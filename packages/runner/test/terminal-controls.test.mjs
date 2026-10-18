import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { createWorkspaceImportedTree } from "../src/navigation.ts";

const main = new URL("../src/main.ts", import.meta.url);

test("failed imported branch publication keeps the old conversation active and reports the staged root", async () => {
  const navigation = {
    activeConversationId: 1,
    branches: [{ conversationId: 1, createdAt: 1 }],
  };
  const history = new Map([[1, ["Existing conversation"]]]);
  let nextId = 2;
  const harness = {
    snapshot: async () => structuredClone(navigation),
    createConversation: async (options) => {
      const id = nextId++;
      const staged = [];
      await options.init(
        {
          appendEntry: async (conversationId, entry) => {
            assert.equal(conversationId, id);
            staged.push(entry.model[0]);
            return { id: staged.length };
          },
        },
        id,
      );
      history.set(id, staged);
      return { id };
    },
    commit: async (callback) => {
      const draft = structuredClone(navigation);
      const tx = {
        forkConversation: async () => {
          throw new Error("injected Durable fork failure");
        },
        doc: async () => draft,
      };
      const result = await callback(tx);
      Object.assign(navigation, draft);
      return result;
    },
  };
  await assert.rejects(
    createWorkspaceImportedTree(
      harness,
      1,
      {},
      "selected-leaf",
      [
        {
          leafId: "selected-leaf",
          entries: [
            { id: "root", parentId: null, message: { role: "user" } },
            { id: "selected-leaf", parentId: "root", message: { role: "assistant" } },
          ],
        },
        {
          leafId: "alternate-leaf",
          entries: [
            { id: "root", parentId: null, message: { role: "user" } },
            { id: "alternate-leaf", parentId: "root", message: { role: "user" } },
          ],
        },
      ],
    ),
    /previous selection is unchanged by this import; staged conversation 2 is recorded as incomplete/,
  );
  assert.equal(navigation.activeConversationId, 1);
  assert.deepEqual(navigation.branches, [{ conversationId: 1, createdAt: 1 }]);
  assert.deepEqual(navigation.incompleteImports, [
    { conversationId: 2, createdAt: navigation.incompleteImports[0].createdAt },
  ]);
  assert.equal(history.get(1)[0], "Existing conversation");
  assert.equal(history.get(2).length, 2);
});

async function runnerFor(directory, { defaultModel = true } = {}) {
  const args = [
    main.pathname,
    "--port",
    "0",
    "--state-dir",
    directory,
    "--provider",
    "faux",
  ];
  if (defaultModel) args.push("--model", "faux-1");
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`runner exited ${code}: ${errors}`)),
    );
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.ready) resolve(value.url);
      } catch {}
    });
  });
  const url = await ready;
  return {
    url,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      lines.close();
    },
    async request(path, method = "GET", body) {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function waitForEvent(response, predicate) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const part = await reader.read();
    if (part.done) throw new Error("event stream ended before expected event");
    buffer += decoder.decode(part.value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6));
      if (predicate(event)) return event;
    }
  }
}

function observeEvents(response) {
  const frames = [];
  const waiters = [];
  const publish = (frame) => {
    frames.push(frame);
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (waiters[index].predicate(frame)) {
        waiters[index].resolve(frame);
        waiters.splice(index, 1);
      }
    }
  };
  const done = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const part = await reader.read();
      if (part.done) return;
      buffer += decoder.decode(part.value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const lines = buffer.slice(0, end).split("\n");
        buffer = buffer.slice(end + 2);
        const type =
          lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim() ?? "message";
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) publish({ type, data: JSON.parse(data) });
      }
    }
  })().catch((error) => {
    if (error?.name !== "AbortError") throw error;
  });
  const waitForAfter = (index, predicate) => {
    const existing = frames.slice(index).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) =>
      waiters.push({
        predicate: (frame) =>
          frames.indexOf(frame) >= index && predicate(frame),
        resolve,
      }),
    );
  };
  return {
    frames,
    done,
    waitFor(predicate) {
      return waitForAfter(0, predicate);
    },
    waitForAfter,
  };
}

