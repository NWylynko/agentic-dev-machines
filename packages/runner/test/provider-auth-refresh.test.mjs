// TASK-109: provider-auth logs every login, logout and refresh, refreshes
// stored OAuth credentials on its own before they expire, and tolerates
// refresh failures. The authority is driven over HTTP against a fake OAuth
// provider whose refresh calls a fake token endpoint, like Pi's xAI provider.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOwnerEpochGuard,
  createProviderAuthAuthority,
} from "../src/provider-auth-authority.ts";

const FAKE_PROVIDER = "adm-fake-oauth";
const MINUTE = 60_000;
const SECRET_PATTERN = /fake-(access|refresh)-[a-z0-9-]*secret/;

// Mirrors Pi's xAI provider: form POST to the token endpoint, the provider's
// error text in the thrown message, `expires` saved 5 min before the real one.
async function postFakeToken(tokenUrl, fields, signal) {
  const response = await fetch(tokenUrl, {
    method: "POST",
    body: new URLSearchParams(fields),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `Fake OAuth token refresh failed (HTTP ${response.status})${body.error ? `: ${body.error}` : ""}`,
    );
  return {
    type: "oauth",
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000 - 5 * MINUTE,
  };
}

function fakeOAuthProvider(tokenUrl) {
  return {
    id: FAKE_PROVIDER,
    name: "Fake OAuth provider",
    auth: {
      oauth: {
        name: "Fake OAuth",
        login: async () =>
          postFakeToken(tokenUrl, { grant_type: "device_code" }, undefined),
        refresh: async (credential, signal) =>
          postFakeToken(
            tokenUrl,
            { grant_type: "refresh_token", refresh_token: credential.refresh },
            signal,
          ),
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    getModels: () => [],
    stream: () => {
      throw new Error("not used");
    },
    streamSimple: () => {
      throw new Error("not used");
    },
  };
}

// A scheduler the test drives by hand: timers never fire on their own.
function createManualRefreshScheduler(startAt = Date.now()) {
  const scheduler = {
    time: startAt,
    timers: [],
    now: () => scheduler.time,
    setTimer(run, delayMs) {
      const timer = { run, delayMs, at: scheduler.time + delayMs };
      scheduler.timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      scheduler.timers = scheduler.timers.filter((item) => item !== timer);
    },
    // Advance the clock to the earliest timer and run it to completion.
    async fireNext() {
      scheduler.timers.sort((a, b) => a.at - b.at);
      const timer = scheduler.timers.shift();
      assert.ok(timer, "a refresh should be scheduled");
      scheduler.time = Math.max(scheduler.time, timer.at);
      await timer.run();
      return timer;
    },
  };
  return scheduler;
}

async function startFakeTokenEndpoint(t) {
  const endpoint = { responses: [], requests: [] };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    endpoint.requests.push(
      Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())),
    );
    const next = endpoint.responses.shift() ?? {
      status: 599,
      body: { error: "unexpected_token_request" },
    };
    response.writeHead(next.status, { "content-type": "application/json" });
    response.end(JSON.stringify(next.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  endpoint.url = `http://127.0.0.1:${server.address().port}/token`;
  endpoint.issue = (n, expiresInSeconds = 6 * 60 * 60) => ({
    status: 200,
    body: {
      access_token: `fake-access-${n}-secret`,
      refresh_token: `fake-refresh-${n}-secret`,
      expires_in: expiresInSeconds,
    },
  });
  return endpoint;
}

async function startProviderAuthFixture(t, { credential, scheduler } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-auth-refresh-"));
  const authPath = join(directory, "auth.json");
  if (credential)
    await writeFile(authPath, JSON.stringify({ [FAKE_PROVIDER]: credential }));
  const tokens = await startFakeTokenEndpoint(t);
  const owner = { epoch: 7 };
  const logs = [];
  const authority = await createProviderAuthAuthority({
    authPath,
    ownerGuard: createOwnerEpochGuard(async () => owner.epoch),
    configure: (runtime) =>
      runtime.registerNativeProvider(fakeOAuthProvider(tokens.url)),
    log: (line) => logs.push(line),
    ...(scheduler ? { refreshScheduler: scheduler } : {}),
  });
  t.after(async () => {
    await authority.close();
    await rm(directory, { recursive: true });
  });
  await new Promise((resolve) => authority.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${authority.server.address().port}`;
  const request = (path, method = "GET", body) =>
    fetch(`${url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  const events = () => logs.map((line) => JSON.parse(line));
  const stored = async () =>
    JSON.parse(await readFile(authPath, "utf8"))[FAKE_PROVIDER];
  return { authority, authPath, tokens, owner, logs, events, request, stored };
}

function assertNoSecretsLogged(logs) {
  for (const line of logs)
    assert.doesNotMatch(line, SECRET_PATTERN, `log line leaks a token: ${line}`);
}

test("provider-auth logs login, request-path refresh and logout as JSON lines without tokens (TASK-109)", async (t) => {
  const fixture = await startProviderAuthFixture(t);
  fixture.tokens.responses.push(fixture.tokens.issue("login", 1));
  const login = await fixture.request("/v1/provider-auth/login", "POST", {
    provider: FAKE_PROVIDER,
    type: "oauth",
  });
  const { operationId } = await login.json();
  const complete = await fixture.request(
    `/v1/provider-auth/login/${operationId}/events`,
  );
  assert.equal((await complete.json()).event.type, "complete");

  // expires_in 1 s is saved already expired, so the next resolve refreshes.
  fixture.tokens.responses.push(fixture.tokens.issue("rotated"));
  const resolved = await fixture.request(
    `/v1/provider-auth/resolve/${FAKE_PROVIDER}`,
  );
  assert.equal(resolved.status, 200);
  assert.deepEqual((await resolved.json()).auth, {
    apiKey: "fake-access-rotated-secret",
  });
  const stored = await fixture.stored();
  assert.equal(stored.refresh, "fake-refresh-rotated-secret");

  const logout = await fixture.request("/v1/provider-auth/logout", "POST", {
    provider: FAKE_PROVIDER,
  });
  assert.equal(logout.status, 200);

  const events = fixture.events();
  for (const entry of events) {
    assert.equal(entry.service, "provider-auth");
    assert.ok(!Number.isNaN(Date.parse(entry.time)), JSON.stringify(entry));
  }
  const named = (event) => events.filter((entry) => entry.event === event);
  assert.equal(named("login_started").length, 1);
  assert.equal(named("login_started")[0].provider, FAKE_PROVIDER);
  assert.equal(named("login_succeeded").length, 1);
  assert.equal(named("refresh_started").length, 1);
  assert.equal(named("refresh_started")[0].trigger, "request");
  const succeeded = named("refresh_succeeded");
  assert.equal(succeeded.length, 1);
  assert.equal(succeeded[0].provider, FAKE_PROVIDER);
  assert.equal(succeeded[0].expires, new Date(stored.expires).toISOString());
  assert.equal(typeof succeeded[0].durationMs, "number");
  assert.equal(named("logout").length, 1);
  assertNoSecretsLogged(fixture.logs);
});

test("a failed request-path refresh returns and logs the provider's real cause (TASK-109)", async (t) => {
  const fixture = await startProviderAuthFixture(t, {
    credential: {
      type: "oauth",
      access: "fake-access-old-secret",
      refresh: "fake-refresh-old-secret",
      expires: Date.now() - 1000,
    },
  });
  fixture.tokens.responses.push({ status: 500, body: { error: "server_error" } });
  const resolved = await fixture.request(
    `/v1/provider-auth/resolve/${FAKE_PROVIDER}`,
  );
  assert.equal(resolved.status, 400);
  const { error } = await resolved.json();
  assert.equal(error.code, "PROVIDER_AUTH_ERROR");
  assert.equal(
    error.message,
    `${FAKE_PROVIDER}: token refresh failed (Fake OAuth token refresh failed (HTTP 500): server_error)`,
  );
  assert.doesNotMatch(JSON.stringify(error), SECRET_PATTERN);

  const events = fixture.events();
  const failed = events.filter((entry) => entry.event === "refresh_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, "error");
  assert.equal(failed[0].provider, FAKE_PROVIDER);
  assert.equal(failed[0].operation, "token refresh");
  assert.equal(typeof failed[0].durationMs, "number");
  assert.equal(failed[0].cause.length, 2);
  assert.match(failed[0].cause[0], new RegExp(`^OAuth refresh failed for ${FAKE_PROVIDER}`));
  assert.equal(
    failed[0].cause[1],
    "Fake OAuth token refresh failed (HTTP 500): server_error",
  );
  const requestFailed = events.filter((entry) => entry.event === "request_failed");
  assert.equal(requestFailed.length, 1);
  assert.equal(requestFailed[0].method, "GET");
  assert.equal(requestFailed[0].path, `/v1/provider-auth/resolve/${FAKE_PROVIDER}`);
  assert.equal(requestFailed[0].status, 400);
  assert.match(requestFailed[0].cause.join(" "), /HTTP 500/);
  // The stored credential is kept for the next attempt.
  assert.equal((await fixture.stored()).refresh, "fake-refresh-old-secret");
  assertNoSecretsLogged(fixture.logs);
});

test("a rejected owner fence is logged (TASK-109)", async (t) => {
  const fixture = await startProviderAuthFixture(t);
  assert.equal((await fixture.request("/health")).status, 200);
  fixture.owner.epoch = 8;
  assert.equal((await fixture.request("/health")).status, 503);
  const fence = fixture.events().filter((entry) => entry.event === "fence_rejected");
  assert.equal(fence.length, 1);
  assert.equal(fence[0].level, "warn");
  assert.equal(fence[0].path, "/health");
});

test("an invalid request body is answered and logged with its parse error (TASK-109)", async (t) => {
  const fixture = await startProviderAuthFixture(t);
  const bad = await fetch(
    `http://127.0.0.1:${fixture.authority.server.address().port}/v1/provider-auth/logout`,
    { method: "POST", body: "not json" },
  );
  assert.equal(bad.status, 400);
  const { error } = await bad.json();
  assert.match(error.message, /^provider-auth: POST \/v1\/provider-auth\/logout failed \(.*JSON/);
  const logged = fixture.events().filter((entry) => entry.event === "request_failed");
  assert.equal(logged.length, 1);
  assert.match(logged[0].cause.join(" "), /JSON/);
});
