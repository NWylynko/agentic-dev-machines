import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AuthCheck,
  AuthEvent,
  AuthPrompt,
  AuthType,
} from "@earendil-works/pi-ai";
import { createAgentsFileAuthority } from "./agents-file-authority.ts";
import { createConnectorAuthority } from "./connector-authority.ts";

export type SharedProviderCatalog = Record<
  string,
  {
    auth?: AuthCheck;
    models: string[];
    allModels: string[];
    /** Safe to show to the user. Other providers are unaffected. */
    error?: string;
  }
>;

type AuthorityOptions = {
  authPath: string;
  configure?: (runtime: any) => void;
  ownerGuard?: () => Promise<boolean>;
  /** Receives one JSON line per event; defaults to stdout (TASK-109). */
  log?: (line: string) => void;
  /** Clock and timers for scheduled refreshes; injectable for tests. */
  refreshScheduler?: ProviderRefreshScheduler;
  /** Per-provider catalog budget. Tests use a short one; production is 10s. */
  catalogProviderTimeoutMs?: number;
};

export type ProviderRefreshScheduler = {
  now(): number;
  setTimer(run: () => Promise<void>, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
};

const systemProviderRefreshScheduler: ProviderRefreshScheduler = {
  now: () => Date.now(),
  setTimer: (run, delayMs) => setTimeout(run, delayMs).unref(),
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

// Refresh stored OAuth credentials this long before their stored `expires`
// (Pi already saves `expires` 5 min early). Agreed with Nick 2026-10-30.
const PROVIDER_REFRESH_LEAD_MS = 10 * 60 * 1000;
// Pi requires `expires` on OAuth credentials, so this should never apply.
const PROVIDER_REFRESH_WITHOUT_EXPIRY_MS = 60 * 60 * 1000;
// setTimeout fires at once for delays above 2^31-1 ms (~24.8 days).
const MAX_PROVIDER_REFRESH_TIMER_MS = 2 ** 31 - 1;

type ProviderAuthLogLevel = "info" | "warn" | "error";
export type ProviderAuthLog = (
  level: ProviderAuthLogLevel,
  event: string,
  fields?: Record<string, unknown>,
) => void;

// One JSON line per event on stdout, read with `adm system-log` (TASK-109).
// Callers pass provider IDs, timings and error messages only, never credentials.
export function createProviderAuthLog(
  write: (line: string) => void = (line) => console.log(line),
): ProviderAuthLog {
  return (level, event, fields = {}) =>
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        service: "provider-auth",
        level,
        event,
        ...fields,
      }),
    );
}