test(
  "Durable tree forks and selects a branch, then restores that branch after runner restart",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-terminal-branches-"));
    let runner = await runnerFor(directory);
    t.after(async () => runner?.stop());
    const path = "/v1/workspaces/branch-demo";
    const registered = await runner.request(path, "PUT", {
      id: "branch-demo",
      name: "branch demo",
      role: "coding",
      environment: "local",
      localRoot: directory,
      model: { provider: "faux", id: "faux-1" },
    });
    assert.equal(registered.status, 200);
    const initial = await runner.request(path + "/branches");
    assert.equal(initial.status, 200);
    assert.ok(initial.body.activeConversationId);
    assert.deepEqual(initial.body.branches.length, 1);
    assert.equal(
      initial.body.activeConversationId,
      (await runner.request(path)).body.conversationId,
    );
    assert.equal(
      (
        await runner.request(path + "/branch", "PUT", {
          conversationId: 999999,
        })
      ).status,
      404,
    );

    const firstController = new AbortController();
    const secondController = new AbortController();
    const [firstResponse, secondResponse] = await Promise.all([
      fetch(
        `${runner.url}${path}/events?after=0&conversationId=${initial.body.activeConversationId}`,
        { signal: firstController.signal },
      ),
      fetch(
        `${runner.url}${path}/events?after=0&conversationId=${initial.body.activeConversationId}`,
        { signal: secondController.signal },
      ),
    ]);
    const firstClient = observeEvents(firstResponse);
    const secondClient = observeEvents(secondResponse);
    const answer = firstClient.waitFor(
      (frame) => frame.type === "message" && frame.data.kind === "assistant",
    );
    await runner.request(path + "/input", "POST", {
      requestId: "branch-seed",
      message: "Write one concise greeting",
    });
    await answer;
    await secondClient.waitFor(
      (frame) => frame.type === "message" && frame.data.kind === "assistant",
    );
    const history = await runner.request(path + "/history?limit=100");
    const seedEntry = history.body.events.find(
      (event) => event.kind === "user",
    );
    assert.ok(seedEntry);
    const treeEvents = [];
    let treeCursor = 0;
    let treeHasMore = true;
    while (treeHasMore) {
      const page = await runner.request(
        `${path}/tree?after=${treeCursor}&limit=1`,
      );
      assert.equal(
        page.body.activeConversationId,
        initial.body.activeConversationId,
      );
      treeEvents.push(...page.body.events);
      treeHasMore = page.body.hasMore;
      if (treeHasMore) {
        assert.ok(page.body.nextAfter > treeCursor);
        treeCursor = page.body.nextAfter;
      }
    }
    assert.ok(treeEvents.some((event) => event.seq === seedEntry.seq));
    assert.equal(
      new Set(treeEvents.map((event) => event.seq)).size,
      treeEvents.length,
    );
    assert.equal(
      (
        await runner.request(path + "/tree", "POST", {
          entryId: Number.MAX_SAFE_INTEGER,
        })
      ).status,
      404,
    );

    const compact = await runner.request(path + "/compact", "POST", {
      instructions: "Retain the project decisions",
    });
    assert.equal(compact.status, 202);
    assert.ok(compact.body.taskId);

    const selected = await runner.request(path + "/tree", "POST", {
      entryId: seedEntry.seq,
    });
    assert.equal(selected.status, 200);
    assert.notEqual(
      selected.body.activeConversationId,
      initial.body.activeConversationId,
    );
    const staleStream = await fetch(
      `${runner.url}${path}/events?after=0&conversationId=${initial.body.activeConversationId}`,
    );
    assert.equal(staleStream.status, 409);
    assert.equal(
      (await staleStream.json()).error.code,
      "WORKSPACE_SESSION_CHANGED",
    );
    await Promise.all([firstClient.done, secondClient.done]);
    const current = await runner.request(path);
    assert.equal(
      current.body.conversationId,
      selected.body.activeConversationId,
    );
    const reconnectController = new AbortController();
    const reconnected = await fetch(
      `${runner.url}${path}/events?after=0&conversationId=${current.body.conversationId}`,
      { signal: reconnectController.signal },
    );
    const reconnectClient = observeEvents(reconnected);
    await reconnectClient.waitFor(
      (frame) => frame.type === "message" && frame.data.kind === "user",
    );
    reconnectController.abort();
    await reconnectClient.done;
    const branch = await runner.request(path + "/branches");
    assert.equal(
      branch.body.activeConversationId,
      selected.body.activeConversationId,
    );
    assert.equal(branch.body.branches.length, 2);
    const changed = await runner.request(path + "/settings", "PUT", {
      thinkingLevel: "high",
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.thinkingLevel, "high");
    const changedMax = await runner.request(path + "/settings", "PUT", {
      thinkingLevel: "max",
    });
    assert.equal(changedMax.status, 200);
    assert.equal(changedMax.body.thinkingLevel, "max");

    await runner.stop();
    runner = await runnerFor(directory);
    const restored = await runner.request(path + "/branches");
    assert.equal(restored.status, 200);
    assert.equal(
      restored.body.activeConversationId,
      selected.body.activeConversationId,
    );
    assert.equal(restored.body.branches.length, 2);
    const settings = await runner.request(path + "/settings");
    assert.equal(settings.body.thinkingLevel, "max");
    const selectedController = new AbortController();
    const selectedResponse = await fetch(
      `${runner.url}${path}/events?after=0&conversationId=${restored.body.activeConversationId}`,
      { signal: selectedController.signal },
    );
    const selectedClient = observeEvents(selectedResponse);
    const followup = selectedClient.waitFor(
      (frame) =>
        frame.type === "message" &&
        frame.data.kind === "assistant" &&
        frame.data.data.text.includes("Echo: Continue on the restored branch"),
    );
    await runner.request(path + "/input", "POST", {
      requestId: "restored-branch-followup",
      message: "Continue on the restored branch",
    });
    await followup;
    const selectedHistory = await runner.request(path + "/history?limit=100");
    assert.ok(
      selectedHistory.body.events.some(
        (event) => event.data.text === "Continue on the restored branch",
      ),
    );
    await selectedClient.waitFor(
      (frame) =>
        frame.type === "message" &&
        frame.data.kind === "assistant" &&
        frame.data.data.text.includes("Echo: Continue on the restored branch"),
    );
    selectedController.abort();
    await selectedClient.done;
    const resumed = await runner.request(path + "/branch", "PUT", {
      conversationId: initial.body.activeConversationId,
    });
    assert.equal(resumed.status, 200);
    assert.equal(
      resumed.body.activeConversationId,
      initial.body.activeConversationId,
    );
    const rootHistory = await runner.request(path + "/history?limit=100");
    assert.ok(
      rootHistory.body.events.every(
        (event) => event.data.text !== "Continue on the restored branch",
      ),
    );
    const reset = await runner.request(path + "/reset", "POST", {
      handoff: "Start a fresh model context",
    });
    assert.equal(reset.status, 202);
    assert.equal(
      reset.body.activeConversationId,
      initial.body.activeConversationId,
    );
    await runner.stop();
    runner = await runnerFor(directory);
    const afterReset = await runner.request(path + "/branches");
    assert.equal(
      afterReset.body.activeConversationId,
      initial.body.activeConversationId,
    );
    assert.equal(afterReset.body.branches.length, 2);
    const previousSession = await runner.request(path);

    const newSession = await runner.request(path + "/new", "POST", {});
    assert.equal(newSession.status, 200);
    assert.notEqual(
      newSession.body.activeConversationId,
      initial.body.activeConversationId,
    );
    const newBranches = await runner.request(path + "/branches");
    assert.equal(
      newBranches.body.activeConversationId,
      newSession.body.activeConversationId,
    );
    assert.deepEqual(
      (await runner.request(path)).body.tools,
      previousSession.body.tools,
    );
    assert.equal(newBranches.body.branches.length, 3);
    const newHistory = await runner.request(path + "/history?limit=100");
    assert.deepEqual(newHistory.body.events, []);
    const oldBranch = newBranches.body.branches.find(
      (branch) => branch.conversationId === initial.body.activeConversationId,
    );
    const createdBranch = newBranches.body.branches.find(
      (branch) =>
        branch.conversationId === newSession.body.activeConversationId,
    );
    assert.ok(oldBranch);
    assert.equal(
      createdBranch.parentConversationId,
      initial.body.activeConversationId,
    );
    assert.equal(createdBranch.forkEntryId, undefined);

    await runner.stop();
    runner = await runnerFor(directory);
    const persistedNewSession = await runner.request(path + "/branches");
    assert.equal(
      persistedNewSession.body.activeConversationId,
      newSession.body.activeConversationId,
    );
    assert.equal(persistedNewSession.body.branches.length, 3);
    assert.deepEqual(
      (await runner.request(path + "/history?limit=100")).body.events,
      [],
    );
    const persistedSessionInfo = persistedNewSession.body.branches.find(
      (branch) => branch.conversationId === newSession.body.activeConversationId,
    ).sessionInfo;
    assert.equal(persistedSessionInfo.id, `branch-demo:${newSession.body.activeConversationId}`);
    assert.equal(persistedSessionInfo.path, persistedSessionInfo.id);
    assert.equal(persistedSessionInfo.cwd, directory);
    assert.equal(persistedSessionInfo.messageCount, 0);
    assert.equal(persistedSessionInfo.firstMessage, "");
    assert.ok(Number.isFinite(Date.parse(persistedSessionInfo.created)));
    assert.ok(Number.isFinite(Date.parse(persistedSessionInfo.modified)));
    const persistedRootInfo = persistedNewSession.body.branches.find(
      (branch) => branch.conversationId === initial.body.activeConversationId,
    ).sessionInfo;
    assert.ok(persistedRootInfo.messageCount >= 2);
    assert.equal(persistedRootInfo.firstMessage, "Write one concise greeting");
    assert.match(persistedRootInfo.allMessagesText, /Write one concise greeting/);
    assert.match(persistedRootInfo.allMessagesText, /Echo: Write one concise greeting/);
    const newSessionStatus = await runner.request(path);
    assert.deepEqual(newSessionStatus.body.model, previousSession.body.model);
    assert.deepEqual(newSessionStatus.body.tools, previousSession.body.tools);
    const newSessionController = new AbortController();
    const newSessionResponse = await fetch(
      `${runner.url}${path}/events?after=0&conversationId=${newSession.body.activeConversationId}`,
      { signal: newSessionController.signal },
    );
    const newSessionClient = observeEvents(newSessionResponse);
    const newSessionTool = newSessionClient.waitFor(
      (frame) => frame.type === "message" && frame.data.kind === "tool",
    );
    const newSessionAnswer = newSessionClient.waitFor(
      (frame) =>
        frame.type === "message" &&
        frame.data.kind === "assistant" &&
        frame.data.data.text.includes("Synthetic task complete."),
    );
    const newTurn = await runner.request(path + "/input", "POST", {
      requestId: "new-session-turn",
      message:
        "/faux " +
        JSON.stringify({
          calls: [{ tool: "bash", args: { command: "printf fresh-session" } }],
          answer: "Synthetic task complete.",
        }),
    });
    assert.equal(newTurn.status, 202);
    const toolEvent = await newSessionTool;
    assert.equal(toolEvent.data.data.name, "bash");
    assert.equal(toolEvent.data.data.message.isError, false);
    await newSessionAnswer;
    newSessionController.abort();
    await newSessionClient.done;
    await runner.request(path + "/branch", "PUT", {
      conversationId: initial.body.activeConversationId,
    });
    assert.ok(
      (await runner.request(path + "/history?limit=100")).body.events.some(
        (event) =>
          event.kind === "user" &&
          event.data.text === "Write one concise greeting",
      ),
    );
  },
);

