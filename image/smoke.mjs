#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const detail = [error.stderr?.trim(), error.stdout?.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(`${command} failed: ${detail}`, { cause: error });
  }
}

async function verifySignalForwarding() {
  const signalContainer = `${container}-signal`;
  let exists = false;
  let running = false;
  try {
    await docker(
      "create",
      "--name",
      signalContainer,
      "--network",
      "none",
      "--read-only",
      "--pids-limit",
      "8",
      image,
    );
    exists = true;
    await docker("start", signalContainer);
    running = true;

    const [{ stdout: inspectOutput }, { stdout: pid1 }] = await Promise.all([
      docker("inspect", signalContainer),
      docker("exec", signalContainer, "cat", "/proc/1/comm"),
    ]);
    const [inspection] = JSON.parse(inspectOutput);
    assert.deepEqual(inspection.Config.Entrypoint, [
      "/usr/bin/tini",
      "--",
      "/usr/local/bin/adm-dev-entrypoint",
    ]);
    assert.equal(pid1.trim(), "tini", "tini must remain PID 1");
    assert.equal(inspection.HostConfig.NetworkMode, "none");
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(
      inspection.Mounts,
      [],
      "signal test must not mount host or workspace files",
    );

    const started = performance.now();
    await docker("stop", "--timeout", "2", signalContainer);
    running = false;
    const elapsed = performance.now() - started;
    const { stdout: exitCode } = await docker(
      "inspect",
      signalContainer,
      "--format",
      "{{.State.ExitCode}}",
    );
    assert.equal(
      Number(exitCode.trim()),
      143,
      "SIGTERM must reach the workspace wait process",
    );
    assert.ok(
      elapsed < 1900,
      `SIGTERM should be forwarded before Docker's two-second kill deadline (${elapsed.toFixed(1)}ms)`,
    );
  } finally {
    if (running) {
      await docker("stop", "--timeout", "2", signalContainer).catch(() => {});
    }
    if (exists) await docker("rm", signalContainer);
  }
}

async function verifyPackageInstallation() {
  const packageRoot = await mkdtemp(join(tmpdir(), "adm-package-fixture-"));
  const { stdout: architecture } = await exec("dpkg", ["--print-architecture"]);
  await chmod(packageRoot, 0o755);
  const packageDir = join(packageRoot, "package");
  const packageBin = join(packageDir, "usr/local/bin");
  const packageName = "adm-package-smoke";
  const packageFile = join(packageRoot, "pool/main/a", `${packageName}.deb`);
  const packageContainer = `${container}-packages`;
  let exists = false;
  let running = false;
  try {
    await mkdir(join(packageDir, "DEBIAN"), { recursive: true });
    await mkdir(packageBin, { recursive: true });
    await mkdir(join(packageRoot, "empty-sources"));
    await mkdir(join(packageRoot, "pool/main/a"), { recursive: true });
    const packageIndex = join(
      packageRoot,
      `dists/stable/main/binary-${architecture.trim()}/Packages`,
    );
    await mkdir(
      join(packageRoot, `dists/stable/main/binary-${architecture.trim()}`),
      {
        recursive: true,
      },
    );
    await writeFile(
      join(packageDir, "DEBIAN/control"),
      `Package: ${packageName}\nVersion: 1.0\nArchitecture: ${architecture.trim()}\nMaintainer: ADM image smoke <smoke@example.invalid>\nDescription: local package installation smoke fixture\n`,
    );
    await writeFile(
      join(packageBin, packageName),
      "#!/bin/sh\nprintf '%s\\n' 'fixture installed'\n",
      { mode: 0o755 },
    );
    await exec("dpkg-deb", ["--build", packageDir, packageFile]);
    const packageBytes = await readFile(packageFile);
    const packageSize = (await stat(packageFile)).size;
    const md5 = createHash("md5").update(packageBytes).digest("hex");
    const sha256 = createHash("sha256").update(packageBytes).digest("hex");
    await writeFile(
      packageIndex,
      `Package: ${packageName}\nVersion: 1.0\nArchitecture: ${architecture.trim()}\nMaintainer: ADM image smoke <smoke@example.invalid>\nDescription: local package installation smoke fixture\nFilename: pool/main/a/${packageName}.deb\nSize: ${packageSize}\nMD5sum: ${md5}\nSHA256: ${sha256}\n\n`,
    );
    await writeFile(
      join(packageRoot, "adm-fixture.list"),
      "deb [trusted=yes] file:/fixture stable main\n",
    );

    await docker(
      "create",
      "--name",
      packageContainer,
      "--hostname",
      "localhost",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "SETUID",
      "--security-opt",
      "no-new-privileges:false",
      "--network",
      "none",
      "--mount",
      `type=bind,src=${packageRoot},dst=/fixture,readonly`,
      image,
    );
    exists = true;
    await docker("start", packageContainer);
    running = true;

    const { stdout: inspectOutput } = await docker("inspect", packageContainer);
    const [inspection] = JSON.parse(inspectOutput);
    assert.equal(inspection.Config.User, "1000:1000");
    assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
    assert.deepEqual(inspection.HostConfig.CapAdd, [
      "CAP_CHOWN",
      "CAP_DAC_OVERRIDE",
      "CAP_FOWNER",
      "CAP_SETGID",
      "CAP_SETUID",
    ]);
    assert.ok(
      inspection.HostConfig.SecurityOpt.includes("no-new-privileges:false"),
    );
    assert.equal(inspection.HostConfig.Privileged, false);
    assert.equal(inspection.HostConfig.NetworkMode, "none");
    assert.deepEqual(inspection.HostConfig.PortBindings ?? {}, {});
    assert.equal(inspection.Mounts.length, 1);
    assert.equal(inspection.Mounts[0].Destination, "/fixture");
    assert.equal(inspection.Mounts[0].RW, false);
    const { stdout: identity } = await docker(
      "exec",
      packageContainer,
      "sh",
      "-c",
      "id -u && id -g",
    );
    assert.equal(
      identity.trim(),
      "1000\n1000",
      "ordinary package-container commands must remain UID/GID 1000",
    );

    const install = await docker(
      "exec",
      packageContainer,
      "sh",
      "-c",
      `sudo -n sh -c 'apt_options="-o Dir::Etc::sourcelist=/fixture/adm-fixture.list -o Dir::Etc::sourceparts=/fixture/empty-sources -o APT::Get::List-Cleanup=0"; apt-get $apt_options update && apt-get $apt_options install -y --no-install-recommends adm-package-smoke'`,
    );
    assert.match(install.stdout, /Setting up adm-package-smoke/);
    const installed = await docker("exec", packageContainer, packageName);
    assert.equal(installed.stdout.trim(), "fixture installed");
  } finally {
    if (running) await docker("stop", "--time", "5", packageContainer);
    if (exists) await docker("rm", packageContainer);
    await rm(packageRoot, { recursive: true });
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

  const nano = await docker("exec", container, "nano", "--version");
  assert.match(
    nano.stdout,
    /^\s*GNU nano, version /,
    "nano should be available in every workspace image",
  );
  const denied = await docker(
    "exec",
    container,
    "sh",
    "-c",
    "if sudo -n id -u >/dev/null 2>&1; then exit 1; else echo escalation denied; fi",
  );
  assert.equal(
    denied.stdout.trim(),
    "escalation denied",
    "default profile must block sudo escalation",
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
  await verifySignalForwarding();
  await verifyPackageInstallation();
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
