import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { tmpdir } from "node:os";

const adm = process.argv[2];
assert.ok(adm, "pass the public adm executable");
const root = await mkdtemp(join(tmpdir(), "adm-managed-shell-"));
const stateFile = join(root, "cluster.json");
const execLog = join(root, "exec.jsonl");
const hostEnvLog = join(root, "host-env.jsonl");
const envLog = join(root, "remote-env.jsonl");
const requestLog = join(root, "requests.jsonl");
const kube = join(root, "kubectl");
const wrongKubeconfig = join(root, "wrong.kubeconfig");
const selectedKubeconfig = join(root, "selected.kubeconfig");
const mappedRepos = join(root, "mapped-repos");
const mappedRepository = join(mappedRepos, "owner", "project");
let agentStatus = "running";
let abortCount = 0;
let releaseHeldRequest;
let releaseHeldClose;
const heldRequest = new Promise((resolve) => (releaseHeldRequest = resolve));
const heldClose = new Promise((resolve) => (releaseHeldClose = resolve));
async function waitFor(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
  const [path, query] = request.url.split("?");
  await writeFile(
    requestLog,
    `${JSON.stringify({ method: request.method, path: request.url, body })}\n`,
    { flag: "a" },
  );
  let result;
  if (path === "/health") result = { status: "ok" };
  else if (request.method === "PUT") result = { status: "idle" };
  else if (path.endsWith("/history")) {
    const limit = Number(new URLSearchParams(query).get("limit"));
    result = {
      events: [
        {
          workspaceId: "MUST_NOT_REACH_GUEST",
          kind: "user",
          data: {
            text: "prior",
            large: "x".repeat(limit === 200 ? 1100000 : 70000),
          },
        },
      ],
      nextAfter: Number(new URLSearchParams(query).get("after")) + 1,
      hasMore: false,
    };
  } else if (path.endsWith("/input")) {
    if (body.message === "hold open request") {
      releaseHeldRequest();
      response.once("close", releaseHeldClose);
      return;
    }
    agentStatus = "running";
    result = { submissionId: 17, status: "admitted" };
  } else if (path.endsWith("/abort")) {
    abortCount++;
    agentStatus = body.background ? "aborted_background" : "aborted";
    result = { status: agentStatus };
  } else if (request.method === "GET")
    result = {
      id: "MUST_NOT_REACH_GUEST",
      namespace: "must-not-reach-guest",
      status: agentStatus,
      error: null,
    };
  else result = { error: { message: "unexpected request" } };
  response.writeHead(
    path === "/health" || request.method === "PUT" ? 200 : 202,
    { "content-type": "application/json" },
  );
  response.end(JSON.stringify(result));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await mkdir(join(root, "remote-tmp"));
  await writeFile(wrongKubeconfig, "parent context");
  await writeFile(selectedKubeconfig, "selected context");
  await mkdir(mappedRepository, { recursive: true });
  await writeFile(join(mappedRepository, "README.md"), "selected repository\n");
  await writeFile(
    kube,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(execLog)}, JSON.stringify(args) + "\\n");
