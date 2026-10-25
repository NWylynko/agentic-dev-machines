import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
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

async function startRunner(
  directory,
  env = {},
  {
    useFaux = true,
    defaultModel = true,
    port = 0,
    host = "127.0.0.1",
    tokenFile,
    workspaceConfigFile,
    lifecycleUrl,
    podUid,
  } = {},
) {
  const child = spawn(
    process.execPath,
    [
      main.pathname,
      "--port",
      String(port),
      "--host",
      host,
      "--state-dir",
      directory,
      ...(tokenFile ? ["--token-file", tokenFile] : []),
      ...(workspaceConfigFile
        ? ["--workspace-config", workspaceConfigFile]
        : []),
      ...(lifecycleUrl ? ["--lifecycle-url", lifecycleUrl] : []),
      ...(podUid ? ["--pod-uid", podUid] : []),
      ...(useFaux
        ? ["--provider", "faux", ...(defaultModel ? ["--model", "faux-1"] : [])]
        : ["--auth-path", join(directory, "empty-auth.json")]),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: useFaux
        ? { ...process.env, ...env }
        : { PATH: process.env.PATH, HOME: directory, ...env },
    },
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
    get errors() {
      return errors;
    },
    async stop(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        await exited;
      }
      lines.close();
    },
    async request(path, method = "GET", body, signal, token) {
      const response = await fetch(url + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startPodRunner(
  root,
  lifecycle,
  { id, name, role, host, podUid, port = 7432 },
) {
  const workspace = {
    id,
    name,
    role,
    phase: "ready",
    namespace: `fixture-${id}`,
    runtime_status: {
      podIP: host,
      ready: true,
      activity: { status: "idle" },
    },
  };
  const token = `token-${id}`;
  const tokenFile = await lifecycle.addWorkspace(workspace, token);
  const workspaceConfigFile = join(root, `${id}.json`);
  await writeFile(
    workspaceConfigFile,
    JSON.stringify({
      id,
      name,
      role,
      environment: "pod",
      ...(role === "coding" ? { localRoot: join(root, id, "repos") } : {}),
      model: { provider: "faux", id: "faux-1" },
    }),
    { mode: 0o600 },
  );
  const runner = await startRunner(
    join(root, id),
    { ADM_RUNTIME_PORT: String(port) },
    {
      host,
      port,
      tokenFile,
      workspaceConfigFile,
      lifecycleUrl: lifecycle.url,
      podUid,
    },
  );
  return { runner, token, workspace };
}

async function startBotLifecycle(
  directory,
  workspaces,
  { holdDirectory = false, holdProviderCatalog = false } = {},
  testContext,
) {
  await mkdir(directory, { recursive: true });
  const tokenFile = join(directory, "projected-token");
  await writeFile(tokenFile, "fixture-runtime-token\n", { mode: 0o600 });
  const authorizations = [];
  const operations = new Map();
  const tokens = new Map([["fixture-runtime-token", "fixture-source"]]);
  const providerCatalogRequests = [];
  const heldProviderCatalogResponses = [];
  let signalDirectoryRequest;
  let signalDirectoryAbort;
  const directoryRequest = new Promise((resolve) => {
    signalDirectoryRequest = resolve;
  });
  const directoryAbort = new Promise((resolve) => {
    signalDirectoryAbort = resolve;
  });
  const server = createServer(async (request, response) => {
    const headers = { "content-type": "application/json" };
    const sourceId = tokens.get(
      request.headers.authorization?.replace(/^Bearer /, ""),
    );
    if (!sourceId) {
      response
        .writeHead(403, headers)
        .end(JSON.stringify({ error: { message: "forbidden" } }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const value = body ? JSON.parse(body) : {};
    if (
      holdProviderCatalog &&
      request.method === "POST" &&
      request.url === "/v1/provider-auth/catalog"
    ) {
      // A deliberately slow provider catalogue: it answers only at close.
      providerCatalogRequests.push(sourceId);
      heldProviderCatalogResponses.push(response);
      return;
    }
    if (request.method === "GET" && request.url === "/v1/runtime/workspaces") {
      if (holdDirectory) {
        signalDirectoryRequest();
        response.once("close", signalDirectoryAbort);
        return;
      }
      response
        .writeHead(200, headers)
        .end(
          JSON.stringify(
            workspaces.filter(
              (workspace) =>
                workspace.role === "coding" &&
                workspace.phase !== "deleted" &&
                workspace.phase !== "deleting",
            ),
          ),
        );
      return;
    }
    const runtime =
      /^\/v1\/workspaces\/([^/]+)\/runtime\/(authorize|lease|lease\/renew|check)$/.exec(
        request.url ?? "",
      );
    if (request.method === "POST" && runtime) {
      const id = decodeURIComponent(runtime[1]);
      const action = runtime[2];
      if (action === "authorize") {
        const target = workspaces.find((workspace) => workspace.id === id);
        const allowed =
          target &&
          target.phase !== "deleted" &&
          target.phase !== "deleting" &&
          (sourceId === id ||
            (target.role === "coding" &&
              workspaces.some(
                (workspace) =>
                  workspace.id === sourceId && workspace.role === "bot",
              )));
        authorizations.push({ id, action: value.action, sourceId });
        response
          .writeHead(allowed ? 200 : 403, headers)
          .end(
            JSON.stringify(
              allowed
                ? { allowed: true }
                : { error: { message: "not authorized" } },
            ),
          );
        return;
      }
      const own = workspaces.find((workspace) => workspace.id === sourceId);
      if (id !== sourceId || !own) {
        response
          .writeHead(403, headers)
          .end(JSON.stringify({ error: { message: "not authorized" } }));
        return;
      }
      response.writeHead(200, headers).end(
        JSON.stringify({
          workspaceId: id,
          holder: value.holder,
          fencingToken: 1,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          valid: true,
        }),
      );
      return;
    }
    const authorize = /^\/v1\/workspaces\/([^/]+)\/runtime\/authorize$/.exec(
      request.url ?? "",
    );
    if (request.method === "POST" && authorize) {
      const id = decodeURIComponent(authorize[1]);
      authorizations.push({ id, action: value.action });
      const allowed = workspaces.some((workspace) => workspace.id === id);
      response
        .writeHead(allowed ? 200 : 403, headers)
        .end(
          JSON.stringify(
            allowed
              ? { allowed: true }
              : { error: { message: "not authorized" } },
          ),
        );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/runtime/operations") {
      const previous = operations.get(value.operationId);
      if (
        previous &&
        JSON.stringify(previous.request) !== JSON.stringify(value)
      ) {
        response.writeHead(409, headers).end(
          JSON.stringify({
            error: {
              message: "operationId was already used with a different request",
            },
          }),
        );
        return;
      }
      const receipt = previous?.receipt ?? {
        operationId: value.operationId,
        kind: value.kind,
        status: "accepted",
        workspaceId: value.workspaceId ?? `created-${value.operationId}`,
      };
      operations.set(value.operationId, { request: value, receipt });
      response.writeHead(202, headers).end(JSON.stringify(receipt));
      return;
    }
    const operationStatus = /^\/v1\/runtime\/operations\/([^/]+)$/.exec(
      request.url ?? "",
    );
    if (request.method === "GET" && operationStatus) {
      const receipt = operations.get(
        decodeURIComponent(operationStatus[1]),
      )?.receipt;
      response
        .writeHead(receipt ? 200 : 404, headers)
        .end(JSON.stringify(receipt ?? { error: { message: "not found" } }));
      return;
    }
    response
      .writeHead(404, headers)
      .end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const close = () => {
    for (const response of heldProviderCatalogResponses.splice(0))
      response.writeHead(503).end();
    return server.listening
      ? new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      : Promise.resolve();
  };
  testContext?.after(close);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    tokenFile,
    addWorkspace(workspace, token) {
      const tokenPath = join(directory, `${workspace.id}-token`);
      return writeFile(tokenPath, `${token}\n`, { mode: 0o600 }).then(() => {
        tokens.set(token, workspace.id);
        const existing = workspaces.findIndex(
          (item) => item.id === workspace.id,
        );
        if (existing < 0) workspaces.push(workspace);
        else workspaces[existing] = workspace;
        return tokenPath;
      });
    },
    authorizations,
    operations,
    providerCatalogRequests,
    directoryRequest,
    directoryAbort,
    close,
  };
}

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
      assert.deepEqual(status.body, {
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
    const body = JSON.parse(text);
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
    const body = JSON.parse(text);
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
      const body = JSON.parse(text);
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
      const body = JSON.parse(text);
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

// A Pod runner whose first lease renewal reports controller maintenance
// window `maintenanceAckWindow`, so it acks; `ack` answers that ack. Later
// renewals report no window. Resolves `acked` on the ack and `renewedAfterAck`
// on the next renewal.
async function startMaintenanceAckRunner(t, name, ack) {
  const directory = await mkdtemp(join(tmpdir(), `adm-runner-${name}-`));
  const tokenFile = join(directory, "service-account-token");
  const workspaceConfigFile = join(directory, "workspace.json");
  const id = `workspace-${name}`;
  await writeFile(tokenFile, `${name}-identity\n`, { mode: 0o600 });
  await writeFile(
    workspaceConfigFile,
    JSON.stringify({
      id,
      name,
      role: "coding",
      environment: "pod",
      localRoot: directory,
      model: { provider: "faux", id: "faux-1" },
    }),
  );
  const holder = "a1b2c3d4-e5f6-47a8-9012-123456789abc";
  const fixture = { id, renewals: 0, acks: [] };
  let ackSeen, renewSeenAfterAck;
  fixture.acked = new Promise((resolve) => (ackSeen = resolve));
  fixture.renewedAfterAck = new Promise(
    (resolve) => (renewSeenAfterAck = resolve),
  );
  const control = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const headers = { "content-type": "application/json" };
    if (request.headers.authorization !== `Bearer ${name}-identity`) {
      response
        .writeHead(401, headers)
        .end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
      return;
    }
    if (request.url?.endsWith("/runtime/lease/ack")) {
      fixture.acks.push(body);
      ackSeen();
      response.writeHead(ack.status, headers).end(JSON.stringify(ack.body));
      return;
    }
    const renewal = request.url?.endsWith("/runtime/lease/renew");
    if (renewal && ++fixture.renewals > 1 && fixture.acks.length)
      renewSeenAfterAck();
    response.writeHead(200, headers).end(
      JSON.stringify({
        workspaceId: id,
        holder: body.holder ?? holder,
        fencingToken: 1,
        expiresAt: Math.floor(Date.now() / 1000) + 30,
        maintenanceId:
          renewal && fixture.renewals === 1 ? maintenanceAckWindow : null,
        valid: true,
        allowed: true,
      }),
    );
  });
  await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await fixture.runner?.stop();
    await new Promise((resolve) => control.close(resolve));
  });
  fixture.runner = await startRunner(
    join(directory, "state"),
    {},
    {
      tokenFile,
      workspaceConfigFile,
      lifecycleUrl: `http://127.0.0.1:${control.address().port}`,
      podUid: holder,
    },
  );
  return fixture;
}
const maintenanceAckWindow = "8f6f2f0e-3b9a-4f43-9d64-6e2b0f1d2a11";

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
      const body = JSON.parse(text);
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

async function nextEvent(
  runner,
  id,
  predicate,
  after = 0,
  diagnostics = false,
  timeoutMs = 0,
  token,
) {
  const controller = new AbortController();
  const timeout = timeoutMs
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  const response = await fetch(
    `${runner.url}/v1/workspaces/${id}/events?after=${after}&diagnostics=${diagnostics}`,
    {
      signal: controller.signal,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    },
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

export { startRunner, nextEvent };

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
            image: "adm-dev:0.1.0",
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

async function writeLifecycleWorkspace(directory, id) {
  const tokenFile = join(directory, "service-account-token");
  const workspaceConfigFile = join(directory, "workspace.json");
  await writeFile(tokenFile, "pod-token\n", { mode: 0o600 });
  await writeFile(
    workspaceConfigFile,
    JSON.stringify({
      id,
      name: "outage",
      role: "coding",
      environment: "pod",
      localRoot: directory,
      model: { provider: "faux", id: "faux-1" },
    }),
  );
  return { tokenFile, workspaceConfigFile };
}

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
    const port = await freePort();
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
