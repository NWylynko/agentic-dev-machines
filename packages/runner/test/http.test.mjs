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

async function startPodRunner(root, lifecycle, { id, name, role, host, podUid, port = 7432 }) {
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
  const runner = await startRunner(join(root, id), { ADM_RUNTIME_PORT: String(port) }, {
    host,
    port,
    tokenFile,
    workspaceConfigFile,
    lifecycleUrl: lifecycle.url,
    podUid,
  });
  return { runner, token, workspace };
}

async function startBotLifecycle(
  directory,
  workspaces,
  { holdDirectory = false } = {},
) {
  await mkdir(directory, { recursive: true });
  const tokenFile = join(directory, "projected-token");
  await writeFile(tokenFile, "fixture-runtime-token\n", { mode: 0o600 });
  const authorizations = [];
  const operations = new Map();
  const tokens = new Map([['fixture-runtime-token', 'fixture-source']]);
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
    if (request.method === "GET" && request.url === "/v1/runtime/workspaces") {
      if (holdDirectory) {
        signalDirectoryRequest();
        response.once("close", signalDirectoryAbort);
        return;
      }
      response.writeHead(200, headers).end(JSON.stringify(workspaces.filter((workspace) => workspace.role === "coding" && workspace.phase !== "deleted" && workspace.phase !== "deleting")));
      return;
    }
    const runtime = /^\/v1\/workspaces\/([^/]+)\/runtime\/(authorize|lease|lease\/renew|check)$/.exec(request.url ?? "");
    if (request.method === "POST" && runtime) {
      const id = decodeURIComponent(runtime[1]);
      const action = runtime[2];
      if (action === "authorize") {
        const target = workspaces.find((workspace) => workspace.id === id);
        const allowed = target && target.phase !== "deleted" && target.phase !== "deleting" && (sourceId === id || (target.role === "coding" && workspaces.some((workspace) => workspace.id === sourceId && workspace.role === "bot")));
        authorizations.push({ id, action: value.action, sourceId });
        response.writeHead(allowed ? 200 : 403, headers).end(JSON.stringify(allowed ? { allowed: true } : { error: { message: "not authorized" } }));
        return;
      }
      const own = workspaces.find((workspace) => workspace.id === sourceId);
      if (id !== sourceId || !own) {
        response.writeHead(403, headers).end(JSON.stringify({ error: { message: "not authorized" } }));
        return;
      }
      response.writeHead(200, headers).end(JSON.stringify({ workspaceId: id, holder: value.holder, fencingToken: 1, expiresAt: Date.now() + 60000 }));
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
    const operationStatus = /^\/v1\/runtime\/operations\/([^/]+)$/.exec(request.url ?? "");
    if (request.method === "GET" && operationStatus) {
      const receipt = operations.get(decodeURIComponent(operationStatus[1]))?.receipt;
      response.writeHead(receipt ? 200 : 404, headers).end(JSON.stringify(receipt ?? { error: { message: "not found" } }));
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
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    tokenFile,
    addWorkspace(workspace, token) {
      const tokenPath = join(directory, `${workspace.id}-token`);
      return writeFile(tokenPath, `${token}\n`, { mode: 0o600 }).then(() => {
        tokens.set(token, workspace.id);
        const existing = workspaces.findIndex((item) => item.id === workspace.id);
        if (existing < 0) workspaces.push(workspace);
        else workspaces[existing] = workspace;
        return tokenPath;
      });
    },
    authorizations,
    operations,
    directoryRequest,
    directoryAbort,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
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
  const directory = await mkdtemp(join(tmpdir(), "adm-runner-mounted-bot-restart-"));
  const configPath = join(directory, "workspace.json");
  await writeFile(configPath, JSON.stringify({
    id: "mounted-bot-restart",
    name: "watcher",
    role: "bot",
    environment: "pod",
  }));
  let runner = await startRunner(directory, {}, { workspaceConfigFile: configPath, defaultModel: false });
  assert.equal((await runner.request("/v1/workspaces/mounted-bot-restart")).status, 200);
  await runner.stop();
  runner = await startRunner(directory, {}, { workspaceConfigFile: configPath, defaultModel: false });
  t.after(() => runner.stop());
  assert.equal((await runner.request("/v1/workspaces/mounted-bot-restart")).status, 200);
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
    const status = !authorized ? 401 : checkPath && deleting ? 410 : 200;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        !authorized
          ? { error: { code: "UNAUTHORIZED" } }
          : leasePath
            ? {
                workspaceId: "workspace-lifecycle-auth",
                holder: body.holder,
                fencingToken: 7,
                expiresAt: Date.now() + 30_000,
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
  const runner = await startRunner(
    directory,
    {},
    {
      tokenFile,
      workspaceConfigFile,
      lifecycleUrl: controlUrl,
      podUid: "a1b2c3d4-e5f6-47a8-9012-123456789abc",
    },
  );
  t.after(async () => {
    await runner.stop();
    await new Promise((resolve) => control.close(resolve));
  });

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
  const projectedStatus = await fetch(
    `${runner.url}/v1/workspaces/workspace-lifecycle-auth/runtime-status`,
    { headers: { authorization: "Bearer rotating-pod-identity-token" } },
  );
  assert.equal(projectedStatus.status, 200);
  const projectedBody = await projectedStatus.json();
  assert.ok(["idle", "running"].includes(projectedBody.activity.status));
  assert.deepEqual(projectedBody.selectedModel, { provider: "faux", id: "faux-1" });
  assert.ok(
    authorizations.some((entry) => entry.path.endsWith("/authorize") && entry.authorization === "Bearer rotating-pod-identity-token" && entry.body.action === "read"),
    "runtime status is available only to an identity scoped to this workspace Pod",
  );
  assert.ok(
    !authorizations.some((entry) => entry.authorization === "Bearer lifecycle-controller-token"),
    "the controller credential never crosses into the workspace Pod",
  );
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
  assert.equal(fenced.status, 503);
  assert.equal((await fenced.json()).error.code, "RUNTIME_OWNERSHIP_LOST");
  const readiness = await fetch(`${runner.url}/health`);
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).status, "error");
  const closed = await fetch(
    `${runner.url}/v1/workspaces/workspace-lifecycle-auth`,
    { headers: { authorization: "Bearer rotating-pod-identity-token" } },
  );
  assert.equal(closed.status, 503);
  assert.equal((await closed.json()).error.code, "RUNTIME_OWNERSHIP_LOST");
});

