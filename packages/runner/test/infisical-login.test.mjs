// The installation's Infisical machine identity (TASK-138): the real `adm`
// against the real provider-auth authority and a fake Infisical API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

const CLIENT_ID = "4f1c2a9e-client-id-fixture";
const CLIENT_SECRET = "ua-SECRET-fixture-0001";

// A stand-in for Infisical's universal-auth login
// (`POST /api/v1/auth/universal-auth/login`, as the Infisical CLI calls it).
export function startFakeInfisical() {
  const state = { logins: 0, expiresIn: 7200, reject: false, issued: [] };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const reply = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && request.url === "/api/v1/auth/universal-auth/login") {
      state.logins += 1;
      const body = JSON.parse(raw || "{}");
      if (state.reject || body.clientId !== CLIENT_ID || body.clientSecret !== CLIENT_SECRET)
        return reply(401, { statusCode: 401, message: "Invalid credentials", error: "UnauthorizedError" });
      const accessToken = `inf-access-${state.logins}-${Math.random().toString(36).slice(2)}`;
      state.issued.push(accessToken);
      return reply(200, {
        accessToken,
        expiresIn: state.expiresIn,
        accessTokenMaxTTL: 2592000,
        tokenType: "Bearer",
      });
    }
    reply(404, { message: "Not Found" });
  });
  return { server, state };
}

test(
  "adm infisical login checks and stores the machine identity, the runtime route mints cached access tokens, and nothing leaks",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-infisical-login-"));
    const infisical = startFakeInfisical();
    infisical.server.listen(0, "127.0.0.1");
    await once(infisical.server, "listening");
    const domain = `http://127.0.0.1:${infisical.server.address().port}`;
    const logs = [];
    const authority = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
      log: (line) => logs.push(line),
    });
    await new Promise((resolve) => authority.server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await authority.close();
      infisical.server.closeAllConnections();
      infisical.server.close();
      await rm(directory, { recursive: true });
    });
    const authorityUrl = `http://127.0.0.1:${authority.server.address().port}`;
    const tokenFile = join(directory, "lifecycle-token");
    await writeFile(tokenFile, "operator-lifecycle-token\n", { mode: 0o600 });
    const outputs = [];
    const adm = async (args, { input = "", allowFailure = false } = {}) => {
      const child = spawn(
        admBinary,
        [...args, "--lifecycle-url", authorityUrl, "--lifecycle-token-file", tokenFile],
        {
          stdio: ["pipe", "pipe", "pipe"],
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
      child.stdin.end(input);
      const [code] = await once(child, "exit");
      outputs.push(stdout, stderr);
      if (!allowFailure) assert.equal(code, 0, `adm ${args.join(" ")}: ${stdout}${stderr}`);
      return { code, stdout, stderr };
    };
    const tokenRoute = async () => {
      const response = await fetch(`${authorityUrl}/v1/runtime/infisical/token`);
      const body = await response.json();
      outputs.push(JSON.stringify(body));
      return { status: response.status, body };
    };
    const stateFile = join(directory, "authority", "infisical.json");
    const login = (secret, extra = []) =>
      adm(["infisical", "login", "--domain", domain, "--client-id", CLIENT_ID, ...extra], {
        input: `${secret}\n`,
        allowFailure: true,
      });

    // Not logged in: a distinct not_configured answer, and status says what to run.
    const before = await adm(["infisical", "status"]);
    assert.match(before.stdout, /Infisical: not logged in; run adm infisical login/);
    const missing = await tokenRoute();
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error.code, "INFISICAL_NOT_CONFIGURED");

    // A pair Infisical refuses is not stored.
    const refused = await login("ua-WRONG-secret-9999");
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /Infisical refused machine identity 4f1c2a9e-client-id-fixture/);
    await assert.rejects(stat(stateFile), { code: "ENOENT" });
    assert.equal(infisical.state.logins, 1);

    // A good pair is checked with one real login and stored 0600.
    const good = await login(CLIENT_SECRET);
    assert.equal(good.code, 0, good.stderr);
    assert.match(good.stdout, /Infisical connected as machine identity 4f1c2a9e-client-id-fixture/);
    assert.equal(infisical.state.logins, 2);
    const stored = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(stored.clientId, CLIENT_ID);
    assert.equal(stored.clientSecret, CLIENT_SECRET);
    assert.equal(stored.domain, domain);
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);

    // The access token from that check is cached: two requests, no new login.
    const first = await tokenRoute();
    const second = await tokenRoute();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.token, infisical.state.issued.at(-1));
    assert.equal(second.body.token, first.body.token);
    assert.ok(Date.parse(first.body.expiresAt) > Date.now() + 60 * 60_000);
    assert.equal(infisical.state.logins, 2, "cached tokens need no new login");

    const status = await adm(["infisical", "status"]);
    assert.match(status.stdout, /Infisical: connected as machine identity 4f1c2a9e-client-id-fixture at http:\/\/127\.0\.0\.1:\d+/);
    assert.match(status.stdout, /last token minted .* valid until /);

    // A token with under 10 minutes left is replaced on the next request.
    infisical.state.expiresIn = 300;
    assert.equal((await login(CLIENT_SECRET)).code, 0);
    assert.equal(infisical.state.logins, 3);
    const short = await tokenRoute();
    assert.equal(short.status, 200);
    assert.equal(infisical.state.logins, 4, "a short-lived token is renewed on request");
    await tokenRoute();
    assert.equal(infisical.state.logins, 5);

    // Infisical refusing the stored pair is login_expired, naming the fix.
    infisical.state.reject = true;
    const expired = await tokenRoute();
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error.code, "INFISICAL_LOGIN_EXPIRED");
    assert.match(expired.body.error.message, /run adm infisical login/);
    const expiredStatus = await adm(["infisical", "status"]);
    assert.match(expiredStatus.stdout, /login expired.*run adm infisical login/);
    infisical.state.reject = false;

    // doctor shows the identity, never the secret.
    const doctor = await adm(["doctor"], { allowFailure: true });
    assert.match(doctor.stdout, /Infisical:\n {2}connected as machine identity 4f1c2a9e-client-id-fixture/);

    const out = await adm(["infisical", "logout"]);
    assert.match(out.stdout, /Logged out of Infisical/);
    await assert.rejects(stat(stateFile), { code: "ENOENT" });
    assert.equal((await tokenRoute()).body.error.code, "INFISICAL_NOT_CONFIGURED");

    // The secret is never in argv-free output, logs or status; tokens only in
    // the runtime route's own answers.
    const visible = [...logs, ...outputs.filter((text) => !text.includes('"token"'))].join("\n");
    assert.equal(visible.includes(CLIENT_SECRET), false, "client secret leaked");
    assert.equal(outputs.join("\n").includes(CLIENT_SECRET), false, "client secret leaked");
    for (const token of infisical.state.issued)
      assert.equal(visible.includes(token), false, `access token leaked: ${visible}`);
    for (const event of [
      "infisical_login_refused",
      "infisical_login_succeeded",
      "infisical_token_minted",
      "infisical_token_login_expired",
      "infisical_logout",
    ])
      assert.ok(logs.some((line) => line.includes(event)), `${event} missing from: ${logs.join("\n")}`);
  },
);
