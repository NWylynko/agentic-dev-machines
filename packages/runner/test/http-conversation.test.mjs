import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  readFile,
  stat,
  watch,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { entryRole } from "./attach-stream.ts";
import {
  startRunner,
  followView,
  nextEvent,
  fauxTurn,
  longFauxAnswer,
} from "./http-fixture.mjs";

test(
  "attach follows the Durable conversation view: its first value, the ops of each commit, and a resume from an entry",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-view-"));
    const runner = await startRunner(directory);
    t.after(async () => runner.stop());
    const id = "workspace-view";
    const path = `/v1/workspaces/${id}`;
    assert.equal(
      (
        await runner.request(path, "PUT", {
          id,
          name: "view",
          role: "coding",
          environment: "local",
          localRoot: join(directory, "repo"),
          model: { provider: "faux", id: "faux-1" },
        })
      ).status,
      200,
    );
    let sawRun = false;
    const answered = await followView(runner, id, async (view, frame) => {
      if (frame === "view") {
        assert.equal(
          view.conversation.id,
          (await runner.request(path)).body.conversationId,
        );
        assert.deepEqual(view.entries, []);
        const admitted = await runner.request(path + "/input", "POST", {
          message: fauxTurn(longFauxAnswer("The view answer")),
          requestId: "view-input",
        });
        assert.equal(admitted.status, 202);
        return;
      }
      if (view.docs["pi.live"]?.run) sawRun = true;
      const answer = view.entries.find(
        (entry) =>
          entryRole(entry) === "assistant" &&
          JSON.stringify(entry.model).includes("The view answer"),
      );
      if (answer && !view.docs["pi.live"]?.run) return { view, answer };
    });
    assert.ok(sawRun, "the run shows in pi.live while it works");
    assert.ok(
      answered.view.entries.some((entry) => entryRole(entry) === "user"),
    );

    // A reconnect from just after the newest entry gets only what follows.
    const newest = answered.view.entries.at(-1).id;
    const resumed = await followView(
      runner,
      id,
      (view) => view,
      `?from=${Number(newest) + 1}`,
    );
    assert.deepEqual(resumed.entries, []);
    assert.equal(resumed.before, newest);

    // The transcript loader pages the same entries.
    const page = await runner.request(
      path + `/entries?order=descending&limit=1`,
    );
    assert.equal(page.status, 200);
    assert.deepEqual(
      page.body.items.map((entry) => entry.id),
      [newest],
    );
    const earlier = await runner.request(
      path +
        `/entries?order=descending&limit=100&maxEntryId=${Number(newest) - 1}`,
    );
    assert.deepEqual(
      [...earlier.body.items].reverse().map((entry) => entry.id),
      answered.view.entries.slice(0, -1).map((entry) => entry.id),
    );
    assert.equal(
      (await runner.request(path + "/events?from=nope")).status,
      400,
    );
  },
);

test(
  "a bot's attach view is public: its users' messages, published messages and whether it is working, never its private turns",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-bot-view-"));
    const runner = await startRunner(directory);
    t.after(async () => runner.stop());
    const bot = {
      id: "bot-view",
      name: "bot view",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
    };
    const path = `/v1/workspaces/${bot.id}`;
    assert.equal((await runner.request(path, "PUT", bot)).status, 200);
    let sawWorking = false;
    const published = await followView(runner, bot.id, async (view, frame) => {
      assert.deepEqual(Object.keys(view.docs), ["pi.live"]);
      assert.deepEqual(
        Object.keys(view.docs["pi.live"]).filter((key) => key !== "run"),
        [],
      );
      for (const entry of view.entries)
        assert.ok(
          entryRole(entry) === "user" ||
            entry.kind === "adm.message" ||
            entry.kind === "adm.status",
          `bot view leaked a ${entry.kind} entry`,
        );
      if (view.docs["pi.live"].run) sawWorking = true;
      if (frame === "view") {
        await runner.request(path + "/input", "POST", {
          message: fauxTurn(longFauxAnswer("Private reasoning only"), [
            { tool: "sendMessage", args: { text: "Hello in public" } },
          ]),
          requestId: "bot-view-input",
        });
        return;
      }
      if (
        !view.docs["pi.live"].run &&
        view.entries.some(
          (entry) =>
            entry.kind === "adm.message" &&
            entry.data.text === "Hello in public",
        )
      )
        return view;
    });
    assert.ok(sawWorking, "a working bot shows a run");
    assert.ok(published.entries.some((entry) => entryRole(entry) === "user"));
    const entries = await runner.request(path + "/entries?limit=1000");
    assert.ok(
      entries.body.items.every(
        (entry) =>
          entryRole(entry) === "user" ||
          entry.kind === "adm.message" ||
          entry.kind === "adm.status",
      ),
    );
    // Diagnostics show the whole private view.
    const diagnostic = await followView(
      runner,
      bot.id,
      (view) => view,
      "?diagnostics=true",
    );
    assert.ok(
      diagnostic.entries.some(
        (entry) =>
          entryRole(entry) === "assistant" &&
          JSON.stringify(entry.model).includes("Private reasoning only"),
      ),
    );
    assert.ok("pi.usage" in diagnostic.docs);
  },
);

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

