import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  startRunner,
  startBotLifecycle,
  startMaintenanceAckRunner,
  maintenanceAckWindow,
} from "./http-fixture.mjs";

test("a workspace runtime authenticates every management route while keeping health public", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-auth-"));
  const tokenFile = join(directory, "runtime-token");
  await writeFile(tokenFile, "workspace-runtime-secret\n", { mode: 0o600 });
  const runner = await startRunner(directory, {}, { tokenFile });
  t.after(() => runner.stop());

  assert.deepEqual((await runner.request("/health")).body, {
    status: "ok",
    version: "0.1.0",
  });
  assert.equal((await runner.request("/v1/workspaces")).status, 401);
  const authorized = await fetch(`${runner.url}/v1/workspaces`, {
    headers: { authorization: "Bearer workspace-runtime-secret" },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { workspaces: [] });
});

test("a pod runtime opens its immutable workspace directly from mounted runtime configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-pod-"));
  const configPath = join(directory, "workspace.json");
  await writeFile(
    configPath,
    JSON.stringify({
      id: "workspace-pod-runtime",
      name: "pod-runtime",
      role: "bot",
      environment: "pod",
    }),
  );
  const runner = await startRunner(
    directory,
    {},
    { workspaceConfigFile: configPath, defaultModel: false },
  );
  t.after(() => runner.stop());

  const response = await runner.request("/v1/workspaces/workspace-pod-runtime");
  assert.equal(response.status, 200);
  assert.equal(response.body.id, "workspace-pod-runtime");
  assert.equal(response.body.role, "bot");
  assert.equal(response.body.status, "needs_model");
});

test("a mounted bot runtime keeps its identity when the Pod restarts", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "adm-runner-mounted-bot-restart-"),
  );
  const configPath = join(directory, "workspace.json");
  await writeFile(
    configPath,
    JSON.stringify({
      id: "mounted-bot-restart",
      name: "watcher",
      role: "bot",
      environment: "pod",
    }),
  );
  let runner = await startRunner(
    directory,
    {},
    { workspaceConfigFile: configPath, defaultModel: false },
  );
  assert.equal(
    (await runner.request("/v1/workspaces/mounted-bot-restart")).status,
    200,
  );
  await runner.stop();
  runner = await startRunner(
    directory,
    {},
    { workspaceConfigFile: configPath, defaultModel: false },
  );
  t.after(() => runner.stop());
  assert.equal(
    (await runner.request("/v1/workspaces/mounted-bot-restart")).status,
    200,
  );
});

test(
  "runtime status answers with activity and the selected model while the shared provider catalogue is slow",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-runtime-status-slow-catalogue-"),
    );
    const lifecycle = await startBotLifecycle(
      join(directory, "management"),
      [],
      { holdProviderCatalog: true },
      t,
    );
    const id = "runtime-status-slow-catalogue";
    const token = "token-runtime-status-slow-catalogue";
    const tokenFile = await lifecycle.addWorkspace(
      { id, name: "slow-catalogue", role: "coding", phase: "ready" },
      token,
    );
    const workspaceConfigFile = join(directory, "workspace.json");
    await writeFile(
      workspaceConfigFile,
      JSON.stringify({
        id,
        name: "slow-catalogue",
        role: "coding",
        environment: "pod",
        localRoot: join(directory, "repos"),
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      }),
      { mode: 0o600 },
    );
    const runner = await startRunner(
      join(directory, "runner"),
      {
        ADM_LIFECYCLE_URL: lifecycle.url,
        ADM_LIFECYCLE_IDENTITY_TOKEN_FILE: tokenFile,
      },
      {
        useFaux: false,
        tokenFile,
        workspaceConfigFile,
        lifecycleUrl: lifecycle.url,
        podUid: "44444444-4444-4444-8444-444444444444",
      },
    );
    t.after(async () => {
      await runner.stop();
      await lifecycle.close();
    });
    const catalogueRequestsBefore = lifecycle.providerCatalogRequests.length;
    const statuses = await Promise.all(
      [1, 2, 3].map(() =>
        runner.request(`/v1/workspaces/${id}/runtime-status`),
      ),
    );
    for (const status of statuses) {
      assert.equal(status.status, 200);
      // Coding Pod runtimes also report the built-in browser (TASK-115); its
      // state depends on whether this host has the Playwright MCP.
      const { browser, ...rest } = status.body;
      assert.match(browser.status, /^(connected|error)$/);
      assert.deepEqual(rest, {
        activity: { status: "idle" },
        selectedModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      });
    }
    assert.equal(
      lifecycle.providerCatalogRequests.length,
      catalogueRequestsBefore,
      "runtime status makes no shared provider catalogue requests",
    );
  },
);

