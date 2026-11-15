// Every new shell in a coding workspace gets a fresh Infisical access token in
// INFISICAL_TOKEN (TASK-138): `/etc/zsh/zshenv` and `BASH_ENV` source
// `adm-infisical-env.sh`, which asks `adm-infisical-token` (projected Pod
// identity → `GET /v1/runtime/infisical/token`). Here a fake lifecycle serves
// that route and a fake Infisical serves the secrets the real CLI reads;
// ZDOTDIR/.zshenv stands in for /etc/zsh/zshenv, which the host owns.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";

const imageDirectory = dirname(new URL(import.meta.url).pathname);
const hook = join(imageDirectory, "adm-infisical-env.sh");
const remoteEnv = new URL("../packages/runner/src/remote-env-server.ts", import.meta.url).pathname;
const which = (name) =>
  promisify(execFile)("sh", ["-c", `command -v ${name}`])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
const zsh = await which("zsh");
const infisicalCli = await which("infisical");
const claude = await which("claude");

// One server is both the lifecycle controller (runtime token route) and the
// Infisical API (`GET /api/v4/secrets`, which only accepts tokens it issued).
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "adm-infisical-hook-"));
  const state = { mode: "configured", requests: 0, issued: [] };
  const server = createServer((request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v1/runtime/infisical/token") {
      state.requests += 1;
      if (request.headers.authorization !== "Bearer pod-identity")
        return reply(403, { error: { code: "RUNTIME_FORBIDDEN", message: "forbidden" } });
      if (state.mode === "not_configured")
        return reply(409, {
          error: { code: "INFISICAL_NOT_CONFIGURED", message: "Infisical is not connected: run adm infisical login" },
        });
      if (state.mode === "login_expired")
        return reply(409, {
          error: {
            code: "INFISICAL_LOGIN_EXPIRED",
            message: "Infisical refused machine identity client-1 (401 Invalid credentials): run adm infisical login",
          },
        });
      const token = `inf-fresh-${state.requests}`;
      state.issued.push(token);
      return reply(200, { token, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (request.url.startsWith("/api/v4/secrets")) {
      const url = new URL(request.url, "http://fake");
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      if (!state.issued.includes(token)) return reply(401, { message: "Token invalid" });
      if (url.searchParams.get("projectId") !== "P" || url.searchParams.get("environment") !== "dev")
        return reply(404, { message: "no such project environment" });
      return reply(200, {
        secrets: [
          {
            _id: "1", version: 1, workspace: "P", type: "shared", environment: "dev",
            secretKey: "FOO", secretValue: "bar-from-infisical", secretComment: "", secretPath: "/",
            skipMultilineEncoding: false, tags: [], secretValueHidden: false,
          },
        ],
        imports: [],
      });
    }
    reply(404, { message: "Not Found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const tokenFile = join(root, "pod-token");
  await writeFile(tokenFile, "pod-identity\n");
  const zdotdir = join(root, "zdotdir");
  await mkdir(zdotdir);
  // GLOBAL_RCS off: interactive zsh would otherwise read the host's
  // /etc/zsh/zshrc, which on Ubuntu runs compinit. On the CI runner compinit
  // finds an insecure fpath directory and, with no terminal, prints
  // "compinit: initialization aborted" to stderr, so the test was checking the
  // host's zsh config instead of the hook.
  await writeFile(join(zdotdir, ".zshenv"), `unsetopt GLOBAL_RCS\n. ${hook}\n`);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = {
    PATH: `${imageDirectory}:${process.env.PATH}`,
    HOME: root,
    ZDOTDIR: zdotdir,
    BASH_ENV: hook,
    ADM_LIFECYCLE_URL: url,
    ADM_LIFECYCLE_TOKEN_FILE: tokenFile,
  };
  return { root, env, state, url };
}

function run(command, args, env, { cwd } = {}) {
  const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
}

const shells = () => [
  ["bash -c", "bash", ["-c", "printenv INFISICAL_TOKEN"]],
  ...(zsh
    ? [
        ["zsh -c", zsh, ["-c", "printenv INFISICAL_TOKEN"]],
        ["interactive zsh", zsh, ["-i", "-c", "printenv INFISICAL_TOKEN"]],
      ]
    : []),
];

test("every new bash and zsh shell starts with a fresh cluster Infisical token", async (t) => {
  const { env, state } = await setup(t);
  const seen = new Set();
  for (const [name, command, args] of shells()) {
    const result = await run(command, args, env);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    assert.equal(result.stderr, "", name);
    const token = result.stdout.trim();
    assert.match(token, /^inf-fresh-\d+$/, name);
    assert.ok(!seen.has(token), `${name} reused ${token}`);
    seen.add(token);
  }
  assert.equal(state.requests, seen.size);
});

test("a token the user set wins; one the hook exported is replaced in the next shell", async (t) => {
  const { env, state } = await setup(t);
  for (const [name, command, args] of shells()) {
    const preset = await run(command, args, { ...env, INFISICAL_TOKEN: "user-set-token" });
    assert.equal(preset.stdout.trim(), "user-set-token", name);
  }
  assert.equal(state.requests, 0, "a user token is never even replaced by a request");
  for (const [name, command, args] of shells()) {
    const nested = await run(command, args, {
      ...env,
      INFISICAL_TOKEN: "inf-old-from-parent",
      ADM_INFISICAL_TOKEN_FROM_ADM: "1",
    });
    assert.match(nested.stdout.trim(), /^inf-fresh-\d+$/, name);
  }
});

test("not_configured is silent and leaves no token; other failures print one line and the shell still runs", async (t) => {
  const { env, state } = await setup(t);
  state.mode = "not_configured";
  for (const [name, command, args] of shells()) {
    const result = await run(command, [...args.slice(0, -1), "printenv INFISICAL_TOKEN; echo ran"], {
      ...env,
      INFISICAL_TOKEN: "inf-stale-from-parent",
      ADM_INFISICAL_TOKEN_FROM_ADM: "1",
    });
    assert.equal(result.stderr, "", name);
    assert.equal(result.stdout, "ran\n", name);
  }
  state.mode = "login_expired";
  for (const [name, command, args] of shells()) {
    const result = await run(command, [...args.slice(0, -1), "printenv INFISICAL_TOKEN; echo ran"], env);
    assert.equal(result.stdout, "ran\n", name);
    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 1, `${name}: ${result.stderr}`);
    assert.match(lines[0], /^adm-infisical-token: .*refused machine identity client-1.*run adm infisical login/);
  }
  // Outside a workspace Pod (no lifecycle URL) the hook says nothing.
  const { ADM_LIFECYCLE_URL: _unused, ...outside } = env;
  const quiet = await run("bash", ["-c", "echo ran"], outside);
  assert.deepEqual([quiet.stdout, quiet.stderr], ["ran\n", ""]);
});

test(
  "the real Infisical CLI run from a new shell reads secrets with the hook's token",
  { skip: infisicalCli ? false : "infisical is not on PATH" },
  async (t) => {
    const { env, url, root } = await setup(t);
    const result = await run(
      "bash",
      ["-c", `infisical run --domain ${url} --projectId P --env dev -- printenv FOO`],
      env,
      { cwd: root },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "bar-from-infisical", result.stderr);
  },
);

test("Pi's bash tool (the workspace execution server) sees the token", async (t) => {
  const { env, root } = await setup(t);
  // The Pod's runner executes Pi's bash tool through this server inside the
  // dev container; a string command runs as `/bin/bash -c COMMAND`.
  const server = spawn(process.execPath, ["--import", "tsx", remoteEnv, "--cwd", root], {
    env: { ...env, PATH: `${dirname(process.execPath)}:${env.PATH}` },
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  let stderr = "";
  server.stderr.on("data", (chunk) => (stderr += chunk));
  const lines = createInterface({ input: server.stdout });
  let output = "";
  const result = new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== 1) return;
      if (message.event === "output") output += message.text;
      else resolve(message);
    });
    server.once("exit", (code) => reject(new Error(`execution server exited ${code}: ${stderr}`)));
  });
  server.stdin.write(`${JSON.stringify({ id: 1, method: "exec", args: ["printenv INFISICAL_TOKEN", {}] })}\n`);
  const done = await result;
  assert.equal(done.ok, true, JSON.stringify(done) + stderr);
  assert.match(output.trim(), /^inf-fresh-\d+$/, JSON.stringify(done));
});

test(
  "Claude Code's Bash tool sees the token",
  { timeout: 120000, skip: claude ? false : "claude is not on PATH" },
  async (t) => {
    const { env, root } = await setup(t);
    const results = [];
    // A fake Anthropic API: asks for one Bash call, then records its result.
    const model = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (!request.url.startsWith("/v1/messages") || request.url.includes("count_tokens"))
        return response.writeHead(404).end();
      const body = JSON.parse(raw);
      const last = body.messages.at(-1);
      const toolResult = Array.isArray(last?.content)
        ? last.content.find((part) => part.type === "tool_result")
        : undefined;
      if (toolResult) results.push(toolResult);
      const wantsTool = !toolResult && body.tools?.some((tool) => tool.name === "Bash");
      const content = wantsTool
        ? [{ type: "tool_use", id: "toolu_env", name: "Bash", input: { command: "printenv INFISICAL_TOKEN", description: "print token" } }]
        : [{ type: "text", text: "done" }];
      const message = {
        id: "msg_fixture", type: "message", role: "assistant", model: body.model, content,
        stop_reason: wantsTool ? "tool_use" : "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify(message));
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: { ...message, content: [], stop_reason: null } });
      content.forEach((block, index) => {
        if (block.type === "text") {
          event("content_block_start", { index, content_block: { type: "text", text: "" } });
          event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
        } else {
          event("content_block_start", { index, content_block: { ...block, input: {} } });
          event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        }
        event("content_block_stop", { index });
      });
      event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
      event("message_stop", {});
      response.end();
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    t.after(() => {
      model.closeAllConnections();
      model.close();
    });
    const answer = await run(
      claude,
      ["-p", "print the token", "--allowedTools", "Bash"],
      {
        ...env,
        SHELL: zsh || "/bin/bash",
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`,
        ANTHROPIC_API_KEY: "sk-ant-fixture",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      },
      { cwd: root },
    );
    assert.equal(answer.code, 0, answer.stderr + answer.stdout);
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(JSON.stringify(results[0].content), /inf-fresh-\d+/, JSON.stringify(results[0]));
  },
);
