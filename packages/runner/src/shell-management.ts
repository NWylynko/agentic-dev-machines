import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const CLIENT_SOURCE = String.raw`#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

const usage = 'Usage: adm status [--json] | history [--after N] [--limit N] | prompt MESSAGE | abort [--background] | help';
function fail(message) { process.stderr.write(message + '\n' + usage + '\n'); process.exit(2); }
const [action = 'help', ...args] = process.argv.slice(2);
let payload;
if (action === 'help' && args.length === 0) {
  process.stdout.write(usage + '\nManagement is limited to this workspace. Use adm list, create, destroy, exec, port, and other host commands on the management host.\n');
  process.exit(0);
} else if (action === 'status') {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) fail('status accepts only --json');
  payload = { action, args: { json: args.length === 1 } };
} else if (action === 'history') {
  let after = 0;
  let limit = 200;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option === '--after' && value && /^(0|[1-9][0-9]*)$/.test(value)) after = Number(value);
    else if (option === '--limit' && value && /^(0|[1-9][0-9]*)$/.test(value)) limit = Number(value);
    else fail('history accepts --after N and --limit N');
  }
  if (!Number.isSafeInteger(after) || !Number.isInteger(limit) || limit < 1 || limit > 200) fail('history cursor must be nonnegative and limit must be 1..200');
  payload = { action, args: { after, limit } };
} else if (action === 'prompt') {
  if (args.length !== 1 || !args[0].trim() || args[0].length > 10000) fail('prompt requires one nonempty message (up to 10000 characters)');
  payload = { action, args: { message: args[0] } };
} else if (action === 'abort') {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--background')) fail('abort accepts only --background');
  payload = { action, args: { background: args.length === 1 } };
} else fail('unsupported management action');

const socketPath = process.env.ADM_MANAGE_SOCKET;
if (!socketPath) fail('managed shell socket is unavailable');
const id = randomUUID();
const socket = connect(socketPath);
let buffer = '';
socket.once('connect', () => {
  const frame = JSON.stringify({ id, ...payload }) + '\n';
  if (Buffer.byteLength(frame) > 131072) fail('management request exceeds 128 KiB');
  socket.write(frame);
});
socket.on('data', (bytes) => {
  buffer += bytes.toString();
  if (Buffer.byteLength(buffer) > 1048576) { process.stderr.write('management response exceeds 1 MiB; rerun history with a smaller --limit\n'); socket.destroy(); process.exitCode = 1; return; }
  const newline = buffer.indexOf('\n');
  if (newline < 0) return;
  const response = JSON.parse(buffer.slice(0, newline));
  if (response.id !== id || typeof response.ok !== 'boolean') { process.stderr.write('invalid management response\n'); process.exitCode = 1; }
  else if (!response.ok) { process.stderr.write(String(response.error || 'management request failed') + '\n'); process.exitCode = 1; }
  else process.stdout.write(String(response.output || ''));
  socket.end();
});
socket.once('error', (error) => { process.stderr.write('management request failed: ' + error.message + '\n'); process.exitCode = 1; });
`;

const GUEST = String.raw`
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_REQUEST_FRAME = 131072;
const MAX_RESPONSE_FRAME = 1048576;
const directory = await mkdtemp(join(tmpdir(), 'adm-manage-'));
await chmod(directory, 0o700);
const socketPath = join(directory, 'control.sock');
const clientPath = join(directory, 'adm');
const CLIENT = ${JSON.stringify(CLIENT_SOURCE)};

const sockets = new Set();
let closing = false;
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  let buffer = "";
  socket.on("data", (bytes) => {
    buffer += bytes.toString("utf8");
    if (Buffer.byteLength(buffer) > MAX_REQUEST_FRAME) {
      socket.destroy();
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const frame = buffer.slice(0, newline);
    buffer = "";
    try {
      const request = JSON.parse(frame);
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !== "action,args,id" ||
        typeof request.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(request.id) ||
        typeof request.action !== "string" ||
        !request.args ||
        typeof request.args !== "object" ||
        Array.isArray(request.args)
      ) {
        socket.destroy();
        return;
      }
      process.stdout.write(JSON.stringify(request) + "\n");
      pending.set(request.id, socket);
    } catch {
      socket.destroy();
    }
  });
});
const pending = new Map();
async function cleanup() {
  if (closing) return;
  closing = true;
  server.close();
  for (const socket of sockets) socket.destroy();
  await rm(directory, { recursive: true });
}
server.listen(socketPath, async () => {
  try {
    await chmod(socketPath, 0o600);
    await writeFile(clientPath, CLIENT, { mode: 0o700 });
    await chmod(clientPath, 0o700);
    process.stdout.write(JSON.stringify({ kind: "ready", directory, socket: socketPath }) + "\n");
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
});
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_RESPONSE_FRAME) process.exit(2);
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const frame = input.slice(0, newline);
    input = input.slice(newline + 1);
    try {
      const response = JSON.parse(frame);
      const socket = pending.get(response.id);
      if (!socket || typeof response.ok !== "boolean") continue;
      pending.delete(response.id);
      socket.end(JSON.stringify(response) + "\n");
    } catch {
      process.exit(2);
    }
  }
});
process.stdin.on("end", () => void cleanup());
`;

