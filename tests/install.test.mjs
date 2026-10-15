import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile),
  installer = resolve("install.sh");
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "adm-install-test-")),
    home = join(directory, "home"),
    assets = new Map();
  await mkdir(home);
  const commands = join(directory, "commands");
  await mkdir(commands);
  await writeFile(join(commands, "systemctl"), "#!/bin/sh\nexit 1\n");
  await chmod(join(commands, "systemctl"), 0o755);
  const server = createServer((request, response) => {
    const value = assets.get(request.url);
    if (typeof value === "function") return value(response);
    response.writeHead(value ? 200 : 404);
    response.end(value ?? "missing fixture asset");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`,
    env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, "data"),
      PATH: `${commands}:${process.env.PATH}`,
    };
  delete env.ADM_STATE_DIR;
  async function release(name, customize = async () => {}) {
    const bundle = join(directory, name);
    for (const child of ["bin", "runtime", "node_modules"])
      await mkdir(join(bundle, child), { recursive: true });
    for (const binary of ["adm", "adm-repositories"]) {
      const path = join(bundle, "bin", binary);
      await writeFile(
        path,
        `#!/bin/sh\nif [ "\${1-}" = setup ]; then printf '%s\\n' setup >> "$HOME/setup-called"; else printf '%s\\n' '${name}'; fi\n`,
      );
      await chmod(path, 0o755);
    }
    await writeFile(join(bundle, "package.json"), '{"type":"module"}\n');
    for (const app of ["runner", "terminal"])
      await writeFile(
        join(bundle, "runtime", `${app}.mjs`),
        "export const fixture = true;\n",
      );
    await writeFile(join(bundle, "VERSION"), `${name}\n`);
    await writeFile(
      join(bundle, "IMAGE"),
      `ghcr.io/nwylynko/agentic-dev-machines:${name}\n`,
    );
    await customize(bundle);
    const archive = join(directory, `${name}.tar.gz`);
    await execute("tar", ["-czf", archive, "-C", bundle, "."]);
    const bytes = await readFile(archive),
      checksum = createHash("sha256").update(bytes).digest("hex");
    assets.set(`/${name}/adm-linux-amd64.tar.gz`, bytes);
    assets.set(`/${name}/SHA256SUMS`, `${checksum}  adm-linux-amd64.tar.gz\n`);
    return { checksum, bytes };
  }
  async function install(name, args = []) {
    try {
      return await execute(
        "sh",
        [installer, "--base-url", `${base}/${name}`, "--no-setup", ...args],
        { env },
      );
    } catch (error) {
      return error;
    }
  }
  return {
    directory,
    home,
    assets,
    env,
    base,
    release,
    install,
    command: join(home, ".local/bin/adm"),
    prefix: join(home, "data/adm/install"),
  };
}

test("a release installs without a checkout and updates preserve existing state and configuration", async (t) => {
  const f = await fixture(t);
  await f.release("v1");
  let result = await f.install("v1");
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(
    (await execute(f.command, ["--version"], { env: f.env })).stdout,
    "v1\n",
  );
  await mkdir(join(f.home, ".config/adm"), { recursive: true });
  await writeFile(join(f.home, ".config/adm/config.json"), "keep config\n");
  await writeFile(join(f.home, "data/adm/history"), "keep history\n");
  await f.release("v2");
  result = await f.install("v2");
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(
    (await execute(f.command, ["--version"], { env: f.env })).stdout,
    "v2\n",
  );
  assert.equal(
    await readFile(join(f.home, ".config/adm/config.json"), "utf8"),
    "keep config\n",
  );
  assert.equal(
    await readFile(join(f.home, "data/adm/history"), "utf8"),
    "keep history\n",
  );
  result = await f.install("v1");
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(
    (await execute(f.command, ["--version"], { env: f.env })).stdout,
    "v1\n",
  );
});

