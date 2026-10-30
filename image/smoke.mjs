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
import { verifyGitHubPushAuthentication } from "./github-auth-smoke.mjs";
import { verifyLifecycleKubeconfigProjection } from "./lifecycle-kubeconfig-smoke.mjs";

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
  const configPath = join(runtimeRoot, "workspace.json");
  const tokenPath = join(runtimeRoot, "token");
  const lifecyclePath = join(runtimeRoot, "lifecycle-fixture.mjs");
  const runtimeContainer = `${container}-runtime`;
  const runtimeVolume = `${runtimeContainer}-workspace`;
  let volumeExists = false;
  let exists = false;
  let running = false;
  try {
    await docker("volume", "create", runtimeVolume);
    volumeExists = true;
    await docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${runtimeVolume},dst=/workspace`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-eu",
      "-c",
      "mkdir -p /workspace/repo && exec /usr/local/bin/adm-init-workspace plain",
    );
    await writeFile(tokenPath, "pod-runtime-smoke-token\n", { mode: 0o444 });
    await writeFile(
      configPath,
      JSON.stringify({
        id: "image-pod-runtime",
        name: "image-pod-runtime",
        role: "coding",
        environment: "pod",
        localRoot: "/workspace/repo",
        cwd: "/workspace/repo",
        model: { provider: "faux", id: "faux-1" },
      }),
    );
    await writeFile(lifecyclePath, String.raw`
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const holder = "731db50f-237a-4f43-af54-a9d033e9c3b1";
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  if (request.headers.authorization !== "Bearer pod-runtime-smoke-token") {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "fixture identity required" } })); return;
  }
  if (request.url.endsWith("/authorize")) {
    response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return;
  }
  const initial = request.url.endsWith("/lease");
  const valid = body.holder === holder && (initial || body.fencingToken === 1);
  response.writeHead(valid ? 200 : 410, { "content-type": "application/json" });
  const lease = request.url.endsWith("/check")
    ? { valid: true }
    : { holder, fencingToken: 1, expiresAt: Math.floor(Date.now() / 1000) + 60 };
  response.end(JSON.stringify(valid ? lease : { error: { message: "stale fixture owner" } }));
});
server.listen(7433, "127.0.0.1", () => {
  const child = spawn("/usr/local/bin/adm-dev-entrypoint", [], {
    stdio: "inherit",
    env: { ...process.env, ADM_LIFECYCLE_URL: "http://127.0.0.1:7433", ADM_POD_UID: holder },
  });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  child.on("error", (error) => { console.error(error); process.exitCode = 1; server.close(); });
  child.on("exit", (code) => { process.exitCode = code ?? 1; server.close(); });
});
`);
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
      `type=volume,src=${runtimeVolume},dst=/workspace`,
      "--mount",
      `type=bind,src=${configPath},dst=/run/adm/workspace.json,readonly`,
      "--mount",
      `type=bind,src=${tokenPath},dst=/var/run/secrets/kubernetes.io/serviceaccount/token,readonly`,
      "--mount",
      `type=bind,src=${lifecyclePath},dst=/run/adm/lifecycle-fixture.mjs,readonly`,
      image,
      "node", "/run/adm/lifecycle-fixture.mjs",
    );
    exists = true;
    await docker("start", runtimeContainer);
    running = true;

    const probe = String.raw`
const headers = { authorization: "Bearer pod-runtime-smoke-token", "content-type": "application/json" };
const get = async (path) => fetch("http://127.0.0.1:7432" + path, { headers });
// /health is liveness and answers 200 while the runtime is still starting;
// /ready only answers 200 once the runtime holds its lease and serves the API.
let ready;
for (let attempt = 0; attempt < 200; attempt++) {
  try { ready = await get("/ready"); if (ready.ok) break; }
  catch (error) { if (attempt === 199) throw error; }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!ready?.ok) throw new Error("workspace runtime did not become ready: " + (ready ? ready.status + " " + await ready.text() : "unreachable"));
const unauthorized = await fetch("http://127.0.0.1:7432/v1/workspaces");
if (unauthorized.status !== 401) throw new Error("workspace API accepted unauthenticated access: " + unauthorized.status + " " + await unauthorized.text());
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
      throw new Error(`${error.message}\nworkspace runtime logs:\n${logs.stdout}${logs.stderr ?? ""}`, { cause: error });
    }
    const { stdout: podOwnedFile } = await docker(
      "exec",
      runtimeContainer,
      "cat",
      "/workspace/repo/pod-owned.txt",
    );
    assert.equal(podOwnedFile, "executed inside workspace Pod");

    await docker("stop", "--time", "5", runtimeContainer);
    running = false;
    await docker("start", runtimeContainer);
    running = true;
