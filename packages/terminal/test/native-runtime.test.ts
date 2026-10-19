import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { WorkspaceTerminal } from "../src/terminal.ts";
import { DurableInteractiveRuntime } from "../src/native-runtime.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

test("upstream session projection sends prompts to Durable and replays streamed events", async () => {
  let stream: import("node:http").ServerResponse | undefined;
  let accepted: unknown;
  let trustUpdates: unknown;
  let bashRequest: unknown;
  let savedQueue = { steering: ["steer me"], followUp: ["then do this"] };
  const savedSettings = {
    thinkingLevel: "off",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompact: true,
    scopedModels: ["faux/faux-1"],
    cacheWarmingMode: "idle",
    sessionName: "saved name",
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/bash/operation-1/events")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: output\ndata: ${JSON.stringify({ operationId: "operation-1", text: "hello ", stream: "stdout" })}\n\n`,
      );
      response.write(
        `event: output\ndata: ${JSON.stringify({ operationId: "operation-1", text: "world", stream: "stdout" })}\n\n`,
      );
      response.end(
        `event: result\ndata: ${JSON.stringify({ role: "bashExecution", command: "printf hello", output: "hello world", exitCode: 0, cancelled: false, truncated: false, operationId: "operation-1" })}\n\n`,
      );
    } else if (url.pathname.endsWith("/bash")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      bashRequest = JSON.parse(body);
      response.writeHead(202);
      response.end(JSON.stringify({ operationId: "operation-1" }));
    } else if (url.pathname.endsWith("/events")) {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": attached\n\n");
    } else if (url.pathname.endsWith("/history")) {
      response.end(
        JSON.stringify({
          events: [
            {
              seq: 1,
              workspaceId: "work",
              kind: "message",
              timestamp: Date.now(),
              data: {
                message: {
                  role: "bashExecution",
                  command: "printf history",
                  output: "history output",
                  exitCode: 0,
                  cancelled: false,
                  truncated: false,
                  timestamp: Date.now(),
                },
              },
            },
          ],
          nextAfter: 1,
          hasMore: false,
          activeConversationId: 12,
        }),
      );
    } else if (url.pathname.endsWith("/models")) {
      response.end(
        JSON.stringify({
          selected: { provider: "faux", id: "faux-1" },
          providers: [],
          models: [
            {
              provider: "faux",
              id: "faux-1",
              name: "Faux",
              api: "openai-completions",
              baseUrl: "https://models.invalid",
              input: ["text"],
              cost: { input: 0, output: 0 },
              reasoning: true,
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        }),
      );
    } else if (url.pathname.endsWith("/settings")) {
      if (request.method === "PUT") {
        let body = "";
        for await (const chunk of request) body += chunk;
        Object.assign(savedSettings, JSON.parse(body));
      }
      response.end(JSON.stringify(savedSettings));
    } else if (url.pathname.endsWith("/queue/clear")) {
      savedQueue = { steering: [], followUp: [] };
      response.end(JSON.stringify(savedQueue));
    } else if (url.pathname.endsWith("/queue")) {
      response.end(JSON.stringify(savedQueue));
    } else if (url.pathname.endsWith("/tools")) {
      response.end(JSON.stringify({ tools: [], activeToolNames: [] }));
    } else if (url.pathname.endsWith("/resources")) {
      response.end(
        JSON.stringify({
          cwd: "/repos/demo",
          trust: { trusted: true, trustRequired: false, source: null },
          themes: [],
          prompts: [],
          skills: [],
          agentsFiles: [],
          extensions: [],
          diagnostics: [],
          appendSystemPrompt: [],
        }),
      );
    } else if (url.pathname.endsWith("/extensions")) {
      response.end(JSON.stringify({ extensions: [], diagnostics: [] }));
    } else if (url.pathname.endsWith("/trust")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      trustUpdates = JSON.parse(body);
      response.end(
        JSON.stringify({
          cwd: "/repos/demo",
          trust: { trusted: false, trustRequired: true, source: "/repos" },
          themes: [],
          prompts: [],
          skills: [],
          agentsFiles: [],
          extensions: [],
          diagnostics: [],
          appendSystemPrompt: [],
        }),
      );
    } else if (url.pathname.endsWith("/resources/reload")) {
      response.end(
        JSON.stringify({
          cwd: "/repos/demo",
          trust: { trusted: true, trustRequired: false, source: null },
          themes: [],
          prompts: [],
          skills: [],
          agentsFiles: [],
          extensions: [],
          diagnostics: [],
          appendSystemPrompt: [],
        }),
      );
    } else if (url.pathname.endsWith("/branches")) {
      response.end(
        JSON.stringify({
          activeConversationId: 12,
          branches: [
            {
              conversationId: 12,
              sessionInfo: {
                id: "work:12",
                path: "work:12",
                cwd: "/repos/demo",
                created: "2026-10-18T12:00:00.000Z",
                modified: "2026-10-18T12:01:00.000Z",
                messageCount: 2,
                firstMessage: "hello",
                allMessagesText: "hello world",
              },
            },
          ],
        }),
      );
    } else if (url.pathname.endsWith("/input")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      accepted = JSON.parse(body);
      response.writeHead(202);
      response.end(JSON.stringify({ submissionId: 44, status: "admitted" }));
    } else if (request.method === "GET") {
      response.end(
        JSON.stringify({
          id: "work",
          name: "workspace",
          role: "coding",
          status: "idle",
          cwd: "/repos/demo",
          conversationId: 12,
        }),
      );
    } else {
      response.end(JSON.stringify({ status: "accepted" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const transport = new WorkspaceTerminal({
    url: `http://127.0.0.1:${address.port}`,
    workspaceId: "work",
  });
  const remote = new DurableInteractiveRuntime(transport);
  try {
    await transport.connect();
    assert.equal(
      transport.getRemoteSnapshot().connected,
      true,
      transport.getRemoteSnapshot().status,
    );
    await remote.initialize();
    assert.equal(remote.session.sessionManager.getCwd(), "/repos/demo");
    assert.equal(remote.session.sessionName, "saved name");
    assert.deepEqual(remote.session.getSteeringMessages(), ["steer me"]);
    assert.deepEqual(remote.session.getFollowUpMessages(), ["then do this"]);
    assert.deepEqual(
      remote.session.scopedModels.map(
        ({ model }) => `${model.provider}/${model.id}`,
      ),
      ["faux/faux-1"],
    );
    assert.equal(remote.session.model?.provider, "faux");
    assert.ok(
      remote.session.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "message" && entry.message.role === "bashExecution",
        ),
      "Durable history preserves Pi bash execution messages",
    );
    assert.equal(remote.session.steeringMode, "one-at-a-time");
    assert.equal(remote.session.followUpMode, "one-at-a-time");
    assert.equal(remote.session.autoCompactionEnabled, true);
    await remote.session.setSteeringMode("all");
    await remote.session.setFollowUpMode("all");
    await remote.session.setAutoCompactionEnabled(false);
    await remote.session.setScopedModels([]);
    await remote.session.setCacheWarmingMode("streaming");
    await remote.session.setSessionName("new name");
    assert.deepEqual(await remote.session.clearQueue(), {
      steering: [],
      followUp: [],
    });
    assert.deepEqual(savedSettings.scopedModels, []);
    assert.equal(savedSettings.cacheWarmingMode, "streaming");
    assert.equal(savedSettings.sessionName, "new name");
    assert.equal(remote.session.steeringMode, "all");
    assert.equal(remote.session.followUpMode, "all");
    assert.equal(remote.session.autoCompactionEnabled, false);
    assert.equal(remote.session.sessionManager.getSessionFile(), undefined);
    assert.equal(remote.session.resourceLoader.getSkills().skills.length, 0);
    const sessions = await remote.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.path, "work:12");
    assert.ok(sessions[0]?.created instanceof Date);
    assert.equal(remote.remotePorts.projectTrust.get("/repos/demo"), true);
    await remote.remotePorts.projectTrust.setMany([
      { path: "/repos", decision: false },
      { path: "/repos/demo", decision: null },
    ]);
    assert.deepEqual(trustUpdates, {
      updates: [
        { path: "/repos", decision: false },
        { path: "/repos/demo", decision: null },
      ],
    });
    assert.equal(remote.remotePorts.projectTrust.get("/repos/demo"), false);
    await remote.session.resourceLoader.reload();
    assert.equal(remote.remotePorts.projectTrust.get("/repos/demo"), true);
    await remote.session.prompt("continue from the existing workspace");
    assert.equal(
      (accepted as { message: string }).message,
      "continue from the existing workspace",
    );
    assert.equal(
      typeof (accepted as { requestId: string }).requestId,
      "string",
    );

    const outputChunks: string[] = [];
    const bashResult = await remote.session.executeBash(
      "printf hello",
      (chunk: string) => outputChunks.push(chunk),
      { excludeFromContext: true, id: "bash-request-1" },
    );
    assert.deepEqual(outputChunks, ["hello ", "world"]);
    assert.deepEqual(bashRequest, {
      command: "printf hello",
      requestId: "bash-request-1",
      excludeFromContext: true,
    });
    assert.deepEqual(bashResult, {
      output: "hello world",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    });

    const observed: string[] = [];
    let resolveEvents!: () => void;
    const gotEvents = new Promise<void>((resolve) => {
      resolveEvents = resolve;
    });
    const unsubscribe = remote.session.subscribe((event: AgentSessionEvent) => {
      observed.push(event.type);
      if (
        observed.includes("message_start") &&
        observed.includes("message_update")
      )
        resolveEvents();
    });
    stream!.write(
      `event: live\ndata: ${JSON.stringify({
        workspaceId: "work",
        kind: "live",
        timestamp: Date.now(),
        data: {
          type: "message_start",
          message: { role: "assistant", content: [] },
        },
      })}\n\n`,
    );
    stream!.write(
      `event: live\ndata: ${JSON.stringify({
        workspaceId: "work",
        kind: "live",
        timestamp: Date.now(),
        data: {
          type: "message_update",
          changes: [
            {
              type: "text_start",
              contentIndex: 0,
              block: { type: "text", text: "" },
            },
          ],
        },
      })}\n\n`,
    );
    await gotEvents;
    assert.ok(observed.includes("message_start"));
    assert.ok(observed.includes("message_update"));
    unsubscribe();
  } finally {
    remote.dispose();
    transport.close();
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pinned upstream InteractiveMode starts over the Durable workspace projection and renders live tool ends", async () => {
  const projectRoot = process.cwd();
  const stagedPi = join(
    projectRoot,
    "target/todo-20261018-task-54/native-ui/node_modules/@earendil-works/pi-coding-agent",
  );
  await mkdir(dirname(stagedPi), { recursive: true });
  await cp(
    join(projectRoot, "node_modules/@earendil-works/pi-coding-agent"),
    stagedPi,
    { recursive: true, force: true },
  );
  process.argv[2] = stagedPi;
  await import(
    pathToFileURL(join(projectRoot, "scripts/patch-pi-interactive.mjs")).href
  );
  const patchedInteractiveMode = await readFile(
    join(stagedPi, "dist/modes/interactive/interactive-mode.js"),
    "utf8",
  );
  assert.doesNotMatch(
    patchedInteractiveMode,
    /this\.settingsManager\.isProjectTrusted\(\)/,
    "remote trust checks must never read the client's Pi settings",
  );
  const { InteractiveMode } = await import(
    pathToFileURL(join(stagedPi, "dist/index.js")).href
  );
  let stream: import("node:http").ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/events")) {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": attached\n\n");
    } else if (url.pathname.endsWith("/history")) {
      response.end(
        JSON.stringify({
          events: [],
          nextAfter: 0,
          hasMore: false,
          activeConversationId: 12,
        }),
      );
    } else if (url.pathname.endsWith("/models")) {
      response.end(
        JSON.stringify({
          selected: { provider: "faux", id: "faux-1" },
          providers: [],
          models: [
            {
              provider: "faux",
              id: "faux-1",
              name: "Faux Model",
              api: "openai-completions",
              baseUrl: "https://models.invalid",
              input: ["text"],
              cost: { input: 0, output: 0 },
              reasoning: true,
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        }),
      );
    } else if (url.pathname.endsWith("/settings")) {
      response.end(JSON.stringify({ thinkingLevel: "off" }));
    } else if (url.pathname.endsWith("/queue")) {
      response.end(JSON.stringify({ steering: [], followUp: [] }));
    } else if (url.pathname.endsWith("/extensions")) {
      response.end(JSON.stringify({ extensions: [], diagnostics: [] }));
    } else if (url.pathname.endsWith("/tools")) {
      response.end(JSON.stringify({ tools: [], activeToolNames: [] }));
    } else if (url.pathname.endsWith("/resources")) {
      response.end(
        JSON.stringify({
          cwd: "/repos/demo",
          trust: { trusted: true, trustRequired: false, source: null },
          themes: [],
          prompts: [],
          skills: [],
          agentsFiles: [],
          extensions: [],
          diagnostics: [],
          appendSystemPrompt: [],
        }),
      );
    } else if (url.pathname.endsWith("/input")) {
      response.writeHead(202);
      response.end(JSON.stringify({ submissionId: 45, status: "admitted" }));
    } else {
      response.end(
        JSON.stringify({
          id: "work",
          name: "demo",
          role: "coding",
          status: "idle",
          cwd: "/repos/demo",
          conversationId: 12,
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const terminal = new CapturingTerminal();
  const transport = new WorkspaceTerminal({
    url: `http://127.0.0.1:${address.port}`,
    workspaceId: "work",
  });
  const remote = new DurableInteractiveRuntime(transport);
  try {
    await transport.connect();
    await remote.initialize();
    const mode = new InteractiveMode(remote, { terminal });
    await mode.init();
    const screen = stripTerminalSequences(terminal.output);
    assert.match(screen, /v1\.2\.0/);
    assert.match(screen, /faux-1/);
    assert.match(screen, /\/repos\/demo/);
    assert.match(screen, /bash/);
    assert.equal(remote.session.sessionManager.getSessionFile(), undefined);
    assert.ok(
      terminal.input,
      "InteractiveMode must register the editor input handler",
    );

    // Durable ends a model-issued call with its toolResult entry, a nested
    // Code Mode call with its result, and an orphaned call with neither.
    const piEnds: AgentSessionEvent[] = [];
    const unsubscribe = remote.session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "tool_execution_end") piEnds.push(event);
    });
    const live = (data: object) =>
      stream!.write(
        `event: live\ndata: ${JSON.stringify({ workspaceId: "work", kind: "live", data })}\n\n`,
      );
    live({
      type: "tool_execution_start",
      toolCallId: "call-code",
      toolName: "codemode",
      args: { code: "await tools.read({ path: 'notes.md' })" },
    });
    live({
      type: "tool_execution_start",
      toolCallId: "call-code/1",
      toolName: "read",
      parentToolCallId: "call-code",
      args: { path: "notes.md" },
    });
    live({
      type: "tool_execution_end",
      toolCallId: "call-code/1",
      toolName: "read",
      parentToolCallId: "call-code",
      result: {
        taskId: 31,
        structuredOutput: "nested notes contents",
        isError: false,
        diagnostics: [],
        durationMs: 4,
      },
    });
    live({
      type: "tool_execution_end",
      toolCallId: "call-code",
      toolName: "codemode",
      entry: {
        id: 32,
        conversationId: 12,
        kind: "pi.toolResult",
        model: [
          {
            role: "toolResult",
            toolCallId: "call-code",
            toolName: "codemode",
            content: [{ type: "text", text: "codemode returned notes" }],
            isError: false,
            timestamp: Date.now(),
            durationMs: 9,
          },
        ],
      },
    });
    live({
      type: "tool_execution_start",
      toolCallId: "call-lost",
      toolName: "bash",
      args: { command: "sleep 600" },
    });
    live({
      type: "tool_execution_end",
      toolCallId: "call-lost",
      toolName: "bash",
    });
    await terminal.waitFor("orphaned");
    unsubscribe();
    assert.deepEqual(
      piEnds.map((event) => event.type === "tool_execution_end" && event),
      [
        {
          type: "tool_execution_end",
          toolCallId: "call-code/1",
          toolName: "read",
          parentToolCallId: "call-code",
          result: {
            content: [{ type: "text", text: "nested notes contents" }],
            details: undefined,
          },
          isError: false,
          durationMs: 4,
        },
        {
          type: "tool_execution_end",
          toolCallId: "call-code",
          toolName: "codemode",
          result: {
            content: [{ type: "text", text: "codemode returned notes" }],
            details: undefined,
          },
          isError: false,
          durationMs: 9,
        },
        {
          type: "tool_execution_end",
          toolCallId: "call-lost",
          toolName: "bash",
          result: {
            content: [
              {
                type: "text",
                text: "Tool call ended without a result: its task faulted or was orphaned, or its run ended first.",
              },
            ],
          },
          isError: true,
        },
      ],
    );
    const tools = stripTerminalSequences(terminal.output).replace(/\s+/g, " ");
    assert.match(tools, /codemode returned notes/);
    assert.match(tools, /sleep 600/);
    assert.match(tools, /its task faulted or was orphaned/);
  } finally {
    await remote.dispose();
    transport.close();
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

class CapturingTerminal implements Terminal {
  output = "";
  input?: (data: string) => void;
  private writes = new Set<() => void>();
  start(input: (data: string) => void) {
    this.input = input;
  }
  stop() {}
  async drainInput() {}
  write(data: string) {
    this.output += data;
    for (const check of this.writes) check();
  }
  waitFor(text: string) {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (
          stripTerminalSequences(this.output)
            .replace(/\s+/g, " ")
            .includes(text)
        ) {
          this.writes.delete(check);
          resolve();
        }
      };
      this.writes.add(check);
      check();
    });
  }
  get columns() {
    return 100;
  }
  get rows() {
    return 30;
  }
  get kittyProtocolActive() {
    return false;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}