test("ownership loss during input admission rejects promptly and closes the workspace", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "adm-runner-admission-fence-"),
  );
  const tokenFile = join(directory, "token");
  const workspaceConfigFile = join(directory, "workspace.json");
  const id = "workspace-admission-fence";
  await writeFile(tokenFile, "pod-token");
  await writeFile(
    workspaceConfigFile,
    JSON.stringify({
      id,
      name: "admission-fence",
      role: "bot",
      environment: "pod",
    }),
  );
  let armed = false;
  let checks = 0;
  const control = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    // Allow the route and serialized request checks, then revoke at admission.
    const denied = request.url.endsWith("/check") && armed && ++checks >= 3;
    response.writeHead(denied ? 410 : 200, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        denied
          ? {
              error: {
                code: "WORKSPACE_DELETED",
                message: "Workspace is deleting",
              },
            }
          : request.url.endsWith("/lease")
            ? {
                workspaceId: id,
                holder: body.holder,
                fencingToken: 7,
                expiresAt: Math.floor(Date.now() / 1000) + 30,
              }
            : { valid: true, allowed: true },
      ),
    );
  });
  await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => control.close(resolve)));
  const runner = await startRunner(
    directory,
    {},
    {
      defaultModel: false,
      tokenFile,
      workspaceConfigFile,
      lifecycleUrl: `http://127.0.0.1:${control.address().port}`,
      podUid: "a1b2c3d4-e5f6-47a8-9012-123456789abc",
    },
  );
  // This test must also clean up a runtime deadlocked during shutdown.
  t.after(() => runner.stop("SIGKILL"));
  armed = true;
  const rejected = await runner.request(
    `/v1/workspaces/${id}/input`,
    "POST",
    {
      message: "Must not be admitted",
      requestId: "fenced-admission",
    },
    AbortSignal.timeout(3000),
    "pod-token",
  );
  assert.equal(checks, 3, "ownership is revoked inside the admission check");
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.error.code, "RUNTIME_OWNERSHIP_LOST");
  assert.equal((await runner.request("/health")).status, 503);
  await runner.stop();
});

