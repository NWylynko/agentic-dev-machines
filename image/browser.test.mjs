import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./browser.mjs", import.meta.url);

function runBrowser(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script.pathname, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("browser automation reads a page and writes a screenshot", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>adm-preview</title><p>hello workspace</p>",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const dir = await mkdtemp(join(tmpdir(), "adm-browser-"));
  const shot = join(dir, "page.png");
  const profiles = join(dir, "profiles");
  await mkdir(profiles);
  const env = { ...process.env, TMPDIR: profiles };
  try {
    const page = await runBrowser([`http://127.0.0.1:${port}/`], env);
    assert.equal(page.code, 0, page.stderr);
    assert.match(page.stdout, /adm-preview/);
    assert.match(page.stdout, /hello workspace/);
    assert.deepEqual(await readdir(profiles), []);
    const image = await runBrowser(
      [`http://127.0.0.1:${port}/`, "--screenshot", shot],
      env,
    );
    assert.equal(image.code, 0, image.stderr);
    const bytes = await readFile(shot);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.deepEqual(await readdir(profiles), []);
  } finally {
    server.close();
    await rm(dir, { recursive: true });
  }
});

test("a terminated browser request forwards the signal and removes its profile", async () => {
  let pageRequested;
  const requested = new Promise((resolve) => {
    pageRequested = resolve;
  });
  const server = createServer(() => pageRequested());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const dir = await mkdtemp(join(tmpdir(), "adm-browser-signal-"));
  const profiles = join(dir, "profiles");
  await mkdir(profiles);
  const child = spawn(
    process.execPath,
    [script.pathname, `http://127.0.0.1:${port}/`],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, TMPDIR: profiles },
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await Promise.race([
      requested,
      new Promise((_, reject) =>
        child.once("exit", (code) =>
          reject(new Error(`Browser process exited ${code}: ${stderr}`)),
        ),
      ),
      new Promise((_, reject) => child.once("error", reject)),
    ]);
    child.kill("SIGTERM");
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) =>
        resolve([exitCode, exitSignal]),
      );
    });
    assert.equal(signal, null);
    assert.equal(code, 143);
    assert.deepEqual(await readdir(profiles), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true });
  }
});