test(
  "Durable prompt input preserves validated pasted image content",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-terminal-image-"));
    const runner = await runnerFor(directory);
    t.after(() => runner.stop());
    const path = "/v1/workspaces/image-demo";
    const registered = await runner.request(path, "PUT", {
      id: "image-demo",
      name: "image demo",
      role: "coding",
      environment: "local",
      localRoot: directory,
      model: { provider: "faux", id: "faux-1" },
    });
    assert.equal(registered.status, 200);
    const image = {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=",
    };
    const submitted = await runner.request(path + "/input", "POST", {
      message: "What is in this picture?",
      requestId: "image-prompt-1",
      images: [image],
    });
    assert.equal(submitted.status, 202);
    const history = await runner.request(path + "/history?limit=100");
    const user = history.body.events.find((event) => event.kind === "user");
    assert.ok(user);
    assert.deepEqual(user.data.message.content, [
      { type: "text", text: "What is in this picture?" },
      image,
    ]);
    const mislabeled = await runner.request(path + "/input", "POST", {
      message: "mislabelled image",
      images: [{ ...image, mimeType: "image/webp" }],
    });
    assert.equal(mislabeled.status, 400);
    const largeImage = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(2_100_000),
    ]).toString("base64");
    const tooMuch = await runner.request(path + "/input", "POST", {
      message: "two images exceed the aggregate limit",
      images: [
        { type: "image", mimeType: "image/png", data: largeImage },
        { type: "image", mimeType: "image/png", data: largeImage },
      ],
    });
    assert.equal(tooMuch.status, 413);
  },
);

