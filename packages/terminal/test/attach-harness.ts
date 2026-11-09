// A real runner behind a forwarding proxy (standing in for `kubectl
// port-forward`), and native Pi terminals (`adm attach`) in real PTYs, their
// screens emulated by @xterm/headless.
import { type TestContext } from "node:test";
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
import type { EntryRecord } from "@earendil-works/pi-durable";
import { WorkspaceConnection } from "../src/workspace-connection.ts";
import { viewEntries } from "../src/pi-view-events.ts";
import { TERMINAL_WAIT_MS } from "./wait-budget.ts";

// The runner declares this keepalive on its event stream; the attached
// terminal treats three silent intervals as a dead stream.
export const keepaliveMs = 200;

export const visibleText = (text: string) =>
  stripTerminalSequences(text).replace(/\s+/g, " ");
export const occurrences = (text: string, part: string) =>
  text.split(part).length - 1;
// The prompt spells the answer's spaces as JSON escapes, so the reply text
// appears on screen only where Pi renders the reply itself.
export const fauxPrompt = (plan: {
  calls?: { tool: string; args: Record<string, string> }[];
  answer: string;
}) =>
  "/faux " +
  JSON.stringify(plan).replace(
    JSON.stringify(plan.answer),
    JSON.stringify(plan.answer).replaceAll(" ", "\\u0020"),
  );
export const assistantText = (entry: EntryRecord) => {
  const message = entry.model?.[0];
  return message?.role === "assistant"
    ? message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    : undefined;
};

type EventStreamThroughProxy = {
  incoming: IncomingMessage;
  response: ServerResponse;
};

export type WorkspaceOptions = {
  role?: "coding" | "bot";
  /** The workspace's model; null registers it without one. */
  model?: { provider: string; id: string } | null;
};

/** One coding or bot workspace on a real runner, reached through a proxy. */
export async function startWorkspace(
  t: TestContext,
  id: string,
  {
    role = "coding",
    model = { provider: "faux", id: "faux-1" },
  }: WorkspaceOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "adm-attach-"));
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
      role,
      environment: "local",
      ...(role === "coding" ? { localRoot: root } : {}),
      ...(model ? { model } : {}),
    }),
  });
  assert.equal(registered.status, 200);

  // While `outage` is set the proxy answers every request with 503, as a
  // forward to a restarting runner would fail. `override` answers a request
  // itself when it returns a response.
  type ProxiedRequest = { method: string; path: string };
  const requestWaiters = new Set<(request: ProxiedRequest) => void>();
  const proxyControl = {
    outage: false,
    eventStreams: [] as EventStreamThroughProxy[],
    requests: [] as ProxiedRequest[],
    override: (_request: ProxiedRequest) =>
      undefined as { status: number; body: unknown } | undefined,
    /** The next request from now that matches. */
    nextRequest: (match: (request: ProxiedRequest) => boolean) =>
      new Promise<ProxiedRequest>((resolve) => {
        const waiter = (request: ProxiedRequest) => {
          if (!match(request)) return;
          requestWaiters.delete(waiter);
          resolve(request);
        };
        requestWaiters.add(waiter);
      }),
  };
  const proxy = createServer((req, res) => {
    const url = new URL(req.url!, runnerUrl);
    const seen = { method: req.method!, path: url.pathname + url.search };
    proxyControl.requests.push(seen);
    for (const waiter of requestWaiters) waiter(seen);
    const overridden = proxyControl.outage
      ? {
          status: 503,
          body: {
            error: { code: "FIXTURE_OUTAGE", message: "runner unavailable" },
          },
        }
      : proxyControl.override(seen);
    if (overridden) {
      res.writeHead(overridden.status, { "content-type": "application/json" });
      res.end(JSON.stringify(overridden.body));
      return;
    }
    const upstream = httpRequest(
      url,
      { method: req.method, headers: req.headers },
      (incoming) => {
        res.writeHead(incoming.statusCode!, incoming.headers);
        res.flushHeaders();
        if (url.pathname.endsWith("/events"))
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
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

  // The runner's own view, read directly with diagnostics, says when each
  // run is over.
  const observer = new WorkspaceConnection({
    url: runnerUrl,
    workspaceId: id,
    diagnostics: true,
  });
  cleanups.push(() => observer.close());
  await observer.connect();
  const entry = (match: (entry: EntryRecord) => boolean) =>
    new Promise<EntryRecord>((resolve) => {
      const found = () => viewEntries(observer.view).find(match);
      const now = found();
      if (now) return resolve(now);
      const stop = observer.subscribeView(() => {
        const later = found();
        if (!later) return;
        stop();
        resolve(later);
      });
    });
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
  let terminals = 0;
  // A native terminal attached in a PTY. Each has its own client state.
  const attach = async ({
    diagnostics = false,
    terminalArgs = [] as string[],
  } = {}) => {
    const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
    const args = [
      process.execPath,
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "--url",
      proxyUrl,
      "--workspace",
      id,
      ...(diagnostics ? ["--diagnostics"] : []),
      ...terminalArgs,
    ];
    const client = join(directory, `client-${++terminals}`);
    const stateHome = join(client, "state");
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
          HOME: client,
          XDG_CONFIG_HOME: join(client, "config"),
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
    const exit = once(child, "exit").then(([code]) => code as number | null);
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
    const waitScreen = (
      description: string,
      ready: (text: string) => boolean,
    ) =>
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
          TERMINAL_WAIT_MS,
        ).unref();
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
    // A settled turn: its reply is on screen exactly once, Pi shows no
    // working indicator, and the terminal is connected.
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
    // Each event-stream drop this terminal logged, oldest first.
    const streamDrops = async () =>
      (await readFile(join(stateHome, "adm", "terminal.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((record) => record.event === "event_stream_dropped");
    // Detach as a user does: Ctrl+C on an empty editor.
    const detach = async () => {
      child.stdin!.write("\x03");
      return exit;
    };
    return {
      child,
      screen,
      waitScreen,
      settledReply,
      submit,
      streamDrops,
      detach,
      exit,
    };
  };
  return {
    id,
    runnerUrl,
    proxyUrl,
    directory,
    root,
    proxyControl,
    entry,
    blockingTool,
    attach,
    runnerErrors: () => runnerErrors,
  };
}

/** A workspace with one native terminal attached, its models loaded. */
export async function attachThroughProxy(
  t: TestContext,
  id: string,
  options: WorkspaceOptions & { diagnostics?: boolean } = {},
) {
  const workspace = await startWorkspace(t, id, options);
  // Pi refreshes the catalog once InteractiveMode is running.
  const running = workspace.proxyControl.nextRequest((request) =>
    request.path.includes("/models?refresh=true"),
  );
  const terminal = await workspace.attach({
    diagnostics: options.diagnostics,
  });
  await running;
  return { ...workspace, ...terminal };
}
