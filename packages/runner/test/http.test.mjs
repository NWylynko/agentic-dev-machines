import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

const main = new URL("../src/main.ts", import.meta.url);

async function startRunner(directory) {
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
    { stdio: ["ignore", "pipe", "pipe"] },
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

async function nextEvent(
  runner,
  id,
  predicate,
  after = 0,
  diagnostics = false,
) {
  const controller = new AbortController();
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
      (event) => event.kind === "message",
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
      1,
    );
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
      1,
    );
    assert.equal(
      history.body.events.find((event) => event.kind === "message").seq,
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
