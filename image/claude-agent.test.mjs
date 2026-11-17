// A bot's Claude Code agent (TASK-141): in a workspace with harness "claude",
// `adm-claude start --task` (run by the lifecycle once the workspace is
// ready) starts Claude in tmux with nobody attached: no onboarding, trust or
// permission screen, the task as its first prompt, the workspace's model, and
// messageManager as an MCP tool that reaches the lifecycle with the Pod's
// token. After a Pod restart `adm-claude boot` resumes that conversation and
// never sends the task again. Drives the real `adm-claude`, `claude` and tmux
// against a fake Anthropic API and a fake lifecycle, logged in like a Pod
// (an OAuth access token, no API key).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startTuiFake } from "./claude-tui-fake-api.mjs";

const run = promisify(execFile);
const imageDir = new URL(".", import.meta.url).pathname;
const claude = await run("sh", ["-c", "command -v claude"])
  .then(({ stdout }) => stdout.trim())
  .catch(() => "");
const tmux = await run("sh", ["-c", "command -v tmux"])
  .then(({ stdout }) => stdout.trim())
  .catch(() => "");
const skip = !claude ? "claude is not on PATH" : !tmux ? "tmux is not on PATH" : false;

const botId = "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";
const agentId = "a9e1a9e1a9e1a9e1a9e1a9e1a9e1a9e1";

// Fails loudly instead of hanging; the only timer, and only in the test.
const within = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms).unref()),
  ]);

/** A fake lifecycle: Claude's login, an empty connector catalog, and agent messages. */
function startFakeLifecycle() {
  const messages = [];
  const listeners = new Set();
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const send = (status, value) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (request.headers.authorization !== "Bearer pod-identity")
      return send(403, { error: { message: "not the Pod's token" } });
    if (request.url === "/v1/runtime/claude/credentials")
      return send(200, {
        accessToken: "sk-ant-oat01-fixture",
        expiresAt: Date.now() + 8 * 3600_000,
        scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
        subscriptionType: "max",
        oauthAccount: { accountUuid: "acct-fixture", emailAddress: "nick@example.com", organizationUuid: "org-fixture" },
      });
    if (request.url === "/v1/runtime/connectors/catalog") return send(200, []);
    const message = /^\/v1\/workspaces\/([^/]+)\/runtime\/message$/.exec(request.url);
    if (message && request.method === "POST") {
      const entry = { manager: message[1], body: JSON.parse(raw) };
      messages.push(entry);
      listeners.forEach((listener) => listener(entry));
      return send(202, { status: "admitted" });
    }
    send(404, { error: { message: `unexpected ${request.method} ${request.url}` } });
  });
  const nextMessage = () =>
    new Promise((resolve) => {
      if (messages.length) return resolve(messages[0]);
      listeners.add(resolve);
    });
  return { server, messages, nextMessage };
}