test(
  "native Pi messages import as a selected Durable conversation and survive runner restart",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-terminal-import-"));
    let runner = await runnerFor(directory);
    t.after(() => runner.stop());
    const path = "/v1/workspaces/import-demo";
    const registered = await runner.request(path, "PUT", {
      id: "import-demo",
      name: "import demo",
      role: "coding",
      environment: "local",
      localRoot: directory,
      model: { provider: "faux", id: "faux-1" },
    });
    assert.equal(registered.status, 200);
    const originalId = registered.body.conversationId;
    const imported = await runner.request(path + "/import", "POST", {
      session: { id: "native-session-1", cwd: "/tmp/original" },
      selectedLeafId: "selected-answer",
      entries: [
        {
          id: "source-question",
          parentId: null,
          message: {
            role: "user",
            content: "Imported question",
            timestamp: 10,
          },
        },
        {
          id: "source-answer",
          parentId: "source-question",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Source answer" }],
            api: "openai-responses",
            provider: "faux",
            model: "faux-1",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            stopReason: "stop",
            timestamp: 11,
          },
        },
        {
          id: "alternate-question",
          parentId: "source-question",
          message: {
            role: "user",
            content: "Alternate question",
            timestamp: 12,
          },
        },
        {
          id: "selected-question",
          parentId: "source-answer",
          message: {
            role: "user",
            content: "Selected follow-up",
            timestamp: 13,
          },
        },
        {
          id: "selected-answer",
          parentId: "selected-question",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Selected answer" }],
            api: "openai-responses",
            provider: "faux",
            model: "faux-1",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            stopReason: "stop",
            timestamp: 14,
          },
        },
      ],
    });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.notEqual(imported.body.activeConversationId, originalId);
    assert.equal(imported.body.importedMessages, 4);
    assert.equal(imported.body.importedBranches, 2);
    const invalidContent = await runner.request(path + "/import", "POST", {
      messages: [{ role: "user", content: [{ type: "toolCall", id: "fake" }] }],
    });
    assert.equal(invalidContent.status, 400);
    const danglingTool = await runner.request(path + "/import", "POST", {
      messages: [
        {
          role: "toolResult",
          toolCallId: "missing",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "no" }],
          timestamp: 12,
        },
      ],
    });
    assert.equal(danglingTool.status, 400);
    assert.equal(
      (await runner.request(path)).body.conversationId,
      imported.body.activeConversationId,
    );
    const navigation = await runner.request(path + "/branches");
    assert.equal(
      navigation.body.activeConversationId,
      imported.body.activeConversationId,
    );
    assert.equal(navigation.body.branches.length, 3);
    const history = await runner.request(path + "/history?limit=100");
    assert.deepEqual(
      history.body.events.map((event) => event.data.text),
      ["Imported question", "Source answer", "Selected follow-up", "Selected answer"],
    );
    const alternate = navigation.body.branches.at(-1).conversationId;
    const selectedAlternate = await runner.request(path + "/branch", "PUT", {
      conversationId: alternate,
    });
    assert.equal(selectedAlternate.status, 200);
    const alternateHistory = await runner.request(path + "/history?limit=100");
    assert.deepEqual(
      alternateHistory.body.events.map((event) => event.data.text),
      ["Imported question", "Alternate question"],
    );
    await runner.request(path + "/branch", "PUT", {
      conversationId: imported.body.activeConversationId,
    });
    await runner.stop();
    runner = await runnerFor(directory);
    const restored = await runner.request(path);
    assert.equal(
      restored.body.conversationId,
      imported.body.activeConversationId,
    );
    const restoredHistory = await runner.request(path + "/history?limit=100");
    assert.deepEqual(
      restoredHistory.body.events.map((event) => event.data.text),
      ["Imported question", "Source answer", "Selected follow-up", "Selected answer"],
    );
    const toolImport = await runner.request(path + "/import", "POST", {
      selectedLeafId: "tool-result",
      entries: [
        {
          id: "tool-call",
          parentId: null,
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "imported-call-1",
                name: "read",
                arguments: { path: "README.md" },
              },
            ],
            api: "openai-responses",
            provider: "faux",
            model: "faux-1",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            stopReason: "toolUse",
            timestamp: 13,
          },
        },
        {
          id: "tool-result",
          parentId: "tool-call",
          message: {
            role: "toolResult",
            toolCallId: "imported-call-1",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "Imported file output" }],
            timestamp: 14,
          },
        },
      ],
    });
    assert.equal(toolImport.status, 201, JSON.stringify(toolImport.body));
  },
);

