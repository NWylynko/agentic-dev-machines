import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const main = new URL("../src/main.ts", import.meta.url);
const remoteEnv = fileURLToPath(
  new URL("../src/remote-env-server.ts", import.meta.url),
);

async function startRunner(directory) {
  const child = spawn(
    process.execPath,
    [
      main.pathname,
      "--port",
      "0",
      "--state-dir",
      directory,
      "--provider",
      "faux",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
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
        /* Diagnostics stay on the log. */
      }
    });
  });
  const { url } = await ready;
  return {
    url,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      lines.close();
    },
    async request(path, method = "GET", body) {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function nextEvent(runner, id, predicate) {
  const controller = new AbortController();
  const response = await fetch(
    `${runner.url}/v1/workspaces/${id}/events?after=0`,
    { signal: controller.signal },
  );
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
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (predicate(event)) return event;
      }
    }
    throw new Error("Event stream ended before the workspace finished");
  } finally {
    controller.abort();
  }
}

test(
  "coding tools execute in the workspace runtime and do not write the management host",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-kube-"));
    const target = join(directory, "container");
    const untouched = join(directory, "management-host");
    const log = join(directory, "kubectl.log");
    await mkdir(target);
    await mkdir(untouched);
    const kubectl = join(directory, "kubectl");
    await writeFile(
      kubectl,
      `#!/usr/bin/env python3
import os, sys
with open(${JSON.stringify(log)}, 'a') as log: log.write(' '.join(sys.argv[1:]) + '\\n')
args = sys.argv[1:]
if '--' not in args:
    sys.stderr.write('missing remote command\\n')
    sys.exit(2)
command = args[args.index('--') + 1:]
os.execvp(command[0], command)
`,
    );
    await chmod(kubectl, 0o755);
    const runner = await startRunner(join(directory, "state"));
    t.after(() => runner.stop());
    const id = "kube-coder";
    const registered = await runner.request(`/v1/workspaces/${id}`, "PUT", {
      id,
      name: "kube",
      role: "coding",
      environment: "kubernetes",
      namespace: "adm-kube",
      cwd: target,
      kubectl,
      remoteEnv,
      model: { provider: "faux", id: "faux-1" },
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    const plan = {
      calls: [
        { tool: "bash", args: { command: "printf private > noted.txt" } },
        {
          tool: "write",
          args: { path: "hello.txt", content: "from-the-tool\n" },
        },
      ],
      answer: "Tools finished in the workspace.",
    };
    assert.equal(
      (
        await runner.request(`/v1/workspaces/${id}/input`, "POST", {
          message: `/faux ${JSON.stringify(plan)}`,
          requestId: "kube-tools",
        })
      ).status,
      202,
    );
    const done = await nextEvent(
      runner,
      id,
      (event) =>
        event.kind === "assistant" &&
        event.data.text.includes("Tools finished"),
    );
    assert.match(done.data.text, /Tools finished/);
    assert.equal(await readFile(join(target, "noted.txt"), "utf8"), "private");
    assert.equal(
      await readFile(join(target, "hello.txt"), "utf8"),
      "from-the-tool\n",
    );
    await assert.rejects(access(join(untouched, "noted.txt")));
    await assert.rejects(access(join(process.cwd(), "noted.txt")));
    const trace = await readFile(log, "utf8");
    assert.match(trace, /deployment\/workspace/);
    assert.match(trace, /-n adm-kube/);
    assert.match(trace, /remote-env-server\.ts/);
  },
);
