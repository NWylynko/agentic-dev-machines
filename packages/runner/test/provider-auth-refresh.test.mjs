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
    endpoint.onRequest?.();
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

async function startProviderAuthFixture(
  t,
  { credential, scheduler = createManualRefreshScheduler() } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-auth-refresh-"));
  const authPath = join(directory, "auth.json");
  if (credential)
    await writeFile(authPath, JSON.stringify({ [FAKE_PROVIDER]: credential }));
  const tokens = await startFakeTokenEndpoint(t);
  const owner = { epoch: 7, advanceOnNextRead: false };
  const logs = [];
  const authority = await createProviderAuthAuthority({
    authPath,
    ownerGuard: createOwnerEpochGuard(async () => {
      const epoch = owner.epoch;
      if (owner.advanceOnNextRead) {
        owner.advanceOnNextRead = false;
        owner.epoch += 1;
      }
      return epoch;
    }),
    configure: (runtime) =>
      runtime.registerNativeProvider(fakeOAuthProvider(tokens.url)),
    log: (line) => logs.push(line),
    refreshScheduler: scheduler,
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

test("an idle OAuth credential is refreshed 10 min before its stored expiry with no request touching it (TASK-109)", async (t) => {
  const scheduler = createManualRefreshScheduler();
  const expires = scheduler.now() + 60 * MINUTE;
  const fixture = await startProviderAuthFixture(t, {
    scheduler,
    credential: {
      type: "oauth",
      access: "fake-access-idle-secret",
      refresh: "fake-refresh-idle-secret",
      expires,
    },
  });
  // Scheduled on start from the stored expiry, not from a request.
  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.timers[0].delayMs, 50 * MINUTE);

  fixture.tokens.responses.push(fixture.tokens.issue("scheduled"));
  await scheduler.fireNext();
  assert.deepEqual(fixture.tokens.requests, [
    { grant_type: "refresh_token", refresh_token: "fake-refresh-idle-secret" },
  ]);
  const stored = await fixture.stored();
  assert.equal(stored.access, "fake-access-scheduled-secret");
  assert.equal(stored.refresh, "fake-refresh-scheduled-secret");
  assert.ok(stored.expires > expires + 4 * 60 * MINUTE, "the new expiry is persisted");

  // The next refresh is scheduled from the new expiry.
  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.timers[0].at, stored.expires - 10 * MINUTE);

  const events = fixture.events();
  const succeeded = events.filter((entry) => entry.event === "refresh_succeeded");
  assert.equal(succeeded.length, 1);
  assert.equal(succeeded[0].trigger, "scheduled");
  assert.equal(succeeded[0].expires, new Date(stored.expires).toISOString());
  assert.equal(
    events.filter((entry) => entry.event === "refresh_scheduled").length,
    2,
  );
  assert.equal(events.filter((entry) => entry.event === "request_failed").length, 0);
  assertNoSecretsLogged(fixture.logs);
});

test("login schedules the credential's refresh and logout cancels it (TASK-109)", async (t) => {
  const scheduler = createManualRefreshScheduler();
  const fixture = await startProviderAuthFixture(t, { scheduler });
  assert.equal(scheduler.timers.length, 0);
  fixture.tokens.responses.push(fixture.tokens.issue("login"));
  const login = await fixture.request("/v1/provider-auth/login", "POST", {
    provider: FAKE_PROVIDER,
    type: "oauth",
  });
  const { operationId } = await login.json();
  const complete = await fixture.request(
    `/v1/provider-auth/login/${operationId}/events`,
  );
  assert.equal((await complete.json()).event.type, "complete");
  const stored = await fixture.stored();
  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.timers[0].at, stored.expires - 10 * MINUTE);

  const logout = await fixture.request("/v1/provider-auth/logout", "POST", {
    provider: FAKE_PROVIDER,
  });
  assert.equal(logout.status, 200);
  assert.equal(scheduler.timers.length, 0);
  assert.equal(fixture.tokens.requests.length, 1, "only the login reached the token endpoint");
});

const idleCredential = (scheduler) => ({
  type: "oauth",
  access: "fake-access-idle-secret",
  refresh: "fake-refresh-idle-secret",
  expires: scheduler.now() + 60 * MINUTE,
});

