import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderAuthAuthority } from "../src/provider-auth-authority.ts";

const admBinary =
  process.env.ADM_BIN ??
  join(
    process.env.CARGO_TARGET_DIR ??
      new URL("../../../target", import.meta.url).pathname,
    "debug",
    "adm",
  );

// A stand-in for `gh` that behaves like the real one in a non-interactive
// terminal: `auth login --web` prints the device code and URL on stderr, then
// stores the token in $GH_CONFIG_DIR/hosts.yml. It refuses to run when the
// authority leaks a GH_TOKEN into it, and records every argv.
const FAKE_GH = `#!/bin/sh
FAKE_GH_DIR=$(dirname "$0")
echo "$*" >> "$FAKE_GH_DIR/argv.log"
case "$1 $2" in
  "auth login")
    [ -n "$GH_CONFIG_DIR" ] || { echo "fake gh: GH_CONFIG_DIR missing" >&2; exit 9; }
    [ -z "$GH_TOKEN" ] || { echo "fake gh: GH_TOKEN leaked into login" >&2; exit 9; }
    echo "$GH_CONFIG_DIR" > "$FAKE_GH_DIR/config-dir"
    [ ! -f "$FAKE_GH_DIR/deny-login" ] || { echo "fake gh: authorization_pending timed out" >&2; exit 1; }
    . "$FAKE_GH_DIR/next-login"
    echo "! First copy your one-time code: $CODE" >&2
    echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
    mkdir -p "$GH_CONFIG_DIR"
    printf 'github.com:\\n    oauth_token: %s\\n    user: %s\\n' "$TOKEN" "$ACCOUNT" > "$GH_CONFIG_DIR/hosts.yml"
    echo "✓ Logged in as $ACCOUNT" >&2
    ;;
  "auth token")
    sed -n 's/^    oauth_token: //p' "$GH_CONFIG_DIR/hosts.yml"
    ;;
  "api user")
    [ -n "$GH_TOKEN" ] || { echo "fake gh: no token" >&2; exit 4; }
    sed -n 's/^    user: //p' "$GH_CONFIG_DIR/hosts.yml"
    ;;
  "api --paginate")
    printf '1\\n2\\n3\\n'
    ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
`;

