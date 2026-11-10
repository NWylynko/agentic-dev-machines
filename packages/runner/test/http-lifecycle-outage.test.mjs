import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unusedFixedPort } from "./fixed-port.mjs";
import {
  startRunner,
  nextEvent,
  writeLifecycleWorkspace,
} from "./http-fixture.mjs";

test(
  "a controller transport outage pauses new work while an active turn survives until the same lease is renewed",
  { timeout: 35_000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-lifecycle-outage-"),
    );
    const tokenFile = join(directory, "service-account-token");
    const workspaceConfigFile = join(directory, "workspace.json");
    const repository = join(directory, "repository");
    const marker = join(directory, "tool-started");
    await writeFile(tokenFile, "temporary-outage-identity\n", { mode: 0o600 });
    await writeFile(
      workspaceConfigFile,
      JSON.stringify({
        id: "workspace-lifecycle-outage",
        name: "lifecycle-outage",
        role: "coding",
        environment: "pod",
        localRoot: repository,
        model: { provider: "faux", id: "faux-1" },
      }),
    );
    let unavailable = false;
    let renewedDuringOutage;
    const renewalDuringOutage = new Promise((resolve) => {
      renewedDuringOutage = resolve;
    });
    const holder = "a1b2c3d4-e5f6-47a8-9012-123456789abc";
    const control = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {};
      const headers = { "content-type": "application/json" };
      if (
        request.headers.authorization !== "Bearer temporary-outage-identity"
      ) {
        response
          .writeHead(401, headers)
          .end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
        return;
      }
      if (unavailable) {
        if (request.url?.endsWith("/runtime/lease/renew"))
          renewedDuringOutage();
        response
          .writeHead(503, headers)
          .end(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE" } }));
        return;
      }
      response.writeHead(200, headers).end(
        JSON.stringify({
          workspaceId: "workspace-lifecycle-outage",
          holder: body.holder ?? holder,
          fencingToken: 1,
          expiresAt: Math.floor(Date.now() / 1000) + 30,
          valid: true,
        }),
      );
    });
    await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
    let runner;
    t.after(async () => {
      await runner?.stop();
      await new Promise((resolve) => control.close(resolve));
    });
    runner = await startRunner(
      join(directory, "state"),
      {},
      {
        tokenFile,
        workspaceConfigFile,
        lifecycleUrl: `http://127.0.0.1:${control.address().port}`,
        podUid: holder,
      },
    );

    const id = "workspace-lifecycle-outage";
    const active = await runner.request(
      `/v1/workspaces/${id}/input`,
      "POST",
      {
        requestId: "held-across-controller-update",
        message:
          "/faux " +
          JSON.stringify({
            calls: [
              {
                tool: "bash",
                args: {
                  command: `touch ${marker}; sleep 12; printf held > ${join(repository, "tool-finished")}`,
                },
              },
            ],
            answer:
              "The in-flight turn completed after the controller returned.",
          }),
      },
      undefined,
      "temporary-outage-identity",
    );
    assert.equal(active.status, 202);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await access(marker);
    unavailable = true;
    await renewalDuringOutage;

    const canceled = new AbortController();
    const canceledAdmission = runner.request(
      `/v1/workspaces/${id}/input`,
      "POST",
      {
        requestId: "canceled-while-controller-is-down",
        message: "This canceled admission must never be queued.",
      },
      canceled.signal,
      "temporary-outage-identity",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    canceled.abort();
    await assert.rejects(canceledAdmission, { name: "AbortError" });

    const waiting = runner.request(
      `/v1/workspaces/${id}/input`,
      "POST",
      {
        requestId: "admission-waits-for-authority",
        message:
          "Continue after the controller has the same runtime lease again.",
      },
      undefined,
      "temporary-outage-identity",
    );
    const early = await Promise.race([
      waiting.then((result) => ({ result })),
      new Promise((resolve) => setTimeout(() => resolve({ held: true }), 100)),
    ]);
    assert.deepEqual(early, { held: true });
    assert.equal((await fetch(`${runner.url}/health`)).status, 200);

    unavailable = false;
    const resumed = await waiting;
    assert.equal(resumed.status, 202);
    await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" &&
        event.data.text.includes("controller returned"),
      0,
      false,
      25_000,
      "temporary-outage-identity",
    );
    assert.equal(
      await readFile(join(repository, "tool-finished"), "utf8"),
      "held",
    );
  },
);