test("a transient refresh failure keeps the credential and retries with backoff until it succeeds (TASK-109)", async (t) => {
  const scheduler = createManualRefreshScheduler();
  const credential = idleCredential(scheduler);
  const fixture = await startProviderAuthFixture(t, { scheduler, credential });
  const unavailable = { status: 503, body: { error: "temporarily_unavailable" } };
  const retryDelays = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    fixture.tokens.responses.push(unavailable);
    await scheduler.fireNext();
    assert.deepEqual(await fixture.stored(), credential, "the credential survives");
    assert.equal(scheduler.timers.length, 1, "a retry is scheduled");
    retryDelays.push(scheduler.timers[0].delayMs / MINUTE);
  }
  assert.deepEqual(retryDelays, [1, 2, 4, 8, 15, 15]);
  // The fake clock is now past the access token's expiry; retries continue.
  assert.ok(scheduler.now() > credential.expires);

  fixture.tokens.responses.push(fixture.tokens.issue("recovered"));
  await scheduler.fireNext();
  const stored = await fixture.stored();
  assert.equal(stored.refresh, "fake-refresh-recovered-secret");
  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.timers[0].at, stored.expires - 10 * MINUTE);
  assert.equal(fixture.tokens.requests.length, 7);
  for (const request of fixture.tokens.requests)
    assert.equal(request.refresh_token, "fake-refresh-idle-secret");

  const events = fixture.events();
  const failed = events.filter((entry) => entry.event === "refresh_failed");
  assert.equal(failed.length, 6);
  for (const entry of failed) {
    assert.equal(entry.kind, "transient");
    assert.match(entry.cause.at(-1), /HTTP 503/);
  }
  assert.deepEqual(
    events
      .filter((entry) => entry.event === "refresh_retry_scheduled")
      .map((entry) => entry.attempt),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(events.filter((entry) => entry.event === "refresh_succeeded").length, 1);
  assertNoSecretsLogged(fixture.logs);
});

test("invalid_grant stops retrying and marks the provider login_expired with its cause (TASK-109)", async (t) => {
  const scheduler = createManualRefreshScheduler();
  const fixture = await startProviderAuthFixture(t, {
    scheduler,
    credential: idleCredential(scheduler),
  });
  fixture.tokens.responses.push({ status: 400, body: { error: "invalid_grant" } });
  await scheduler.fireNext();
  assert.equal(scheduler.timers.length, 0, "a permanent failure is not retried");
  assert.equal(fixture.tokens.requests.length, 1);

  const providers = await (await fixture.request("/v1/provider-auth/providers")).json();
  const provider = providers.find((item) => item.provider === FAKE_PROVIDER);
  assert.equal(provider.authenticated, "oauth");
  assert.equal(provider.status, "login_expired");
  assert.equal(provider.cause, "Fake OAuth token refresh failed (HTTP 400): invalid_grant");

  const hints = fixture.logs.filter((line) =>
    line.includes(`adm login ${FAKE_PROVIDER}`),
  );
  assert.equal(hints.length, 1, fixture.logs.join("\n"));
  const failed = JSON.parse(hints[0]);
  assert.equal(failed.event, "refresh_failed");
  assert.equal(failed.level, "error");
  assert.equal(failed.kind, "permanent");
  assert.equal(
    failed.message,
    `${FAKE_PROVIDER}: token refresh failed (Fake OAuth token refresh failed (HTTP 400): invalid_grant): run adm login ${FAKE_PROVIDER}`,
  );

  // A new login clears the state and schedules again.
  fixture.tokens.responses.push(fixture.tokens.issue("relogin"));
  const login = await fixture.request("/v1/provider-auth/login", "POST", {
    provider: FAKE_PROVIDER,
    type: "oauth",
  });
  const { operationId } = await login.json();
  await fixture.request(`/v1/provider-auth/login/${operationId}/events`);
  const after = await (await fixture.request("/v1/provider-auth/providers")).json();
  const relogged = after.find((item) => item.provider === FAKE_PROVIDER);
  assert.equal(relogged.status, "authenticated");
  assert.equal(relogged.cause, undefined);
  assert.equal(scheduler.timers.length, 1);
  assertNoSecretsLogged(fixture.logs);
});