const MAX_REQUEST_FRAME = 131072;
const MAX_RESPONSE_FRAME = 1048576;
const execFileAsync = promisify(execFile);

const { values, positionals } = parseArgs({
  options: {
    kubectl: { type: "string" },
    namespace: { type: "string" },
    "workspace-id": { type: "string" },
    cwd: { type: "string" },
    "runner-url": { type: "string" },
    "identity-file": { type: "string" },
  },
  allowPositionals: true,
  strict: true,
});
const {
  kubectl,
  namespace,
  "workspace-id": workspaceId,
  cwd,
  "runner-url": runnerUrl,
  "identity-file": identityFile,
} = values;
if (
  !kubectl ||
  !namespace ||
  !workspaceId ||
  !cwd ||
  !runnerUrl ||
  !identityFile
)
  throw new Error(
    "managed shell needs kubectl, namespace, workspace ID, runner URL, and Pod identity",
  );
const runtimeIdentityFile = identityFile!;
const runtimeWorkspaceId = workspaceId!;
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId))
  throw new Error("invalid immutable workspace ID");
if (!cwd.startsWith("/") || cwd.includes("\0"))
  throw new Error("managed shell cwd must be an absolute container path");
const runner = new URL(runnerUrl);
if (
  runner.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]", "::1"].includes(runner.hostname)
)
  throw new Error("runner must use the management host loopback URL");
