import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const helper = new URL("./adm-git-credential", import.meta.url).pathname;
const ghWrapper = new URL("./adm-gh", import.meta.url).pathname;

async function setup(t, { loggedIn = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "adm-github-credential-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== "Bearer pod-identity")
      return reply(403, { error: { message: "forbidden" } });
    if (request.url === "/v1/runtime/repos/rejected") return reply(200, {});
    if (!loggedIn)
      return reply(409, {
        error: { message: "GitHub is not connected to this installation: run adm repos login github" },
      });
    reply(200, { token: "gho_CLUSTERtoken", account: "nwylynko" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const tokenFile = join(root, "token");
  await writeFile(tokenFile, "pod-identity\n");
  // A stand-in for the real gh: reports which token it was given, and in
  // which place, so the test can prove it came by environment only.
  const fakeGh = join(root, "gh");
  await writeFile(fakeGh, '#!/bin/sh\necho "gh $* with token ${GH_TOKEN:-none}"\n');
  await chmod(fakeGh, 0o755);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true });
  });
  const env = {
    PATH: process.env.PATH,
    ADM_LIFECYCLE_URL: `http://127.0.0.1:${server.address().port}`,
    ADM_LIFECYCLE_TOKEN_FILE: tokenFile,
    ADM_REAL_GH: fakeGh,
  };
  return { env, requests };
}

function run(command, args, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    // gh exits without reading stdin; a child that is already gone when Node writes is not a failure.
    child.stdin.on("error", (error) => error.code === "EPIPE" || reject(error));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const request = "protocol=https\nhost=github.com\n\n";

test("git and gh get the cluster GitHub login without any workspace Secret", async (t) => {
  const { env, requests } = await setup(t);
  const git = await run(helper, ["get"], env, request);
  assert.equal(git.code, 0, git.stderr);
  assert.match(git.stdout, /^password=gho_CLUSTERtoken$/m);
  assert.match(git.stdout, /^host=github\.com$/m);
  const gh = await run(ghWrapper, ["auth", "status"], env);
  assert.equal(gh.code, 0, gh.stderr);
  assert.equal(gh.stdout.trim(), "gh auth status with token gho_CLUSTERtoken");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((line) => line.endsWith("Bearer pod-identity")));
});

test("a workspace GH_TOKEN Secret overrides the cluster login", async (t) => {
  const { env, requests } = await setup(t);
  const withSecret = { ...env, GH_TOKEN: "ghp_NARROWsecret" };
  const git = await run(helper, ["get"], withSecret, request);
  assert.equal(git.code, 0, git.stderr);
  assert.match(git.stdout, /^password=ghp_NARROWsecret$/m);
  const gh = await run(ghWrapper, ["auth", "status"], withSecret);
  assert.equal(gh.stdout.trim(), "gh auth status with token ghp_NARROWsecret");
  assert.deepEqual(requests, []);
});

test("a missing cluster login fails loudly and names the command, for git and gh", async (t) => {
  const { env } = await setup(t, { loggedIn: false });
  const git = await run(helper, ["get"], env, request);
  assert.notEqual(git.code, 0);
  assert.match(git.stderr, /run adm repos login github/);
  assert.equal(git.stdout, "");
  const gh = await run(ghWrapper, ["auth", "status"], env);
  assert.match(gh.stderr, /run adm repos login github/);
  assert.equal(gh.stdout.trim(), "gh auth status with token none");
});

test("git credentials are only offered to https github.com, and a rejection is reported without the token", async (t) => {
  const { env, requests } = await setup(t);
  for (const other of [
    "protocol=https\nhost=example.invalid\n\n",
    "protocol=https\nhost=github.com:8443\n\n",
    "protocol=http\nhost=github.com\n\n",
  ]) {
    const result = await run(helper, ["get"], env, other);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(requests, []);
  const erased = await run(helper, ["erase"], env, `${request}password=gho_CLUSTERtoken\n`);
  assert.equal(erased.code, 0);
  assert.match(erased.stderr, /run adm repos login github/);
  assert.match(erased.stderr, /GH_TOKEN Secret.*repository write permission/);
  assert.deepEqual(requests, ["POST /v1/runtime/repos/rejected Bearer pod-identity"]);
  assert.equal(`${erased.stdout}${erased.stderr}`.includes("gho_CLUSTERtoken"), false);
});
