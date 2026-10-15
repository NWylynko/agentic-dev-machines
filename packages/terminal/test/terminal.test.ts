import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceTerminal } from "../src/terminal.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

function terminalText(terminal: WorkspaceTerminal) {
  return stripTerminalSequences(terminal.render(100).join("\n"));
}
async function fixture(role = "coding", events: any[] = []) {
  const requests: any[] = [];
  let stream: any;
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
        JSON.stringify({ submissionId: "submission", status: "accepted" }),
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
function changedTerminal(url: string, diagnostics = false) {
  let notify: () => void = () => {};
  const terminal = new WorkspaceTerminal({
    url,
    workspaceId: "work",
    diagnostics,
    onRender() {
      notify();
    },
  });
  const waitFor = (text: string) =>
    new Promise<void>((resolve) => {
      if (terminalText(terminal).includes(text)) {
        resolve();
        return;
      }
      notify = () => {
        if (terminalText(terminal).includes(text)) resolve();
      };
    });
  return { terminal, waitFor };
}

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
      { stdio: ["pipe", "pipe", "pipe"] },
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
      if (child.exitCode === null) child.kill("SIGTERM");
      await service.close();
    }
  },
);

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
      { stdio: ["ignore", "pipe", "pipe"] },
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
          { stdio: ["pipe", "pipe", "pipe"] },
        );
      const first = attach();
      let firstOutput = "";
      const waitForOutput = (
        child: ReturnType<typeof attach>,
        contains: string,
      ) => {
        if (stripTerminalSequences(firstOutput).includes(contains))
          return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeout);
            child.stdout.off("data", onStdout);
            child.stderr.off("data", onStderr);
            child.off("error", onError);
            child.off("exit", onExit);
          };
          const complete = () => {
            cleanup();
            resolve();
          };
          const onStdout = (chunk: Buffer) => {
            firstOutput += chunk.toString();
            if (stripTerminalSequences(firstOutput).includes(contains))
              complete();
          };
          const onStderr = (chunk: Buffer) => {
            firstOutput += chunk.toString();
            if (stripTerminalSequences(firstOutput).includes(contains))
              complete();
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const onExit = (code: number | null) => {
            cleanup();
            reject(new Error(`Terminal exited ${code}: ${firstOutput}`));
          };
          const timeout = setTimeout(() => {
            cleanup();
            reject(
              new Error(`Timed out waiting for ${contains}: ${firstOutput}`),
            );
          }, 5000);
          child.stdout.on("data", onStdout);
          child.stderr.on("data", onStderr);
          child.once("error", onError);
          child.once("exit", onExit);
        });
      };
      try {
        const connected = waitForOutput(first, "Connected ·");
        await connected;
        first.stdin.write("The runner continued after terminal detach\n");
        await waitForOutput(first, "Input accepted");
        const detached = once(first, "exit");
        first.stdin.write("\x03");
        assert.equal((await detached)[0], 0);

        const historyResponse = await fetch(
          `${runnerUrl}${path}/history?limit=1000`,
        );
        const history = await historyResponse.json();
        assert.ok(
          history.events.some(
            (event: any) =>
              event.kind === "assistant" &&
              event.data.text.includes(
                "Echo: The runner continued after terminal detach",
              ),
          ),
        );

        firstOutput = "";
        const second = attach();
        try {
          await waitForOutput(
            second,
            "Echo: The runner continued after terminal detach",
          );
          assert.match(
            stripTerminalSequences(firstOutput),
            /Echo: The runner continued after terminal detach/,
          );

          const failedInput = await fetch(`${runnerUrl}${path}/input`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message: "/faux-fail-once finish after refreshing credentials",
              requestId: "terminal-provider-failure",
            }),
          });
          assert.equal(failedInput.status, 202);
          await waitForOutput(
            second,
            "Provider error · Authentication credentials are invalid",
          );
          const failedStatus = await fetch(`${runnerUrl}${path}`);
          const failedWorkspace = await failedStatus.json();
          assert.equal(failedWorkspace.status, "error");
          assert.match(
            failedWorkspace.error,
            /authentication credentials are invalid/i,
          );

          second.stdin.write("/status\n");
          await waitForOutput(second, "0 goals · 0 loops");
          assert.match(
            stripTerminalSequences(firstOutput),
            /Provider error · Authentication credentials are invalid/,
          );
          second.stdin.write("/resume\n");
          await waitForOutput(second, "Provider retry queued");
          await waitForOutput(
            second,
            "Echo: Continue the unanswered request from assistant error entry",
          );
          const resumedStatus = await fetch(`${runnerUrl}${path}`);
          const resumedWorkspace = await resumedStatus.json();
          assert.equal(resumedWorkspace.status, "idle");
          assert.equal(resumedWorkspace.error, undefined);

          firstOutput = "";
          second.stdin.write("/newgoal Ship the release\n");
          await waitForOutput(second, "Goal saved");
          firstOutput = "";
          second.stdin.write("/goal Retire the old API\n");
          await waitForOutput(second, "Goal saved");
          firstOutput = "";
          second.stdin.write("/loop 3600 Review the release status\n");
          await waitForOutput(second, "Loop saved");

          const managed = await fetch(`${runnerUrl}${path}`);
          const beforeControls = await managed.json();
          const [completedGoal, cancelledGoal] = beforeControls.goals;
          const [cancelledLoop] = beforeControls.loops;
          assert.equal(completedGoal.description, "Ship the release");
          assert.equal(cancelledGoal.description, "Retire the old API");
          assert.equal(cancelledLoop.prompt, "Review the release status");

          firstOutput = "";
          second.stdin.write("/goals\n");
          await waitForOutput(second, completedGoal.id);
          await waitForOutput(second, cancelledGoal.id);
          firstOutput = "";
          second.stdin.write("/loops\n");
          await waitForOutput(second, cancelledLoop.id);

          firstOutput = "";
          second.stdin.write(`/complete-goal ${completedGoal.id}\n`);
          await waitForOutput(second, "Goal marked completed");
          firstOutput = "";
          second.stdin.write(`/cancel-goal ${cancelledGoal.id}\n`);
          await waitForOutput(second, "Goal cancelled");
          firstOutput = "";
          second.stdin.write(`/cancel-loop ${cancelledLoop.id}\n`);
          await waitForOutput(second, "Loop cancelled");

          const managedAfter = await fetch(`${runnerUrl}${path}`);
          const afterControls = await managedAfter.json();
          assert.deepEqual(
            afterControls.goals.map((goal: any) => goal.status),
            ["completed", "cancelled"],
          );
          assert.equal(afterControls.loops[0].status, "cancelled");

          const detachedAgain = once(second, "exit");
          second.stdin.write("\x03");
          assert.equal((await detachedAgain)[0], 0);
        } finally {
          if (second.exitCode === null) second.kill("SIGTERM");
        }
      } finally {
        if (first.exitCode === null) first.kill("SIGTERM");
      }
    } finally {
      runner.kill("SIGTERM");
      await runnerExit;
      runnerLines.close();
    }
  },
);
