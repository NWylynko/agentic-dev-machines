#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const image = process.argv[2] ?? "adm-dev:0.1.0";
const container = `adm-image-smoke-${process.pid}`;
let created = false;
let failure;

async function docker(...args) {
  try {
    return await exec("docker", args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const command = args.slice(0, 3).join(" ");
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`${command} failed: ${detail}`, { cause: error });
  }
}

const browserFixture = String.raw`
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const marker = "adm-image-browser-smoke";
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>" + marker + "</title><p>" + marker + "</p>");
});
const profileRoot = await mkdtemp(join(tmpdir(), "adm-browser-profiles-"));
const screenshot = join(tmpdir(), "adm-image-browser-smoke.png");
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = "http://127.0.0.1:" + address.port + "/";
  const runBrowser = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["/opt/adm/browser.mjs", ...args], {
      env: { ...process.env, TMPDIR: profileRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  const page = await runBrowser(url);
  assert.equal(page.code, 0, page.stderr);
  assert.match(page.stdout, new RegExp(marker));
  assert.deepEqual(await readdir(profileRoot), []);

  const image = await runBrowser(url, "--screenshot", screenshot);
  assert.equal(image.code, 0, image.stderr);
  assert.equal((await readFile(screenshot)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual(await readdir(profileRoot), []);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profileRoot, { recursive: true });
  await rm(screenshot).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
`;

try {
  await docker(
    "create",
    "--name",
    container,
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    "none",
    image,
  );
  created = true;
  await docker("start", container);

  const [{ stdout: inspectOutput }, { stdout: identity }] = await Promise.all([
    docker("inspect", container),
    docker("exec", container, "sh", "-c", "id -u && id -g"),
  ]);
  const [inspection] = JSON.parse(inspectOutput);
  assert.equal(
    identity.trim(),
    "1000\n1000",
    "container must run as uid/gid 1000",
  );
  assert.equal(inspection.Config.User, "1000:1000");
  assert.equal(inspection.HostConfig.NetworkMode, "none");
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.ok(inspection.HostConfig.SecurityOpt.includes("no-new-privileges"));
  assert.deepEqual(
    inspection.Mounts,
    [],
    "smoke container must have no host or volume mounts",
  );
  assert.deepEqual(
    inspection.HostConfig.PortBindings ?? {},
    {},
    "smoke container must publish no ports",
  );

  await docker(
    "exec",
    container,
    "/usr/local/bin/adm-dev-entrypoint",
    "--check",
  );
  const git = await docker(
    "exec",
    container,
    "sh",
    "-c",
    "set -eu; git init -q --initial-branch=main /tmp/adm-image-smoke-git; cd /tmp/adm-image-smoke-git; git config user.name 'Image Smoke'; git config user.email smoke@example.invalid; printf 'smoke\\n' > README.md; git add README.md; git commit -qm 'image smoke'; test \"$(git status --porcelain)\" = ''; test \"$(git log -1 --format=%s)\" = 'image smoke'; test \"$(cat README.md)\" = smoke",
  );
  assert.equal(git.stderr, "");
  await docker(
    "exec",
    container,
    "node",
    "--input-type=module",
    "-e",
    browserFixture,
  );
  process.stdout.write(`Image smoke passed for ${image} in ${container}\n`);
} catch (error) {
  failure = error;
} finally {
  if (created) {
    try {
      await docker("stop", "--time", "5", container);
      await docker("rm", container);
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            "Smoke test and container cleanup both failed",
          )
        : error;
    }
  }
}

if (failure) {
  process.stderr.write(`Image smoke failed: ${failure.stack ?? failure}\n`);
  process.exitCode = 1;
}
