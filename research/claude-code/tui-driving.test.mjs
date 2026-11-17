// Spike (TASK-141/142): drive the real interactive `claude` TUI inside tmux
// against a fake Anthropic API, with a scratch HOME/CLAUDE_CONFIG_DIR.
//   node --test --test-concurrency=1 research/claude-code/tui-driving.test.mjs
// Findings: research/claude-code/tui-driving.md. Never touches ~/.claude and
// never reaches the real Anthropic API. Tests that only observe print what
// they saw; the console output is the evidence quoted in the findings.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startTuiFake } from "../../image/claude-tui-fake-api.mjs";

const run = promisify(execFile);
// CLAUDE_BIN picks another build, e.g. the version the image pins.
const claude = process.env.CLAUDE_BIN || await run("sh", ["-c", "command -v claude"]).then(({ stdout }) => stdout.trim()).catch(() => "");
const skip = claude ? false : "claude is not on PATH";
const apiKey = "sk-ant-api03-spike-fixture-key-0000000000";
const unattended = { skipDangerousModePermissionPrompt: true };

// Fails loudly instead of hanging; the only timer, and only in the test.
const within = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms).unref())]);

async function startClaude(t, { seed = true, trustParent = false, args = [], settings = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "claude-tui-"));
  const fake = startTuiFake();
  await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const port = fake.server.address().port;
  const home = join(directory, "home");
  const config = join(home, "config");
  const repo = join(directory, "repo");
  await mkdir(join(config, "sessions"), { recursive: true });
  await mkdir(repo);
  if (seed) {
    // The minimum .claude.json that skips every first-run screen. The API key
    // approval only exists because this test uses ANTHROPIC_API_KEY; a Pod
    // with an OAuth .credentials.json never sees that screen.
    await writeFile(
      join(config, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
        projects: { [trustParent ? directory : repo]: { hasTrustDialogAccepted: true } },
      }),
    );
  }
  const hook = `curl -s --data-binary @- http://127.0.0.1:${port}/hook > /dev/null`;
  const hooks = Object.fromEntries(
    ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "Notification", "SessionEnd"].map((event) => [
      event,
      [{ hooks: [{ type: "command", command: hook }] }],
    ]),
  );
  const socket = `claude-tui-${process.pid}-${port}`;
  const tmux = (...command) => run("tmux", ["-L", socket, ...command]).then(({ stdout }) => stdout);
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: apiKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    TERM: "xterm-256color",
  };
  await tmux(
    "-f", "/dev/null", "new-session", "-d", "-s", "claude", "-x", "200", "-y", "50", "-c", repo,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    claude, "--settings", JSON.stringify({ ...settings, hooks }), ...args,
  );
  t.after(async () => {
    // Claude writes its config on the way out: wait for it to exit before rm.
    const pid = (await tmux("display-message", "-p", "-t", "=claude:", "#{pane_pid}").catch(() => "")).trim();
    await tmux("kill-server").catch(() => {});
    if (pid) await run("tail", ["--pid", pid, "-f", "/dev/null"]);
    fake.server.closeAllConnections();
    await new Promise((resolve) => fake.server.close(resolve));
    await rm(directory, { recursive: true, maxRetries: 10 });
  });
  const screen = () => tmux("capture-pane", "-p", "-t", "=claude:");
  const hookEvent = (name, test = () => true) => fake.waitFor((line) => line.hook === name && test(line.input));
  // tmux adds the bracketed-paste markers only if Claude has enabled
  // bracketed paste; before that every newline is an Enter.
  const paste = async (text) => {
    // load-buffer from stdin: set-buffer's argument is capped ("command too long").
    const load = spawn("tmux", ["-L", socket, "load-buffer", "-b", "prompt", "-"], { stdio: ["pipe", "ignore", "inherit"] });
    load.stdin.end(text);
    assert.equal((await once(load, "close"))[0], 0, "tmux load-buffer");
    await tmux("paste-buffer", "-p", "-d", "-b", "prompt", "-t", "=claude:", ";", "send-keys", "-t", "=claude:", "Enter");
  };
  // $CLAUDE_CONFIG_DIR/sessions/<pid>.json: Claude's own live-session record,
  // rewritten on every status change (idle | busy | waiting).
  const sessionRecord = async () => {
    for (const name of await readdir(join(config, "sessions"))) {
      if (!name.endsWith(".json")) continue;
      try {
        return JSON.parse(await readFile(join(config, "sessions", name), "utf8"));
      } catch {} // mid-write
    }
  };
  const sessionStatus = (status) =>
    new Promise((resolve) => {
      const watcher = watch(join(config, "sessions"));
      const check = async () => {
        const record = await sessionRecord();
        if (record?.status === status) watcher.close(), resolve(record);
      };
      watcher.on("change", check);
      check();
    });
  return { fake, tmux, screen, hookEvent, paste, sessionRecord, sessionStatus, repo, config };
}

