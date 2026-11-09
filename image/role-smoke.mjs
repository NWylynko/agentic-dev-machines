#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [image, role] = process.argv.slice(2);
if (!image || !role || !["adm-control", "adm-repositories", "adm-workspace", "adm-code", "adm-bot", "adm-dev"].includes(role))
  throw new Error("usage: node image/role-smoke.mjs IMAGE ROLE");
const run = async (script) => execute("docker", ["run", "--rm", "--entrypoint", "/bin/sh", image, "-ec", script], { maxBuffer: 1024 * 1024 });
const absent = (command) => `! command -v ${command} >/dev/null 2>&1`;

// Mount the catalog the way the workspace Pod runs the sidecar: privileged, as UID/GID 1000,
// with /dev/fuse. A non-root fusermount3 needs /etc/mtab and a passwd entry for that UID.
const smokeRepositoriesCatalogMount = async () => {
  if (!existsSync("/dev/fuse")) return console.warn("adm-repositories smoke: SKIPPED the catalog mount check, no /dev/fuse on this host");
  const name = `adm-repositories-smoke-${process.pid}`;
  const serve = "printf '{\"repositories\":[{\"owner\":\"smoke\",\"name\":\"repo\",\"remote\":\"https://github.com/smoke/repo.git\",\"ref\":\"refs/heads/main\"}]}' > /tmp/catalog.json && mkdir -p /tmp/catalog && exec /usr/local/bin/adm-repositories serve --catalog /tmp/catalog.json --state /tmp/state --git-root /tmp/git --views /tmp/views --mount /tmp/catalog --uid 1000 --gid 1000 --artifact-fs /usr/local/bin/artifact-fs";
  const container = spawn("docker", ["run", "--rm", "--name", name, "--privileged", "--user", "1000:1000", "--device", "/dev/fuse", "--entrypoint", "/bin/sh", image, "-ec", serve]);
  let output = "";
  try {
    await new Promise((resolve, reject) => {
      const read = (chunk) => {
        output += chunk;
        if (output.includes("repository catalog ready")) resolve();
      };
      container.stdout.on("data", read);
      container.stderr.on("data", read);
      container.on("exit", (code) => reject(new Error(`adm-repositories serve exited with ${code} before mounting the catalog:\n${output}`)));
    });
    const { stdout } = await execute("docker", ["exec", name, "ls", "/tmp/catalog/smoke"]);
    if (stdout.trim() !== "repo") throw new Error(`catalog mount lists ${JSON.stringify(stdout)}, expected smoke/repo`);
  } finally {
    await execute("docker", ["rm", "-f", name]).catch(() => {});
  }
};

// Docker adds /etc/mtab when it creates a container but containerd (k3s) does not, so check the image's own layers.
const smokeImageShipsMtab = async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-image-layers-"));
  try {
    await execute("sh", ["-ec", 'docker save "$1" | tar -x -C "$2"', "sh", image, directory]);
    const [{ Layers }] = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    for (const layer of Layers) {
      const { stdout } = await execute("tar", ["-tf", join(directory, layer)], { maxBuffer: 64 * 1024 * 1024 });
      if (stdout.split("\n").includes("etc/mtab")) return;
    }
    throw new Error(`${image} has no /etc/mtab; fusermount3 cannot mount the catalog under containerd`);
  } finally {
    await rm(directory, { recursive: true });
  }
};

// Run as the workspace Pod does (src/workspaces.rs workspace_security_context): UID 1000, all
// capabilities dropped but these. Without AUDIT_WRITE sudo prints "unable to send audit message".
const workspaceCapabilities = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID", "AUDIT_WRITE"];
const smokeWorkspaceShellLocaleAndSudo = async () => {
  const { stdout, stderr } = await execute("docker", ["run", "--rm", "--user", "1000:1000", "--cap-drop", "ALL", ...workspaceCapabilities.flatMap((capability) => ["--cap-add", capability]), "--security-opt", "no-new-privileges:false", "--entrypoint", "/bin/sh", image, "-ec", "locale charmap && sudo -n true"]);
  if (stdout.trim() !== "UTF-8") throw new Error(`workspace shells use charmap ${JSON.stringify(stdout.trim())}, expected UTF-8`);
  if (stderr !== "") throw new Error(`sudo printed warnings in a workspace container: ${stderr}`);
};

