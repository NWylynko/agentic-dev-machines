// Built-in browser for coding workspaces: the real Playwright MCP server over
// stdio, driving a real chromium, through a real Pod runner with the faux
// provider. Needs chromium on the test host (ADM_BROWSER_CHROMIUM, `chromium`
// on PATH, or a Playwright browser cache); the test skips with a message
// without one. CI hosts without chromium skip; the adm-code image smoke
// (npm run test:image) covers the bundled server and system chromium.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { startPodLifecycle, startPodRunner } from "./pod-fixture.ts";
import { browserServerArgs } from "../src/browser.ts";

// The tools the runner offers before the server has started:
// a snapshot of the pinned @playwright/mcp. UPDATE_BROWSER_TOOLS=1 rewrites it.
const snapshotFile = new URL("../src/browser-tools.json", import.meta.url);

const mcpCli = new URL(
  "../../../node_modules/@playwright/mcp/cli.js",
  import.meta.url,
).pathname;
const chromium =
  process.env.ADM_BROWSER_CHROMIUM ??
  spawnSync("which", ["chromium"], { encoding: "utf8" }).stdout.trim();
const executable = existsSync(chromium)
  ? chromium
  : globSync(
      join(homedir(), ".cache/ms-playwright/chromium-*/chrome-linux64/chrome"),
    ).at(-1);
const skip =
  !existsSync(mcpCli) || !executable
    ? "no chromium (set ADM_BROWSER_CHROMIUM) or no @playwright/mcp (npm ci) on this host"
    : false;

const plan = (calls, answer = "Browser step complete.") =>
  `/faux ${JSON.stringify({ calls, answer })}`;

const browserServerRunning = (directory) =>
  spawnSync("pgrep", ["-f", join(directory, "repos", ".adm", "browser")])
    .status === 0;

test(
  "the offered browser tools are exactly the pinned Playwright MCP server's tools",
  { timeout: 60000, skip },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-browser-tools-"));
    const client = new McpClient({ name: "adm-browser-test", version: "1" });
    t.after(async () => {
      await client.close().catch(() => {});
      await rm(directory, { recursive: true });
    });
    await client.connect(
      new StdioTransport({
        command: process.execPath,
        args: browserServerArgs({
          cli: mcpCli,
          chromium: executable,
          outputDir: directory,
        }),
        cwd: directory,
      }),
    );
    const tools = await client.listTools();
    if (process.env.UPDATE_BROWSER_TOOLS === "1")
      writeFileSync(snapshotFile, `${JSON.stringify(tools, null, 2)}\n`);
    assert.deepEqual(
      JSON.parse(readFileSync(snapshotFile, "utf8")),
      JSON.parse(JSON.stringify(tools)),
      "browser-tools.json is stale: rerun this test with UPDATE_BROWSER_TOOLS=1",
    );
  },
);

