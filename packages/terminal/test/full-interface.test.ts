import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WorkspaceTerminal } from "../src/terminal.ts";
import { SettingsSelectorComponent } from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  stripTerminalSequences,
  TuiMainScreen,
} from "@earendil-works/pi-tui";

test("Pi command aliases open their Durable-backed controls and hotkey help", async () => {
  let stream: import("node:http").ServerResponse | undefined;
  let activeConversationId = 9;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/history")) {
      response.end(
        JSON.stringify({ events: [], nextAfter: 0, hasMore: false }),
      );
    } else if (url.pathname.endsWith("/models")) {
      response.end(
        JSON.stringify({
          selected: { provider: "faux", id: "faux-1" },
          providers: [],
          models: [{ provider: "faux", id: "faux-1", reasoning: true }],
        }),
      );
    } else if (url.pathname.endsWith("/settings")) {
      response.end(JSON.stringify({ thinkingLevel: "off" }));
    } else if (url.pathname.endsWith("/branches")) {
      response.end(
        JSON.stringify({
          activeConversationId,
          branches: [{ conversationId: 9 }, { conversationId: 10 }],
        }),
      );
    } else if (url.pathname.endsWith("/tree")) {
      response.end(
        JSON.stringify({
          activeConversationId,
          events: [
            {
              seq: 1,
              kind: "user",
              timestamp: new Date().toISOString(),
              data: {
                message: {
                  role: "user",
                  content: [{ type: "text", text: "hello" }],
                },
              },
            },
          ],
          nextAfter: 1,
          hasMore: false,
        }),
      );
    } else if (url.pathname.endsWith("/events")) {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": attached\n\n");
    } else if (url.pathname.endsWith("/new")) {
      activeConversationId = 10;
      response.end(
        JSON.stringify({
          activeConversationId,
          model: { provider: "faux", id: "faux-1" },
        }),
      );
    } else if (request.method === "GET") {
      response.end(
        JSON.stringify({
          id: "work",
          name: "demo",
          role: "coding",
          status: "idle",
        }),
      );
    } else {
      response.end(JSON.stringify({ status: "accepted" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const ui = new TuiMainScreen(new ProcessTerminal());
  const terminal = new WorkspaceTerminal({
    url: `http://127.0.0.1:${address.port}`,
    workspaceId: "work",
    tui: ui,
  });
  try {
    await terminal.connect();
    await terminal.submit("/thinking");
    assert.ok(
      (terminal as any).activeSelector,
      "/thinking should open the Pi selector",
    );
    terminal.handleInput("\x1b");

    await terminal.submit("/session");
    assert.match(
      stripTerminalSequences(terminal.render(100).join("\n")),
      /Workspace session 9/,
    );

    await terminal.submit("/fork");
    assert.ok(
      (terminal as any).activeSelector,
      "/fork should open the Durable tree selector",
    );
    terminal.handleInput("\x1b");

    await terminal.submit("/hotkeys");
    const rendered = stripTerminalSequences(terminal.render(100).join("\n"));
    assert.match(rendered, /Ctrl\+O/);
    assert.match(rendered, /Shift\+Tab/);

    await terminal.submit("/settings");
    const settingsWrapper = (terminal as any).activeSelector;
    assert.ok(settingsWrapper.children[0] instanceof SettingsSelectorComponent);
    const settingsText = stripTerminalSequences(
      terminal.render(100).join("\n"),
    );
    assert.match(settingsText, /Auto-compact/);
    terminal.handleInput("\r");
    assert.match(
      stripTerminalSequences(terminal.render(100).join("\n")),
      /Auto-compact is not configurable through adm attach/,
    );

    await terminal.submit("/new");
    assert.equal(activeConversationId, 10);
    assert.equal((terminal as any).cursor, 0);
    assert.equal((terminal as any).records.length, 0);
    assert.match(
      stripTerminalSequences(terminal.render(100).join("\n")),
      /New workspace session 10/,
    );
  } finally {
    terminal.close();
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Pi compact and retry controls call the Durable workspace operations", async () => {
  const requests: { method: string; path: string; body: string }[] = [];
  let stream: import("node:http").ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname.endsWith("/history")) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ events: [], nextAfter: 0, hasMore: false }),
      );
      return;
    }
    if (url.pathname.endsWith("/models")) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          selected: { provider: "faux", id: "faux-1" },
          providers: [],
          models: [],
        }),
      );
      return;
    }
    if (url.pathname.endsWith("/settings")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ thinkingLevel: "off" }));
      return;
    }
    if (url.pathname.endsWith("/events")) {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": attached\n\n");
      return;
    }
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "work",
          name: "demo",
          role: "coding",
          status: "idle",
        }),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method!, path: url.pathname, body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "accepted" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const ui = new TuiMainScreen(new ProcessTerminal());
  const terminal = new WorkspaceTerminal({
    url: `http://127.0.0.1:${address.port}`,
    workspaceId: "work",
    tui: ui,
  });
  try {
    await terminal.connect();
    await terminal.submit(
      "/compact Keep the implementation decisions and open risks",
    );
    await terminal.submit("/retry");
    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/v1/workspaces/work/compact",
        body: JSON.stringify({
          instructions: "Keep the implementation decisions and open risks",
        }),
      },
      { method: "POST", path: "/v1/workspaces/work/retry", body: "{}" },
    ]);
    assert.match(
      stripTerminalSequences(terminal.render(100).join("\n")),
      /retry/,
    );
  } finally {
    terminal.close();
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  "Pi rendering preserves thinking, provider usage, tool arguments and details",
  { timeout: 5000 },
  async () => {
    let stream: import("node:http").ServerResponse | undefined;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://localhost");
      if (url.pathname.endsWith("/history")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ events: [], nextAfter: 0, hasMore: false }),
        );
      } else if (url.pathname.endsWith("/models")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            selected: { provider: "faux", id: "faux-1" },
            providers: [],
            models: [],
          }),
        );
      } else if (url.pathname.endsWith("/settings")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ thinkingLevel: "off" }));
      } else if (url.pathname.endsWith("/events")) {
        stream = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": attached\n\n");
      } else if (request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "work",
            name: "demo",
            role: "coding",
            status: "idle",
          }),
        );
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "accepted" }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as import("node:net").AddressInfo;
    const ui = new TuiMainScreen(new ProcessTerminal());
    let terminal: WorkspaceTerminal | undefined;
    let rendered = "";
    let notify: () => void = () => {};
    terminal = new WorkspaceTerminal({
      url: `http://127.0.0.1:${address.port}`,
      workspaceId: "work",
      tui: ui,
      onRender() {
        if (!terminal) return;
        rendered = stripTerminalSequences(terminal.render(100).join("\n"));
        notify();
      },
    });
    try {
      await terminal.connect();
      const hasStructuredOutput = new Promise<void>((resolve) => {
        notify = () => {
          if (rendered.includes("plan detail") && rendered.includes("8 tokens"))
            resolve();
        };
      });
      stream!.write(
        `data: ${JSON.stringify({
          seq: 1,
          workspaceId: "work",
          kind: "assistant",
          timestamp: new Date().toISOString(),
          data: {
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "plan detail" },
                { type: "text", text: "answer" },
              ],
              api: "faux",
              provider: "faux",
              model: "faux-1",
              usage: {
                input: 5,
                output: 3,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 8,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
          },
        })}\n\n`,
      );
      await hasStructuredOutput;
      assert.match(rendered, /plan detail/);
      assert.match(rendered, /answer/);
      assert.match(rendered, /8 tokens/);
    } finally {
      terminal.close();
      stream?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "native Pi keybindings expand tool details and control thinking",
  { timeout: 5000 },
  async () => {
    let stream: import("node:http").ServerResponse | undefined;
    const settings: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://localhost");
      if (url.pathname.endsWith("/history")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ events: [], nextAfter: 0, hasMore: false }),
        );
      } else if (url.pathname.endsWith("/models")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            selected: { provider: "faux", id: "faux-1" },
            providers: [],
            models: [{ provider: "faux", id: "faux-1", reasoning: true }],
          }),
        );
      } else if (url.pathname.endsWith("/settings")) {
        if (request.method === "PUT") {
          let body = "";
          for await (const chunk of request) body += chunk;
          settings.push(JSON.parse(body).thinkingLevel);
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ thinkingLevel: settings.at(-1) ?? "off" }),
        );
      } else if (url.pathname.endsWith("/events")) {
        stream = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": attached\n\n");
      } else if (request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "work",
            name: "demo",
            role: "coding",
            status: "idle",
          }),
        );
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "accepted" }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as import("node:net").AddressInfo;
    const ui = new TuiMainScreen(new ProcessTerminal());
    let terminal: WorkspaceTerminal | undefined;
    let rendered = "";
    let notify = () => {};
    terminal = new WorkspaceTerminal({
      url: `http://127.0.0.1:${address.port}`,
      workspaceId: "work",
      tui: ui,
      onRender() {
        if (!terminal) return;
        rendered = stripTerminalSequences(terminal.render(80).join("\n"));
        notify();
      },
    });
    const waitFor = (label: string, predicate: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        if (predicate()) return resolve();
        const timeout = setTimeout(
          () =>
            reject(new Error(`Timed out waiting for ${label}: ${rendered}`)),
          1000,
        );
        notify = () => {
          if (predicate()) {
            clearTimeout(timeout);
            resolve();
          }
        };
      });
    try {
      await terminal.connect();
      stream!.write(
        `data: ${JSON.stringify({
          seq: 1,
          workspaceId: "work",
          kind: "assistant",
          timestamp: new Date().toISOString(),
          data: {
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "private plan" },
                { type: "text", text: "answer" },
              ],
              api: "faux",
              provider: "faux",
              model: "faux-1",
              usage: { totalTokens: 1 },
              stopReason: "stop",
            },
          },
        })}\n\n`,
      );
      stream!.write(
        `data: ${JSON.stringify({
          seq: 2,
          workspaceId: "work",
          kind: "tool",
          timestamp: new Date().toISOString(),
          data: {
            name: "future_tool",
            toolCallId: "tool-1",
            message: {
              role: "toolResult",
              toolCallId: "tool-1",
              toolName: "read",
              content: [
                {
                  type: "text",
                  text: `${"expanded detail line\n".repeat(40)}FINAL DETAIL`,
                },
              ],
              isError: false,
            },
          },
        })}\n\n`,
      );
      await waitFor(
        "assistant and tool output",
        () =>
          rendered.includes("private plan") && rendered.includes("future_tool"),
      );
      assert.equal((terminal as any).toolViews[0].expanded, false);
      terminal.handleInput("\x14");
      assert.match(rendered, /Thinking hidden/);
      terminal.handleInput("\x14");
      assert.match(rendered, /private plan/);
      terminal.handleInput("\x1b[Z");
      await waitFor("first thinking level", () => settings.length > 0);
      assert.deepEqual(settings, ["minimal"]);
      terminal.handleInput("\x1b[Z");
      await waitFor("second thinking level", () => settings.length > 1);
      assert.deepEqual(settings, ["minimal", "low"]);
      terminal.handleInput("\x0f");
      assert.equal((terminal as any).toolsExpanded, true);
      assert.equal((terminal as any).toolViews[0].expanded, true);
    } finally {
      terminal.close();
      stream?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "branch selection replays that conversation and reconnect does not duplicate it",
  { timeout: 5000 },
  async () => {
    let active = 2;
    let selectedResolve!: () => void;
    const selectedRoot = new Promise<void>((resolve) => {
      selectedResolve = resolve;
    });
    const streams: import("node:http").ServerResponse[] = [];
    const streamWaiters: { count: number; resolve: () => void }[] = [];
    const connectedWaiters: { count: number; resolve: () => void }[] = [];
    const waitForStreams = (count: number) =>
      streams.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
            streamWaiters.push({ count, resolve }),
          );
    const waitForTerminalConnection = (count: number) =>
      (terminal as any)?.connected && streams.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
            connectedWaiters.push({ count, resolve }),
          );
    const event = (seq: number, text: string) => ({
      seq,
      workspaceId: "work",
      kind: "user",
      timestamp: new Date().toISOString(),
      data: {
        text,
        message: {
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        },
      },
    });
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://localhost");
      if (url.pathname.endsWith("/history")) {
        response.setHeader("content-type", "application/json");
        const events =
          active === 1
            ? [event(1, "ROOT HISTORY MESSAGE")]
            : [event(7, "FORK HISTORY MESSAGE")];
        const after = Number(url.searchParams.get("after") ?? 0);
        const visible = events.filter((item) => item.seq > after);
        response.end(
          JSON.stringify({
            events: visible,
            nextAfter: visible.at(-1)?.seq ?? after,
            hasMore: false,
          }),
        );
      } else if (url.pathname.endsWith("/branches")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            activeConversationId: active,
            branches: [
              { conversationId: 1 },
              { conversationId: 2, parentConversationId: 1, forkEntryId: 1 },
            ],
          }),
        );
      } else if (url.pathname.endsWith("/models")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            selected: { provider: "faux", id: "faux-1" },
            providers: [],
            models: [],
          }),
        );
      } else if (url.pathname.endsWith("/settings")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ thinkingLevel: "off" }));
      } else if (url.pathname.endsWith("/events")) {
        streams.push(response);
        for (const waiter of streamWaiters.filter(
          (item) => streams.length >= item.count,
        ))
          waiter.resolve();
        for (let index = streamWaiters.length - 1; index >= 0; index--)
          if (streams.length >= streamWaiters[index]!.count)
            streamWaiters.splice(index, 1);
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const waiter of connectedWaiters.filter(
          (item) => streams.length >= item.count,
        ))
          waiter.resolve();
        for (let index = connectedWaiters.length - 1; index >= 0; index--)
          if (streams.length >= connectedWaiters[index]!.count)
            connectedWaiters.splice(index, 1);
        response.write(": attached\n\n");
      } else if (url.pathname.endsWith("/branch") && request.method === "PUT") {
        let body = "";
        for await (const chunk of request) body += chunk;
        active = JSON.parse(body).conversationId;
        if (active === 1) selectedResolve();
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            activeConversationId: active,
            model: { provider: "faux", id: "faux-1" },
          }),
        );
      } else if (request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "work",
            name: "demo",
            role: "coding",
            status: "idle",
          }),
        );
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "accepted" }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as import("node:net").AddressInfo;
    const ui = new TuiMainScreen(new ProcessTerminal());
    let terminal: WorkspaceTerminal | undefined;
    let rendered = "";
    let waitText = "";
    let waitBranch: number | undefined;
    let waitResolve: (() => void) | undefined;
    const whenRendered = (text: string, branch?: number) =>
      new Promise<void>((resolve) => {
        waitText = text;
        waitBranch = branch;
        waitResolve = resolve;
      });
    terminal = new WorkspaceTerminal({
      url: `http://127.0.0.1:${address.port}`,
      workspaceId: "work",
      tui: ui,
      onRender() {
        if (terminal) {
          rendered = stripTerminalSequences(terminal.render(100).join("\n"));
          if (
            waitResolve &&
            rendered.includes(waitText) &&
            (waitBranch === undefined || active === waitBranch)
          ) {
            const resolve = waitResolve;
            waitResolve = undefined;
            resolve();
          }
          for (let index = connectedWaiters.length - 1; index >= 0; index--)
            if (
              (terminal as any).connected &&
              streams.length >= connectedWaiters[index]!.count
            ) {
              connectedWaiters[index]!.resolve();
              connectedWaiters.splice(index, 1);
            }
        }
      },
    });
    try {
      await terminal.connect();
      assert.match(rendered, /FORK HISTORY MESSAGE/);
      await terminal.submit("/resume");
      terminal.handleInput("\x1b[A");
      assert.equal((terminal as any).activeSelector.selectedIndex, 0);
      const rootVisible = whenRendered("ROOT HISTORY MESSAGE", 1);
      const firstBranchStream = waitForStreams(2);
      terminal.handleInput("\r");
      await selectedRoot;
      await rootVisible;
      await firstBranchStream;
      await waitForTerminalConnection(2);
      assert.equal(active, 1);
      assert.match(rendered, /ROOT HISTORY MESSAGE/);
      assert.doesNotMatch(rendered, /FORK HISTORY MESSAGE/);
      const reconnectedStream = waitForStreams(3);
      await terminal.connect();
      await reconnectedStream;
      await waitForTerminalConnection(3);
      assert.equal((rendered.match(/ROOT HISTORY MESSAGE/g) ?? []).length, 1);
      await terminal.submit("/resume");
      terminal.handleInput("\x1b[B");
      const forkVisible = whenRendered("FORK HISTORY MESSAGE", 2);
      const secondBranchStream = waitForStreams(4);
      terminal.handleInput("\r");
      await forkVisible;
      await secondBranchStream;
      await waitForTerminalConnection(4);
      assert.equal(active, 2);
      assert.equal((rendered.match(/FORK HISTORY MESSAGE/g) ?? []).length, 1);
    } finally {
      terminal.close();
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
