import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  watch,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { WorkspaceTerminal, type WorkspaceEvent } from "../src/terminal.ts";

// The runner declares this keepalive on its event stream; the attached
// terminal treats three silent intervals as a dead stream.
const keepaliveMs = 200;

const visibleText = (text: string) =>
  stripTerminalSequences(text).replace(/\s+/g, " ");
const occurrences = (text: string, part: string) => text.split(part).length - 1;
// The prompt spells the answer's spaces as JSON escapes, so the reply text
// appears on screen only where Pi renders the reply itself.
const fauxPrompt = (plan: {
  calls?: { tool: string; args: Record<string, string> }[];
  answer: string;
}) =>
  "/faux " +
  JSON.stringify(plan).replace(
    JSON.stringify(plan.answer),
    JSON.stringify(plan.answer).replaceAll(" ", "\\u0020"),
  );

type EventStreamThroughProxy = {
  incoming: IncomingMessage;
  response: ServerResponse;
};

// A real runner behind a forwarding proxy (standing in for `kubectl
// port-forward`), with the native Pi terminal attached in a real PTY.
async function attachThroughProxy(t: TestContext, id: string) {
  const directory = await mkdtemp(join(tmpdir(), "adm-stream-drop-"));
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
      "--events-keepalive-ms",
      String(keepaliveMs),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: directory },
    },
  );
  let runnerErrors = "";
  runner.stderr.on("data", (chunk) => (runnerErrors += chunk));
  const runnerExit = once(runner, "exit");
  const runnerLines = createInterface({ input: runner.stdout });
  const watchController = new AbortController();
  const cleanups: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    watchController.abort();
    for (const cleanup of cleanups.reverse()) await cleanup();
    if (runner.exitCode === null && runner.signalCode === null) {
      runner.kill("SIGTERM");
      await runnerExit;
    }
    runnerLines.close();
    await rm(directory, { recursive: true });
  });
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
  const root = join(directory, "repo");
  await mkdir(root);
  const registered = await fetch(`${runnerUrl}/v1/workspaces/${id}`, {
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

  // While `outage` is set the proxy answers every request with 503, as a
  // forward to a restarting runner would fail.
  const proxyControl = {
    outage: false,
    eventStreams: [] as EventStreamThroughProxy[],
  };
  let readyResolve = () => {};
  const ready = new Promise<void>((resolve) => (readyResolve = resolve));
  const proxy = createServer((req, res) => {
    if (proxyControl.outage) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "FIXTURE_OUTAGE", message: "runner unavailable" },
        }),
      );
      return;
    }
    if (req.url?.includes("/models?refresh=true")) readyResolve();
    const upstream = httpRequest(
      new URL(req.url!, runnerUrl),
      { method: req.method, headers: req.headers },
      (incoming) => {
        res.writeHead(incoming.statusCode!, incoming.headers);
        res.flushHeaders();
        if (new URL(req.url!, runnerUrl).pathname.endsWith("/events"))
          proxyControl.eventStreams.push({ incoming, response: res });
        incoming.pipe(res);
      },
    );
    upstream.on("error", (error) => res.destroy(error));
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  cleanups.push(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

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
  const stateHome = join(directory, "client-state");
  const child = spawn(
    "script",
    [
      "--quiet",
      "--return",
      "--command",
      `stty cols 120 rows 200 && exec ${args.map(quote).join(" ")}`,
      "/dev/null",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, "client-config"),
        XDG_STATE_HOME: stateHome,
      },
    },
  );
  cleanups.push(() => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid)
      return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  });
  let output = "";
  let exited: number | null | undefined;
  child.once("exit", (code) => (exited = code));
  const emulator = new xterm.Terminal({
    cols: 120,
    rows: 200,
    allowProposedApi: true,
  });
  let emulated = Promise.resolve();
  child.stdout!.on("data", (data) => {
    output += data;
    emulated = new Promise((resolve) => emulator.write(data, resolve));
  });
  child.stderr!.on("data", (data) => (output += data));
  const screen = async () => {
    await emulated;
    const buffer = emulator.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++)
      lines.push(buffer.getLine(row)!.translateToString(true));
    return lines.join("\n");
  };
  // Wait until the emulated screen satisfies `ready`; a crashed terminal or
  // a timeout fails with the screen as it is.
  const waitScreen = (description: string, ready: (text: string) => boolean) =>
    new Promise<string>((resolve, reject) => {
      let settled = false;
      const check = async () => {
        const text = await screen();
        if (settled) return;
        if (ready(text)) done(() => resolve(text));
        else if (exited !== undefined)
          done(() =>
            reject(
              new Error(
                `Terminal exited (${exited}) before ${description}:\n${text}\n${visibleText(output)}\nrunner=${runnerErrors}`,
              ),
            ),
          );
      };
      const timer = setTimeout(
        () =>
          void screen().then((text) =>
            done(() =>
              reject(
                new Error(
                  `Screen never showed ${description}:\n${text}\nrunner=${runnerErrors}`,
                ),
              ),
            ),
          ),
        10000,
      );
      const done = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout!.off("data", check);
        child.off("exit", check);
        settle();
      };
      child.stdout!.on("data", check);
      child.on("exit", check);
      void check();
    });
  // A settled turn: its reply is on screen exactly once, Pi shows no working
  // indicator, and the terminal is connected.
  const settledReply = async (reply: string) => {
    const text = await waitScreen(
      `the settled reply ${reply}`,
      (text) =>
        text.includes(reply) &&
        !text.includes("Working") &&
        !text.includes("Disconnected"),
    );
    assert.equal(occurrences(text, reply), 1, text);
    return text;
  };
  const submit = async (prompt: string) => {
    child.stdin!.write(`\x1b[200~${prompt}\x1b[201~`);
    await waitScreen(`the typed prompt ${prompt}`, (text) =>
      text.includes(prompt.slice(-24)),
    );
    child.stdin!.write("\r");
  };
  // The runner's own history, read directly, says when each run is over.
  const observer = new WorkspaceTerminal({
    url: runnerUrl,
    workspaceId: id,
    autoModelSelector: false,
  });
  cleanups.push(() => observer.close());
  await observer.connect();
  const history = (match: (event: WorkspaceEvent) => boolean) =>
    new Promise<WorkspaceEvent>((resolve) =>
      observer.subscribeWorkspaceEvents((event) => {
        if (match(event)) resolve(event);
      }),
    );
  // Each event-stream drop the attached terminal logged, oldest first.
  const streamDrops = async () =>
    (await readFile(join(stateHome, "adm", "terminal.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((record) => record.event === "event_stream_dropped");
  // A bash tool that blocks until `release()`, reporting when it started.
  const blockingTool = async () => {
    const fifo = join(directory, `release-${Date.now()}`);
    const marker = `${fifo}-started`;
    assert.equal((await once(spawn("mkfifo", [fifo]), "exit"))[0], 0);
    const changes = watch(directory, { signal: watchController.signal });
    const started = (async () => {
      for await (const event of changes)
        if (event.filename && join(directory, event.filename) === marker)
          return;
    })();
    return {
      command: `touch ${marker}; cat ${fifo}`,
      started,
      release: (text: string) => writeFile(fifo, text),
    };
  };
  await ready;
  return {
    proxyControl,
    screen,
    waitScreen,
    settledReply,
    submit,
    history,
    streamDrops,
    blockingTool,
    runnerErrors: () => runnerErrors,
    child,
  };
}

test(
  "a native terminal whose event stream is killed mid-turn shows it is disconnected, reconnects on its own, and shows the gap once",
  { timeout: 40000 },
  async (t) => {
    const attached = await attachThroughProxy(t, "stream-drop-killed");
    await attached.submit(fauxPrompt({ answer: "Reply before the drop" }));
    await attached.settledReply("Reply before the drop");

    const tool = await attached.blockingTool();
    const answered = attached.history(
      (event) =>
        event.kind === "assistant" &&
        event.data.text === "Reply sent while disconnected",
    );
    await attached.submit(
      fauxPrompt({
        calls: [{ tool: "bash", args: { command: tool.command } }],
        answer: "Reply sent while disconnected",
      }),
    );
    await tool.started;
    await attached.waitScreen("the running turn", (text) =>
      text.includes("Working"),
    );

    // The runner restarts: its stream is cut and reconnection fails until it
    // is back.
    attached.proxyControl.outage = true;
    attached.proxyControl.eventStreams.at(-1)!.response.destroy();
    const disconnected = await attached.waitScreen(
      "the disconnected state",
      (text) => text.includes("Ctrl+R to retry now"),
    );
    assert.match(
      disconnected,
      /Disconnected \(event stream failed: [^)]+\) · retrying every \d+s · Ctrl\+R to retry now · Connection unavailable/,
    );

    // The turn finishes while the terminal cannot see it.
    await tool.release("released-while-disconnected");
    await answered;
    attached.proxyControl.outage = false;

    const recovered = await attached.settledReply(
      "Reply sent while disconnected",
    );
    for (const text of [
      "Reply before the drop",
      "released-while-disconnected",
      "Reply\\u0020before\\u0020the\\u0020drop",
    ])
      assert.equal(occurrences(recovered, text), 1, recovered);

    // The recovered stream is live.
    await attached.submit(fauxPrompt({ answer: "Reply after recovering" }));
    await attached.settledReply("Reply after recovering");

    const drops = await attached.streamDrops();
    assert.equal(drops.length, 1, JSON.stringify(drops));
    assert.equal(drops[0].reason, "error");
    assert.equal(drops[0].workspaceId, "stream-drop-killed");
    assert.ok(Number.isSafeInteger(drops[0].upMs) && drops[0].upMs > 0);
    assert.match(
      attached.runnerErrors(),
      /"event":"workspace_events_closed"/,
      "the runner logs the stream it lost",
    );
  },
);

test(
  "a native terminal notices a silent half-open event stream within its keepalive deadline and reconnects",
  { timeout: 40000 },
  async (t) => {
    const attached = await attachThroughProxy(t, "stream-drop-silent");
    await attached.submit(fauxPrompt({ answer: "Reply before the silence" }));
    await attached.settledReply("Reply before the silence");

    // The connection stays open but nothing more arrives on it.
    const silent = attached.proxyControl.eventStreams.at(-1)!;
    silent.incoming.unpipe(silent.response);
    silent.incoming.pause();
    const silencedAt = Date.now();

    // A prompt still reaches the agent; its reply appears once the terminal
    // has noticed the silence and reconnected.
    await attached.submit(
      fauxPrompt({ answer: "Reply after a silent stream" }),
    );
    const recovered = await attached.settledReply(
      "Reply after a silent stream",
    );
    assert.equal(occurrences(recovered, "Reply before the silence"), 1);
    assert.ok(
      silent.response.destroyed,
      "the terminal closed the silent stream",
    );

    const drops = await attached.streamDrops();
    assert.equal(drops.length, 1, JSON.stringify(drops));
    assert.equal(drops[0].reason, "silence");
    assert.ok(drops[0].upMs > 0);
    assert.ok(
      Date.parse(drops[0].at) - silencedAt < 10 * keepaliveMs,
      `silence detected within a bounded time: ${JSON.stringify(drops[0])}`,
    );
  },
);
