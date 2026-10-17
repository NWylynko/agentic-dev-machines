import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { once } from "node:events";

const [binary] = process.argv.slice(2);
assert.ok(binary, "adm binary path is required");
const root = await mkdtemp(join(tmpdir(), "adm-bot-pod-prompt-"));
const exec = promisify(execFile);
const workspaceId = "bot-pod-prompt-001";
const namespace = "adm-bot-pod-prompt";
const podName = "workspace-bot";
const podUid = "00000000-0000-4000-8000-000000000001";
const lifecycleToken = "fixture-lifecycle-token";
const runtimeToken = "fixture-pod-runtime-token";
const tokenFile = join(root, "pod-token");
const configFile = join(root, "workspace.json");
await writeFile(tokenFile, `${runtimeToken}\n`, { mode: 0o600 });

const workspace = {
  id: workspaceId,
  name: "fixture-bot",
  role: "bot",
  namespace,
  phase: "ready",
  image: "adm-dev:test",
  storage_class: "adm-replicated",
  storage_size: "1Gi",
  cpu: "1",
  memory: "1Gi",
  agent_enabled: true,
  repositories: false,
  catalog: {},
  model: { provider: "faux", id: "faux-1" },
  herdr_space: null,
  created_at: 1,
  last_error: null,
  runtime_status: {
    podName,
    podPhase: "Running",
    ready: true,
    activity: { status: "idle" },
    selectedModel: { provider: "faux", id: "faux-1" },
  },
};
const podRunnerConfig = { ...workspace, environment: "pod" };
delete podRunnerConfig.namespace;
await writeFile(configFile, JSON.stringify(podRunnerConfig));

const lifecycleRequests = [];
const lifecycle = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  lifecycleRequests.push({
    path: request.url,
    authorization: request.headers.authorization,
    body,
  });
  const path = new URL(request.url, "http://lifecycle").pathname;
  let status = 200;
  let value = {};
  if (path === "/health") {
    value = { status: "ok" };
  } else if (path === "/v1/workspaces") {
    if (request.headers.authorization !== `Bearer ${lifecycleToken}`) {
      status = 401;
      value = { error: { code: "UNAUTHORIZED" } };
    } else {
      value = [workspace];
    }
  } else if (path.endsWith("/runtime/authorize")) {
    if (request.headers.authorization !== `Bearer ${runtimeToken}`) {
      status = 401;
      value = { error: { code: "UNAUTHORIZED" } };
    } else {
      value = { allowed: true };
    }
  } else if (path.endsWith("/runtime/lease")) {
    value = {
      workspaceId,
      holder: body.holder,
      fencingToken: 1,
      expiresAt: Date.now() + 30_000,
    };
  } else if (
    path.endsWith("/runtime/check") ||
    path.endsWith("/runtime/lease/renew")
  ) {
    value = { valid: true };
  } else {
    status = 404;
    value = { error: { code: "NOT_FOUND" } };
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
});
await new Promise((resolve) => lifecycle.listen(0, "127.0.0.1", resolve));
const lifecycleUrl = `http://127.0.0.1:${lifecycle.address().port}`;

const kubectl = join(root, "kubectl");
await writeFile(
  kubectl,
  `#!${process.execPath}
import http from "node:http";
const args = process.argv.slice(2);
if (args[0] === "get" && args[1] === "pod") {
  process.stdout.write(JSON.stringify({
    metadata: { name: ${JSON.stringify(podName)}, namespace: ${JSON.stringify(namespace)}, uid: ${JSON.stringify(podUid)}, labels: { "adm.dev/workspace-id": ${JSON.stringify(workspaceId)}, "app.kubernetes.io/managed-by": "adm" } },
    spec: { serviceAccountName: "adm-runtime" },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] }
  }));
} else if (args[0] === "exec") {
  process.stdout.write(${JSON.stringify(runtimeToken + "\n")});
} else if (args[0] === "port-forward") {
  const upstream = new URL(${JSON.stringify("http://127.0.0.1:0")});
  upstream.port = process.env.POD_RUNTIME_PORT;
  const server = http.createServer((request, response) => {
    const proxy = http.request(new URL(request.url, upstream), { method: request.method, headers: request.headers }, (remote) => {
      response.writeHead(remote.statusCode ?? 502, remote.headers);
      remote.pipe(response);
    });
    proxy.on("error", (error) => { response.writeHead(502); response.end(String(error)); });
    request.pipe(proxy);
  });
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write("Forwarding from 127.0.0.1:" + server.address().port + " -> 7432\\n");
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else {
  process.stderr.write("unexpected kubectl arguments: " + JSON.stringify(args));
  process.exit(2);
}
`,
);
await chmod(kubectl, 0o755);