test("native bash executes in the workspace harness and records replayable native history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-bash-"));
  const runner = await startRunner(directory);
  t.after(() => runner.stop());
  const id = "native-bash",
    path = `/v1/workspaces/${id}`;
  const config = {
    id,
    name: id,
    role: "coding",
    environment: "local",
    localRoot: join(directory, "repo"),
    model: { provider: "faux", id: "faux-1" },
  };
  assert.equal((await runner.request(path, "PUT", config)).status, 200);

  const invalid = await runner.request(`${path}/bash`, "POST", {
    command: "printf 'must-not-enter-context'",
    requestId: "invalid-exclusion",
    excludeFromContext: "true",
  });
  assert.equal(
    invalid.status,
    400,
    "context exclusion requires an explicit boolean",
  );
  const admitted = await runner.request(`${path}/bash`, "POST", {
    command: "printf 'native-output'",
    requestId: "bash-once",
  });
  assert.equal(admitted.status, 202);
  const stream = await fetch(
    `${runner.url}${path}/bash/${admitted.body.operationId}/events`,
  );
  const events = await stream.text();
  assert.match(events, /event: output/);
  assert.match(events, /native-output/);
  assert.match(events, /event: result/);
  assert.match(events, /"exitCode":0/);

  const history = await runner.request(`${path}/history`);
  const entry = history.body.events.find(
    (event) => event.data.operationId === admitted.body.operationId,
  );
  assert.equal(entry.kind, "message");
  assert.equal(entry.data.message.role, "bashExecution");
  assert.equal(entry.data.message.output, "native-output");
  const branches = await runner.request(path + "/branches");
  const sessionInfo = branches.body.branches.find(
    (branch) => branch.conversationId === history.body.activeConversationId,
  ).sessionInfo;
  assert.equal(sessionInfo.firstMessage, "");
  assert.doesNotMatch(sessionInfo.allMessagesText, /native-output/);
  const retry = await runner.request(`${path}/bash`, "POST", {
    command: "printf 'duplicate'",
    requestId: "bash-once",
  });
  assert.equal(retry.body.operationId, admitted.body.operationId);
});

test(
  "excluded native bash output is absent from the next model context",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-bash-context-"));
    let runner = await startRunner(directory);
    t.after(() => runner.stop());
    const id = "bash-context",
      path = `/v1/workspaces/${id}`;
    const config = {
      id,
      name: id,
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    };
    assert.equal((await runner.request(path, "PUT", config)).status, 200);
    const excluded = await runner.request(path + "/bash", "POST", {
      command: "printf 'PRIVATE_BASH_RESULT'",
      requestId: "excluded-result",
      excludeFromContext: true,
    });
    assert.equal(excluded.status, 202);
    const response = await fetch(
      `${runner.url}${path}/bash/${excluded.body.operationId}/events`,
    );
    await response.text();
    const before = await runner.request(path + "/history?diagnostics=true");
    await runner.request(path + "/input", "POST", {
      message: "/faux-inspect-system-prompt",
      requestId: "inspect-after-bash",
    });
    const assistant = await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" && event.seq > before.body.nextAfter,
      before.body.nextAfter,
      true,
      10000,
    );
    assert.doesNotMatch(assistant.data.text, /PRIVATE_BASH_RESULT/);
  },
);

