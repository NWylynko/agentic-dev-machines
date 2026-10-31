#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [image, role] = process.argv.slice(2);
if (!image || !role || !["adm-control", "adm-repositories", "adm-workspace", "adm-code", "adm-bot"].includes(role))
  throw new Error("usage: node image/role-smoke.mjs IMAGE ROLE");
const run = async (script) => execute("docker", ["run", "--rm", "--entrypoint", "/bin/sh", image, "-ec", script], { maxBuffer: 1024 * 1024 });
const absent = (command) => `! command -v ${command} >/dev/null 2>&1`;

if (role === "adm-repositories") {
  await run(["test -x /usr/local/bin/adm-repositories", "test -x /usr/local/bin/artifact-fs", ...["sudo", "node", "chromium", "gh"].map(absent)].join(" && "));
} else if (role === "adm-control") {
  await run(["test -x /usr/local/bin/adm", "test -x /usr/local/bin/kubectl", "test -f /opt/adm/provider-auth.mjs", "test -d /opt/adm/node_modules", absent("chromium"), absent("sudo")].join(" && "));
} else if (role === "adm-code") {
  await execute("docker", ["run", "--rm", image, "/usr/local/bin/adm-dev-entrypoint", "--check"]);
} else if (role === "adm-bot") {
  await run(["test -x /usr/local/bin/adm-dev-entrypoint", "! command -v gh >/dev/null 2>&1", "! command -v chromium >/dev/null 2>&1", "test -x /usr/bin/zsh", "test -f /opt/adm/runner.mjs"].join(" && "));
} else {
  await execute("docker", ["run", "--rm", image, "/usr/local/bin/adm-dev-entrypoint", "--check", "bot"]);
}
console.log(`${role} image smoke passed: ${image}`);