test(
  "a controller transport outage pauses new work while an active turn survives until the same lease is renewed",
  { timeout: 35_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-lifecycle-outage-"));
    const tokenFile = join(directory, "service-account-token");
    const workspaceConfigFile = join(directory, "workspace.json");
    const repository = join(directory, "repository");
    const marker = join(directory, "tool-started");
    await writeFile(tokenFile, "temporary-outage-identity\n", { mode: 0o600 });
    await writeFile(workspaceConfigFile, JSON.stringify({
      id: "workspace-lifecycle-outage",
      name: "lifecycle-outage",
      role: "coding",
      environment: "pod",
      localRoot: repository,
      model: { provider: "faux", id: "faux-1" },
    }));
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
      if (request.headers.authorization !== "Bearer temporary-outage-identity") {
        response.writeHead(401, headers).end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
        return;
      }
      if (unavailable) {
        if (request.url?.endsWith("/runtime/lease/renew")) renewedDuringOutage();
        response.writeHead(503, headers).end(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE" } }));
        return;
      }
      response.writeHead(200, headers).end(JSON.stringify({
        workspaceId: "workspace-lifecycle-outage",
        holder: body.holder ?? holder,
        fencingToken: 1,
        expiresAt: Math.floor(Date.now() / 1000) + 30,
        valid: true,
      }));
    });
    await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
    const runner = await startRunner(
      join(directory, "state"),
      {},
      {
        tokenFile,
        workspaceConfigFile,
        lifecycleUrl: `http://127.0.0.1:${control.address().port}`,
        podUid: holder,
      },
    );
    t.after(async () => {
      await runner.stop();
      await new Promise((resolve) => control.close(resolve));
    });

    const id = "workspace-lifecycle-outage";
    const active = await runner.request(`/v1/workspaces/${id}/input`, "POST", {
      requestId: "held-across-controller-update",
      message: "/faux " + JSON.stringify({
        calls: [{ tool: "bash", args: { command: `touch ${marker}; sleep 12; printf held > ${join(repository, "tool-finished")}` } }],
        answer: "The in-flight turn completed after the controller returned.",
      }),
    }, undefined, "temporary-outage-identity");
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

    const waiting = runner.request(`/v1/workspaces/${id}/input`, "POST", {
      requestId: "admission-waits-for-authority",
      message: "Continue after the controller has the same runtime lease again.",
    }, undefined, "temporary-outage-identity");
    const early = await Promise.race([
      waiting.then((result) => ({ result })),
      new Promise((resolve) => setTimeout(() => resolve({ held: true }), 100)),
    ]);
    assert.deepEqual(early, { held: true });
    assert.equal((await fetch(`${runner.url}/health`)).status, 200);

    unavailable = false;
    const resumed = await waiting;
    assert.equal(resumed.status, 202);
    await nextEvent(runner, id, (event) =>
      event.kind === "assistant" && event.data.text.includes("controller returned"),
      0,
      false,
      25_000,
      "temporary-outage-identity",
    );
    assert.equal(await readFile(join(repository, "tool-finished"), "utf8"), "held");
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
    { signal: controller.signal, headers: token ? { authorization: `Bearer ${token}` } : {} },
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
    // A successful reply precedes the server process closing its transport.
    // Observe that independent close before checking its retained diagnostic.
    const closeDeadline = Date.now() + 5000;
    let disconnectedStatus = await runner.request(disconnectPath);
    while (!disconnectedStatus.body.error && Date.now() < closeDeadline) {
      await new Promise(setImmediate);
      disconnectedStatus = await runner.request(disconnectPath);
    }
    assert.match(disconnectedStatus.body.error ?? "", /disconnected/i);
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
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-agent-directory-"));
    const workspaces = [];
    const port = await freePort();
    const lifecycle = await startBotLifecycle(join(directory, "management"), workspaces);
    const botId = "directory-bot";
    const botWorkspace = { id: botId, name: "bot", role: "bot", phase: "ready", namespace: "fixture-directory-bot" };
    const botPod = await startPodRunner(directory, lifecycle, {
      ...botWorkspace,
      host: "127.0.0.1", port,
      podUid: "11111111-1111-4111-8111-111111111111",
    });
    const targets = new Map();
    async function addTarget(id, name, host) {
      const target = await startPodRunner(directory, lifecycle, {
        id, name, role: "coding", host, port,
        podUid: id === "alpha" ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
      });
      targets.set(id, target);
      return target;
    }
    await addTarget("alpha", "project-albatross", "127.0.0.2");
    await addTarget("beta", "project-bee", "127.0.0.3");
    const bot = botPod.runner;
    const targetRunner = (id) => targets.get(id)?.runner;
    t.after(async () => {
      await Promise.all([bot.stop(), ...[...targets.values()].map(({ runner }) => runner.stop())]);
      await lifecycle.close();
    });
    const authRequest = async (runner, token, path, method = "GET", body) => {
      const response = await fetch(runner.url + path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    let cursor = 0;
    async function call(tool, args, requestId, code = false) {
      const calls = code
        ? [{ tool: "codemode", args: { code: `return await tools.${tool}(${JSON.stringify(args)})` } }]
        : [{ tool, args }];
      const input = await authRequest(bot, botPod.token, `/v1/workspaces/${botId}/input`, "POST", {
        message: "/faux " + JSON.stringify({ calls, answer: "Private lifecycle result." }), requestId,
      });
      assert.equal(input.status, 202);
      const event = await nextEvent(bot, botId,
        (value) => value.kind === "tool" && value.data.name === (code ? "codemode" : tool),
        cursor, true, 0, botPod.token);
      cursor = event.seq;
      return event.data;
    }
    const listed = JSON.parse((await call("listAgents", {}, "list")).text);
    assert.deepEqual(listed.agents.map(({ id, name }) => ({ id, name })), [
      { id: "alpha", name: "project-albatross" }, { id: "beta", name: "project-bee" },
    ]);
    const codeMode = await call("listAgents", {}, "list-code", true);
    assert.equal(codeMode.isError, false);
    assert.match(codeMode.text, /project-bee/);

    const target = targetRunner("alpha");
    const remoteInput = await authRequest(target, targets.get("alpha").token, "/v1/workspaces/alpha/input", "POST", {
      message: "/faux " + JSON.stringify({ calls: [{ tool: "write", args: { path: join(directory, "tool.txt"), content: "done" } }], answer: "written" }),
      requestId: "history-with-tool",
    });
    assert.equal(remoteInput.status, 202);
    await nextEvent(target, "alpha", (event) => event.kind === "tool" && event.data.name === "write", 0, true, 0, targets.get("alpha").token);
    const monitored = JSON.parse((await call("monitorAgent", { agentId: "alpha", after: 0, limit: 2 }, "monitor")).text);
    assert.equal(monitored.id, "alpha");
    let historyEvents = monitored.history.events;
    let nextAfter = monitored.history.nextAfter;
    while (monitored.history.hasMore) {
      const page = JSON.parse((await call("monitorAgent", { agentId: "alpha", after: nextAfter, limit: 100 }, `monitor-${nextAfter}`)).text).history;
      historyEvents = [...historyEvents, ...page.events];
      nextAfter = page.nextAfter;
      if (!page.hasMore) break;
    }
    assert.ok(historyEvents.some((event) => event.kind === "tool" && event.data.name === "write"));

    const prompt = JSON.parse((await call("promptAgent", { agentId: "alpha", message: "Report your status." }, "prompt")).text);
    assert.equal(prompt.status, "admitted");
    await nextEvent(target, "alpha", (event) => event.kind === "assistant" && event.data.text.includes("Report your status."), 0, true, 0, targets.get("alpha").token);
    assert.equal(JSON.parse((await call("saveAgentGoal", { agentId: "alpha", goal: { description: "Ship it" } }, "goal")).text).description, "Ship it");
    assert.equal(JSON.parse((await call("saveAgentLoop", { agentId: "beta", loop: { prompt: "Check progress", intervalMs: 60000, nextAt: 2000000000000 } }, "loop")).text).prompt, "Check progress");
    assert.equal((await call("configureAgentModel", { agentId: "beta", provider: "faux", modelId: "faux-1" }, "model")).isError, false);

    const created = JSON.parse((await call("createAgent", {
      name: "new-agent", image: "adm-dev:0.1.0", storageClass: "fast", storageSize: "10Gi", cpu: "2", memory: "4Gi", model: { provider: "faux", id: "faux-1" },
    }, "create")).text);
    assert.equal(created.status, "accepted");
    const operation = JSON.parse((await call("monitorAgentOperation", { operationId: created.operationId }, "create-status")).text);
    assert.equal(operation.operationId, created.operationId);
    const destroyed = JSON.parse((await call("destroyAgent", { agentId: "beta" }, "destroy")).text);
    assert.equal(destroyed.kind, "delete");
    assert.equal(destroyed.workspaceId, "beta");
    assert.equal(JSON.parse((await call("monitorAgentOperation", { operationId: destroyed.operationId }, "delete-status")).text).operationId, destroyed.operationId);

    await bot.stop();
    const restarted = await startPodRunner(directory, lifecycle, { ...botWorkspace, host: "127.0.0.1", port, podUid: "11111111-1111-4111-8111-111111111111" });
    t.after(() => restarted.runner.stop());
    const persisted = await authRequest(restarted.runner, restarted.token, `/v1/workspaces/${botId}`);
    assert.equal(persisted.status, 200);
    const afterRestart = await authRequest(restarted.runner, restarted.token, `/v1/workspaces/${botId}/input`, "POST", {
      message: "/faux " + JSON.stringify({ calls: [{ tool: "listAgents", args: {} }], answer: "Private." }), requestId: "restart-list",
    });
    assert.equal(afterRestart.status, 202);
    const afterEvent = await nextEvent(restarted.runner, botId, (event) => event.kind === "tool" && event.data.name === "listAgents", 0, true, 0, restarted.token);
    assert.match(afterEvent.data.text, /project-albatross/);
  },
);

test(
  "aborting a bot turn cancels its in-flight lifecycle request",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-bot-cancel-"));
    const port = await freePort();
    const lifecycle = await startBotLifecycle(join(directory, "management"), [], { holdDirectory: true });
    const pod = await startPodRunner(directory, lifecycle, {
      id: "cancel-bot", name: "bot", role: "bot", host: "127.0.0.1", port,
      podUid: "11111111-1111-4111-8111-111111111111",
    });
    t.after(async () => { await pod.runner.stop(); await lifecycle.close(); });
    const call = await pod.runner.request("/v1/workspaces/cancel-bot/input", "POST", {
      message: `/faux ${JSON.stringify({ calls: [{ tool: "listAgents", args: {} }] })}`,
      requestId: "cancel-management-request",
    }, undefined, pod.token);
    assert.equal(call.status, 202);
    await lifecycle.directoryRequest;
    assert.equal((await pod.runner.request("/v1/workspaces/cancel-bot/abort", "POST", {}, undefined, pod.token)).status, 200);
    await lifecycle.directoryAbort;
  },
);