const recovery = String.raw`
let ready;
for (let attempt = 0; attempt < 200; attempt++) {
  try { ready = await fetch("http://127.0.0.1:7432/ready"); if (ready.ok) break; }
  catch (error) { if (attempt === 199) throw error; }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!ready?.ok) throw new Error("workspace runtime did not become ready after Pod process restart: " + (ready ? ready.status + " " + await ready.text() : "unreachable"));
const response = await fetch("http://127.0.0.1:7432/v1/workspaces/image-pod-runtime/history?diagnostics=true", {
  headers: { authorization: "Bearer pod-runtime-smoke-token" },
});
if (!response.ok) throw new Error("workspace history unavailable after Pod process restart: " + response.status + " " + await response.text());
const history = await response.json();
if (!history.events.some((event) => event.kind === "assistant")) throw new Error("workspace history did not survive process restart");
`;
    await docker("exec", runtimeContainer, "node", "--input-type=module", "-e", recovery);
  } finally {
    if (running) await docker("stop", "--time", "5", runtimeContainer);
    if (exists) await docker("rm", runtimeContainer);
    if (volumeExists) await docker("volume", "rm", runtimeVolume);
    await rm(runtimeRoot, { recursive: true });
  }
}

async function verifyZshPersistenceAndShellEntrypoints() {
  const volume = `${container}-workspace`;
  const workingDirectory = "/workspace/shell-fixture";
  const zshDirectory = "/workspace/.adm/zsh";
  const startupFile = `${zshDirectory}/.zshrc`;
  const marker = "ADM_ZSH_CUSTOM_TEST=persisted";
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  // Identity and ~/.local/bin come from the interactive startup files.
  // Do not export SHELL or PATH here: that would hide a shell that never sets them.
  const identityCheck = [
    'print -r -- "SHELL=$SHELL"',
    'print -r -- "ZSH_BIN=$(command -v zsh)"',
    'print -r -- "USER=$USER"',
    'print -r -- "LOGNAME=$LOGNAME"',
    'print -r -- "HOME=$HOME"',
    'print -r -- "LOGIN_SHELL=$(getent passwd 1000 | cut -d: -f7)"',
    'print -r -- "STARTUP=$(readlink -f ~/.zshrc)"',
    'print -r -- "ZSH=$ZSH_VERSION UID=$UID PWD=$PWD CUSTOM=$ADM_ZSH_CUSTOM_TEST INTERACTIVE=$([[ -o interactive ]] && print yes || print no) AUTO_UPDATE=$DISABLE_AUTO_UPDATE UPDATE_PROMPT=$DISABLE_UPDATE_PROMPT"',
    'print -r -- "LOCAL_BIN=$(adm-local-bin-smoke)"',
    'print -r -- "PATH_PROBE=$(adm-path-probe)"',
    'print -s ADM_ZSH_HISTORY_TOKEN',
    'fc -W "$HISTFILE"',
  ].join("; ");
  const sourceStartupFile = [
    'printf "\\nexport ADM_ZSH_CUSTOM_TEST=persisted\\n" >> "$HOME/.zshrc"',
    'source "$HOME/.zshrc"',
    'print -r -- "SOURCED=$ADM_ZSH_CUSTOM_TEST"',
    'print -r -- "STARTUP=$(readlink -f ~/.zshrc)"',
  ].join("; ");
  const prepareUserBin = [
    'home=$(getent passwd 1000 | cut -d: -f6)',
    'mkdir -p "$home/.local/bin" /tmp/adm-managed-bin',
    "printf '%s\\n' '#!/bin/sh' 'printf adm-local-bin-ok\\n' > \"$home/.local/bin/adm-local-bin-smoke\"",
    "printf '%s\\n' '#!/bin/sh' 'printf local-wins\\n' > \"$home/.local/bin/adm-path-probe\"",
    "printf '%s\\n' '#!/bin/sh' 'printf managed-wins\\n' > /tmp/adm-managed-bin/adm-path-probe",
    'chmod 755 "$home/.local/bin/adm-local-bin-smoke" "$home/.local/bin/adm-path-probe" /tmp/adm-managed-bin/adm-path-probe',
  ].join("; ");
  const openInteractiveZsh = async (entrypoint, check) => {
    const shell =
      entrypoint === "plain"
        ? `${prepareUserBin}; cd -- ${quote(workingDirectory)} && env TERM=xterm ZDOTDIR=${quote(zshDirectory)} zsh -l -i -c ${quote(check)}`
        : `${prepareUserBin}; bash -l -c ${quote(`cd -- "$1" && export PWD="$1" PATH="$2:$PATH" ADM_MANAGE_SOCKET="$3" && exec env TERM=xterm ZDOTDIR=${zshDirectory} zsh -l -i -c ${quote(check)}`)} adm-shell ${quote(workingDirectory)} /tmp/adm-managed-bin /tmp/adm-managed.sock`;
    const { stdout } = await docker(
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "--workdir",
      workingDirectory,
      "--entrypoint",
      "/usr/bin/script",
      image,
      "-qec",
      shell,
      "/dev/null",
    );
    return stdout;
  };
  const assertInteractiveZsh = async (entrypoint, { custom }) => {
    const stdout = await openInteractiveZsh(entrypoint, identityCheck);
    const shell = /^SHELL=(.*)$/m.exec(stdout)?.[1];
    const zshBin = /^ZSH_BIN=(.*)$/m.exec(stdout)?.[1];
    assert.ok(zshBin?.endsWith("/zsh"), stdout);
    assert.equal(shell, zshBin, stdout);
    assert.match(stdout, /^USER=node$/m);
    assert.match(stdout, /^LOGNAME=node$/m);
    assert.match(stdout, /^HOME=\/home\/node$/m);
    assert.match(stdout, /^LOGIN_SHELL=\/usr\/bin\/zsh$/m);
    assert.match(stdout, /^STARTUP=\/workspace\/\.adm\/zsh\/\.zshrc$/m);
    assert.match(stdout, /ZSH=\d/);
    assert.match(stdout, /UID=1000/);
    assert.match(stdout, new RegExp(`PWD=${workingDirectory.replaceAll("/", "\\/")}`));
    assert.match(stdout, custom ? /CUSTOM=persisted/ : /CUSTOM=($| )/ );
    assert.match(stdout, /INTERACTIVE=yes/);
    assert.match(stdout, /AUTO_UPDATE=true UPDATE_PROMPT=true/);
    assert.match(stdout, /LOCAL_BIN=adm-local-bin-ok/);
    assert.match(
      stdout,
      entrypoint === "managed" ? /PATH_PROBE=managed-wins/ : /PATH_PROBE=local-wins/,
    );
    return stdout;
  };

  await docker("volume", "create", volume);
  try {
    await docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "--entrypoint",
      "/usr/local/bin/adm-init-workspace",
      image,
      "plain",
    );
    await docker(
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-eu",
      "-c",
      `mkdir -p '${workingDirectory}'`,
    );

    await assertInteractiveZsh("plain", { custom: false });
    await assertInteractiveZsh("managed", { custom: false });

    // ~/.zshrc is the startup file editors and installers write. Sourcing it
    // affects this session; the next session reads the same persistent file.
    const sourced = await openInteractiveZsh("plain", sourceStartupFile);
    assert.match(sourced, /SOURCED=persisted/);
    assert.match(sourced, /^STARTUP=\/workspace\/\.adm\/zsh\/\.zshrc$/m);
    await assertInteractiveZsh("plain", { custom: true });
    await assertInteractiveZsh("managed", { custom: true });

    // A replacement Pod runs the initializer again against the same private PVC.
    await docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "--entrypoint",
      "/usr/local/bin/adm-init-workspace",
      image,
      "plain",
    );
    const { stdout: config } = await docker(
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      `cat '${startupFile}' && test -w '${zshDirectory}/.zsh_history'`,
    );
    assert.equal(
      config.split("\n").filter((line) => line === `export ${marker}`).length,
      1,
      "workspace initialization must preserve user edits instead of reseeding configuration",
    );
    await assertInteractiveZsh("plain", { custom: true });
    // Explicit commands do not become interactive shells: zsh -c keeps its own
    // environment and does not source the startup file or ~/.local/bin.
    const { stdout: explicit } = await docker(
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "--entrypoint",
      "zsh",
      image,
      "-c",
      'home=$(getent passwd 1000 | cut -d: -f6); mkdir -p "$home/.local/bin"; printf "%s\\n" "#!/bin/sh" "printf adm-local-bin-ok\\n" > "$home/.local/bin/adm-local-bin-smoke"; chmod 755 "$home/.local/bin/adm-local-bin-smoke"; if command -v adm-local-bin-smoke >/dev/null; then print -r -- "LOCAL_BIN=visible"; else print -r -- "LOCAL_BIN=hidden"; fi; print -r -- "SHELL=${SHELL-unset}"; print -r -- "CUSTOM=${ADM_ZSH_CUSTOM_TEST-unset}"',
    );
    assert.match(explicit, /LOCAL_BIN=hidden/);
    assert.match(explicit, /SHELL=unset/);
    assert.match(explicit, /CUSTOM=unset/);
    const { stdout: history } = await docker(
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      `cat '${zshDirectory}/.zsh_history'`,
    );
    assert.match(history, /ADM_ZSH_HISTORY_TOKEN/);
  } finally {
    await docker("volume", "rm", volume);
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

if (process.argv.includes("--only=zsh")) {
  try {
    await verifyZshPersistenceAndShellEntrypoints();
    process.stdout.write(`Image zsh smoke passed for ${image}\n`);
  } catch (error) {
    process.stderr.write(`Image zsh smoke failed: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

try {
  await verifyLifecycleKubeconfigProjection(image);
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
  assert.match((await docker("exec", container, "zsh", "--version")).stdout, /^zsh 5\./);
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
  await verifyGitHubPushAuthentication(image);
  await verifyZshPersistenceAndShellEntrypoints();
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