test(
  "a claude workspace starts Claude Code unattended on its task, reports back with messageManager, and resumes after a restart",
  { skip, timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-claude-agent-"));
    const api = startTuiFake();
    const lifecycle = startFakeLifecycle();
    for (const server of [api.server, lifecycle.server])
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const checkout = join(directory, "repos", "octo", "app.web_1");
    const state = join(directory, "state");
    const config = join(state, "config");
    await mkdir(checkout, { recursive: true });
    await mkdir(join(directory, "tmux"));
    const workspace = join(directory, "workspace.json");
    await writeFile(
      workspace,
      JSON.stringify({
        id: agentId,
        name: "claude-131",
        role: "coding",
        cwd: checkout,
        repositories: false,
        harness: "claude",
        manager: botId,
        model: { provider: "claude", id: "sonnet" },
      }),
    );
    const identity = join(directory, "identity-token");
    await writeFile(identity, "pod-identity\n");
    const env = {
      // adm-claude, adm-claude-mcp and adm-claude-credentials are in /usr/local/bin in the image.
      PATH: `${imageDir}:${process.env.PATH}`,
      HOME: directory,
      ADM_LIFECYCLE_URL: `http://127.0.0.1:${lifecycle.server.address().port}`,
      ADM_LIFECYCLE_TOKEN_FILE: identity,
      ADM_CLAUDE_STATE: state,
      ADM_WORKSPACE_CONFIG: workspace,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.server.address().port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // Offer MCP tools directly instead of behind ToolSearch, so the fake
      // model can call messageManager in one step.
      ENABLE_TOOL_SEARCH: "false",
      // A private tmux server, as the Pod has its own.
      TMUX_TMPDIR: join(directory, "tmux"),
    };
    const tmuxIn = (...args) => run("tmux", args, { env }).then(({ stdout }) => stdout);
    t.after(async () => {
      // Claude writes its config on the way out: wait for it before rm.
      const pid = (await tmuxIn("display-message", "-p", "-t", "=claude:", "#{pane_pid}").catch(() => "")).trim();
      await tmuxIn("kill-server").catch(() => {});
      if (pid) await run("tail", ["--pid", pid, "-f", "/dev/null"]);
      for (const server of [api.server, lifecycle.server]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await rm(directory, { recursive: true, maxRetries: 10 });
    });
    const admClaude = async (args, input = "") => {
      const child = spawn(join(imageDir, "adm-claude"), args, { cwd: "/", env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end(input);
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const [code] = await once(child, "close");
      assert.equal(code, 0, `adm-claude ${args.join(" ")}: ${output}`);
    };
    const screen = () => tmuxIn("capture-pane", "-p", "-t", "=claude:");
    // Claude's own record of the running session (research/claude-code/tui-driving.md).
    const sessionRecord = async (status) => {
      const pid = (await tmuxIn("display-message", "-p", "-t", "=claude:", "#{pane_pid}")).trim();
      const file = join(config, "sessions", `${pid}.json`);
      await mkdir(join(config, "sessions"), { recursive: true });
      return new Promise((resolve) => {
        const watcher = watch(join(config, "sessions"));
        const check = async () => {
          const record = await readFile(file, "utf8").then(JSON.parse, () => undefined);
          if (record?.status === status) watcher.close(), resolve(record);
        };
        watcher.on("change", check);
        check();
      });
    };

    const task = `Fix issue #131.\nCALL:mcp__manager__messageManager {"text":"done: PR #7"}`;
    await admClaude(["start", "--task"], task);
    const message = await within(lifecycle.nextMessage(), 60000, "messageManager reaches the lifecycle").catch(
      async (error) => {
        console.log(await screen().catch(() => "no claude session"), JSON.stringify(api.requests, null, 1));
        throw error;
      },
    );
    assert.equal(message.manager, botId);
    assert.equal(message.body.text, "done: PR #7");
    assert.match(message.body.requestId, new RegExp(`^${agentId}:`));
    const first = await within(sessionRecord("idle"), 30000, "Claude idle after its task");
    const prompts = api.requests.filter((request) => request.text === task);
    assert.equal(prompts.length, 1, "the task is Claude's first prompt, sent once");
    assert.match(prompts[0].model, /sonnet/, "the workspace's model.id is Claude's --model");
    assert.doesNotMatch(
      await screen(),
      /trust this folder|Bypass Permissions mode|text style|external CLAUDE\.md|Do you want/,
    );

    // A Pod restart takes tmux and Claude with it; the entrypoint's boot
    // resumes the conversation, and Claude gets no new prompt.
    const requestsBefore = api.requests.length;
    await tmuxIn("kill-server");
    await run("tail", ["--pid", String(first.pid), "-f", "/dev/null"]);
    await admClaude(["boot"]);
    const resumed = await within(sessionRecord("idle"), 30000, "Claude idle after the restart");
    assert.notEqual(resumed.pid, first.pid);
    assert.equal(resumed.sessionId, first.sessionId, "boot continues the same conversation");
    assert.equal(api.requests.length, requestsBefore, "the task is never sent again");
    assert.match(await screen(), /Fix issue #131/, "the conversation is back on screen");
    assert.equal(existsSync(join(state, "task")), false, "the task leaves the volume once Claude has it");
  },
);
