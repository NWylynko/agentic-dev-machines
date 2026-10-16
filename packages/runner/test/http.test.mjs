import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  watch,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

const main = new URL("../src/main.ts", import.meta.url);

async function startRunner(directory, env = {}) {
  const child = spawn(
    process.execPath,
    [
      main.pathname,
      "--port",
      "0",
      "--state-dir",
      directory,
      "--provider",
      "faux",
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Runner exited ${code}: ${errors}`)),
    );
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.ready) resolve(value);
      } catch {
        /* Other stdout is diagnostic. */
      }
    });
  });
  const { url } = await ready;
  return {
    url,
    child,
    async stop(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        await exited;
      }
      lines.close();
    },
    async request(path, method = "GET", body, signal) {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function nextEvent(
  runner,
  id,
  predicate,
  after = 0,
  diagnostics = false,
  timeoutMs = 0,
) {
  const controller = new AbortController();
  const timeout = timeoutMs
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  const response = await fetch(
    `${runner.url}/v1/workspaces/${id}/events?after=${after}&diagnostics=${diagnostics}`,
    { signal: controller.signal },
  );
  assert.equal(response.status, 200);
  let buffer = "";
  try {
    for await (const bytes of response.body) {
      buffer += Buffer.from(bytes).toString();
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (data) {
          const event = JSON.parse(data.slice(6));
          if (predicate(event)) return event;
        }
      }
    }
    throw new Error("Event stream ended before the expected event");
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
  }
}

test(
  "a client can detach, deduplicate input, recover history after SIGKILL, and permanently delete a named workspace",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-http-"));
    let runner = await startRunner(directory);
    t.after(async () => runner.stop());
    const id = "workspace-http-history";
    const path = `/v1/workspaces/${id}`;
    const config = {
      id,
      name: "history",
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    };
    assert.equal((await runner.request("/health")).body.status, "ok");
    assert.equal((await runner.request(path, "PUT", config)).status, 200);
    assert.equal((await runner.request(path, "PUT", config)).status, 200);
    const first = await runner.request(path + "/input", "POST", {
      message: "Remember the blue submarine",
      requestId: "input-1",
    });
    const duplicate = await runner.request(path + "/input", "POST", {
      message: "Remember the blue submarine",
      requestId: "input-1",
    });
    assert.equal(first.status, 202);
    assert.equal(duplicate.body.submissionId, first.body.submissionId);
    const answer = await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" &&
        event.data.text.includes("blue submarine"),
    );
    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    const history = await runner.request(path + "/history");
    assert.equal(history.status, 200);
    assert.equal(
      history.body.events.filter((event) => event.kind === "user").length,
      1,
    );
    assert.ok(
      history.body.events.some(
        (event) =>
          event.seq === answer.seq &&
          event.data.text.includes("blue submarine"),
      ),
    );
    assert.equal(
      (
        await runner.request(path + "/input", "POST", {
          message: "Remember the blue submarine",
          requestId: "input-1",
        })
      ).body.submissionId,
      first.body.submissionId,
    );
    assert.equal((await runner.request(path, "DELETE")).status, 200);
    assert.equal(
      (await runner.request(path + "/input", "POST", { message: "resurrect" }))
        .status,
      410,
    );
    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    assert.equal((await runner.request(path, "PUT", config)).status, 410);
    assert.equal((await runner.request(path, "DELETE")).status, 200);
  },
);

test("malformed path encoding is reported as a client error without terminating the runner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-path-"));
  const runner = await startRunner(directory);
  t.after(() => runner.stop());

  const malformed = await runner.request("/v1/workspaces/%E0%A4%A");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_ID");
  assert.equal((await runner.request("/health")).status, 200);
});

test(
  "provider failure survives restart and explicit resume succeeds without repeating completed tools",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-resume-"));
    let runner = await startRunner(directory);
    t.after(() => runner.stop());
    const id = "resume-coder",
      path = `/v1/workspaces/${id}`;
    const config = {
      id,
      name: "resume",
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    };
    assert.equal((await runner.request(path, "PUT", config)).status, 200);

    await runner.request(path + "/input", "POST", {
      message: "/faux-fail-once finish the pending request",
      requestId: "provider-failure",
    });
    const failure = await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" && event.data.stopReason === "error",
    );
    const failedStatus = await runner.request(path);
    assert.equal(failedStatus.body.status, "error");
    assert.match(
      failedStatus.body.error,
      /authentication credentials are invalid/i,
    );

    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    const recovered = await runner.request(path);
    assert.equal(recovered.body.status, "error");
    assert.equal(recovered.body.error, failure.data.error);
    const resumed = await runner.request(path + "/resume", "POST", {});
    assert.equal(resumed.status, 202);
    const duplicate = await runner.request(path + "/resume", "POST", {});
    assert.equal(duplicate.body.submissionId, resumed.body.submissionId);
    await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" &&
        event.seq > failure.seq &&
        event.data.stopReason === "stop",
      failure.seq,
    );
    const completed = await runner.request(path);
    assert.equal(completed.body.status, "idle");
    assert.equal(completed.body.error, undefined);

    const sideEffect = join(directory, "other-repo", "already-ran.txt");
    const afterToolId = "resume-after-tool",
      afterToolPath = `/v1/workspaces/${afterToolId}`;
    const afterToolConfig = {
      ...config,
      id: afterToolId,
      name: "resume-after-tool",
      localRoot: join(directory, "other-repo"),
    };
    await runner.request(afterToolPath, "PUT", afterToolConfig);
    const faultPlan = {
      calls: [
        {
          tool: "write",
          args: { path: sideEffect, content: "completed once" },
        },
      ],
    };
    await runner.request(afterToolPath + "/input", "POST", {
      message: "/faux-fail-after-tools " + JSON.stringify(faultPlan),
      requestId: "tool-before-provider-failure",
    });
    const afterToolFailure = await nextEvent(
      runner,
      afterToolId,
      (event) =>
        event.kind === "assistant" && event.data.stopReason === "error",
    );
    assert.equal(await readFile(sideEffect, "utf8"), "completed once");
    const unsafeResume = await runner.request(
      afterToolPath + "/resume",
      "POST",
      {},
    );
    assert.equal(unsafeResume.status, 409);
    assert.equal(unsafeResume.body.error.code, "RESUME_AFTER_TOOL_EFFECT");
    assert.equal(
      (
        await runner.request(
          afterToolPath + "/history?after=" + afterToolFailure.seq,
        )
      ).body.events.filter((event) => event.kind === "tool").length,
      0,
    );
    assert.equal(await readFile(sideEffect, "utf8"), "completed once");
  },
);

test("runner state and per-workspace durable files are private and the owner lock records process identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-private-"));
  const runner = await startRunner(directory);
  t.after(() => runner.stop());
  await assert.rejects(
    startRunner(directory),
    /Another runner owns this state directory/,
  );
  const id = "private-state",
    path = `/v1/workspaces/${id}`;
  const config = {
    id,
    name: "private-state",
    role: "coding",
    environment: "local",
    localRoot: join(directory, "repo"),
    model: { provider: "faux", id: "faux-1" },
  };
  await runner.request(path, "PUT", config);
  const owner = JSON.parse(
    await readFile(join(directory, "owner.json"), "utf8"),
  );
  assert.equal(owner.pid, runner.child.pid);
  assert.equal(typeof owner.processStart, "string");
  for (const pathToCheck of [
    directory,
    join(directory, "sessions", id),
    join(directory, "tombstones"),
  ])
    assert.equal((await stat(pathToCheck)).mode & 0o777, 0o700, pathToCheck);
  assert.equal((await stat(join(directory, "owner.json"))).mode & 0o777, 0o600);
  assert.equal(
    (await stat(join(directory, "sessions", id, "session.sqlite"))).mode &
      0o777,
    0o600,
  );
});

test("a stale legacy PID-only owner lock is reclaimed after its process exits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-stale-owner-"));
  await writeFile(
    join(directory, "owner.json"),
    JSON.stringify({ pid: 2147483647 }),
    { mode: 0o600 },
  );
  const runner = await startRunner(directory);
  t.after(() => runner.stop());
  const owner = JSON.parse(
    await readFile(join(directory, "owner.json"), "utf8"),
  );
  assert.equal(owner.pid, runner.child.pid);
  assert.equal(typeof owner.processStart, "string");
});

export { startRunner, nextEvent };

test(
  "bot onboarding is admitted once, publishes setup through sendMessage, and keeps its profile after restart",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-bot-onboarding-"),
    );
    let runner = await startRunner(directory);
    t.after(async () => runner.stop());
    const bot = {
      id: "onboarding-bot",
      name: "watcher",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
    };
    const path = `/v1/workspaces/${bot.id}`;
    assert.equal((await runner.request(path, "PUT", bot)).status, 200);
    await runner.request(path, "PUT", bot);
    const onboarding = await nextEvent(
      runner,
      bot.id,
      (event) =>
        event.kind === "user" && event.data.text.includes("onboarding"),
    );
    const published = await nextEvent(
      runner,
      bot.id,
      (event) =>
        event.kind === "message" &&
        event.data.text.includes("identity and purpose"),
      onboarding.seq,
    );
    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    assert.equal((await runner.request(path, "PUT", bot)).status, 200);
    assert.equal((await runner.request(path)).body.profile.state, "collecting");
    const interruptedHistory = await runner.request(
      path + "/history?limit=1000",
    );
    assert.equal(
      interruptedHistory.body.events.filter(
        (event) =>
          event.kind === "user" && event.data.text.includes("onboarding"),
      ).length,
      1,
    );
    const setup = {
      calls: [
        {
          tool: "saveProfile",
          args: {
            identity: "Build monitor",
            purpose: "Track build health and report failures.",
          },
        },
      ],
      answer: "Setup saved.",
    };
    await runner.request(path + "/input", "POST", {
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            {
              tool: "saveProfile",
              args: { identity: "  ", purpose: "   " },
            },
          ],
          answer: "Invalid profile rejected.",
        }),
      requestId: "reject-empty-profile",
    });
    const invalidProfile = await nextEvent(
      runner,
      bot.id,
      (event) => event.kind === "tool" && event.data.name === "saveProfile",
      interruptedHistory.body.nextAfter,
      true,
    );
    assert.equal(invalidProfile.data.isError, true);
    assert.equal((await runner.request(path)).body.profile.state, "collecting");
    await runner.request(path + "/input", "POST", {
      message: "/faux " + JSON.stringify(setup),
      requestId: "finish-onboarding",
    });
    const saved = await nextEvent(
      runner,
      bot.id,
      (event) => event.kind === "tool" && event.data.name === "saveProfile",
      invalidProfile.seq,
      true,
    );
    assert.equal(saved.data.isError, false);
    const ready = await runner.request(path);
    assert.equal(ready.body.profile.state, "ready");
    assert.equal(ready.body.profile.identity, "Build monitor");
    assert.equal(
      ready.body.profile.purpose,
      "Track build health and report failures.",
    );

    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    assert.equal((await runner.request(path, "PUT", bot)).status, 200);
    const history = await runner.request(path + "/history?limit=1000");
    assert.equal(
      history.body.events.filter(
        (event) =>
          event.kind === "user" && event.data.text.includes("onboarding"),
      ).length,
      1,
    );
    assert.ok(history.body.events.some((event) => event.seq === published.seq));
    assert.deepEqual(
      (await runner.request(path)).body.profile,
      ready.body.profile,
    );
    const beforePromptCheck = await runner.request(
      path + "/history?limit=1000&diagnostics=true",
    );
    await runner.request(path + "/input", "POST", {
      message: "/faux-inspect-system-prompt",
      requestId: "inspect-saved-profile",
    });
    const prompt = await nextEvent(
      runner,
      bot.id,
      (event) =>
        event.kind === "assistant" && event.data.text.includes("Build monitor"),
      beforePromptCheck.body.nextAfter,
      true,
      5000,
    );
    assert.ok(
      prompt.data.text.includes("Track build health and report failures."),
      prompt.data.text,
    );
  },
);

test(
  "legacy bots without a profile are not prompted for setup after upgrade",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-legacy-bot-"));
    let runner = await startRunner(directory);
    t.after(async () => runner.stop());
    const bot = {
      id: "legacy-bot",
      name: "legacy",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
    };
    const path = `/v1/workspaces/${bot.id}`;
    assert.equal((await runner.request(path, "PUT", bot)).status, 200);
    await nextEvent(
      runner,
      bot.id,
      (event) =>
        event.kind === "message" &&
        /identity and purpose/i.test(event.data.text),
    );

    await runner.stop("SIGTERM");
    const database = new DatabaseSync(
      join(directory, "sessions", bot.id, "session.sqlite"),
    );
    database.exec(`
      DELETE FROM document_revisions
      WHERE document_id IN (SELECT id FROM documents WHERE kind = '"adm.bot-profile"');
      DELETE FROM documents WHERE kind = '"adm.bot-profile"';
    `);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM documents WHERE kind = '\"adm.bot-profile\"'",
        )
        .get().count,
      0,
    );
    database.close();
    const registryPath = join(directory, "workspaces.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    delete registry[0].onboardingRequired;
    await writeFile(registryPath, JSON.stringify(registry));

    runner = await startRunner(directory);
    assert.equal((await runner.request(path, "PUT", bot)).status, 200);
    assert.equal((await runner.request(path)).body.profile, undefined);
    const before = await runner.request(
      path + "/history?diagnostics=true&limit=1000",
    );
    await runner.request(path + "/input", "POST", {
      message: "/faux-inspect-system-prompt",
      requestId: "legacy-prompt",
    });
    const prompt = await nextEvent(
      runner,
      bot.id,
      (event) => event.kind === "assistant",
      before.body.nextAfter,
      true,
      5000,
    );
    assert.doesNotMatch(prompt.data.text, /You are a bot being set up/);
    const history = await runner.request(path + "/history?limit=1000");
    assert.equal(
      history.body.events.filter(
        (event) =>
          event.kind === "user" && event.data.text.includes("onboarding"),
      ).length,
      1,
    );
  },
);

test(
  "a bot can call only host-granted stdio MCP tools with referenced secrets through Durable and Code Mode",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-bot-mcp-"));
    const fixture = join(directory, "mcp-fixture.mjs");
    const starts = join(directory, "mcp-starts.txt");
    const registrySeen = join(directory, "registry-seen.txt");
    await writeFile(
      fixture,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const starts = ${JSON.stringify(starts)};
const registryPath = ${JSON.stringify(join(directory, "workspaces.json"))};
const registrySeen = ${JSON.stringify(registrySeen)};
appendFileSync(starts, "start\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => { appendFileSync(starts, "exit\\n"); process.exit(0); });
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\\n");
    if (end < 0) break;
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (!("id" in message)) continue;
    let result;
    if (message.method === "initialize") {
      const registered = JSON.parse(readFileSync(registryPath, "utf8")).some((entry) => entry.id === "mcp-bot" && entry.mcpServers?.[0]?.tools?.includes("allowed_lookup"));
      appendFileSync(registrySeen, String(registered));
      result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    }
    else if (message.method === "tools/list") result = { tools: [
      { name: "allowed_lookup", description: "Read an allowed fixture value", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "denied_write", description: "Must stay unavailable", inputSchema: { type: "object", properties: {} } },
      { name: "drop_connection", description: "Ends the fixture process", inputSchema: { type: "object", properties: {} } },
      { name: "hang", description: "Waits until the caller is cancelled", inputSchema: { type: "object", properties: {} } }
    ] };
    else if (message.method === "tools/call" && message.params.name === "allowed_lookup") result = { content: [{ type: "text", text: JSON.stringify({ query: message.params.arguments.query, injected: process.env.MCP_TOKEN === "fixture-secret", providerSecretForwarded: process.env.PROVIDER_SECRET !== undefined }) }] };
    else if (message.method === "tools/call" && message.params.name === "drop_connection") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Connection is closing." }] } }) + "\\n", () => process.exit(0));
      return;
    }
    else if (message.method === "tools/call" && message.params.name === "hang") {
      appendFileSync(starts, "hang\\n");
      return;
    }
    else result = { content: [{ type: "text", text: "unexpected tool" }], isError: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
    );
    await chmod(fixture, 0o700);
    const runnerEnv = {
      INJECTED_MCP_SECRET: "fixture-secret",
      PROVIDER_SECRET: "must-not-forward",
    };
    let runner = await startRunner(directory, runnerEnv);
    t.after(async () => runner.stop());
    const bot = {
      id: "mcp-bot",
      name: "lookup bot",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
      mcpServers: [
        {
          id: "fixture",
          command: fixture,
          tools: ["allowed_lookup", "hang"],
          secretEnv: { MCP_TOKEN: "INJECTED_MCP_SECRET" },
        },
      ],
    };
    const path = `/v1/workspaces/${bot.id}`;
    const registration = await runner.request(path, "PUT", bot);
    assert.equal(registration.status, 200);
    assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, 1);
    assert.equal(await readFile(registrySeen, "utf8"), "true");
    assert.ok(registration.body.tools.includes("mcp_fixture_allowed_lookup"));
    assert.ok(!registration.body.tools.includes("mcp_fixture_denied_write"));
    const registry = await readFile(join(directory, "workspaces.json"), "utf8");
    assert.ok(registry.includes("INJECTED_MCP_SECRET"));
    assert.ok(!registry.includes("fixture-secret"));

    await runner.request(path + "/input", "POST", {
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            {
              tool: "mcp_fixture_allowed_lookup",
              args: { query: "status" },
            },
          ],
          answer: "Lookup complete.",
        }),
      requestId: "mcp-direct-call",
    });
    const allowed = await nextEvent(
      runner,
      bot.id,
      (event) =>
        event.kind === "tool" &&
        event.data.name === "mcp_fixture_allowed_lookup",
      0,
      true,
    );
    assert.equal(allowed.data.isError, false);
    const mcpResult = JSON.parse(JSON.parse(allowed.data.text)[0].text);
    assert.deepEqual(mcpResult, {
      query: "status",
      injected: true,
      providerSecretForwarded: false,
    });

    await runner.request(path + "/input", "POST", {
      message:
        "/faux " +
        JSON.stringify({
          calls: [{ tool: "mcp_fixture_denied_write", args: {} }],
          answer: "Denied direct call complete.",
        }),
      requestId: "mcp-denied-direct-call",
    });
    const deniedDirect = await nextEvent(
      runner,
      bot.id,
      (event) =>
        event.kind === "tool" && event.data.name === "mcp_fixture_denied_write",
      allowed.seq,
      true,
    );
    assert.equal(deniedDirect.data.isError, true);

    await runner.request(path + "/input", "POST", {
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            {
              tool: "codemode",
              args: {
                code: "return await tools.mcp_fixture_denied_write({})",
              },
            },
          ],
          answer: "Denied call complete.",
        }),
      requestId: "mcp-denied-code-call",
    });
    const denied = await nextEvent(
      runner,
      bot.id,
      (event) => event.kind === "tool" && event.data.name === "codemode",
      deniedDirect.seq,
      true,
    );
    assert.equal(denied.data.isError, true);

    await runner.stop("SIGKILL");
    runner = await startRunner(directory, runnerEnv);
    const restored = await runner.request(path, "PUT", bot);
    assert.equal(restored.status, 200);
    assert.ok(restored.body.tools.includes("mcp_fixture_allowed_lookup"));
    assert.ok(!restored.body.tools.includes("mcp_fixture_denied_write"));
    assert.equal(
      (await readFile(starts, "utf8"))
        .trim()
        .split("\n")
        .filter((line) => line === "start").length,
      2,
    );

    const cancellationBot = { ...bot, id: "cancellation-bot" };
    const cancellationPath = `/v1/workspaces/${cancellationBot.id}`;
    assert.equal(
      (await runner.request(cancellationPath, "PUT", cancellationBot)).status,
      200,
    );
    const exitsBeforeCancellation = (await readFile(starts, "utf8"))
      .split("\n")
      .filter((line) => line === "exit").length;
    const markerWatch = watch(starts);
    const hangingStarted = (async () => {
      for await (const _event of markerWatch) {
        if ((await readFile(starts, "utf8")).includes("hang")) {
          await markerWatch.return();
          return;
        }
      }
    })();
    await runner.request(cancellationPath + "/input", "POST", {
      message:
        "/faux " +
        JSON.stringify({
          calls: [{ tool: "mcp_fixture_hang", args: {} }],
          answer: "This response waits for cancellation.",
        }),
      requestId: "mcp-hanging-call",
    });
    await hangingStarted;
    const deletion = await runner.request(
      cancellationPath,
      "DELETE",
      undefined,
      AbortSignal.timeout(5000),
    );
    assert.equal(deletion.status, 200);
    assert.ok(
      (await readFile(starts, "utf8"))
        .split("\n")
        .filter((line) => line === "exit").length > exitsBeforeCancellation,
    );
    assert.equal((await runner.request(path, "DELETE")).status, 200);
    assert.equal(
      (await readFile(starts, "utf8"))
        .split("\n")
        .filter((line) => line === "start").length,
      3,
    );

    const disconnectBot = {
      ...bot,
      id: "disconnect-bot",
      mcpServers: [
        {
          ...bot.mcpServers[0],
          id: "disconnect",
          tools: ["drop_connection"],
        },
      ],
    };
    const disconnectPath = `/v1/workspaces/${disconnectBot.id}`;
    const disconnectRegistration = await runner.request(
      disconnectPath,
      "PUT",
      disconnectBot,
    );
    assert.equal(disconnectRegistration.status, 200);
    await runner.request(disconnectPath + "/input", "POST", {
      message:
        "/faux " +
        JSON.stringify({
          calls: [{ tool: "mcp_disconnect_drop_connection", args: {} }],
          answer: "This answer follows a lost MCP connection.",
        }),
      requestId: "disconnect-mcp",
    });
    const disconnected = await nextEvent(
      runner,
      disconnectBot.id,
      (event) =>
        event.kind === "tool" &&
        event.data.name === "mcp_disconnect_drop_connection",
      0,
      true,
    );
    assert.equal(disconnected.data.isError, false);
    assert.match(
      (await runner.request(disconnectPath)).body.error,
      /disconnected/i,
    );
    const laterInput = await runner.request(disconnectPath + "/input", "POST", {
      message: "later work",
      requestId: "after-mcp-disconnect",
    });
    assert.equal(laterInput.status, 202);
    await nextEvent(
      runner,
      disconnectBot.id,
      (event) =>
        event.kind === "assistant" &&
        event.data.text.includes("Echo: later work"),
      disconnected.seq,
      true,
      5000,
    );
    assert.match(
      (await runner.request(disconnectPath)).body.error,
      /disconnected/i,
    );
  },
);

test(
  "MCP subprocesses close and registry state rolls back when workspace initialization fails",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-mcp-open-failure-"),
    );
    const fixture = join(directory, "mcp-server.mjs");
    const initialized = join(directory, "initialized.txt");
    const exited = join(directory, "exited.txt");
    const registryPath = join(directory, "workspaces.json");
    await writeFile(
      fixture,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const registryPath = ${JSON.stringify(registryPath)};
const initialized = ${JSON.stringify(initialized)};
const exited = ${JSON.stringify(exited)};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => { appendFileSync(exited, "exit"); process.exit(0); });
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\\n");
    if (end < 0) break;
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (!("id" in message)) continue;
    let result;
    if (message.method === "initialize") {
      const registered = JSON.parse(readFileSync(registryPath, "utf8")).some((entry) => entry.id === "bad-mcp");
      appendFileSync(initialized, String(registered));
      result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "failure-fixture", version: "1" } };
    } else {
      result = { tools: [] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
    );
    await chmod(fixture, 0o700);
    await mkdir(join(directory, "sessions", "bad-mcp", "session.sqlite"), {
      recursive: true,
    });
    const runner = await startRunner(directory);
    t.after(() => runner.stop());
    const config = {
      id: "bad-mcp",
      name: "mcp failure cleanup",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
      mcpServers: [{ id: "failure", command: fixture, tools: ["probe"] }],
    };
    const failed = await runner.request(
      `/v1/workspaces/${config.id}`,
      "PUT",
      config,
    );
    assert.equal(failed.status, 500);
    assert.equal(await readFile(initialized, "utf8"), "true");
    assert.equal(await readFile(exited, "utf8"), "exit");
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), []);
  },
);

test(
  "a bot publishes only explicit messages, cannot use coding tools through Code Mode, and supervises only permitted agents",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-bot-"));
    const runner = await startRunner(directory);
    t.after(() => runner.stop());
    const coding = {
      id: "allowed-coder",
      name: "coder",
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    };
    const bot = {
      id: "private-bot",
      name: "bot",
      role: "bot",
      environment: "local",
      allowedAgents: ["allowed-coder"],
      model: { provider: "faux", id: "faux-1" },
    };
    assert.equal(
      (await runner.request("/v1/workspaces/allowed-coder", "PUT", coding))
        .status,
      200,
    );
    const registration = await runner.request(
      "/v1/workspaces/private-bot",
      "PUT",
      bot,
    );
    assert.equal(registration.status, 200);
    assert.ok(registration.body.tools.includes("sendMessage"));
    for (const forbidden of ["read", "write", "edit", "bash"])
      assert.ok(!registration.body.tools.includes(forbidden));
    const send = {
      calls: [{ tool: "sendMessage", args: { text: "The agent is ready." } }],
      answer: "This private model response must not be published.",
    };
    await runner.request("/v1/workspaces/private-bot/input", "POST", {
      message: "/faux " + JSON.stringify(send),
      requestId: "bot-message",
    });
    const published = await nextEvent(
      runner,
      bot.id,
      (event) =>
        event.kind === "message" && event.data.text === "The agent is ready.",
    );
    assert.equal(published.data.text, "The agent is ready.");
    const denied = {
      calls: [
        {
          tool: "codemode",
          args: { code: 'await tools.bash({command:"touch forbidden"})' },
        },
      ],
      answer: "Private after denial.",
    };
    await runner.request("/v1/workspaces/private-bot/input", "POST", {
      message: "/faux " + JSON.stringify(denied),
      requestId: "bot-codemode",
    });
    const codeResult = await nextEvent(
      runner,
      bot.id,
      (event) => event.kind === "tool" && event.data.name === "codemode",
      published.seq,
      true,
    );
    assert.equal(codeResult.data.isError, true);
    const supervise = {
      calls: [
        {
          tool: "promptAgent",
          args: {
            agentId: coding.id,
            message: "Please summarize your progress.",
          },
        },
      ],
      answer: "Private supervision result.",
    };
    await runner.request("/v1/workspaces/private-bot/input", "POST", {
      message: "/faux " + JSON.stringify(supervise),
      requestId: "supervision",
    });
    await nextEvent(
      runner,
      coding.id,
      (event) =>
        event.kind === "assistant" && event.data.text.includes("summarize"),
    );
    const forbidden = {
      calls: [{ tool: "monitorAgent", args: { agentId: "unpermitted-coder" } }],
      answer: "Private unauthorized result.",
    };
    await runner.request("/v1/workspaces/private-bot/input", "POST", {
      message: "/faux " + JSON.stringify(forbidden),
      requestId: "denied-target",
    });
    const forbiddenResult = await nextEvent(
      runner,
      bot.id,
      (event) => event.kind === "tool" && event.data.name === "monitorAgent",
      codeResult.seq,
      true,
    );
    assert.equal(forbiddenResult.data.isError, true);
    const history = await runner.request(
      "/v1/workspaces/private-bot/history?limit=1000",
    );
    assert.ok(
      history.body.events.every(
        (event) => !["assistant", "tool"].includes(event.kind),
      ),
    );
    assert.equal(
      history.body.events.filter((event) => event.kind === "message").length,
      2,
    );
  },
);

test(
  "a bot discovers only its live coding grants across Code Mode, deletion, and restart",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-agent-directory-"),
    );
    let runner = await startRunner(directory);
    t.after(() => runner.stop());
    const coder = (id, name) => ({
      id,
      name,
      role: "coding",
      environment: "local",
      localRoot: join(directory, id),
      model: { provider: "faux", id: "faux-1" },
    });
    const bot = {
      id: "directory-bot",
      name: "bot",
      role: "bot",
      environment: "local",
      allowedAgents: ["granted-coder"],
      model: { provider: "faux", id: "faux-1" },
    };
    for (const config of [
      coder("granted-coder", "project-albatross"),
      coder("ungranted-coder", "project-bee"),
    ])
      assert.equal(
        (await runner.request(`/v1/workspaces/${config.id}`, "PUT", config))
          .status,
        200,
      );
    const registration = await runner.request(
      `/v1/workspaces/${bot.id}`,
      "PUT",
      bot,
    );
    assert.equal(registration.status, 200);
    assert.ok(registration.body.tools.includes("listAgents"));
    assert.ok(registration.body.tools.includes("monitorAgent"));
    assert.ok(registration.body.tools.includes("promptAgent"));

    let cursor = 0;
    async function call(tool, args, requestId, code = false) {
      const calls = code
        ? [
            {
              tool: "codemode",
              args: {
                code: `return await tools.${tool}(${JSON.stringify(args)})`,
              },
            },
          ]
        : [{ tool, args }];
      await runner.request(`/v1/workspaces/${bot.id}/input`, "POST", {
        message:
          "/faux " +
          JSON.stringify({ calls, answer: "Private directory result." }),
        requestId,
      });
      const event = await nextEvent(
        runner,
        bot.id,
        (value) =>
          value.kind === "tool" &&
          value.data.name === (code ? "codemode" : tool),
        cursor,
        true,
      );
      cursor = event.seq;
      return event.data;
    }
    function toolText(result) {
      return result.text;
    }

    const listed = JSON.parse(toolText(await call("listAgents", {}, "list")));
    assert.deepEqual(listed, {
      agents: [
        { id: "granted-coder", name: "project-albatross", status: "idle" },
      ],
      unavailable: [],
      message: "",
    });
    const codeModeText = toolText(
      await call("listAgents", {}, "list-codemode", true),
    );
    assert.match(codeModeText, /\"id\":\"granted-coder\"/);
    assert.match(codeModeText, /\"name\":\"project-albatross\"/);
    assert.doesNotMatch(codeModeText, /ungranted-coder|project-bee/);

    const monitored = JSON.parse(
      toolText(
        await call("monitorAgent", { agentId: listed.agents[0].id }, "monitor"),
      ),
    );
    assert.equal(monitored.id, "granted-coder");
    await call(
      "promptAgent",
      { agentId: listed.agents[0].id, message: "Report your status." },
      "prompt",
    );
    await nextEvent(
      runner,
      "granted-coder",
      (event) =>
        event.kind === "assistant" &&
        event.data.text.includes("Report your status."),
    );

    const ungranted = await call(
      "monitorAgent",
      { agentId: "ungranted-coder" },
      "monitor-ungranted",
    );
    assert.equal(ungranted.isError, true);
    const deniedCodeMode = await call(
      "monitorAgent",
      { agentId: "ungranted-coder" },
      "monitor-ungranted-codemode",
      true,
    );
    assert.equal(deniedCodeMode.isError, true);

    assert.equal(
      (await runner.request("/v1/workspaces/granted-coder", "DELETE")).status,
      200,
    );
    const afterDelete = JSON.parse(
      toolText(await call("listAgents", {}, "list-deleted")),
    );
    assert.deepEqual(afterDelete.agents, []);
    assert.deepEqual(afterDelete.unavailable, ["granted-coder"]);
    assert.match(afterDelete.message, /unavailable/i);

    assert.equal(
      (
        await runner.request(
          "/v1/workspaces/replacement-coder",
          "PUT",
          coder("replacement-coder", "project-albatross"),
        )
      ).status,
      200,
    );
    const afterReuse = JSON.parse(
      toolText(await call("listAgents", {}, "list-reused-name")),
    );
    assert.deepEqual(afterReuse.agents, []);
    assert.deepEqual(afterReuse.unavailable, ["granted-coder"]);

    await runner.stop();
    runner = await startRunner(directory);
    const afterRestart = await runner.request(`/v1/workspaces/${bot.id}`);
    assert.equal(afterRestart.status, 200);
    const persisted = JSON.parse(
      toolText(await call("listAgents", {}, "list-after-restart")),
    );
    assert.deepEqual(persisted.agents, []);
    assert.deepEqual(persisted.unavailable, ["granted-coder"]);

    const emptyBot = {
      ...bot,
      id: "empty-directory-bot",
      allowedAgents: [],
    };
    assert.equal(
      (await runner.request(`/v1/workspaces/${emptyBot.id}`, "PUT", emptyBot))
        .status,
      200,
    );
    const emptyRequest = await runner.request(
      `/v1/workspaces/${emptyBot.id}/input`,
      "POST",
      {
        message:
          "/faux " +
          JSON.stringify({
            calls: [{ tool: "listAgents", args: {} }],
            answer: "Private empty directory result.",
          }),
        requestId: "list-empty-grants",
      },
    );
    assert.equal(emptyRequest.status, 202);
    const emptyResult = await nextEvent(
      runner,
      emptyBot.id,
      (event) => event.kind === "tool" && event.data.name === "listAgents",
      0,
      true,
    );
    const emptyListing = JSON.parse(toolText(emptyResult.data));
    assert.deepEqual(emptyListing.agents, []);
    assert.deepEqual(emptyListing.unavailable, []);
    assert.match(emptyListing.message, /no coding agents are assigned/i);
  },
);

test(
  "a bot-owned goal and scheduled loop recover without a client and deletion cancels future work",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-loop-"));
    let runner = await startRunner(directory);
    t.after(() => runner.stop());
    const id = "scheduled-bot",
      path = `/v1/workspaces/${id}`;
    const config = {
      id,
      name: "scheduled",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
    };
    await runner.request(path, "PUT", config);
    const goal = await runner.request(path + "/goals", "POST", {
      description: "Watch for useful agent progress",
    });
    assert.equal(goal.status, 200);
    const prompt =
      "/faux " +
      JSON.stringify({
        calls: [
          { tool: "sendMessage", args: { text: "Scheduled check completed." } },
        ],
        answer: "Private loop result.",
      });
    const loop = await runner.request(path + "/loops", "POST", {
      prompt,
      intervalMs: 60000,
      nextAt: Date.now() + 1500,
    });
    assert.equal(loop.status, 200);
    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    const restored = await runner.request(path);
    assert.ok(
      restored.body.goals.some(
        (entry) =>
          entry.id === goal.body.id &&
          entry.description === "Watch for useful agent progress",
      ),
    );
    assert.ok(
      restored.body.loops.some(
        (entry) => entry.id === loop.body.id && entry.status === "active",
      ),
    );
    const notification = await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "message" &&
        event.data.text === "Scheduled check completed.",
    );
    const afterRun = await runner.request(path);
    assert.ok(
      afterRun.body.loops.find((entry) => entry.id === loop.body.id).nextAt >
        Date.now(),
    );
    await runner.request(path, "DELETE");
    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    const history = await runner.request(path + "/history?after=0&limit=1000");
    assert.equal(history.status, 200);
    assert.equal(
      history.body.events.filter((event) => event.kind === "message").length,
      2,
    );
    assert.equal(
      history.body.events.find((event) => event.seq === notification.seq).seq,
      notification.seq,
    );
    assert.equal(
      (
        await runner.request(path + "/loops", "POST", {
          prompt,
          intervalMs: 1000,
        })
      ).status,
      410,
    );
    const renamed = { ...config, id: "fresh-scheduled-bot" };
    assert.equal(
      (
        await runner.request(
          "/v1/workspaces/fresh-scheduled-bot",
          "PUT",
          renamed,
        )
      ).status,
      200,
    );
    assert.deepEqual(
      (await runner.request("/v1/workspaces/fresh-scheduled-bot")).body.loops,
      [],
    );
  },
);

test(
  "reactivating a loop after its canceled task settles schedules it again",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-loop-reactivate-"),
    );
    const runner = await startRunner(directory);
    t.after(() => runner.stop());
    const id = "reactivated-loop",
      path = `/v1/workspaces/${id}`;
    await runner.request(path, "PUT", {
      id,
      name: "reactivated-loop",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
    });
    const prompt = "reactivation occurrence";
    const loop = await runner.request(path + "/loops", "POST", {
      prompt,
      intervalMs: 1000,
      nextAt: Date.now() + 1000,
    });
    assert.equal(loop.status, 200);
    const first = await nextEvent(
      runner,
      id,
      (event) => event.kind === "user" && event.data.text === prompt,
      0,
      false,
      5000,
    );
    assert.equal(
      (
        await runner.request(path + "/loops", "POST", {
          id: loop.body.id,
          status: "cancelled",
        })
      ).status,
      200,
    );
    const cancelledState = await runner.request(path);
    const cancelledLoop = cancelledState.body.loops.find(
      (entry) => entry.id === loop.body.id,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, cancelledLoop.nextAt - Date.now() + 100)),
    );
    assert.equal(
      (
        await runner.request(path + "/loops", "POST", {
          id: loop.body.id,
          status: "active",
        })
      ).status,
      200,
    );
    const second = await nextEvent(
      runner,
      id,
      (event) => event.kind === "user" && event.data.text === prompt,
      first.seq,
      false,
      5000,
    );
    assert.ok(second.seq > first.seq);
  },
);

test(
  "reactivating before cancellation settles reuses the scheduled loop task",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-loop-reuse-"));
    const runner = await startRunner(directory);
    t.after(() => runner.stop());
    const id = "reused-loop-task",
      path = `/v1/workspaces/${id}`;
    await runner.request(path, "PUT", {
      id,
      name: "reused-loop-task",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
    });
    const loop = await runner.request(path + "/loops", "POST", {
      prompt: "one active schedule task",
      intervalMs: 1000,
      nextAt: Date.now() + 1000,
    });
    for (const status of ["cancelled", "active"]) {
      assert.equal(
        (
          await runner.request(path + "/loops", "POST", {
            id: loop.body.id,
            status,
          })
        ).status,
        200,
      );
    }
    await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "user" && event.data.text === "one active schedule task",
      0,
      false,
      5000,
    );
    const status = await runner.request(path);
    const loopTasks = status.body.tasks.filter(
      (task) =>
        task.record.kind === "adm.loop" &&
        task.record.input.loopId === loop.body.id &&
        task.record.state.status !== "terminal",
    );
    assert.equal(loopTasks.length, 1);
  },
);

test(
  "a due loop cannot add input after its workspace is deleted",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-loop-delete-race-"),
    );
    const runner = await startRunner(directory);
    t.after(() => runner.stop());
    const id = "deleted-due-loop",
      path = `/v1/workspaces/${id}`;
    await runner.request(path, "PUT", {
      id,
      name: "deleted-due-loop",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
    });
    const loop = await runner.request(path + "/loops", "POST", {
      prompt: "must not be admitted after deletion",
      intervalMs: 1000,
      nextAt: Date.now(),
    });
    assert.equal(loop.status, 200);
    assert.equal((await runner.request(path, "DELETE")).status, 200);
    const deletedHistory = await runner.request(path + "/history?limit=1000");
    const cursorAfterDelete = deletedHistory.body.nextAfter;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const laterHistory = await runner.request(
      `${path}/history?after=${cursorAfterDelete}&limit=1000`,
    );
    assert.deepEqual(laterHistory.body.events, []);
  },
);

test(
  "HTTP and model-created loops enforce the same interval and safe timestamp bounds",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-loop-bounds-"));
    const runner = await startRunner(directory);
    t.after(() => runner.stop());
    const id = "loop-bounds",
      path = `/v1/workspaces/${id}`;
    await runner.request(path, "PUT", {
      id,
      name: "loop-bounds",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
    });
    for (const invalid of [
      { prompt: "too short", intervalMs: 999 },
      { prompt: "too long", intervalMs: 366 * 24 * 60 * 60 * 1000 + 1 },
      {
        prompt: "unsafe timestamp",
        intervalMs: 1000,
        nextAt: Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      assert.equal(
        (await runner.request(path + "/loops", "POST", invalid)).status,
        400,
      );
    }
    const invalidTool =
      "/faux " +
      JSON.stringify({
        calls: [
          {
            tool: "saveLoop",
            args: {
              prompt: "outside the HTTP bounds",
              intervalMs: 366 * 24 * 60 * 60 * 1000 + 1,
              nextAt: Number.MAX_SAFE_INTEGER + 1,
            },
          },
        ],
        answer: "The invalid loop was rejected.",
      });
    await runner.request(path + "/input", "POST", {
      message: invalidTool,
      requestId: "invalid-model-loop",
    });
    const rejectedTool = await nextEvent(
      runner,
      id,
      (event) => event.kind === "tool" && event.data.name === "saveLoop",
      0,
      true,
      5000,
    );
    assert.equal(rejectedTool.data.isError, true);
    const status = await runner.request(path);
    assert.deepEqual(status.body.loops, []);
  },
);