// Coding workspaces drive their Docker engine Pod through DOCKER_HOST, a socket on the work
// volume; here the host daemon's socket stands in for it. The CLI runs as UID 1000.
const smokeDockerCliDrivesTheEngine = async () => {
  const socket = "/var/run/docker.sock";
  if (!existsSync(socket)) return console.warn("adm-code smoke: SKIPPED the Docker CLI check, no Docker socket on this host");
  const { stdout } = await execute("docker", ["run", "--rm", "--user", `1000:${(await execute("stat", ["-c", "%g", socket])).stdout.trim()}`, "--mount", `type=bind,src=${socket},dst=/workspace/.adm/docker/docker.sock`, "-e", "DOCKER_HOST=unix:///workspace/.adm/docker/docker.sock", "--entrypoint", "/bin/sh", image, "-ec", "docker version --format 'server {{.Server.Version}}' && docker compose version && docker buildx version"]);
  for (const expected of [/^server \d/m, /Docker Compose version v\d/, /github.com\/docker\/buildx v0/]) if (!expected.test(stdout)) throw new Error(`Docker CLI as UID 1000 printed ${JSON.stringify(stdout)}, expected ${expected}`);
};

// The engine stores image layers under /workspace/.adm/docker with its rootless subordinate
// UIDs; the initializer runs on every Pod start and must not reset their ownership.
const smokeInitLeavesDockerDataAlone = async () => {
  const volume = `adm-code-init-${process.pid}`;
  const onVolume = (user, script) => execute("docker", ["run", "--rm", "--network", "none", "--user", user, "--mount", `type=volume,src=${volume},dst=/workspace`, "--entrypoint", "/bin/sh", image, "-ec", script]);
  await execute("docker", ["volume", "create", volume]);
  try {
    await onVolume("0", "mkdir -p /workspace/.adm/docker/data/layer /workspace/project && touch /workspace/.adm/docker/data/layer/file /workspace/project/file && chown 1000:1000 /workspace/.adm/docker && chown -R 2070:2070 /workspace/.adm/docker/data && chown 5000:5000 /workspace/project/file");
    await onVolume("0", "/usr/local/bin/adm-init-workspace plain");
    const { stdout } = await onVolume("0", "stat -c '%n %u:%g' /workspace/.adm/docker /workspace/.adm/docker/data/layer/file /workspace/project/file");
    const expected = "/workspace/.adm/docker 1000:1000\n/workspace/.adm/docker/data/layer/file 2070:2070\n/workspace/project/file 1000:1000\n";
    if (stdout !== expected) throw new Error(`after adm-init-workspace:\n${stdout}expected:\n${expected}`);
  } finally {
    await execute("docker", ["volume", "rm", "-f", volume]).catch(() => {});
  }
};

// `adm claude` (TASK-90) runs Claude Code under tmux as UID 1000, not as the root that installed it.
const smokeClaudeCodeRunsAsTheWorkspaceUser = async () => {
  const { stdout } = await execute("docker", ["run", "--rm", "--user", "1000:1000", "--entrypoint", "/bin/sh", image, "-ec", "claude --version && tmux -V && test -x /usr/local/bin/adm-claude && test -x /usr/local/bin/adm-claude-mcp && test -x /usr/local/bin/adm-claude-credentials"]);
  if (!/\(Claude Code\)/.test(stdout)) throw new Error(`claude --version as UID 1000 printed ${JSON.stringify(stdout)}`);
  if (!/^tmux \d/m.test(stdout)) throw new Error(`tmux -V printed ${JSON.stringify(stdout)}`);
};