test("a disconnected client leaves a FIFO-backed bash command running for reconnect", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-bash-reconnect-"));
  const runner = await startRunner(directory);
  t.after(() => runner.stop());
  const id = "bash-reconnect",
    path = `/v1/workspaces/${id}`;
  const repo = join(directory, "repo"),
    gate = join(directory, "bash-gate");
  const config = {
    id,
    name: id,
    role: "coding",
    environment: "local",
    localRoot: repo,
    model: { provider: "faux", id: "faux-1" },
  };
  assert.equal((await runner.request(path, "PUT", config)).status, 200);
  const fifo = spawn("mkfifo", [gate]);
  const [fifoCode] = await once(fifo, "exit");
  assert.equal(fifoCode, 0);
  const admitted = await runner.request(path + "/bash", "POST", {
    command: `printf before; cat '${gate}'; printf continued`,
    requestId: "disconnect-keeps-shell",
  });
  const first = await fetch(
    `${runner.url}${path}/bash/${admitted.body.operationId}/events`,
  );
  const firstReader = first.body.getReader();
  const firstOutput = await firstReader.read();
  assert.match(new TextDecoder().decode(firstOutput.value), /before/);
  await firstReader.cancel();
  const replay = await fetch(
    `${runner.url}${path}/bash/${admitted.body.operationId}/events`,
  );
  const replayReader = replay.body.getReader();
  const replayOutput = await replayReader.read();
  assert.match(new TextDecoder().decode(replayOutput.value), /before/);
  await replayReader.cancel();
  const writer = spawn("sh", ["-c", `printf fifo-output > '${gate}'`]);
  const [writerCode] = await once(writer, "exit");
  assert.equal(writerCode, 0);
  const reconnected = await fetch(
    `${runner.url}${path}/bash/${admitted.body.operationId}/events`,
  );
  const events = await reconnected.text();
  assert.match(events, /fifo-outputcontinued/);
  assert.match(events, /event: result/);
});

test("aborting native bash kills that operation and records cancellation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-bash-abort-"));
  const runner = await startRunner(directory);
  t.after(() => runner.stop());
  const id = "bash-abort",
    path = `/v1/workspaces/${id}`;
  const config = {
    id,
    name: id,
    role: "coding",
    environment: "local",
    localRoot: join(directory, "repo"),
    model: { provider: "faux", id: "faux-1" },
  };
  assert.equal((await runner.request(path, "PUT", config)).status, 200);
  const admitted = await runner.request(path + "/bash", "POST", {
    command: "exec sleep 30",
    requestId: "abort-this-shell",
  });
  assert.equal(admitted.status, 202);
  const aborted = await runner.request(
    `${path}/bash/${admitted.body.operationId}/abort`,
    "POST",
    {},
  );
  assert.equal(aborted.body.status, "aborted");
  const resultResponse = await fetch(
    `${runner.url}${path}/bash/${admitted.body.operationId}/events`,
  );
  const events = await resultResponse.text();
  assert.match(events, /"cancelled":true/);
  assert.match(events, /"exitCode":130/);
});

test("native bash bounds retained output and provides a spill path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-bash-output-"));
  const runner = await startRunner(directory);
  t.after(() => runner.stop());
  const id = "bash-output",
    path = `/v1/workspaces/${id}`;
  const config = {
    id,
    name: id,
    role: "coding",
    environment: "local",
    localRoot: join(directory, "repo"),
    model: { provider: "faux", id: "faux-1" },
  };
  assert.equal((await runner.request(path, "PUT", config)).status, 200);
  const admitted = await runner.request(path + "/bash", "POST", {
    command: "head -c 1200000 /dev/zero | tr '\\000' x",
    requestId: "large-bash-output",
    excludeFromContext: true,
  });
  const response = await fetch(
    `${runner.url}${path}/bash/${admitted.body.operationId}/events`,
  );
  const events = await response.text();
  const result = JSON.parse(
    events.match(/event: result\ndata: (.+)\n\n/)?.[1] ?? "null",
  );
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output) <= 1024 * 1024);
  assert.equal(typeof result.fullOutputPath, "string");
});

test(
  "an unsafe Bash intent interrupted by runner restart never executes twice",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-bash-restart-"));
    let runner = await startRunner(directory);
    t.after(() => runner.stop());
    const id = "bash-restart",
      path = `/v1/workspaces/${id}`;
    const repo = join(directory, "repo"),
      marker = join(directory, "marker"),
      pids = join(directory, "pids");
    const config = {
      id,
      name: id,
      role: "coding",
      environment: "local",
      localRoot: repo,
      model: { provider: "faux", id: "faux-1" },
    };
    assert.equal((await runner.request(path, "PUT", config)).status, 200);
    const directoryWatch = watch(directory);
    const markerWritten = (async () => {
      for await (const _event of directoryWatch) {
        try {
          await access(marker);
          await directoryWatch.return();
          return;
        } catch {}
      }
    })();
    const admitted = await runner.request(path + "/bash", "POST", {
      command: `printf x >> '${marker}'; printf '%s\\n' $$ >> '${pids}'; exec sleep 30`,
      requestId: "unsafe-restart-marker",
      excludeFromContext: true,
    });
    await markerWritten;
    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    const response = await fetch(
      `${runner.url}${path}/bash/${admitted.body.operationId}/events`,
    );
    const events = await response.text();
    assert.match(events, /execution intent; it was not restarted/);
    assert.equal(await readFile(marker, "utf8"), "x");
    for (const pid of (await readFile(pids, "utf8")).trim().split("\n")) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
  },
);

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