const podRunner = spawn(
  process.execPath,
  [
    "packages/runner/src/main.ts",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--state-dir",
    join(root, "pod-runtime"),
    "--provider",
    "faux",
    "--model",
    "faux-1",
    "--workspace-config",
    configFile,
    "--token-file",
    tokenFile,
    "--lifecycle-url",
    lifecycleUrl,
    "--pod-uid",
    podUid,
  ],
  {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, POD_RUNTIME_PORT: "0" },
  },
);
const runnerExited = once(podRunner, "exit");
const lines = createInterface({ input: podRunner.stdout });
let runnerErrors = "";
podRunner.stderr.on("data", (chunk) => (runnerErrors += chunk));
const ready = new Promise((resolve, reject) => {
  podRunner.once("exit", (code) =>
    reject(new Error(`workspace Pod runtime exited ${code}: ${runnerErrors}`)),
  );
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line);
      if (value.ready) resolve(value);
    } catch {}
  });
});

try {
  const { url } = await ready;
  process.env.POD_RUNTIME_PORT = new URL(url).port;
  const runCli = async (args) =>
    exec(
      binary,
      [
        "--state-dir",
        join(root, "cli-state"),
        "--kubectl",
        kubectl,
        "--lifecycle-url",
        lifecycleUrl,
        "--lifecycle-token-file",
        join(root, "lifecycle-token"),
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, POD_RUNTIME_PORT: new URL(url).port },
      },
    );
  await writeFile(join(root, "lifecycle-token"), `${lifecycleToken}\n`, {
    mode: 0o600,
  });

  const message =
    "/faux " +
    JSON.stringify({
      calls: [
        {
          tool: "sendMessage",
          args: { text: "Pod-owned bot message reached the terminal." },
        },
      ],
      answer: "Private pod diagnostic.",
    });
  const first = JSON.parse(
    (await runCli(["prompt", "fixture-bot", message, "--request-id", "fixture-id"]))
      .stdout,
  );
  const duplicate = JSON.parse(
    (await runCli(["prompt", "fixture-bot", message, "--request-id", "fixture-id"]))
      .stdout,
  );
  assert.equal(first.status, "admitted");
  assert.equal(duplicate.status, "admitted");
  assert.equal(first.submissionId, duplicate.submissionId);

  const historyResponse = await fetch(
    `${url}/v1/workspaces/${workspaceId}/history?diagnostics=false`,
    { headers: { authorization: `Bearer ${runtimeToken}` } },
  );
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.ok(
    history.events.some(
      (event) =>
        event.kind === "message" &&
        event.data.text === "Pod-owned bot message reached the terminal.",
    ),
  );
  assert.ok(
    history.events.every((event) =>
      ["user", "message", "status"].includes(event.kind),
    ),
    "the default bot history hides model and tool diagnostics",
  );
  assert.ok(
    lifecycleRequests.some(
      (entry) =>
        entry.path === `/v1/workspaces/${workspaceId}/runtime/authorize` &&
        entry.authorization === `Bearer ${runtimeToken}` &&
        entry.body.action === "prompt",
    ),
    "the pod identity authorizes CLI prompts through the lifecycle service",
  );
  assert.ok(
    lifecycleRequests.some((entry) => entry.path.endsWith("/runtime/lease")),
    "the pod runner acquires its durable lifecycle fence",
  );
  console.log("Pod-owned bot prompt and lifecycle routing scenario passed");
} finally {
  podRunner.kill("SIGTERM");
  await runnerExited;
  lines.close();
  await new Promise((resolve) => lifecycle.close(resolve));
  await rm(root, { recursive: true });
}