// The session outlives its client and comes back on the next container start
// (kill-server stands in for the Pod restart; /workspace is the kept volume).
const smokeClaudeSessionSurvivesDetachAndRestart = async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-claude-smoke-"));
  try {
    await writeFile(join(directory, "workspace.json"), JSON.stringify({ id: "smoke", name: "claude-smoke", cwd: "/workspace" }));
    await chmod(join(directory, "workspace.json"), 0o644);
    // A lifecycle with no connectors and a shared Claude login (`adm login claude`).
    await writeFile(join(directory, "lifecycle.mjs"), `
      import { createServer } from "node:http";
      createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/runtime/claude/credentials")
          return response.end(JSON.stringify({ accessToken: "smoke-access", expiresAt: Date.now() + 3600000, scopes: ["user:inference", "user:sessions:claude_code"], subscriptionType: "max", oauthAccount: { accountUuid: "smoke-account", organizationUuid: "smoke-organization" } }));
        response.end("[]");
      }).listen(7433, "127.0.0.1");
    `);
    await chmod(join(directory, "lifecycle.mjs"), 0o644);
    const script = [
      "(node /run/adm-smoke/lifecycle.mjs &)",
      "echo identity > /tmp/identity",
      "export ADM_LIFECYCLE_URL=http://127.0.0.1:7433 ADM_LIFECYCLE_TOKEN_FILE=/tmp/identity",
      "i=0; until node -e 'fetch(\"http://127.0.0.1:7433\").catch(() => process.exit(1))'; do i=$((i+1)); [ $i -lt 100 ] || exit 1; sleep 0.1; done",
      "adm-claude boot",
      "! tmux has-session -t =claude 2>/dev/null",
      "adm-claude start",
      "test -f /workspace/.adm/claude/enabled",
      `test "$(cat /workspace/.adm/claude/mcp.json | tr -d ' \\n')" = '{"mcpServers":{}}'`,
      // Signed in from the installation login before Claude starts, without a refresh token.
      `node -e 'const c = require("/workspace/.adm/claude/config/.credentials.json").claudeAiOauth; if (c.accessToken !== "smoke-access" || c.refreshToken !== null) process.exit(1)'`,
      `node -e 'if (require("/workspace/.adm/claude/config/.claude.json").oauthAccount.organizationUuid !== "smoke-organization") process.exit(1)'`,
      "tmux has-session -t claude-credentials",
      // Claude replaces tmux's exec of it straight away; wait for it to draw.
      "i=0; until tmux capture-pane -p -t claude | grep -q .; do i=$((i+1)); [ $i -lt 100 ] || exit 1; sleep 0.1; done",
      'test "$(tmux display-message -p -t claude "#{pane_current_command}")" = claude',
      'test "$(tmux show-environment -t claude CLAUDE_CONFIG_DIR)" = CLAUDE_CONFIG_DIR=/workspace/.adm/claude/config',
      "adm-claude start",
      'test "$(tmux list-sessions | wc -l)" = 2',
      "tmux kill-server",
      "adm-claude boot",
      "tmux has-session -t =claude",
      "tmux has-session -t claude-credentials",
    ].join(" && ");
    await execute("docker", ["run", "--rm", "--user", "1000:1000", "--tmpfs", "/workspace:uid=1000,gid=1000", "-v", `${join(directory, "workspace.json")}:/run/adm/workspace.json:ro`, "-v", `${join(directory, "lifecycle.mjs")}:/run/adm-smoke/lifecycle.mjs:ro`, "--entrypoint", "/bin/sh", image, "-ec", script]);
  } finally {
    await rm(directory, { recursive: true });
  }
};