test("workspace requests are authorized by lifecycle against the caller's projected identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-lifecycle-auth-"));
  const tokenFile = join(directory, "service-account-token");
  const workspaceConfigFile = join(directory, "workspace.json");
  await writeFile(tokenFile, "rotating-pod-identity-token\n", { mode: 0o600 });
  await writeFile(
    workspaceConfigFile,
    JSON.stringify({
      id: "workspace-lifecycle-auth",
      name: "lifecycle-auth",
      role: "bot",
      environment: "pod",
      model: { provider: "faux", id: "faux-1" },
    }),
  );
  const authorizations = [];
  let deleting = false;
  const control = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    authorizations.push({
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    const authorized =
      request.headers.authorization === "Bearer rotating-pod-identity-token";
    const leasePath = request.url?.endsWith("/runtime/lease");
    const checkPath = request.url?.endsWith("/runtime/check");
    const resourceDenied = body.action === "resources";
    const status = !authorized
      ? 401
      : resourceDenied
        ? 403
        : checkPath && deleting
          ? 410
          : 200;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        !authorized
          ? { error: { code: "UNAUTHORIZED" } }
          : resourceDenied
            ? {
                error: {
                  code: "PROJECT_RESOURCES_FORBIDDEN",
                  message:
                    "Only the owning coding workspace can manage resources",
                },
              }
            : leasePath
              ? {
                  workspaceId: "workspace-lifecycle-auth",
                  holder: body.holder,
                  fencingToken: 7,
                  expiresAt: Math.floor(Date.now() / 1000) + 30,
                }
              : checkPath && deleting
                ? {
                    error: {
                      code: "WORKSPACE_DELETED",
                      message: "Workspace is deleting",
                    },
                  }
                : checkPath
                  ? { valid: true }
                  : { allowed: true },
      ),
    );
  });
  await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
  const controlUrl = `http://127.0.0.1:${control.address().port}`;
  let runner;
  t.after(async () => {
    await runner?.stop();
    await new Promise((resolve) => control.close(resolve));
  });
  runner = await startRunner(
    directory,
    {},
    {
      tokenFile,
      workspaceConfigFile,
      lifecycleUrl: controlUrl,
      podUid: "a1b2c3d4-e5f6-47a8-9012-123456789abc",
    },
  );

  const denied = await fetch(`${runner.url}/v1/workspaces`);
  assert.equal(denied.status, 401);
  const response = await fetch(`${runner.url}/v1/workspaces`, {
    headers: { authorization: "Bearer rotating-pod-identity-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    authorizations.filter((entry) => entry.path.endsWith("/authorize")),
    [
      {
        path: "/v1/workspaces/workspace-lifecycle-auth/runtime/authorize",
        authorization: "",
        body: { action: "read" },
      },
      {
        path: "/v1/workspaces/workspace-lifecycle-auth/runtime/authorize",
        authorization: "Bearer rotating-pod-identity-token",
        body: { action: "read" },
      },
    ],
  );
  assert.ok(
    authorizations.some((entry) => entry.path.endsWith("/runtime/check")),
    "Durable commits and requests must check the lifecycle fence",
  );
  // Runtime status (activity + selected model) needs no token and no lifecycle
  // authorize round trip: the workspace NetworkPolicy admits only the
  // lifecycle and bots, and `adm list` reads every Pod (TASK-67).
  const authorizationsBeforeStatus = authorizations.filter((entry) =>
    entry.path.endsWith("/authorize"),
  ).length;
  const projectedStatus = await fetch(
    `${runner.url}/v1/workspaces/workspace-lifecycle-auth/runtime-status`,
  );
  assert.equal(projectedStatus.status, 200);
  assert.equal(
    authorizations.filter((entry) => entry.path.endsWith("/authorize")).length,
    authorizationsBeforeStatus,
    "runtime status makes no lifecycle authorize request",
  );
  assert.equal(
    (await fetch(`${runner.url}/v1/workspaces/someone-else/runtime-status`))
      .status,
    404,
    "unauthenticated runtime status serves only this runtime's own workspace",
  );
  const projectedBody = await projectedStatus.json();
  assert.ok(["idle", "running"].includes(projectedBody.activity.status));
  assert.deepEqual(projectedBody.selectedModel, {
    provider: "faux",
    id: "faux-1",
  });
  assert.ok(
    !authorizations.some(
      (entry) => entry.authorization === "Bearer lifecycle-controller-token",
    ),
    "the controller credential never crosses into the workspace Pod",
  );
  for (const [endpoint, method, body] of [
    ["resources", "GET"],
    ["tools", "GET"],
    ["trust", "GET"],
    ["trust", "PUT", { trusted: true }],
    ["resources/reload", "POST", {}],
    ["extensions", "GET"],
    ["extensions/commands/review", "POST", {}],
  ]) {
    const result = await fetch(
      `${runner.url}/v1/workspaces/workspace-lifecycle-auth/${endpoint}`,
      {
        method,
        headers: {
          authorization: "Bearer rotating-pod-identity-token",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    assert.equal(result.status, 403);
    assert.equal(
      (await result.json()).error.code,
      "PROJECT_RESOURCES_FORBIDDEN",
    );
    assert.equal(
      authorizations.filter((entry) => entry.path.endsWith("/authorize")).at(-1)
        .body.action,
      "resources",
    );
  }
  const admitted = await fetch(
    `${runner.url}/v1/workspaces/workspace-lifecycle-auth/input`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer rotating-pod-identity-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "Persist this request",
        requestId: "fenced-commit",
      }),
    },
  );
  assert.equal(admitted.status, 202);
  const commitChecks = authorizations.filter((entry) =>
    entry.path.endsWith("/runtime/check"),
  ).length;
  assert.ok(
    commitChecks >= 2,
    "workspace admission and the Durable SQLite commit both check the lifecycle fence",
  );
  deleting = true;
  const fenced = await fetch(
    `${runner.url}/v1/workspaces/workspace-lifecycle-auth/input`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer rotating-pod-identity-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "Must not be admitted",
        requestId: "after-delete",
      }),
    },
  );
  const rejection = await fenced.json();
  // An in-flight commit may observe deletion before this request reaches its own fence check.
  assert.ok(
    (fenced.status === 503 &&
      rejection.error.code === "RUNTIME_OWNERSHIP_LOST") ||
      (fenced.status === 410 && rejection.error.code === "WORKSPACE_DELETED"),
    JSON.stringify({ status: fenced.status, rejection }),
  );
  const readiness = await fetch(`${runner.url}/health`);
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).status, "error");
  const closed = await fetch(
    `${runner.url}/v1/workspaces/workspace-lifecycle-auth`,
    { headers: { authorization: "Bearer rotating-pod-identity-token" } },
  );
  assert.equal(closed.status, 410);
  assert.equal((await closed.json()).error.code, "WORKSPACE_DELETED");
});

