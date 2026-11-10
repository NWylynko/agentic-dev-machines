// Shared runner, Pod and lifecycle fixtures for the http-*.test.mjs suites.
// The suites are split so node --test runs them in parallel.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  followView as followAttachView,
  nextHistoryEvent,
} from "./attach-stream.ts";

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
    const body = text ? JSON.parse(text) : {};
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

const followView = (runner, id, onView, query = "", token) =>
  followAttachView(runner.url, `/v1/workspaces/${id}`, onView, {
    query,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

// The first ADM history event after `after` matching `predicate`.
async function nextEvent(
  runner,
  id,
  predicate,
  after = 0,
  diagnostics = false,
  timeoutMs = 0,
  token,
) {
  const reading = nextHistoryEvent(
    runner.url,
    `/v1/workspaces/${id}`,
    predicate,
    {
      after,
      diagnostics,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    },
  );
  if (!timeoutMs) return reading;
  let timer;
  try {
    return await Promise.race([
      reading,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the event")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const fauxTurn = (answer, calls = []) =>
  "/faux " + JSON.stringify({ calls, answer });
// A short faux turn can start and end within one watch callback. This answer
// streams over many throttled partial commits, so a client sees the run working.
const longFauxAnswer = (text) => `${text} ${"streaming ".repeat(2_000)}`;

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

export {
  main,
  startRunner,
  startPodRunner,
  startBotLifecycle,
  startMaintenanceAckRunner,
  maintenanceAckWindow,
  followView,
  nextEvent,
  fauxTurn,
  longFauxAnswer,
  writeLifecycleWorkspace,
};
