// Installation-wide MCP connectors, owned by the cluster authority beside the
// shared provider credentials. The authority registers each remote server,
// runs its OAuth sign-in, stores and refreshes its tokens, and hands workspace
// Pods only short-lived access tokens. Refresh tokens never leave this file.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  authorizeMcp,
  McpOAuthProvider,
  MemoryOAuthStateStore,
  type McpOAuthState,
  type McpOAuthStateStore,
} from "@earendil-works/pi-mcp/oauth";

type ConnectorRecord = {
  url: string;
  addedAt: number;
  /** Increments on every completed sign-in so running agents reconnect. */
  revision: number;
  redirectUrl?: string;
  signedInAt?: number;
  /** Why the connector stopped being signed in, when it was not a logout. */
  error?: string;
  oauth?: McpOAuthState;
};
type ConnectorState = { connectors: Record<string, ConnectorRecord> };
type PendingSignIn = {
  state: string;
  url: string;
  redirectUrl: string;
  provider: McpOAuthProvider;
  store: MemoryOAuthStateStore;
};

/** One shared refresh margin: Pods always receive a token valid for a minute. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;
const CONNECTOR_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const CLIENT_METADATA = { client_name: "ADM agentic dev machines" };

class ConnectorError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The MCP tool-name prefix for a connector: `mcp_<name>_`. */
export function connectorToolPrefix(name: string) {
  return `mcp_${name.replace(/[^A-Za-z0-9_]/g, "_")}_`;
}

function validConnectorUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new ConnectorError(400, "INVALID_CONNECTOR", "url must be a URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new ConnectorError(
      400,
      "INVALID_CONNECTOR",
      "MCP connectors must use an https:// Streamable HTTP URL",
    );
  if (url.username || url.password || url.hash)
    throw new ConnectorError(
      400,
      "INVALID_CONNECTOR",
      "MCP connector URLs must not contain credentials or a fragment",
    );
  return String(url);
}