test(
  "a pod bot discovers coding agents created later through direct tools and Code Mode",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-bot-late-agent-"));
    const port = await freePort();
    const lifecycle = await startBotLifecycle(join(directory, "management"), []);
    const bot = await startPodRunner(directory, lifecycle, {
      id: "late-agent-bot", name: "bot", role: "bot", host: "127.0.0.1", port,
      podUid: "11111111-1111-4111-8111-111111111111",
    });
    const target = await startPodRunner(directory, lifecycle, {
      id: "created-after-bot", name: "new-project", role: "coding", host: "127.0.0.2", port,
      podUid: "22222222-2222-4222-8222-222222222222",
    });
    t.after(async () => { await bot.runner.stop(); await target.runner.stop(); await lifecycle.close(); });
    let cursor = 0;
    async function call(tool, args, requestId, code = false) {
      const calls = code ? [{ tool: "codemode", args: { code: `return await tools.${tool}(${JSON.stringify(args)})` } }] : [{ tool, args }];
      assert.equal((await bot.runner.request("/v1/workspaces/late-agent-bot/input", "POST", {
        message: "/faux " + JSON.stringify({ calls, answer: "Private lifecycle result." }), requestId,
      }, undefined, bot.token)).status, 202);
      const event = await nextEvent(bot.runner, "late-agent-bot", (value) => value.kind === "tool" && value.data.name === (code ? "codemode" : tool), cursor, true, 0, bot.token);
      cursor = event.seq;
      return event.data;
    }
    const direct = JSON.parse((await call("listAgents", {}, "late-list")).text);
    assert.deepEqual(direct.agents, [{ id: "created-after-bot", name: "new-project", status: "idle", phase: "ready", ready: true }]);
    const throughCodeMode = await call("listAgents", {}, "late-list-codemode", true);
    assert.equal(throughCodeMode.isError, false);
    assert.match(throughCodeMode.text, /created-after-bot/);
    assert.equal((await target.runner.request("/v1/workspaces/created-after-bot", "GET", undefined, undefined, bot.token)).status, 200);
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
