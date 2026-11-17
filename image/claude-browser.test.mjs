// Claude Code in a coding workspace gets the same built-in browser as Pi: the
// pinned Playwright MCP server, launched by `adm-browser-mcp`, written into
// Claude's MCP config by `adm-claude-mcp config`. Drives the real
// `adm-claude run`, `claude` and chromium against a fake Anthropic API that
// opens a local page.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, globSync } from "node:fs";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { createProviderAuthAuthority } from "../packages/runner/src/provider-auth-authority.ts";

const imageDir = new URL(".", import.meta.url).pathname;
const mcpCli = new URL("../node_modules/@playwright/mcp/cli.js", import.meta.url).pathname;
const claude = await promisify(execFile)("sh", ["-c", "command -v claude"])
  .then(({ stdout }) => stdout.trim())
  .catch(() => "");
const chromium =
  process.env.ADM_BROWSER_CHROMIUM ??
  spawnSync("which", ["chromium"], { encoding: "utf8" }).stdout.trim();
const executable = existsSync(chromium)
  ? chromium
  : globSync(join(homedir(), ".cache/ms-playwright/chromium-*/chrome-linux64/chrome")).at(-1);
const skip = !claude
  ? "claude is not on PATH"
  : !executable || !existsSync(mcpCli)
    ? "no chromium (set ADM_BROWSER_CHROMIUM) or no @playwright/mcp (npm ci) on this host"
    : false;

const navigate = "mcp__browser__browser_navigate";

test(
  "adm claude drives the workspace's built-in browser, like Pi",
  { timeout: 120000, skip },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-claude-browser-"));
    const authority = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
    });
    const site = createServer((request, response) =>
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>Hello ADM Browser</title><h1>hi</h1>"),
    );
    const results = [];
    const model = startFakeAnthropic((body) => {
      const last = body.messages.at(-1);
      const result = Array.isArray(last?.content)
        ? last.content.find((part) => part.type === "tool_result")
        : undefined;
      if (result) results.push(result);
      return !result && body.tools?.some((tool) => tool.name === navigate)
        ? [{ type: "tool_use", id: "toolu_browser", name: navigate, input: { url: `http://127.0.0.1:${site.address().port}/` } }]
        : [{ type: "text", text: "done" }];
    });
    t.after(async () => {
      for (const server of [authority.server, model.server, site]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await rm(directory, { recursive: true });
    });
    for (const server of [authority.server, model.server, site])
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const checkout = join(directory, "repo");
    const state = join(directory, "state");
    await mkdir(checkout);
    await mkdir(state);
    const workspace = join(directory, "workspace.json");
    await writeFile(workspace, JSON.stringify({ name: "browser", cwd: checkout, repositories: false }));
    const identity = join(directory, "identity-token");
    await writeFile(identity, "pod-identity\n");
    const env = {
      // adm-claude-mcp and adm-browser-mcp are in /usr/local/bin in the image.
      PATH: `${imageDir}:${process.env.PATH}`,
      HOME: directory,
      ADM_LIFECYCLE_URL: `http://127.0.0.1:${authority.server.address().port}`,
      ADM_LIFECYCLE_TOKEN_FILE: identity,
      ADM_CLAUDE_STATE: state,
      ADM_WORKSPACE_CONFIG: workspace,
      ADM_PLAYWRIGHT_MCP_CLI: mcpCli,
      ADM_BROWSER_CHROMIUM: executable,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.server.address().port}`,
      ANTHROPIC_API_KEY: "sk-ant-fixture",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // Offer MCP tools directly instead of behind ToolSearch.
      ENABLE_TOOL_SEARCH: "false",
    };
    const run = async (command, args) => {
      const child = spawn(command, args, { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const [code] = await once(child, "close");
      return { code, output };
    };

    const config = await run(join(imageDir, "adm-claude-mcp"), ["config", join(state, "mcp.json")]);
    assert.equal(config.code, 0, config.output);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(state, "mcp.json"), "utf8")).mcpServers), ["browser"]);

    // Claude often starts in the read-only /repos catalog (a workspace with
    // no --repo): the browser must not write where Claude runs.
    await chmod(checkout, 0o555);
    const turn = await run(join(imageDir, "adm-claude"), ["run", "-p", "open the dev server", "--allowedTools", navigate]);
    await chmod(checkout, 0o755);
    assert.equal(turn.code, 0, turn.output);
    assert.match(JSON.stringify(results), /Hello ADM Browser/, `${JSON.stringify(results)}\n${turn.output}`);
    const prompt = JSON.stringify(model.requests[0].system);
    assert.match(prompt, /built-in browser/, "Claude is told about the browser");
    assert.ok(existsSync(join(state, "browser")), "browser output goes beside Claude's config on the workspace volume");
  },
);
