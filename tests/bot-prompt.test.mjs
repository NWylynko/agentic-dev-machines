import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";

const [binary] = process.argv.slice(2);
assert.ok(binary, "adm binary path is required");
const root = await mkdtemp(join(tmpdir(), "adm-bot-prompt-"));
const exec = promisify(execFile);
const kubectl = join(root, "kubectl");
const mcpServer = join(root, "mcp-server.mjs");
const mcpConfig = join(root, "mcp-config.json");
const mcpInitialized = join(root, "mcp-initialized.txt");
await writeFile(
  kubectl,
  `#!/usr/bin/env python3
import json, pathlib, sys
path = pathlib.Path(__file__).parent / 'cluster.json'
state = json.loads(path.read_text()) if path.exists() else {'namespaces': {}, 'resources': []}
args = sys.argv[1:]
if args[:2] == ['get', 'storageclass']:
    print(json.dumps({'provisioner':'driver.longhorn.io','metadata':{'name':args[2]}}))
elif args[0] == 'apply':
    doc=json.load(sys.stdin)
    for item in doc['items']:
        state['resources'].append(item)
        if item['kind']=='Namespace': state['namespaces'][item['metadata']['name']]=item
    path.write_text(json.dumps(state)); print('applied')
elif args[:2] == ['get','namespace']:
    if args[2] in state['namespaces']: print(json.dumps(state['namespaces'][args[2]]))
    else: print('Error from server (NotFound): namespaces not found',file=sys.stderr);sys.exit(1)
elif args[:2] == ['delete','namespace']:
    state['namespaces'].pop(args[2],None);path.write_text(json.dumps(state)); print('deleted')
elif args[0] == 'wait': print('condition met')
elif args[:2] == ['get','pods']:
    namespace = args[args.index('-n')+1] if '-n' in args else None
    pods = [item for item in state['resources'] if item['kind']=='Pod' and (namespace is None or item.get('metadata',{}).get('namespace')==namespace)]
    print(json.dumps({'items':pods}))
else: print('unexpected kubectl arguments: '+repr(args),file=sys.stderr);sys.exit(2)
`,
);
await chmod(kubectl, 0o755);
await writeFile(
  mcpServer,
  `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const registryPath = ${JSON.stringify(join(root, "runner", "workspaces.json"))};
const initialized = ${JSON.stringify(join(root, "mcp-initialized.txt"))};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => process.exit(0));
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
      const registered = process.env.MCP_TOKEN === "cli-secret" && JSON.parse(readFileSync(registryPath, "utf8")).some((entry) => entry.mcpServers?.[0]?.tools?.includes("cli_ping"));
      appendFileSync(initialized, String(registered));
      result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "cli-fixture", version: "1" } };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "cli_ping", description: "CLI fixture", inputSchema: { type: "object", properties: {} } }] };
    } else {
      result = { content: [{ type: "text", text: "pong" }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`,
);
await chmod(mcpServer, 0o755);
await writeFile(
  mcpConfig,
  JSON.stringify([
    {
      id: "cli_fixture",
      command: mcpServer,
      tools: ["cli_ping"],
      secretEnv: { MCP_TOKEN: "MCP_CLI_TOKEN" },
    },
  ]),
);

