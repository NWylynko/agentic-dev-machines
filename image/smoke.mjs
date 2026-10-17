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
const image = process.argv[2] ?? "ghcr.io/nwylynko/agentic-dev-machines:latest";
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
      "sleep",
      "infinity",
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

async function verifyPodOwnedRuntime() {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "adm-pod-runtime-smoke-"));
  const workspaceRoot = join(runtimeRoot, "workspace");
  const repoRoot = join(workspaceRoot, "repo");
  const configPath = join(runtimeRoot, "workspace.json");
  const tokenPath = join(runtimeRoot, "token");
  const runtimeContainer = `${container}-runtime`;
  let exists = false;
  let running = false;
  try {
    await mkdir(repoRoot, { recursive: true });
    await writeFile(tokenPath, "pod-runtime-smoke-token\n", { mode: 0o600 });
    await writeFile(
      configPath,
      JSON.stringify({
        id: "image-pod-runtime",
        name: "image-pod-runtime",
        role: "coding",
        environment: "pod",
        localRoot: repoRoot,
        cwd: repoRoot,
        model: { provider: "faux", id: "faux-1" },
      }),
    );
    await docker(
      "create",
      "--name",
      runtimeContainer,
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
      `type=bind,src=${workspaceRoot},dst=/workspace`,
      "--mount",
      `type=bind,src=${configPath},dst=/run/adm/workspace.json,readonly`,
      "--mount",
      `type=bind,src=${tokenPath},dst=/var/run/secrets/kubernetes.io/serviceaccount/token,readonly`,
      image,
    );
    exists = true;
    await docker("start", runtimeContainer);
    running = true;

    const probe = String.raw`
const headers = { authorization: "Bearer pod-runtime-smoke-token", "content-type": "application/json" };
const get = async (path) => fetch("http://127.0.0.1:7432" + path, { headers });
let health;
for (let attempt = 0; attempt < 100; attempt++) {
  try { health = await get("/health"); break; }
  catch (error) {
    if (attempt === 99) throw error;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
if (!health.ok) throw new Error("workspace runtime did not become ready");
const unauthorized = await fetch("http://127.0.0.1:7432/v1/workspaces");
if (unauthorized.status !== 401) throw new Error("workspace API accepted unauthenticated access");
const status = await get("/v1/workspaces/image-pod-runtime");
if (!(await status.json()).id) throw new Error("workspace was not registered by its Pod runtime");
const input = await fetch("http://127.0.0.1:7432/v1/workspaces/image-pod-runtime/input", {
  method: "POST", headers, body: JSON.stringify({ message: "/faux " + JSON.stringify({
    calls: [{ tool: "write", args: { path: "/workspace/repo/pod-owned.txt", content: "executed inside workspace Pod" } }],
    answer: "file written",
  }), requestId: "pod-runtime-tool-write" }),
});
if (input.status !== 202) throw new Error("workspace runtime rejected tool work: " + await input.text());
for (let attempt = 0; attempt < 100; attempt++) {
  const history = await (await get("/v1/workspaces/image-pod-runtime/history?diagnostics=true")).json();
  if (history.events.some((event) => event.kind === "assistant")) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (attempt === 99) throw new Error("workspace agent did not finish its tool turn");
}
`;
    try {
      await docker("exec", runtimeContainer, "node", "--input-type=module", "-e", probe);
    } catch (error) {
      const logs = await docker("logs", runtimeContainer).catch(() => ({ stdout: "" }));
      throw new Error(`${error.message}\nworkspace runtime logs:\n${logs.stdout}`, { cause: error });
    }
    assert.equal(
      await readFile(join(repoRoot, "pod-owned.txt"), "utf8"),
      "executed inside workspace Pod",
    );

    await docker("stop", "--time", "5", runtimeContainer);
    running = false;
    await docker("start", runtimeContainer);
    running = true;
const recovery = String.raw`
let response;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    response = await fetch("http://127.0.0.1:7432/v1/workspaces/image-pod-runtime/history?diagnostics=true", {
      headers: { authorization: "Bearer pod-runtime-smoke-token" },
    });
    break;
  } catch (error) {
    if (attempt === 99) throw error;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
if (!response.ok) throw new Error("workspace history unavailable after Pod process restart");
const history = await response.json();
if (!history.events.some((event) => event.kind === "assistant")) throw new Error("workspace history did not survive process restart");
`;
    await docker("exec", runtimeContainer, "node", "--input-type=module", "-e", recovery);
  } finally {
    if (running) await docker("stop", "--time", "5", runtimeContainer);
    if (exists) await docker("rm", runtimeContainer);
    await rm(runtimeRoot, { recursive: true });
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
      "sleep",
      "infinity",
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
    image,
    "sleep",
    "infinity",
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
  assert.ok(inspection.HostConfig.SecurityOpt.includes("no-new-privileges:false"));
  assert.deepEqual(inspection.HostConfig.CapAdd, [
    "CAP_CHOWN",
    "CAP_DAC_OVERRIDE",
    "CAP_FOWNER",
    "CAP_SETGID",
    "CAP_SETUID",
  ]);
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
  const ghVersion = await docker("exec", container, "gh", "--version");
  assert.match(ghVersion.stdout, /^gh version \d+\.\d+\.\d+/m);
  const ghHelp = await docker("exec", container, "gh", "help");
  assert.match(ghHelp.stdout, /USAGE\s+gh <command>/);
  const root = await docker(
    "exec",
    container,
    "sh",
    "-c",
    "test \"$(sudo -n id -u)\" = 0 && sudo -n sh -c 'printf smoke > /etc/adm-image-smoke && test \"$(cat /etc/adm-image-smoke)\" = smoke && rm /etc/adm-image-smoke' && printf '%s\\n' 'sudo works'",
  );
  assert.equal(root.stdout.trim(), "sudo works");

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
  await verifyPodOwnedRuntime();
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
