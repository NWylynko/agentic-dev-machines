// A workspace whose harness is "claude" (TASK-141/142): the runner never
// runs a Pi turn there; it reports, prompts, aborts and reads back the Claude
// Code session in tmux. Runs the real runner, the real `adm-claude` and
// `claude` in a private tmux server, against the fake Anthropic API of
// image/claude-tui-fake-api.mjs and a fake lifecycle for Claude's login.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startTuiFake } from "../../../image/claude-tui-fake-api.mjs";
import { startRunner } from "./http-fixture.mjs";

const run = promisify(execFile);
const imageDir = new URL("../../../image/", import.meta.url).pathname;
const onPath = (name) =>
  run("sh", ["-c", `command -v ${name}`])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
const skip = !(await onPath("claude"))
  ? "claude is not on PATH"
  : !(await onPath("tmux"))
    ? "tmux is not on PATH"
    : false;
const id = "c1a0dec0de0000000000000000000001";

// Fails loudly instead of hanging; only in the test.
const within = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${what}`)), ms).unref(),
    ),
  ]);

/** Claude's login from a fake lifecycle, as in a Pod (no API key). */
function startFakeLifecycle() {
  return createServer((request, response) => {
    const send = (status, value) =>
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (request.url === "/v1/runtime/claude/credentials")
      return send(200, {
        accessToken: "sk-ant-oat01-fixture",
        expiresAt: Date.now() + 8 * 3600_000,
        scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
        subscriptionType: "max",
        oauthAccount: {
          accountUuid: "acct-fixture",
          emailAddress: "nick@example.com",
          organizationUuid: "org-fixture",
        },
      });
    if (request.url === "/v1/runtime/connectors/catalog") return send(200, []);
    send(404, { error: { message: `unexpected ${request.url}` } });
  });
}

async function claudeWorkspace(t, { readyDeadlineMs } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-claude-"));
  const api = startTuiFake();
  const lifecycle = startFakeLifecycle();
  for (const server of [api.server, lifecycle])
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const localRoot = join(directory, "workspace");
  const checkout = join(directory, "checkout");
  await mkdir(checkout, { recursive: true });
  await mkdir(join(directory, "tmux"));
  const config = {
    id,
    name: "claude-131",
    role: "coding",
    environment: "local",
    localRoot,
    cwd: checkout,
    harness: "claude",
    model: { provider: "claude", id: "sonnet" },
  };
  const workspaceFile = join(directory, "workspace.json");
  await writeFile(workspaceFile, JSON.stringify(config));
  const identity = join(directory, "identity-token");
  await writeFile(identity, "pod-identity\n");
  // One tmux server for the runner and adm-claude, like the Pod's.
  const tmuxEnv = { TMUX_TMPDIR: join(directory, "tmux") };
  const env = {
    ...process.env,
    ...tmuxEnv,
    PATH: `${imageDir}:${process.env.PATH}`,
    HOME: directory,
    ADM_LIFECYCLE_URL: `http://127.0.0.1:${lifecycle.address().port}`,
    ADM_LIFECYCLE_TOKEN_FILE: identity,
    // The runner's default: the workspace root's .adm/claude.
    ADM_CLAUDE_STATE: join(localRoot, ".adm", "claude"),
    ADM_WORKSPACE_CONFIG: workspaceFile,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const tmux = (...args) =>
    run("tmux", args, { env }).then(({ stdout }) => stdout);
  let runner;
  t.after(async () => {
    await runner?.stop();
    const pid = (
      await tmux(
        "display-message",
        "-p",
        "-t",
        "=claude:",
        "#{pane_pid}",
      ).catch(() => "")
    ).trim();
    await tmux("kill-server").catch(() => {});
    if (pid) await run("tail", ["--pid", pid, "-f", "/dev/null"]);
    for (const server of [api.server, lifecycle]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(directory, { recursive: true, maxRetries: 10 });
  });
  runner = await startRunner(join(directory, "runner"), {
    ...tmuxEnv,
    ...(readyDeadlineMs
      ? { ADM_CLAUDE_READY_DEADLINE_MS: String(readyDeadlineMs) }
      : {}),
  });
  const registered = await runner.request(
    `/v1/workspaces/${id}`,
    "PUT",
    config,
  );
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const admClaude = async (args, input = "") => {
    const child = spawn(join(imageDir, "adm-claude"), args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(input);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const [code] = await once(child, "close");
    assert.equal(code, 0, `adm-claude ${args.join(" ")}: ${output}`);
  };
  const activity = async () =>
    (await runner.request(`/v1/workspaces/${id}/runtime-status`)).body.activity;
  // Status reads are cheap file reads: poll them until `test` holds.
  const activityUntil = async (test, what) => {
    for (;;) {
      const value = await activity();
      if (test(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return {
    api,
    runner,
    tmux,
    admClaude,
    activity,
    activityUntil,
    state: env.ADM_CLAUDE_STATE,
    within: (promise, what) => within(promise, 20000, what),
  };
}

test(
  "a Claude agent's status comes from Claude's session record, and Pi takes no turns",
  { skip, timeout: 120000 },
  async (t) => {
    const c = await claudeWorkspace(t);
    assert.deepEqual(
      await c.activity(),
      { status: "unavailable" },
      "not started yet",
    );

    await c.admClaude(["start", "--task"], "first task HOLD");
    await c.within(
      c.activityUntil((a) => a.status === "running"),
      "running while the task streams",
    );
    const status = await c.runner.request(`/v1/workspaces/${id}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.harness, "claude");
    assert.equal(status.body.status, "running");
    // Busy shows at submit, before the request reaches the model: release
    // only a stream that is held.
    await c.within(
      c.api.waitFor((line) => line.text === "first task HOLD"),
      "the task streams",
    );
    c.api.release();
    await c.within(
      c.activityUntil((a) => a.status === "idle"),
      "idle after the task",
    );

    for (const [path, method, body] of [
      ["goals", "POST", { value: { description: "ship it" } }],
      ["loops", "POST", { value: { prompt: "check", intervalMs: 60000 } }],
      ["model", "PUT", { provider: "faux", modelId: "faux-1" }],
      ["resume", "POST", {}],
      ["retry", "POST", {}],
      ["compact", "POST", {}],
    ]) {
      const refused = await c.runner.request(
        `/v1/workspaces/${id}/${path}`,
        method,
        body,
      );
      assert.equal(
        refused.status,
        409,
        `${path}: ${JSON.stringify(refused.body)}`,
      );
      assert.match(
        refused.body.error.message,
        /not supported for Claude Code agents/,
      );
    }
    assert.equal(
      c.api.requests.filter((request) => request.text !== undefined).length,
      1,
      "only Claude's own task reached the model",
    );
  },
);

test(
  "a Claude that never becomes ready fails loudly with its screen",
  { skip, timeout: 60000 },
  async (t) => {
    const c = await claudeWorkspace(t, { readyDeadlineMs: 500 });
    // Stand-in for Claude stuck on a screen nobody answers.
    await c.tmux(
      "new-session",
      "-d",
      "-s",
      "claude",
      "-x",
      "120",
      "-y",
      "20",
      "sh",
      "-c",
      "echo 'Do you trust the files in this folder?'; exec sleep 600",
    );
    const stuck = await c.within(
      c.activityUntil((a) => a.status === "error"),
      "the stuck start is reported",
    );
    assert.match(stuck.error, /Claude Code has not become ready/);
    assert.match(stuck.error, /Do you trust the files in this folder\?/);
    assert.match(c.runner.errors, /claude_not_ready/, "and logged");

    // Started here once (adm-claude's enabled marker), and now gone: also loud.
    await c.tmux("kill-session", "-t", "=claude");
    await mkdir(c.state, { recursive: true });
    await writeFile(join(c.state, "enabled"), "");
    const gone = await c.activity();
    assert.equal(gone.status, "error");
    assert.match(gone.error, /Claude Code is not running/);
  },
);

test(
  "a bot prompts, watches and aborts its Claude agent through the runner's routes",
  { skip, timeout: 180000 },
  async (t) => {
    const c = await claudeWorkspace(t);
    const input = (message, requestId, whenBusy) =>
      c.runner.request(`/v1/workspaces/${id}/input`, "POST", {
        message,
        requestId,
        ...(whenBusy ? { whenBusy } : {}),
      });
    const idle = (what) =>
      c.within(
        c.activityUntil((a) => a.status === "idle"),
        what,
      );
    const modelSaw = (text, what) =>
      c.within(
        c.api.waitFor((line) => line.text === text),
        what,
      );
    await c.admClaude(["start", "--task"], "warm up");
    await modelSaw("warm up", "the task");
    await idle("idle after the task");

    // Idle: the prompt is pasted and submitted once, newlines intact; a
    // replayed request ID is not sent again.
    const prompt = 'second line one\n\n  "quoted" $HOME `tick`\nlast';
    const admitted = await input(prompt, "bot:1");
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    assert.equal(admitted.body.status, "admitted");
    await modelSaw(prompt, "the prompt");
    await idle("idle after the prompt");
    assert.equal((await input(prompt, "bot:1")).status, 202);
    assert.equal(
      c.api.requests.filter((line) => line.text === prompt).length,
      1,
      "a replayed requestId is delivered once",
    );

    // Busy: reject refuses; steer and followUp are typed in, and Claude
    // takes them after the running turn.
    assert.equal((await input("long HOLD", "bot:2")).status, 202);
    await modelSaw("long HOLD", "the long turn streams");
    const rejected = await input("not now", "bot:3", "reject");
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, "AGENT_BUSY");
    assert.equal(
      (await input("queued while busy", "bot:4", "followUp")).status,
      202,
    );
    c.api.release();
    await modelSaw("queued while busy", "the queued prompt");
    await idle("idle after the queued prompt");
    assert.ok(
      !c.api.requests.some((line) => line.text?.includes("not now")),
      "a rejected prompt never reaches Claude",
    );

    // Abort: Escape stops the stream; Claude is idle and takes prompts again.
    assert.equal((await input("abort me HOLD", "bot:5")).status, 202);
    await modelSaw("abort me HOLD", "the turn to abort");
    const aborted = await c.runner.request(
      `/v1/workspaces/${id}/abort`,
      "POST",
      {},
    );
    assert.equal(aborted.status, 200, JSON.stringify(aborted.body));
    assert.equal(aborted.body.status, "idle");
    await c.within(
      c.api.waitFor((line) => line.aborted === "abort me HOLD"),
      "the stream is closed",
    );

    // Waiting on Claude's own question: input refuses (it would type into
    // the question); abort cancels the question.
    assert.equal((await input("please ASK me", "bot:6")).status, 202);
    await c.within(
      c.activityUntil((a) => a.status === "waiting"),
      "waiting on the question",
    );
    const answering = await input("Red", "bot:7", "followUp");
    assert.equal(answering.status, 409, JSON.stringify(answering.body));
    assert.equal(answering.body.error.code, "CLAUDE_CODE_WAITING");
    const status = await c.runner.request(`/v1/workspaces/${id}`);
    assert.equal(status.body.status, "waiting");
    assert.equal(status.body.waitingFor, "input needed");
    assert.equal(
      (await c.runner.request(`/v1/workspaces/${id}/abort`, "POST", {})).body
        .status,
      "idle",
    );

    assert.equal((await input("after the question", "bot:8")).status, 202);
    await c.within(
      c.api.waitFor((line) => line.text?.includes("after the question")),
      "a prompt after the question",
    );
    await idle("idle after the question");

    // History: prompts and final replies only, no tool calls or results.
    const history = await c.runner.request(
      `/v1/workspaces/${id}/history?after=0&limit=1000`,
    );
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.deepEqual(
      history.body.events.map(({ kind, text }) => ({ kind, text })),
      [
        { kind: "user", text: "warm up" },
        { kind: "assistant", text: "ECHO: warm up" },
        { kind: "user", text: prompt },
        { kind: "assistant", text: `ECHO: ${prompt}` },
        { kind: "user", text: "long HOLD" },
        { kind: "assistant", text: "working... ECHO: long HOLD" },
        { kind: "user", text: "queued while busy" },
        { kind: "assistant", text: "ECHO: queued while busy" },
        { kind: "user", text: "abort me HOLD" },
        { kind: "assistant", text: "working... " },
        { kind: "interrupted", text: undefined },
        { kind: "user", text: "please ASK me" },
        { kind: "interrupted", text: undefined },
        { kind: "user", text: "after the question" },
        {
          kind: "assistant",
          text: "ECHO: [Request interrupted by user for tool use]\n | after the question",
        },
      ],
    );
    assert.deepEqual(
      history.body.events.map(({ seq }) => seq),
      history.body.events.map((_, index) => index + 1),
    );
    const page = await c.runner.request(
      `/v1/workspaces/${id}/history?after=2&limit=2`,
    );
    assert.deepEqual(
      page.body.events.map(({ seq }) => seq),
      [3, 4],
    );
    assert.equal(page.body.nextAfter, 4);
    assert.equal(page.body.hasMore, true);
  },
);
