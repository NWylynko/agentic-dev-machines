import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