const path = "/v1/workspaces/" + encodeURIComponent(workspaceId);
const relay = spawn(
  kubectl,
  [
    "exec",
    "-i",
    "-n",
    namespace,
    "deployment/workspace",
    "-c",
    "dev",
    "--",
    "sh",
    "-lc",
    'cd -- "$1" && shift && exec "$@"',
    "adm-managed-shell",
    cwd,
    "node",
    "--input-type=module",
    "-e",
    GUEST,
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const lines = createInterface({ input: relay.stdout });
let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
const relayExit = new Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>((resolve, reject) => {
  relay.once("error", reject);
  relay.once("exit", (code, signal) => {
    exited = { code, signal };
    resolve(exited);
  });
});
let ready: { directory: string; socket: string };
try {
  ready = await new Promise<{ directory: string; socket: string }>(
    (resolve, reject) => {
      const onExit = (result: {
        code: number | null;
        signal: NodeJS.Signals | null;
      }) =>
        reject(
          new Error(
            "management relay exited before ready (" +
              (result.signal ?? result.code) +
              ")",
          ),
        );
      relayExit.then(onExit, reject);
      lines.once("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (
            event.kind !== "ready" ||
            typeof event.directory !== "string" ||
            typeof event.socket !== "string"
          )
            throw new Error("invalid guest management readiness");
          resolve(event);
        } catch (error) {
          reject(error);
        }
      });
    },
  );
} catch (error) {
  if (!relay.stdin.destroyed) relay.stdin.end();
  await relayExit.catch(() => undefined);
  throw error;
}
let dispatchQueue = Promise.resolve();
const lifetime = new AbortController();
let dispatchFailure: unknown;
let acceptingRequests = true;
lines.on("line", (line) => {
  if (!acceptingRequests) return;
  dispatchQueue = dispatchQueue
    .then(async () => {
      if (dispatchFailure) return;
      if (Buffer.byteLength(line) > MAX_REQUEST_FRAME)
        throw new Error("management request exceeds 128 KiB");
      const request = JSON.parse(line);
      const response: {
        id: string;
        ok: boolean;
        error?: string;
        output?: string;
      } = {
        id: request.id,
        ok: false,
        error: "unsupported management action",
      };
      try {
        let result;
        if (
          request.action === "status" &&
          exactKeys(request.args, ["json"]) &&
          typeof request.args.json === "boolean"
        ) {
          const value = await runnerRequest("GET", path);
          result = { status: value.status, error: value.error ?? null };
          response.output = request.args.json
            ? JSON.stringify(result, null, 2) + "\n"
            : "Agent: " +
              result.status +
              (result.error ? "\nError: " + result.error : "") +
              "\n";
        } else if (
          request.action === "history" &&
          exactKeys(request.args, ["after", "limit"]) &&
          Number.isSafeInteger(request.args.after) &&
          request.args.after >= 0 &&
          Number.isInteger(request.args.limit) &&
          request.args.limit >= 1 &&
          request.args.limit <= 200
        ) {
          const value = await runnerRequest(
            "GET",
            path +
              "/history?after=" +
              request.args.after +
              "&limit=" +
              request.args.limit,
          );
          result = {
            events: Array.isArray(value.events)
              ? value.events.map((event: Record<string, unknown>) => {
                  const { workspaceId: _id, ...publicEvent } = event;
                  return publicEvent;
                })
              : [],
            nextAfter: value.nextAfter,
            hasMore: value.hasMore,
          };
          response.output = JSON.stringify(result, null, 2) + "\n";
        } else if (
          request.action === "prompt" &&
          exactKeys(request.args, ["message"]) &&
          typeof request.args.message === "string" &&
          request.args.message.trim() &&
          request.args.message.length <= 10000
        ) {
          const value = await runnerRequest("POST", path + "/input", {
            message: request.args.message,
            requestId: randomUUID(),
          });
          response.output = JSON.stringify(value, null, 2) + "\n";
        } else if (
          request.action === "abort" &&
          exactKeys(request.args, ["background"]) &&
          typeof request.args.background === "boolean"
        ) {
          const value = await runnerRequest("POST", path + "/abort", {
            background: request.args.background,
          });
          result = { status: value.status };
          response.output = JSON.stringify(result, null, 2) + "\n";
        } else {
          throw new Error("unsupported management action or arguments");
        }
        response.ok = true;
        delete response.error;
      } catch (error) {
        response.error = error instanceof Error ? error.message : String(error);
      }
      let frame = JSON.stringify(response) + "\n";
      if (Buffer.byteLength(frame) > MAX_RESPONSE_FRAME) {
        frame =
          JSON.stringify({
            id: request.id,
            ok: false,
            error:
              "management response exceeds 1 MiB; rerun history with a smaller --limit",
          }) + "\n";
      }
      if (!relay.stdin.destroyed && !relay.stdin.writableEnded)
        relay.stdin.write(frame);
    })
    .catch((error) => {
      dispatchFailure = error;
      process.stderr.write(
        "managed shell relay failed: " +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
      relay.kill("SIGTERM");
      if (shell && !shell.killed) shell.kill("SIGTERM");
    });
});

async function runnerRequest(method: string, urlPath: string, body?: unknown) {
  const url = new URL(urlPath, runner);
  const authorization = `Bearer ${await projectedPodToken(runtimeIdentityFile, runtimeWorkspaceId)}`;
  const response = await fetch(url, {
    method,
    signal: lifetime.signal,
    headers: {
      authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : {};
  if (!response.ok)
    throw new Error(
      value.error?.message ?? "runner request failed (" + response.status + ")",
    );
  return value;
}

async function projectedPodToken(
  identityPath: string,
  expectedWorkspaceId: string,
) {
  const identity = JSON.parse(await readFile(identityPath, "utf8")) as {
    workspaceId: string;
    namespace: string;
    podName: string;
    podUid: string;
    container: string;
    kubectl: string;
    kubeconfig: string;
  };
  if (
    identity.workspaceId !== expectedWorkspaceId ||
    identity.namespace !== namespace ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(identity.namespace) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(identity.podName) ||
    !/^[0-9a-f-]{36}$/i.test(identity.podUid) ||
    !["dev", "bot"].includes(identity.container) ||
    identity.kubectl !== kubectl ||
    !identity.kubeconfig
  )
    throw new Error("Workspace Pod identity descriptor is invalid");
  const options = {
    encoding: "utf8" as const,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, KUBECONFIG: identity.kubeconfig },
  };
  const podResult = await execFileAsync(
    identity.kubectl,
    ["get", "pod", identity.podName, "-n", identity.namespace, "-o", "json"],
    options,
  );
  const pod = JSON.parse(podResult.stdout) as {
    metadata?: {
      uid?: string;
      namespace?: string;
      labels?: Record<string, string>;
    };
    spec?: { serviceAccountName?: string };
    status?: {
      phase?: string;
      conditions?: Array<{ type?: string; status?: string }>;
    };
  };
  const ready = pod.status?.conditions?.some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  );
  if (
    pod.metadata?.uid !== identity.podUid ||
    pod.metadata.namespace !== identity.namespace ||
    pod.metadata.labels?.["adm.dev/workspace-id"] !== identity.workspaceId ||
    pod.metadata.labels?.["app.kubernetes.io/managed-by"] !== "adm" ||
    pod.spec?.serviceAccountName !== "adm-runtime" ||
    pod.status?.phase !== "Running" ||
    !ready
  )
    throw new Error(
      "Workspace Pod identity changed or is not ready; reopen the managed shell",
    );
  const tokenResult = await execFileAsync(
    identity.kubectl,
    [
      "exec",
      "-n",
      identity.namespace,
      identity.podName,
      "-c",
      identity.container,
      "--",
      "cat",
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    ],
    options,
  );
  const token = tokenResult.stdout.trim();
  if (!token) throw new Error("Workspace projected identity token is empty");
  return token;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

let shell: ChildProcess | undefined;
let shellResult: { code: number | null; signal: NodeJS.Signals | null };
try {
  const shellArgs = positionals.length
    ? positionals
    : [
        "bash",
        "-l",
        "-c",
        'cd -- "$1" && export PWD="$1" PATH="$2:$PATH" ADM_MANAGE_SOCKET="$3" USER="$(id -un)" SHELL=/usr/bin/zsh && exec env ZDOTDIR=/workspace/.adm/zsh zsh -l',
        "adm-shell",
        cwd,
        ready.directory,
        ready.socket,
      ];
  if (positionals.length) {
    const [program, ...args] = shellArgs;
    shell = spawn(
      kubectl,
      [
        "exec",
        "-it",
        "-n",
        namespace,
        "deployment/workspace",
        "-c",
        "dev",
        "--",
        "env",
        `PATH=${ready.directory}:/usr/local/bin:/usr/bin:/bin`,
        `ADM_MANAGE_SOCKET=${ready.socket}`,
        program!,
        ...args,
      ],
      { stdio: "inherit" },
    );
  } else {
    shell = spawn(
      kubectl,
      [
        "exec",
        "-it",
        "-n",
        namespace,
        "deployment/workspace",
        "-c",
        "dev",
        "--",
        ...shellArgs,
      ],
      { stdio: "inherit" },
    );
  }
  const shellExit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    shell!.once("error", reject);
    shell!.once("exit", (code, signal) => resolve({ code, signal }));
  });
  relayExit.then(() => {
    if (!shell!.killed) shell!.kill("SIGTERM");
  });
  shellResult = await shellExit;
  if (relay.exitCode !== null || relay.signalCode !== null)
    throw new Error(
      `management relay exited during shell (${relay.signalCode ?? relay.exitCode})`,
    );
} finally {
  acceptingRequests = false;
  lifetime.abort(new Error("managed shell closed"));
  await dispatchQueue;
  if (!relay.stdin.destroyed && !relay.stdin.writableEnded) relay.stdin.end();
  lines.close();
  if (!exited) await relayExit;
}
if (shellResult.signal)
  process.exitCode = 128 + (shellResult.signal === "SIGINT" ? 2 : 15);
else process.exitCode = shellResult.code ?? 1;