test(
  "a running workspace outlives a lifecycle that answers 503 and then refuses connections, and stops only when the lifecycle rejects it",
  { timeout: 90_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-long-outage-"));
    const tokenFile = join(directory, "service-account-token");
    const workspaceConfigFile = join(directory, "workspace.json");
    const repository = join(directory, "repository");
    const started = join(directory, "tool-started");
    const release = join(directory, "tool-release");
    const id = "workspace-long-outage";
    await writeFile(tokenFile, "long-outage-identity\n", { mode: 0o600 });
    await writeFile(
      workspaceConfigFile,
      JSON.stringify({
        id,
        name: "long-outage",
        role: "coding",
        environment: "pod",
        localRoot: repository,
        model: { provider: "faux", id: "faux-1" },
      }),
    );
    const holder = "a1b2c3d4-e5f6-47a8-9012-123456789abc";
    // "ok", "unavailable" (503) or "forbidden" (403 on renewal). Refused
    // connections are the control server not listening at all.
    let mode = "ok";
    let renewalWhileUnavailable;
    const renewedWhileUnavailable = new Promise((resolve) => {
      renewalWhileUnavailable = resolve;
    });
    const control = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {};
      const headers = { "content-type": "application/json" };
      const renewal = request.url?.endsWith("/runtime/lease/renew");
      if (mode === "unavailable") {
        if (renewal) renewalWhileUnavailable();
        response
          .writeHead(503, headers)
          .end(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE" } }));
        return;
      }
      if (mode === "forbidden" && renewal) {
        response.writeHead(403, headers).end(
          JSON.stringify({
            error: {
              code: "RUNTIME_FORBIDDEN",
              message: "runtime lease is held by another pod",
            },
          }),
        );
        return;
      }
      response.writeHead(200, headers).end(
        JSON.stringify({
          workspaceId: id,
          holder: body.holder ?? holder,
          fencingToken: 1,
          // The real 300 s lease, issued by a lifecycle whose clock runs
          // 10 s ahead of this node's.
          expiresAt: Math.floor(Date.now() / 1000) + 310,
          valid: true,
          allowed: true,
        }),
      );
    });
    await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
    const port = control.address().port;
    let runner;
    t.after(async () => {
      await runner?.stop();
      await new Promise((resolve) => control.close(resolve));
    });
    runner = await startRunner(
      join(directory, "state"),
      {},
      {
        tokenFile,
        workspaceConfigFile,
        lifecycleUrl: `http://127.0.0.1:${port}`,
        podUid: holder,
      },
    );
    const waitForErrors = async (pattern) => {
      while (!pattern.test(runner.errors))
        await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const active = await runner.request(
      `/v1/workspaces/${id}/input`,
      "POST",
      {
        requestId: "turn-across-long-outage",
        message:
          "/faux " +
          JSON.stringify({
            calls: [
              {
                tool: "bash",
                args: {
                  command: `touch ${started}; while [ ! -e ${release} ]; do sleep 0.1; done; printf held > ${join(repository, "tool-finished")}`,
                },
              },
            ],
            answer: "The turn outlived the lifecycle outage.",
          }),
      },
      undefined,
      "long-outage-identity",
    );
    assert.equal(active.status, 202);
    while (
      !(await access(started).then(
        () => true,
        () => false,
      ))
    )
      await new Promise((resolve) => setTimeout(resolve, 20));

    mode = "unavailable";
    await renewedWhileUnavailable;
    await waitForErrors(/lease renewal failed, lifecycle unavailable.*503/);
    // Then the lifecycle Pod is gone entirely: connections are refused.
    await new Promise((resolve) => {
      control.close(resolve);
      control.closeAllConnections();
    });
    await waitForErrors(
      /lease renewal failed, lifecycle unavailable.*ECONNREFUSED/,
    );
    const degraded = await fetch(`${runner.url}/health`);
    assert.equal(degraded.status, 200);
    assert.equal((await degraded.json()).status, "degraded");
    assert.doesNotMatch(runner.errors, /lost its lifecycle fence/);

    mode = "ok";
    await new Promise((resolve) => control.listen(port, "127.0.0.1", resolve));
    const resumed = await runner.request(
      `/v1/workspaces/${id}/input`,
      "POST",
      {
        requestId: "input-after-lifecycle-returns",
        message: "Accepted once the lifecycle is back.",
      },
      undefined,
      "long-outage-identity",
    );
    assert.equal(resumed.status, 202);
    await writeFile(release, "");
    // The tool finishes inside the same turn, and the input admitted after
    // the outage is answered by it.
    const toolResult = await nextEvent(
      runner,
      id,
      (event) => event.kind === "tool" && event.data.name === "bash",
      0,
      false,
      25_000,
      "long-outage-identity",
    );
    assert.equal(toolResult.data.isError, false);
    await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" &&
        event.data.text.includes("Accepted once the lifecycle is back."),
      toolResult.seq,
      false,
      25_000,
      "long-outage-identity",
    );
    assert.equal(
      await readFile(join(repository, "tool-finished"), "utf8"),
      "held",
    );

    // A rejection, unlike unavailability, stops the runtime.
    mode = "forbidden";
    await waitForErrors(
      /lost its lifecycle fence: runtime lease is held by another pod/,
    );
    const health = await fetch(`${runner.url}/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).status, "error");
  },
);

test(
  "a runner started while its lifecycle is too slow waits unready and retries the lease instead of exiting",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-lease-wait-"));
    const id = "workspace-lease-wait";
    const { tokenFile, workspaceConfigFile } = await writeLifecycleWorkspace(
      directory,
      id,
    );
    const holder = "a1b2c3d4-e5f6-47a8-9012-123456789abc";
    // Lease requests are held unanswered, like the lifecycle that answered only
    // after runners had given up on it (TASK-82).
    const heldLeases = [];
    let leaseArrived;
    let nextLease = new Promise((resolve) => (leaseArrived = resolve));
    const control = createServer(async (request, response) => {
      for await (const _chunk of request) {
      }
      if (request.url.endsWith("/runtime/lease")) {
        heldLeases.push(response);
        leaseArrived();
        nextLease = new Promise((resolve) => (leaseArrived = resolve));
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"allowed":true,"valid":true}');
    });
    await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      control.closeAllConnections();
      await new Promise((resolve) => control.close(resolve));
    });
    const port = await unusedFixedPort();
    const url = `http://127.0.0.1:${port}`;
    const starting = startRunner(
      join(directory, "state"),
      {},
      {
        port,
        tokenFile,
        workspaceConfigFile,
        lifecycleUrl: `http://127.0.0.1:${control.address().port}`,
        podUid: holder,
      },
    );
    starting.catch(() => {});
    await nextLease;
    const retried = nextLease;
    // The first request times out on the runner's side; it must try again.
    await Promise.race([retried, starting]);
    assert.equal(heldLeases.length, 2, "the runner retried its lease");

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200, "liveness holds while waiting");
    const healthBody = await health.json();
    assert.equal(healthBody.status, "starting");
    assert.match(healthBody.reason, /lease request failed: .*timeout/);
    const ready = await fetch(`${url}/ready`);
    assert.equal(ready.status, 503, "readiness fails without a lease");
    assert.equal((await ready.json()).error.code, "RUNTIME_STARTING");
    const early = await fetch(`${url}/v1/workspaces/${id}/runtime-status`);
    assert.equal(early.status, 503, "no work is served without a lease");
    const earlyBody = await early.json();
    assert.equal(earlyBody.error.code, "RUNTIME_STARTING");
    assert.match(
      earlyBody.error.message,
      /waiting for its lifecycle lease: .*timeout/,
    );

    heldLeases[1].writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        workspaceId: id,
        holder,
        fencingToken: 3,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    );
    const runner = await starting;
    t.after(() => runner.stop());
    assert.match(
      runner.errors,
      /Waiting for workspace lifecycle lease: .*aborted due to timeout/,
    );
    assert.equal((await fetch(`${url}/ready`)).status, 200);
    const status = await runner.request(`/v1/workspaces/${id}/runtime-status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.activity.status, "idle");
  },
);