const hookLog = (fake) =>
  fake.requests.map((line) =>
    line.hook
      ? `${line.hook}${line.input.prompt !== undefined ? ` ${JSON.stringify(line.input.prompt)}` : ""}`
      : line.aborted
        ? `API aborted ${JSON.stringify(line.aborted)}`
        : `API [${line.roles}] ${JSON.stringify(line.text)}${line.afterTool ? " (tool result)" : ""}`,
  );
const lastLines = (screen, count) => screen.split("\n").filter((l) => l.trim()).slice(-count).join("\n");

test("unseeded config: onboarding screens block, and SessionStart waits behind them", { skip, timeout: 60000 }, async (t) => {
  const c = await startClaude(t, { seed: false, args: ["--dangerously-skip-permissions"] });
  const fired = await within(c.hookEvent("SessionStart"), 8000, "SessionStart").then(() => true, () => false);
  const screen = await c.screen();
  console.log(`SessionStart fired: ${fired}; session record status: ${(await c.sessionRecord())?.status}\n${lastLines(screen, 12)}`);
  assert.equal(fired, false);
  assert.match(screen, /Choose the text style/);
});

test("seeded .claude.json without skipDangerousModePermissionPrompt: the Bypass Permissions warning blocks", { skip, timeout: 60000 }, async (t) => {
  const c = await startClaude(t, { args: ["--dangerously-skip-permissions"] });
  const fired = await within(c.hookEvent("SessionStart"), 8000, "SessionStart").then(() => true, () => false);
  const screen = await c.screen();
  console.log(`SessionStart fired: ${fired}; session record status: ${(await c.sessionRecord())?.status}\n${lastLines(screen, 10)}`);
  assert.equal(fired, false);
  assert.match(screen, /Bypass Permissions mode/);
});

test("pasting the moment SessionStart fires is too early: the prompt is split, merged or left unsent", { skip, timeout: 90000 }, async (t) => {
  const clean = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await startClaude(t, { args: ["--dangerously-skip-permissions"], settings: unattended });
    await within(c.hookEvent("SessionStart"), 30000, "SessionStart");
    const record = await c.sessionRecord();
    const early = `early ${attempt}\nsecond line`;
    await c.paste(early);
    await within(c.sessionStatus("idle"), 30000, "idle");
    await c.paste(`ready ${attempt}`);
    const after = await within(c.hookEvent("Stop", (input) => input.last_assistant_message.includes(`ready ${attempt}`)), 10000, "Stop").then(() => "", (error) => ` (${error.message})`);
    console.log(`attempt ${attempt}: session record at SessionStart: ${record ? record.status : "none"}${after}\n  ${hookLog(c.fake).join("\n  ")}`);
    clean.push(c.fake.requests.some((line) => line.hook === "UserPromptSubmit" && line.input.prompt === early));
  }
  assert.ok(clean.includes(false), "at least one early paste went wrong");
});

