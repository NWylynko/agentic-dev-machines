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
import { timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Workspace } from "./workspace.ts";
import { WorkspaceResources } from "./resources.ts";
import {
  failLifecycleAvailability,
  lifecycleAvailabilityError,
  restoreLifecycleAvailability,
  suspendLifecycleAvailability,
  waitForLifecycleAvailability,
} from "./lifecycle-availability.ts";
import { botAgentManagementFromEnvironment } from "./bot-management.ts";
import { ApiError, workspaceIdPattern, type WorkspaceConfig } from "./types.ts";
import { watchEvents } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "7432" },
    "state-dir": { type: "string", default: "./.adm/runner" },
    provider: { type: "string" },
    model: { type: "string" },
    "auth-path": { type: "string" },
    "token-file": { type: "string" },
    "workspace-config": { type: "string" },
    "lifecycle-url": { type: "string" },
    "pod-uid": { type: "string" },
  },
});
const host = values.host!,
  port = Number(values.port),
  stateDirectory = values["state-dir"]!;
const tokenFile = values["token-file"];
const workspaceResources = new Map<string, WorkspaceResources>();
const lifecycleUrl = values["lifecycle-url"] ?? process.env.ADM_LIFECYCLE_URL;
if (!["127.0.0.1", "::1", "localhost"].includes(host) && !lifecycleUrl)
  throw new Error(
    "Non-loopback runner binds require --lifecycle-url for authenticated authorization",
  );
