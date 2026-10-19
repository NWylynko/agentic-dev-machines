import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  watch,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceTerminal, type WorkspaceEvent } from "../src/terminal.ts";
import {
  ProcessTerminal,
  stripTerminalSequences,
  TuiMainScreen,
} from "@earendil-works/pi-tui";

function terminalText(terminal: WorkspaceTerminal) {
  return stripTerminalSequences(terminal.render(100).join("\n"));
}
function visibleTerminalText(text: string) {
  return stripTerminalSequences(text).replace(/\s+/g, " ");
}
function stopProcessGroup(child: { pid?: number }) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
async function fixture(
  role = "coding",
  events: any[] = [],
  {
    needsModel = false,
    holdRefresh = false,
  }: { needsModel?: boolean; holdRefresh?: boolean } = {},
) {
  const requests: any[] = [];
  let stream: any;
  let refreshStartedResolve = () => {};
  let refreshClosedResolve = () => {};
  const refreshStarted = new Promise<void>((resolve) => {
    refreshStartedResolve = resolve;
  });
  const refreshClosed = new Promise<void>((resolve) => {
    refreshClosedResolve = resolve;
  });
  let admissionResolve: (value: any) => void = () => {};
  const admission = () =>
    new Promise<any>((resolve) => (admissionResolve = resolve));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname.endsWith("/history")) {
      const found = events.filter(
        (e) => e.seq > Number(url.searchParams.get("after") || 0),
      );
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          events: found,
          nextAfter: found.at(-1)?.seq || 0,
          hasMore: false,
          activeConversationId: 12,
        }),
      );
    } else if (url.pathname.endsWith("/settings")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          thinkingLevel: "off",
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          autoCompact: true,
        }),
      );
    } else if (url.pathname.endsWith("/queue/clear")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ steering: [], followUp: [] }));
    } else if (url.pathname.endsWith("/queue")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ steering: [], followUp: [] }));
    } else if (url.pathname.endsWith("/tools")) {
      res.end(JSON.stringify({ tools: [], activeToolNames: [] }));
    } else if (url.pathname.endsWith("/resources")) {
      res.setHeader("content-type", "application/json");
      res.end(
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
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ extensions: [], diagnostics: [] }));
    } else if (url.pathname.endsWith("/models")) {
      if (url.searchParams.get("refresh") === "true") {
        refreshStartedResolve();
        if (holdRefresh) {
          res.once("close", refreshClosedResolve);
          return;
        }
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          selected: needsModel ? undefined : { provider: "faux", id: "faux-1" },
          providers: [{ id: "faux", name: "Faux", authenticated: true }],
          models: [
            {
              provider: "faux",
              id: "faux-1",
              name: "Faux 1",
              api: "faux",
              contextWindow: 4096,
              maxTokens: 1024,
              reasoning: false,
              input: ["text"],
            },
          ],
        }),
      );
    } else if (url.pathname.endsWith("/events")) {
      stream = res;
      requests.push({
        method: req.method,
        path: url.pathname,
        after: url.searchParams.get("after"),
        diagnostics: url.searchParams.get("diagnostics"),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": attached\n\n");
    } else if (req.method === "GET") {
      res.end(
        JSON.stringify({
          id: "work",
          name: "demo",
          role,
          cwd: "/repos/demo",
          conversationId: 12,
          status: "idle",
          goals: [],
          loops: [],
        }),
      );
    } else {
      let body = "";
      for await (const chunk of req) body += chunk;
      const item = {
        method: req.method,
        path: url.pathname,
        body: body ? JSON.parse(body) : {},
      };
      requests.push(item);
      admissionResolve(item);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          url.pathname.endsWith("/model")
            ? {
                selected: {
                  provider: item.body.provider,
                  id: item.body.modelId,
                },
              }
            : { submissionId: "submission", status: "accepted" },
        ),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as any;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    admission,
    refreshStarted,
    refreshClosed,
    push(event: any) {
      stream.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    disconnect() {
      stream.end();
    },
    async close() {
      stream?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const event = (seq: number, kind: string, text: string) => ({
  seq,
  workspaceId: "work",
  kind,
  data: { text },
  timestamp: Date.now(),
});

test(
  "native adm attach PTY starts Pi and submits editor text to the existing Durable conversation",
  { timeout: 20000 },
  async (t) => {
    const service = await fixture("coding", [], { holdRefresh: true });
    const args = [
      process.execPath,
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "--url",
      service.url,
      "--workspace",
      "work",
    ];
    const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
    const child = spawn(
      "script",
      [
        "--quiet",
        "--return",
        "--command",
        args.map(quote).join(" "),
        "/dev/null",
      ],
      { stdio: ["pipe", "pipe", "pipe"], detached: true },
    );
    t.after(() => stopProcessGroup(child));
    let output = "";
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          child.stdout.on("data", (chunk) => {
            output += chunk;
            if (stripTerminalSequences(output).includes("/repos/demo"))
              resolve();
          });
          child.stderr.on("data", (chunk) => (output += chunk));
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(new Error(`Native TUI exited (${code}): ${output}`)),
          );
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Native TUI startup timed out: ${output}`)),
            5000,
          ),
        ),
      ]);
      await Promise.race([
        service.refreshStarted,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Pi InteractiveMode did not finish startup: ${output}`,
                ),
              ),
            5000,
          ),
        ),
      ]);
      const accepted = service.admission();
      const prompt = "Continue the existing workspace conversation";
      child.stdin.write(`\x1b[200~${prompt}\x1b[201~`);
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const check = () => {
            if (visibleTerminalText(output).includes(prompt)) resolve();
          };
          child.stdout.on("data", (chunk) => {
            output += chunk;
            check();
          });
          check();
          child.once("exit", (code) =>
            reject(
              new Error(
                `Native TUI exited before editor accepted paste (${code}): ${output}`,
              ),
            ),
          );
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`Editor did not render pasted prompt: ${output}`),
              ),
            5000,
          ),
        ),
      ]);
      child.stdin.write("\r");
      const request = await Promise.race([
        accepted,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`Native prompt was not admitted: ${output}`)),
            5000,
          ),
        ),
      ]);
      assert.equal(request.path.endsWith("/input"), true);
      assert.equal(request.body.message, prompt);
      const exited = once(child, "exit");
      child.stdin.write("\x04");
      assert.equal((await exited)[0], 0, output);
    } finally {
      stopProcessGroup(child);
      await service.close();
    }
  },
);
function changedTerminal(
  url: string,
  diagnostics = false,
  readClipboardImage?: () => Promise<
    { bytes: Uint8Array; mimeType: string } | undefined
  >,
) {
  let notify: () => void = () => {};
  const ui = new TuiMainScreen(new ProcessTerminal());
  const terminal = new WorkspaceTerminal({
    url,
    workspaceId: "work",
    diagnostics,
    readClipboardImage,
    tui: ui,
    onRender() {
      notify();
    },
  });
  const waitFor = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const visibleText = () => visibleTerminalText(terminalText(terminal));
      if (visibleText().includes(text)) {
        resolve();
        return;
      }
      const deadline = setTimeout(
        () =>
          reject(new Error(`Timed out waiting for ${text}: ${visibleText()}`)),
        3000,
      );
      notify = () => {
        if (visibleText().includes(text)) {
          clearTimeout(deadline);
          resolve();
        }
      };
    });
  return { terminal, waitFor };
}