test(
  "adm repos login stores the GitHub token in the authority state, never leaks it, and logout removes it",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-github-login-"));
    const fakeDir = join(directory, "fake-gh");
    await mkdir(fakeDir, { recursive: true });
    await writeFile(join(fakeDir, "gh"), FAKE_GH, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${previousPath}`;
    const logs = [];
    const authority = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
      log: (line) => logs.push(line),
    });
    await new Promise((resolve) =>
      authority.server.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      process.env.PATH = previousPath;
      await authority.close();
      await rm(directory, { recursive: true });
    });
    const authorityUrl = `http://127.0.0.1:${authority.server.address().port}`;
    const tokenFile = join(directory, "lifecycle-token");
    await writeFile(tokenFile, "operator-lifecycle-token\n", { mode: 0o600 });
    const adm = async (args, { allowFailure = false } = {}) => {
      const child = spawn(
        admBinary,
        [
          ...args,
          "--lifecycle-url",
          authorityUrl,
          "--lifecycle-token-file",
          tokenFile,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, "client", "config"),
            XDG_STATE_HOME: join(directory, "client", "state"),
            XDG_DATA_HOME: join(directory, "client", "data"),
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const [code] = await once(child, "exit");
      if (!allowFailure)
        assert.equal(code, 0, `adm ${args.join(" ")}: ${stdout}${stderr}`);
      return { code, stdout, stderr };
    };
    const login = (token, account, code) =>
      writeFile(
        join(fakeDir, "next-login"),
        `TOKEN=${token}\nACCOUNT=${account}\nCODE=${code}\n`,
      );
    const tokenRoute = () => fetch(`${authorityUrl}/v1/runtime/repos/token`);
    const stateFile = join(directory, "authority", "github.json");

    // Not logged in: status says so, and the token route tells the caller what to run.
    const before = await adm(["repos", "status"]);
    assert.match(before.stdout, /GitHub: not logged in.*adm repos login github/);
    const missing = await tokenRoute();
    assert.equal(missing.status, 409);
    assert.match((await missing.json()).error.message, /adm repos login github/);
    assert.ok(
      logs.some((line) => line.includes("github_token_unavailable")),
      logs.join("\n"),
    );

    await login("gho_FIRSTsecret0001", "nwylynko", "WXYZ-1234");
    const first = await adm(["repos", "login", "github"]);
    assert.match(
      first.stdout,
      /Open https:\/\/github\.com\/login\/device and enter WXYZ-1234/,
    );
    assert.match(first.stdout, /GitHub connected as nwylynko: 3 repositories available/);
    const stored = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(stored.token, "gho_FIRSTsecret0001");
    assert.equal(stored.account, "nwylynko");
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    const served = await (await tokenRoute()).json();
    assert.equal(served.token, "gho_FIRSTsecret0001");
    assert.equal(served.account, "nwylynko");
    // The temporary gh config directory (which held the token) is gone.
    const configDir = (await readFile(join(fakeDir, "config-dir"), "utf8")).trim();
    await assert.rejects(stat(configDir));
    const status = await adm(["repos", "status"]);
    assert.match(status.stdout, /GitHub: connected as nwylynko/);

    // A second login replaces the first.
    await login("gho_SECONDsecret0002", "other-account", "ABCD-5678");
    const second = await adm(["repos", "login", "github"]);
    assert.match(second.stdout, /enter ABCD-5678/);
    assert.match(second.stdout, /connected as other-account/);
    assert.equal(
      (await (await tokenRoute()).json()).token,
      "gho_SECONDsecret0002",
    );

    // A login that fails leaves the existing connection alone and says why.
    await writeFile(join(fakeDir, "deny-login"), "");
    const denied = await adm(["repos", "login", "github"], {
      allowFailure: true,
    });
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /GitHub login failed/);
    await rm(join(fakeDir, "deny-login"));
    assert.equal(
      (await (await tokenRoute()).json()).token,
      "gho_SECONDsecret0002",
    );

    const out = await adm(["repos", "logout", "github"]);
    assert.match(out.stdout, /Logged out of GitHub/);
    await assert.rejects(stat(stateFile));
    assert.equal((await tokenRoute()).status, 409);

    // Operator routes exist for github only.
    const other = await adm(["repos", "login", "gitlab"], { allowFailure: true });
    assert.notEqual(other.code, 0);

    // Logs record login and logout without any token; argv never carries one.
    const everything = [
      ...logs,
      await readFile(join(fakeDir, "argv.log"), "utf8"),
      first.stdout,
      first.stderr,
      second.stdout,
      second.stderr,
      denied.stderr,
    ].join("\n");
    assert.equal(everything.includes("gho_FIRSTsecret0001"), false);
    assert.equal(everything.includes("gho_SECONDsecret0002"), false);
    for (const event of [
      "github_login_started",
      "github_login_succeeded",
      "github_login_failed",
      "github_logout",
    ])
      assert.ok(
        logs.some((line) => line.includes(event)),
        `${event} missing from: ${logs.join("\n")}`,
      );
    assert.deepEqual(await readdir(join(directory, "authority")).then((names) => names.filter((name) => name.startsWith("gh-"))), []);
  },
);

