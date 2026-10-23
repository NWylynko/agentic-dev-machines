// Installation MCP connectors inside one workspace runtime. The cluster
// authority owns registration and OAuth; this runtime reads its token-free
// catalog before each turn, keeps one Streamable HTTP session per signed-in
// connector, and offers every connector tool to the agent. Each call asks the
// authority for a current access token, so a removed or signed-out connector
// fails visibly even before its tools are withdrawn.
import { readFile } from "node:fs/promises";
import {
  McpClient,
  McpConnectionClosedError,
  McpSessionExpiredError,
  StreamableHttpTransport,
  toLlmContent,
  type Tool,
} from "@earendil-works/pi-mcp";
import {
  defineExtension,
  defineTool,
  type createRegistry,
} from "@earendil-works/pi-durable";
import { connectorToolPrefix } from "./connector-authority.ts";

export type ConnectorLifecycle = { url: string; tokenFile: string };

type CatalogEntry = {
  name: string;
  url: string;
  revision: number;
  signedIn: boolean;
  error?: string;
};

type ConnectorConnection = {
  name: string;
  url: string;
  revision: number;
  status: "connected" | "sign_in_required" | "error";
  error?: string;
  client?: McpClient;
  tools: Tool[];
  accessToken?: string;
};

export type ConnectorStatus = {
  name: string;
  status: ConnectorConnection["status"];
  tools: number;
  error?: string;
};

class ConnectorSignInRequired extends Error {}

export function connectorLifecycleFromEnvironment(options: {
  lifecycleUrl?: string;
  tokenFile?: string;
}): ConnectorLifecycle | undefined {
  return options.lifecycleUrl && options.tokenFile
    ? { url: options.lifecycleUrl, tokenFile: options.tokenFile }
    : undefined;
}

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
}

export class WorkspaceConnectors {
  private connections = new Map<string, ConnectorConnection>();
  private reconciling?: Promise<void>;
  private catalogError?: string;
  private closed = false;
  private lifecycle: ConnectorLifecycle;
  private registry: ReturnType<typeof createRegistry>;
  private assertActive: (signal?: AbortSignal) => Promise<void>;

  constructor(
    lifecycle: ConnectorLifecycle,
    registry: ReturnType<typeof createRegistry>,
    assertActive: (signal?: AbortSignal) => Promise<void>,
  ) {
    this.lifecycle = lifecycle;
    this.registry = registry;
    this.assertActive = assertActive;
    this.install();
  }

  status(): ConnectorStatus[] {
    return [...this.connections.values()].map((connection) => ({
      name: connection.name,
      status: connection.status,
      tools: connection.status === "connected" ? connection.tools.length : 0,
      ...(connection.error ? { error: connection.error } : {}),
    }));
  }