test("ready = sessions/<pid>.json says idle: no dialog, paste + Enter submits once, newlines kept, big prompts too", { skip, timeout: 180000 }, async (t) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    await t.test(`start ${attempt}`, async (t) => {
      const c = await startClaude(t, { args: ["--dangerously-skip-permissions"], settings: unattended });
      await within(c.sessionStatus("idle"), 30000, "idle");
      assert.doesNotMatch(await c.screen(), /trust this folder|Bypass Permissions mode|API key|text style/);
      const prompt = `first line ${attempt}\nsecond line\n\n  indented "quoted" $HOME \`tick\` \\back\nlast`;
      await c.paste(prompt);
      const submitted = await within(c.hookEvent("UserPromptSubmit"), 30000, "UserPromptSubmit");
      assert.equal(submitted.input.prompt, prompt);
      await within(c.hookEvent("Stop"), 30000, "Stop");
      const big = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
      await c.paste(big);
      const second = await within(c.hookEvent("UserPromptSubmit", (input) => input.prompt.startsWith("line 0")), 30000, "big prompt");
      assert.equal(second.input.prompt, big);
      await within(c.hookEvent("Stop", (input) => input.last_assistant_message.includes("line 299")), 30000, "big Stop");
      const prompts = c.fake.requests.filter((line) => line.hook === "UserPromptSubmit");
      assert.equal(prompts.length, 2, hookLog(c.fake).join("\n"));
      assert.equal(c.fake.requests.filter((line) => line.text === prompt).length, 1, "one model request per prompt");
    });
  }
});

test("trust accepted on a parent directory covers the checkout below it", { skip, timeout: 60000 }, async (t) => {
  const c = await startClaude(t, { trustParent: true, args: ["--dangerously-skip-permissions"], settings: unattended });
  const ready = await within(c.sessionStatus("idle"), 8000, "idle").then(() => true, () => false);
  console.log(`idle with only the parent trusted: ${ready}\n${lastLines(await c.screen(), 6)}`);
  assert.equal(ready, true);
});

test("idle paste + Enter, 10 prompts in a row: each submitted exactly once", { skip, timeout: 120000 }, async (t) => {
  const c = await startClaude(t, { args: ["--dangerously-skip-permissions", "warm up"], settings: unattended });
  await within(c.hookEvent("Stop"), 30000, "warm-up Stop");
  for (let round = 0; round < 10; round++) {
    const prompt = `round ${round}\nsecond line`;
    await c.paste(prompt);
    await within(c.hookEvent("Stop", (input) => input.last_assistant_message === `ECHO: ${prompt}`), 10000, `round ${round}`);
  }
  assert.equal(c.fake.requests.filter((line) => line.hook === "UserPromptSubmit").length, 11);
});

test("initial prompt as a positional argument: submitted once on start, newlines kept, no paste needed", { skip, timeout: 60000 }, async (t) => {
  const prompt = "initial line one\ninitial line two";
  const c = await startClaude(t, { args: ["--dangerously-skip-permissions", prompt], settings: unattended });
  const submitted = await within(c.hookEvent("UserPromptSubmit"), 30000, "UserPromptSubmit");
  assert.equal(submitted.input.prompt, prompt);
  await within(c.hookEvent("Stop"), 30000, "Stop");
  console.log(hookLog(c.fake).join("\n"));
});