if (lifecycleUrl && !tokenFile)
  throw new Error(
    "Lifecycle-authenticated runner requires --token-file for its projected Pod identity",
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
let runtimeLease:
  | {
      workspaceId: string;
      holder: string;
      fencingToken: number;
      expiresAt: number;
    }
  | undefined;
let runtimeLeaseError: Error | undefined;
let fenceShutdown: Promise<void> | undefined;
let leaseExpiryTimer: NodeJS.Timeout | undefined;
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
const botAgents = botAgentManagementFromEnvironment({
  lifecycleUrl,
  tokenFile: values["token-file"],
  runtimePort: process.env.ADM_RUNTIME_PORT,
});
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
async function assertActive(id: string, signal?: AbortSignal) {
  if (runtimeLeaseError)
    throw new ApiError(
      503,
      "RUNTIME_OWNERSHIP_LOST",
      runtimeLeaseError.message,
    );
  if (await isDeleted(id))
    throw new ApiError(
      410,
      "WORKSPACE_DELETED",
      "This workspace was deliberately deleted",
    );
  if (lifecycleUrl) {
    if (!runtimeLease || runtimeLease.workspaceId !== id)
      throw new ApiError(
        503,
        "RUNTIME_LEASE_MISSING",
        "Workspace runtime does not hold its lifecycle fence",
      );
    for (;;) {
      await waitForLifecycleAvailability(signal);
      try {
        const checked = await lifecycleRuntimeCall(id, "check", {
          holder: runtimeLease.holder,
          fencingToken: runtimeLease.fencingToken,
        }, signal);
        if (checked.valid !== true)
          throw new Error("Lifecycle returned an invalid workspace lease check");
        restoreLifecycleAvailability();
        return;
      } catch (error) {
        if (isLifecycleUnavailable(error)) {
          suspendLifecycleAvailability(error);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        await fenceLost(error);
        throw new ApiError(503, "RUNTIME_OWNERSHIP_LOST", message);
      }
    }
  }
}
function isLifecycleUnavailable(error: unknown): boolean {
  return error instanceof ApiError
    ? error.status >= 500
    : error instanceof TypeError ||
        (error instanceof Error &&
          ["AbortError", "TimeoutError"].includes(error.name));
}
function scheduleLeaseExpiry(expiresAt: number) {
  if (leaseExpiryTimer) clearTimeout(leaseExpiryTimer);
  const remaining = expiresAt * 1000 - Date.now();
  if (remaining <= 0) {
    void fenceLost(new Error("Workspace runtime lease expired"));
    return;
  }
  leaseExpiryTimer = setTimeout(() => {
    void fenceLost(new Error("Workspace runtime lease expired"));
  }, remaining);
  leaseExpiryTimer.unref();
}
function fenceLost(error: unknown) {
  if (fenceShutdown) return fenceShutdown;
  runtimeLeaseError = error instanceof Error ? error : new Error(String(error));
  if (leaseExpiryTimer) clearTimeout(leaseExpiryTimer);
  failLifecycleAvailability(runtimeLeaseError);
  process.stderr.write(
    `FATAL workspace runtime lost its lifecycle fence: ${runtimeLeaseError.message}\n`,
  );
  fenceShutdown = (async () => {
    for (const workspace of workspaces.values()) {
      try {
        await workspace.close(true);
      } catch (closeError) {
        process.stderr.write(
          `FATAL failed to stop fenced workspace ${workspace.config.id}: ${String(closeError)}\n`,
        );
      }
    }
  })();
  return fenceShutdown;
}
async function lifecycleRuntimeCall(
  id: string,
  action: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  if (!lifecycleUrl || !tokenFile)
    throw new Error("Lifecycle runtime transport is not configured");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) throw new Error("Projected workspace identity token is empty");
  let response: Response;
  try {
    response = await fetch(
      `${lifecycleUrl.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(id)}/runtime/${action}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
          : AbortSignal.timeout(5_000),
      },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TypeError(
      `Workspace lifecycle ${action} request failed: ${(error as Error).message}`,
    );
  }
  const value = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
    fencingToken?: number;
    holder?: string;
    expiresAt?: number;
    maintenanceId?: string | null;
    valid?: boolean;
  };
  if (!response.ok)
    throw new ApiError(
      response.status,
      value.error?.code ?? "RUNTIME_FENCE_REJECTED",
      value.error?.message ?? `Workspace lifecycle rejected runtime ${action}`,
    );
  return value;
}
function runtimeAction(method: string, pathname: string): string {
  const endpoint = pathname.match(/^\/v1\/workspaces\/[^/]+(?:\/(.*))?$/)?.[1];
  if (method === "GET") return "read";
  if (method === "DELETE") return "delete";
  if (method === "PUT" && endpoint === "model") return "model";
  if (method !== "POST") return "read";
  if (endpoint === "input") return "prompt";
  if (endpoint === "abort") return "abort";
  if (endpoint === "resume" || endpoint === "retry") return "resume";
  if (endpoint === "goals") return "goal";
  if (endpoint === "loops") return "loop";
  return "read";
}
async function authorizeRuntimeRequest(
  request: IncomingMessage,
  pathname: string,
  signal?: AbortSignal,
) {
  const authorization = request.headers.authorization ?? "";
  if (lifecycleUrl) {
    const match = pathname.match(/^\/v1\/workspaces(?:\/([^/]+))?/);
    const id = match?.[1]
      ? decodeURIComponent(match[1])
      : [...configs.keys()][0];
    if (!id)
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "Workspace runtime identity is unavailable",
      );
    for (;;) {
      await waitForLifecycleAvailability(signal);
      let response: Response;
      try {
        response = await fetch(
          `${lifecycleUrl.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(id)}/runtime/authorize`,
          {
            method: "POST",
            headers: {
              authorization,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              action: runtimeAction(request.method ?? "GET", pathname),
            }),
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
              : AbortSignal.timeout(5_000),
          },
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        suspendLifecycleAvailability(error);
        continue;
      }
      if (!response.ok) {
        const value = (await response.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        const failure = new ApiError(
          response.status,
          value.error?.code ?? "UNAUTHORIZED",
          value.error?.message ?? "Lifecycle rejected the workspace request",
        );
        if (response.status >= 500) {
          suspendLifecycleAvailability(failure);
          continue;
        }
        throw failure;
      }
      return;
    }
  }
  if (!tokenFile) return;
  let expected: Buffer;
  try {
    expected = Buffer.from((await readFile(tokenFile, "utf8")).trim());
  } catch (error) {
    throw new ApiError(
      503,
      "AUTH_UNAVAILABLE",
      `Runtime token unavailable: ${(error as Error).message}`,
    );
  }
  const supplied = authorization.startsWith("Bearer ")
    ? Buffer.from(authorization.slice(7))
    : Buffer.alloc(0);
  if (
    expected.length === 0 ||
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    throw new ApiError(
      401,
      "UNAUTHORIZED",
      "A valid workspace runtime bearer token is required",
    );
}
async function openWorkspace(
  config: WorkspaceConfig,
  passive = false,
  deferActivation = false,
) {
  const workspace = await Workspace.open(
    config,
    join(stateDirectory, "sessions", config.id),
    () => assertActive(config.id),
    values["auth-path"],
    botAgents,
    passive,
    deferActivation,
    values.provider,
    lifecycleUrl ? waitForLifecycleAvailability : undefined,
  );
  workspaces.set(config.id, workspace);
  return workspace;
}
if (values["workspace-config"]) {
  const workspaceConfig = JSON.parse(
    await readFile(values["workspace-config"], "utf8"),
  ) as WorkspaceConfig;
  const config = validateConfig(workspaceConfig.id, workspaceConfig);
  const previous = configs.get(config.id);
  const persistedIdentity = previous && { ...previous };
  if (persistedIdentity) delete persistedIdentity.onboardingRequired;
  if (
    persistedIdentity &&
    JSON.stringify(persistedIdentity) !== JSON.stringify(config)
  )
    throw new Error(
      "Mounted workspace configuration conflicts with persisted runtime identity",
    );
  if (!previous) {
    const registration = {
      ...config,
      ...(config.role === "bot" ? { onboardingRequired: true } : {}),
    };
    configs.set(config.id, registration);
    await atomicJson(registryPath, [...configs.values()]);
  }
}
if (lifecycleUrl) {
  const config = [...configs.values()][0];
  if (!config || configs.size !== 1)
    throw new Error(
      "A lifecycle-owned Pod runtime must open exactly one workspace",
    );
  const holder = values["pod-uid"] ?? process.env.ADM_POD_UID;
  if (!holder || !/^[0-9a-f-]{36}$/i.test(holder))
    throw new Error(
      "Lifecycle-owned Pod runtime requires its Kubernetes Pod UID",
    );
  const acquired = await lifecycleRuntimeCall(config.id, "lease", { holder });
  if (
    acquired.holder !== holder ||
    !Number.isSafeInteger(acquired.fencingToken) ||
    acquired.fencingToken! < 1 ||
    !Number.isSafeInteger(acquired.expiresAt) ||
    acquired.expiresAt! <= Math.floor(Date.now() / 1000)
  )
    throw new Error("Lifecycle returned an invalid workspace runtime lease");
  runtimeLease = {
    workspaceId: config.id,
    holder,
    fencingToken: acquired.fencingToken!,
    expiresAt: acquired.expiresAt!,
  };
  scheduleLeaseExpiry(runtimeLease.expiresAt);
}
for (const config of configs.values())
  await openWorkspace(config, await isDeleted(config.id));

if (lifecycleUrl) {
  const { workspaceId, holder } = runtimeLease!;
  let renewing = false;
  const renewal = setInterval(async () => {
    if (renewing || !runtimeLease || runtimeLeaseError) return;
    renewing = true;
    try {
      const renewed = await lifecycleRuntimeCall(workspaceId, "lease/renew", {
        holder,
        fencingToken: runtimeLease.fencingToken,
      });
      if (renewed.fencingToken !== runtimeLease.fencingToken)
        throw new Error("Lifecycle changed the active workspace fence");
      if (
        renewed.holder !== holder ||
        !Number.isSafeInteger(renewed.expiresAt) ||
        renewed.expiresAt! <= Math.floor(Date.now() / 1000)
      )
        throw new Error(
          "Lifecycle returned an invalid renewed workspace lease",
        );
      runtimeLease.expiresAt = renewed.expiresAt!;
      scheduleLeaseExpiry(runtimeLease.expiresAt);
      if (renewed.maintenanceId) {
        await lifecycleRuntimeCall(workspaceId, "lease/ack", {
          holder,
          fencingToken: runtimeLease.fencingToken,
          maintenanceId: renewed.maintenanceId,
          expiresAt: renewed.expiresAt,
        });
      }
      restoreLifecycleAvailability();
    } catch (error) {
      if (isLifecycleUnavailable(error)) suspendLifecycleAvailability(error);
      else await fenceLost(error);
    } finally {
      renewing = false;
    }
  }, 10_000);
  renewal.unref();
}

function validateConfig(id: string, input: unknown): WorkspaceConfig {
  const config = input as WorkspaceConfig;
  if (
    input &&
    typeof input === "object" &&
    Object.hasOwn(input, "onboardingRequired")
  )
    throw new ApiError(
      400,
      "INVALID_WORKSPACE",
      "onboardingRequired is managed by the runner",
    );
  if (
    !config ||
    config.id !== id ||
    !["coding", "bot"].includes(config.role) ||
    !["local", "kubernetes", "pod"].includes(config.environment)
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
    (config.localRoot || config.cwd || config.namespace || config.kubeconfig)
  )
    throw new ApiError(
      400,
      "BOT_ENVIRONMENT_FORBIDDEN",
      "Bots cannot have coding filesystems or runtime namespaces",
    );
  if (config.mcpServers !== undefined) {
    if (config.role !== "bot" || !Array.isArray(config.mcpServers))
      throw new ApiError(
        400,
        "INVALID_MCP_SERVERS",
        "MCP servers can only be configured for bots",
      );
    const serverIds = new Set<string>();
    for (const server of config.mcpServers) {
      const keys = Object.keys(server ?? {})
        .sort()
        .join(",");
      if (
        ![
          "command,id,tools",
          "args,command,id,tools",
          "command,id,secretEnv,tools",
          "args,command,id,secretEnv,tools",
        ].includes(keys)
      )
        throw new ApiError(
          400,
          "INVALID_MCP_SERVER",
          "MCP config supports only id, stdio command, args, exact tool grants, and secretEnv references",
        );
      if (
        typeof server.id !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(server.id) ||
        serverIds.has(server.id)
      )
        throw new ApiError(
          400,
          "INVALID_MCP_SERVER_ID",
          "Invalid or duplicate MCP server id",
        );
      serverIds.add(server.id);
      if (
        typeof server.command !== "string" ||
        !/^(?:[A-Za-z0-9_.+-]+|\/[A-Za-z0-9_./+-]+)$/.test(server.command) ||
        server.command.includes("..")
      )
        throw new ApiError(
          400,
          "INVALID_MCP_COMMAND",
          "MCP servers require a command name or absolute executable path",
        );
      if (
        server.args !== undefined &&
        (!Array.isArray(server.args) ||
          server.args.length > 64 ||
          server.args.some(
            (arg) => typeof arg !== "string" || arg.length > 4096,
          ))
      )
        throw new ApiError(
          400,
          "INVALID_MCP_ARGS",
          "MCP args must be up to 64 strings of at most 4096 characters",
        );
      if (
        !Array.isArray(server.tools) ||
        server.tools.length === 0 ||
        server.tools.length > 128 ||
        server.tools.some(
          (tool) =>
            typeof tool !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool),
        ) ||
        new Set(server.tools).size !== server.tools.length
      )
        throw new ApiError(
          400,
          "INVALID_MCP_TOOLS",
          "MCP config requires exact, unique tool names",
        );
      if (server.secretEnv !== undefined) {
        if (
          !server.secretEnv ||
          typeof server.secretEnv !== "object" ||
          Array.isArray(server.secretEnv)
        )
          throw new ApiError(
            400,
            "INVALID_MCP_ENV",
            "secretEnv must map MCP variable names to runner environment references",
          );
        for (const [name, reference] of Object.entries(server.secretEnv))
          if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            typeof reference !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)
          )
            throw new ApiError(
              400,
              "INVALID_MCP_ENV",
              "MCP env names and references must be environment variable identifiers",
            );
          else if (process.env[reference] === undefined)
            throw new ApiError(
              400,
              "MCP_SECRET_NOT_INJECTED",
              `MCP environment reference ${reference} is not injected into the runner`,
            );
      }
    }
  }
  if (
    config.role === "coding" &&
    ["local", "pod"].includes(config.environment) &&
    (!config.localRoot || !isAbsolute(config.localRoot))
  )
    throw new ApiError(
      400,
      "INVALID_LOCAL_ROOT",
      "Local and pod coding workspaces require an explicit absolute localRoot",
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
      config.kubeconfig !== undefined &&
      (typeof config.kubeconfig !== "string" ||
        !config.kubeconfig ||
        config.kubeconfig.includes("\0") ||
        config.kubeconfig.split(":").some((path) => !path.startsWith("/")))
    )
      throw new ApiError(
        400,
        "INVALID_KUBECONFIG",
        "kubeconfig must be an absolute host-side path list without NUL bytes",
      );
    if (!config.kubeconfig)
      throw new ApiError(
        400,
        "KUBECONFIG_REQUIRED",
        "Kubernetes coding workspaces require a pinned host kubeconfig; create with --kubeconfig or rebind an existing workspace with adm reconnect NAME --kubeconfig PATHS",
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
  if (!config.model && values.provider && values.model)
    config.model = { provider: values.provider, id: values.model ?? "faux-1" };
  return config;
}
async function body(request: IncomingMessage, maxBytes = 1024 * 1024) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > maxBytes)
      throw new ApiError(
        413,
        "BODY_TOO_LARGE",
        "Request body exceeds the route limit",
      );
  }
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(
      400,
      "INVALID_BODY",
      "Request body must be a JSON object",
    );
  return value as Record<string, unknown>;
}

function importedPiMessages(value: unknown): Message[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000)
    throw new ApiError(
      400,
      "INVALID_IMPORT",
      "Pi transcript import requires one to 1000 messages",
    );
  let totalBytes = 0;
  const availableToolCalls = new Set<string>();
  const messages = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ApiError(
        400,
        "INVALID_IMPORT",
        "Imported message must be an object",
      );
    const message = item as Record<string, any>;
    if (!["user", "assistant", "toolResult"].includes(message.role))
      throw new ApiError(
        400,
        "INVALID_IMPORT",
        "Imported messages must be Pi user, assistant, or tool-result messages",
      );
    if (
      message.role === "user" &&
      typeof message.content !== "string" &&
      (!Array.isArray(message.content) ||
        message.content.some(
          (part: any) =>
            !part ||
            typeof part !== "object" ||
            Array.isArray(part) ||
            (part.type === "text" && typeof part.text !== "string") ||
            !["text", "image"].includes(part.type),
        ))
    )
      throw new ApiError(
        400,
        "INVALID_IMPORT",
        "Imported user content is invalid",
      );
    if (
      message.role !== "user" &&
      (!Array.isArray(message.content) ||
        (message.role === "assistant" &&
          (typeof message.api !== "string" ||
            typeof message.provider !== "string" ||
            typeof message.model !== "string" ||
            ![
              "pending",
              "stop",
              "length",
              "toolUse",
              "error",
              "aborted",
              "deferred",
            ].includes(message.stopReason) ||
            !message.usage ||
            typeof message.usage !== "object" ||
            ["input", "output", "cacheRead", "cacheWrite"].some(
              (field) =>
                !Number.isFinite(message.usage[field]) ||
                message.usage[field] < 0,
            ))) ||
        (message.role === "toolResult" &&
          (typeof message.toolCallId !== "string" ||
            !availableToolCalls.has(message.toolCallId) ||
            typeof message.toolName !== "string" ||
            typeof message.isError !== "boolean")))
    )
      throw new ApiError(
        400,
        "INVALID_IMPORT",
        "Imported message metadata or content is invalid",
      );
    if (message.role === "toolResult")
      availableToolCalls.delete(message.toolCallId);
    if (
      message.timestamp !== undefined &&
      (!Number.isFinite(message.timestamp) ||
        typeof message.timestamp !== "number")
    )
      throw new ApiError(
        400,
        "INVALID_IMPORT",
        "Message timestamp must be numeric",
      );
    for (const part of message.content) {
      if (typeof message.content === "string") break;
      if (!part || typeof part !== "object" || Array.isArray(part))
        throw new ApiError(
          400,
          "INVALID_IMPORT",
          "Message content part must be an object",
        );
      if (
        (part.type === "text" && typeof part.text !== "string") ||
        (part.type === "thinking" &&
          (message.role !== "assistant" ||
            typeof part.thinking !== "string")) ||
        (part.type === "toolCall" &&
          (message.role !== "assistant" ||
            typeof part.id !== "string" ||
            !part.id ||
            typeof part.name !== "string" ||
            !part.name ||
            !part.arguments ||
            typeof part.arguments !== "object" ||
            Array.isArray(part.arguments) ||
            availableToolCalls.has(part.id))) ||
        (part.type === "image" &&
          !["user", "assistant", "toolResult"].includes(message.role)) ||
        (message.role === "toolResult" &&
          !["text", "image"].includes(part.type)) ||
        !["text", "thinking", "toolCall", "image"].includes(part.type)
      )
        throw new ApiError(
          400,
          "INVALID_IMPORT",
          "Message content part is invalid for its role",
        );
      if (part.type === "toolCall") availableToolCalls.add(part.id);
      if (part.type === "image") {
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(part.mimeType) ||
          typeof part.data !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            part.data,
          )
        )
          throw new ApiError(
            400,
            "INVALID_IMPORT_IMAGE",
            "Imported image must use base64 PNG, JPEG, or WebP content",
          );
        const image = Buffer.from(part.data, "base64");
        const signatureMatches =
          (part.mimeType === "image/png" &&
            image
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
          (part.mimeType === "image/jpeg" &&
            image[0] === 255 &&
            image[1] === 216 &&
            image[2] === 255) ||
          (part.mimeType === "image/webp" &&
            image.toString("ascii", 0, 4) === "RIFF" &&
            image.toString("ascii", 8, 12) === "WEBP");
        if (
          !image.length ||
          image.length > 4 * 1024 * 1024 ||
          !signatureMatches
        )
          throw new ApiError(
            400,
            "INVALID_IMPORT_IMAGE",
            "Imported image is invalid or exceeds 4 MiB",
          );
      }
    }
    totalBytes += Buffer.byteLength(JSON.stringify(message));
    if (totalBytes > 8 * 1024 * 1024)
      throw new ApiError(
        413,
        "IMPORT_TOO_LARGE",
        "Imported message history exceeds 8 MiB",
      );
    return message as Message;
  });
  return messages;
}

function importedPiTree(value: unknown, selectedLeafId: unknown) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 1000 ||
    typeof selectedLeafId !== "string"
  )
    throw new ApiError(
      400,
      "INVALID_IMPORT",
      "Pi tree import requires one to 1000 entries and a selected leaf",
    );
  const byId = new Map<string, { id: string; parentId: string | null; message: unknown }>();
  const roots = new Set<string>();
  const children = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ApiError(400, "INVALID_IMPORT", "Imported entry must be an object");
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      entry.id.length > 128 ||
      (entry.parentId !== null && typeof entry.parentId !== "string") ||
      byId.has(entry.id)
    )
      throw new ApiError(400, "INVALID_IMPORT", "Imported entry identity is invalid");
    const parentId = entry.parentId as string | null;
    if (parentId === null) roots.add(entry.id);
    else {
      if (!byId.has(parentId))
        throw new ApiError(400, "INVALID_IMPORT", "Imported entry parent is missing or out of order");
      children.add(parentId);
    }
    byId.set(entry.id, { id: entry.id, parentId, message: entry.message });
  }
  if (roots.size !== 1)
    throw new ApiError(400, "INVALID_IMPORT", "Imported branches must share one history root");
  const leaves = [...byId.keys()].filter((id) => !children.has(id));
  if (!leaves.includes(selectedLeafId))
    throw new ApiError(400, "INVALID_IMPORT", "Selected imported leaf does not exist");
  const branches = leaves.map((leafId) => {
    const path: { id: string; parentId: string | null; message: unknown }[] = [];
    let current: { id: string; parentId: string | null; message: unknown } | undefined = byId.get(leafId);
    while (current) {
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    path.reverse();
    const messages = importedPiMessages(path.map((entry) => entry.message));
    return {
      leafId,
      entries: path.map((entry, index) => ({
        ...entry,
        message: messages[index],
      })),
    };
  });
  return { branches, selectedLeafId };
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
  const requestController = new AbortController();
  const requestSignal = requestController.signal;
  request.once("aborted", () => requestController.abort());
  response.once("close", () => {
    if (!response.writableEnded) requestController.abort();
  });
  try {
    if (request.headers.origin)
      throw new ApiError(
        403,
        "ORIGIN_FORBIDDEN",
        "Browser origins may not control the runner",
      );
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/health" && request.method === "GET") {
      if (runtimeLeaseError)
        return json(response, 503, {
          status: "error",
          error: runtimeLeaseError.message,
        });
      if (lifecycleAvailabilityError() && !runtimeLeaseError)
        return json(response, 200, {
          status: "degraded",
          version: "0.1.0",
          reason: "lifecycle-unavailable",
          leaseExpiresAt: runtimeLease?.expiresAt,
        });
      return json(response, 200, { status: "ok", version: "0.1.0" });
    }
    await authorizeRuntimeRequest(request, url.pathname, requestSignal);
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
      /^\/v1\/workspaces\/([^/]+)(?:\/(input|abort|events|history|goals|loops|resume|retry|kubernetes-connection|model|models|runtime-status|branches|branch|tree|new|import|compact|reset|settings|resources\/reload|resources|trust))?$/.exec(
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
        await assertActive(id, requestSignal);
        const previous = configs.get(id);
        if (
          previous &&
          ["role", "environment", "namespace", "localRoot", "kubeconfig"].some(
            (key) =>
              previous[key as keyof WorkspaceConfig] !==
              config[key as keyof WorkspaceConfig],
          )
        )
          throw new ApiError(
            409,
            "IDENTITY_CONFLICT",
            "Workspace role, environment, and Kubernetes connection cannot change",
          );
        if (!previous) {
          const registration = {
            ...config,
            ...(config.role === "bot" ? { onboardingRequired: true } : {}),
          };
          configs.set(id, registration);
          try {
            await atomicJson(registryPath, [...configs.values()]);
            await openWorkspace(registration, false, true);
            await workspaces.get(id)!.activate();
          } catch (error) {
            const cleanupErrors: unknown[] = [];
            try {
              await workspaces.get(id)?.close(true);
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
            workspaces.delete(id);
            configs.delete(id);
            try {
              await atomicJson(registryPath, [...configs.values()]);
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
            if (cleanupErrors.length)
              throw new AggregateError(
                [error, ...cleanupErrors],
                "Workspace registration failed and rollback was incomplete",
              );
            throw error;
          }
        }
        return json(response, 200, await workspaces.get(id)!.status());
      });
    }
    const config = configs.get(id);
    if (!config) {
      await assertActive(id, requestSignal);
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
      await assertActive(id, requestSignal);
      throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Unknown workspace");
    }
    if (request.method === "PUT" && action === "kubernetes-connection") {
      const data = await body(request);
      if (
        typeof data.kubectl !== "string" ||
        !/^[\w./@+-]+$/.test(data.kubectl)
      )
        throw new ApiError(
          400,
          "INVALID_KUBECTL",
          "kubectl must be a command name or path without spaces",
        );
      if (
        typeof data.kubeconfig !== "string" ||
        !data.kubeconfig ||
        data.kubeconfig.includes("\0") ||
        data.kubeconfig.split(":").some((path) => !path.startsWith("/"))
      )
        throw new ApiError(
          400,
          "INVALID_KUBECONFIG",
          "kubeconfig must be an absolute host-side path list without NUL bytes",
        );
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          200,
          await workspace.rebindKubernetesConnection(
            data.kubectl as string,
            data.kubeconfig as string,
            async (config) => {
              const updated = [...configs.values()].map((entry) =>
                entry.id === id ? config : entry,
              );
              await atomicJson(registryPath, updated);
              configs.set(id, config);
            },
          ),
        );
      });
    }
    if (request.method === "GET" && action === "runtime-status") {
      const status = await workspace.status();
      const catalog = await workspace.modelCatalog(
        new AbortController().signal,
        false,
      );
      const activity = ["needs_model", "running", "error", "idle"].includes(
        status.status,
      )
        ? status.status
        : "unavailable";
      const error =
        typeof status.error === "string"
          ? status.error.slice(0, 2000)
          : undefined;
      return json(response, 200, {
        activity: { status: activity, ...(error ? { error } : {}) },
        ...(catalog.selected ? { selectedModel: catalog.selected } : {}),
      });
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
    await assertActive(id, requestSignal);
    if (request.method === "GET" && action === "branches")
      return json(response, 200, await workspace.branches());
    if (request.method === "POST" && action === "new") {
      await body(request);
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(response, 200, await workspace.newSession());
      });
    }
    if (request.method === "POST" && action === "import") {
      const data = await body(request, 9 * 1024 * 1024);
      const imported = importedPiTree(data.entries, data.selectedLeafId);
      let sourceSession: { id?: string; cwd?: string } | undefined;
      if (data.session !== undefined) {
        if (
          !data.session ||
          typeof data.session !== "object" ||
          Array.isArray(data.session)
        )
          throw new ApiError(
            400,
            "INVALID_IMPORT",
            "Pi session header must be an object",
          );
        const session = data.session as Record<string, unknown>;
        if (
          (session.id !== undefined &&
            (typeof session.id !== "string" || session.id.length > 128)) ||
          (session.cwd !== undefined &&
            (typeof session.cwd !== "string" || session.cwd.length > 4096))
        )
          throw new ApiError(
            400,
            "INVALID_IMPORT",
            "Pi session header fields are invalid",
          );
        sourceSession = {
          ...(typeof session.id === "string" ? { id: session.id } : {}),
          ...(typeof session.cwd === "string" ? { cwd: session.cwd } : {}),
        };
      }
      return await serialized(async () => {
        await assertActive(id);
        return json(
          response,
          201,
          await workspace.importMessages(
            imported.branches,
            imported.selectedLeafId,
            sourceSession,
          ),
        );
      });
    }
    if (request.method === "PUT" && action === "branch") {
      const data = await body(request);
      if (
        !Number.isSafeInteger(data.conversationId) ||
        (data.conversationId as number) < 1
      )
        throw new ApiError(
          400,
          "INVALID_CONVERSATION_ID",
          "conversationId must be a positive Durable conversation ID",
        );
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          200,
          await workspace.selectBranch(data.conversationId as number),
        );
      });
    }
    if (request.method === "GET" && action === "tree") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 200);
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
        await workspace.tree(
          after,
          limit,
          url.searchParams.get("diagnostics") === "true",
        ),
      );
    }
    if (request.method === "POST" && action === "tree") {
      const data = await body(request);
      if (!Number.isSafeInteger(data.entryId) || (data.entryId as number) < 1)
        throw new ApiError(
          400,
          "INVALID_ENTRY_ID",
          "entryId must be a positive Durable entry ID",
        );
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          200,
          await workspace.forkBranch(data.entryId as number),
        );
      });
    }
    if (request.method === "POST" && action === "compact") {
      const data = await body(request);
      if (
        data.instructions !== undefined &&
        typeof data.instructions !== "string"
      )
        throw new ApiError(
          400,
          "INVALID_COMPACTION_INSTRUCTIONS",
          "instructions must be text",
        );
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          202,
          await workspace.compact(data.instructions as string | undefined),
        );
      });
    }
    if (request.method === "POST" && action === "reset") {
      const data = await body(request);
      if (data.handoff !== undefined && typeof data.handoff !== "string")
        throw new ApiError(400, "INVALID_HANDOFF", "handoff must be text");
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          202,
          await workspace.reset(data.handoff as string | undefined),
        );
      });
    }
    if (
      action === "resources" ||
      action === "resources/reload" ||
      action === "trust"
    ) {
      let resources = workspaceResources.get(id);
      if (!resources) {
        resources = new WorkspaceResources(
          workspace.config,
          join(stateDirectory, "sessions", id),
        );
        workspaceResources.set(id, resources);
      }
      if (request.method === "GET" && action === "resources")
        return json(response, 200, await resources.get());
      if (request.method === "GET" && action === "trust")
        return json(response, 200, resources.trust());
      if (request.method === "PUT" && action === "trust") {
        const data = await body(request);
        if (typeof data.trusted !== "boolean" && !Array.isArray(data.updates))
          throw new ApiError(
            400,
            "INVALID_TRUST",
            "trusted must be a boolean or updates must contain project trust decisions",
          );
        return await serialized(async () => {
          await assertActive(id, requestSignal);
          return json(
            response,
            200,
            Array.isArray(data.updates)
              ? await resources.setTrustUpdates(
                  data.updates as { path: string; decision: boolean | null }[],
                )
              : await resources.setTrust(data.trusted as boolean),
          );
        });
      }
      if (request.method === "POST" && action === "resources/reload")
        return await serialized(async () => {
          await assertActive(id, requestSignal);
          return json(response, 200, await resources.reload());
        });
    }
    if (request.method === "GET" && action === "settings")
      return json(response, 200, await workspace.settings());
    if (request.method === "PUT" && action === "settings") {
      const data = await body(request);
      if (typeof data.thinkingLevel !== "string")
        throw new ApiError(
          400,
          "INVALID_SETTINGS",
          "thinkingLevel is required",
        );
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          200,
          await workspace.changeThinkingLevel(data.thinkingLevel as string),
        );
      });
    }
    if (request.method === "GET" && action === "models") {
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      return json(
        response,
        200,
        await workspace.modelCatalog(
          controller.signal,
          url.searchParams.get("refresh") === "true",
        ),
      );
    }
    if (request.method === "PUT" && action === "model") {
      const data = await body(request);
      if (
        typeof data.provider !== "string" ||
        !data.provider ||
        typeof data.modelId !== "string" ||
        !data.modelId
      )
        throw new ApiError(
          400,
          "INVALID_MODEL",
          "Model selection requires provider and modelId",
        );
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          200,
          await workspace.changeModel(
            data.provider as string,
            data.modelId as string,
          ),
        );
      });
    }
    if (request.method === "GET" && !action)
      return json(response, 200, await workspace.status());
    if (request.method === "POST" && action === "goals") {
      const data = await body(request);
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          200,
          await workspace.saveGoal(
            "value" in data ? data.value : data,
            typeof data.requestId === "string" ? data.requestId : undefined,
          ),
        );
      });
    }
    if (request.method === "POST" && action === "loops") {
      const data = await body(request);
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          200,
          await workspace.saveLoop(
            "value" in data ? data.value : data,
            typeof data.requestId === "string" ? data.requestId : undefined,
          ),
        );
      });
    }
    if (request.method === "POST" && action === "input") {
      const data = await body(request, 6 * 1024 * 1024);
      const message = data.message,
        images = data.images,
        requestId = data.requestId,
        whenBusy = data.whenBusy;
      if (
        typeof message !== "string" ||
        (!message.trim() && images === undefined)
      )
        throw new ApiError(
          400,
          "INVALID_MESSAGE",
          "Input requires text or image content",
        );
      if (
        images !== undefined &&
        (!Array.isArray(images) || images.length < 1 || images.length > 4)
      )
        throw new ApiError(
          400,
          "INVALID_IMAGES",
          "Input images must contain one to four images",
        );
      let imageBytes = 0;
      const content =
        images === undefined
          ? message
          : [
              ...(message.trim()
                ? [{ type: "text" as const, text: message }]
                : []),
              ...images.map((image) => {
                if (!image || typeof image !== "object" || Array.isArray(image))
                  throw new ApiError(
                    400,
                    "INVALID_IMAGE",
                    "Image content must be an object",
                  );
                const candidate = image as Record<string, unknown>;
                if (
                  candidate.type !== "image" ||
                  !["image/png", "image/jpeg", "image/webp"].includes(
                    String(candidate.mimeType),
                  ) ||
                  typeof candidate.data !== "string" ||
                  !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                    candidate.data,
                  )
                )
                  throw new ApiError(
                    400,
                    "INVALID_IMAGE",
                    "Image must use base64 PNG, JPEG, or WebP content",
                  );
                const bytes = Buffer.from(candidate.data, "base64");
                if (
                  !bytes.length ||
                  bytes.toString("base64") !== candidate.data
                )
                  throw new ApiError(
                    400,
                    "INVALID_IMAGE",
                    "Image data must be canonical base64",
                  );
                const signatureMatches =
                  (candidate.mimeType === "image/png" &&
                    bytes.length >= 8 &&
                    bytes
                      .subarray(0, 8)
                      .equals(
                        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
                      )) ||
                  (candidate.mimeType === "image/jpeg" &&
                    bytes.length >= 3 &&
                    bytes[0] === 255 &&
                    bytes[1] === 216 &&
                    bytes[2] === 255) ||
                  (candidate.mimeType === "image/webp" &&
                    bytes.length >= 12 &&
                    bytes.toString("ascii", 0, 4) === "RIFF" &&
                    bytes.toString("ascii", 8, 12) === "WEBP");
                if (!signatureMatches)
                  throw new ApiError(
                    400,
                    "IMAGE_MIME_MISMATCH",
                    "Image bytes do not match their declared PNG, JPEG, or WebP MIME type",
                  );
                imageBytes += bytes.length;
                if (imageBytes > 4 * 1024 * 1024)
                  throw new ApiError(
                    413,
                    "IMAGES_TOO_LARGE",
                    "Prompt images must total at most 4 MiB",
                  );
                return {
                  type: "image" as const,
                  mimeType: candidate.mimeType as string,
                  data: candidate.data,
                };
              }),
            ];
      if (requestId !== undefined && typeof requestId !== "string")
        throw new ApiError(
          400,
          "INVALID_REQUEST_ID",
          "requestId must be a string",
        );
      if (
        whenBusy !== undefined &&
        whenBusy !== "steer" &&
        whenBusy !== "followUp" &&
        whenBusy !== "reject"
      )
        throw new ApiError(400, "INVALID_QUEUE_MODE", "Invalid whenBusy");
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(
          response,
          202,
          await workspace.input(content, requestId, whenBusy),
        );
      });
    }
    if (request.method === "POST" && action === "abort") {
      const data = await body(request);
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        await workspace.conversation.abort(
          (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
          { background: data.background === true },
        );
        return json(response, 200, await workspace.status());
      });
    }
    if (
      request.method === "POST" &&
      (action === "resume" || action === "retry")
    ) {
      await body(request);
      return await serialized(async () => {
        await assertActive(id, requestSignal);
        return json(response, 202, await workspace.resume());
      });
    }
    if (request.method === "GET" && action === "events") {
      let after = Number(
        url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0,
      );
      const limit = Number(url.searchParams.get("limit") ?? 200),
        diagnostics = url.searchParams.get("diagnostics") === "true";
      const conversationIdParam = url.searchParams.get("conversationId");
      const requestedConversationId = Number(conversationIdParam ?? 0);
      if (
        conversationIdParam !== null &&
        (!Number.isSafeInteger(requestedConversationId) ||
          requestedConversationId < 1)
      )
        throw new ApiError(
          400,
          "INVALID_CONVERSATION_ID",
          "conversationId must be a positive Durable conversation ID",
        );
      if (
        requestedConversationId &&
        requestedConversationId !== Number(workspace.conversation.id)
      )
        throw new ApiError(
          409,
          "WORKSPACE_SESSION_CHANGED",
          "The selected workspace session changed; reconnect to load its history",
        );
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
      const streamConversation = workspace.conversation;
      let pumping = false,
        dirty = false,
        ended = false;
      const includeLiveEvents = workspace.config.role !== "bot" || diagnostics;
      const watcherController = includeLiveEvents
        ? new AbortController()
        : undefined;
      let watcher: Awaited<ReturnType<typeof watchEvents>> | undefined;
      let pump = () => {};
      const notify = () => {
        pump();
      };
      const close = () => {
        if (ended) return;
        ended = true;
        watcherController?.abort();
        if (watcher) void watcher.stop();
        workspace.events.off("change", notify);
        workspace.events.off("branch", close);
        workspace.events.off("close", close);
        response.end();
      };
      workspace.events.on("change", notify);
      workspace.events.once("branch", close);
      workspace.events.once("close", close);
      response.once("close", close);
      if (watcherController) {
        const watcherContext = withAbortSignal(
          watcherController.signal,
          BACKGROUND_CONTEXT,
        );
        watcher = await watchEvents(
          workspace.harness,
          streamConversation.id,
          watcherContext,
        );
        if (ended) {
          watcherController.abort();
          void watcher.stop();
          return;
        }
      }
      const writeLive = (event: unknown) => {
        if (!ended && !response.destroyed)
          response.write(
            `event: live\ndata: ${JSON.stringify({ workspaceId: id, kind: "live", data: event })}\n\n`,
          );
      };
      if (watcher) {
        writeLive(watcher.snapshot);
        watcher.start(async (batch) => {
          for (const event of batch) writeLive(event);
        });
      }
      pump = async () => {
        dirty = true;
        if (pumping || ended) return;
        pumping = true;
        try {
          while (dirty && !ended) {
            dirty = false;
            let more = true;
            while (more && !ended) {
              const page = await workspace.history(
                after,
                200,
                diagnostics,
                streamConversation,
              );
              after = page.nextAfter;
              for (const event of page.events) {
                response.write(
                  `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
                );
              }
              more = page.hasMore;
            }
          }
        } catch (error) {
          process.stderr.write(
            `${JSON.stringify({
              event: "workspace_events_failed",
              workspaceId: id,
              cursor: after,
              error: (error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error)
              ).slice(0, 2000),
            })}\n`,
          );
          if (!ended && !response.destroyed) {
            response.write(
              'event: error\ndata: {"error":"Unable to read workspace event history"}\n\n',
            );
            response.end();
          }
        } finally {
          pumping = false;
        }
      };
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
process.on("unhandledRejection", (reason) => {
  if (
    reason instanceof ApiError &&
    (reason.code === "WORKSPACE_DELETED" ||
      reason.code === "RUNTIME_FENCE_REJECTED")
  ) {
    console.error(
      JSON.stringify({
        event: "runtime-work-cancelled",
        code: reason.code,
        message: reason.message,
      }),
    );
    return;
  }
  throw reason;
});
