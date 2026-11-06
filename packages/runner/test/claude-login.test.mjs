// `adm login claude` (TASK-90): one Claude Code login per installation, held
// and refreshed only by the provider-auth authority. A Claude Pod writes
// `.credentials.json` with an access token and no refresh token
// (`image/adm-claude-credentials`), plus the account in `.claude.json`, so a
// new workspace starts signed in. Separate from Pi's `adm login anthropic`.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProviderAuthAuthority } from "../src/provider-auth-authority.ts";

const admBinary =
  process.env.ADM_BIN ??
  join(
    process.env.CARGO_TARGET_DIR ??
      new URL("../../../target", import.meta.url).pathname,
    "debug",
    "adm",
  );
const writer = new URL("../../../image/adm-claude-credentials", import.meta.url)
  .pathname;
const claude = await promisify(execFile)("sh", ["-c", "command -v claude"])
  .then(({ stdout }) => stdout.trim())
  .catch(() => "");

function run(command, args, { env, input = "" }) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input);
  return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
}

test(
  "adm login claude signs every Claude Pod in with access tokens only, refreshed by the authority",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-claude-login-"));
    // Stand-ins for Anthropic's token endpoint and profile API.
    let issued = 0;
    const refreshes = [];
    let lifetimeMs = 60 * 60 * 1000;
    const claudeOAuth = {
      name: "Claude Code",
      async login(interaction) {
        interaction.notify({
          type: "auth_url",
          url: "https://claude.ai/oauth/authorize?fixture",
        });
        const code = await interaction.prompt({
          type: "manual_code",
          message: "Paste the code Anthropic shows after you sign in:",
        });
        assert.equal(code, "fixture-code#state");
        issued += 1;
        return {
          type: "oauth",
          access: `claude-access-${issued}`,
          refresh: `claude-refresh-${issued}`,
          expires: Date.now() + lifetimeMs,
        };
      },
      async refresh(credential) {
        refreshes.push(credential.refresh);
        issued += 1;
        return {
          type: "oauth",
          access: `claude-access-${issued}`,
          refresh: `claude-refresh-${issued}`,
          expires: Date.now() + 60 * 60 * 1000,
        };
      },
      async toAuth(credential) {
        return { apiKey: credential.access };
      },
    };
    const profileRequests = [];
    const profile = createServer((request, response) => {
      profileRequests.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          account: {
            uuid: "account-uuid",
            email: "nick@example.com",
            display_name: "Nick",
            created_at: "2024-01-01T00:00:00Z",
          },
          organization: {
            uuid: "organization-uuid",
            organization_type: "claude_max",
          },
        }),
      );
    });
    await new Promise((resolve) => profile.listen(0, "127.0.0.1", resolve));
    const authority = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
      claudeOAuth,
      claudeProfileUrl: `http://127.0.0.1:${profile.address().port}/api/oauth/profile`,
    });
    t.after(async () => {
      await authority.close();
      profile.closeAllConnections();
      await new Promise((resolve) => profile.close(resolve));
      await rm(directory, { recursive: true });
    });
    await new Promise((resolve) =>
      authority.server.listen(0, "127.0.0.1", resolve),
    );
    const authorityUrl = `http://127.0.0.1:${authority.server.address().port}`;
    const operatorToken = join(directory, "operator-token");
    await writeFile(operatorToken, "operator\n", { mode: 0o600 });
    const adm = (input, ...args) =>
      run(
        admBinary,
        [
          ...args,
          "--lifecycle-url",
          authorityUrl,
          "--lifecycle-token-file",
          operatorToken,
        ],
        {
          input,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, "client", "config"),
            XDG_STATE_HOME: join(directory, "client", "state"),
            XDG_DATA_HOME: join(directory, "client", "data"),
          },
        },
      );
    const identity = join(directory, "pod-identity");
    await writeFile(identity, "pod-identity\n");
    const config = join(directory, "claude-config");
    const podEnv = {
      PATH: process.env.PATH,
      HOME: directory,
      ADM_LIFECYCLE_URL: authorityUrl,
      ADM_LIFECYCLE_TOKEN_FILE: identity,
      CLAUDE_CONFIG_DIR: config,
    };
    const write = () => run(writer, ["write", config], { env: podEnv });

    const before = await write();
    assert.notEqual(before.code, 0);
    assert.match(before.stderr, /run adm login claude/);

    const login = await adm("fixture-code#state\n", "login", "claude");
    assert.equal(login.code, 0, login.stdout + login.stderr);
    assert.match(login.stdout, /claude\.ai\/oauth\/authorize/);
    assert.match(login.stdout, /Authenticated Claude Code for all ADM workspaces/);
    const stored = JSON.parse(
      await readFile(join(directory, "authority", "auth.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(stored), ["claude"], "never Pi's anthropic login");

    const first = await write();
    assert.equal(first.code, 0, first.stderr);
    const credentials = JSON.parse(
      await readFile(join(config, ".credentials.json"), "utf8"),
    );
    assert.equal(credentials.claudeAiOauth.accessToken, "claude-access-1");
    assert.equal(credentials.claudeAiOauth.refreshToken, null);
    assert.ok(credentials.claudeAiOauth.expiresAt > Date.now() + 50 * 60 * 1000);
    assert.ok(
      credentials.claudeAiOauth.scopes.includes("user:sessions:claude_code"),
    );
    assert.equal(credentials.claudeAiOauth.subscriptionType, "max");
    const account = JSON.parse(await readFile(join(config, ".claude.json"), "utf8"));
    assert.equal(account.oauthAccount.organizationUuid, "organization-uuid");
    assert.equal(account.oauthAccount.accountUuid, "account-uuid");
    assert.equal(account.hasCompletedOnboarding, true);
    assert.deepEqual(profileRequests, ["Bearer claude-access-1"]);
    const pod = JSON.stringify([credentials, account]);
    assert.ok(!pod.includes("claude-refresh"), "no refresh token in the Pod");

    if (claude) {
      const status = await run(claude, ["auth", "status"], { env: podEnv });
      assert.equal(status.code, 0, status.stdout + status.stderr);
      assert.match(status.stdout, /"loggedIn": true/);
    }

    // A login that is close to expiry is refreshed once, by the authority,
    // before a Pod gets it.
    await adm("", "logout", "claude");
    lifetimeMs = 10 * 60 * 1000;
    assert.equal((await adm("fixture-code#state\n", "login", "claude")).code, 0);
    const second = await write();
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(refreshes, ["claude-refresh-2"]);
    assert.equal(
      JSON.parse(await readFile(join(config, ".credentials.json"), "utf8"))
        .claudeAiOauth.accessToken,
      "claude-access-3",
    );

    const logout = await adm("", "logout", "claude");
    assert.equal(logout.code, 0, logout.stderr);
    const after = await write();
    assert.notEqual(after.code, 0);
    assert.match(after.stderr, /run adm login claude/);
  },
);