test("a bot without a selected model waits without admitting onboarding", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-bot-needs-model-"));
  let runner = await startRunner(directory, {}, { useFaux: false });
  t.after(() => runner.stop());
  const path = "/v1/workspaces/unconfigured-bot";
  const registered = await runner.request(path, "PUT", {
    id: "unconfigured-bot",
    name: "unconfigured",
    role: "bot",
    environment: "local",
  });
  assert.equal(registered.status, 200);
  assert.equal(registered.body.status, "needs_model");
  assert.deepEqual((await runner.request(path + "/history")).body.events, []);
  assert.deepEqual((await runner.request(path)).body.tasks, []);
  await runner.stop();
  runner = await startRunner(directory, {}, { useFaux: false });
  assert.equal((await runner.request(path)).body.status, "needs_model");
  assert.deepEqual((await runner.request(path + "/history")).body.events, []);
  const input = await runner.request(path + "/input", "POST", {
    message: "hello",
  });
  assert.equal(input.status, 409);
  assert.equal(input.body.error.code, "MODEL_REQUIRED");
});

test(
  "selecting a bot model admits onboarding once and keeps its durable choice across restart",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-bot-model-selection-"));
    let runner = await startRunner(directory, {}, { defaultModel: false });
    t.after(async () => runner.stop());
    const bot = {
      id: "bot-model-selection",
      name: "model-selected bot",
      role: "bot",
      environment: "local",
    };
    const path = `/v1/workspaces/${bot.id}`;
    assert.equal((await runner.request(path, "PUT", bot)).status, 200);
    assert.deepEqual((await runner.request(path + "/history")).body.events, []);
    const changed = await runner.request(
      path + "/model",
      "PUT",
      {
        provider: "faux",
        modelId: "faux-1",
      },
      AbortSignal.timeout(2000),
    );
    assert.equal(changed.status, 200);
    const onboarding = await nextEvent(
      runner,
      bot.id,
      (event) =>
        event.kind === "user" && event.data.text.includes("onboarding"),
    );
    await nextEvent(
      runner,
      bot.id,
      (event) =>
        event.kind === "message" &&
        event.data.text.includes("identity and purpose"),
      onboarding.seq,
    );
    await runner.request(path + "/input", "POST", {
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            {
              tool: "saveProfile",
              args: {
                identity: "Build monitor",
                purpose: "Track build health.",
              },
            },
          ],
          answer: "Setup saved.",
        }),
      requestId: "finish-model-selection-onboarding",
    });
    await nextEvent(
      runner,
      bot.id,
      (event) => event.kind === "tool" && event.data.name === "saveProfile",
      onboarding.seq,
      true,
    );
    assert.equal((await runner.request(path)).body.profile.state, "ready");
    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    assert.equal(
      (
        await runner.request(path, "PUT", {
          ...bot,
          model: { provider: "faux", id: "faux-2" },
        })
      ).status,
      200,
    );
    const reselected = await runner.request(
      path + "/model",
      "PUT",
      {
        provider: "faux",
        modelId: "faux-1",
      },
      AbortSignal.timeout(2000),
    );
    assert.equal(reselected.status, 200);
    assert.deepEqual((await runner.request(path + "/models")).body.selected, {
      provider: "faux",
      id: "faux-1",
    });
    const history = await runner.request(path + "/history?limit=1000");
    assert.equal(
      history.body.events.filter(
        (event) =>
          event.kind === "user" && event.data.text.includes("onboarding"),
      ).length,
      1,
    );
    assert.equal((await runner.request(path)).body.profile.state, "ready");
  },
);

