import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  access,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Workspace } from "./workspace.ts";
import { ApiError, workspaceIdPattern, type WorkspaceConfig } from "./types.ts";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "7432" },
    "state-dir": { type: "string", default: "./.adm/runner" },
    provider: { type: "string" },
    model: { type: "string" },
    "auth-path": { type: "string" },
  },
});
const host = values.host!,
  port = Number(values.port),
  stateDirectory = values["state-dir"]!;
if (!["127.0.0.1", "::1", "localhost"].includes(host))
  throw new Error(
    "Runner binds must be loopback; remote authenticated configuration is not implemented",
  );
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid port");
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
const stateDirectoryInfo = await lstat(stateDirectory);
if (stateDirectoryInfo.isSymbolicLink() || !stateDirectoryInfo.isDirectory())
  throw new Error("Runner state path must be a real directory, not a symlink");
await chmod(stateDirectory, 0o700);
for (const directory of ["sessions", "tombstones"].map((name) =>
  join(stateDirectory, name),
)) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

const ownerPath = join(stateDirectory, "owner.json");
const ownerDatabasePath = join(stateDirectory, "owner.sqlite");
let ownerDatabase: DatabaseSync | undefined;
async function processStart(pid: number): Promise<string | undefined> {
  try {
    const record = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = record.lastIndexOf(")");
    if (close < 0) throw new Error(`Cannot identify process ${pid}`);
    const fields = record
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const start = fields[19];
    if (!start) throw new Error(`Cannot identify process ${pid}`);
    return start;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function acquireOwner() {
  const ownProcessStart = await processStart(process.pid);
  if (!ownProcessStart)
    throw new Error("Runner ownership requires process identity from /proc");

  // This transaction is the ownership lock. Metadata can be restored or
  // replaced, but SQLite releases this kernel lock only when its owner exits.
  const lockFile = await open(
    ownerDatabasePath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!(await lockFile.stat()).isFile())
      throw new Error("Runner ownership database must be a regular file");
    await lockFile.chmod(0o600);
  } catch (error) {
    await lockFile.close();
    throw error;
  }
  await lockFile.close();

  const database = new DatabaseSync(ownerDatabasePath);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    database.close();
    const sqliteError = error as Error & { errcode?: number };
    if (
      sqliteError.errcode === 5 ||
      /database is locked|database is busy/i.test(sqliteError.message)
    )
      throw new Error("Another runner owns this state directory");
    throw error;
  }
  ownerDatabase = database;

  try {
    try {
      const previous = JSON.parse(await readFile(ownerPath, "utf8")) as {
        pid?: number;
        processStart?: string;
      };
      if (!Number.isSafeInteger(previous.pid))
        throw new Error(
          "Runner owner lock is invalid; refusing to risk a second writer",
        );
      if (typeof previous.processStart !== "string") {
        let stale = false;
        try {
          process.kill(previous.pid!, 0);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === "ESRCH") stale = true;
          else throw failure;
        }
        if (stale) await unlink(ownerPath);
        else
          throw new Error(
            "A legacy runner owner lock refers to a live process; refusing to risk a second writer",
          );
      } else {
        const currentStart = await processStart(previous.pid!);
        if (
          currentStart === undefined ||
          currentStart !== previous.processStart
        )
          await unlink(ownerPath);
        else throw new Error("Another runner owns this state directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicJson(ownerPath, {
      pid: process.pid,
      processStart: ownProcessStart,
    });
  } catch (error) {
    ownerDatabase = undefined;
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
}
await acquireOwner();
const registryPath = join(stateDirectory, "workspaces.json");
const configs = new Map<string, WorkspaceConfig>();
try {
  for (const config of JSON.parse(
    await readFile(registryPath, "utf8"),
  ) as WorkspaceConfig[])
    configs.set(config.id, config);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const workspaces = new Map<string, Workspace>();
async function isDeleted(id: string) {
  try {
    await access(join(stateDirectory, "tombstones", `${id}.json`));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function assertActive(id: string) {
  if (await isDeleted(id))
    throw new ApiError(
      410,
      "WORKSPACE_DELETED",
      "This workspace was deliberately deleted",
    );
}
async function openWorkspace(config: WorkspaceConfig, passive = false) {
  const workspace = await Workspace.open(
    config,
    join(stateDirectory, "sessions", config.id),
    () => assertActive(config.id),
    values["auth-path"],
    async (id) => {
      await assertActive(id);
      const workspace = workspaces.get(id);
      if (!workspace || workspace.passive)
        throw new ApiError(
          404,
          "WORKSPACE_NOT_FOUND",
          "Unknown supervision target",
        );
      return workspace;
    },
    passive,
  );
  workspaces.set(config.id, workspace);
  return workspace;
}
for (const config of configs.values())
  await openWorkspace(config, await isDeleted(config.id));

function validateConfig(id: string, input: unknown): WorkspaceConfig {
  const config = input as WorkspaceConfig;
  if (
    !config ||
    config.id !== id ||
    !["coding", "bot"].includes(config.role) ||
    !["local", "kubernetes"].includes(config.environment)
  )
    throw new ApiError(
      400,
      "INVALID_WORKSPACE",
      "id, role, and environment must be valid",
    );
  if (
    typeof config.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(config.name)
  )
    throw new ApiError(
      400,
      "INVALID_NAME",
      "Use a short printable workspace name",
    );
  if (
    config.role === "bot" &&
    (config.localRoot || config.cwd || config.namespace)
  )
    throw new ApiError(
      400,
      "BOT_ENVIRONMENT_FORBIDDEN",
      "Bots cannot have coding filesystems or runtime namespaces",
    );
  if (
    config.role === "coding" &&
    config.environment === "local" &&
    (!config.localRoot || !isAbsolute(config.localRoot))
  )
    throw new ApiError(
      400,
      "INVALID_LOCAL_ROOT",
      "Local coding workspaces require an explicit absolute localRoot",
    );
  if (config.role === "coding" && config.environment === "kubernetes") {
    if (
      !config.namespace ||
      config.namespace.length > 63 ||
      !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(config.namespace)
    )
      throw new ApiError(
        400,
        "INVALID_NAMESPACE",
        "Kubernetes coding workspaces require a valid namespace",
      );
    if (
      config.kubectl !== undefined &&
      (typeof config.kubectl !== "string" ||
        !/^[\w./@+-]+$/.test(config.kubectl))
    )
      throw new ApiError(
        400,
        "INVALID_KUBECTL",
        "kubectl must be a command name or path without spaces",
      );
    if (
      config.remoteEnv !== undefined &&
      (typeof config.remoteEnv !== "string" ||
        !config.remoteEnv.startsWith("/") ||
        config.remoteEnv.split("/").includes("..") ||
        !/^\/(?:[\w.@+-]+\/)*[\w.@+-]+$/.test(config.remoteEnv))
    )
      throw new ApiError(
        400,
        "INVALID_REMOTE_ENV",
        "remoteEnv must be an absolute container path",
      );
    if (
      config.container !== undefined &&
      !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(config.container)
    )
      throw new ApiError(400, "INVALID_CONTAINER", "container name is invalid");
    if (
      config.cwd !== undefined &&
      (typeof config.cwd !== "string" ||
        !config.cwd.startsWith("/") ||
        config.cwd.includes("\0"))
    )
      throw new ApiError(
        400,
        "INVALID_CWD",
        "Kubernetes cwd must be an absolute path",
      );
  }
  if (
    config.model &&
    (typeof config.model.provider !== "string" ||
      typeof config.model.id !== "string")
  )
    throw new ApiError(400, "INVALID_MODEL", "Model requires provider and id");
  if (
    !config.model &&
    values.provider &&
    (values.model || values.provider === "faux")
  )
    config.model = { provider: values.provider, id: values.model ?? "faux-1" };
  return config;
}
async function body(request: IncomingMessage) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 1024 * 1024)
      throw new ApiError(413, "BODY_TOO_LARGE", "Request body exceeds 1 MiB");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be JSON");
  }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
let mutation = Promise.resolve();
async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutation.then(operation);
  mutation = result.then(
    () => {},
    () => {},
  );
  return result;
}

const server = createServer(async (request, response) => {
  try {
    if (request.headers.origin)
      throw new ApiError(
        403,
        "ORIGIN_FORBIDDEN",
        "Browser origins may not control the runner",
      );
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/health" && request.method === "GET")
      return json(response, 200, { status: "ok", version: "0.1.0" });
    if (url.pathname === "/v1/workspaces" && request.method === "GET")
      return json(response, 200, {
        workspaces: await Promise.all(
          [...configs.values()].map(async (config) =>
            (await isDeleted(config.id))
              ? { ...config, status: "deleted" }
              : workspaces.get(config.id)!.status(),
          ),
        ),
      });
    const match =
      /^\/v1\/workspaces\/([^/]+)(?:\/(input|abort|events|history|goals|loops|resume))?$/.exec(
        url.pathname,
      );
    if (!match) throw new ApiError(404, "NOT_FOUND", "Unknown endpoint");
    let id: string;
    try {
      id = decodeURIComponent(match[1]!);
    } catch {
      throw new ApiError(
        400,
        "INVALID_ID",
        "Workspace ID must use valid URL encoding",
      );
    }
    const action = match[2];
    if (!workspaceIdPattern.test(id))
      throw new ApiError(400, "INVALID_ID", "Invalid immutable workspace ID");
    if (request.method === "PUT" && !action) {
      const config = validateConfig(id, await body(request));
      return await serialized(async () => {
        await assertActive(id);
        const previous = configs.get(id);
        if (
          previous &&
          ["role", "environment", "namespace", "localRoot"].some(
            (key) =>
              previous[key as keyof WorkspaceConfig] !==
              config[key as keyof WorkspaceConfig],
          )
        )
          throw new ApiError(
            409,
            "IDENTITY_CONFLICT",
            "Workspace role and environment identity cannot change",
          );
        if (!previous) {
          configs.set(id, config);
          await atomicJson(registryPath, [...configs.values()]);
          await openWorkspace(config);
        }
        return json(response, 200, await workspaces.get(id)!.status());
      });
    }
    const config = configs.get(id);
    if (!config) {
      await assertActive(id);
      throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Unknown workspace");
    }
    if (request.method === "DELETE" && !action) {
      return await serialized(async () => {
        await atomicJson(join(stateDirectory, "tombstones", `${id}.json`), {
          id,
          deletedAt: Date.now(),
        });
        const current = workspaces.get(id);
        if (current && !current.passive) {
          await current.close(true);
          workspaces.delete(id);
          await openWorkspace(config, true);
        }
        json(response, 200, { id, status: "deleted" });
      });
    }
    const workspace = workspaces.get(id);
    if (!workspace) {
      await assertActive(id);
      throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Unknown workspace");
    }
    if (request.method === "GET" && action === "history") {
      let after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 200),
        diagnostics = url.searchParams.get("diagnostics") === "true";
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new ApiError(
          400,
          "INVALID_CURSOR",
          "after must be nonnegative; limit must be 1..1000",
        );
      return json(
        response,
        200,
        await workspace.history(after, limit, diagnostics),
      );
    }
    await assertActive(id);
    if (request.method === "GET" && !action)
      return json(response, 200, await workspace.status());
    if (request.method === "POST" && action === "goals") {
      const data = await body(request);
      return await serialized(async () => {
        await assertActive(id);
        return json(response, 200, await workspace.saveGoal(data));
      });
    }
    if (request.method === "POST" && action === "loops") {
      const data = await body(request);
      return await serialized(async () => {
        await assertActive(id);
        return json(response, 200, await workspace.saveLoop(data));
      });
    }
    if (request.method === "POST" && action === "input") {
      const data = await body(request);
      if (typeof data.message !== "string" || !data.message.trim())
        throw new ApiError(
          400,
          "INVALID_MESSAGE",
          "Input requires a nonempty message",
        );
      if (data.requestId !== undefined && typeof data.requestId !== "string")
        throw new ApiError(
          400,
          "INVALID_REQUEST_ID",
          "requestId must be a string",
        );
      if (
        data.whenBusy &&
        !["steer", "followUp", "reject"].includes(data.whenBusy)
      )
        throw new ApiError(400, "INVALID_QUEUE_MODE", "Invalid whenBusy");
      return await serialized(async () => {
        await assertActive(id);
        return json(
          response,
          202,
          await workspace.input(data.message, data.requestId, data.whenBusy),
        );
      });
    }
    if (request.method === "POST" && action === "abort") {
      const data = await body(request);
      return await serialized(async () => {
        await assertActive(id);
        await workspace.conversation.abort(
          (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
          { background: data.background === true },
        );
        return json(response, 200, await workspace.status());
      });
    }
    if (request.method === "POST" && action === "resume") {
      await body(request);
      return await serialized(async () => {
        await assertActive(id);
        return json(response, 202, await workspace.resume());
      });
    }
    if (request.method === "GET" && action === "events") {
      let after = Number(
        url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0,
      );
      const limit = Number(url.searchParams.get("limit") ?? 200),
        diagnostics = url.searchParams.get("diagnostics") === "true";
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new ApiError(
          400,
          "INVALID_CURSOR",
          "after must be nonnegative; limit must be 1..1000",
        );
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.flushHeaders();
      let pumping = false,
        dirty = false,
        ended = false;
      const pump = async () => {
        dirty = true;
        if (pumping || ended) return;
        pumping = true;
        try {
          while (dirty && !ended) {
            dirty = false;
            let more = true;
            while (more && !ended) {
              const page = await workspace.history(after, 200, diagnostics);
              after = page.nextAfter;
              for (const event of page.events) {
                response.write(
                  `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
                );
              }
              more = page.hasMore;
            }
          }
        } catch {
          response.end();
        } finally {
          pumping = false;
        }
      };
      const close = () => {
        ended = true;
        workspace.events.off("change", notify);
        workspace.events.off("close", close);
        response.end();
      };
      const notify = () => {
        void pump();
      };
      workspace.events.on("change", notify);
      workspace.events.once("close", close);
      response.once("close", close);
      void pump();
      return;
    }
    throw new ApiError(404, "NOT_FOUND", "Endpoint is not implemented");
  } catch (error) {
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError(
            500,
            "RUNNER_FAILURE",
            error instanceof Error ? error.message : "Runner operation failed",
          );
    if (!response.headersSent)
      json(response, failure.status, {
        error: { code: failure.code, message: failure.message },
      });
    else response.end();
  }
});
server.listen(port, host, () => {
  const address = server.address();
  if (address && typeof address !== "string")
    console.log(
      JSON.stringify({
        ready: true,
        url: `http://${host === "::1" ? "[::1]" : host}:${address.port}`,
        pid: process.pid,
      }),
    );
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  const closing = await Promise.allSettled(
    [...workspaces.values()].map((workspace) => workspace.close()),
  );
  const errors = closing.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  try {
    await unlink(ownerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
  }
  const database = ownerDatabase;
  ownerDatabase = undefined;
  if (database) {
    try {
      database.exec("ROLLBACK");
    } catch (error) {
      errors.push(error);
    }
    try {
      database.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Runner shutdown was incomplete");
}
process.on("SIGTERM", () => {
  void shutdown().catch(() => {
    process.exitCode = 1;
  });
});
process.on("SIGINT", () => {
  void shutdown().catch(() => {
    process.exitCode = 1;
  });
});