test("a bad download keeps the current release usable and rerunning an unchanged release is idempotent", async (t) => {
  const f = await fixture(t);
  await f.release("v1");
  assert.equal((await f.install("v1")).code, undefined);
  const current = await readlink(join(f.prefix, "current"));
  const helper = join(dirname(f.command), "adm-repositories");
  await rm(helper);
  assert.match((await f.install("v1")).stdout, /already up to date/);
  assert.equal(
    (await execute(helper, ["--version"], { env: f.env })).stdout,
    "v1\n",
  );
  await f.release("bad");
  f.assets.set("/bad/adm-linux-amd64.tar.gz", Buffer.from("broken download"));
  const result = await f.install("bad");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(await readlink(join(f.prefix, "current")), current);
  assert.equal(
    (await execute(f.command, ["--version"], { env: f.env })).stdout,
    "v1\n",
  );
});

test("an active user runner restarts only after the stable command points at the validated update", async (t) => {
  const f = await fixture(t),
    boundary = join(f.directory, "system"),
    log = join(f.home, "service-events");
  await mkdir(boundary);
  await writeFile(
    join(boundary, "systemctl"),
    `#!/bin/sh\nif [ "$*" = '--user is-active --quiet adm-runner.service' ]; then exit 0; fi\nif [ "$*" = '--user restart adm-runner.service' ]; then "$HOME/.local/bin/adm" --version >> "$HOME/service-events"; exit 0; fi\nexit 1\n`,
  );
  await chmod(join(boundary, "systemctl"), 0o755);
  f.env.PATH = `${boundary}:${f.env.PATH}`;
  await f.release("v1");
  assert.equal((await f.install("v1")).code, undefined);
  await f.release("v2");
  assert.equal((await f.install("v2")).code, undefined);
  assert.equal(await readFile(log, "utf8"), "v1\nv2\n");
  await f.release("bad");
  f.assets.set("/bad/adm-linux-amd64.tar.gz", Buffer.from("corrupt"));
  assert.equal((await f.install("bad")).code, 1);
  assert.equal(await readFile(log, "utf8"), "v1\nv2\n");
});

test("a staged release cannot use runtime files outside its installation", async (t) => {
  const f = await fixture(t);
  await f.release("v1");
  assert.equal((await f.install("v1")).code, undefined);
  const outside = join(f.directory, "outside.mjs");
  await writeFile(outside, "export const outside=true;\n");
  await f.release("unsafe", async (bundle) => {
    await rm(join(bundle, "runtime/runner.mjs"));
    await symlink(outside, join(bundle, "runtime/runner.mjs"));
  });
  const result = await f.install("unsafe");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /outside|unsafe/);
  assert.equal(
    (await execute(f.command, ["--version"], { env: f.env })).stdout,
    "v1\n",
  );
});

test("an update asks the operator to stop an existing standalone runner before switching", async (t) => {
  const f = await fixture(t);
  await f.release("v1");
  assert.equal((await f.install("v1")).code, undefined);
  const main = join(f.directory, "runtime/runner.mjs");
  await mkdir(dirname(main));
  await writeFile(
    main,
    "process.stdout.write('ready\\n');process.stdin.resume();\n",
  );
  const child = spawn(
    process.execPath,
    [main, "--state-dir", join(f.home, "data/adm/runner")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(async () => {
    const stopped = once(child, "exit");
    child.kill();
    await stopped;
  });
  await once(child.stdout, "data");
  await writeFile(join(f.home, "data/adm/runner.pid"), String(child.pid));
  await f.release("v2");
  const result = await f.install("v2");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /adm stop/);
  assert.equal(
    (await execute(f.command, ["--version"], { env: f.env })).stdout,
    "v1\n",
  );
  assert.equal(child.exitCode, null);
});

test("a piped installer opens first-run onboarding through the terminal and updates never repeat it", async (t) => {
  const f = await fixture(t);
  await f.release("v1");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  async function piped(name, args = "") {
    return execute(
      "script",
      [
        "--quiet",
        "--return",
        "--command",
        `cat ${quote(installer)} | sh -s -- --base-url ${quote(`${f.base}/${name}`)} ${args}`,
        "/dev/null",
      ],
      { env: f.env },
    );
  }
  await piped("v1");
  assert.equal(await readFile(join(f.home, "setup-called"), "utf8"), "setup\n");
  await f.release("v2");
  await piped("v2");
  assert.equal(await readFile(join(f.home, "setup-called"), "utf8"), "setup\n");
});

test("a failed service restart is reported after installing the validated release", async (t) => {
  const f = await fixture(t),
    boundary = join(f.directory, "system");
  await mkdir(boundary);
  await writeFile(
    join(boundary, "systemctl"),
    "#!/bin/sh\nif [ \"$*\" = '--user is-active --quiet adm-runner.service' ]; then exit 0; fi\nexit 1\n",
  );
  await chmod(join(boundary, "systemctl"), 0o755);
  f.env.PATH = `${boundary}:${f.env.PATH}`;
  await f.release("v1");
  const result = await f.install("v1");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /restart failed/);
  assert.equal(
    (await execute(f.command, ["--version"], { env: f.env })).stdout,
    "v1\n",
  );
});