test("model catalog and selection operate on the existing durable conversation", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "adm-runner-model-selection-"),
  );
  let runner = await startRunner(directory);
  t.after(async () => runner.stop());
  const id = "model-selection";
  const path = `/v1/workspaces/${id}`;
  const config = {
    id,
    name: "model selection",
    role: "coding",
    environment: "local",
    localRoot: join(directory, "repo"),
    model: { provider: "faux", id: "faux-1" },
  };
  await runner.request(path, "PUT", config);
  const catalog = await runner.request(`${path}/models`);
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.selected, { provider: "faux", id: "faux-1" });
  assert.ok(
    catalog.body.models.some(
      (model) => model.provider === "faux" && model.id === "faux-1",
    ),
  );
  assert.equal(JSON.stringify(catalog.body).includes("secret"), false);

  const invalid = await runner.request(`${path}/model`, "PUT", {
    provider: "missing-provider",
    modelId: "missing-model",
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "MODEL_NOT_FOUND");

  const changed = await runner.request(`${path}/model`, "PUT", {
    provider: "faux",
    modelId: "faux-1",
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.selected, { provider: "faux", id: "faux-1" });
  await runner.request(path + "/input", "POST", {
    message: "keep this history",
  });
  await nextEvent(runner, id, (event) => event.kind === "assistant");
  await runner.stop();
  runner = await startRunner(directory);
  const reRegistered = await runner.request(path, "PUT", {
    ...config,
    model: { provider: "faux", id: "faux-2" },
  });
  assert.equal(reRegistered.body.status, "idle");
  const afterRestart = await runner.request(`${path}/models`);
  assert.deepEqual(afterRestart.body.selected, {
    provider: "faux",
    id: "faux-1",
  });
  assert.equal(
    (await runner.request(`${path}/history`)).body.events.some(
      (event) => event.data.text === "keep this history",
    ),
    true,
  );
});

test(
  "session names belong to Durable branches and survive restart",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-session-names-"));
    let runner = await startRunner(directory);
    t.after(() => runner.stop());
    const path = "/v1/workspaces/named-coder";
    await runner.request(path, "PUT", {
      id: "named-coder",
      name: "coder",
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    });
    const original = (await runner.request(path + "/branches")).body
      .activeConversationId;
    const named = await runner.request(path + "/settings", "PUT", {
      sessionName: "Investigate streaming",
    });
    assert.equal(named.status, 200);
    assert.equal(named.body.sessionName, "Investigate streaming");
    assert.equal((await runner.request(path + "/new", "POST", {})).status, 200);
    assert.equal(
      (await runner.request(path + "/settings")).body.sessionName,
      undefined,
    );
    assert.equal(
      (
        await runner.request(path + "/settings", "PUT", {
          sessionName: "Second conversation",
        })
      ).status,
      200,
    );
    const branches = (await runner.request(path + "/branches")).body.branches;
    assert.deepEqual(
      branches.map((branch) => branch.sessionInfo.name),
      ["Investigate streaming", "Second conversation"],
    );
    assert.equal(
      (
        await runner.request(path + "/branch", "PUT", {
          conversationId: original,
        })
      ).status,
      200,
    );
    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    assert.equal(
      (await runner.request(path + "/settings")).body.sessionName,
      "Investigate streaming",
    );
    assert.equal(
      (
        await runner.request(path + "/settings", "PUT", {
          sessionName: "x".repeat(201),
        })
      ).status,
      400,
    );
    assert.equal(
      (await runner.request(path + "/settings", "PUT", { sessionName: "" }))
        .status,
      200,
    );
    assert.equal(
      (await runner.request(path + "/settings")).body.sessionName,
      undefined,
    );
  },
);

test(
  "clearing queued input preserves the active tool and committed history",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-clear-queue-"));
    const runner = await startRunner(directory);
    t.after(() => runner.stop());
    const path = "/v1/workspaces/queue-coder";
    const fifo = join(directory, "release");
    const marker = join(directory, "tool-started");
    const made = spawn("mkfifo", [fifo]);
    assert.equal((await once(made, "exit"))[0], 0);
    await runner.request(path, "PUT", {
      id: "queue-coder",
      name: "queue",
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    });
    const changes = watch(directory);
    const started = (async () => {
      for await (const event of changes) {
        if (event.filename === "tool-started") return;
      }
    })();
    t.after(() => changes.return());
    await runner.request(path + "/input", "POST", {
      requestId: "held-current",
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            { tool: "bash", args: { command: `touch ${marker}; cat ${fifo}` } },
          ],
          answer: "Active turn completed.",
        }),
    });
    await started;
    for (const [whenBusy, message] of [
      ["steer", "Queued steering"],
      ["followUp", "Queued follow-up"],
    ]) {
      assert.equal(
        (
          await runner.request(path + "/input", "POST", {
            requestId: whenBusy,
            message,
            whenBusy,
          })
        ).status,
        202,
      );
    }
    const expected = {
      steering: ["Queued steering"],
      followUp: ["Queued follow-up"],
    };
    assert.deepEqual((await runner.request(path + "/queue")).body, expected);
    const cleared = await runner.request(path + "/queue/clear", "POST", {});
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body, { cleared: 2, ...expected });
    assert.deepEqual((await runner.request(path + "/queue")).body, {
      steering: [],
      followUp: [],
    });
    await writeFile(fifo, "continue\n");
    await nextEvent(
      runner,
      "queue-coder",
      (event) =>
        event.kind === "assistant" &&
        event.data.text === "Active turn completed.",
    );
    const history = (await runner.request(path + "/history")).body.events;
    assert.equal(history.filter((event) => event.kind === "user").length, 1);
    assert.ok(
      history.some(
        (event) =>
          event.kind === "tool" && event.data.text.includes("continue"),
      ),
    );
    assert.equal(
      (await runner.request(path + "/queue/clear", "POST", {})).body.cleared,
      0,
    );
  },
);