test(
  "canceling a blocked authoritative check does not fence the workspace",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-canceled-check-"),
    );
    const tokenFile = join(directory, "service-account-token");
    const workspaceConfigFile = join(directory, "workspace.json");
    await writeFile(tokenFile, "canceled-check-identity\n", { mode: 0o600 });
    await writeFile(
      workspaceConfigFile,
      JSON.stringify({
        id: "workspace-canceled-check",
        name: "canceled-check",
        role: "coding",
        environment: "pod",
        localRoot: directory,
        model: { provider: "faux", id: "faux-1" },
      }),
    );
    const holder = "a1b2c3d4-e5f6-47a8-9012-123456789abc";
    let blockCheck = false;
    let checkEnteredResolve;
    const checkEntered = new Promise((resolve) => {
      checkEnteredResolve = resolve;
    });
    const control = createServer(async (request, response) => {
      for await (const _chunk of request) {
      }
      if (request.url?.endsWith("/runtime/authorize")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"allowed":true}');
        return;
      }
      if (request.url?.endsWith("/runtime/check") && blockCheck) {
        checkEnteredResolve();
        return;
      }
      const body = request.url?.endsWith("/runtime/lease")
        ? {
            workspaceId: "workspace-canceled-check",
            holder,
            fencingToken: 1,
            expiresAt: Math.floor(Date.now() / 1000) + 60,
          }
        : {
            workspaceId: "workspace-canceled-check",
            holder,
            fencingToken: 1,
            valid: true,
          };
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
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

    blockCheck = true;
    const canceled = new AbortController();
    const pending = runner.request(
      `/v1/workspaces/workspace-canceled-check/input`,
      "POST",
      {
        requestId: "canceled-authoritative-check",
        message: "This canceled admission must not fence the owner.",
      },
      canceled.signal,
      "canceled-check-identity",
    );
    await checkEntered;
    canceled.abort(new Error("caller canceled its request"));
    await assert.rejects(pending);
    blockCheck = false;
    assert.equal((await fetch(`${runner.url}/health`)).status, 200);
    const next = await runner.request(
      `/v1/workspaces/workspace-canceled-check/input`,
      "POST",
      {
        requestId: "after-canceled-authoritative-check",
        message: "The same holder can still submit after cancellation.",
      },
      undefined,
      "canceled-check-identity",
    );
    assert.equal(next.status, 202);
  },
);

