// The workspace browser (image/adm-browser-mcp, shared by Pi and Claude Code)
// looks like a person's desktop Chrome to the sites it opens, not a headless
// bot: the checks bot detectors such as bot.sannysoft.com run, read from a
// local page through the real Playwright MCP server and chromium. Not hidden
// (no GPU in a Pod): WebGL reports SwiftShader.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, globSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpClient, StdioTransport, toLlmContent } from "@earendil-works/pi-mcp";

const launcher = new URL("./adm-browser-mcp", import.meta.url).pathname;
const mcpCli = new URL("../node_modules/@playwright/mcp/cli.js", import.meta.url).pathname;
const chromium =
  process.env.ADM_BROWSER_CHROMIUM ??
  spawnSync("which", ["chromium"], { encoding: "utf8" }).stdout.trim();
const executable = existsSync(chromium)
  ? chromium
  : globSync(join(homedir(), ".cache/ms-playwright/chromium-*/chrome-linux64/chrome")).at(-1);
const skip =
  !executable || !existsSync(mcpCli)
    ? "no chromium (set ADM_BROWSER_CHROMIUM) or no @playwright/mcp (npm ci) on this host"
    : false;

test("the workspace browser passes as a person's desktop Chrome", { timeout: 60000, skip }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-browser-human-"));
  let headers;
  const site = createServer((request, response) => {
    if (request.url === "/") headers = request.headers;
    response.writeHead(200, { "content-type": "text/html" }).end("<title>human</title>");
  });
  const client = new McpClient({ name: "adm-browser-human", version: "1" });
  t.after(async () => {
    await client.close().catch(() => {});
    site.closeAllConnections();
    site.close();
    await rm(directory, { recursive: true });
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  await client.connect(
    new StdioTransport({
      command: launcher,
      args: [directory],
      env: { ...process.env, ADM_PLAYWRIGHT_MCP_CLI: mcpCli, ADM_BROWSER_CHROMIUM: executable },
    }),
  );
  await client.callTool("browser_navigate", { url: `http://127.0.0.1:${site.address().port}/` });
  const result = await client.callTool("browser_evaluate", {
    function: `() => JSON.stringify({
      userAgent: navigator.userAgent, webdriver: navigator.webdriver,
      deviceMemory: navigator.deviceMemory, plugins: navigator.plugins.length,
      languages: navigator.languages, chrome: typeof window.chrome,
      window: [outerWidth, outerHeight, innerWidth, innerHeight],
      screen: [screen.width, screen.height],
    })`,
  });
  const text = JSON.stringify(toLlmContent(result));
  const page = JSON.parse(JSON.parse(JSON.parse(text)[0].text.match(/### Result\n(".*")\n/)[1]));

  assert.doesNotMatch(headers["user-agent"], /Headless/, "the User-Agent header names no headless browser");
  assert.match(headers["user-agent"], /Chrome\/\d+\.0\.0\.0 /, "the User-Agent header is Chrome's reduced form");
  assert.doesNotMatch(page.userAgent, /Headless/, "navigator.userAgent names no headless browser");
  assert.equal(page.webdriver, false, "navigator.webdriver is false");
  assert.ok(page.deviceMemory > 0, `navigator.deviceMemory is set (${page.deviceMemory})`);
  assert.ok(page.plugins > 0, "the PDF viewer plugins are listed");
  assert.ok(page.languages.length > 0, "navigator.languages is set");
  assert.equal(page.chrome, "object", "window.chrome exists");
  const [outerWidth, outerHeight, innerWidth, innerHeight] = page.window;
  assert.ok(outerHeight > innerHeight, `the window has browser chrome around the page (${page.window})`);
  assert.ok(outerWidth >= innerWidth, `${page.window}`);
  assert.deepEqual(page.screen, [1920, 1080], "a desktop screen, larger than the default 1280x720 viewport");
});