await appendFile(${JSON.stringify(hostEnvLog)}, JSON.stringify(process.env.KUBECONFIG ?? "<unset>") + "\\n");
const statePath = ${JSON.stringify(stateFile)};
const shellPidPath = ${JSON.stringify(join(root, "shell.pid"))};
let state = {};
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch {}
if (args[0] === "get" && args[1] === "storageclass") process.stdout.write(JSON.stringify({provisioner:"driver.longhorn.io"}));
else if (args[0] === "apply") {
  let input = ""; for await (const chunk of process.stdin) input += chunk;
  const manifest = JSON.parse(input); const ns = manifest.items.find(x => x.kind === "Namespace");
  state[ns.metadata.name] = ns; await writeFile(statePath, JSON.stringify(state)); process.stdout.write("applied\\n");
} else if (args[0] === "get" && args[1] === "namespace") {
  if (!state[args[2]]) { process.stderr.write("namespace not found\\n"); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify(state[args[2]]));
} else if (args[0] === "wait") process.stdout.write("condition met\\n");
else if (args[0] === "exec") {
  const split = args.indexOf("--"); const command = args.slice(split + 1);
  if (command[0] === "sh" && command[1] === "-eu" && command[4] === "adm-repository") {
    process.stdout.write("repository prepared\\n");
  } else if (
    command[0] === "bash" &&
    command[1] === "-l" &&
    command[2] === "-c"
  ) {
    const remoteEnv = {
      HOME: ${JSON.stringify(join(root, "container-home"))},
      PATH: dirname(process.execPath) + ":/usr/bin:/bin",
      TERM: "xterm",
    };
    const mappedCommand = [...command];
    const cwdIndex = mappedCommand.findIndex(
      (value) => value === "/repos" || value === "/repos/owner/project",
    );
    if (cwdIndex < 0)
      throw new Error("default managed shell omitted its public cwd argv");
    mappedCommand[cwdIndex] =
      mappedCommand[cwdIndex] === "/repos"
        ? ${JSON.stringify(mappedRepos)}
        : ${JSON.stringify(mappedRepository)};
    const child = spawn("bash", mappedCommand.slice(1), {
      env: remoteEnv,
      stdio: "inherit",
    });
    const [code, signal] = await new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve([code, signal])),
    );
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  } else if (command[0] === "sh" && command[1] === "-lc" && command[5] === "node") {
    const remoteEnv = { HOME: ${JSON.stringify(join(root, "container-home"))}, TMPDIR: ${JSON.stringify(join(root, "remote-tmp"))}, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm", ADM_TEST_CWD: command[4] };
    await appendFile(${JSON.stringify(envLog)}, JSON.stringify(remoteEnv) + "\\n");
    const child = spawn(process.execPath, command.slice(6), { env: remoteEnv, stdio: "inherit" });
    const [code, signal] = await new Promise(resolve => child.once("exit", (code, signal) => resolve([code, signal])));
    if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
  } else if (command[0] === "node" && command[1] === "--input-type=module" && command[2] === "-e") {
    const remoteEnv = { HOME: ${JSON.stringify(join(root, "container-home"))}, TMPDIR: ${JSON.stringify(join(root, "remote-tmp"))}, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm", HOST_SENTINEL: undefined };
    delete remoteEnv.HOST_SENTINEL;
    await appendFile(${JSON.stringify(envLog)}, JSON.stringify(remoteEnv) + "\\n");
    const child = spawn(process.execPath, command.slice(1), { env: remoteEnv, stdio: "inherit" });
    const [code, signal] = await new Promise(resolve => child.once("exit", (code, signal) => resolve([code, signal])));
    if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
  } else if (command[0] === "env") {
    await writeFile(shellPidPath, String(process.pid));
    const remoteEnv = { HOME: ${JSON.stringify(join(root, "container-home"))}, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm" };
    let i = 1; while (i < command.length && command[i].includes("=")) { const [key, ...value] = command[i].split("="); remoteEnv[key] = value.join("=").replaceAll("/usr/local/bin", dirname(process.execPath)); i++; }
    await appendFile(${JSON.stringify(envLog)}, JSON.stringify(remoteEnv) + "\\n");
    const child = spawn(command[i], command.slice(i + 1), { env: remoteEnv, stdio: "inherit" });
    process.once("SIGTERM", () => child.kill("SIGTERM"));
    const [code, signal] = await new Promise(resolve => child.once("exit", (code, signal) => resolve([code, signal])));
    if (signal) process.exitCode = signal === "SIGTERM" ? 143 : 130; else process.exitCode = code ?? 1;
  } else { process.stderr.write("unexpected exec payload\\n"); process.exitCode = 2; }
} else { process.stderr.write("unexpected kubectl args: " + JSON.stringify(args) + "\\n"); process.exitCode = 2; }
`,
    { mode: 0o755 },
  );
  await mkdir(join(root, "container-home"));
  await writeFile(
    join(root, "container-home", ".bash_profile"),
    `export PATH=${dirname(process.execPath)}:/usr/bin:/bin\n`,
  );
  const runnerUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    KUBECONFIG: wrongKubeconfig,
    HOST_SENTINEL: "must-not-cross-exec",
  };
  delete env.ADM_PROJECT_DIR;
  delete env.ADM_STATE_DIR;
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        adm,
        [
          "--state-dir",
          join(root, "state"),
          "--kubectl",
          kube,
          "--runner-url",
          runnerUrl,
          "--kubeconfig",
          selectedKubeconfig,
          ...args,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const stdout = [],
        stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        }),
      );
    });
  const runInteractive = (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        adm,
        [
          "--state-dir",
          join(root, "state"),
          "--kubectl",
          kube,
          "--runner-url",
          runnerUrl,
          "--kubeconfig",
          selectedKubeconfig,
          ...args,
        ],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
      const stdout = [],
        stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        }),
      );
      child.stdin.end(input);
    });

  const created = await run([
    "create",
    "manage-current",
    "--model",
    "faux/faux-1",
    "--repo",
    "owner/project",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const workspace = JSON.parse(created.stdout);
  const command = [
    "sh",
    "-c",
    `set -eu
adm status --json
adm history --limit 1
error=$(adm history --limit 200 2>&1) && exit 43
case "$error" in *"smaller --limit"*) echo OVERSIZE_CLEAR;; *) exit 44;; esac
adm prompt 'literal $(touch /tmp/adm-management-should-not-exist); "quoted"'
adm abort --background
adm prompt 'leave the agent running after detach'
if adm status sibling-workspace 2>/dev/null; then exit 41; else echo SIBLING_DENIED; fi
if adm destroy sibling-workspace 2>/dev/null; then exit 42; else echo VERB_DENIED; fi
`,
  ];
  const shell = await run([
    "shell",
    "manage-current",
    "--manage",
    "--",
    ...command,
  ]);
  assert.equal(shell.code, 0, `stdout=${shell.stdout}\nstderr=${shell.stderr}`);
  assert.match(shell.stdout, /"status": "running"/);
  assert.match(shell.stdout, /"text": "prior"/);
  assert.match(shell.stdout, /"large": "x{100}/);
  assert.match(shell.stdout, /OVERSIZE_CLEAR/);
  assert.match(shell.stdout, /"submissionId": 17/);
  assert.match(shell.stdout, /aborted_background/);
  assert.match(shell.stdout, /SIBLING_DENIED/);
  assert.match(shell.stdout, /VERB_DENIED/);
  assert.doesNotMatch(
    shell.stdout,
    /MUST_NOT_REACH_GUEST|must-not-reach-guest|${workspace.id}/,
  );

  const kubectlCalls = (await readFile(execLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const hostKubeconfigs = (await readFile(hostEnvLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(hostKubeconfigs.length, kubectlCalls.length);
  assert.ok(
    hostKubeconfigs.every((value) => value === selectedKubeconfig),
    `every host kubectl call, including relay and interactive shell, must use the selected kubeconfig: ${hostKubeconfigs}`,
  );
  const managedRelay = kubectlCalls.find(
    (args) =>
      args[0] === "exec" &&
      args.includes("-i") &&
      args[args.indexOf("--") + 1] === "sh",
  );
  assert.ok(managedRelay, "managed session opens an stdin/stdout relay exec");
  assert.equal(
    hostKubeconfigs[kubectlCalls.indexOf(managedRelay)],
    selectedKubeconfig,
  );
  const remoteCommand = managedRelay.slice(managedRelay.indexOf("--") + 1);
  assert.deepEqual(remoteCommand.slice(0, 8), [
    "sh",
    "-lc",
    'cd -- "$1" && shift && exec "$@"',
    "adm-managed-shell",
    "/repos/owner/project",
    "node",
    "--input-type=module",
    "-e",
  ]);
  assert.doesNotMatch(remoteCommand[8], new RegExp(workspace.id));
  assert.doesNotMatch(
    remoteCommand.join(" "),
    /runner-url|state-dir|HOST_SENTINEL|credential/i,
  );
  const remoteShell = kubectlCalls.find(
    (args) => args[0] === "exec" && args[args.indexOf("--") + 1] === "env",
  );
  assert.ok(
    remoteShell,
    "shell receives only its private client path and socket",
  );
  assert.equal(
    hostKubeconfigs[kubectlCalls.indexOf(remoteShell)],
    selectedKubeconfig,
  );
  const remoteEnvs = (await readFile(envLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    remoteEnvs.some((value) => value.HOST_SENTINEL),
    false,
  );
  assert.equal(
    remoteEnvs.some((value) => value.ADM_RUNNER_URL || value.ADM_STATE_DIR),
    false,
  );
  assert.equal(
    remoteEnvs.some((value) => value.KUBECONFIG),
    false,
    "the host kubeconfig path must not be sent into the workspace container",
  );
  assert.equal(
    agentStatus,
    "running",
    "closing the shell must leave accepted work running",
  );
  assert.equal(abortCount, 1, "relay cleanup must not issue an implicit abort");
  const requests = (await readFile(requestLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    requests.map(({ method, path }) => [method, path]),
    [
      ["GET", "/health"],
      ["PUT", `/v1/workspaces/${workspace.id}`],
      ["GET", `/v1/workspaces/${workspace.id}`],
      ["GET", `/v1/workspaces/${workspace.id}/history?after=0&limit=1`],
      ["GET", `/v1/workspaces/${workspace.id}/history?after=0&limit=200`],
      ["POST", `/v1/workspaces/${workspace.id}/input`],
      ["POST", `/v1/workspaces/${workspace.id}/abort`],
      ["POST", `/v1/workspaces/${workspace.id}/input`],
    ],
  );
  assert.equal(
    requests.find(
      ({ method, path }) =>
        method === "PUT" && path === `/v1/workspaces/${workspace.id}`,
    ).body.cwd,
    "/repos/owner/project",
  );
  assert.equal(
    requests.find(({ path }) => path.endsWith("/input")).body.message,
    'literal $(touch /tmp/adm-management-should-not-exist); "quoted"',
  );
  assert.match(
    requests.find(({ path }) => path.endsWith("/input")).body.requestId,
    /^[0-9a-f-]{36}$/,
  );
  assert.deepEqual(requests.find(({ path }) => path.endsWith("/abort")).body, {
    background: true,
  });
  assert.deepEqual(
    await readdir(join(root, "remote-tmp")),
    [],
    "guest socket and executable are removed when the shell exits",
  );
  assert.ok(shell.stdout.includes("prior"));

  const detached = spawn(
    adm,
    [
      "--state-dir",
      join(root, "state"),
      "--kubectl",
      kube,
      "--runner-url",
      runnerUrl,
      "--kubeconfig",
      selectedKubeconfig,
      "shell",
      "manage-current",
      "--manage",
      "--",
      "sh",
      "-c",
      "adm prompt 'hold open request'",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const detachedOutput = [];
  detached.stdout.on("data", (chunk) => detachedOutput.push(chunk));
  const detachedExit = once(detached, "exit");
  await waitFor(heldRequest, "held runner request did not arrive");
  process.kill(
    Number(await readFile(join(root, "shell.pid"), "utf8")),
    "SIGTERM",
  );
  const [detachedCode] = await waitFor(
    detachedExit,
    "detached managed shell did not exit",
  );
  assert.notEqual(detachedCode, 0, Buffer.concat(detachedOutput).toString());
  await waitFor(heldClose, "runner request stayed open after shell detach");
  assert.equal(
    agentStatus,
    "running",
    "transport cleanup must not abort held work",
  );
  assert.equal(
    abortCount,
    1,
    "detaching a pending prompt must not submit an abort",
  );
  assert.deepEqual(await readdir(join(root, "remote-tmp")), []);

  const defaultShell = await runInteractive(
    ["shell", "manage-current", "--manage"],
    "pwd\ncat README.md\nadm status --json\nexit\n",
  );
  assert.equal(
    defaultShell.code,
    0,
    `stdout=${defaultShell.stdout}\\nstderr=${defaultShell.stderr}`,
  );
  assert.ok(defaultShell.stdout.includes(mappedRepository), defaultShell.stdout);
  assert.match(defaultShell.stdout, /selected repository/);
  assert.match(defaultShell.stdout, /"status": "running"/);
  const allKubectlCalls = (await readFile(execLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const allHostKubeconfigs = (await readFile(hostEnvLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(allHostKubeconfigs.length, allKubectlCalls.length);
  assert.ok(allHostKubeconfigs.every((value) => value === selectedKubeconfig));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true });
}