test(
  "a root-owned loop delivers to its Durable owner while a new session is selected across restart",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-terminal-loop-owner-"));
    let runner = await runnerFor(directory);
    t.after(() => runner.stop());
    const path = "/v1/workspaces/loop-owner";
    const registered = await runner.request(path, "PUT", {
      id: "loop-owner",
      name: "loop owner",
      role: "coding",
      environment: "local",
      localRoot: directory,
      model: { provider: "faux", id: "faux-1" },
    });
    assert.equal(registered.status, 200);
    const rootId = registered.body.conversationId;
    const seedController = new AbortController();
    const seedResponse = await fetch(
      `${runner.url}${path}/events?after=0&conversationId=${rootId}`,
      { signal: seedController.signal },
    );
    const seedEvents = observeEvents(seedResponse);
    const seedAnswer = seedEvents.waitFor(
      (frame) =>
        frame.type === "message" &&
        frame.data.kind === "assistant" &&
        frame.data.data.text.includes("Echo: Seed the root conversation"),
    );
    await runner.request(path + "/input", "POST", {
      requestId: "loop-fork-seed",
      message: "Seed the root conversation",
    });
    await seedAnswer;
    seedController.abort();
    await seedEvents.done;
    const rootHistory = await runner.request(path + "/history?limit=100");
    const seed = rootHistory.body.events.find((event) => event.kind === "user");
    assert.ok(seed);
    const loopPrompt = "Deliver this occurrence to the root owner";
    const loop = await runner.request(path + "/loops", "POST", {
      prompt: loopPrompt,
      intervalMs: 60000,
      nextAt: Date.now() + 1500,
    });
    assert.equal(loop.status, 200);
    const fork = await runner.request(path + "/tree", "POST", {
      entryId: seed.seq,
    });
    assert.equal(fork.status, 200);
    assert.notEqual(fork.body.activeConversationId, rootId);

    await runner.stop();
    runner = await runnerFor(directory);
    assert.equal(
      (await runner.request(path)).body.conversationId,
      fork.body.activeConversationId,
    );
    const fresh = await runner.request(path + "/new", "POST", {});
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.body.activeConversationId, rootId);
    assert.notEqual(
      fresh.body.activeConversationId,
      fork.body.activeConversationId,
    );
    await runner.stop();
    runner = await runnerFor(directory);
    assert.equal(
      (await runner.request(path)).body.conversationId,
      fresh.body.activeConversationId,
    );

    await new Promise((resolve) => setTimeout(resolve, 3500));
    const selectRoot = await runner.request(path + "/branch", "PUT", {
      conversationId: rootId,
    });
    assert.equal(selectRoot.status, 200);
    const rootStatus = await runner.request(path);
    assert.ok(rootStatus.body.loops.some((entry) => entry.id === loop.body.id));
    const delivered = await runner.request(path + "/history?limit=100");
    assert.ok(
      delivered.body.events.some(
        (event) => event.kind === "user" && event.data.text === loopPrompt,
      ),
      "the scheduled prompt must reach its originating conversation after restart",
    );
    assert.ok(
      delivered.body.events.some(
        (event) =>
          event.kind === "assistant" &&
          event.data.text.includes(`Echo: ${loopPrompt}`),
      ),
      "the originating conversation must complete the scheduled turn",
    );
    await runner.request(path + "/branch", "PUT", {
      conversationId: fresh.body.activeConversationId,
    });
    assert.equal(
      (await runner.request(path)).body.conversationId,
      fresh.body.activeConversationId,
    );
    const childHistory = await runner.request(path + "/history?limit=100");
    assert.ok(
      childHistory.body.events.every(
        (event) => event.data?.text !== loopPrompt,
      ),
      "the scheduled prompt must never enter the selected child conversation",
    );
  },
);