const runner = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "packages/runner/src/main.ts",
    "--port",
    "0",
    "--state-dir",
    join(root, "runner"),
    "--provider",
    "faux",
  ],
  {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MCP_CLI_TOKEN: "cli-secret" },
  },
);
const runnerExited = once(runner, "exit");
const lines = createInterface({ input: runner.stdout });
let runnerErrors = "";
runner.stderr.on("data", (chunk) => (runnerErrors += chunk));
const ready = new Promise((resolve, reject) => {
  runner.once("exit", (code) =>
    reject(new Error(`runner exit ${code}: ${runnerErrors}`)),
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
  const runCli = async (args, runnerUrl = url) =>
    exec(
      binary,
      [
        "--state-dir",
        join(root, "cli-state"),
        "--kubectl",
        kubectl,
        "--runner-url",
        runnerUrl,
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, XDG_CONFIG_HOME: join(root, "config") },
      },
    );
  const cli = async (args) => JSON.parse((await runCli(args)).stdout);
  const createHelp = await runCli(["create", "--help"]);
  assert.match(createHelp.stdout, /management-host runner/);
  assert.match(createHelp.stdout, /no workspace Pod/);
  const disabled = await runCli([
    "create",
    "shell-bot",
    "--role",
    "bot",
    "--no-agent",
  ]);
  const shellBot = JSON.parse(disabled.stdout);
  assert.equal(shellBot.agent_enabled, false);
  assert.match(disabled.stderr, /no enabled agent/);
  assert.doesNotMatch(disabled.stderr, /management-host runner/);
  await cli(["destroy", "shell-bot"]);
  const created = await runCli([
    "create",
    "fixture-bot",
    "--role",
    "bot",
    "--model",
    "faux/faux-1",
    "--mcp-config",
    mcpConfig,
  ]);
  const bot = JSON.parse(created.stdout);
  assert.match(created.stderr, /management-host runner/);
  assert.match(created.stderr, /namespace.*no.*Pod/i);
  assert.ok(created.stderr.includes("adm attach fixture-bot"));
  const cluster = JSON.parse(
    await readFile(join(root, "cluster.json"), "utf8"),
  );
  assert.deepEqual(
    cluster.resources.map(({ kind }) => kind),
    ["Namespace", "Namespace"],
    "bot creation applies only a Kubernetes namespace, never a Pod or workload",
  );
  const pods = await exec(kubectl, [
    "get",
    "pods",
    "-n",
    bot.namespace,
    "-o",
    "json",
  ]);
  assert.deepEqual(JSON.parse(pods.stdout).items, []);
  const healthyStatus = (await runCli(["status", "fixture-bot"])).stdout;
  assert.match(healthyStatus, /management host/);
  assert.doesNotMatch(healthyStatus, /Agent unavailable/);
  const offlineStatus = (
    await runCli(["status", "fixture-bot"], "http://127.0.0.1:1")
  ).stdout;
  assert.match(offlineStatus, /management host/);
  assert.match(offlineStatus, /Agent unavailable/);
  const table = (await runCli(["list"], "http://127.0.0.1:1")).stdout;
  assert.match(table, /NAME\s+ROLE\s+PHASE\s+AGENT\s+ID/);
  assert.match(
    table,
    new RegExp(`fixture-bot\\s+bot\\s+ready\\s+enabled\\s+${bot.id}`),
    "default list shows the configured agent state and full immutable ID without contacting the runner",
  );
  const registered = await fetch(`${url}/v1/workspaces/${bot.id}`);
  const botStatus = await registered.json();
  assert.ok(botStatus.tools.includes("mcp_cli_fixture_cli_ping"));
  assert.equal(await readFile(mcpInitialized, "utf8"), "true");
  const watch = await fetch(`${url}/v1/workspaces/${bot.id}/events`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(watch.status, 200);
  const diagnosticWatch = await fetch(
    `${url}/v1/workspaces/${bot.id}/events?diagnostics=true`,
    {
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(diagnosticWatch.status, 200);
  const diagnosticAnswer = (async () => {
    const reader = diagnosticWatch.body.getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += Buffer.from(value).toString();
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (
          event.kind === "assistant" &&
          event.data.text.includes("Private diagnostic.")
        ) {
          await reader.cancel();
          return event;
        }
      }
    }
  })();
  const firstMessage = (async () => {
    let buffer = "";
    for await (const bytes of watch.body) {
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
          if (
            event.kind === "message" &&
            event.data.text === "Prompt without request ID was delivered."
          )
            return event;
        }
      }
    }
  })();
  const noIdMessage =
    "/faux " +
    JSON.stringify({
      calls: [
        {
          tool: "sendMessage",
          args: { text: "Prompt without request ID was delivered." },
        },
      ],
      answer: "Private diagnostic.",
    });
  const noIdResponse = await cli(["prompt", "fixture-bot", noIdMessage]);
  assert.equal(
    noIdResponse.status,
    "admitted",
    "prompt without optional request ID must be admitted",
  );
  const published = await firstMessage;
  assert.equal(published.data.text, "Prompt without request ID was delivered.");
  await diagnosticAnswer;
  const publicHistory = await fetch(
    `${url}/v1/workspaces/${bot.id}/history?diagnostics=false`,
  ).then((response) => response.json());
  const diagnosticHistory = await fetch(
    `${url}/v1/workspaces/${bot.id}/history?diagnostics=true`,
  ).then((response) => response.json());
  assert.ok(publicHistory.events.some((event) => event.kind === "message"));
  assert.ok(
    publicHistory.events.every((event) =>
      ["user", "message", "status"].includes(event.kind),
    ),
    "ordinary bot history excludes diagnostic assistant records",
  );
  assert.ok(
    diagnosticHistory.events.some(
      (event) =>
        event.kind === "assistant" && event.data.text === "Private diagnostic.",
    ),
    "diagnostic history opts in to the assistant record",
  );

  const explicitMessage =
    "/faux " +
    JSON.stringify({
      calls: [
        {
          tool: "sendMessage",
          args: { text: "Explicit request ID was delivered once." },
        },
      ],
      answer: "Private diagnostic.",
    });
  const first = await cli([
    "prompt",
    "fixture-bot",
    explicitMessage,
    "--request-id",
    "fixture-id",
  ]);
  const duplicate = await cli([
    "prompt",
    "fixture-bot",
    explicitMessage,
    "--request-id",
    "fixture-id",
  ]);
  assert.equal(first.status, "admitted");
  assert.equal(duplicate.status, "admitted");
  assert.equal(
    first.submissionId,
    duplicate.submissionId,
    "repeated explicit request ID must deduplicate",
  );

  const malformed = await fetch(`${url}/v1/workspaces/${bot.id}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "malformed request ID", requestId: null }),
  });
  assert.equal(
    malformed.status,
    400,
    "runner must continue rejecting explicit null request IDs",
  );
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.error.message, "requestId must be a string");

  await cli(["destroy", "fixture-bot"]);
  console.log("CLI prompt request ID scenario passed");
} finally {
  runner.kill("SIGTERM");
  await runnerExited;
  lines.close();
  await rm(root, { recursive: true });
}