test("Pi terminal formats assistant Markdown and identifies named tool failures", async () => {
  const service = await fixture("coding", [
    {
      ...event(1, "assistant", ""),
      data: { text: "## Plan\n\n- inspect\n- **fix**" },
    },
    {
      ...event(2, "tool", ""),
      data: { name: "read", text: "permission denied", isError: true },
    },
  ]);
  const { terminal } = changedTerminal(service.url);
  try {
    await terminal.connect();
    const rendered = terminalText(terminal);
    assert.match(rendered, /Plan/);
    assert.match(rendered, /- inspect/);
    assert.match(rendered, /fix/);
    assert.doesNotMatch(rendered, /\*\*fix\*\*/);
    assert.match(rendered, /Tool · read · failed/);
    assert.match(rendered, /permission denied/);
    await terminal.submit("/help");
    assert.match(terminalText(terminal), /\/model opens Pi's model selector/);
  } finally {
    terminal.close();
    await service.close();
  }
});

test("Pi editor submits multiline prompts and restores them from editor history", async () => {
  const service = await fixture();
  const { terminal, waitFor } = changedTerminal(service.url);
  try {
    await terminal.connect();
    const accepted = waitFor("Input accepted");
    terminal.handleInput("first line");
    terminal.handleInput("\x0a");
    terminal.handleInput("second line");
    terminal.handleInput("\r");
    await accepted;
    assert.equal(
      service.requests.at(-1).body.message,
      "first line\nsecond line",
    );
    terminal.handleInput("\x1b[A");
    assert.match(terminalText(terminal), /first line/);
    assert.match(terminalText(terminal), /second line/);
  } finally {
    terminal.close();
    await service.close();
  }
});

test(
  "Pi external-editor binding returns edited text to the workspace prompt",
  { timeout: 5000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "adm-editor-"));
    const editor = join(directory, "editor.sh");
    await writeFile(editor, '#!/bin/sh\nprintf "edited by Pi\\n" > "$1"\n');
    await chmod(editor, 0o700);
    const previous = process.env.EDITOR;
    process.env.EDITOR = editor;
    let terminal!: WorkspaceTerminal;
    let notify = () => {};
    terminal = new WorkspaceTerminal({
      url: "http://127.0.0.1",
      workspaceId: "work",
      onRender: () => notify(),
    });
    const edited = new Promise<void>((resolve) => {
      notify = () => {
        if (/External editor\s+updated/.test(terminalText(terminal))) resolve();
      };
    });
    try {
      terminal.handleInput("draft");
      terminal.handleInput("\x07");
      await edited;
      assert.match(terminalText(terminal), /edited by Pi/);
    } finally {
      terminal.close();
      if (previous === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previous;
      await rm(directory, { recursive: true });
    }
  },
);

