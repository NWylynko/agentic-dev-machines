#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [image, role] = process.argv.slice(2);
if (!image || !role || !["adm-control", "adm-repositories", "adm-workspace", "adm-code", "adm-bot"].includes(role))
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

// `adm claude` (TASK-90) runs Claude Code under tmux as UID 1000, not as the root that installed it.
const smokeClaudeCodeRunsAsTheWorkspaceUser = async () => {
  const { stdout } = await execute("docker", ["run", "--rm", "--user", "1000:1000", "--entrypoint", "/bin/sh", image, "-ec", "claude --version && tmux -V && test -x /usr/local/bin/adm-claude && test -x /usr/local/bin/adm-claude-mcp"]);
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
    const script = [
      // A lifecycle with no connectors: adm-claude writes Claude's MCP config from its catalog.
      `(node -e 'require("http").createServer((q, s) => s.end("[]")).listen(7433, "127.0.0.1")' &)`,
      "echo identity > /tmp/identity",
      "export ADM_LIFECYCLE_URL=http://127.0.0.1:7433 ADM_LIFECYCLE_TOKEN_FILE=/tmp/identity",
      "i=0; until node -e 'fetch(\"http://127.0.0.1:7433\").catch(() => process.exit(1))'; do i=$((i+1)); [ $i -lt 100 ]; sleep 0.1; done",
      "adm-claude boot",
      "! tmux has-session -t claude 2>/dev/null",
      "adm-claude start",
      "test -f /workspace/.adm/claude/enabled",
      `test "$(cat /workspace/.adm/claude/mcp.json | tr -d ' \\n')" = '{"mcpServers":{}}'`,
      // Claude replaces tmux's exec of it straight away; wait for it to draw.
      "i=0; until tmux capture-pane -p -t claude | grep -q .; do i=$((i+1)); [ $i -lt 100 ]; sleep 0.1; done",
      'test "$(tmux display-message -p -t claude "#{pane_current_command}")" = claude',
      'test "$(tmux show-environment -t claude CLAUDE_CONFIG_DIR)" = CLAUDE_CONFIG_DIR=/workspace/.adm/claude/config',
      "adm-claude start",
      'test "$(tmux list-sessions | wc -l)" = 1',
      "tmux kill-server",
      "adm-claude boot",
      "tmux has-session -t claude",
    ].join(" && ");
    await execute("docker", ["run", "--rm", "--user", "1000:1000", "--tmpfs", "/workspace:uid=1000,gid=1000", "-v", `${join(directory, "workspace.json")}:/run/adm/workspace.json:ro`, "--entrypoint", "/bin/sh", image, "-ec", script]);
  } finally {
    await rm(directory, { recursive: true });
  }
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

if (role === "adm-repositories") {
  await smokeImageShipsMtab();
  await run(["test -x /usr/local/bin/adm-repositories", "test -x /usr/local/bin/artifact-fs", "getent passwd 1000 >/dev/null", ...["sudo", "node", "chromium", "gh"].map(absent)].join(" && "));
  await smokeRepositoriesCatalogMount();
} else if (role === "adm-control") {
  await run(["test -x /usr/local/bin/adm", "test -x /usr/local/bin/kubectl", "test -f /opt/adm/provider-auth.mjs", "test -x /usr/bin/gh", "test -d /opt/adm/node_modules", absent("chromium"), absent("sudo")].join(" && "));
} else if (role === "adm-code") {
  await execute("docker", ["run", "--rm", image, "/usr/local/bin/adm-dev-entrypoint", "--check"]);
  await smokeWorkspaceShellLocaleAndSudo();
  await smokeClaudeCodeRunsAsTheWorkspaceUser();
  await smokeClaudeSessionSurvivesDetachAndRestart();
  await smokeBrowserMcp();
} else if (role === "adm-bot") {
  await run(["test -x /usr/local/bin/adm-dev-entrypoint", 'test "$(locale charmap)" = UTF-8', "! command -v gh >/dev/null 2>&1", "! command -v chromium >/dev/null 2>&1", "test -x /usr/bin/zsh", "test -f /opt/adm/runner.mjs"].join(" && "));
} else {
  await execute("docker", ["run", "--rm", image, "/usr/local/bin/adm-dev-entrypoint", "--check", "bot"]);
}
console.log(`${role} image smoke passed: ${image}`);
