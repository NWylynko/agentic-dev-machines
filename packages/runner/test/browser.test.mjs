// Built-in browser for coding workspaces: the real Playwright MCP server over
// stdio, driving a real chromium, through a real Pod runner with the faux
// provider. Needs chromium on the test host (ADM_BROWSER_CHROMIUM, `chromium`
// on PATH, or a Playwright browser cache); the test skips with a message
// without one. CI hosts without chromium skip; the adm-code image smoke
// (npm run test:image) covers the bundled server and system chromium.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPodLifecycle, startPodRunner } from "./pod-fixture.ts";

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

test(
  "coding workspaces drive a built-in browser through Playwright MCP tools, bots never get it, and a crashed server restarts on the next turn",
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
    const state = (await coding.request()).body.browser;
    assert.equal(state.status, "connected");
    assert.ok(state.tools > 10);
    assert.deepEqual((await coding.request("/runtime-status")).body.browser, {
      status: "connected",
    });

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
      /Browser tools stopped; they restart on the next turn/,
    );
    assert.equal((await coding.request()).body.browser.status, "error");
    assert.match(
      (await coding.request("/runtime-status")).body.browser.error,
      /restart on the next turn/,
    );

    // The next turn restarts the server and the browser works again.
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