test(
  "bot public SSE hides live model and tool output while diagnostics can inspect it",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-bot-terminal-stream-"));
    let runner = await runnerFor(directory, { defaultModel: false });
    t.after(() => runner.stop());
    const path = "/v1/workspaces/private-bot";
    const registered = await runner.request(path, "PUT", {
      id: "private-bot",
      name: "private bot",
      role: "bot",
      environment: "local",
    });
    assert.equal(registered.status, 200);

    const publicAbort = new AbortController();
    const diagnosticAbort = new AbortController();
    const publicResponse = await fetch(runner.url + path + "/events?after=0", {
      signal: publicAbort.signal,
    });
    const diagnosticResponse = await fetch(
      runner.url + path + "/events?after=0&diagnostics=true",
      { signal: diagnosticAbort.signal },
    );
    const publicEvents = observeEvents(publicResponse);
    const diagnosticEvents = observeEvents(diagnosticResponse);
    t.after(() => {
      publicAbort.abort();
      diagnosticAbort.abort();
    });

    const published = publicEvents.waitFor(
      (frame) =>
        frame.type === "message" &&
        frame.data.kind === "message" &&
        frame.data.data?.text,
    );
    const inspected = diagnosticEvents.waitFor(
      (frame) =>
        frame.type === "message" &&
        frame.data.kind === "assistant" &&
        frame.data.data?.text?.includes("I am ready for setup details."),
    );
    const selected = await runner.request(path + "/model", "PUT", {
      provider: "faux",
      modelId: "faux-1",
    });
    assert.equal(selected.status, 200);
    await published;
    await inspected;

    const publicFrames = JSON.stringify(publicEvents.frames);
    assert.match(
      publicFrames,
      /What identity and purpose would you like me to have/,
    );
    assert.doesNotMatch(publicFrames, /I am ready for setup details\./);
    assert.ok(
      publicEvents.frames.every(
        (frame) =>
          frame.type === "message" &&
          ["user", "message", "status"].includes(frame.data.kind),
      ),
    );
    const publicBranch = (await runner.request(path + "/branches")).body.branches[0];
    assert.match(publicBranch.sessionInfo.allMessagesText, /What identity and purpose would you like me to have/);
    assert.doesNotMatch(publicBranch.sessionInfo.allMessagesText, /I am ready for setup details\./);
    const diagnosticFrames = JSON.stringify(diagnosticEvents.frames);
    assert.match(diagnosticFrames, /I am ready for setup details\./);
    await diagnosticEvents.waitFor(
      (frame) => frame.type === "live" && frame.data.data.type === "run_end",
    );

    const nextRun = diagnosticEvents.waitForAfter(
      diagnosticEvents.frames.length,
      (frame) => frame.type === "live" && frame.data.data.type === "run_end",
    );
    await runner.request(path + "/input", "POST", {
      requestId: "save-profile",
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            {
              tool: "codemode",
              args: {
                code: 'await tools.saveProfile({identity:"Release reviewer",purpose:"Track build health"})',
              },
            },
          ],
          answer: "Private profile update complete.",
        }),
    });
    await nextRun;
    let botStatus = await runner.request(path);
    assert.equal(botStatus.body.profile.identity, "Release reviewer");
    assert.equal(botStatus.body.profile.purpose, "Track build health");
    const privateTool = (
      await runner.request(path + "/history?diagnostics=true&limit=100")
    ).body.events.findLast(
      (event) => event.kind === "tool" && event.data.name === "codemode",
    );
    assert.ok(privateTool);
    const forked = await runner.request(path + "/tree", "POST", {
      entryId: privateTool.seq,
    });
    assert.equal(forked.status, 200);
    await Promise.all([publicEvents.done, diagnosticEvents.done]);
    botStatus = await runner.request(path);
    assert.equal(
      botStatus.body.conversationId,
      forked.body.activeConversationId,
    );
    assert.equal(botStatus.body.profile.identity, "Release reviewer");
    assert.equal(botStatus.body.profile.purpose, "Track build health");

    await runner.stop();
    runner = await runnerFor(directory, { defaultModel: false });
    botStatus = await runner.request(path);
    assert.equal(
      botStatus.body.conversationId,
      forked.body.activeConversationId,
    );
    assert.equal(botStatus.body.profile.identity, "Release reviewer");
    assert.equal(botStatus.body.profile.purpose, "Track build health");
    assert.equal(
      (await runner.request(path + "/history?limit=100")).body.events.filter(
        (event) =>
          event.kind === "user" &&
          event.data.text.includes("ADM bot onboarding:"),
      ).length,
      1,
    );
    const savedProfile = botStatus.body.profile;
    const newBotSession = await runner.request(path + "/new", "POST", {});
    assert.equal(newBotSession.status, 200);
    assert.notEqual(
      newBotSession.body.activeConversationId,
      botStatus.body.conversationId,
    );
    botStatus = await runner.request(path);
    assert.equal(
      botStatus.body.conversationId,
      newBotSession.body.activeConversationId,
    );
    assert.deepEqual(botStatus.body.profile, savedProfile);
    assert.deepEqual(
      (await runner.request(path + "/history?limit=100")).body.events,
      [],
    );

    const publicController = new AbortController();
    const diagnosticController = new AbortController();
    const newPublicResponse = await fetch(
      `${runner.url}${path}/events?after=0&conversationId=${newBotSession.body.activeConversationId}`,
      { signal: publicController.signal },
    );
    const newDiagnosticResponse = await fetch(
      `${runner.url}${path}/events?after=0&conversationId=${newBotSession.body.activeConversationId}&diagnostics=true`,
      { signal: diagnosticController.signal },
    );
    const newPublicClient = observeEvents(newPublicResponse);
    const newDiagnosticClient = observeEvents(newDiagnosticResponse);
    const explicitMessage = newPublicClient.waitFor(
      (frame) =>
        frame.type === "message" &&
        frame.data.kind === "message" &&
        frame.data.data.text === "Explicit message survives a new session.",
    );
    const privateOutput = newDiagnosticClient.waitFor(
      (frame) =>
        frame.type === "message" &&
        frame.data.kind === "assistant" &&
        frame.data.data.text === "Private model output after new session.",
    );
    await runner.request(path + "/input", "POST", {
      requestId: "new-bot-session-visibility",
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            {
              tool: "sendMessage",
              args: { text: "Explicit message survives a new session." },
            },
          ],
          answer: "Private model output after new session.",
        }),
    });
    await Promise.all([explicitMessage, privateOutput]);
    assert.ok(
      newPublicClient.frames.every(
        (frame) =>
          frame.type === "message" &&
          !["assistant", "tool"].includes(frame.data.kind),
      ),
      "bot streams may publish explicit messages only",
    );
    assert.ok(
      newDiagnosticClient.frames.some(
        (frame) =>
          frame.type === "message" &&
          frame.data.kind === "assistant" &&
          frame.data.data.text === "Private model output after new session.",
      ),
    );
    publicController.abort();
    diagnosticController.abort();
    await Promise.all([newPublicClient.done, newDiagnosticClient.done]);

    await runner.stop();
    runner = await runnerFor(directory, { defaultModel: false });
    botStatus = await runner.request(path);
    assert.equal(
      botStatus.body.conversationId,
      newBotSession.body.activeConversationId,
    );
    assert.deepEqual(botStatus.body.profile, savedProfile);
    assert.equal(
      (await runner.request(path + "/history?limit=100")).body.events.filter(
        (event) =>
          event.kind === "user" &&
          event.data.text.includes("ADM bot onboarding:"),
      ).length,
      0,
    );
  },
);