test("prerequisite failures and unmanaged commands are rejected before creating an installation", async (t) => {
  const f = await fixture(t),
    boundary = join(f.directory, "prerequisites");
  await mkdir(boundary);
  f.env.PATH = `${boundary}:${f.env.PATH}`;
  await writeFile(join(boundary, "node"), "#!/bin/sh\nexit 1\n");
  await chmod(join(boundary, "node"), 0o755);
  let result = await f.install("unused");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Node.js 24/);
  await rm(join(boundary, "node"));
  await writeFile(
    join(boundary, "uname"),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo aarch64; fi\n',
  );
  await chmod(join(boundary, "uname"), 0o755);
  result = await f.install("unused");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /architecture/);
  await rm(join(boundary, "uname"));
  await mkdir(dirname(f.command), { recursive: true });
  await writeFile(f.command, "my existing command\n");
  result = await f.install("unused");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unmanaged command/);
  assert.equal(await readFile(f.command, "utf8"), "my existing command\n");
  await assert.rejects(access(f.prefix), { code: "ENOENT" });
});

test("two installers cannot update the same installation concurrently", async (t) => {
  const f = await fixture(t),
    release = await f.release("v1"),
    started = Promise.withResolvers(),
    unblock = Promise.withResolvers();
  f.assets.set("/v1/adm-linux-amd64.tar.gz", (response) => {
    started.resolve();
    unblock.promise.then(() => response.end(release.bytes));
  });
  const first = f.install("v1");
  await started.promise;
  try {
    const second = await f.install("v1");
    assert.equal(second.code, 1);
    assert.match(second.stderr, /another ADM installation/);
  } finally {
    unblock.resolve();
  }
  const result = await first;
  assert.equal(result.code, undefined, result.stderr);
  assert.equal(
    (await execute(f.command, ["--version"], { env: f.env })).stdout,
    "v1\n",
  );
});

test("an existing custom service configuration is called out during an update", async (t) => {
  const f = await fixture(t),
    boundary = join(f.directory, "custom-service");
  await mkdir(boundary);
  await writeFile(
    join(boundary, "systemctl"),
    "#!/bin/sh\ncase \"$*\" in\n'--user is-active --quiet adm-runner.service') exit 0;;\n'--user show adm-runner.service --property=ExecStart --value') echo '/old/adm --project-dir /old/checkout serve'; exit 0;;\n'--user restart adm-runner.service') exit 0;;\nesac\nexit 1\n",
  );
  await chmod(join(boundary, "systemctl"), 0o755);
  f.env.PATH = `${boundary}:${f.env.PATH}`;
  await f.release("v1");
  const result = await f.install("v1");
  assert.equal(result.code, undefined, result.stderr);
  assert.match(result.stderr, /custom ExecStart/);
});