test(
  "model cycling scope is validated against the workspace catalogue and persists",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-model-scope-"));
    let runner = await startRunner(directory);
    t.after(() => runner.stop());
    const path = "/v1/workspaces/scoped-coder";
    await runner.request(path, "PUT", {
      id: "scoped-coder",
      name: "scope",
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    });
    const available = (await runner.request(path + "/models")).body.models;
    const selected = available
      .slice(0, 2)
      .map((model) => `${model.provider}/${model.id}`);
    assert.ok(selected.length);
    const changed = await runner.request(path + "/settings", "PUT", {
      scopedModels: selected,
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.scopedModels, selected);
    for (const scopedModels of [
      ["absent/model"],
      [...selected, selected[0]],
      "all",
    ]) {
      assert.equal(
        (await runner.request(path + "/settings", "PUT", { scopedModels }))
          .status,
        400,
      );
    }
    assert.deepEqual(
      (await runner.request(path + "/settings")).body.scopedModels,
      selected,
    );
    await runner.stop("SIGKILL");
    runner = await startRunner(directory);
    assert.deepEqual(
      (await runner.request(path + "/settings")).body.scopedModels,
      selected,
    );
    assert.equal(
      (await runner.request(path + "/settings", "PUT", { scopedModels: [] }))
        .status,
      200,
    );
    assert.deepEqual(
      (await runner.request(path + "/settings")).body.scopedModels,
      [],
    );
  },
);

test("workspace behavior settings update through HTTP and persist across runner restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-settings-"));
  const id = "settings-coder";
  const path = `/v1/workspaces/${id}`;
  let runner = await startRunner(directory);
  t.after(() => runner.stop());
  assert.equal(
    (
      await runner.request(path, "PUT", {
        id,
        name: "settings",
        role: "coding",
        environment: "local",
        localRoot: join(directory, "repo"),
        model: { provider: "faux", id: "faux-1" },
      })
    ).status,
    200,
  );

  const defaults = await runner.request(path + "/settings");
  assert.equal(defaults.status, 200);
  assert.deepEqual(defaults.body, {
    thinkingLevel: "off",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompact: true,
    cacheWarmingMode: "off",
  });

  const changed = await runner.request(path + "/settings", "PUT", {
    thinkingLevel: "high",
    steeringMode: "all",
    followUpMode: "all",
    autoCompact: false,
    cacheWarmingMode: "idle",
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, {
    thinkingLevel: "high",
    steeringMode: "all",
    followUpMode: "all",
    autoCompact: false,
    cacheWarmingMode: "idle",
  });
  assert.equal(
    (await stat(join(directory, "sessions", id, "adm-settings.json"))).mode &
      0o777,
    0o600,
  );

  const secondId = "settings-isolated";
  const secondPath = `/v1/workspaces/${secondId}`;
  await runner.request(secondPath, "PUT", {
    id: secondId,
    name: "isolated settings",
    role: "bot",
    environment: "local",
    model: { provider: "faux", id: "faux-1" },
  });
  assert.deepEqual((await runner.request(secondPath + "/settings")).body, {
    thinkingLevel: "off",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompact: true,
    cacheWarmingMode: "off",
  });

  const invalid = await runner.request(path + "/settings", "PUT", {
    steeringMode: "parallel",
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_SETTINGS");
  const invalidCacheMode = await runner.request(path + "/settings", "PUT", {
    cacheWarmingMode: "always",
  });
  assert.equal(invalidCacheMode.status, 400);
  assert.deepEqual(
    (await runner.request(path + "/settings")).body,
    changed.body,
  );

  await runner.stop("SIGKILL");
  runner = await startRunner(directory);
  const recovered = await runner.request(path + "/settings");
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body, changed.body);
});

