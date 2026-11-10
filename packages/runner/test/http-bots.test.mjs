import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  startRunner,
  freePort,
  startPodRunner,
  startBotLifecycle,
  nextEvent,
} from "./http-fixture.mjs";

test(
  "a bot publishes only explicit messages and cannot use coding tools through Code Mode",
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
  "a pod bot controls isolated coding runtimes, observes durable operations, and keeps broad discovery after restart",
  { timeout: 45000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-agent-directory-"),
    );
    const workspaces = [];
    const port = await freePort();
    const lifecycle = await startBotLifecycle(
      join(directory, "management"),
      workspaces,
      {},
      t,
    );
    const botId = "directory-bot";
    const botWorkspace = {
      id: botId,
      name: "bot",
      role: "bot",
      phase: "ready",
      namespace: "fixture-directory-bot",
    };
    const botPod = await startPodRunner(directory, lifecycle, {
      ...botWorkspace,
      host: "127.0.0.1",
      port,
      podUid: "11111111-1111-4111-8111-111111111111",
    });
    const targets = new Map();
    async function addTarget(id, name, host) {
      const target = await startPodRunner(directory, lifecycle, {
        id,
        name,
        role: "coding",
        host,
        port,
        podUid:
          id === "alpha"
            ? "22222222-2222-4222-8222-222222222222"
            : "33333333-3333-4333-8333-333333333333",
      });
      targets.set(id, target);
      return target;
    }
    await addTarget("alpha", "project-albatross", "127.0.0.2");
    await addTarget("beta", "project-bee", "127.0.0.3");
    const bot = botPod.runner;
    const targetRunner = (id) => targets.get(id)?.runner;
    t.after(async () => {
      await Promise.all([
        bot.stop(),
        ...[...targets.values()].map(({ runner }) => runner.stop()),
      ]);
      await lifecycle.close();
    });
    const authRequest = async (runner, token, path, method = "GET", body) => {
      const response = await fetch(runner.url + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
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
      const input = await authRequest(
        bot,
        botPod.token,
        `/v1/workspaces/${botId}/input`,
        "POST",
        {
          message:
            "/faux " +
            JSON.stringify({ calls, answer: "Private lifecycle result." }),
          requestId,
        },
      );
      assert.equal(input.status, 202);
      const event = await nextEvent(
        bot,
        botId,
        (value) =>
          value.kind === "tool" &&
          value.data.name === (code ? "codemode" : tool),
        cursor,
        true,
        0,
        botPod.token,
      );
      cursor = event.seq;
      return event.data;
    }
    const listed = JSON.parse((await call("listAgents", {}, "list")).text);
    assert.deepEqual(
      listed.agents.map(({ id, name }) => ({ id, name })),
      [
        { id: "alpha", name: "project-albatross" },
        { id: "beta", name: "project-bee" },
      ],
    );
    const codeMode = await call("listAgents", {}, "list-code", true);
    assert.equal(codeMode.isError, false);
    assert.match(codeMode.text, /project-bee/);

    const target = targetRunner("alpha");
    const remoteInput = await authRequest(
      target,
      targets.get("alpha").token,
      "/v1/workspaces/alpha/input",
      "POST",
      {
        message:
          "/faux " +
          JSON.stringify({
            calls: [
              {
                tool: "write",
                args: { path: join(directory, "tool.txt"), content: "done" },
              },
            ],
            answer: "written",
          }),
        requestId: "history-with-tool",
      },
    );
    assert.equal(remoteInput.status, 202);
    await nextEvent(
      target,
      "alpha",
      (event) => event.kind === "tool" && event.data.name === "write",
      0,
      true,
      0,
      targets.get("alpha").token,
    );
    const monitored = JSON.parse(
      (
        await call(
          "monitorAgent",
          { agentId: "alpha", after: 0, limit: 2 },
          "monitor",
        )
      ).text,
    );
    assert.equal(monitored.id, "alpha");
    let historyEvents = monitored.history.events;
    let nextAfter = monitored.history.nextAfter;
    while (monitored.history.hasMore) {
      const page = JSON.parse(
        (
          await call(
            "monitorAgent",
            { agentId: "alpha", after: nextAfter, limit: 100 },
            `monitor-${nextAfter}`,
          )
        ).text,
      ).history;
      historyEvents = [...historyEvents, ...page.events];
      nextAfter = page.nextAfter;
      if (!page.hasMore) break;
    }
    assert.ok(
      historyEvents.some(
        (event) => event.kind === "tool" && event.data.name === "write",
      ),
    );

    const prompt = JSON.parse(
      (
        await call(
          "promptAgent",
          { agentId: "alpha", message: "Report your status." },
          "prompt",
        )
      ).text,
    );
    assert.equal(prompt.status, "admitted");
    await nextEvent(
      target,
      "alpha",
      (event) =>
        event.kind === "assistant" &&
        event.data.text.includes("Report your status."),
      0,
      true,
      0,
      targets.get("alpha").token,
    );
    assert.equal(
      JSON.parse(
        (
          await call(
            "saveAgentGoal",
            { agentId: "alpha", goal: { description: "Ship it" } },
            "goal",
          )
        ).text,
      ).description,
      "Ship it",
    );
    assert.equal(
      JSON.parse(
        (
          await call(
            "saveAgentLoop",
            {
              agentId: "beta",
              loop: {
                prompt: "Check progress",
                intervalMs: 60000,
                nextAt: 2000000000000,
              },
            },
            "loop",
          )
        ).text,
      ).prompt,
      "Check progress",
    );
    assert.equal(
      (
        await call(
          "configureAgentModel",
          { agentId: "beta", provider: "faux", modelId: "faux-1" },
          "model",
        )
      ).isError,
      false,
    );

    const created = JSON.parse(
      (
        await call(
          "createAgent",
          {
            name: "new-agent",
            storageClass: "fast",
            storageSize: "10Gi",
            cpu: "2",
            memory: "4Gi",
            model: { provider: "faux", id: "faux-1" },
            repository: "owner/project",
            branch: "feature/bot-work",
            base: "origin/release",
          },
          "create",
        )
      ).text,
    );
    assert.equal(created.status, "accepted");
    const createSpec = lifecycle.operations.get(created.operationId).request
      .spec;
    assert.equal(createSpec.repository, "owner/project");
    assert.equal(createSpec.branch, "feature/bot-work");
    assert.equal(createSpec.base, "origin/release");
    assert.equal(createSpec.cwd, "/repos/owner/project");
    // The lifecycle fills the image from the cluster's release.
    assert.equal("image" in createSpec, false);
    const operation = JSON.parse(
      (
        await call(
          "monitorAgentOperation",
          { operationId: created.operationId },
          "create-status",
        )
      ).text,
    );
    assert.equal(operation.operationId, created.operationId);
    const destroyed = JSON.parse(
      (await call("destroyAgent", { agentId: "beta" }, "destroy")).text,
    );
    assert.equal(destroyed.kind, "delete");
    assert.equal(destroyed.workspaceId, "beta");
    assert.equal(
      JSON.parse(
        (
          await call(
            "monitorAgentOperation",
            { operationId: destroyed.operationId },
            "delete-status",
          )
        ).text,
      ).operationId,
      destroyed.operationId,
    );

    await bot.stop();
    const restarted = await startPodRunner(directory, lifecycle, {
      ...botWorkspace,
      host: "127.0.0.1",
      port,
      podUid: "11111111-1111-4111-8111-111111111111",
    });
    t.after(() => restarted.runner.stop());
    const persisted = await authRequest(
      restarted.runner,
      restarted.token,
      `/v1/workspaces/${botId}`,
    );
    assert.equal(persisted.status, 200);
    const afterRestart = await authRequest(
      restarted.runner,
      restarted.token,
      `/v1/workspaces/${botId}/input`,
      "POST",
      {
        message:
          "/faux " +
          JSON.stringify({
            calls: [{ tool: "listAgents", args: {} }],
            answer: "Private.",
          }),
        requestId: "restart-list",
      },
    );
    assert.equal(afterRestart.status, 202);
    const afterEvent = await nextEvent(
      restarted.runner,
      botId,
      (event) => event.kind === "tool" && event.data.name === "listAgents",
      0,
      true,
      0,
      restarted.token,
    );
    assert.match(afterEvent.data.text, /project-albatross/);
  },
);