// fnm keeps the Node versions a project asks for on the work volume, so they survive a Pod
// restart (a second container on the same volume stands in for it). Interactive zsh switches to
// a repo's .node-version on cd. Non-interactive shells, like the runner, always use the image's
// Node, and so do interactive ones until a version is installed (fnm then defaults to the first).
const smokeFnmSwitchesNodePerProject = async () => {
  const volume = `adm-fnm-${process.pid}`;
  const onVolume = async (script) => (await execute("docker", ["run", "--rm", "--user", "1000:1000", "--mount", `type=volume,src=${volume},dst=/workspace`, "--entrypoint", "/bin/sh", image, "-ec", script], { maxBuffer: 1024 * 1024 })).stdout.trim();
  await execute("docker", ["volume", "create", volume]);
  try {
    await execute("docker", ["run", "--rm", "--mount", `type=volume,src=${volume},dst=/workspace`, "--entrypoint", "/usr/local/bin/adm-init-workspace", image, "plain"]);
    const own = `v${await onVolume('echo "$ADM_NODE_VERSION"')}`;
    const fresh = await onVolume("zsh -ic 'node --version' 2>/dev/null");
    await onVolume("mkdir -p /workspace/project && echo 22 > /workspace/project/.node-version && fnm install 22 >/dev/null 2>&1");
    const [startedIn, cdInto, nonInteractive, claude] = (await onVolume([
      "cd /workspace/project && zsh -ic 'node --version' 2>/dev/null",
      "zsh -ic 'cd /workspace/project && node --version' 2>/dev/null",
      "cd /workspace/project && node --version",
      "cd /workspace/project && zsh -ic 'claude --version' 2>/dev/null | grep -c 'Claude Code'",
    ].join(" && "))).split("\n");
    if (fresh !== own || nonInteractive !== own || !/^v22\./.test(startedIn) || !/^v22\./.test(cdInto) || claude !== "1")
      throw new Error(`fnm: before any install ${fresh}, started in project ${startedIn}, cd into project ${cdInto}, non-interactive ${nonInteractive}, claude ${claude}; image Node ${own}`);
  } finally {
    await execute("docker", ["volume", "rm", "-f", volume]).catch(() => {});
  }
};

// `adm shell` (TASK-106) runs this tool as UID 1000 for every interactive shell; without
// it or dtach the client tells the user to run `adm update --workspace`.
const smokeShellSessionTool = async () => {
  const { stdout } = await execute("docker", ["run", "--rm", "--user", "1000:1000", "--entrypoint", "/bin/sh", image, "-ec", "command -v dtach >/dev/null && adm-shell-session list"]);
  if (stdout.trim() !== "No live shell sessions.") throw new Error(`adm-shell-session list printed ${JSON.stringify(stdout)}`);
};

// The bundled Playwright MCP, as the runner starts it (packages/runner/src/browser.ts): over stdio as
// UID 1000 with the Pod's dropped capabilities, driving system chromium to a data: page.
const smokeBrowserMcp = async () => {
  const script = `
    import { McpClient, StdioTransport, toLlmContent } from "/opt/adm/node_modules/@earendil-works/pi-mcp/dist/index.js";
    const client = new McpClient({ name: "smoke", version: "1" });
    await client.connect(new StdioTransport({ command: process.execPath, args: ["/opt/adm/node_modules/@playwright/mcp/cli.js", "--headless", "--isolated", "--no-sandbox", "--executable-path", "/usr/bin/chromium", "--output-dir", "/tmp/browser"] }));
    const names = (await client.listTools()).map((tool) => tool.name);
    if (!names.includes("browser_navigate")) throw new Error("no browser_navigate in " + names);
    const result = await client.callTool("browser_navigate", { url: "data:text/html,<title>adm-smoke-title</title>" });
    const text = toLlmContent(result);
    await client.close();
    if (!JSON.stringify(text).includes("adm-smoke-title")) throw new Error("navigate returned " + JSON.stringify(text));
  `;
  await execute("docker", ["run", "--rm", "--user", "1000:1000", "--cap-drop", "ALL", ...workspaceCapabilities.flatMap((capability) => ["--cap-add", capability]), "-e", "HOME=/tmp", "--entrypoint", "node", image, "--input-type=module", "-e", script], { maxBuffer: 1024 * 1024 });
};