test(
  "idle cache warming follows a real Durable turn and persists the synthetic provider usage",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-cache-warming-"));
    const env = { HOME: directory };
    let runner = await startRunner(directory, env);
    t.after(() => runner.stop());
    const id = "cache-warming-coder";
    const path = `/v1/workspaces/${id}`;
    assert.equal(
      (
        await runner.request(path, "PUT", {
          id,
          name: id,
          role: "coding",
          environment: "local",
          localRoot: join(directory, "repo"),
          model: { provider: "faux", id: "faux-1" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await runner.request(path + "/settings", "PUT", {
          cacheWarmingMode: "idle",
        })
      ).status,
      200,
    );
    const before = await runner.request(path + "/history?diagnostics=true");
    assert.equal(
      (
        await runner.request(path + "/input", "POST", {
          requestId: "cache-warming-turn",
          // Supply the cacheable context explicitly, independent of host AGENTS.md files.
          message: `/faux ${JSON.stringify({
            answer: "real harness turn",
            context: "synthetic cacheable context ".repeat(1000),
          })}`,
        })
      ).status,
      202,
    );
    const assistant = await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" && event.seq > before.body.nextAfter,
      before.body.nextAfter,
      true,
      5000,
    );
    assert.equal(assistant.data.text, "real harness turn");
    let status;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      status = (await runner.request(path)).body;
      if (status.cacheWarming.lastUsage) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      status.cacheWarming.lastUsage,
      `warm usage missing: ${JSON.stringify(status.cacheWarming)}`,
    );
    assert.equal(status.cacheWarming.lastUsage.provider, "faux");
    assert.ok(status.cacheWarming.lastUsage.usage);
    const durable = new DatabaseSync(
      join(directory, "sessions", id, "session.sqlite"),
    );
    const records = durable
      .prepare("SELECT record FROM entries ORDER BY id DESC LIMIT 100")
      .all()
      .map(({ record }) => JSON.parse(record));
    durable.close();
    assert.ok(records.some((record) => record.kind === "adm.cache_warm"));
    await runner.stop("SIGKILL");
    runner = await startRunner(directory, env);
    status = (await runner.request(path)).body;
    assert.equal(
      status.cacheWarming.lastUsage?.provider,
      "faux",
      `cache warm entry was not restored; runner errors: ${runner.errors}`,
    );
  },
);

test(
  "steering mode controls how many queued inputs a real Durable turn admits at once",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-settings-steering-"),
    );
    const id = "settings-steering";
    const path = `/v1/workspaces/${id}`;
    const marker = join(directory, "tool-started");
    const runner = await startRunner(directory);
    t.after(() => runner.stop());
    await runner.request(path, "PUT", {
      id,
      name: "settings steering",
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    });
    const changed = await runner.request(path + "/settings", "PUT", {
      steeringMode: "all",
      followUpMode: "all",
    });
    assert.equal(changed.status, 200);
    const start = await runner.request(path + "/input", "POST", {
      requestId: "settings-hold-tool",
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            { tool: "bash", args: { command: `touch ${marker}; sleep 1` } },
          ],
          answer: "Initial turn complete.",
        }),
    });
    assert.equal(start.status, 202);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await access(marker);
    assert.equal(
      (
        await runner.request(path + "/input", "POST", {
          requestId: "settings-steer-one",
          whenBusy: "steer",
          message: "steer-one",
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await runner.request(path + "/input", "POST", {
          requestId: "settings-follow-up-one",
          whenBusy: "followUp",
          message: "follow-up-one",
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await runner.request(path + "/input", "POST", {
          requestId: "settings-follow-up-two",
          whenBusy: "followUp",
          message: "follow-up-two",
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await runner.request(path + "/input", "POST", {
          requestId: "settings-steer-two",
          whenBusy: "steer",
          message: "steer-two",
        })
      ).status,
      202,
    );
    await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" && event.data.text === "Echo: steer-two",
      0,
      false,
      10000,
    );
    await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" && event.data.text === "Echo: follow-up-two",
      0,
      false,
      10000,
    );
    const history = await runner.request(path + "/history");
    const events = history.body.events;
    const first = events.findIndex(
      (event) => event.kind === "user" && event.data.text === "steer-one",
    );
    const second = events.findIndex(
      (event) => event.kind === "user" && event.data.text === "steer-two",
    );
    assert.ok(first >= 0 && second > first);
    assert.equal(
      events
        .slice(first + 1, second)
        .some((event) => event.kind === "assistant"),
      false,
    );
    const firstFollowUp = events.findIndex(
      (event) => event.kind === "user" && event.data.text === "follow-up-one",
    );
    const secondFollowUp = events.findIndex(
      (event) => event.kind === "user" && event.data.text === "follow-up-two",
    );
    assert.ok(firstFollowUp >= 0 && secondFollowUp > firstFollowUp);
    assert.equal(
      events
        .slice(firstFollowUp + 1, secondFollowUp)
        .some((event) => event.kind === "assistant"),
      false,
    );
  },
);

test("model selection reports missing provider authentication without falling back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-model-auth-"));
  const runner = await startRunner(directory, {}, { useFaux: false });
  t.after(async () => runner.stop());
  const id = "model-auth";
  const path = `/v1/workspaces/${id}`;
  await runner.request(path, "PUT", {
    id,
    name: "model auth",
    role: "coding",
    environment: "local",
    localRoot: join(directory, "repo"),
  });
  const catalog = await runner.request(`${path}/models`);
  assert.equal(catalog.body.selected, undefined);
  assert.equal(
    catalog.body.providers.find((provider) => provider.id === "openai")
      ?.authenticated,
    false,
  );
  assert.deepEqual(catalog.body.models, []);
  const selection = await runner.request(`${path}/model`, "PUT", {
    provider: "openai",
    modelId: "gpt-4.1",
  });
  assert.equal(selection.status, 409);
  assert.equal(selection.body.error.code, "MODEL_AUTH_REQUIRED");
  assert.equal((await runner.request(path)).body.status, "needs_model");
  assert.deepEqual((await runner.request(`${path}/history`)).body.events, []);
});

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

