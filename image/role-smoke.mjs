#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

if (role === "adm-repositories") {
  await smokeImageShipsMtab();
  await run(["test -x /usr/local/bin/adm-repositories", "test -x /usr/local/bin/artifact-fs", "getent passwd 1000 >/dev/null", ...["sudo", "node", "chromium", "gh"].map(absent)].join(" && "));
  await smokeRepositoriesCatalogMount();
} else if (role === "adm-control") {
  await run(["test -x /usr/local/bin/adm", "test -x /usr/local/bin/kubectl", "test -f /opt/adm/provider-auth.mjs", "test -x /usr/bin/gh", "test -d /opt/adm/node_modules", absent("chromium"), absent("sudo")].join(" && "));
} else if (role === "adm-code") {
  await execute("docker", ["run", "--rm", image, "/usr/local/bin/adm-dev-entrypoint", "--check"]);
} else if (role === "adm-bot") {
  await run(["test -x /usr/local/bin/adm-dev-entrypoint", "! command -v gh >/dev/null 2>&1", "! command -v chromium >/dev/null 2>&1", "test -x /usr/bin/zsh", "test -f /opt/adm/runner.mjs"].join(" && "));
} else {
  await execute("docker", ["run", "--rm", image, "/usr/local/bin/adm-dev-entrypoint", "--check", "bot"]);
}
console.log(`${role} image smoke passed: ${image}`);
