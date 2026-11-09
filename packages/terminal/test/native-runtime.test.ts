import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { DurableInteractiveRuntime } from "../src/native-runtime.ts";
import { WorkspaceConnection } from "../src/workspace-connection.ts";
import {
  attachThroughProxy,
  fauxPrompt,
  occurrences,
} from "./attach-harness.ts";
import { TERMINAL_TEST_TIMEOUT_MS } from "./wait-budget.ts";

// A real runner with the faux provider and one coding workspace.
async function codingRunner(t: test.TestContext, id: string) {
  const directory = await mkdtemp(join(tmpdir(), "adm-native-runtime-"));
  const runner = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../runner/src/main.ts", import.meta.url)),
      "--port",
      "0",
      "--state-dir",
      join(directory, "runner"),
      "--provider",
      "faux",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: directory },
    },
  );
  let errors = "";
  runner.stderr.on("data", (chunk) => (errors += chunk));
  const exited = once(runner, "exit");
  const lines = createInterface({ input: runner.stdout });
  t.after(async () => {
    if (runner.exitCode === null && runner.signalCode === null) {
      runner.kill("SIGTERM");
      await exited;
    }
    lines.close();
    await rm(directory, { recursive: true });
  });
  const url = await new Promise<string>((resolve, reject) => {
    runner.once("exit", (code) =>
      reject(new Error(`Runner exited ${code}: ${errors}`)),
    );
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.ready) resolve(value.url);
      } catch {}
    });
  });
  const root = join(directory, "repo");
  await mkdir(root);
  const registered = await fetch(`${url}/v1/workspaces/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id,
      name: id,
      role: "coding",
      environment: "local",
      localRoot: root,
      model: { provider: "faux", id: "faux-1" },
    }),
  });
  assert.equal(registered.status, 200);
  return { url, root, directory };
}

test(
  "Pi's session over a workspace reads and changes the workspace's own settings, queue, trust, bash and runs",
  { timeout: TERMINAL_TEST_TIMEOUT_MS },
  async (t) => {
    const id = "native-runtime";
    const runner = await codingRunner(t, id);
    const connection = new WorkspaceConnection({
      url: runner.url,
      workspaceId: id,
    });
    const remote = new DurableInteractiveRuntime(connection);
    t.after(async () => {
      await remote.dispose();
      connection.close();
    });
    await connection.connect();
    await remote.initialize();
    await connection.loadModelCatalog();
    remote.rendered();
    const session = remote.session;
    assert.equal(session.sessionManager.getCwd(), runner.root);
    assert.equal(session.model?.provider, "faux");
    assert.equal(
      session.sessionManager.getSessionId(),
      `${id}:${connection.conversationId}`,
    );

    // Settings live in the workspace, not in this terminal.
    await session.setSteeringMode("all");
    await session.setFollowUpMode("all");
    await session.setAutoCompactionEnabled(false);
    const available = session.modelRuntime.getAvailableSnapshot();
    await session.setScopedModels(available.map((model) => ({ model })));
    await session.setCacheWarmingMode("streaming");
    await session.setSessionName("renamed session");
    const saved = await connection.request("/settings");
    assert.equal(saved.steeringMode, "all");
    assert.equal(saved.followUpMode, "all");
    assert.equal(saved.autoCompact, false);
    assert.deepEqual(
      saved.scopedModels,
      available.map((model) => `${model.provider}/${model.id}`),
    );
    assert.equal(saved.cacheWarmingMode, "streaming");
    assert.equal(session.sessionName, "renamed session");
    const sessions = await remote.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.path, `${id}:${connection.conversationId}`);

    // Trust decisions are the workspace's.
    await remote.remotePorts.projectTrust.setMany([
      { path: runner.root, decision: false },
    ]);
    assert.equal(remote.remotePorts.projectTrust.get(runner.root), false);
    await remote.remotePorts.projectTrust.setMany([
      { path: runner.root, decision: true },
    ]);
    assert.equal(remote.remotePorts.projectTrust.get(runner.root), true);

    // Bash runs in the workspace and lands in its transcript.
    const chunks: string[] = [];
    const bash = await session.executeBash(
      "printf 'hello from bash'",
      (chunk: string) => chunks.push(chunk),
      { id: "bash-request-1" },
    );
    assert.equal(bash.exitCode, 0);
    assert.equal(bash.output, "hello from bash");
    assert.equal(chunks.join(""), "hello from bash");

    // A run, shown as Pi events from the workspace's state, ends settled; input
    // sent while it works waits in the workspace's queue.
    const events: string[] = [];
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    session.subscribe((event: AgentSessionEvent) => {
      events.push(
        event.type === "message_end"
          ? `message_end:${event.message.role}`
          : event.type,
      );
      if (event.type === "agent_settled") settled();
    });
    await session.prompt(
      fauxPrompt({
        calls: [{ tool: "bash", args: { command: "sleep 1" } }],
        answer: "The queued run answer",
      }),
    );
    await session.followUp("queued follow-up");
    await new Promise<void>((resolve) => {
      if (session.getFollowUpMessages().length) return resolve();
      const stop = connection.subscribeView(() => {
        if (!session.getFollowUpMessages().length) return;
        stop();
        resolve();
      });
    });
    assert.deepEqual(session.getFollowUpMessages(), ["queued follow-up"]);
    assert.deepEqual(await session.clearQueue(), {
      steering: [],
      followUp: ["queued follow-up"],
    });
    await done;
    const started = events.indexOf("agent_start");
    assert.equal(events[started + 1], "turn_start", `${events}`);
    for (const type of [
      "message_end:user",
      "tool_execution_start",
      "tool_execution_end",
      "message_end:toolResult",
      "message_end:assistant",
    ])
      assert.ok(events.includes(type), `${type} in ${events}`);
    assert.deepEqual(events.slice(-2), ["agent_end", "agent_settled"]);
    assert.ok(
      session.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "message" && entry.message.role === "bashExecution",
        ),
      "the transcript keeps Pi bash executions",
    );
    assert.ok(session.getSessionStats().tokens.total > 0);
  },
);

test(
  "attached Pi shows a tool's output, a provider failure and an aborted tool, each reply once",
  { timeout: TERMINAL_TEST_TIMEOUT_MS },
  async (t) => {
    const attached = await attachThroughProxy(t, "native-runtime-pty");
    await attached.submit(
      fauxPrompt({
        calls: [{ tool: "bash", args: { command: "echo tool-$((6 * 7))" } }],
        answer: "Reply after the tool",
      }),
    );
    const tooled = await attached.settledReply("Reply after the tool");
    assert.equal(occurrences(tooled, "tool-42"), 1, tooled);

    await attached.submit("/faux-fail-once a provider failure");
    await attached.waitScreen("the provider failure", (text) =>
      text.includes("faux injected failure"),
    );

    const tool = await attached.blockingTool();
    await attached.submit(
      fauxPrompt({
        calls: [{ tool: "bash", args: { command: tool.command } }],
        answer: "never answered",
      }),
    );
    await tool.started;
    await attached.waitScreen("the running tool", (text) =>
      text.includes("Working"),
    );
    attached.child.stdin!.write("\x1b");
    const aborted = await attached.waitScreen(
      "the aborted run",
      (text) => !text.includes("Working") && /abort/i.test(text),
    );
    assert.doesNotMatch(aborted, /never answered/);

    await attached.submit(fauxPrompt({ answer: "Reply after the abort" }));
    const last = await attached.settledReply("Reply after the abort");
    for (const reply of ["Reply after the tool", "Reply after the abort"])
      assert.equal(occurrences(last, reply), 1, last);
  },
);

test(
  "Pi's session controls move between the workspace's Durable conversations and delegate provider sign-in to adm",
  { timeout: TERMINAL_TEST_TIMEOUT_MS },
  async (t) => {
    const id = "native-navigation";
    const runner = await codingRunner(t, id);
    // `adm` on this client: records each command it is asked to run.
    const adm = join(runner.directory, "adm");
    const ran = join(runner.directory, "adm-commands");
    await writeFile(adm, `#!/bin/sh\necho "$*" >> '${ran}'\n`, {
      mode: 0o700,
    });
    const connection = new WorkspaceConnection({
      url: runner.url,
      workspaceId: id,
      adminCommand: { executable: adm, args: ["--context", "test"] },
    });
    const remote = new DurableInteractiveRuntime(connection);
    t.after(async () => {
      await remote.dispose();
      connection.close();
    });
    let rebinds = 0;
    remote.setRebindSession(async () => {
      rebinds++;
    });
    await connection.connect();
    await remote.initialize();
    await connection.loadModelCatalog();
    remote.rendered();
    const session = remote.session;
    const texts = () =>
      session.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" &&
          (entry.message.role === "user" || entry.message.role === "assistant")
            ? [JSON.stringify(entry.message.content)]
            : [],
        )
        .join("\n");
    const run = async (prompt: string) => {
      const settled = new Promise<void>((resolve) => {
        const stop = session.subscribe((event: AgentSessionEvent) => {
          if (event.type !== "agent_settled") return;
          stop();
          resolve();
        });
      });
      await session.prompt(prompt);
      await settled;
    };
    await run("first prompt");
    await run("second prompt");
    const root = connection.conversationId;
    assert.match(texts(), /Echo: second prompt/);

    // /tree: a fork through the second prompt, before its reply.
    const second = session.sessionManager
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "second prompt",
      )!;
    const forked = await remote.fork(second.id);
    assert.equal(forked.cancelled, false);
    assert.notEqual(connection.conversationId, root);
    assert.match(texts(), /Echo: first prompt/);
    assert.match(texts(), /second prompt/);
    assert.doesNotMatch(texts(), /Echo: second prompt/);

    // /new: an empty conversation.
    await remote.newSession();
    assert.equal(texts(), "");

    // /resume: back to the root, whole.
    const sessions = await remote.listSessions();
    assert.equal(sessions.length, 3);
    await remote.switchSession(
      sessions.find((info) => info.path === `${id}:${root}`)!.path,
    );
    assert.equal(connection.conversationId, root);
    assert.match(texts(), /Echo: second prompt/);

    // /import: a native Pi session becomes the selected conversation.
    const transcript = join(runner.directory, "pi session.jsonl");
    const at = new Date().toISOString();
    await writeFile(
      transcript,
      [
        {
          type: "session",
          version: 3,
          id: "pi-session",
          cwd: runner.root,
          timestamp: at,
        },
        {
          type: "message",
          id: "a",
          parentId: null,
          timestamp: at,
          message: {
            role: "user",
            content: "imported question",
            timestamp: Date.now(),
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    await remote.importFromJsonl(transcript);
    assert.notEqual(connection.conversationId, root);
    assert.match(texts(), /imported question/);
    assert.equal(rebinds, 4, "each switch re-renders Pi's session");

    // /compact is the workspace's.
    await session.compact("keep the questions");

    // Provider sign-in runs adm on this client, then reattaches.
    await remote.remotePorts.authActions.login();
    await session.modelRuntime.logout("faux");
    assert.deepEqual((await readFile(ran, "utf8")).trim().split("\n"), [
      "--context test login",
      "--context test logout faux",
    ]);
    assert.equal(connection.connected, true);
  },
);