test("per-workspace MCP server grants are rejected in favor of installation connectors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-mcp-removed-"));
  const runner = await startRunner(directory);
  t.after(() => runner.stop());
  const rejected = await runner.request("/v1/workspaces/mcp-bot", "PUT", {
    id: "mcp-bot",
    name: "lookup bot",
    role: "bot",
    environment: "local",
    model: { provider: "faux", id: "faux-1" },
    mcpServers: [{ id: "fixture", command: "/bin/true", tools: ["lookup"] }],
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "MCP_SERVERS_REMOVED");
  assert.match(rejected.body.error.message, /adm mcp add NAME URL/);
});

test(
  "goal and loop request receipts survive retries and reject request ID reuse",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-schedule-receipts-"),
    );
    const runner = await startRunner(directory);
    t.after(() => runner.stop());
    const config = {
      id: "receipt-coder",
      name: "receipt coder",
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    };
    assert.equal(
      (await runner.request(`/v1/workspaces/${config.id}`, "PUT", config))
        .status,
      200,
    );
    async function receiptRequest(path, value) {
      const response = await fetch(
        `${runner.url}/v1/workspaces/${config.id}/${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        },
      );
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : undefined,
      };
    }
    const goal = { description: "Ship the durable feature" };
    const firstGoal = await receiptRequest("goals", {
      requestId: "goal-create-1",
      value: goal,
    });
    const replayGoal = await receiptRequest("goals", {
      requestId: "goal-create-1",
      value: goal,
    });
    assert.equal(firstGoal.status, 200, JSON.stringify(firstGoal));
    assert.equal(replayGoal.status, 200, JSON.stringify(replayGoal));
    assert.deepEqual(
      replayGoal.body,
      firstGoal.body,
      `replay=${JSON.stringify(replayGoal)}`,
    );
    const reusedGoal = await receiptRequest("goals", {
      requestId: "goal-create-1",
      value: { description: "Different request" },
    });
    assert.equal(reusedGoal.status, 409);

    const loop = {
      prompt: "Review progress",
      intervalMs: 60000,
      nextAt: 2000000000000,
    };
    const firstLoop = await receiptRequest("loops", {
      requestId: "loop-create-1",
      value: loop,
    });
    const replayLoop = await receiptRequest("loops", {
      requestId: "loop-create-1",
      value: loop,
    });
    assert.equal(firstLoop.status, 200);
    assert.deepEqual(replayLoop.body, firstLoop.body);
    const reusedLoop = await receiptRequest("loops", {
      requestId: "loop-create-1",
      value: { ...loop, prompt: "Different request" },
    });
    assert.equal(reusedLoop.status, 409);
  },
);
