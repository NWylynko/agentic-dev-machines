import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const script = new URL("./adm-git-identity", import.meta.url).pathname;

async function setup(t, { loggedIn = true, user = { login: "nwylynko", id: 4242, name: "Nick Wylynko" } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "adm-git-identity-"));
  const requests = [];
  // One server stands in for the lifecycle controller and the GitHub API.
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/v1/runtime/repos/token") {
      if (request.headers.authorization !== "Bearer pod-identity") return reply(403, { error: { message: "forbidden" } });
      if (!loggedIn) return reply(409, { error: { message: "GitHub is not connected to this installation: run adm repos login github" } });
      return reply(200, { token: "gho_CLUSTERtoken", account: "nwylynko" });
    }
    if (request.url === "/github/user") return reply(200, user);
    reply(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const tokenFile = join(root, "token");
  await writeFile(tokenFile, "pod-identity\n");
  const identity = join(root, "gitconfig");
  // The image's /etc/gitconfig, and an empty global config.
  const system = join(root, "system-gitconfig");
  await writeFile(system, `[include]\n\tpath = ${identity}\n`);
  const global = join(root, "global-gitconfig");
  await writeFile(global, "");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {
    PATH: process.env.PATH,
    ADM_LIFECYCLE_URL: base,
    ADM_LIFECYCLE_TOKEN_FILE: tokenFile,
    ADM_GITHUB_API_URL: `${base}/github`,
    ADM_GIT_IDENTITY_FILE: identity,
    GIT_CONFIG_SYSTEM: system,
    GIT_CONFIG_GLOBAL: global,
  };
  const gitConfig = async (key) =>
    (await promisify(execFile)("git", ["config", "--get", key], { env, cwd: root })).stdout.trim();
  return { env, requests, identity, global, gitConfig };
}

function run(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(script, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("git commits default to the cluster GitHub login, and a global setting still wins", async (t) => {
  const { env, requests, global, gitConfig } = await setup(t);
  const result = await run(env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await gitConfig("user.name"), "Nick Wylynko");
  assert.equal(await gitConfig("user.email"), "4242+nwylynko@users.noreply.github.com");
  assert.deepEqual(requests, ["GET /v1/runtime/repos/token Bearer pod-identity", "GET /github/user Bearer gho_CLUSTERtoken"]);
  await writeFile(global, "[user]\n\tname = Someone Else\n");
  assert.equal(await gitConfig("user.name"), "Someone Else");
});

test("a workspace GH_TOKEN decides the identity, and a missing profile name falls back to the login", async (t) => {
  const { env, requests, gitConfig } = await setup(t, { user: { login: "bot-account", id: 7, name: null } });
  const result = await run({ ...env, GH_TOKEN: "ghp_WORKSPACEtoken" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await gitConfig("user.name"), "bot-account");
  assert.equal(await gitConfig("user.email"), "7+bot-account@users.noreply.github.com");
  assert.deepEqual(requests, ["GET /github/user Bearer ghp_WORKSPACEtoken"]);
});

test("a profile name with quotes and control characters stays one line", async (t) => {
  const { env, gitConfig } = await setup(t, { user: { login: "q", id: 1, name: 'A "B"\n[user]\nemail = x' } });
  assert.equal((await run(env)).code, 0);
  assert.equal(await gitConfig("user.name"), 'A "B" [user] email = x');
  assert.equal(await gitConfig("user.email"), "1+q@users.noreply.github.com");
});

test("without a GitHub login the previous identity is kept and the failure explains itself", async (t) => {
  const { env, identity } = await setup(t, { loggedIn: false });
  await writeFile(identity, "[user]\n\tname = Earlier\n");
  const result = await run(env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /run adm repos login github/);
  assert.match(result.stderr, /adm-git-identity: no GitHub login for this workspace/);
  assert.equal(await readFile(identity, "utf8"), "[user]\n\tname = Earlier\n");
});