// adm-dev (a coding workspace for working on ADM itself) builds Rust and Go as UID 1000, with the
// cargo registry and Go module caches on the work volume so a restarted Pod does not refetch them.
const smokeDevToolchainsBuildOnTheVolume = async () => {
  const volume = `adm-dev-${process.pid}`;
  const onVolume = (user, script) => execute("docker", ["run", "--rm", "--user", user, "--mount", `type=volume,src=${volume},dst=/workspace`, "--entrypoint", "/bin/sh", image, "-ec", script], { maxBuffer: 4 * 1024 * 1024 });
  await execute("docker", ["volume", "create", volume]);
  try {
    await onVolume("0", "/usr/local/bin/adm-init-workspace plain");
    await onVolume("1000:1000", [
      "cargo clippy --version >/dev/null && cargo fmt --version >/dev/null && kubectl version --client >/dev/null",
      "cd /workspace && cargo new -q hello && cd hello && cargo build -q && ./target/debug/hello | grep -q 'Hello, world!'",
      "mkdir /workspace/gohello && cd /workspace/gohello && go mod init example.com/gohello >/dev/null 2>&1 && printf 'package main\\nfunc main() { println(\"go ok\") }\\n' > main.go && go build && ./gohello 2>&1 | grep -q 'go ok'",
      'test "$(go env GOPATH)" = /workspace/.adm/go && test "$CARGO_HOME" = /workspace/.adm/cargo && test -d /workspace/.adm/go/pkg && test -d /workspace/.adm/cargo',
    ].join(" && "));
  } finally {
    await execute("docker", ["volume", "rm", "-f", volume]).catch(() => {});
  }
};

if (role === "adm-dev") {
  await execute("docker", ["run", "--rm", image, "/usr/local/bin/adm-dev-entrypoint", "--check"]);
  await smokeDevToolchainsBuildOnTheVolume();
} else if (role === "adm-repositories") {
  await smokeImageShipsMtab();
  await run(["test -x /usr/local/bin/adm-repositories", "test -x /usr/local/bin/artifact-fs", "getent passwd 1000 >/dev/null", ...["sudo", "node", "chromium", "gh"].map(absent)].join(" && "));
  await smokeRepositoriesCatalogMount();
} else if (role === "adm-control") {
  await run(["test -x /usr/local/bin/adm", "test -x /usr/local/bin/kubectl", "test -f /opt/adm/provider-auth.mjs", "test -x /usr/bin/gh", "test -d /opt/adm/node_modules", absent("chromium"), absent("sudo")].join(" && "));
} else if (role === "adm-code") {
  await execute("docker", ["run", "--rm", image, "/usr/local/bin/adm-dev-entrypoint", "--check"]);
  // The fsmonitor hook ArtifactFS writes into each shared git dir execs this path.
  await run(["test -x /usr/local/bin/artifact-fs", "/usr/local/bin/artifact-fs --help >/dev/null"].join(" && "));
  // The everyday build tools the node:bookworm base used to bring; npm needs python3, make and g++ for native modules.
  await run(["curl", "make", "gcc", "g++", "python3", "pkg-config", "ssh", "unzip", "xz", "bzip2", "file", "patch", "gpg"].map((command) => `command -v ${command} >/dev/null`).join(" && "));
  await smokeWorkspaceShellLocaleAndSudo();
  await smokeShellSessionTool();
  await smokeClaudeCodeRunsAsTheWorkspaceUser();
  await smokeClaudeSessionSurvivesDetachAndRestart();
  await smokeBrowserMcp();
  await smokeFnmSwitchesNodePerProject();
  await smokeDockerCliDrivesTheEngine();
  await smokeInitLeavesDockerDataAlone();
} else if (role === "adm-bot") {
  await run(["test -x /usr/local/bin/adm-dev-entrypoint", 'test "$(locale charmap)" = UTF-8', "! command -v gh >/dev/null 2>&1", "! command -v chromium >/dev/null 2>&1", "test -x /usr/bin/zsh", "test -f /opt/adm/runner.mjs", 'test "$(node --version)" = "v$ADM_NODE_VERSION"', "fnm --version >/dev/null"].join(" && "));
} else {
  await execute("docker", ["run", "--rm", image, "/usr/local/bin/adm-dev-entrypoint", "--check", "bot"]);
}
console.log(`${role} image smoke passed: ${image}`);