function publicConnector(name: string, record: ConnectorRecord) {
  return {
    name,
    url: record.url,
    revision: record.revision,
    signedIn: Boolean(record.oauth?.tokens),
    addedAt: record.addedAt,
    ...(record.signedInAt ? { signedInAt: record.signedInAt } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

/** Persist only what refresh needs; never an abandoned PKCE verifier or state. */
function storedOAuth(oauth: McpOAuthState): McpOAuthState {
  const { codeVerifier: _verifier, oauthState: _state, ...kept } = oauth;
  return kept;
}

async function listConnectorTools(url: string, accessToken: string) {
  const client = new McpClient({ name: "adm-connector-check", version: "1" });
  try {
    await client.connect(
      new StreamableHttpTransport({
        url,
        openGetStream: false,
        authProvider: { token: async () => accessToken },
      }),
    );
    return (await client.listTools()).map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

export async function createConnectorAuthority({
  statePath,
  ownerGuard,
}: {
  statePath: string;
  ownerGuard?: () => Promise<boolean>;
}) {
  let state: ConnectorState = { connectors: {} };
  try {
    const info = await lstat(statePath);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("MCP connector store must be a regular file");
    await chmod(statePath, 0o600);
    state = JSON.parse(await readFile(statePath, "utf8")) as ConnectorState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pending = new Map<string, PendingSignIn>();
  const refreshes = new Map<string, Promise<string>>();
  let writes: Promise<unknown> = Promise.resolve();
  let closed = false;

  function persist(change: (draft: ConnectorState) => void) {
    const write = writes.then(async () => {
      if (closed) throw new Error("MCP connector store is closed");
      const draft = structuredClone(state);
      change(draft);
      if (ownerGuard && !(await ownerGuard()))
        throw new ConnectorError(
          503,
          "CONNECTOR_AUTHORITY_UNAVAILABLE",
          "Lifecycle provider-auth owner fence is not current",
        );
      const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(draft));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, statePath);
      const directory = await open(dirname(statePath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      state = draft;
    });
    writes = write.catch(() => {});
    return write;
  }

  function record(name: string) {
    const found = state.connectors[name];
    if (!found)
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        `MCP connector ${name} is not added to this ADM installation`,
      );
    return found;
  }

  /** Durable OAuth state for one connector; a removed connector is never recreated. */
  function connectorOAuthStore(name: string): McpOAuthStateStore {
    return {
      load: () => structuredClone(state.connectors[name]?.oauth),
      save: (oauth) =>
        persist((draft) => {
          const target = draft.connectors[name];
          if (target) target.oauth = storedOAuth(oauth);
        }),
    };
  }

  async function startSignIn(name: string, redirectUrl: unknown) {
    const connector = record(name);
    let redirect: URL;
    try {
      redirect = new URL(String(redirectUrl));
    } catch {
      throw new ConnectorError(
        400,
        "INVALID_REQUEST",
        "redirectUrl is required",
      );
    }
    if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1")
      throw new ConnectorError(
        400,
        "INVALID_REQUEST",
        "Sign-in redirects must reach the CLI's loopback callback",
      );
    // Sign-in runs on its own copy of the connector state, so agents keep
    // their current grant until the new one completes.
    const client = connector.oauth?.clientInformation as
      | { redirect_uris?: string[] }
      | undefined;
    const store = new MemoryOAuthStateStore();
    store.save({
      serverUrl: new URL(connector.url).href,
      ...(connector.oauth?.discovery
        ? { discovery: connector.oauth.discovery }
        : {}),
      ...(client?.redirect_uris?.includes(String(redirect))
        ? { clientInformation: connector.oauth!.clientInformation }
        : {}),
    });
    let authorizationUrl: URL | undefined;
    const provider = new McpOAuthProvider({
      serverUrl: connector.url,
      redirectUrl: String(redirect),
      clientMetadata: CLIENT_METADATA,
      store,
      onRedirect: (url) => {
        authorizationUrl = url;
      },
    });
    const result = await authorizeMcp(provider, {
      serverUrl: connector.url,
      skipRefresh: true,
    });
    if (result !== "REDIRECT" || !authorizationUrl)
      throw new Error(`MCP connector ${name} did not request authorization`);
    const signIn = {
      state: await provider.state(),
      url: connector.url,
      redirectUrl: String(redirect),
      provider,
      store,
    };
    pending.set(name, signIn);
    return { state: signIn.state, authorizationUrl: String(authorizationUrl) };
  }

  async function completeSignIn(name: string, value: any) {
    const signIn = pending.get(name);
    if (
      !signIn ||
      typeof value.state !== "string" ||
      value.state !== signIn.state
    )
      throw new ConnectorError(
        409,
        "SIGN_IN_NOT_PENDING",
        `No matching sign-in is pending for MCP connector ${name}; run adm mcp login ${name} again`,
      );
    if (typeof value.code !== "string" || !value.code)
      throw new ConnectorError(400, "INVALID_REQUEST", "code is required");
    pending.delete(name);
    await authorizeMcp(signIn.provider, {
      serverUrl: signIn.url,
      authorizationCode: value.code,
      ...(typeof value.iss === "string" ? { iss: value.iss } : {}),
    });
    const oauth = signIn.store.load()!;
    // Prove the grant reaches the server before agents rely on it.
    const tools = await listConnectorTools(
      signIn.url,
      oauth.tokens!.access_token,
    );
    await persist((draft) => {
      const target = draft.connectors[name];
      if (!target || target.url !== signIn.url)
        throw new ConnectorError(
          409,
          "CONNECTOR_CHANGED",
          `MCP connector ${name} changed during sign-in`,
        );
      target.oauth = storedOAuth(oauth);
      target.redirectUrl = signIn.redirectUrl;
      target.revision += 1;
      target.signedInAt = Date.now();
      delete target.error;
    });
    return { ...publicConnector(name, state.connectors[name]!), tools };
  }

  async function refresh(name: string) {
    const connector = record(name);
    const provider = new McpOAuthProvider({
      serverUrl: connector.url,
      redirectUrl: connector.redirectUrl ?? "http://127.0.0.1/callback",
      clientMetadata: CLIENT_METADATA,
      store: connectorOAuthStore(name),
      onRedirect: () => {},
    });
    let failure: string | undefined;
    try {
      if (
        (await authorizeMcp(provider, { serverUrl: connector.url })) ===
        "AUTHORIZED"
      )
        return record(name).oauth!.tokens!.access_token;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (state.connectors[name]?.oauth?.tokens?.refresh_token === undefined) {
      await persist((draft) => {
        const target = draft.connectors[name];
        if (!target) return;
        if (target.oauth) delete target.oauth.tokens;
        target.error = "the server rejected the saved sign-in";
      });
      throw signInRequired(name);
    }
    // The grant is intact (for example a network failure); a later call retries.
    throw new ConnectorError(
      502,
      "CONNECTOR_REFRESH_FAILED",
      `MCP connector ${name} could not refresh its access token${failure ? `: ${failure}` : ""}`,
    );
  }

  function signInRequired(name: string) {
    return new ConnectorError(
      401,
      "CONNECTOR_SIGN_IN_REQUIRED",
      `MCP connector ${name} needs sign-in: run adm mcp login ${name}`,
    );
  }

  async function accessToken(name: string, rejectedToken: unknown) {
    const tokens = record(name).oauth?.tokens;
    if (!tokens) throw signInRequired(name);
    const expiresAt = record(name).oauth?.tokensExpireAt;
    const stale =
      rejectedToken === tokens.access_token ||
      (expiresAt !== undefined &&
        expiresAt - ACCESS_TOKEN_MARGIN_MS <= Date.now());
    if (!stale) return tokens.access_token;
    if (!tokens.refresh_token) {
      await persist((draft) => {
        const target = draft.connectors[name];
        if (target?.oauth) delete target.oauth.tokens;
        if (target)
          target.error = "the access token expired without a refresh token";
      });
      throw signInRequired(name);
    }
    // Concurrent Pods share one refresh: a rotating refresh token is single use.
    let running = refreshes.get(name);
    if (!running) {
      running = refresh(name).finally(() => refreshes.delete(name));
      refreshes.set(name, running);
    }
    return running;
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    if (
      path !== "/v1/connectors" &&
      !path.startsWith("/v1/connectors/") &&
      !path.startsWith("/v1/runtime/connectors/")
    )
      return false;
    try {
      if (
        request.method === "POST" &&
        path === "/v1/runtime/connectors/catalog"
      )
        return send(
          response,
          200,
          Object.entries(state.connectors).map(([name, value]) =>
            publicConnector(name, value),
          ),
        );
      if (
        request.method === "POST" &&
        path === "/v1/runtime/connectors/token"
      ) {
        const value = await body(request);
        if (typeof value.name !== "string")
          throw new ConnectorError(400, "INVALID_REQUEST", "name is required");
        return send(response, 200, {
          accessToken: await accessToken(value.name, value.rejectedToken),
        });
      }
      if (request.method === "GET" && path === "/v1/connectors")
        return send(
          response,
          200,
          Object.entries(state.connectors).map(([name, value]) =>
            publicConnector(name, value),
          ),
        );
      if (request.method === "POST" && path === "/v1/connectors") {
        const value = await body(request);
        if (typeof value.name !== "string" || !CONNECTOR_NAME.test(value.name))
          throw new ConnectorError(
            400,
            "INVALID_CONNECTOR",
            "Connector names use 1-32 lowercase letters, digits or hyphens and start with a letter",
          );
        const connectorUrl = validConnectorUrl(value.url);
        const existing = state.connectors[value.name];
        if (existing) {
          if (existing.url !== connectorUrl)
            throw new ConnectorError(
              409,
              "CONNECTOR_EXISTS",
              `MCP connector ${value.name} already uses ${existing.url}; remove it first`,
            );
          return send(response, 200, publicConnector(value.name, existing));
        }
        const prefix = connectorToolPrefix(value.name);
        const clash = Object.keys(state.connectors).find(
          (name) => connectorToolPrefix(name) === prefix,
        );
        if (clash)
          throw new ConnectorError(
            409,
            "CONNECTOR_EXISTS",
            `MCP connector ${value.name} would share tool names with ${clash}`,
          );
        await persist((draft) => {
          draft.connectors[value.name] = {
            url: connectorUrl,
            addedAt: Date.now(),
            revision: 0,
          };
        });
        return send(
          response,
          201,
          publicConnector(value.name, state.connectors[value.name]!),
        );
      }
      const match =
        /^\/v1\/connectors\/([a-z][a-z0-9-]*)(?:\/(logout|sign-in|sign-in\/complete))?$/.exec(
          path,
        );
      if (!match)
        throw new ConnectorError(404, "NOT_FOUND", "connector route not found");
      const name = match[1]!;
      const action = match[2];
      if (request.method === "DELETE" && !action) {
        record(name);
        pending.delete(name);
        await persist((draft) => {
          delete draft.connectors[name];
        });
        return send(response, 200, { name, removed: true });
      }
      if (request.method === "POST" && action === "logout") {
        record(name);
        await persist((draft) => {
          const target = draft.connectors[name]!;
          if (target.oauth) delete target.oauth.tokens;
          delete target.error;
        });
        return send(
          response,
          200,
          publicConnector(name, state.connectors[name]!),
        );
      }
      if (request.method === "POST" && action === "sign-in")
        return send(
          response,
          200,
          await startSignIn(name, (await body(request)).redirectUrl),
        );
      if (request.method === "DELETE" && action === "sign-in") {
        pending.delete(name);
        return send(response, 200, {});
      }
      if (request.method === "POST" && action === "sign-in/complete")
        return send(
          response,
          200,
          await completeSignIn(name, await body(request)),
        );
      throw new ConnectorError(404, "NOT_FOUND", "connector route not found");
    } catch (error) {
      if (error instanceof ConnectorError)
        send(response, error.status, {
          error: { code: error.code, message: error.message },
        });
      else
        send(response, 400, {
          error: {
            code: "CONNECTOR_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      return true;
    }
  }

  return {
    handle,
    async close() {
      closed = true;
      pending.clear();
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
    if (size > 64 * 1024)
      throw new ConnectorError(
        400,
        "INVALID_REQUEST",
        "request body too large",
      );
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ConnectorError(
      400,
      "INVALID_REQUEST",
      "request body must be JSON",
    );
  }
}