test("mid-turn text: queued, then sent as the next turn or injected at a tool boundary; Escape aborts with no Stop hook", { skip, timeout: 120000 }, async (t) => {
  const c = await startClaude(t, { args: ["--dangerously-skip-permissions"], settings: unattended });
  const session = await within(c.hookEvent("SessionStart"), 30000, "SessionStart");
  await within(c.sessionStatus("idle"), 30000, "idle");

  await c.paste("streaming HOLD");
  await within(c.fake.waitFor((line) => line.text === "streaming HOLD"), 30000, "HOLD request");
  assert.equal((await c.sessionRecord()).status, "busy");
  await c.paste("queued during stream\nsecond line");
  await within(c.hookEvent("UserPromptSubmit", (input) => input.prompt.startsWith("queued")), 30000, "queued UserPromptSubmit");
  console.log(lastLines(await c.screen(), 8));
  c.fake.release();
  await within(c.hookEvent("Stop", (input) => input.last_assistant_message.includes("queued during stream")), 30000, "queued Stop");

  // A turn that runs one Bash tool call: `touch started; cat gate` (a fifo),
  // so the test knows the tool is running and decides when it finishes.
  const toolTurn = async (label, { queueWhileToolRuns }) => {
    const gate = join(c.repo, `gate-${label}`);
    const started = join(c.repo, `started-${label}`);
    await run("mkfifo", [gate]);
    const toolStarted = new Promise((resolve) => {
      const watcher = watch(c.repo, (_, name) => name === `started-${label}` && (watcher.close(), resolve()));
    });
    await c.paste(`tool ${label} TOOL:touch ${started} && cat ${gate}`);
    const debug = async (error) => {
      console.log(hookLog(c.fake).join("\n"), "\n", lastLines(await c.screen(), 15));
      throw error;
    };
    if (queueWhileToolRuns) await within(toolStarted, 30000, "tool started").catch(debug);
    else await within(c.fake.waitFor((line) => line.text?.startsWith(`tool ${label}`)), 30000, "tool_use request");
    await c.paste(`queued ${label}`);
    await within(c.hookEvent("UserPromptSubmit", (input) => input.prompt === `queued ${label}`), 30000, "queued UserPromptSubmit");
    // A child writes the fifo, so a test failure never leaves Node blocked on it.
    const opener = spawn("sh", ["-c", `echo open > '${gate}'`]);
    t.after(() => opener.kill());
    await within(c.hookEvent("Stop", (input) => input.last_assistant_message.includes(`queued ${label}`)), 30000, `${label} Stop`).catch(debug);
    const injected = c.fake.requests.some((line) => line.afterTool && line.text.includes(`queued ${label}`));
    console.log(`${label}: queued text ${injected ? "INJECTED into the tool-result request (same turn)" : "sent as the NEXT turn"}`);
    return injected;
  };
  const beforeTool = await toolTurn("before-tool-runs", { queueWhileToolRuns: false });
  const whileTool = await toolTurn("while-tool-runs", { queueWhileToolRuns: true });

  await c.paste("abort me HOLD");
  await within(c.fake.waitFor((line) => line.text === "abort me HOLD"), 30000, "abort request");
  await c.tmux("send-keys", "-t", "=claude:", "Escape");
  await within(c.fake.waitFor((line) => line.aborted === "abort me HOLD"), 30000, "stream aborted");
  await within(c.sessionStatus("idle"), 30000, "idle after Escape");
  await c.paste("after abort");
  await within(c.hookEvent("Stop", (input) => input.last_assistant_message.includes("after abort")), 30000, "after-abort Stop");

  const log = hookLog(c.fake);
  console.log(log.join("\n"));
  const between = log.slice(log.indexOf('API aborted "abort me HOLD"'), log.indexOf('UserPromptSubmit "after abort"'));
  assert.ok(!between.some((l) => l.startsWith("Stop")), "no Stop hook after Escape");

  // The Stop hook can fire before the turn's last lines reach the transcript:
  // re-read on every change until the final reply is there.
  const transcriptPath = c.fake.requests.filter((l) => l.hook === "Stop").at(-1).input.transcript_path;
  console.log(`transcript path at SessionStart and at the last Stop are the same: ${transcriptPath === session.input.transcript_path}`);
  const readTranscript = async () =>
    (await readFile(transcriptPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  let watcher;
  t.after(() => watcher?.close());
  const transcript = await within(
    new Promise((resolve) => {
      watcher = watch(dirname(transcriptPath));
      const check = async () => {
        const entries = await readTranscript();
        if (entries.some((e) => e.type === "assistant" && JSON.stringify(e.message.content).includes("after abort")))
          watcher.close(), resolve(entries);
      };
      watcher.on("change", check);
      check();
    }),
    10000,
    "transcript has the final reply",
  ).catch(async (error) => {
    for (const e of (await readTranscript()).slice(-8)) console.log(JSON.stringify(e).slice(0, 300));
    throw error;
  });
  const history = transcriptHistory(transcript);
  console.log(session.input.transcript_path.replace(c.config, "$CLAUDE_CONFIG_DIR"));
  console.log(JSON.stringify(history, null, 1));
  console.log(
    transcript
      .filter((e) => JSON.stringify(e).includes("queued "))
      .map((e) => `${e.type}${e.attachment ? `/${e.attachment.type}` : ""}${e.operation ? `/${e.operation}` : ""}: ${JSON.stringify(e).slice(0, 160)}`)
      .join("\n"),
  );
  const users = history.filter((h) => h.role === "user").map((h) => h.text);
  for (const label of ["before-tool-runs", "while-tool-runs"]) assert.ok(users.includes(`queued ${label}`), `history has queued ${label}`);
  assert.deepEqual(history.slice(-5), [
    { role: "user", text: "abort me HOLD" },
    { role: "assistant", text: "working... " },
    { role: "interrupted" },
    { role: "user", text: "after abort" },
    { role: "assistant", text: "ECHO: [Request interrupted by user]\n | after abort" },
  ]);
  console.log({ beforeTool, whileTool });
});

test("AskUserQuestion: Notification(permission_prompt) fires, session record says waiting; Escape cancels with no Stop", { skip, timeout: 60000 }, async (t) => {
  const c = await startClaude(t, { args: ["--dangerously-skip-permissions"], settings: unattended });
  await within(c.sessionStatus("idle"), 30000, "idle");
  await c.paste("please ASK me");
  const notified = await within(c.hookEvent("Notification"), 15000, "Notification");
  const waiting = await within(c.sessionStatus("waiting"), 15000, "waiting");
  console.log(`Notification: ${JSON.stringify({ message: notified.input.message, type: notified.input.notification_type })}`);
  console.log(`session record: ${JSON.stringify({ status: waiting.status, waitingFor: waiting.waitingFor })}`);
  console.log(lastLines(await c.screen(), 10));
  await c.tmux("send-keys", "-t", "=claude:", "Escape");
  await within(c.sessionStatus("idle"), 15000, "idle after Escape");
  console.log(hookLog(c.fake).join("\n"));
  assert.ok(!c.fake.requests.some((line) => line.hook === "Stop"));
});

test("--remote-control NAME without a claude.ai login does not block input", { skip, timeout: 60000 }, async (t) => {
  const c = await startClaude(t, { args: ["--dangerously-skip-permissions", "--remote-control", "spike"], settings: unattended });
  await within(c.sessionStatus("idle"), 30000, "idle");
  await c.paste("hello\nremote");
  const submitted = await within(c.hookEvent("UserPromptSubmit"), 30000, "UserPromptSubmit");
  assert.equal(submitted.input.prompt, "hello\nremote");
  await within(c.hookEvent("Stop"), 30000, "Stop");
  console.log(lastLines(await c.screen(), 40));
});

test("--remote-control NAME then a positional initial prompt: NAME stays the name, the prompt is submitted", { skip, timeout: 60000 }, async (t) => {
  const prompt = "initial with\nremote control";
  const c = await startClaude(t, { args: ["--dangerously-skip-permissions", "--remote-control", "spike-name", prompt], settings: unattended });
  const submitted = await within(c.hookEvent("UserPromptSubmit"), 30000, "UserPromptSubmit");
  assert.equal(submitted.input.prompt, prompt);
  await within(c.hookEvent("Stop"), 30000, "Stop");
  assert.ok(!c.fake.requests.some((line) => line.text?.includes("spike-name")), "the name is not sent as a prompt");
});

// History for a bot: the human prompts and the final assistant text of each
// turn. Skips tool calls/results, meta and system entries, and the newer
// api-request-* / queue-operation lines.
export function transcriptHistory(entries) {
  const history = [];
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    // Text typed mid-turn and delivered with a tool result (same turn).
    if (entry.type === "attachment" && entry.attachment?.type === "queued_command")
      history.push({ role: "user", text: entry.attachment.prompt, midTurn: true });
    if (entry.type === "user" && !entry.isMeta) {
      const content = entry.message.content;
      if (Array.isArray(content) && content.some((b) => b.type === "tool_result")) continue;
      const text = typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text.startsWith("[Request interrupted by user")) history.push({ role: "interrupted" });
      else history.push({ role: "user", text });
    }
    if (entry.type === "assistant") {
      const text = entry.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (!text) continue;
      const previous = history.at(-1);
      // Only the latest assistant text of a turn is kept: the final reply.
      if (previous?.role === "assistant") previous.text = text;
      else history.push({ role: "assistant", text });
    }
  }
  return history;
}