test(
  "branch and thinking changes are rejected while Durable work is active",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-terminal-busy-controls-"),
    );
    const runner = await runnerFor(directory);
    t.after(() => runner.stop());
    const path = "/v1/workspaces/busy-controls";
    const registered = await runner.request(path, "PUT", {
      id: "busy-controls",
      name: "busy controls",
      role: "coding",
      environment: "local",
      localRoot: directory,
      model: { provider: "faux", id: "faux-1" },
    });
    assert.equal(registered.status, 200);
    const branch = await runner.request(path + "/branches");
    const controller = new AbortController();
    const response = await fetch(
      runner.url +
        path +
        `/events?after=0&conversationId=${branch.body.activeConversationId}`,
      { signal: controller.signal },
    );
    const events = observeEvents(response);
    const toolStarted = events.waitFor(
      (frame) =>
        frame.type === "live" &&
        frame.data.data.type === "tool_execution_start" &&
        frame.data.data.toolName === "bash",
    );
    const complete = events.waitFor(
      (frame) => frame.type === "live" && frame.data.data.type === "run_end",
    );
    await runner.request(path + "/input", "POST", {
      requestId: "hold-active-tool",
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            {
              tool: "bash",
              args: { command: "sleep 2; echo held" },
            },
          ],
          answer: "The command completed.",
        }),
    });
    await toolStarted;
    const userEntry = (
      await runner.request(path + "/history?limit=100")
    ).body.events.find((event) => event.kind === "user");
    assert.ok(userEntry);
    for (const response of [
      await runner.request(path + "/branch", "PUT", {
        conversationId: branch.body.activeConversationId,
      }),
      await runner.request(path + "/tree", "POST", { entryId: userEntry.seq }),
      await runner.request(path + "/settings", "PUT", {
        thinkingLevel: "high",
      }),
    ]) {
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "WORKSPACE_BUSY");
    }
    await complete;
    controller.abort();
    await events.done;
  },
);