test(
  "repository registration check reaches GitHub with the cluster login, names the canonical repo, and explains what it cannot reach",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-github-check-"));
    const seen = [];
    // A GitHub API stand-in: `Example/Project` is public, `example/secret` is
    // private (404 without the cluster token, exactly like github.com).
    const github = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      const reply = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const authorized = request.headers.authorization === "Bearer gho_CHECKsecret0001";
      const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/branches\/(.+))?$/.exec(request.url);
      if (!match) return reply(404, { message: "Not Found" });
      const [, owner, name, branch] = match;
      const key = `${owner}/${name}`.toLowerCase();
      const repo = { "example/project": ["example/project", false], "example/secret": ["example/secret", true] }[key];
      if (!repo || (repo[1] && !authorized)) return reply(404, { message: "Not Found" });
      if (branch !== undefined)
        return ["trunk", "release/1"].includes(decodeURIComponent(branch))
          ? reply(200, { name: decodeURIComponent(branch) })
          : reply(404, { message: "Branch not found" });
      reply(200, { full_name: repo[0], default_branch: "trunk", private: repo[1] });
    });
    github.listen(0, "127.0.0.1");
    await once(github, "listening");
    process.env.ADM_GITHUB_API_URL = `http://127.0.0.1:${github.address().port}`;
    const logs = [];
    await mkdir(join(directory, "authority"), { recursive: true });
    const authority = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
      log: (line) => logs.push(line),
    });
    await new Promise((resolve) => authority.server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      delete process.env.ADM_GITHUB_API_URL;
      await authority.close();
      github.close();
      await rm(directory, { recursive: true });
    });
    const base = `http://127.0.0.1:${authority.server.address().port}`;
    const check = async (repo, ref) => {
      const response = await fetch(`${base}/v1/repos/check`, {
        method: "POST",
        body: JSON.stringify({ repo, ref }),
      });
      return { status: response.status, body: await response.json() };
    };

    // Not logged in: a public repository is reachable, resolved to its
    // canonical name and default branch, without any credential.
    const publicRepo = await check("Example/Project");
    assert.equal(publicRepo.status, 200, JSON.stringify(publicRepo.body));
    assert.deepEqual(publicRepo.body, { repo: "example/project", ref: "trunk" });
    assert.equal(seen[0].authorization, undefined);

    // A private repository without the login says what to run.
    const noLogin = await check("example/secret");
    assert.equal(noLogin.status, 404);
    assert.match(noLogin.body.error.message, /example\/secret is not reachable/);
    assert.match(noLogin.body.error.message, /adm repos login github/);

    // With the cluster login the same repository is reachable.
    await writeFile(
      join(directory, "authority", "github.json"),
      JSON.stringify({ token: "gho_CHECKsecret0001", account: "nwylynko", loggedInAt: "2026-10-31T00:00:00Z" }),
      { mode: 0o600 },
    );
    await authority.close();
    const second = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
      log: (line) => logs.push(line),
    });
    await new Promise((resolve) => second.server.listen(0, "127.0.0.1", resolve));
    t.after(() => second.close());
    const secondBase = `http://127.0.0.1:${second.server.address().port}`;
    const checkLoggedIn = async (repo, ref) => {
      const response = await fetch(`${secondBase}/v1/repos/check`, {
        method: "POST",
        body: JSON.stringify({ repo, ref }),
      });
      return { status: response.status, body: await response.json() };
    };
    const secret = await checkLoggedIn("example/secret");
    assert.equal(secret.status, 200, JSON.stringify(secret.body));
    assert.deepEqual(secret.body, { repo: "example/secret", ref: "trunk" });
    assert.equal(seen.at(-1).authorization, "Bearer gho_CHECKsecret0001");

    // An explicit branch must exist; branch names with slashes work.
    assert.deepEqual((await checkLoggedIn("example/secret", "release/1")).body, {
      repo: "example/secret",
      ref: "release/1",
    });
    const noBranch = await checkLoggedIn("example/secret", "nope");
    assert.equal(noBranch.status, 404);
    assert.match(noBranch.body.error.message, /branch nope was not found in example\/secret/);

    const missing = await checkLoggedIn("example/missing");
    assert.equal(missing.status, 404);
    assert.match(missing.body.error.message, /example\/missing is not reachable with the GitHub login \(account nwylynko\)/);

    // The token is never in an error or a log line.
    assert.equal(
      JSON.stringify([missing.body, noBranch.body, noLogin.body, logs]).includes("gho_CHECKsecret0001"),
      false,
    );
  },
);
