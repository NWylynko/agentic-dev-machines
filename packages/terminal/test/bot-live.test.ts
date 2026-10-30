import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { WorkspaceTerminal } from "../src/terminal.ts";
import { DurableInteractiveRuntime } from "../src/native-runtime.ts";
import { createProviderAuthAuthority } from "../../runner/src/provider-auth-authority.ts";
import {
  signInConnector,
  startMcpOAuthServer,
} from "../../runner/test/mcp-oauth-fixture.ts";
import {
  startPodLifecycle,
  startPodRunner,
} from "../../runner/test/pod-fixture.ts";

// Interpret Pi's main-screen CSI cursor moves/erases and skip SGR/mode/OSC codes.
// Assertions use the current screen, so a stale spinner or duplicate row fails.
class BotPtyScreen {
  private lines: string[][] = [[]];
  private row = 0;
  private column = 0;
  private pending = "";
  write(chunk: string) {
    this.pending += chunk;
    while (this.pending) {
      if (this.pending.startsWith("\x1b[")) {
        const sequence = /^\x1b\[([0-9;?:><]*)([@-~])/.exec(this.pending);
        if (!sequence) return;
        this.pending = this.pending.slice(sequence[0].length);
        const [count = 0, column = 0] = sequence[1]!.split(";").map(Number);
        const line = (this.lines[this.row] ??= []);
        switch (sequence[2]) {
          case "A":
            this.row = Math.max(0, this.row - (count || 1));
            break;
          case "B":
            this.row += count || 1;
            break;
          case "C":
            this.column += count || 1;
            break;
          case "D":
            this.column = Math.max(0, this.column - (count || 1));
            break;
          case "G":
            this.column = Math.max(0, count - 1);
            break;
          case "H":
          case "f":
            this.row = Math.max(0, count - 1);
            this.column = Math.max(0, column - 1);
            break;
          case "J":
            if (count === 2 || count === 3) this.lines = [];
            else {
              line.length = this.column;
              this.lines.length = this.row + 1;
            }
            break;
          case "K":
            if (count === 2) this.lines[this.row] = [];
            else if (count === 1) line.fill(" ", 0, this.column + 1);
            else line.length = this.column;
            break;
        }
      } else if (this.pending.startsWith("\x1b]")) {
        const end = /\x07|\x1b\\/.exec(this.pending);
        if (!end) return;
        this.pending = this.pending.slice(end.index + end[0].length);
      } else if (this.pending.startsWith("\x1b")) {
        if (this.pending.length < 2) return;
        this.pending = this.pending.slice(2);
      } else {
        const character = String.fromCodePoint(this.pending.codePointAt(0)!);
        this.pending = this.pending.slice(character.length);
        if (character === "\r") this.column = 0;
        else if (character === "\n") this.row++;
        else if (character === "\b") this.column = Math.max(0, this.column - 1);
        else if (character >= " ") {
          const width = visibleWidth(character);
          if (this.column + width > 80) {
            this.row++;
            this.column = 0;
          }
          const line = (this.lines[this.row] ??= []);
          line[this.column] = character;
          for (let index = 1; index < width; index++)
            line[this.column + index] = "";
          this.column += width;
        }
      }
    }
  }
  text() {
    return this.lines
      .map((line) => line?.join("") ?? "")
      .join("\n")
      .replace(/\s+/g, " ");
  }
}

test(
  "native bot attach renders live onboarding, published replies, and private working activity across reconnect",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-bot-live-"));
    // A private, gated tool round comes from an installation MCP connector,
    // so the bot runs as a lifecycle-owned Pod runtime.
    let release: ((text: string) => void) | undefined;
    let started = () => {};
    let toolStarted = new Promise<void>((resolve) => (started = resolve));
    const gate = await startMcpOAuthServer({
      onWait: (reply) => {
        release = reply;
        started();
      },
    });
    const authority = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
    });
    await new Promise<void>((resolve) =>
      authority.server.listen(0, "127.0.0.1", () => resolve()),
    );
    const authorityUrl = `http://127.0.0.1:${(authority.server.address() as { port: number }).port}`;
    await fetch(`${authorityUrl}/v1/connectors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "gate", url: gate.url }),
    });
    await signInConnector(authorityUrl, gate, "gate");
    const lifecycle = await startPodLifecycle({ authorityUrl });
    const bot = await startPodRunner(directory, lifecycle, {
      id: "live-bot",
      name: "Live bot",
      role: "bot",
      model: false,
    });
    t.after(async () => {
      await bot.stop();
      await lifecycle.close();
      await authority.close();
      await gate.close();
      await rm(directory, { recursive: true });
    });
    const url = bot.url;
    const errors = () => bot.errors;
    const request = async (suffix: string, method = "GET", body?: unknown) => {
      const response = await bot.request(suffix, method, body);
      assert.ok(
        response.status < 300,
        `${method} ${suffix}: ${response.status} ${JSON.stringify(response.body)}`,
      );
      return response.body;
    };
    let ready = () => {};
    let startup = new Promise<void>((resolve) => (ready = resolve));
    const proxy = createServer((req, res) => {
      if (req.url?.includes("/models?refresh=true")) ready();
      const upstream = httpRequest(
        new URL(req.url!, url),
        { method: req.method, headers: req.headers },
        (incoming) => {
          res.writeHead(incoming.statusCode!, incoming.headers);
          res.flushHeaders();
          incoming.pipe(res);
        },
      );
      upstream.on("error", (error) => res.destroy(error));
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    t.after(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
    const attach = () => {
      const args = [
        process.execPath,
        "--import",
        "tsx",
        new URL("../src/main.ts", import.meta.url).pathname,
        "--url",
        `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
        "--workspace",
        "live-bot",
        "--token-file",
        bot.tokenFile,
      ];
      const child = spawn(
        "script",
        [
          "--quiet",
          "--return",
          "--command",
          `stty cols 80 rows 100 && exec ${args.map(quote).join(" ")}`,
          "/dev/null",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          env: {
            ...process.env,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, "client"),
          },
        },
      );
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      });
      let output = "";
      const screen = new BotPtyScreen();
      child.stdout.on("data", (chunk) => {
        output += chunk;
        screen.write(chunk.toString());
      });
      child.stderr.on("data", (chunk) => (output += chunk));
      const text = () => stripTerminalSequences(output).replace(/\s+/g, " ");
      const waitForScreen = (
        predicate: (text: string) => boolean,
        description: string,
      ) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Missing bot screen ${description}: ${screen.text()}; output=${text()}; runner=${errors()}`,
                ),
              ),
            5000,
          );
          const check = () => {
            if (predicate(screen.text())) {
              clearTimeout(timer);
              child.stdout.off("data", check);
              resolve();
            }
          };
          child.stdout.on("data", check);
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Bot terminal exited ${code}: ${text()}`));
          });
          check();
        });
      return {
        child,
        text,
        screen,
        waitFor: (text: string) =>
          waitForScreen((screen) => screen.includes(text), text),
        waitForIdle: () =>
          waitForScreen(
            (screen) => !screen.includes("Working"),
            "Working cleared",
          ),
      };
    };
    const first = attach();
    await startup;
    await request("/model", "PUT", { provider: "faux", modelId: "faux-1" });
    const question = "What identity and purpose would you like me to have?";
    await first.waitFor(question);
    assert.doesNotMatch(first.text(), /I am ready for setup details\./);

    const transport = new WorkspaceTerminal({
      url,
      workspaceId: "live-bot",
      autoModelSelector: false,
      tokenFile: bot.tokenFile,
    });
    const runtime = new DurableInteractiveRuntime(transport);
    t.after(async () => {
      await runtime.dispose();
      transport.close();
    });
    await transport.connect();
    await runtime.initialize();
    const delivered: string[] = [];
    let complete = () => {};
    const published = new Promise<void>((resolve) => (complete = resolve));
    runtime.sessionProjection().subscribe((event) => {
      if (
        (event.type === "message_start" || event.type === "message_end") &&
        event.message.role === "custom"
      ) {
        delivered.push(`${event.type}:${event.message.content}`);
        if (event.type === "message_end") complete();
      }
    });
    const reply = "Public reply arrives while attached";
    const prompt =
      "/faux " +
      JSON.stringify({
        calls: [
          {
            tool: "codemode",
            args: {
              code: 'await tools.sendMessage({text: "Public reply arrives" + " while attached"})',
            },
          },
        ],
        answer: "PRIVATE_LIVE_BOT_MODEL_OUTPUT",
      });
    first.child.stdin.write(`\x1b[200~${prompt}\x1b[201~`);
    await first.waitFor("PRIVATE_LIVE_BOT_MODEL_OUTPUT"); // the user's editor input, not model output
    first.child.stdin.write("\r");
    await published;
    await first.waitFor(reply);
    const history = await request("/history");
    assert.equal(
      history.events.filter(
        (event: any) => event.kind === "message" && event.data.text === reply,
      ).length,
      1,
    );
    assert.deepEqual(delivered, [
      `message_start:${reply}`,
      `message_end:${reply}`,
    ]);
    await transport.connect();
    assert.deepEqual(
      delivered,
      [`message_start:${reply}`, `message_end:${reply}`],
      "cursor replay must not republish custom messages",
    );
    assert.equal(
      runtime
        .sessionProjection()
        .messages.filter(
          (message) => message.role === "custom" && message.content === reply,
        ).length,
      1,
    );

    const exited = once(first.child, "exit");
    first.child.stdin.write("\x03");
    assert.equal((await exited)[0], 0);
    startup = new Promise<void>((resolve) => (ready = resolve));
    const second = attach();
    await startup;
    await second.waitFor(question);
    await second.waitFor(reply);
    assert.equal(second.screen.text().split(question).length - 1, 1);
    assert.equal(second.screen.text().split(reply).length - 1, 1);
    assert.equal(
      runtime
        .sessionProjection()
        .messages.filter(
          (message) =>
            message.role === "custom" && message.content === question,
        ).length,
      1,
    );

    const events: string[] = [];
    let settled = () => {};
    let working = () => {};
    let active = new Promise<void>((resolve) => (working = resolve));
    let idle = new Promise<void>((resolve) => (settled = resolve));
    runtime.sessionProjection().subscribe((event) => {
      events.push(event.type);
      if (event.type === "turn_start") working();
      if (event.type === "agent_settled") settled();
    });
    await request("/input", "POST", {
      requestId: "bot-working-success",
      message:
        "/faux " +
        JSON.stringify({
          calls: [{ tool: "mcp_gate_wait", args: {} }],
          answer: "PRIVATE_ACTIVITY_MODEL_OUTPUT",
        }),
    });
    await Promise.all([toolStarted, active]);
    assert.equal(
      runtime.sessionProjection().isStreaming,
      true,
      "bot remains working while its private tool runs",
    );
    await second.waitFor("Working");
    const secondExit = once(second.child, "exit");
    second.child.stdin.write("\x03");
    assert.equal((await secondExit)[0], 0);
    startup = new Promise<void>((resolve) => (ready = resolve));
    const third = attach();
    await startup;
    await third.waitFor("Working");
    release!("PRIVATE_GATE_TOOL_RESULT");
    await idle;
    await third.waitForIdle();
    assert.equal(runtime.sessionProjection().isStreaming, false);
    assert.deepEqual(
      events.filter((type) =>
        ["agent_start", "turn_start", "agent_end", "agent_settled"].includes(
          type,
        ),
      ),
      ["agent_start", "turn_start", "agent_end", "agent_settled"],
    );

    idle = new Promise<void>((resolve) => (settled = resolve));
    toolStarted = new Promise<void>((resolve) => (started = resolve));
    active = new Promise<void>((resolve) => (working = resolve));
    await request("/input", "POST", {
      requestId: "bot-working-error",
      message:
        "/faux-fail-after-tools " +
        JSON.stringify({ calls: [{ tool: "mcp_gate_wait", args: {} }] }),
    });
    await Promise.all([toolStarted, active]);
    await third.waitFor("Working");
    release!("PRIVATE_GATE_TOOL_RESULT");
    await idle;
    await third.waitForIdle();
    assert.equal(
      runtime.sessionProjection().isStreaming,
      false,
      "provider failure clears bot activity",
    );

    toolStarted = new Promise<void>((resolve) => (started = resolve));
    active = new Promise<void>((resolve) => (working = resolve));
    idle = new Promise<void>((resolve) => (settled = resolve));
    await request("/input", "POST", {
      requestId: "bot-working-abort",
      message:
        "/faux " +
        JSON.stringify({
          calls: [{ tool: "mcp_gate_wait", args: {} }],
          answer: "PRIVATE_ABORTED_MODEL_OUTPUT",
        }),
    });
    await Promise.all([toolStarted, active]);
    assert.equal(runtime.sessionProjection().isStreaming, true);
    await third.waitFor("Working");
    await request("/abort", "POST", {});
    await idle;
    await third.waitForIdle();
    assert.equal(
      runtime.sessionProjection().isStreaming,
      false,
      "explicit abort clears bot activity",
    );
    release!("PRIVATE_GATE_TOOL_RESULT");
    assert.doesNotMatch(third.text(), /PRIVATE_GATE_TOOL_RESULT/);
    assert.ok(
      runtime
        .sessionProjection()
        .messages.every((message) => ["user", "custom"].includes(message.role)),
      "bot chat keeps ordinary model output and tool activity private",
    );
  },
);