/** Messages of an error and its `cause` chain, outermost first. */
export function providerAuthCauseChain(error: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 10) {
    chain.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function providerAuthRootCause(error: unknown): string {
  return providerAuthCauseChain(error).at(-1) ?? "unknown error";
}

/** An error whose message is safe to return to the caller as is. */
class ProviderAuthRequestError extends Error {}

class ProviderAuthFenceError extends Error {
  constructor() {
    super("Lifecycle provider-auth owner fence is not current");
  }
}

type ProviderRefreshFailureKind = "fence" | "permanent" | "transient";

class ProviderRefreshError extends ProviderAuthRequestError {
  readonly kind: ProviderRefreshFailureKind;
  constructor(
    message: string,
    kind: ProviderRefreshFailureKind,
    options: { cause: unknown },
  ) {
    super(message, options);
    this.kind = kind;
  }
}

// The token endpoint rejected the refresh token itself: retrying cannot
// help, only a new login can. Everything else (network, timeout, 5xx) is
// treated as transient.
const PERMANENT_REFRESH_FAILURE = /invalid_grant|\b(?:HTTP|status) 40[01]\b/;

function classifyProviderRefreshFailure(
  error: unknown,
): ProviderRefreshFailureKind {
  for (
    let current: unknown = error;
    current;
    current = (current as Error).cause
  )
    if (current instanceof ProviderAuthFenceError) return "fence";
  return PERMANENT_REFRESH_FAILURE.test(
    providerAuthCauseChain(error).join("\n"),
  )
    ? "permanent"
    : "transient";
}

const PROVIDER_REFRESH_RETRY_DELAYS_MS = [1, 2, 4, 8].map(
  (minutes) => minutes * 60_000,
);
const PROVIDER_REFRESH_RETRY_MAX_DELAY_MS = 15 * 60_000;

function rotatedRefreshTokenProviders(
  before: string | undefined,
  after: string,
): string[] {
  const parse = (text: string | undefined) => {
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  };
  const previous = parse(before);
  const next = parse(after);
  return Object.keys(next).filter(
    (providerId) =>
      previous[providerId]?.type === "oauth" &&
      next[providerId]?.type === "oauth" &&
      previous[providerId].refresh !== next[providerId].refresh,
  );
}

const PI_OAUTH_REFRESH_WINDOW_MS = 5 * 60 * 1000;
// One provider's token endpoint must not hold the catalog. Agreed as 10s (TASK-97).
const CATALOG_PROVIDER_TIMEOUT_MS = 10_000;

type LoginOperation = {
  controller: AbortController;
  events: unknown[];
  waiters: ((value: unknown | undefined) => void)[];
  prompts: Map<string, (value: string) => void>;
};

function send(response: ServerResponse, status: number, value?: unknown) {
  response.writeHead(
    status,
    value === undefined ? {} : { "content-type": "application/json" },
  );
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cleanPrompt(prompt: AuthPrompt): Omit<AuthPrompt, "signal"> {
  const { signal: _signal, ...safe } = prompt;
  return safe;
}

export function createOwnerEpochGuard(
  readOwnerEpoch: () => Promise<number | undefined>,
): () => Promise<boolean> {
  let ownerEpoch: number | undefined;
  let invalidated = false;
  return async () => {
    if (invalidated) return false;
    let currentEpoch: number | undefined;
    try {
      currentEpoch = await readOwnerEpoch();
    } catch {
      currentEpoch = undefined;
    }
    if (!Number.isSafeInteger(currentEpoch) || currentEpoch! <= 0) {
      if (ownerEpoch !== undefined) invalidated = true;
      return false;
    }
    if (ownerEpoch === undefined) {
      ownerEpoch = currentEpoch;
      return true;
    }
    if (ownerEpoch !== currentEpoch) {
      invalidated = true;
      return false;
    }
    return true;
  };
}

async function createGuardedCredentialStore(
  authPath: string,
  ownerGuard: () => Promise<boolean>,
  log: ProviderAuthLog,
) {
  // Pi does not export these storage primitives. Wrapping its pinned backend
  // keeps its cross-process lock while fencing the final persisted mutation.
  const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const storageModule = await import(
    new URL("./core/auth-storage.js", packageEntry).href
  );
  const backend = new storageModule.FileAuthStorageBackend(authPath);
  let closed = false;
  const pendingCredentialOperations = new Set<Promise<unknown>>();
  const assertCredentialStoreOpen = () => {
    if (closed) throw new Error("Provider credential store is closed");
  };
  const guardedBackend = {
    withLock<T>(
      update: (content: string | undefined) => { result: T; next?: string },
    ): T {
      assertCredentialStoreOpen();
      return backend.withLock((content: string | undefined) => {
        const result = update(content);
        if (result.next !== undefined)
          throw new Error(
            "Synchronous provider credential writes are not allowed",
          );
        return result;
      });
    },
    async withLockAsync<T>(
      update: (
        content: string | undefined,
      ) => Promise<{ result: T; next?: string }>,
      options?: { signal?: AbortSignal },
    ): Promise<T> {
      assertCredentialStoreOpen();
      const operation = backend.withLockAsync(
        async (content: string | undefined) => {
          const result = await update(content);
          if (result.next !== undefined && !(await ownerGuard())) {
            log("warn", "fence_rejected", { operation: "credential write" });
            for (const providerId of rotatedRefreshTokenProviders(
              content,
              result.next,
            ))
              log("error", "refresh_token_lost", {
                provider: providerId,
                message: `${providerId}: refreshed, but the owner fence was lost before saving, so the rotated refresh token was lost and the stored one is probably spent: run adm login ${providerId}`,
              });
            throw new ProviderAuthFenceError();
          }
          return result;
        },
        options,
      );
      pendingCredentialOperations.add(operation);
      try {
        return await operation;
      } finally {
        pendingCredentialOperations.delete(operation);
      }
    },
  };
  // With authPath, reads use Pi's file-revision cache like its default store;
  // `fromStorage` would reload under the lock on every read.
  const credentials = new storageModule.AuthStorage(guardedBackend, authPath);
  // Pi refreshes OAuth inside `modify`, under the credential lock. Check the
  // owner fence there before Pi's update runs: a refresh spends the stored
  // refresh token, so a non-owner must never start one (TASK-109). Plain
  // reads also take the lock (Pi reloads through withLockAsync) and are not
  // fenced, so the check sits on `modify`, not on the backend.
  const modifyCredential = credentials.modify.bind(credentials);
  credentials.modify = (
    providerId: string,
    update: (current: unknown) => Promise<unknown>,
    options?: { signal?: AbortSignal },
  ) =>
    modifyCredential(
      providerId,
      async (current: unknown) => {
        if (!(await ownerGuard())) {
          log("warn", "fence_rejected", {
            operation: "credential update",
            provider: providerId,
          });
          throw new ProviderAuthFenceError();
        }
        return update(current);
      },
      options,
    );
  return {
    credentials,
    close: async () => {
      // Pi's background catalog reads can outlive the HTTP server. Fence new
      // storage work, then wait for admitted operations to release their locks.
      closed = true;
      await Promise.allSettled(pendingCredentialOperations);
    },
  };
}

export async function createProviderAuthAuthority({
  authPath,
  configure,
  ownerGuard,
  log: writeLog,
  refreshScheduler = systemProviderRefreshScheduler,
  catalogProviderTimeoutMs = CATALOG_PROVIDER_TIMEOUT_MS,
}: AuthorityOptions) {
  const log = createProviderAuthLog(writeLog);
  const authDirectory = dirname(authPath);
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(authDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
    throw new Error("Provider auth directory must be a real directory");
  await chmod(authDirectory, 0o700);
  try {
    const authInfo = await lstat(authPath);
    if (authInfo.isSymbolicLink() || !authInfo.isFile())
      throw new Error("Provider auth store must be a regular file");
    await chmod(authPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const credentialStore = await createGuardedCredentialStore(
    authPath,
    ownerGuard ?? (async () => true),
    log,
  );
  const runtime = await ModelRuntime.create({
    authPath,
    credentials: credentialStore.credentials,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  configure?.(runtime);
  const connectors = await createConnectorAuthority({
    statePath: join(authDirectory, "connectors.json"),
    ownerGuard,
  });
  const agentsFile = await createAgentsFileAuthority({
    statePath: join(authDirectory, "agents-file.json"),
    ownerGuard,
    log,
  });
  const operations = new Map<string, LoginOperation>();
  const providerRefreshesInFlight = new Map<string, Promise<unknown>>();
  // Providers whose refresh token the token endpoint rejected; shown as
  // `login_expired` in /providers until the next login or refresh.
  const providerLoginsExpired = new Map<
    string,
    { cause: string; since: string }
  >();
  const providerRefreshAttempts = new Map<string, number>();

  const readStoredCredential = (providerId: string): Promise<any> =>
    credentialStore.credentials.read(providerId);

  // Every refresh, from a request or the schedule, goes through Pi's normal
  // path (`getAuth`, under the credential lock) and is logged here. One
  // refresh per provider runs at a time; concurrent callers share it.
  function refreshProviderCredential(
    providerId: string,
    trigger: "request" | "scheduled",
    minOAuthValidityMs?: number,
    signal?: AbortSignal,
  ) {
    const pending = providerRefreshesInFlight.get(providerId);
    if (pending) return pending;
    const refresh = (async () => {
      const startedAt = Date.now();
      log("info", "refresh_started", { provider: providerId, trigger });
      try {
        await runtime.getAuth(providerId, {
          ...(minOAuthValidityMs === undefined ? {} : { minOAuthValidityMs }),
          ...(signal ? { signal } : {}),
        });
        const credential = await readStoredCredential(providerId);
        log("info", "refresh_succeeded", {
          provider: providerId,
          trigger,
          expires:
            credential?.type === "oauth" && Number.isFinite(credential.expires)
              ? new Date(credential.expires).toISOString()
              : null,
          durationMs: Date.now() - startedAt,
        });
        providerLoginsExpired.delete(providerId);
        await scheduleProviderCredentialRefresh(providerId);
        return credential;
      } catch (error) {
        const kind = classifyProviderRefreshFailure(error);
        const cause = providerAuthRootCause(error);
        const message =
          `${providerId}: token refresh failed (${cause})` +
          (kind === "permanent" ? `: run adm login ${providerId}` : "");
        if (kind === "permanent")
          providerLoginsExpired.set(providerId, {
            cause,
            since: new Date().toISOString(),
          });
        log("error", "refresh_failed", {
          provider: providerId,
          trigger,
          operation: "token refresh",
          kind,
          message,
          durationMs: Date.now() - startedAt,
          cause: providerAuthCauseChain(error),
        });
        throw new ProviderRefreshError(message, kind, { cause: error });
      }
    })();
    providerRefreshesInFlight.set(providerId, refresh);
    void refresh
      .finally(() => {
        if (providerRefreshesInFlight.get(providerId) === refresh)
          providerRefreshesInFlight.delete(providerId);
      })
      .catch(() => {});
    return refresh;
  }

  // While provider-auth runs, each stored OAuth credential is refreshed
  // PROVIDER_REFRESH_LEAD_MS before its own stored `expires`, so an idle
  // login stays fresh. Rescheduled after every refresh, login and logout,
  // and on start (TASK-109).
  const providerRefreshTimers = new Map<string, unknown>();
  let refreshSchedulingClosed = false;

  function cancelProviderCredentialRefresh(providerId: string) {
    const timer = providerRefreshTimers.get(providerId);
    if (timer === undefined) return;
    refreshScheduler.clearTimer(timer);
    providerRefreshTimers.delete(providerId);
  }

  async function scheduleProviderCredentialRefresh(providerId: string) {
    cancelProviderCredentialRefresh(providerId);
    providerRefreshAttempts.delete(providerId);
    if (refreshSchedulingClosed) return;
    const credential = await readStoredCredential(providerId);
    if (credential?.type !== "oauth" || refreshSchedulingClosed) return;
    cancelProviderCredentialRefresh(providerId);
    const expires = Number.isFinite(credential.expires)
      ? (credential.expires as number)
      : undefined;
    if (expires === undefined)
      log("warn", "refresh_without_expiry", {
        provider: providerId,
        intervalMs: PROVIDER_REFRESH_WITHOUT_EXPIRY_MS,
      });
    const dueAt =
      expires === undefined
        ? refreshScheduler.now() + PROVIDER_REFRESH_WITHOUT_EXPIRY_MS
        : expires - PROVIDER_REFRESH_LEAD_MS;
    const delayMs = Math.min(
      Math.max(0, dueAt - refreshScheduler.now()),
      MAX_PROVIDER_REFRESH_TIMER_MS,
    );
    providerRefreshTimers.set(
      providerId,
      refreshScheduler.setTimer(
        () => runScheduledProviderRefresh(providerId, dueAt, expires),
        delayMs,
      ),
    );
    log("info", "refresh_scheduled", {
      provider: providerId,
      at: new Date(dueAt).toISOString(),
      delayMs,
    });
  }

  async function runScheduledProviderRefresh(
    providerId: string,
    dueAt: number,
    expires: number | undefined,
  ) {
    providerRefreshTimers.delete(providerId);
    // A delay longer than the timer limit fires early: wait again.
    if (refreshScheduler.now() < dueAt)
      return scheduleProviderCredentialRefresh(providerId);
    try {
      // Refresh anything that expires no later than the expiry this was
      // scheduled from; Pi rechecks that under the credential lock.
      await refreshProviderCredential(
        providerId,
        "scheduled",
        expires === undefined
          ? undefined
          : Math.max(0, expires - Date.now()) + 1,
      );
    } catch (error) {
      // refreshProviderCredential logged the failure. A transient failure
      // or a fence that may come back keeps the stored credential and
      // retries, also after the access token expired; a rejected refresh
      // token waits for `adm login`.
      if (error instanceof ProviderRefreshError && error.kind === "permanent")
        return;
      if (refreshSchedulingClosed) return;
      const attempt = (providerRefreshAttempts.get(providerId) ?? 0) + 1;
      providerRefreshAttempts.set(providerId, attempt);
      const delayMs =
        PROVIDER_REFRESH_RETRY_DELAYS_MS[attempt - 1] ??
        PROVIDER_REFRESH_RETRY_MAX_DELAY_MS;
      const retryAt = refreshScheduler.now() + delayMs;
      cancelProviderCredentialRefresh(providerId);
      providerRefreshTimers.set(
        providerId,
        refreshScheduler.setTimer(
          () => runScheduledProviderRefresh(providerId, retryAt, expires),
          delayMs,
        ),
      );
      log("warn", "refresh_retry_scheduled", {
        provider: providerId,
        attempt,
        at: new Date(retryAt).toISOString(),
        delayMs,
      });
    }
  }

  async function scheduleStoredProviderCredentialRefreshes() {
    for (const { providerId, type } of await credentialStore.credentials.list())
      if (type === "oauth") await scheduleProviderCredentialRefresh(providerId);
  }

  async function resolveSharedProviderAuth(providerId: string) {
    const stored = await readStoredCredential(providerId);
    if (
      stored?.type === "oauth" &&
      Date.now() + PI_OAUTH_REFRESH_WINDOW_MS >= stored.expires
    )
      await refreshProviderCredential(providerId, "request");
    return runtime.getAuth(providerId);
  }

  function publish(operation: LoginOperation, value: unknown) {
    const waiter = operation.waiters.shift();
    if (waiter) waiter(value);
    else operation.events.push(value);
  }

  function next(
    operation: LoginOperation,
    response: ServerResponse,
  ): Promise<unknown | undefined> {
    const queued = operation.events.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const finish = (value: unknown | undefined) => {
        response.off("close", closed);
        resolve(value);
      };
      const closed = () => {
        const index = operation.waiters.indexOf(finish);
        if (index >= 0) operation.waiters.splice(index, 1);
        finish(undefined);
      };
      operation.waiters.push(finish);
      response.once("close", closed);
    });
  }

  function credentialNeedsRefresh(
    credential:
      | {
          type?: string;
          expires?: number;
        }
      | undefined,
  ) {
    return (
      credential?.type === "oauth" &&
      typeof credential.expires === "number" &&
      Date.now() + PI_OAUTH_REFRESH_WINDOW_MS >= credential.expires
    );
  }

  async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(message)),
            catalogProviderTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function catalogProvider(
    id: string,
    refreshFirst: boolean,
  ): Promise<[string, SharedProviderCatalog[string]]> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      catalogProviderTimeoutMs,
    );
    try {
      if (refreshFirst) {
        const pending = refreshProviderCredential(
          id,
          "request",
          undefined,
          controller.signal,
        );
        try {
          await bounded(pending, `${id}: token refresh timed out`);
        } catch (error) {
          // Stop waiting. A refresh that ignores abort still holds Pi's
          // credential lock; it must not keep shutdown waiting too.
          if (providerRefreshesInFlight.get(id) === pending)
            providerRefreshesInFlight.delete(id);
          throw error;
        }
      }
      const [models, allModels, auth] = await bounded(
        Promise.all([
          runtime.getAvailable(id),
          runtime.getAllAvailable(id),
          runtime.checkAuth(id),
        ]),
        `${id}: catalog timed out`,
      );
      return [
        id,
        {
          ...(auth ? { auth } : {}),
          models: models.map((model: { id: string }) => model.id),
          allModels: allModels.map((model: { id: string }) => model.id),
        },
      ];
    } catch (error) {
      const cause = providerAuthCauseChain(error);
      const message =
        error instanceof ProviderRefreshError
          ? error.message
          : `${id}: catalog failed (${cause.at(-1) ?? "unknown error"})`;
      log("error", "catalog_failed", {
        provider: id,
        operation: "catalog",
        message,
        cause,
      });
      return [id, { error: message, models: [], allModels: [] }];
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sharedProviderCatalog(): Promise<SharedProviderCatalog> {
    const providers = runtime.getProviders();
    const stored = new Map<string, { type?: string; expires?: number }>();
    const catalog: SharedProviderCatalog = {};
    for (const provider of providers) {
      try {
        stored.set(provider.id, await readStoredCredential(provider.id));
      } catch (error) {
        const cause = providerAuthCauseChain(error);
        const message = `${provider.id}: catalog failed (${providerAuthRootCause(error)})`;
        log("error", "catalog_failed", {
          provider: provider.id,
          operation: "catalog",
          message,
          cause,
        });
        catalog[provider.id] = { error: message, models: [], allModels: [] };
      }
    }
    const refreshing: string[] = [];
    const ready: string[] = [];
    for (const provider of providers) {
      if (catalog[provider.id]) continue;
      (credentialNeedsRefresh(stored.get(provider.id))
        ? refreshing
        : ready
      ).push(provider.id);
    }
    // Ready providers finish before any refresh takes the credential lock.
    for (const [id, entry] of await Promise.all(
      ready.map((id) => catalogProvider(id, false)),
    ))
      catalog[id] = entry;
    for (const [id, entry] of await Promise.all(
      refreshing.map((id) => catalogProvider(id, true)),
    ))
      catalog[id] = entry;
    return catalog;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (ownerGuard && !(await ownerGuard())) {
        log("warn", "fence_rejected", {
          method: request.method,
          path: url.pathname,
        });
        return send(response, 503, { status: "unavailable" });
      }
      if (request.method === "GET" && url.pathname === "/health")
        return send(response, 200, { status: "ok" });
      if (await agentsFile.handle(request, response, url)) return;
      if (await connectors.handle(request, response, url)) return;
      if (
        request.method === "POST" &&
        url.pathname === "/v1/provider-auth/catalog"
      ) {
        // Providers that do not need a refresh finish before any refresh
        // takes the credential lock, and each call is bounded, so one hung
        // token refresh cannot drop the others (TASK-97).
        return send(response, 200, await sharedProviderCatalog());
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/provider-auth/providers"
      ) {
        const credentials = new Map(
          (await runtime.listCredentials()).map(({ providerId, type }: any) => [
            providerId,
            type,
          ]),
        );
        return send(
          response,
          200,
          runtime.getProviders().map((provider: any) => {
            const expired = providerLoginsExpired.get(provider.id);
            const authenticated = credentials.get(provider.id) ?? null;
            return {
              provider: provider.id,
              name: provider.name,
              authTypes: [
                ...(provider.auth.apiKey?.login ? ["api_key"] : []),
                ...(provider.auth.oauth ? ["oauth"] : []),
              ],
              authenticated,
              // login_expired: the token endpoint rejected the stored
              // refresh token; `cause` says why (TASK-109).
              status: expired
                ? "login_expired"
                : authenticated
                  ? "authenticated"
                  : "unauthenticated",
              ...(expired ? { cause: expired.cause } : {}),
            };
          }),
        );
      }
      const resolveMatch = /^\/v1\/provider-auth\/resolve\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && resolveMatch) {
        const provider = decodeURIComponent(resolveMatch[1]!);
        const resolved = await resolveSharedProviderAuth(provider);
        return resolved
          ? send(response, 200, resolved)
          : send(response, 401, {
              error: {
                code: "PROVIDER_AUTH_REQUIRED",
                message: `Provider ${provider} is not authenticated`,
              },
            });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/provider-auth/resolve"
      ) {
        const value = await body(request);
        if (typeof value.provider !== "string" || !value.provider)
          return send(response, 400, {
            error: { code: "INVALID_REQUEST", message: "provider is required" },
          });
        const resolved = await resolveSharedProviderAuth(value.provider);
        return resolved
          ? send(response, 200, resolved)
          : send(response, 401, {
              error: {
                code: "PROVIDER_AUTH_REQUIRED",
                message: `Provider ${value.provider} is not authenticated`,
              },
            });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/provider-auth/logout"
      ) {
        const value = await body(request);
        if (typeof value.provider !== "string" || !value.provider)
          return send(response, 400, {
            error: { code: "INVALID_REQUEST", message: "provider is required" },
          });
        await runtime.logout(value.provider);
        cancelProviderCredentialRefresh(value.provider);
        providerRefreshAttempts.delete(value.provider);
        providerLoginsExpired.delete(value.provider);
        log("info", "logout", { provider: value.provider });
        return send(response, 200, {});
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/provider-auth/login"
      ) {
        const value = await body(request);
        if (
          typeof value.provider !== "string" ||
          !value.provider ||
          !["api_key", "oauth"].includes(value.type)
        )
          return send(response, 400, {
            error: {
              code: "INVALID_REQUEST",
              message: "provider and a supported auth type are required",
            },
          });
        const id = randomUUID();
        const operation: LoginOperation = {
          controller: new AbortController(),
          events: [],
          waiters: [],
          prompts: new Map(),
        };
        operations.set(id, operation);
        const provider = value.provider as string;
        const loginStartedAt = Date.now();
        log("info", "login_started", { provider, type: value.type });
        void runtime
          .login(value.provider, value.type as AuthType, {
            signal: operation.controller.signal,
            prompt: async (prompt: AuthPrompt) => {
              const promptId = randomUUID();
              return new Promise<string>((resolve, reject) => {
                operation.prompts.set(promptId, resolve);
                const aborted = () => {
                  operation.prompts.delete(promptId);
                  reject(new Error("login cancelled"));
                };
                operation.controller.signal.addEventListener("abort", aborted, {
                  once: true,
                });
                publish(operation, {
                  type: "prompt",
                  promptId,
                  prompt: cleanPrompt(prompt),
                });
              });
            },
            notify: (event: AuthEvent) => publish(operation, event),
          })
          .then(
            async () => {
              await chmod(authPath, 0o600);
              log("info", "login_succeeded", {
                provider,
                type: value.type,
                durationMs: Date.now() - loginStartedAt,
              });
              providerLoginsExpired.delete(provider);
              await scheduleProviderCredentialRefresh(provider);
              publish(operation, { type: "complete" });
            },
            (error: unknown) => {
              log("error", "login_failed", {
                provider,
                type: value.type,
                durationMs: Date.now() - loginStartedAt,
                cause: providerAuthCauseChain(error),
              });
              publish(operation, {
                type: "error",
                message: `${provider}: login failed (${providerAuthRootCause(error)})`,
              });
            },
          );
        return send(response, 202, { operationId: id });
      }
      const operationMatch =
        /^\/v1\/provider-auth\/login\/([0-9a-f-]+)(?:\/(events|reply))?$/.exec(
          url.pathname,
        );
      if (operationMatch) {
        const operation = operations.get(operationMatch[1]!);
        if (!operation)
          return send(response, 404, {
            error: {
              code: "LOGIN_NOT_FOUND",
              message: "login operation not found",
            },
          });
        if (request.method === "DELETE" && !operationMatch[2]) {
          operation.controller.abort();
          operation.prompts.clear();
          for (const waiter of operation.waiters.splice(0)) waiter(undefined);
          operations.delete(operationMatch[1]!);
          return send(response, 200, {});
        }
        if (request.method === "POST" && operationMatch[2] === "reply") {
          const value = await body(request);
          if (
            typeof value.value !== "string" ||
            typeof value.promptId !== "string"
          )
            return send(response, 400, {
              error: {
                code: "INVALID_REQUEST",
                message: "promptId and value are required",
              },
            });
          const resolve = operation.prompts.get(value.promptId);
          if (!resolve)
            return send(response, 409, {
              error: {
                code: "PROMPT_NOT_PENDING",
                message: "prompt is no longer pending",
              },
            });
          operation.prompts.delete(value.promptId);
          resolve(value.value);
          return send(response, 200, {});
        }
        if (request.method === "GET" && operationMatch[2] === "events") {
          const event = await next(operation, response);
          if (event === undefined) return;
          const value = event as { type?: string };
          const terminal = value.type === "complete" || value.type === "error";
          if (terminal) operations.delete(operationMatch[1]!);
          return send(response, 200, { event: value, done: terminal });
        }
      }
      send(response, 404, {
        error: { code: "NOT_FOUND", message: "provider auth route not found" },
      });
    } catch (error) {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const cause = providerAuthCauseChain(error);
      log("error", "request_failed", {
        method: request.method,
        path,
        status: 400,
        cause,
      });
      if (!response.headersSent)
        send(response, 400, {
          error: {
            code: "PROVIDER_AUTH_ERROR",
            message:
              error instanceof ProviderAuthRequestError
                ? error.message
                : `provider-auth: ${request.method} ${path} failed (${cause.join(": ")})`,
          },
        });
      else response.end();
    }
  });
  await scheduleStoredProviderCredentialRefreshes();
  return {
    server,
    close: async () => {
      refreshSchedulingClosed = true;
      for (const providerId of [...providerRefreshTimers.keys()])
        cancelProviderCredentialRefresh(providerId);
      await Promise.allSettled(providerRefreshesInFlight.values());
      for (const operation of operations.values()) operation.controller.abort();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await agentsFile.close();
      await connectors.close();
      await credentialStore.close();
    },
  };
}
