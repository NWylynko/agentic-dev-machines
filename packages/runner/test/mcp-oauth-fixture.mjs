// A remote MCP server with its own OAuth 2.1 authorization server, shaped like
// Linear's: protected-resource discovery, dynamic client registration, PKCE
// authorization codes, rotating refresh tokens and Streamable HTTP JSON-RPC.
// The authorization endpoint approves immediately, standing in for the user's
// browser consent, and redirects to the registered loopback callback.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export async function startMcpOAuthServer({ accessTokenSeconds = 3600 } = {}) {
  const clients = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const sessions = new Set();
  const events = [];
  const hanging = new Set();
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, base);
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const json = (status, value, headers = {}) =>
      response
        .writeHead(status, { "content-type": "application/json", ...headers })
        .end(JSON.stringify(value));
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/.well-known/oauth-protected-resource")
    )
      return json(200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ["read"],
      });
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    )
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (request.method === "POST" && url.pathname === "/register") {
      const metadata = JSON.parse(raw);
      const clientId = `client-${++sequence}`;
      clients.set(clientId, metadata);
      events.push({ type: "register", redirectUris: metadata.redirect_uris });
      return json(201, { ...metadata, client_id: clientId });
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      const client = clients.get(url.searchParams.get("client_id"));
      const redirect = url.searchParams.get("redirect_uri");
      if (!client || !client.redirect_uris.includes(redirect))
        return json(400, { error: "invalid_request" });
      const code = `code-${++sequence}`;
      codes.set(code, {
        clientId: url.searchParams.get("client_id"),
        redirect,
        challenge: url.searchParams.get("code_challenge"),
      });
      const location = new URL(redirect);
      location.searchParams.set("code", code);
      location.searchParams.set("state", url.searchParams.get("state"));
      events.push({ type: "authorize" });
      return response.writeHead(302, { location: String(location) }).end();
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(raw);
      let grant;
      if (form.get("grant_type") === "authorization_code") {
        const issued = codes.get(form.get("code"));
        codes.delete(form.get("code"));
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          !issued ||
          issued.challenge !== challenge ||
          issued.redirect !== form.get("redirect_uri") ||
          issued.clientId !== form.get("client_id")
        )
          return json(400, { error: "invalid_grant" });
        grant = issued.clientId;
      } else if (form.get("grant_type") === "refresh_token") {
        grant = refreshTokens.get(form.get("refresh_token"));
        refreshTokens.delete(form.get("refresh_token"));
        if (!grant) return json(400, { error: "invalid_grant" });
      } else return json(400, { error: "unsupported_grant_type" });
      const access = `access-${randomBytes(8).toString("hex")}`;
      const refresh = `refresh-${randomBytes(8).toString("hex")}`;
      accessTokens.set(access, grant);
      refreshTokens.set(refresh, grant);
      events.push({ type: "token", grant: form.get("grant_type") });
      return json(200, {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: accessTokenSeconds,
      });
    }
    if (url.pathname === "/mcp") {
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      if (!accessTokens.has(token)) {
        events.push({ type: "unauthorized" });
        return json(
          401,
          { error: "invalid_token" },
          {
            "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          },
        );
      }
      if (request.method === "DELETE") {
        sessions.delete(request.headers["mcp-session-id"]);
        events.push({ type: "session-closed" });
        return response.writeHead(204).end();
      }
      if (request.method !== "POST") return response.writeHead(405).end();
      const message = JSON.parse(raw);
      if (!("id" in message)) {
        events.push({ type: "notification", method: message.method });
        return response.writeHead(202).end();
      }
      const reply = (result, headers) =>
        json(200, { jsonrpc: "2.0", id: message.id, result }, headers);
      if (message.method === "initialize") {
        const session = `session-${++sequence}`;
        sessions.add(session);
        events.push({ type: "initialize" });
        return reply(
          {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
          { "mcp-session-id": session },
        );
      }
      if (message.method === "tools/list")
        return reply({
          tools: [
            {
              name: "lookup",
              description: "Look up a fixture issue",
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
            {
              name: "hang",
              description: "Wait until the caller gives up",
              inputSchema: { type: "object" },
            },
          ],
        });
      if (message.method === "tools/call" && message.params.name === "lookup") {
        events.push({ type: "call", tool: "lookup" });
        return reply({
          content: [
            {
              type: "text",
              text: `issue ${message.params.arguments.query}: fixture backlog item`,
            },
          ],
        });
      }
      if (message.method === "tools/call" && message.params.name === "hang") {
        events.push({ type: "call", tool: "hang" });
        hanging.add(response);
        response.once("close", () => {
          hanging.delete(response);
          events.push({ type: "hang-closed" });
        });
        return;
      }
      return json(200, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "unknown method" },
      });
    }
    json(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/mcp`,
    events,
    accessTokens,
    refreshTokens,
    /** Expire every issued access token, as an authorization server would. */
    expireAccessTokens() {
      accessTokens.clear();
    },
    /** Revoke the whole grant so refresh fails and the user must sign in again. */
    revokeGrant() {
      accessTokens.clear();
      refreshTokens.clear();
    },
    /** Follow an authorization URL as the user's browser does after consent. */
    async approve(authorizationUrl) {
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      if (response.status !== 302)
        throw new Error(
          `authorization failed: ${response.status} ${await response.text()}`,
        );
      return new URL(response.headers.get("location"));
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