test("a scheduled refresh without a current owner fence never reaches the token endpoint (TASK-109)", async (t) => {
  const scheduler = createManualRefreshScheduler();
  const credential = idleCredential(scheduler);
  const fixture = await startProviderAuthFixture(t, { scheduler, credential });
  assert.equal((await fixture.request("/health")).status, 200);
  fixture.owner.epoch = 8;
  await scheduler.fireNext();
  assert.deepEqual(fixture.tokens.requests, []);
  assert.deepEqual(await fixture.stored(), credential);
  const events = fixture.events();
  assert.equal(
    events.filter(
      (entry) => entry.event === "fence_rejected" && entry.operation === "credential update",
    ).length,
    1,
  );
  const failed = events.filter((entry) => entry.event === "refresh_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].kind, "fence");
  assert.equal(scheduler.timers.length, 1, "retried in case the fence comes back");
});

test("a request-path refresh rechecks the owner fence before spending the refresh token (TASK-109)", async (t) => {
  const fixture = await startProviderAuthFixture(t, {
    credential: {
      type: "oauth",
      access: "fake-access-old-secret",
      refresh: "fake-refresh-old-secret",
      expires: Date.now() - 1000,
    },
  });
  // The request is admitted under epoch 7; the owner moves before the refresh.
  fixture.owner.advanceOnNextRead = true;
  const resolved = await fixture.request(`/v1/provider-auth/resolve/${FAKE_PROVIDER}`);
  assert.equal(resolved.status, 400);
  assert.match((await resolved.json()).error.message, /owner fence is not current/);
  assert.deepEqual(fixture.tokens.requests, [], "the refresh token was not spent");
  assert.equal((await fixture.stored()).refresh, "fake-refresh-old-secret");
});

test("a hung provider refresh does not block the rest of the catalog (TASK-97)", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-catalog-isolation-"));
  t.after(() => rm(directory, { recursive: true }));
  const authPath = join(directory, "auth.json");
  const hung = "adm-catalog-hung";
  const ok = "adm-catalog-ok";
  await writeFile(
    authPath,
    JSON.stringify({
      [hung]: {
        type: "oauth",
        access: "fake-access-hung-secret",
        refresh: "fake-refresh-hung-secret",
        expires: Date.now() - 60_000,
      },
    }),
  );
  const model = (provider, id) => ({
    id,
    provider,
    name: id,
    api: "openai-completions",
    baseUrl: "https://provider.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  });
  const logs = [];
  const authority = await createProviderAuthAuthority({
    authPath,
    // The scheduled refresh must not fire on its own; the catalog calls it.
    refreshScheduler: createManualRefreshScheduler(),
    catalogProviderTimeoutMs: 300,
    log: (line) => logs.push(line),
    configure(runtime) {
      runtime.registerNativeProvider({
        id: hung,
        name: "Hung OAuth provider",
        auth: {
          oauth: {
            name: "Hung OAuth",
            login: async () => {
              throw new Error("not used");
            },
            // Hangs until the caller aborts. Pi only aborts the lock wait;
            // once refresh starts it passes its own 15s signal, which this
            // honors so shutdown can finish. The catalog must still return
            // on its own shorter timeout.
            refresh: (_credential, signal) =>
              new Promise((_resolve, reject) => {
                const abort = () =>
                  reject(new Error("token refresh timed out"));
                if (signal?.aborted) abort();
                else signal?.addEventListener("abort", abort, { once: true });
              }),
            toAuth: async (credential) => ({ apiKey: credential.access }),
          },
        },
        getModels: () => [model(hung, "hung-model")],
        stream: () => {
          throw new Error("not used");
        },
        streamSimple: () => {
          throw new Error("not used");
        },
      });
      runtime.registerNativeProvider({
        id: ok,
        name: "Working provider",
        auth: {
          apiKey: {
            name: "Working key",
            check: async () => ({ source: "API key", type: "api_key" }),
            resolve: async () => ({ auth: { apiKey: "ok-key" } }),
          },
        },
        getModels: () => [model(ok, "ok-model")],
        stream: () => {
          throw new Error("not used");
        },
        streamSimple: () => {
          throw new Error("not used");
        },
      });
    },
  });
  t.after(() => authority.close());
  await new Promise((resolve) =>
    authority.server.listen(0, "127.0.0.1", resolve),
  );
  const started = Date.now();
  const response = await fetch(
    `http://127.0.0.1:${authority.server.address().port}/v1/provider-auth/catalog`,
    { method: "POST", signal: AbortSignal.timeout(2_000) },
  );
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.ok(
    elapsed < 2_000,
    `catalog took ${elapsed}ms; a hung provider must not hold the others`,
  );
  assert.deepEqual(catalog[ok].models, ["ok-model"]);
  assert.equal(catalog[ok].error, undefined);
  assert.equal(typeof catalog[hung].error, "string", JSON.stringify(catalog[hung]));
  assert.match(catalog[hung].error, new RegExp(hung));
  assert.doesNotMatch(catalog[hung].error, /fake-(access|refresh)-hung-secret/);
  const failure = logs
    .map((line) => JSON.parse(line))
    .find(
      (entry) =>
        entry.provider === hung &&
        entry.operation &&
        (Array.isArray(entry.cause) ? entry.cause.length > 0 : entry.cause),
    );
  assert.ok(failure, `no failure log named ${hung}: ${logs.join("\n")}`);
  assert.doesNotMatch(logs.join("\n"), /fake-(access|refresh)-hung-secret/);
});

test("a refresh whose write is fenced out logs that the rotated refresh token was lost (TASK-109)", async (t) => {
  const scheduler = createManualRefreshScheduler();
  const fixture = await startProviderAuthFixture(t, {
    scheduler,
    credential: idleCredential(scheduler),
  });
  assert.equal((await fixture.request("/health")).status, 200);
  fixture.tokens.responses.push(fixture.tokens.issue("rotated"));
  fixture.tokens.onRequest = () => {
    fixture.owner.epoch = 8;
  };
  await scheduler.fireNext();
  assert.equal(fixture.tokens.requests.length, 1);
  assert.equal((await fixture.stored()).refresh, "fake-refresh-idle-secret");
  const lost = fixture.events().filter((entry) => entry.event === "refresh_token_lost");
  assert.equal(lost.length, 1);
  assert.equal(lost[0].level, "error");
  assert.equal(lost[0].provider, FAKE_PROVIDER);
  assert.match(lost[0].message, /rotated refresh token was lost/);
  assert.match(lost[0].message, new RegExp(`run adm login ${FAKE_PROVIDER}`));
  assertNoSecretsLogged(fixture.logs);
});