test("Pi clipboard image paste reaches the owning Durable prompt with its request identity", async () => {
  const service = await fixture();
  const { terminal, waitFor } = changedTerminal(
    service.url,
    false,
    async () => ({
      bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    }),
  );
  try {
    await terminal.connect();
    const attached = waitFor("Image attached from clipboard");
    terminal.handleInput("\x16");
    await attached;
    const accepted = waitFor("Input accepted");
    terminal.handleInput("Describe this image");
    terminal.handleInput("\r");
    await accepted;
    assert.equal(service.requests.at(-1).body.message, "Describe this image");
    assert.equal(service.requests.at(-1).body.images[0].mimeType, "image/png");
    assert.equal(service.requests.at(-1).body.images[0].data, "iVBORw0KGgo=");
    assert.equal(service.requests.at(-1).body.requestId.length > 0, true);
  } finally {
    terminal.close();
    await service.close();
  }
});

test(
  "Herdr terminal loads coding history, receives live work, sends steering input, and detaches without aborting",
  { timeout: 10000 },
  async () => {
    const service = await fixture("coding", [
      event(1, "user", "Fix the build"),
      event(2, "assistant", "Investigating the compiler"),
    ]);
    const { terminal, waitFor } = changedTerminal(service.url);
    try {
      await terminal.connect();
      assert.match(terminalText(terminal), /Fix the build/);
      assert.match(terminalText(terminal), /Investigating the compiler/);
      const live = waitFor("Build fixed");
      service.push(event(3, "assistant", "Build fixed"));
      await live;
      const accepted = service.admission();
      terminal.handleInput("Check the browser too");
      terminal.handleInput("\r");
      const request = await accepted;
      assert.equal(request.path, "/v1/workspaces/work/input");
      assert.equal(request.body.message, "Check the browser too");
      assert.equal(request.body.whenBusy, "steer");
      assert.ok(request.body.requestId);
      terminal.close();
      assert.equal(
        service.requests.some((r) => r.path.endsWith("/abort")),
        false,
      );
    } finally {
      terminal.close();
      await service.close();
    }
  },
);

test(
  "bot chat hides model and tool diagnostics while explicit messages and durable goal controls remain usable",
  { timeout: 10000 },
  async () => {
    const service = await fixture("bot", [
      event(1, "user", "Watch my coding agent"),
      event(2, "assistant", "PRIVATE MODEL REASONING"),
      event(3, "tool", "PRIVATE TOOL OUTPUT"),
      event(4, "message", "I will report meaningful changes"),
    ]);
    const { terminal, waitFor } = changedTerminal(service.url);
    try {
      await terminal.connect();
      assert.match(terminalText(terminal), /Watch my coding agent/);
      assert.match(terminalText(terminal), /I will report meaningful changes/);
      assert.doesNotMatch(terminalText(terminal), /PRIVATE/);
      const next = waitFor("The agent finished");
      service.push(event(5, "assistant", "PRIVATE LIVE MODEL OUTPUT"));
      service.push(event(6, "tool", "PRIVATE LIVE TOOL OUTPUT"));
      service.push(event(7, "message", "The agent finished"));
      await next;
      assert.doesNotMatch(terminalText(terminal), /PRIVATE/);
      await terminal.submit("/newgoal Monitor the release");
      assert.ok(
        service.requests.some(
          (request) =>
            request.path.endsWith("/goals") &&
            request.body.description === "Monitor the release",
        ),
      );
      await terminal.submit("/loop 60 Check permitted agent progress");
      assert.ok(
        service.requests.some(
          (request) =>
            request.path.endsWith("/loops") &&
            request.body.intervalMs === 60000,
        ),
      );
      await terminal.submit("/abort all");
      assert.ok(
        service.requests.some(
          (request) =>
            request.path.endsWith("/abort") && request.body.background === true,
        ),
      );
    } finally {
      terminal.close();
      await service.close();
    }
  },
);

test(
  "reconnecting resumes from the last event and avoids duplicate conversation entries",
  { timeout: 10000 },
  async () => {
    const service = await fixture("coding", [
      event(1, "user", "Existing prompt"),
      event(2, "assistant", "Existing answer"),
    ]);
    const { terminal, waitFor } = changedTerminal(service.url);
    try {
      await terminal.connect();
      const first = waitFor("Latest answer");
      service.push(event(3, "assistant", "Latest answer"));
      await first;
      const disconnected = waitFor("Disconnected");
      service.disconnect();
      await disconnected;
      await terminal.submit("/reconnect");
      assert.equal(
        service.requests
          .filter((request) => request.path.endsWith("/events"))
          .at(-1)?.after,
        "3",
      );
      const next = waitFor("Finished after reconnect");
      service.push(event(3, "assistant", "Latest answer"));
      service.push(event(4, "assistant", "Finished after reconnect"));
      await next;
      assert.equal(terminalText(terminal).split("Latest answer").length - 1, 1);
      await terminal.submit("/followup Review the result");
      assert.equal(service.requests.at(-1).body.whenBusy, "followUp");
      assert.equal(service.requests.at(-1).body.message, "Review the result");
    } finally {
      terminal.close();
      await service.close();
    }
  },
);