test(
  "coding workspaces drive a built-in browser through Playwright MCP tools, started only on the first browser call; bots never get it, and a crashed server restarts on the next call",
  { timeout: 120000, skip },
  async (t) => {
    const holder = {};
    t.after(async () => {
      await holder.coding?.stop();
      await holder.bot?.stop();
      await holder.lifecycle?.close();
      holder.site?.closeAllConnections();
      holder.site?.close();
      if (holder.directory) await rm(holder.directory, { recursive: true });
    });
    holder.directory = await mkdtemp(join(tmpdir(), "adm-browser-"));
    const hangs = [];
    holder.site = createServer((request, response) => {
      if (request.url === "/hang") return void hangs.push(response);
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>Hello ADM Browser</title><h1>hi</h1>");
    });
    holder.site.listen(0, "127.0.0.1");
    await once(holder.site, "listening");
    const site = `http://127.0.0.1:${holder.site.address().port}`;
    holder.lifecycle = await startPodLifecycle({ authorityUrl: site });
    const env = {
      ADM_BROWSER_CHROMIUM: executable,
      ADM_PLAYWRIGHT_MCP_CLI: mcpCli,
    };
    holder.coding = await startPodRunner(holder.directory, holder.lifecycle, {
      id: "coding-agent",
      name: "coding agent",
      role: "coding",
      env,
    });
    holder.bot = await startPodRunner(holder.directory, holder.lifecycle, {
      id: "bot-agent",
      name: "supervisor",
      role: "bot",
      env,
    });
    const { coding, bot } = holder;
    const browserTools = async (agent) =>
      (await agent.request()).body.tools.filter((name) =>
        name.startsWith("browser_"),
      );
    assert.ok((await browserTools(coding)).includes("browser_navigate"));
    assert.deepEqual(await browserTools(bot), []);
    assert.equal((await bot.request()).body.browser, undefined);
    // Nothing runs until a browser tool is called: an idle workspace pays
    // no memory for the server.
    const state = (await coding.request()).body.browser;
    assert.equal(state.status, "idle");
    assert.ok(state.tools > 10);
    assert.deepEqual((await coding.request("/runtime-status")).body.browser, {
      status: "idle",
    });
    await coding.request("/input", "POST", {
      message: "no browser in this turn",
      requestId: "plain-turn",
    });
    await coding.event((event) => event.kind === "assistant");
    assert.equal(browserServerRunning(coding.directory), false);

    // A scripted turn opens a page on this host and reads its title.
    await coding.request("/input", "POST", {
      message: plan([
        { tool: "browser_navigate", args: { url: `${site}/page` } },
      ]),
      requestId: "navigate",
    });
    const navigated = await coding.event(
      (event) =>
        event.kind === "tool" && event.data.name === "browser_navigate",
    );
    assert.equal(navigated.data.isError, false, navigated.data.text);
    assert.match(navigated.data.text, /Page Title: Hello ADM Browser/);
    assert.equal(browserServerRunning(coding.directory), true);
    assert.deepEqual((await coding.request("/runtime-status")).body.browser, {
      status: "connected",
    });

    // Kill the server while a call is in flight: the call fails readably.
    await coding.request("/input", "POST", {
      message: plan([
        { tool: "browser_navigate", args: { url: `${site}/hang` } },
      ]),
      requestId: "hang-then-crash",
    });
    while (!hangs.length) await new Promise((resolve) => setImmediate(resolve));
    execFileSync("pkill", [
      "-KILL",
      "-f",
      join(coding.directory, "repos", ".adm", "browser"),
    ]);
    const crashed = await coding.event(
      (event) =>
        event.kind === "tool" &&
        event.data.name === "browser_navigate" &&
        event.seq > navigated.seq,
      navigated.seq,
    );
    assert.equal(crashed.data.isError, true);
    assert.match(
      crashed.data.text,
      /Browser tools stopped; they restart on the next browser call/,
    );
    assert.equal((await coding.request()).body.browser.status, "error");
    assert.match(
      (await coding.request("/runtime-status")).body.browser.error,
      /restart on the next browser call/,
    );

    // The next browser call restarts the server and the browser works again.
    await coding.request("/input", "POST", {
      message: plan([
        { tool: "browser_navigate", args: { url: `${site}/again` } },
      ]),
      requestId: "navigate-again",
    });
    const again = await coding.event(
      (event) =>
        event.kind === "tool" &&
        event.data.name === "browser_navigate" &&
        event.seq > crashed.seq,
      crashed.seq,
    );
    assert.equal(again.data.isError, false, again.data.text);
    assert.match(again.data.text, /Page Title: Hello ADM Browser/);
    assert.equal((await coding.request()).body.browser.status, "connected");

    // The agent is told it has a browser.
    await coding.request("/input", "POST", {
      message: "/faux-inspect-system-prompt",
      requestId: "inspect-browser",
    });
    const inspected = await coding.event(
      (event) =>
        event.kind === "assistant" && event.data.text.includes("sections"),
      again.seq,
    );
    assert.match(inspected.data.text, /built-in browser/);
  },
);
