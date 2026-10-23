import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderAuthAuthority } from "../src/provider-auth-authority.ts";
import { startMcpOAuthServer } from "./mcp-oauth-fixture.mjs";

async function startAuthority(authPath) {
  const authority = await createProviderAuthAuthority({ authPath });
  await new Promise((resolve) =>
    authority.server.listen(0, "127.0.0.1", resolve),
  );
  const url = `http://127.0.0.1:${authority.server.address().port}`;
  return {
    authority,
    async call(path, method = "GET", body) {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

async function signIn(api, fixture, name) {
  const redirectUrl = "http://127.0.0.1:45871/callback";
  const started = await api.call(`/v1/connectors/${name}/sign-in`, "POST", {
    redirectUrl,
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const callback = await fixture.approve(started.body.authorizationUrl);
  assert.equal(`${callback.origin}${callback.pathname}`, redirectUrl);
  assert.equal(callback.searchParams.get("state"), started.body.state);
  return api.call(`/v1/connectors/${name}/sign-in/complete`, "POST", {
    state: callback.searchParams.get("state"),
    code: callback.searchParams.get("code"),
  });
}

test("a connector signs in once, refreshes centrally, survives restart, and signs out or is removed for every agent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-connector-authority-"));
  const fixture = await startMcpOAuthServer();
  const authPath = join(directory, "provider-auth", "auth.json");
  let api = await startAuthority(authPath);
  t.after(async () => {
    await api.authority.close();
    await fixture.close();
    await rm(directory, { recursive: true });
  });

  assert.equal(
    (
      await api.call("/v1/connectors", "POST", {
        name: "Linear",
        url: fixture.url,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api.call("/v1/connectors", "POST", {
        name: "plain",
        url: "http://mcp.example.com/mcp",
      })
    ).status,
    400,
  );
  const added = await api.call("/v1/connectors", "POST", {
    name: "linear",
    url: fixture.url,
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.signedIn, false);
  assert.equal(
    (
      await api.call("/v1/connectors", "POST", {
        name: "linear",
        url: fixture.url,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api.call("/v1/connectors", "POST", {
        name: "linear",
        url: `${fixture.url}/other`,
      })
    ).status,
    409,
  );
  const missingSignIn = await api.call("/v1/runtime/connectors/token", "POST", {
    name: "linear",
  });
  assert.equal(missingSignIn.status, 401);
  assert.match(missingSignIn.body.error.message, /adm mcp login linear/);

  const signedIn = await signIn(api, fixture, "linear");
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.deepEqual(signedIn.body.tools, ["lookup", "hang"]);
  assert.equal(signedIn.body.signedIn, true);
  const catalog = await api.call("/v1/runtime/connectors/catalog", "POST");
  assert.deepEqual(
    catalog.body.map(({ name, url, revision, signedIn }) => ({
      name,
      url,
      revision,
      signedIn,
    })),
    [{ name: "linear", url: fixture.url, revision: 1, signedIn: true }],
  );
  const listed = JSON.stringify((await api.call("/v1/connectors")).body);
  for (const secret of [
    ...fixture.accessTokens.keys(),
    ...fixture.refreshTokens.keys(),
  ]) {
    assert.ok(!JSON.stringify(catalog.body).includes(secret));
    assert.ok(!listed.includes(secret));
  }

  const first = await api.call("/v1/runtime/connectors/token", "POST", {
    name: "linear",
  });
  assert.equal(first.status, 200);
  assert.ok(fixture.accessTokens.has(first.body.accessToken));
  assert.deepEqual(Object.keys(first.body), ["accessToken"]);

  // An agent reports its token was rejected: concurrent Pods share one refresh.
  fixture.expireAccessTokens();
  const refreshed = await Promise.all(
    [1, 2, 3].map(() =>
      api.call("/v1/runtime/connectors/token", "POST", {
        name: "linear",
        rejectedToken: first.body.accessToken,
      }),
    ),
  );
  assert.deepEqual(
    refreshed.map((response) => response.status),
    [200, 200, 200],
  );
  assert.equal(new Set(refreshed.map((r) => r.body.accessToken)).size, 1);
  assert.ok(fixture.accessTokens.has(refreshed[0].body.accessToken));
  assert.equal(
    fixture.events.filter(
      (event) => event.type === "token" && event.grant === "refresh_token",
    ).length,
    1,
  );

  await api.authority.close();
  api = await startAuthority(authPath);
  assert.equal(
    (await stat(join(directory, "provider-auth", "connectors.json"))).mode &
      0o777,
    0o600,
  );
  const restored = await api.call("/v1/runtime/connectors/token", "POST", {
    name: "linear",
  });
  assert.equal(restored.body.accessToken, refreshed[0].body.accessToken);
  const stored = await readFile(
    join(directory, "provider-auth", "connectors.json"),
    "utf8",
  );
  assert.ok(!stored.includes("codeVerifier"));

  assert.equal(
    (await api.call("/v1/connectors/linear/logout", "POST")).body.signedIn,
    false,
  );
  assert.equal(
    (await api.call("/v1/runtime/connectors/token", "POST", { name: "linear" }))
      .status,
    401,
  );

  // Signing in again bumps the revision so running agents reconnect.
  assert.equal((await signIn(api, fixture, "linear")).body.revision, 2);
  // A revoked grant cannot refresh: the connector needs sign-in again.
  fixture.revokeGrant();
  const current = await api.call("/v1/runtime/connectors/token", "POST", {
    name: "linear",
  });
  const revoked = await api.call("/v1/runtime/connectors/token", "POST", {
    name: "linear",
    rejectedToken: current.body.accessToken,
  });
  assert.equal(revoked.status, 401);
  assert.match(revoked.body.error.message, /adm mcp login linear/);
  const [afterRevoke] = (await api.call("/v1/connectors")).body;
  assert.equal(afterRevoke.signedIn, false);
  assert.match(afterRevoke.error, /rejected/);

  assert.equal((await api.call("/v1/connectors/linear", "DELETE")).status, 200);
  const removed = await api.call("/v1/runtime/connectors/token", "POST", {
    name: "linear",
  });
  assert.equal(removed.status, 404);
  assert.equal(removed.body.error.code, "CONNECTOR_NOT_FOUND");
  assert.deepEqual((await api.call("/v1/connectors")).body, []);
});

test("a sign-in only completes with the state it issued", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-connector-state-"));
  const fixture = await startMcpOAuthServer();
  const api = await startAuthority(join(directory, "auth.json"));
  t.after(async () => {
    await api.authority.close();
    await fixture.close();
    await rm(directory, { recursive: true });
  });
  await api.call("/v1/connectors", "POST", {
    name: "linear",
    url: fixture.url,
  });
  const started = await api.call("/v1/connectors/linear/sign-in", "POST", {
    redirectUrl: "http://127.0.0.1:45872/callback",
  });
  const callback = await fixture.approve(started.body.authorizationUrl);
  const forged = await api.call(
    "/v1/connectors/linear/sign-in/complete",
    "POST",
    {
      state: "forged",
      code: callback.searchParams.get("code"),
    },
  );
  assert.equal(forged.status, 409);
  assert.equal((await api.call("/v1/connectors")).body[0].signedIn, false);
});
