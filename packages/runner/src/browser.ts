// Built-in browser for coding workspaces: the Playwright MCP server, started
// over stdio next to the checkout with the image's system chromium. Its tools
// reach the agent through the same MCP path as connectors. The server starts
// when the workspace opens (chromium itself launches on the first tool call)
// and, if it exits, its tools fail with a readable error and it restarts at
// the next turn. A broken browser never fails the workspace.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { McpClient, StdioTransport, type Tool } from "@earendil-works/pi-mcp";
import {
  defineExtension,
  type createRegistry,
} from "@earendil-works/pi-durable";
import { defineMcpTool } from "./connectors.ts";

export type BrowserStatus = {
  status: "connected" | "error";
  tools: number;
  error?: string;
};

const STOPPED =
  "Browser tools stopped; they restart on the next turn. If this repeats, tell the user.";

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
}

export class WorkspaceBrowser {
  private client?: McpClient;
  private tools: Tool[] = [];
  private error?: string;
  private starting?: Promise<void>;
  private closed = false;
  private registry: ReturnType<typeof createRegistry>;
  private assertActive: (signal?: AbortSignal) => Promise<void>;
  private workspaceRoot: string;

  constructor(
    workspaceRoot: string,
    registry: ReturnType<typeof createRegistry>,
    assertActive: (signal?: AbortSignal) => Promise<void>,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.registry = registry;
    this.assertActive = assertActive;
  }

  status(): BrowserStatus {
    return {
      status: this.client ? "connected" : "error",
      tools: this.client ? this.tools.length : 0,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Start the server if it is not running; never throws. */
  ensureRunning(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async close() {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }

  private async start() {
    const outputDir = join(this.workspaceRoot, ".adm", "browser");
    const client = new McpClient({ name: "adm-browser", version: "1" });
    try {
      await mkdir(outputDir, { recursive: true });
      client.onClose(() => {
        if (this.client !== client) return;
        this.client = undefined;
        this.error = STOPPED;
      });
      await client.connect(
        new StdioTransport({
          command: process.execPath,
          args: [
            process.env.ADM_PLAYWRIGHT_MCP_CLI ??
              "/opt/adm/node_modules/@playwright/mcp/cli.js",
            "--headless",
            "--isolated",
            // The Pod drops the capabilities Chromium's sandbox needs (as image/browser.mjs).
            "--no-sandbox",
            "--executable-path",
            process.env.ADM_BROWSER_CHROMIUM ?? "/usr/bin/chromium",
            "--output-dir",
            outputDir,
          ],
          cwd: this.workspaceRoot,
          inheritEnv: false,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? this.workspaceRoot,
            LANG: process.env.LANG ?? "C.UTF-8",
          },
        }),
      );
      this.tools = await client.listTools();
      if (this.closed) return void (await client.close());
      this.client = client;
      this.error = undefined;
    } catch (error) {
      await client.close().catch(() => {});
      this.error = `Browser tools are unavailable: ${message(error)}`;
    }
    this.install();
  }

  private install() {
    this.registry.install(
      defineExtension({
        name: "browser",
        tools: this.tools.map((tool) =>
          defineMcpTool({
            tool,
            name: tool.name.replace(/[^A-Za-z0-9_]/g, "_"),
            description: `Built-in browser: ${tool.description ?? tool.title ?? tool.name}`,
            assertActive: this.assertActive,
            prepare: async () => {
              if (!this.client) throw new Error(this.error ?? STOPPED);
              return this.client;
            },
            onLost: (client) => {
              if (this.client === client) this.client = undefined;
              this.error = STOPPED;
              void client.close().catch(() => {});
              return new Error(STOPPED);
            },
          }),
        ),
        sections: [
          {
            key: "browser",
            render: () =>
              this.client
                ? "You have a built-in browser in this workspace: headless Chromium driven by the browser_* tools (browser_navigate, browser_snapshot, browser_click, browser_take_screenshot, ...). It sees the workspace's own network, so use it to open dev servers on localhost. Pages and cookies are discarded when the workspace restarts."
                : `The built-in browser is unavailable. ${this.error ?? ""}`.trim(),
          },
        ],
      }),
    );
  }
}