test(
  "diagnostics are opt-in and network ambiguity reuses an input request identity",
  { timeout: 10000 },
  async () => {
    let firstId: string | undefined;
    let secondId: string | undefined;
    let submissions = 0;
    const server = createServer(async (req, res) => {
      if (req.url?.includes("/history")) {
        res.end(
          JSON.stringify({
            events: [event(1, "assistant", "PRIVATE DIAGNOSTICS")],
            hasMore: false,
          }),
        );
      } else if (req.url?.includes("/events")) {
        assert.match(req.url, /diagnostics=true/);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": attached\n\n");
      } else if (
        new URL(req.url!, "http://localhost").pathname.endsWith("/models")
      ) {
        res.end(
          JSON.stringify({
            selected: { provider: "faux", id: "faux-1" },
            models: [],
            providers: [],
          }),
        );
      } else if (req.method === "POST") {
        let text = "";
        for await (const chunk of req) text += chunk;
        const body = JSON.parse(text);
        submissions++;
        if (submissions === 1) {
          firstId = body.requestId;
          res.destroy();
        } else {
          secondId = body.requestId;
          res.end(JSON.stringify({ submissionId: "original" }));
        }
      } else {
        res.end(
          JSON.stringify({
            id: "work",
            name: "demo",
            role: "bot",
            status: "idle",
          }),
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { terminal } = changedTerminal(
      `http://127.0.0.1:${(server.address() as any).port}`,
      true,
    );
    try {
      await terminal.connect();
      assert.match(
        terminalText(terminal),
        /DIAGNOSTICS · PRIVATE MODEL\/TOOL OUTPUT/,
      );
      assert.match(terminalText(terminal), /PRIVATE DIAGNOSTICS/);
      await terminal.submit("Check the status");
      assert.match(terminalText(terminal), /Error:/);
      await terminal.submit("Check the status");
      assert.equal(submissions, 2);
      assert.equal(secondId, firstId);
      assert.match(terminalText(terminal), /Input accepted/);
    } finally {
      terminal.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "an input failure restores the submitted text without consuming keystrokes typed while it was in flight",
  { timeout: 10000 },
  async () => {
    let rejectAdmission!: () => void;
    const receivedAdmission = new Promise<void>((resolve) => {
      rejectAdmission = resolve;
    });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      if (url.pathname.endsWith("/history")) {
        res.end(JSON.stringify({ events: [], nextAfter: 0, hasMore: false }));
      } else if (url.pathname.endsWith("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": attached\n\n");
      } else if (url.pathname.endsWith("/models")) {
        res.end(
          JSON.stringify({
            selected: { provider: "faux", id: "faux-1" },
            models: [],
            providers: [],
          }),
        );
      } else if (req.method === "POST") {
        for await (const _chunk of req) {
        }
        rejectAdmission();
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: "runner restarting" } }));
      } else {
        res.end(
          JSON.stringify({
            id: "work",
            name: "demo",
            role: "coding",
            status: "idle",
            goals: [],
            loops: [],
          }),
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { terminal, waitFor } = changedTerminal(
      `http://127.0.0.1:${(server.address() as any).port}`,
    );
    try {
      await terminal.connect();
      const failed = waitFor("runner restarting");
      terminal.handleInput("Run the integration suite");
      terminal.handleInput("\r");
      await receivedAdmission;
      assert.match(terminalText(terminal), /Run the integration suite/);
      terminal.handleInput("Do not lose this draft");
      terminal.handleInput("\r");
      assert.match(terminalText(terminal), /Run the integration suite/);
      await failed;
      assert.match(terminalText(terminal), /Run the integration suite/);
      assert.doesNotMatch(terminalText(terminal), /Do not lose this draft/);
    } finally {
      terminal.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "attach selects a model through Pi's actual selector in a PTY and persists it over HTTP",
  { timeout: 10000 },
  async () => {
    const service = await fixture("coding", [], { needsModel: true });
    const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
    const args = [
      process.execPath,
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "--url",
      service.url,
      "--workspace",
      "work",
    ];
    const child = spawn(
      "script",
      [
        "--quiet",
        "--return",
        "--command",
        args.map(quote).join(" "),
        "/dev/null",
      ],
      { stdio: ["pipe", "pipe", "pipe"], detached: true },
    );
    let output = "";
    try {
      const modelRequest = service.admission();
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          child.stdout.on("data", (chunk) => {
            output += chunk;
            if (stripTerminalSequences(output).includes("/repos/demo"))
              resolve();
          });
          child.stderr.on("data", (chunk) => (output += chunk));
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(
              new Error(
                `Terminal exited before native startup (${code}): ${output}`,
              ),
            ),
          );
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Native startup timed out: ${output}`)),
            5000,
          ),
        ),
      ]);
      await Promise.race([
        service.refreshStarted,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Native model readiness missing: ${visibleTerminalText(output)}; requests=${JSON.stringify(service.requests)}`,
                ),
              ),
            4000,
          ),
        ),
      ]);
      child.stdin.write("/model\r");
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const check = () => {
            if (visibleTerminalText(output).includes("Faux 1")) resolve();
          };
          child.stdout.on("data", (chunk) => {
            output += chunk;
            check();
          });
          check();
          child.once("exit", (code) =>
            reject(
              new Error(
                `Terminal exited before native selector rendered (${code}): ${output}`,
              ),
            ),
          );
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`Native model selector timed out: ${output}`)),
            5000,
          ),
        ),
      ]);
      child.stdin.write("\r");
      const request = await Promise.race([
        modelRequest,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`Model selection did not complete: ${output}`)),
            5000,
          ),
        ),
      ]);
      assert.equal(request.method, "PUT");
      assert.ok(request.path.endsWith("/model"));
      assert.equal(request.body.provider, "faux");
      assert.equal(request.body.modelId, "faux-1");
      await Promise.race([
        new Promise<void>((resolve) => {
          const check = () => {
            if (visibleTerminalText(output).includes("Model: faux-1"))
              resolve();
          };
          child.stdout.on("data", check);
          check();
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Model acknowledgement missing: ${visibleTerminalText(output)}`,
                ),
              ),
            4000,
          ),
        ),
      ]);
      const exited = once(child, "exit");
      child.stdin.write("\x04");
      assert.equal((await exited)[0], 0, output);
    } finally {
      stopProcessGroup(child);
      await service.close();
    }
  },
);

test(
  "reconnecting closes the open Pi model selector and aborts its catalog refresh",
  { timeout: 5000 },
  async () => {
    const service = await fixture("coding", [], {
      needsModel: true,
      holdRefresh: true,
    });
    const ui = new TuiMainScreen(new ProcessTerminal());
    const terminal = new WorkspaceTerminal({
      url: service.url,
      workspaceId: "work",
      tui: ui,
    });
    try {
      await terminal.connect();
      await service.refreshStarted;
      await terminal.connect();
      const canceled = await Promise.race([
        service.refreshClosed.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 1000),
        ),
      ]);
      assert.equal(
        canceled,
        true,
        "reconnect aborts the selector-owned HTTP refresh",
      );
    } finally {
      terminal.close();
      await service.close();
    }
  },
);

test(
  "actual Pi terminal process renders in a PTY and Ctrl+C detaches without stopping the agent",
  { timeout: 10000 },
  async () => {
    const service = await fixture("bot", [
      event(1, "assistant", "SECRET PROCESS OUTPUT"),
      event(2, "message", "Visible bot reply"),
    ]);
    const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
    const args = [
      process.execPath,
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "--url",
      service.url,
      "--workspace",
      "work",
    ];
    const child = spawn(
      "script",
      [
        "--quiet",
        "--return",
        "--command",
        args.map(quote).join(" "),
        "/dev/null",
      ],
      { stdio: ["pipe", "pipe", "pipe"], detached: true },
    );
    let output = "";
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (stripTerminalSequences(output).includes("Visible bot reply"))
            resolve();
        });
        child.stderr.on("data", (chunk) => (output += chunk));
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(
            new Error(`Terminal exited before rendering (${code}): ${output}`),
          ),
        );
      });
      assert.doesNotMatch(
        stripTerminalSequences(output),
        /SECRET PROCESS OUTPUT/,
      );
      const exited = once(child, "exit");
      child.stdin.write("\x03");
      assert.equal((await exited)[0], 0);
      assert.equal(
        service.requests.some((request) => request.path.endsWith("/abort")),
        false,
      );
    } finally {
      stopProcessGroup(child);
      await service.close();
    }
  },
);

test("terminal re-reads the verified Pod identity so token rotation keeps status, SSE, and prompts authorized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-terminal-identity-"));
  const identityPath = join(directory, "identity.json");
  const tokenPath = join(directory, "projection");
  const kubectlPath = join(directory, "kubectl");
  await writeFile(tokenPath, "projected-runtime-token-1\n", { mode: 0o600 });
  await writeFile(
    identityPath,
    JSON.stringify({
      workspaceId: "work",
      namespace: "adm-work",
      podName: "workspace-0",
      podUid: "a1b2c3d4-e5f6-47a8-9012-123456789abc",
      container: "dev",
      kubectl: kubectlPath,
      kubeconfig: "/tmp/kubeconfig",
    }),
    { mode: 0o600 },
  );
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    kubectlPath,
    `#!/bin/sh\nif [ "$1" = get ]; then printf '%s' '{"metadata":{"uid":"a1b2c3d4-e5f6-47a8-9012-123456789abc","namespace":"adm-work","labels":{"adm.dev/workspace-id":"work"}},"spec":{"serviceAccountName":"adm-runtime"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}'; else cat ${shellQuote(tokenPath)}; fi\n`,
    { mode: 0o700 },
  );
  const observed: string[] = [];
  const server = createServer(async (request, response) => {
    observed.push(request.headers.authorization ?? "");
    if (
      !request.headers.authorization?.startsWith(
        "Bearer projected-runtime-token-",
      )
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.url?.includes("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": attached\n\n");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.method === "POST"
          ? { submissionId: "sent", status: "admitted" }
          : request.url?.includes("/history")
            ? { events: [], nextAfter: 0, hasMore: false }
            : {
                id: "work",
                name: "demo",
                role: "coding",
                status: "idle",
                goals: [],
                loops: [],
              },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as any;
  const terminal = new WorkspaceTerminal({
    url: `http://127.0.0.1:${address.port}`,
    workspaceId: "work",
    identityFile: identityPath,
  });
  try {
    await terminal.connect();
    assert.ok(terminalText(terminal).includes("Connected"));
    await writeFile(tokenPath, "projected-runtime-token-2\n", { mode: 0o600 });
    await terminal.submit("hello");
    assert.ok(observed.length >= 4);
    assert.ok(observed.includes("Bearer projected-runtime-token-1"));
    assert.ok(observed.includes("Bearer projected-runtime-token-2"));
  } finally {
    terminal.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  "a real terminal submits to the runner, detaches mid-run, and reconnects to the completed history",
  { timeout: 20000 },
  async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "adm-terminal-runner-"),
    );
    const runnerPath = fileURLToPath(
      new URL("../../runner/src/main.ts", import.meta.url),
    );
    const runner = spawn(
      process.execPath,
      [
        runnerPath,
        "--port",
        "0",
        "--state-dir",
        stateDirectory,
        "--provider",
        "faux",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: stateDirectory },
      },
    );
    let runnerErrors = "";
    runner.stderr.on("data", (chunk) => (runnerErrors += chunk));
    const runnerExit = once(runner, "exit");
    const runnerLines = createInterface({ input: runner.stdout });
    let runnerUrl = "";
    try {
      runnerUrl = await new Promise<string>((resolve, reject) => {
        runner.once("error", reject);
        runner.once("exit", (code) =>
          reject(new Error(`Runner exited ${code}: ${runnerErrors}`)),
        );
        runnerLines.on("line", (line) => {
          try {
            const value = JSON.parse(line);
            if (value.ready) resolve(value.url);
          } catch {
            // Runner diagnostics may share stdout with its ready record.
          }
        });
      });
      const id = "terminal-real-runner";
      const root = join(stateDirectory, "repo");
      await mkdir(root);
      const path = `/v1/workspaces/${id}`;
      const registered = await fetch(`${runnerUrl}${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          name: "terminal integration",
          role: "coding",
          environment: "local",
          localRoot: root,
          model: { provider: "faux", id: "faux-1" },
        }),
      });
      assert.equal(registered.status, 200);

      const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
      const args = [
        process.execPath,
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        "--url",
        runnerUrl,
        "--workspace",
        id,
      ];
      const attach = () =>
        spawn(
          "script",
          [
            "--quiet",
            "--return",
            "--command",
            args.map(quote).join(" "),
            "/dev/null",
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
            env: {
              ...process.env,
              HOME: stateDirectory,
              XDG_CONFIG_HOME: join(stateDirectory, "client-config"),
            },
          },
        );
      let readyResolve = () => {};
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      const proxy = createServer((req, res) => {
        if (req.url?.includes("/models?refresh=true")) readyResolve();
        const upstream = httpRequest(
          new URL(req.url!, runnerUrl),
          { method: req.method, headers: req.headers },
          (incoming) => {
            res.writeHead(incoming.statusCode!, incoming.headers);
            incoming.pipe(res);
          },
        );
        upstream.on("error", (error) => res.destroy(error));
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      args[args.indexOf("--url") + 1] =
        `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
      const fifo = join(stateDirectory, "release");
      const marker = join(stateDirectory, "tool-started");
      assert.equal((await once(spawn("mkfifo", [fifo]), "exit"))[0], 0);
      const watchController = new AbortController();
      const changes = watch(stateDirectory, { signal: watchController.signal });
      const started = (async () => {
        for await (const event of changes)
          if (event.filename === "tool-started") return;
      })();
      const first = attach();
      const terminals = [first];
      const output = new Map<typeof first, string>();
      const waitOutput = (child: typeof first, text: string) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Missing native output ${text}: ${visibleTerminalText(output.get(child) ?? "")}`,
                ),
              ),
            5000,
          );
          const check = () => {
            if (visibleTerminalText(output.get(child) ?? "").includes(text)) {
              clearTimeout(timer);
              child.stdout.off("data", check);
              resolve();
            }
          };
          child.stdout.on("data", check);
          check();
        });
      const capture = (child: typeof first) => {
        output.set(child, "");
        child.stdout.on("data", (data) =>
          output.set(child, output.get(child)! + data),
        );
        child.stderr.on("data", (data) =>
          output.set(child, output.get(child)! + data),
        );
      };
      capture(first);
      const observer = new WorkspaceTerminal({
        url: runnerUrl,
        workspaceId: id,
        autoModelSelector: false,
      });
      try {
        await Promise.race([
          ready,
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Native startup did not refresh: ${visibleTerminalText(output.get(first) ?? "")}; runner=${runnerErrors}`,
                  ),
                ),
              5000,
            ),
          ),
        ]);
        const prompt =
          "/faux \n" +
          JSON.stringify({
            calls: [
              {
                tool: "bash",
                args: { command: `touch ${marker}; cat ${fifo}` },
              },
            ],
            answer: "Done after terminal detach",
          });
        first.stdin.write(`\x1b[200~${prompt}\x1b[201~`);
        await waitOutput(first, "/faux");
        first.stdin.write("\r");
        await Promise.race([
          started,
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Native tool did not start: ${visibleTerminalText(output.get(first) ?? "")}; runner=${runnerErrors}`,
                  ),
                ),
              5000,
            ),
          ),
        ]);
        const firstExit = once(first, "exit");
        first.stdin.write("\x03");
        assert.equal((await firstExit)[0], 0);
        const pending = await (
          await fetch(`${runnerUrl}${path}/history`)
        ).json();
        assert.ok(
          pending.events.some(
            (event: WorkspaceEvent) =>
              event.kind === "user" && event.data.text === prompt,
          ),
        );
        assert.ok(
          !pending.events.some(
            (event: WorkspaceEvent) =>
              event.kind === "assistant" &&
              event.data.text === "Done after terminal detach",
          ),
        );
        await observer.connect();
        const complete = new Promise<void>((resolve) =>
          observer.subscribeWorkspaceEvents((event) => {
            if (
              event.kind === "assistant" &&
              event.data.text === "Done after terminal detach"
            )
              resolve();
          }),
        );
        await writeFile(fifo, "released\n");
        await complete;
        const second = attach();
        terminals.push(second);
        capture(second);
        await waitOutput(second, "Done after terminal detach");
        const secondExit = once(second, "exit");
        second.stdin.write("\x03");
        assert.equal((await secondExit)[0], 0);
        const recovered = await (
          await fetch(`${runnerUrl}${path}/history`)
        ).json();
        assert.equal(
          recovered.events.filter(
            (event: WorkspaceEvent) => event.kind === "user",
          ).length,
          1,
        );
      } finally {
        observer.close();
        watchController.abort();
        for (const child of terminals) stopProcessGroup(child);
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    } finally {
      runner.kill("SIGTERM");
      await runnerExit;
      runnerLines.close();
    }
  },
);

test(
  "an attached native terminal stays up through live tool success, failure, and abort",
  { timeout: 30000 },
  async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "adm-terminal-live-tools-"),
    );
    const runner = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../runner/src/main.ts", import.meta.url)),
        "--port",
        "0",
        "--state-dir",
        stateDirectory,
        "--provider",
        "faux",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: stateDirectory },
      },
    );
    let runnerErrors = "";
    runner.stderr.on("data", (chunk) => (runnerErrors += chunk));
    const runnerExit = once(runner, "exit");
    const runnerLines = createInterface({ input: runner.stdout });
    const watchController = new AbortController();
    let terminal: ReturnType<typeof spawn> | undefined;
    let proxy: ReturnType<typeof createServer> | undefined;
    let observer: WorkspaceTerminal | undefined;
    try {
      const runnerUrl = await new Promise<string>((resolve, reject) => {
        runner.once("error", reject);
        runner.once("exit", (code) =>
          reject(new Error(`Runner exited ${code}: ${runnerErrors}`)),
        );
        runnerLines.on("line", (line) => {
          try {
            const value = JSON.parse(line);
            if (value.ready) resolve(value.url);
          } catch {
            // Runner diagnostics may share stdout with its ready record.
          }
        });
      });
      const id = "terminal-live-tools";
      const root = join(stateDirectory, "repo");
      await mkdir(root);
      const registered = await fetch(`${runnerUrl}/v1/workspaces/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          name: "live tools",
          role: "coding",
          environment: "local",
          localRoot: root,
          model: { provider: "faux", id: "faux-1" },
        }),
      });
      assert.equal(registered.status, 200);

      // Pi ignores submissions until startup ends with its model refresh.
      let readyResolve = () => {};
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      proxy = createServer((req, res) => {
        if (req.url?.includes("/models?refresh=true")) readyResolve();
        const upstream = httpRequest(
          new URL(req.url!, runnerUrl),
          { method: req.method, headers: req.headers },
          (incoming) => {
            res.writeHead(incoming.statusCode!, incoming.headers);
            incoming.pipe(res);
          },
        );
        upstream.on("error", (error) => res.destroy(error));
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
      const args = [
        process.execPath,
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        "--url",
        `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
        "--workspace",
        id,
      ];
      const child = spawn(
        "script",
        [
          "--quiet",
          "--return",
          "--command",
          args.map(quote).join(" "),
          "/dev/null",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          env: {
            ...process.env,
            HOME: stateDirectory,
            XDG_CONFIG_HOME: join(stateDirectory, "client-config"),
          },
        },
      );
      terminal = child;
      let output = "";
      let exited: number | null | undefined;
      child.stdout!.on("data", (data) => (output += data));
      child.stderr!.on("data", (data) => (output += data));
      child.once("exit", (code) => (exited = code));
      // Wait on PTY output; the attached terminal crashing fails immediately.
      const waitOutput = (text: string) =>
        new Promise<void>((resolve, reject) => {
          const check = () => {
            if (visibleTerminalText(output).includes(text)) done(resolve);
            else if (exited !== undefined)
              done(() =>
                reject(
                  new Error(
                    `Terminal exited (${exited}) before showing ${text}: ${visibleTerminalText(output)}; runner=${runnerErrors}`,
                  ),
                ),
              );
          };
          const timer = setTimeout(
            () =>
              done(() =>
                reject(
                  new Error(
                    `Missing native output ${text}: ${visibleTerminalText(output)}; runner=${runnerErrors}`,
                  ),
                ),
              ),
            10000,
          );
          const done = (settle: () => void) => {
            clearTimeout(timer);
            child.stdout!.off("data", check);
            child.off("exit", check);
            settle();
          };
          child.stdout!.on("data", check);
          child.on("exit", check);
          check();
        });
      const submit = async (prompt: string) => {
        child.stdin!.write(`\x1b[200~${prompt}\x1b[201~`);
        await waitOutput(prompt.slice(-24));
        child.stdin!.write("\r");
      };
      await ready;
      // The runner's own history says when each run is over.
      const historyObserver = new WorkspaceTerminal({
        url: runnerUrl,
        workspaceId: id,
        autoModelSelector: false,
      });
      observer = historyObserver;
      await historyObserver.connect();
      const history = (match: (event: WorkspaceEvent) => boolean) =>
        new Promise<WorkspaceEvent>((resolve) =>
          historyObserver.subscribeWorkspaceEvents((event) => {
            if (match(event)) resolve(event);
          }),
        );

      const answered = history(
        (event) =>
          event.kind === "assistant" &&
          event.data.text === "Both tools finished while attached",
      );
      await submit(
        "/faux " +
          JSON.stringify({
            calls: [
              {
                tool: "bash",
                args: { command: "printf 'tool-ok-%s' $((6*7))" },
              },
              {
                tool: "bash",
                args: { command: "printf 'tool-bad-%s' $((6*7)) >&2; exit 7" },
              },
            ],
            answer: "Both tools finished while attached",
          }),
      );
      // Only the final tool result carries Durable's exit diagnostic.
      await waitOutput("Command exited with code 7");
      await answered;
      const settled = visibleTerminalText(output);
      assert.match(settled, /tool-ok-42 Took \d/);
      assert.match(settled, /tool-bad-42/);

      const fifo = join(stateDirectory, "release");
      const marker = join(stateDirectory, "abort-tool-started");
      assert.equal((await once(spawn("mkfifo", [fifo]), "exit"))[0], 0);
      const changes = watch(stateDirectory, {
        signal: watchController.signal,
      });
      const started = (async () => {
        for await (const event of changes)
          if (event.filename === "abort-tool-started") return;
      })();
      const abortedResult = history(
        (event) =>
          event.kind === "tool" &&
          event.data.text.includes("Tool bash was aborted"),
      );
      await submit(
        "/faux " +
          JSON.stringify({
            calls: [
              {
                tool: "bash",
                args: { command: `touch ${marker}; cat ${fifo}` },
              },
            ],
            answer: "Not reached after abort",
          }),
      );
      await started;
      child.stdin!.write("\x1b");
      assert.equal((await abortedResult).data.isError, true);
      await waitOutput("Tool bash was aborted");
      assert.equal(exited, undefined, visibleTerminalText(output));

      const detached = once(child, "exit");
      child.stdin!.write("\x03");
      assert.equal((await detached)[0], 0);
      assert.doesNotMatch(visibleTerminalText(output), /TypeError/);
    } finally {
      watchController.abort();
      observer?.close();
      if (terminal) stopProcessGroup(terminal);
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy!.close(() => resolve()));
      }
      runner.kill("SIGTERM");
      await runnerExit;
      runnerLines.close();
    }
  },
);
