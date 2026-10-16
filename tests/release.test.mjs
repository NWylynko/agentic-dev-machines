import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

test(
  "a release runs the CLI, terminal, provider runtime, and Code Mode without a checkout",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-release-test-"));
    let stopRunner = async () => {};
    t.after(async () => {
      await stopRunner();
      await rm(directory, { recursive: true });
    });
    const helper = join(directory, "adm-repositories");
    await writeFile(helper, "#!/bin/sh\nprintf 'release helper\\n'\n", {
      mode: 0o755,
    });
    const output = join(directory, "dist");
    await execute(
      process.execPath,
      [
        join(project, "scripts/build-release.mjs"),
        "--version",
        "v9.8.7",
        "--image",
        "ghcr.io/example/adm:9.8.7",
        "--adm",
        resolve(
          process.env.ADM_RELEASE_TEST_ADM ?? join(project, "target/debug/adm"),
        ),
        "--repositories",
        helper,
        "--output",
        output,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    await execute("sha256sum", ["--check", "SHA256SUMS"], { cwd: output });
    const unrelated = join(directory, "outside-checkout");
    await mkdir(unrelated);
    const hostTools = join(directory, "host-tools");
    await mkdir(hostTools);
    await writeFile(join(hostTools, "systemctl"), "#!/bin/sh\nexit 3\n", {
      mode: 0o755,
    });
    const environment = {
      ...process.env,
      HOME: join(directory, "home"),
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
      PATH: hostTools + delimiter + process.env.PATH,
    };
    delete environment.ADM_PROJECT_DIR;
    delete environment.ADM_STATE_DIR;
    const assets = new Map(
      await Promise.all(
        ["adm-linux-amd64.tar.gz", "SHA256SUMS"].map(async (name) => [
          "/" + name,
          await readFile(join(output, name)),
        ]),
      ),
    );
    const releaseServer = createHttpServer((request, response) => {
      const asset = assets.get(request.url);
      response.writeHead(asset ? 200 : 404);
      response.end(asset);
    });
    releaseServer.listen(0, "127.0.0.1");
    await once(releaseServer, "listening");
    t.after(
      () =>
        new Promise((resolve, reject) =>
          releaseServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    await execute(
      "sh",
      [
        join(project, "install.sh"),
        "--no-setup",
        "--base-url",
        `http://127.0.0.1:${releaseServer.address().port}`,
      ],
      {
        cwd: unrelated,
        env: environment,
      },
    );
    const adm = join(environment.HOME, ".local/bin/adm");
    const installed = dirname(dirname(await realpath(adm)));
    assert.match(
      await readFile(join(installed, "LICENSE"), "utf8"),
      /^MIT License\n[\s\S]*Copyright \(c\) 2026 Nick Wylynko[\s\S]*The above copyright notice and this permission notice/,
    );
    assert.equal(
      await readFile(join(installed, "VERSION"), "utf8"),
      "v9.8.7\n",
    );
    await execute(
      process.execPath,
      [join(project, "tests/shell-management.test.mjs"), adm],
      { cwd: unrelated, env: environment, maxBuffer: 1024 * 1024 },
    );
    assert.equal(
      await readFile(join(installed, "IMAGE"), "utf8"),
      "ghcr.io/example/adm:9.8.7\n",
    );
    const version = await execute(adm, ["--version"], {
      cwd: unrelated,
      env: environment,
    });
    assert.match(version.stdout, /^adm /);
    const manifest = await execute(adm, ["manifest", "release"], {
      cwd: unrelated,
      env: environment,
    });
    const deployment = JSON.parse(manifest.stdout).items.find(
      (resource) => resource.kind === "Deployment",
    );
    assert.equal(
      deployment.spec.template.spec.containers[0].image,
      "ghcr.io/example/adm:9.8.7",
    );
    const terminal = await execute(
      process.execPath,
      [join(installed, "runtime/terminal.mjs"), "--help"],
      { cwd: unrelated },
    );
    assert.match(terminal.stdout, /Ctrl\+C detaches/);
    const provider = await execute(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const { ModelRuntime } = await import("@earendil-works/pi-coding-agent"); if (typeof ModelRuntime.create !== "function") throw new Error("Provider runtime missing");',
      ],
      { cwd: installed },
    );
    assert.equal(provider.stderr, "");

    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    const child = spawn(
      adm,
      [
        "--runner-url",
        `http://127.0.0.1:${port}`,
        "--state-dir",
        join(directory, "state"),
        "serve",
      ],
      {
        cwd: unrelated,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    stopRunner = async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      const [code, signal] = await exited;
      lines.close();
      assert.equal(
        code,
        0,
        `Packaged runner did not shut down cleanly (${signal}): ${errors}`,
      );
    };
    const { url } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Packaged runner exited ${code}: ${errors}`)),
      );
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.ready) resolve(event);
        } catch {
          /* Diagnostic output. */
        }
      });
    });
    async function request(path, method = "GET", body) {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    }
    assert.equal((await request("/health")).status, "ok");
    const path = "/v1/workspaces/release-bot";
    await request(path, "PUT", {
      id: "release-bot",
      name: "release",
      role: "bot",
      environment: "local",
      model: { provider: "faux", id: "faux-1" },
    });
    await request(path + "/input", "POST", {
      requestId: "release-worker",
      whenBusy: "followUp",
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            {
              tool: "codemode",
              args: {
                code: 'await tools.sendMessage({text:"Packaged worker delivered this."})',
              },
            },
          ],
          answer: "Private response.",
        }),
    });
    const controller = new AbortController();
    const response = await fetch(url + path + "/events", {
      signal: AbortSignal.any([controller.signal, t.signal]),
    });
    assert.equal(response.status, 200);
    let buffer = "",
      delivered = false;
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
          if (
            event.kind === "message" &&
            event.data.text === "Packaged worker delivered this."
          ) {
            delivered = true;
            break;
          }
        }
        if (delivered) break;
      }
    } finally {
      controller.abort();
    }
    assert.ok(delivered, `Code Mode did not publish its message: ${errors}`);
    const history = await request(path + "/history");
    assert.ok(
      history.events.some(
        (event) =>
          event.kind === "message" &&
          event.data.text === "Packaged worker delivered this.",
      ),
    );
  },
);
