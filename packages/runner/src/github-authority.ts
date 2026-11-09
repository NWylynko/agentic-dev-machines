// The installation's GitHub login (TASK-111). `adm repos login github` runs
// `gh auth login --web` here, in the cluster, and keeps the resulting OAuth
// token in `github.json` beside the provider credentials on the lifecycle
// state volume. Coding Pods (and their repositories sidecar) fetch it at
// runtime through the lifecycle controller, which refuses bots. The token is
// never logged, never in argv, and never leaves this volume except in the
// response to `GET /v1/runtime/repos/token`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const NOT_LOGGED_IN =
  "GitHub is not connected to this installation: run adm repos login github";

type StoredGithubLogin = { token: string; account: string; loggedInAt: string };
type Log = (
  level: "info" | "warn" | "error",
  event: string,
  fields?: Record<string, unknown>,
) => void;

class GithubError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type LoginOperation = {
  controller: AbortController;
  events: unknown[];
  waiters: ((value: unknown | undefined) => void)[];
};

export async function createGithubAuthority({
  statePath,
  ownerGuard,
  log,
}: {
  statePath: string;
  ownerGuard?: () => Promise<boolean>;
  log: Log;
}) {
  const configParent = dirname(statePath);
  let stored: StoredGithubLogin | undefined;
  try {
    const info = await lstat(statePath);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("GitHub login store must be a regular file");
    await chmod(statePath, 0o600);
    const value = JSON.parse(await readFile(statePath, "utf8"));
    if (
      typeof value.token !== "string" ||
      !value.token ||
      typeof value.account !== "string"
    )
      throw new Error("GitHub login store is invalid");
    stored = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const operations = new Map<string, LoginOperation>();
  let writes: Promise<unknown> = Promise.resolve();
  let closed = false;

  function persist(next: StoredGithubLogin | undefined) {
    const write = writes.then(async () => {
      if (closed) throw new Error("GitHub login store is closed");
      if (ownerGuard && !(await ownerGuard()))
        throw new GithubError(
          503,
          "GITHUB_UNAVAILABLE",
          "Lifecycle provider-auth owner fence is not current",
        );
      if (next) {
        const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(next));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, statePath);
      } else {
        await unlink(statePath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      const directory = await open(configParent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      stored = next;
    });
    writes = write.catch(() => {});
    return write;
  }

  function publish(operation: LoginOperation, value: unknown) {
    const waiter = operation.waiters.shift();
    if (waiter) waiter(value);
    else operation.events.push(value);
  }

  function nextEvent(operation: LoginOperation, response: ServerResponse) {
    const queued = operation.events.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<unknown | undefined>((resolve) => {
      const finish = (value: unknown | undefined) => {
        response.off("close", gone);
        resolve(value);
      };
      const gone = () => {
        const index = operation.waiters.indexOf(finish);
        if (index >= 0) operation.waiters.splice(index, 1);
        finish(undefined);
      };
      operation.waiters.push(finish);
      response.once("close", gone);
    });
  }

  // gh runs with only its own config directory (on the state volume, removed
  // afterwards) and no token from this process's environment.
  function ghEnv(configDir: string, token?: string) {
    return {
      PATH: process.env.PATH ?? "",
      HOME: configDir,
      GH_CONFIG_DIR: configDir,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_BROWSER: "true",
      NO_COLOR: "1",
      ...(token ? { GH_TOKEN: token } : {}),
    };
  }

  function ghOutput(args: string[], env: Record<string, string>) {
    return new Promise<string>((resolve, reject) =>
      execFile("gh", args, { env, timeout: 60_000 }, (error, stdout, stderr) =>
        error
          ? reject(new Error(`gh ${args[0]} failed: ${stderr.trim().slice(0, 300) || error.message}`))
          : resolve(stdout),
      ),
    );
  }

  async function runLogin(operation: LoginOperation) {
    const startedAt = Date.now();
    log("info", "github_login_started");
    const configDir = await mkdtemp(join(configParent, "gh-"));
    try {
      const child = spawn(
        "gh",
        [
          "auth", "login",
          "--hostname", "github.com",
          "--web",
          "--git-protocol", "https",
          "--insecure-storage",
          "--skip-ssh-key",
          // Added to gh's defaults (repo, read:org, gist): workflow lets
          // agents push .github/workflows changes; read:packages pulls
          // private GHCR packages.
          "--scopes", "workflow,read:packages",
        ],
        {
          env: ghEnv(configDir),
          stdio: ["ignore", "pipe", "pipe"],
          signal: operation.controller.signal,
          timeout: LOGIN_TIMEOUT_MS,
        },
      );
      let output = "";
      let code: string | undefined;
      let uri: string | undefined;
      const read = (chunk: Buffer) => {
        output = (output + chunk).slice(-4000);
        code ??= /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)?.[1];
        uri ??= /continue in your web browser:\s*(https:\/\/\S+)/.exec(output)?.[1];
        if (code && uri) {
          publish(operation, {
            type: "device_code",
            userCode: code,
            verificationUri: uri,
          });
          code = uri = undefined;
          output = "";
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      const exit = await new Promise<number | string>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (status, signal) => resolve(status ?? signal ?? "unknown"));
      });
      if (exit !== 0) throw new Error(`gh auth login exited ${exit}`);
      const token = (await ghOutput(["auth", "token", "--hostname", "github.com"], ghEnv(configDir))).trim();
      if (!token) throw new Error("gh produced no token");
      const account = (await ghOutput(["api", "user", "--jq", ".login"], ghEnv(configDir, token))).trim();
      if (!account) throw new Error("gh could not read the account");
      await persist({ token, account, loggedInAt: new Date().toISOString() });
      let repositories: number | undefined;
      try {
        repositories = (
          await ghOutput(
            ["api", "--paginate", "user/repos?per_page=100&affiliation=owner,collaborator,organization_member", "--jq", ".[].id"],
            ghEnv(configDir, token),
          )
        )
          .split("\n")
          .filter(Boolean).length;
      } catch (error) {
        log("warn", "github_repository_count_failed", { cause: String(error instanceof Error ? error.message : error).slice(0, 300) });
      }
      log("info", "github_login_succeeded", { account, repositories, durationMs: Date.now() - startedAt });
      publish(operation, { type: "complete", account, repositories });
    } catch (error) {
      const cause = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      log("error", "github_login_failed", { cause, durationMs: Date.now() - startedAt });
      publish(operation, { type: "error", message: `GitHub login failed (${cause})` });
    } finally {
      await rm(configDir, { recursive: true });
    }
  }

  // Can the cluster reach OWNER/REPO (and BRANCH)? Uses the cluster login when
  // there is one, otherwise only public repositories answer. Returns the
  // canonical name and the branch to register (TASK-112).
  async function checkRepository(repo: unknown, ref: unknown) {
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new GithubError(400, "INVALID_REQUEST", "repo must be OWNER/REPO");
    if (ref !== undefined && ref !== null && typeof ref !== "string")
      throw new GithubError(400, "INVALID_REQUEST", "ref must be a branch name");
    const api = process.env.ADM_GITHUB_API_URL ?? "https://api.github.com";
    const get = (resource: string) =>
      fetch(`${api}/${resource}`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "adm-lifecycle",
          ...(stored ? { authorization: `Bearer ${stored.token}` } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
    const unreachable = (why: string) =>
      new GithubError(
        404,
        "REPOSITORY_NOT_REACHABLE",
        `${repo} is not reachable with the GitHub login (${
          stored ? `account ${stored.account}` : "not logged in; run adm repos login github"
        }): ${why}`,
      );
    let found: Response;
    try {
      found = await get(`repos/${repo}`);
    } catch (error) {
      throw new GithubError(503, "GITHUB_UNAVAILABLE", `could not ask GitHub about ${repo}: ${error instanceof Error ? error.message : error}`);
    }
    if (!found.ok) throw unreachable(found.status === 404 ? "not found, or private to other accounts" : `GitHub answered ${found.status}`);
    const details = (await found.json()) as { full_name?: string; default_branch?: string };
    if (!details.full_name || !details.default_branch)
      throw unreachable("GitHub returned no repository details");
    const branch = ref ?? details.default_branch;
    if (ref) {
      const exists = await get(`repos/${repo}/branches/${ref.split("/").map(encodeURIComponent).join("/")}`);
      if (!exists.ok)
        throw new GithubError(404, "BRANCH_NOT_FOUND", `branch ${ref} was not found in ${details.full_name}`);
    }
    log("info", "github_repository_checked", { repo: details.full_name, branch, authenticated: Boolean(stored) });
    return { repo: details.full_name, ref: branch };
  }

  // Creates OWNER/REPO as an empty private repository with the cluster login,
  // on the logged-in account or on an organization (TASK-117).
  async function createRepository(repo: unknown) {
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new GithubError(400, "INVALID_REQUEST", "repo must be OWNER/REPO");
    if (!stored) throw new GithubError(409, "GITHUB_NOT_LOGGED_IN", NOT_LOGGED_IN);
    const [owner, name] = repo.split("/");
    const api = process.env.ADM_GITHUB_API_URL ?? "https://api.github.com";
    const own = owner.toLowerCase() === stored.account.toLowerCase();
    let created: Response;
    try {
      created = await fetch(`${api}/${own ? "user/repos" : `orgs/${owner}/repos`}`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "adm-lifecycle",
          authorization: `Bearer ${stored.token}`,
        },
        body: JSON.stringify({ name, private: true, auto_init: false }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new GithubError(503, "GITHUB_UNAVAILABLE", `could not ask GitHub to create ${repo}: ${error instanceof Error ? error.message : error}`);
    }
    const details = (await created.json().catch(() => ({}))) as {
      full_name?: string;
      message?: string;
      errors?: { message?: string }[];
    };
    if (created.status === 422 && details.errors?.some((error) => /already exists/.test(error.message ?? "")))
      throw new GithubError(409, "REPOSITORY_EXISTS", `${repo} already exists on GitHub; use --repo ${repo} to open it`);
    if (!created.ok || !details.full_name)
      throw new GithubError(
        created.status === 404 ? 404 : 502,
        "REPOSITORY_NOT_CREATED",
        `GitHub refused to create ${repo} for account ${stored.account} (${created.status}: ${details.message ?? "no message"})`,
      );
    log("info", "github_repository_created", { repo: details.full_name, account: stored.account });
    return { repo: details.full_name, account: stored.account };
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith("/v1/repos/") && !path.startsWith("/v1/runtime/repos/"))
      return false;
    try {
      if (request.method === "GET" && path === "/v1/runtime/repos/token") {
        if (!stored) {
          log("warn", "github_token_unavailable", { reason: "not_logged_in" });
          throw new GithubError(409, "GITHUB_NOT_LOGGED_IN", NOT_LOGGED_IN);
        }
        return send(response, 200, { token: stored.token, account: stored.account });
      }
      if (request.method === "POST" && path === "/v1/runtime/repos/rejected") {
        // A workspace's git reported GitHub refusing the token. Record that,
        // never the token, so `adm system-log` shows a revoked login.
        log("warn", "github_token_rejected", {
          account: stored?.account ?? null,
          hint: "run adm repos login github",
        });
        return send(response, 200, {});
      }
      if (request.method === "GET" && path === "/v1/repos/status")
        return send(response, 200, {
          github: stored
            ? { status: "connected", account: stored.account, loggedInAt: stored.loggedInAt }
            : { status: "not_logged_in" },
        });
      if (request.method === "POST" && path === "/v1/repos/create") {
        const value = await body(request);
        return send(response, 200, await createRepository(value.repo));
      }
      if (request.method === "POST" && path === "/v1/repos/check") {
        const value = await body(request);
        return send(response, 200, await checkRepository(value.repo, value.ref));
      }
      if (request.method === "POST" && path === "/v1/repos/login") {
        const value = await body(request);
        if (value.provider !== "github")
          throw new GithubError(400, "INVALID_REQUEST", "only the github repository provider is available");
        const id = randomUUID();
        const operation: LoginOperation = { controller: new AbortController(), events: [], waiters: [] };
        operations.set(id, operation);
        void runLogin(operation);
        return send(response, 202, { operationId: id });
      }
      const match = /^\/v1\/repos\/login\/([0-9a-f-]+)(?:\/(events))?$/.exec(path);
      if (match) {
        const operation = operations.get(match[1]!);
        if (!operation)
          throw new GithubError(404, "LOGIN_NOT_FOUND", "login operation not found");
        if (request.method === "DELETE" && !match[2]) {
          operation.controller.abort();
          for (const waiter of operation.waiters.splice(0)) waiter(undefined);
          operations.delete(match[1]!);
          return send(response, 200, {});
        }
        if (request.method === "GET" && match[2] === "events") {
          const event = await nextEvent(operation, response);
          if (event === undefined) return true;
          const terminal = ["complete", "error"].includes((event as { type?: string }).type ?? "");
          if (terminal) operations.delete(match[1]!);
          return send(response, 200, { event, done: terminal });
        }
      }
      if (request.method === "POST" && path === "/v1/repos/logout") {
        const value = await body(request);
        if (value.provider !== "github")
          throw new GithubError(400, "INVALID_REQUEST", "only the github repository provider is available");
        const account = stored?.account ?? null;
        await persist(undefined);
        log("info", "github_logout", { account });
        return send(response, 200, {});
      }
      throw new GithubError(404, "NOT_FOUND", "repository login route not found");
    } catch (error) {
      if (error instanceof GithubError)
        send(response, error.status, { error: { code: error.code, message: error.message } });
      else
        send(response, 400, {
          error: { code: "GITHUB_ERROR", message: error instanceof Error ? error.message : String(error) },
        });
      return true;
    }
  }

  return {
    handle,
    async close() {
      closed = true;
      for (const operation of operations.values()) operation.controller.abort();
      await writes;
    },
  };
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
  return true;
}

async function body(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new GithubError(400, "INVALID_REQUEST", "request body too large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new GithubError(400, "INVALID_REQUEST", "request body must be JSON");
  }
}