test(
  "an authoritative changed runtime fence permanently closes the runner",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-changed-fence-"),
    );
    const tokenFile = join(directory, "service-account-token");
    const workspaceConfigFile = join(directory, "workspace.json");
    await writeFile(tokenFile, "changed-fence-identity\n", { mode: 0o600 });
    await writeFile(
      workspaceConfigFile,
      JSON.stringify({
        id: "workspace-changed-fence",
        name: "changed-fence",
        role: "coding",
        environment: "pod",
        localRoot: directory,
        model: { provider: "faux", id: "faux-1" },
      }),
    );
    const holder = "a1b2c3d4-e5f6-47a8-9012-123456789abc";
    let renew;
    const renewed = new Promise((resolve) => {
      renew = resolve;
    });
    const control = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {};
      const renewal = request.url?.endsWith("/runtime/lease/renew");
      if (renewal) renew();
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          workspaceId: "workspace-changed-fence",
          holder: renewal
            ? "b2c3d4e5-f6a7-4890-a123-23456789abcd"
            : (body.holder ?? holder),
          fencingToken: renewal ? 2 : 1,
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
    await renewed;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await fetch(`${runner.url}/health`)).status === 503) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const health = await fetch(`${runner.url}/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).status, "error");
  },
);

test(
  "a maintenance ack answered window-ended keeps the runtime serving and renewing",
  { timeout: 40_000 },
  async (t) => {
    // TASK-93: the window expired between the renew that reported it and the
    // ack. The lease is still valid, so the runtime must keep working.
    const fixture = await startMaintenanceAckRunner(t, "late-ack", {
      status: 200,
      body: { acknowledged: false, reason: "window-ended" },
    });
    await fixture.acked;
    assert.equal(fixture.acks[0].maintenanceId, maintenanceAckWindow);
    await fixture.renewedAfterAck;
    const health = await fetch(`${fixture.runner.url}/health`);
    assert.equal(health.status, 200, fixture.runner.errors);
    const accepted = await fixture.runner.request(
      `/v1/workspaces/${fixture.id}/input`,
      "POST",
      { requestId: "after-window-ended", message: "Still serving." },
      undefined,
      "late-ack-identity",
    );
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    assert.doesNotMatch(fixture.runner.errors, /lost its lifecycle fence/);
    assert.match(
      fixture.runner.errors,
      new RegExp(
        `maintenance window ${maintenanceAckWindow} ended before its acknowledgement \\(window-ended\\)`,
      ),
    );
  },
);

test(
  "a maintenance ack rejected for a stale fence still closes the runtime",
  { timeout: 25_000 },
  async (t) => {
    const fixture = await startMaintenanceAckRunner(t, "stale-ack", {
      status: 403,
      body: {
        error: {
          code: "RUNTIME_FORBIDDEN",
          message: "runtime lease fencing token is stale",
        },
      },
    });
    await fixture.acked;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await fetch(`${fixture.runner.url}/health`)).status === 503) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await fetch(`${fixture.runner.url}/health`)).status, 503);
    assert.match(
      fixture.runner.errors,
      /lost its lifecycle fence: runtime lease fencing token is stale/,
    );
  },
);

test(
  "lease expiry closes a running tool even when its durable abort is fenced",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-expired-tool-"));
    const tokenFile = join(directory, "service-account-token");
    const workspaceConfigFile = join(directory, "workspace.json");
    const started = join(directory, "tool-started");
    const afterExpiry = join(directory, "tool-wrote-after-expiry");
    await writeFile(tokenFile, "expired-tool-identity\n", { mode: 0o600 });
    await writeFile(
      workspaceConfigFile,
      JSON.stringify({
        id: "workspace-expired-tool",
        name: "expired-tool",
        role: "coding",
        environment: "pod",
        localRoot: directory,
        model: { provider: "faux", id: "faux-1" },
      }),
    );
    const holder = "a1b2c3d4-e5f6-47a8-9012-123456789abc";
    const control = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {};
      const value = request.url?.endsWith("/runtime/authorize")
        ? { allowed: true }
        : {
            workspaceId: "workspace-expired-tool",
            holder: body.holder ?? holder,
            fencingToken: 1,
            expiresAt: Math.floor(Date.now() / 1000) + 5,
            valid: true,
          };
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(value));
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

    const id = "workspace-expired-tool";
    const active = await runner.request(
      `/v1/workspaces/${id}/input`,
      "POST",
      {
        requestId: "tool-interrupted-by-expiry",
        message:
          "/faux " +
          JSON.stringify({
            calls: [
              {
                tool: "bash",
                args: {
                  command: `touch ${started}; sleep 30; touch ${afterExpiry}`,
                },
              },
            ],
            answer: "This turn must be stopped when its lease expires.",
          }),
      },
      undefined,
      "expired-tool-identity",
    );
    assert.equal(active.status, 202);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await access(started);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await access(started);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await fetch(`${runner.url}/health`)).status === 503) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await fetch(`${runner.url}/health`)).status, 503);
    await new Promise((resolve) => setTimeout(resolve, 750));
    await assert.rejects(access(afterExpiry), { code: "ENOENT" });
    assert.match(runner.errors, /FATAL failed to stop fenced workspace/);
    assert.match(
      runner.errors,
      /shutdown incomplete: Error: Workspace runtime lease expired/,
    );
  },
);

test(
  "the runner fences at the server-issued lease expiry deadline",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-runner-expired-fence-"),
    );
    const tokenFile = join(directory, "service-account-token");
    const workspaceConfigFile = join(directory, "workspace.json");
    await writeFile(tokenFile, "expired-fence-identity\n", { mode: 0o600 });
    await writeFile(
      workspaceConfigFile,
      JSON.stringify({
        id: "workspace-expired-fence",
        name: "expired-fence",
        role: "coding",
        environment: "pod",
        localRoot: directory,
        model: { provider: "faux", id: "faux-1" },
      }),
    );
    const holder = "a1b2c3d4-e5f6-47a8-9012-123456789abc";
    const control = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {};
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          workspaceId: "workspace-expired-fence",
          holder: body.holder ?? holder,
          fencingToken: 1,
          // 1-2 s ahead: Math.floor(...) + 1 could land within milliseconds of
          // now and be rejected as an invalid lease instead of expiring.
          expiresAt: Math.ceil(Date.now() / 1000) + 1,
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
    try {
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
    } catch (error) {
      // The short lease can expire before a loaded runtime is serving;
      // fencing then means exiting loudly instead of becoming ready.
      assert.match(
        error.message,
        /^Runner exited 1: FATAL workspace runtime lost its lifecycle fence: Workspace runtime lease expired\n/,
      );
      return;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await fetch(`${runner.url}/health`)).status === 503) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const health = await fetch(`${runner.url}/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).status, "error");
  },
);