  /** Bring this runtime's connector tools up to date with the installation. */
  reconcile(): Promise<void> {
    this.reconciling ??= this.reconcileOnce().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  async close() {
    this.closed = true;
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(
      connections.map((connection) => connection.client?.close()),
    );
  }

  private async request(path: string, body: unknown, signal?: AbortSignal) {
    const token = (await readFile(this.lifecycle.tokenFile, "utf8")).trim();
    if (!token) throw new Error("Projected lifecycle identity token is empty");
    const response = await fetch(
      `${this.lifecycle.url.replace(/\/$/, "")}/v1/runtime/connectors/${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      },
    );
    const value = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (response.status === 401)
      throw new ConnectorSignInRequired(
        value.error?.message ?? "MCP connector needs sign-in",
      );
    if (!response.ok)
      throw new Error(
        value.error?.message ??
          `MCP connector request ${path} failed (${response.status})`,
      );
    return value as any;
  }

  /** Ask the authority for a current access token; it refreshes centrally. */
  private async refreshAccessToken(
    connection: ConnectorConnection,
    rejectedToken?: string,
    signal?: AbortSignal,
  ) {
    const value = await this.request(
      "token",
      { name: connection.name, ...(rejectedToken ? { rejectedToken } : {}) },
      signal,
    );
    connection.accessToken = value.accessToken;
  }

  private async connect(entry: CatalogEntry): Promise<ConnectorConnection> {
    const connection: ConnectorConnection = {
      name: entry.name,
      url: entry.url,
      revision: entry.revision,
      status: "sign_in_required",
      tools: [],
    };
    if (!entry.signedIn) {
      connection.error = `MCP connector ${entry.name} needs sign-in: run adm mcp login ${entry.name}${entry.error ? ` (${entry.error})` : ""}`;
      return connection;
    }
    try {
      await this.refreshAccessToken(connection);
      const client = new McpClient({ name: `adm-${entry.name}`, version: "1" });
      connection.client = client;
      client.onClose(() => {
        if (this.connections.get(entry.name) !== connection) return;
        connection.client = undefined;
        connection.status = "error";
        connection.error = `MCP connector ${entry.name} disconnected; it reconnects on the next turn`;
      });
      await client.connect(
        new StreamableHttpTransport({
          url: entry.url,
          openGetStream: false,
          authProvider: {
            token: async () => connection.accessToken,
            onUnauthorized: ({ token }) =>
              this.refreshAccessToken(connection, token),
          },
        }),
      );
      connection.tools = await client.listTools();
      connection.status = "connected";
    } catch (error) {
      await connection.client?.close().catch(() => {});
      connection.client = undefined;
      connection.status =
        error instanceof ConnectorSignInRequired ? "sign_in_required" : "error";
      connection.error =
        error instanceof ConnectorSignInRequired
          ? message(error)
          : `MCP connector ${entry.name} is unavailable: ${message(error)}`;
    }
    return connection;
  }

  private async reconcileOnce() {
    if (this.closed) return;
    let catalog: CatalogEntry[];
    try {
      catalog = await this.request("catalog", {});
      if (
        !Array.isArray(catalog) ||
        !catalog.every(
          (entry) =>
            typeof entry?.name === "string" &&
            typeof entry.url === "string" &&
            Number.isSafeInteger(entry.revision) &&
            typeof entry.signedIn === "boolean",
        )
      )
        throw new Error("the lifecycle returned an invalid catalog");
      this.catalogError = undefined;
    } catch (error) {
      // Keep the current sessions; each call still verifies its connector.
      this.catalogError = `MCP connector catalog is unavailable: ${message(error)}`;
      this.install();
      return;
    }
    const wanted = new Map(catalog.map((entry) => [entry.name, entry]));
    const stale = [...this.connections.values()].filter((connection) => {
      const entry = wanted.get(connection.name);
      return (
        !entry ||
        !entry.signedIn ||
        !connection.client ||
        entry.url !== connection.url ||
        entry.revision !== connection.revision
      );
    });
    for (const connection of stale) this.connections.delete(connection.name);
    await Promise.allSettled(
      stale.map((connection) => connection.client?.close()),
    );
    const added = await Promise.all(
      catalog
        .filter((entry) => !this.connections.has(entry.name))
        .map((entry) => this.connect(entry)),
    );
    if (this.closed) {
      await Promise.allSettled(
        added.map((connection) => connection.client?.close()),
      );
      return;
    }
    for (const connection of added)
      this.connections.set(connection.name, connection);
    this.install();
  }

  private install() {
    const tools = [];
    const names = new Set<string>();
    for (const connection of this.connections.values()) {
      if (connection.status !== "connected") continue;
      for (const tool of connection.tools) {
        const name = `${connectorToolPrefix(connection.name)}${tool.name.replace(/[^A-Za-z0-9_]/g, "_")}`;
        if (name.length > 64 || names.has(name)) {
          connection.error = `MCP connector ${connection.name} tool ${tool.name} has no unique tool name`;
          continue;
        }
        names.add(name);
        tools.push(this.defineConnectorTool(connection, tool, name));
      }
    }
    this.registry.install(
      defineExtension({
        name: "mcp-connectors",
        tools,
        sections: [
          {
            key: "mcp-connectors",
            render: () => this.describe(),
          },
        ],
      }),
    );
  }

  private defineConnectorTool(
    connection: ConnectorConnection,
    tool: Tool,
    name: string,
  ) {
    return defineTool({
      name,
      description: `${connection.name} MCP connector: ${tool.description ?? tool.title ?? tool.name}`,
      parameters: {
        ...tool.inputSchema,
        type: "object",
        properties: tool.inputSchema.properties ?? {},
      } as never,
      callers: ["model", "tools"],
      replay: tool.annotations?.readOnlyHint ? "safe" : "unsafe",
      execute: async (args, _api, context) => {
        await this.assertActive(context.abortSignal);
        const client = connection.client;
        if (this.connections.get(connection.name) !== connection || !client)
          throw new Error(
            connection.error ??
              `MCP connector ${connection.name} changed; its tools refresh on the next turn`,
          );
        // Revalidates the connector: removal or sign-out fails this call.
        await this.refreshAccessToken(
          connection,
          undefined,
          context.abortSignal,
        );
        try {
          const result = await client.callTool(
            tool.name,
            args as Record<string, unknown>,
            { signal: context.abortSignal },
          );
          return {
            output: toLlmContent(result),
            isError: result.isError === true,
          };
        } catch (error) {
          if (
            error instanceof McpSessionExpiredError ||
            error instanceof McpConnectionClosedError
          ) {
            connection.status = "error";
            connection.error = `MCP connector ${connection.name} lost its session; it reconnects on the next turn`;
            connection.client = undefined;
            void client.close().catch(() => {});
          }
          throw error;
        }
      },
    });
  }

  private describe() {
    const lines = [...this.connections.values()].map((connection) =>
      connection.status === "connected"
        ? `- ${connection.name}: connected; its tools are named ${connectorToolPrefix(connection.name)}*`
        : `- ${connection.name}: unavailable. ${connection.error ?? ""}`.trim(),
    );
    if (this.catalogError) lines.push(`- ${this.catalogError}`);
    if (!lines.length) return undefined;
    return [
      "MCP connectors are shared by every agent in this ADM installation. The user adds one with `adm mcp add NAME URL` and signs in with `adm mcp login NAME`; you cannot add or sign in to connectors yourself, so ask the user when one is missing or needs sign-in.",
      ...lines,
    ].join("\n");
  }
}
