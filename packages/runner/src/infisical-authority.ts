// The installation's Infisical machine identity (TASK-138). `adm infisical
// login` hands a Universal Auth client ID and secret to this authority, which
// checks them with one real login and keeps them in `infisical.json` beside
// `github.json` on the lifecycle state volume. Coding Pods get a short-lived
// access token through `GET /v1/runtime/infisical/token` (the lifecycle
// controller refuses bots). The access token is cached in memory and a new
// one is minted only when a request finds less than 10 minutes left: no timer.
// The client secret and access tokens are never logged and never in status.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const MIN_TOKEN_VALIDITY_MS = 10 * 60_000;
const NOT_CONFIGURED =
  "Infisical is not connected to this installation: run adm infisical login";

type StoredInfisicalLogin = {
  clientId: string;
  clientSecret: string;
  domain: string;
  loggedInAt: string;
};
type InfisicalAccessToken = { token: string; expiresAt: number };
type InfisicalLastMint =
  | { result: "ok"; at: string; expiresAt: string }
  | { result: "login_expired" | "unavailable"; at: string; error: string };
type Log = (
  level: "info" | "warn" | "error",
  event: string,
  fields?: Record<string, unknown>,
) => void;

class InfisicalError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Infisical's answer to a universal-auth login, as the Infisical CLI reads it
// (`packages/api` UniversalAuthLoginResponse). A 4xx means it refused the
// pair; anything else is Infisical being unreachable or broken. 424 rather
// than 5xx, because the lifecycle proxy hides 5xx bodies behind a generic
// "provider auth unavailable".
async function infisicalUniversalAuthLogin(
  login: Pick<StoredInfisicalLogin, "clientId" | "clientSecret" | "domain">,
): Promise<InfisicalAccessToken> {
  let response: Response;
  try {
    response = await fetch(`${login.domain}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "adm-lifecycle" },
      body: JSON.stringify({ clientId: login.clientId, clientSecret: login.clientSecret }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new InfisicalError(
      424,
      "INFISICAL_UNAVAILABLE",
      `could not reach Infisical at ${login.domain} (${error instanceof Error ? error.message : error})`,
    );
  }
  const value = (await response.json().catch(() => ({}))) as {
    accessToken?: unknown;
    expiresIn?: unknown;
    message?: unknown;
  };
  if (response.status >= 400 && response.status < 500)
    throw new InfisicalError(
      409,
      "INFISICAL_LOGIN_EXPIRED",
      `Infisical refused machine identity ${login.clientId} at ${login.domain} (${response.status}: ${
        typeof value.message === "string" ? value.message.slice(0, 200) : "no message"
      }): run adm infisical login`,
    );
  if (!response.ok || typeof value.accessToken !== "string" || !value.accessToken || typeof value.expiresIn !== "number")
    throw new InfisicalError(
      424,
      "INFISICAL_UNAVAILABLE",
      `Infisical at ${login.domain} answered ${response.status} without an access token`,
    );
  return { token: value.accessToken, expiresAt: Date.now() + value.expiresIn * 1000 };
}

function infisicalDomain(value: unknown) {
  if (typeof value !== "string" || !value)
    throw new InfisicalError(400, "INVALID_REQUEST", "domain must be an http(s) URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InfisicalError(400, "INVALID_REQUEST", `domain ${value} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new InfisicalError(400, "INVALID_REQUEST", "domain must be an http(s) URL");
  // The Infisical CLI's --domain accepts both forms; store the one without /api.
  return url.toString().replace(/\/+$/, "").replace(/\/api$/, "");
}

export async function createInfisicalAuthority({
  statePath,
  ownerGuard,
  log,
}: {
  statePath: string;
  ownerGuard?: () => Promise<boolean>;
  log: Log;
}) {
  const configParent = dirname(statePath);
  let stored: StoredInfisicalLogin | undefined;
  try {
    const info = await lstat(statePath);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Infisical login store must be a regular file");
    await chmod(statePath, 0o600);
    const value = JSON.parse(await readFile(statePath, "utf8"));
    if (
      typeof value.clientId !== "string" ||
      !value.clientId ||
      typeof value.clientSecret !== "string" ||
      !value.clientSecret ||
      typeof value.domain !== "string"
    )
      throw new Error("Infisical login store is invalid");
    stored = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let cachedToken: InfisicalAccessToken | undefined;
  let mintInFlight: { login: StoredInfisicalLogin; minting: Promise<InfisicalAccessToken> } | undefined;
  let lastMint: InfisicalLastMint | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  let closed = false;

  function persist(next: StoredInfisicalLogin | undefined) {
    const write = writes.then(async () => {
      if (closed) throw new Error("Infisical login store is closed");
      if (ownerGuard && !(await ownerGuard()))
        throw new InfisicalError(
          424,
          "INFISICAL_UNAVAILABLE",
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
      cachedToken = undefined;
      lastMint = undefined;
    });
    writes = write.catch(() => {});
    return write;
  }

  // One login at a time; concurrent requests share it. A failure is never
  // cached: the next request tries again.
  function mintInfisicalAccessToken(login: StoredInfisicalLogin) {
    if (mintInFlight?.login === login) return mintInFlight.minting;
    const minting = infisicalUniversalAuthLogin(login)
      .then(
        (minted) => {
          if (stored === login) {
            cachedToken = minted;
            lastMint = { result: "ok", at: new Date().toISOString(), expiresAt: new Date(minted.expiresAt).toISOString() };
          }
          log("info", "infisical_token_minted", {
            clientId: login.clientId,
            expiresAt: new Date(minted.expiresAt).toISOString(),
          });
          return minted;
        },
        (error) => {
          const expired = error instanceof InfisicalError && error.code === "INFISICAL_LOGIN_EXPIRED";
          if (stored === login)
            lastMint = {
              result: expired ? "login_expired" : "unavailable",
              at: new Date().toISOString(),
              error: error instanceof Error ? error.message : String(error),
            };
          log("error", expired ? "infisical_token_login_expired" : "infisical_token_mint_failed", {
            clientId: login.clientId,
            domain: login.domain,
            cause: error instanceof Error ? error.message : String(error),
          });
          throw error;
        },
      )
      .finally(() => {
        if (mintInFlight?.minting === minting) mintInFlight = undefined;
      });
    mintInFlight = { login, minting };
    return minting;
  }

  async function runtimeInfisicalToken() {
    const login = stored;
    if (!login) throw new InfisicalError(409, "INFISICAL_NOT_CONFIGURED", NOT_CONFIGURED);
    const current =
      cachedToken && cachedToken.expiresAt - Date.now() >= MIN_TOKEN_VALIDITY_MS
        ? cachedToken
        : await mintInfisicalAccessToken(login);
    return { token: current.token, expiresAt: new Date(current.expiresAt).toISOString() };
  }

  async function loginInfisical(value: Record<string, unknown>) {
    if (typeof value.clientId !== "string" || !value.clientId.trim())
      throw new InfisicalError(400, "INVALID_REQUEST", "clientId is required");
    if (typeof value.clientSecret !== "string" || !value.clientSecret)
      throw new InfisicalError(400, "INVALID_REQUEST", "clientSecret is required");
    const login = {
      clientId: value.clientId.trim(),
      clientSecret: value.clientSecret,
      domain: infisicalDomain(value.domain),
    };
    let minted: InfisicalAccessToken;
    try {
      minted = await infisicalUniversalAuthLogin(login);
    } catch (error) {
      log("warn", "infisical_login_refused", {
        clientId: login.clientId,
        domain: login.domain,
        cause: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof InfisicalError && error.code === "INFISICAL_LOGIN_EXPIRED")
        throw new InfisicalError(
          400,
          "INFISICAL_LOGIN_REFUSED",
          error.message.replace(/: run adm infisical login$/, "; check the client ID, secret and --domain"),
        );
      throw error;
    }
    await persist({ ...login, loggedInAt: new Date().toISOString() });
    // The checking login's token is as good as any: serve it until it runs low.
    cachedToken = minted;
    lastMint = { result: "ok", at: new Date().toISOString(), expiresAt: new Date(minted.expiresAt).toISOString() };
    log("info", "infisical_login_succeeded", { clientId: login.clientId, domain: login.domain });
    return { clientId: login.clientId, domain: login.domain };
  }

  function infisicalStatus() {
    if (!stored) return { status: "not_configured" };
    return {
      status: lastMint?.result === "login_expired" ? "login_expired" : "connected",
      clientId: stored.clientId,
      domain: stored.domain,
      loggedInAt: stored.loggedInAt,
      lastMint: lastMint ?? null,
    };
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith("/v1/infisical/") && !path.startsWith("/v1/runtime/infisical/"))
      return false;
    try {
      if (request.method === "GET" && path === "/v1/runtime/infisical/token") {
        if (!stored) log("warn", "infisical_token_unavailable", { reason: "not_configured" });
        return send(response, 200, await runtimeInfisicalToken());
      }
      if (request.method === "GET" && path === "/v1/infisical/status")
        return send(response, 200, { infisical: infisicalStatus() });
      if (request.method === "POST" && path === "/v1/infisical/login")
        return send(response, 200, await loginInfisical(await body(request)));
      if (request.method === "POST" && path === "/v1/infisical/logout") {
        const clientId = stored?.clientId ?? null;
        await persist(undefined);
        log("info", "infisical_logout", { clientId });
        return send(response, 200, {});
      }
      throw new InfisicalError(404, "NOT_FOUND", "Infisical route not found");
    } catch (error) {
      if (error instanceof InfisicalError)
        send(response, error.status, { error: { code: error.code, message: error.message } });
      else
        send(response, 400, {
          error: { code: "INFISICAL_ERROR", message: error instanceof Error ? error.message : String(error) },
        });
      return true;
    }
  }

  return {
    handle,
    async close() {
      closed = true;
      await writes;
    },
  };
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
  return true;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new InfisicalError(400, "INVALID_REQUEST", "request body too large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new InfisicalError(400, "INVALID_REQUEST", "request body must be JSON");
  }
}