test(
  "aborting a bot turn cancels its in-flight lifecycle request",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-bot-cancel-"));
    const port = await freePort();
    const lifecycle = await startBotLifecycle(
      join(directory, "management"),
      [],
      { holdDirectory: true },
      t,
    );
    const pod = await startPodRunner(directory, lifecycle, {
      id: "cancel-bot",
      name: "bot",
      role: "bot",
      host: "127.0.0.1",
      port,
      podUid: "11111111-1111-4111-8111-111111111111",
    });
    t.after(async () => {
      await pod.runner.stop();
      await lifecycle.close();
    });
    const call = await pod.runner.request(
      "/v1/workspaces/cancel-bot/input",
      "POST",
      {
        message: `/faux ${JSON.stringify({ calls: [{ tool: "listAgents", args: {} }] })}`,
        requestId: "cancel-management-request",
      },
      undefined,
      pod.token,
    );
    assert.equal(call.status, 202);
    await lifecycle.directoryRequest;
    assert.equal(
      (
        await pod.runner.request(
          "/v1/workspaces/cancel-bot/abort",
          "POST",
          {},
          undefined,
          pod.token,
        )
      ).status,
      200,
    );
    await lifecycle.directoryAbort;
  },
);

test(
  "a pod bot discovers coding agents created later through direct tools and Code Mode",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-bot-late-agent-"),
    );
    const port = await freePort();
    const lifecycle = await startBotLifecycle(
      join(directory, "management"),
      [],
      {},
      t,
    );
    const bot = await startPodRunner(directory, lifecycle, {
      id: "late-agent-bot",
      name: "bot",
      role: "bot",
      host: "127.0.0.1",
      port,
      podUid: "11111111-1111-4111-8111-111111111111",
    });
    const target = await startPodRunner(directory, lifecycle, {
      id: "created-after-bot",
      name: "new-project",
      role: "coding",
      host: "127.0.0.2",
      port,
      podUid: "22222222-2222-4222-8222-222222222222",
    });
    t.after(async () => {
      await bot.runner.stop();
      await target.runner.stop();
      await lifecycle.close();
    });
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
      assert.equal(
        (
          await bot.runner.request(
            "/v1/workspaces/late-agent-bot/input",
            "POST",
            {
              message:
                "/faux " +
                JSON.stringify({ calls, answer: "Private lifecycle result." }),
              requestId,
            },
            undefined,
            bot.token,
          )
        ).status,
        202,
      );
      const event = await nextEvent(
        bot.runner,
        "late-agent-bot",
        (value) =>
          value.kind === "tool" &&
          value.data.name === (code ? "codemode" : tool),
        cursor,
        true,
        0,
        bot.token,
      );
      cursor = event.seq;
      return event.data;
    }
    const direct = JSON.parse((await call("listAgents", {}, "late-list")).text);
    assert.deepEqual(direct.agents, [
      {
        id: "created-after-bot",
        name: "new-project",
        status: "idle",
        phase: "ready",
        ready: true,
      },
    ]);
    const throughCodeMode = await call(
      "listAgents",
      {},
      "late-list-codemode",
      true,
    );
    assert.equal(throughCodeMode.isError, false);
    assert.match(throughCodeMode.text, /created-after-bot/);
    assert.equal(
      (
        await target.runner.request(
          "/v1/workspaces/created-after-bot",
          "GET",
          undefined,
          undefined,
          bot.token,
        )
      ).status,
      200,
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
