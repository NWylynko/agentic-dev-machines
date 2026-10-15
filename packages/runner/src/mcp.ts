import {
  McpClient,
  StdioTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { WorkspaceConfig } from "./types.ts";

export async function openMcpExtension(
  config: WorkspaceConfig,
  assertActive: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  const clients: McpClient[] = [];
  const tools = [];
  const names = new Set<string>();
  let closing = false;
  try {
    for (const server of config.mcpServers ?? []) {
      const env: Record<string, string> = {};
      for (const [key, reference] of Object.entries(server.secretEnv ?? {})) {
        const value = process.env[reference];
        if (value === undefined)
          throw new Error(
            `MCP server ${server.id} requires injected environment reference ${reference}`,
          );
        env[key] = value;
      }
      const client = new McpClient({ name: `adm-${server.id}`, version: "1" });
      const transport = new StdioTransport({
        command: server.command,
        args: server.args,
        env,
        inheritEnv: false,
        stderr: "pipe",
      });
      client.onError(onError);
      client.onClose(() => {
        if (!closing)
          onError(new Error(`MCP server ${server.id} disconnected`));
      });
      clients.push(client);
      await client.connect(transport);
      const discovered = await client.listTools();
      for (const toolName of server.tools) {
        const tool = discovered.find(
          (candidate) => candidate.name === toolName,
        );
        if (!tool)
          throw new Error(
            `MCP server ${server.id} did not offer granted tool ${toolName}`,
          );
        const name = `mcp_${server.id}_${toolName.replace(/[^A-Za-z0-9_]/g, "_")}`;
        if (names.has(name))
          throw new Error(`MCP tool name collision: ${name}`);
        names.add(name);
        tools.push(
          defineTool({
            name,
            description: `${server.id}: ${tool.description ?? tool.name}`,
            parameters: tool.inputSchema as never,
            callers: ["model", "tools"],
            replay: tool.annotations?.readOnlyHint ? "safe" : "unsafe",
            execute: async (args) => {
              await assertActive();
              if (
                !config.mcpServers?.some(
                  (grant) =>
                    grant.id === server.id && grant.tools.includes(toolName),
                )
              )
                throw new Error(
                  `MCP tool grant ${server.id}:${toolName} was revoked`,
                );
              const result = await client.callTool(toolName, args);
              return {
                output: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(toLlmContent(result)),
                  },
                ],
                isError: result.isError,
              };
            },
          }),
        );
      }
    }
    return {
      extension: defineExtension({ name: "bot-mcp", tools }),
      async close() {
        closing = true;
        await Promise.allSettled(clients.map((client) => client.close()));
      },
    };
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
}
