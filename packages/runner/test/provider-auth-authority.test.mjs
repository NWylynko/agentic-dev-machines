import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { workspaceProviderMetadata } from "../src/models.ts";
import {
  createOwnerEpochGuard,
  createProviderAuthAuthority,
} from "../src/provider-auth-authority.ts";

test("shared model selection preserves missing-login state and OAuth account model restrictions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-catalog-"));
  const identityPath = join(directory, "identity");
  await writeFile(identityPath, "synthetic-catalog-pod-token");
  const providerId = "adm-catalog-fixture";
  const models = ["allowed-model", "excluded-model"].map((id) => ({
    id,
    provider: providerId,
    name: id,
    api: "openai-completions",
    baseUrl: "https://provider.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  }));
  const provider = {
    id: providerId,
    name: "Synthetic OAuth account",
    auth: {
      oauth: {
        name: "Synthetic OAuth",
        isSubscription: true,
        login: async () => ({
          type: "oauth",
          access: "catalog-access-secret",
          refresh: "catalog-refresh-secret",
          expires: Date.now() + 3_600_000,
          availableModelIds: ["allowed-model"],
        }),
        refresh: async () => {
          throw new Error("unexpired credential must not refresh");
        },
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    getModels: () => models,
    filterModels: (catalog, credential) =>
      credential?.type === "oauth"
        ? catalog.filter((model) =>
            credential.availableModelIds.includes(model.id),
          )
        : catalog,
    stream: () => {
      throw new Error("catalog must not issue provider requests");
    },
    streamSimple: () => {
      throw new Error("catalog must not issue provider requests");
    },
  };
  const authority = await createProviderAuthAuthority({
    authPath: join(directory, "auth.json"),
    configure: (runtime) => runtime.registerNativeProvider(provider),
  });
  const previousUrl = process.env.ADM_LIFECYCLE_URL;
  const previousIdentity = process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE;
  try {
    await new Promise((resolve) =>
      authority.server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${authority.server.address().port}`;
    process.env.ADM_LIFECYCLE_URL = url;
    process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE = identityPath;
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const { configureSharedProviderAuth } = await import("../src/models.ts");
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(provider);
    await configureSharedProviderAuth(runtime, [providerId]);
    assert.deepEqual(await runtime.getAvailable(providerId), []);
    assert.equal(await runtime.checkAuth(providerId), undefined);
    const login = await fetch(`${url}/v1/provider-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: providerId, type: "oauth" }),
    });
    assert.equal(login.status, 202);
    const { operationId } = await login.json();
    const completion = await fetch(
      `${url}/v1/provider-auth/login/${operationId}/events`,
    );
    assert.equal((await completion.json()).event.type, "complete");
    assert.deepEqual(
      (await runtime.getAvailable(providerId)).map((model) => model.id),
      ["allowed-model"],
    );
    assert.deepEqual(
      (await runtime.getAllAvailable(providerId)).map((model) => model.id),
      ["allowed-model"],
    );
    assert.deepEqual(await runtime.checkAuth(providerId), {
      source: "OAuth",
      type: "oauth",
    });
    await runtime.refresh({ allowNetwork: false, providers: [providerId] });
    assert.equal(runtime.isUsingOAuth(providerId), true);
    assert.equal(runtime.isUsingSubscription(providerId), true);
    const terminalMetadata = (await workspaceProviderMetadata(runtime)).find(
      (provider) => provider.id === providerId,
    );
    assert.equal(terminalMetadata.authenticated, true);
    assert.equal(terminalMetadata.authType, "oauth");
    assert.equal(terminalMetadata.subscription, true);
    assert.doesNotMatch(
      JSON.stringify(terminalMetadata),
      /catalog-(access|refresh)-secret|synthetic-catalog-pod-token/,
    );
    const catalog = await fetch(`${url}/v1/provider-auth/catalog`, {
      method: "POST",
    });
    assert.equal(catalog.status, 200);
    const serializedCatalog = await catalog.text();
    assert.doesNotMatch(
      serializedCatalog,
      /catalog-(access|refresh)-secret|synthetic-catalog-pod-token/,
    );
    const logout = await fetch(`${url}/v1/provider-auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: providerId }),
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await runtime.getAvailable(providerId), []);
  } finally {
    if (previousUrl === undefined) delete process.env.ADM_LIFECYCLE_URL;
    else process.env.ADM_LIFECYCLE_URL = previousUrl;
    if (previousIdentity === undefined)
      delete process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE;
    else process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE = previousIdentity;
    await authority.close();
    await rm(directory, { recursive: true });
  }
});

test("shared provider auth survives authority restart and logout is visible to every client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-auth-"));
  const authPath = join(directory, "auth.json");
  const start = async () => {
    const authority = await createProviderAuthAuthority({
      authPath,
      configure(runtime) {
        runtime.registerNativeProvider({
          id: "adm-synthetic",
          name: "ADM synthetic",
          auth: {
            apiKey: {
              name: "Synthetic key",
              login: async (interaction) => ({
                type: "api_key",
                key: await interaction.prompt({
                  type: "secret",
                  message: "Synthetic key",
                }),
              }),
              resolve: async ({ credential }) =>
                credential?.key
                  ? { auth: { apiKey: credential.key } }
                  : undefined,
            },
          },
          getModels: () => [],
          stream: () => {
            throw new Error("not used");
          },
          streamSimple: () => {
            throw new Error("not used");
          },
        });
      },
    });
    await new Promise((resolve) =>
      authority.server.listen(0, "127.0.0.1", resolve),
    );
    return {
      authority,
      url: `http://127.0.0.1:${authority.server.address().port}`,
    };
  };
  const request = (url, path, method = "GET", body) =>
    fetch(`${url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });

  let first;
  try {
    first = await start();
    const login = await request(first.url, "/v1/provider-auth/login", "POST", {
      provider: "adm-synthetic",
      type: "api_key",
    });
    assert.equal(login.status, 202);
    const { operationId } = await login.json();
    const eventsPath = `/v1/provider-auth/login/${operationId}/events`;
    const promptResponse = await request(first.url, eventsPath);
    const { event: promptEvent, done: promptDone } =
      await promptResponse.json();
    assert.equal(promptDone, false);
    assert.equal(promptEvent.type, "prompt");
    assert.equal(promptEvent.prompt.message, "Synthetic key");
    assert.ok(promptEvent.promptId);
    const wrongReply = await request(
      first.url,
      `/v1/provider-auth/login/${operationId}/reply`,
      "POST",
      {
        promptId: "not-the-active-prompt",
        value: "synthetic-shared-secret",
      },
    );
    assert.equal(wrongReply.status, 409);
    const reply = await request(
      first.url,
      `/v1/provider-auth/login/${operationId}/reply`,
      "POST",
      {
        promptId: promptEvent.promptId,
        value: "synthetic-shared-secret",
      },
    );
    assert.equal(reply.status, 200);
    const complete = await request(first.url, eventsPath);
    assert.deepEqual(await complete.json(), {
      event: { type: "complete" },
      done: true,
    });
    const [existingAgent, secondAgent] = await Promise.all([
      request(first.url, "/v1/provider-auth/resolve/adm-synthetic"),
      request(first.url, "/v1/provider-auth/resolve/adm-synthetic"),
    ]);
    assert.deepEqual(await existingAgent.json(), {
      auth: { apiKey: "synthetic-shared-secret" },
    });
    assert.deepEqual(await secondAgent.json(), {
      auth: { apiKey: "synthetic-shared-secret" },
    });
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    const cancelledLogin = await request(
      first.url,
      "/v1/provider-auth/login",
      "POST",
      {
        provider: "adm-synthetic",
        type: "api_key",
      },
    );
    const { operationId: cancelledId } = await cancelledLogin.json();
    const pendingPrompt = await request(
      first.url,
      `/v1/provider-auth/login/${cancelledId}/events`,
    );
    assert.equal((await pendingPrompt.json()).event.type, "prompt");
    const cancel = await request(
      first.url,
      `/v1/provider-auth/login/${cancelledId}`,
      "DELETE",
    );
    assert.equal(cancel.status, 200);
    const retainedAuth = await request(
      first.url,
      "/v1/provider-auth/resolve/adm-synthetic",
    );
    assert.deepEqual(await retainedAuth.json(), {
      auth: { apiKey: "synthetic-shared-secret" },
    });
    await first.authority.close();

    first = await start();
    const afterRestart = await request(
      first.url,
      "/v1/provider-auth/resolve/adm-synthetic",
    );
    assert.deepEqual(await afterRestart.json(), {
      auth: { apiKey: "synthetic-shared-secret" },
    });
    const logout = await request(
      first.url,
      "/v1/provider-auth/logout",
      "POST",
      {
        provider: "adm-synthetic",
      },
    );
    assert.equal(logout.status, 200);
    const afterLogout = await request(
      first.url,
      "/v1/provider-auth/resolve/adm-synthetic",
    );
    assert.equal(afterLogout.status, 401);
    assert.equal(
      (await afterLogout.json()).error.code,
      "PROVIDER_AUTH_REQUIRED",
    );
  } finally {
    if (first) await first.authority.close();
    await rm(directory, { recursive: true });
  }
});

test("concurrent OAuth resolution persists one rotated refresh token before returning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-refresh-"));
  const authPath = join(directory, "auth.json");
  let refreshes = 0;
  const configure = (runtime) =>
    runtime.registerNativeProvider({
      id: "adm-refresh",
      name: "ADM refresh fixture",
      auth: {
        oauth: {
          name: "Synthetic OAuth",
          login: async () => ({
            type: "oauth",
            refresh: "refresh-initial",
            access: "access-expired",
            expires: Date.now() - 1,
          }),
          refresh: async (credential) => {
            refreshes += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              ...credential,
              refresh: "refresh-rotated",
              access: "access-current",
              expires: Date.now() + 60 * 60 * 1000,
            };
          },
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
    });
  const start = async () => {
    const authority = await createProviderAuthAuthority({
      authPath,
      configure,
    });
    await new Promise((resolve) =>
      authority.server.listen(0, "127.0.0.1", resolve),
    );
    return {
      authority,
      url: `http://127.0.0.1:${authority.server.address().port}`,
    };
  };
  const request = (url, path, method = "GET", body) =>
    fetch(`${url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  let active;
  try {
    active = await start();
    const login = await request(active.url, "/v1/provider-auth/login", "POST", {
      provider: "adm-refresh",
      type: "oauth",
    });
    const { operationId } = await login.json();
    const complete = await request(
      active.url,
      `/v1/provider-auth/login/${operationId}/events`,
    );
    assert.deepEqual(await complete.json(), {
      event: { type: "complete" },
      done: true,
    });
    const [left, right] = await Promise.all([
      request(active.url, "/v1/provider-auth/resolve/adm-refresh"),
      request(active.url, "/v1/provider-auth/resolve/adm-refresh"),
    ]);
    assert.deepEqual(await left.json(), {
      auth: { apiKey: "access-current" },
      source: "OAuth",
    });
    assert.deepEqual(await right.json(), {
      auth: { apiKey: "access-current" },
      source: "OAuth",
    });
    assert.equal(refreshes, 1);
    assert.match(await readFile(authPath, "utf8"), /refresh-rotated/);
    await active.authority.close();

    active = await start();
    const afterRestart = await request(
      active.url,
      "/v1/provider-auth/resolve/adm-refresh",
    );
    assert.deepEqual(await afterRestart.json(), {
      auth: { apiKey: "access-current" },
      source: "OAuth",
    });
    assert.equal(refreshes, 1);
  } finally {
    if (active) await active.authority.close();
    await rm(directory, { recursive: true });
  }
});

test("two existing and a new agent stream use shared auth without local or ambient fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-agent-"));
  const authPath = join(directory, "auth.json");
  const identityPath = join(directory, "pod-token");
  await (
    await import("node:fs/promises")
  ).writeFile(identityPath, "synthetic-pod-identity");
  let authority;
  const savedUrl = process.env.ADM_LIFECYCLE_URL;
  const savedToken = process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE;
  const savedAmbient = process.env.ADM_SYNTHETIC_API_KEY;
  try {
    authority = await createProviderAuthAuthority({
      authPath,
      configure(runtime) {
        runtime.registerNativeProvider({
          id: "adm-agent-test",
          name: "ADM agent fixture",
          auth: {
            apiKey: {
              name: "Synthetic key",
              login: async () => ({
                type: "api_key",
                key: "synthetic-shared-secret",
              }),
              resolve: async ({ credential }) =>
                credential?.key
                  ? { auth: { apiKey: credential.key } }
                  : undefined,
            },
          },
          getModels: () => [],
          stream: () => {
            throw new Error("not used");
          },
          streamSimple: () => {
            throw new Error("not used");
          },
        });
      },
    });
    await new Promise((resolve) =>
      authority.server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${authority.server.address().port}`;
    process.env.ADM_LIFECYCLE_URL = url;
    process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE = identityPath;
    process.env.ADM_SYNTHETIC_API_KEY = "synthetic-ambient-secret";
    const { createAssistantMessageEventStream } =
      await import("@earendil-works/pi-ai");
    const { configureSharedProviderAuth } = await import("../src/models.ts");
    const { workspaceCredentialRuntime, workspacePiAuthPath } =
      await import("../src/credentials.ts");
    const observedApiKeys = [];
    const observedIdentityTokens = [];
    authority.server.on("request", (request) => {
      if (
        request.method === "POST" &&
        request.url === "/v1/provider-auth/resolve"
      )
        observedIdentityTokens.push(request.headers.authorization);
    });
    let providerRequests = 0;
    const model = {
      id: "synthetic-model",
      name: "Synthetic model",
      api: "adm-agent-test-api",
      provider: "adm-agent-test",
      baseUrl: "https://provider.invalid/v1",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: 1000,
      maxTokens: 100,
    };
    const createAgentRuntime = async (name) => {
      const workspaceRoot = join(directory, name);
      const authPath = workspacePiAuthPath(workspaceRoot);
      await mkdir(join(workspaceRoot, ".adm", "pi"), { recursive: true });
      await writeFile(
        authPath,
        JSON.stringify({
          "adm-agent-test": {
            type: "oauth",
            access: "stale-local-access",
            refresh: "stale-local-refresh",
            expires: Date.now() + 60 * 60 * 1000,
          },
        }),
      );
      const runtime = await workspaceCredentialRuntime(workspaceRoot, {
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider({
        id: "adm-agent-test",
        name: "ADM agent fixture",
        auth: {
          apiKey: {
            name: "ADM_SYNTHETIC_API_KEY",
            resolve: async ({ ctx }) => {
              const key = await ctx.env("ADM_SYNTHETIC_API_KEY");
              return key ? { auth: { apiKey: key } } : undefined;
            },
          },
        },
        getModels: () => [model],
        stream: () => {
          throw new Error("not used");
        },
        streamSimple: (_model, _context, options) => {
          providerRequests += 1;
          observedApiKeys.push(options.apiKey);
          if (!options.apiKey)
            throw new Error("provider request has no authentication");
          const stream = createAssistantMessageEventStream();
          stream.end({
            role: "assistant",
            content: [{ type: "text", text: "accepted" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          });
          return stream;
        },
      });
      await configureSharedProviderAuth(runtime, ["adm-agent-test"]);
      return runtime;
    };
    const existingRuntimes = await Promise.all([
      createAgentRuntime("existing-one"),
      createAgentRuntime("existing-two"),
    ]);
    for (const runtime of existingRuntimes) {
      const missing = await runtime.completeSimple(model, {
        messages: [
          {
            role: "user",
            content: "must fail before login",
            timestamp: Date.now(),
          },
        ],
      });
      assert.equal(missing.stopReason, "error");
      assert.match(missing.errorMessage, /Provider is not authenticated/);
    }
    assert.equal(providerRequests, 0);

    await writeFile(identityPath, "synthetic-projected-identity-one");
    const login = await fetch(`${url}/v1/provider-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "adm-agent-test", type: "api_key" }),
    });
    const { operationId } = await login.json();
    const complete = await fetch(
      `${url}/v1/provider-auth/login/${operationId}/events`,
    );
    assert.deepEqual(await complete.json(), {
      event: { type: "complete" },
      done: true,
    });

    for (const runtime of existingRuntimes) {
      const response = await runtime.completeSimple(model, {
        messages: [
          {
            role: "user",
            content: "shared provider request",
            timestamp: Date.now(),
          },
        ],
      });
      assert.equal(response.content[0].text, "accepted");
    }
    await writeFile(identityPath, "synthetic-projected-identity-rotated");
    const newRuntime = await createAgentRuntime("new-agent");
    const newResponse = await newRuntime.completeSimple(model, {
      messages: [
        {
          role: "user",
          content: "new agent shared provider request",
          timestamp: Date.now(),
        },
      ],
    });
    assert.equal(newResponse.content[0].text, "accepted");
    assert.deepEqual(observedApiKeys, Array(3).fill("synthetic-shared-secret"));
    assert.deepEqual(observedIdentityTokens.slice(-3), [
      "Bearer synthetic-projected-identity-one",
      "Bearer synthetic-projected-identity-one",
      "Bearer synthetic-projected-identity-rotated",
    ]);

    await fetch(`${url}/v1/provider-auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "adm-agent-test" }),
    });
    const failed = await existingRuntimes[0].completeSimple(model, {
      messages: [
        {
          role: "user",
          content: "must fail after logout",
          timestamp: Date.now(),
        },
      ],
    });
    assert.equal(failed.stopReason, "error");
    assert.match(failed.errorMessage, /Provider is not authenticated/);
    assert.equal(providerRequests, 3);
  } finally {
    if (savedUrl === undefined) delete process.env.ADM_LIFECYCLE_URL;
    else process.env.ADM_LIFECYCLE_URL = savedUrl;
    if (savedToken === undefined)
      delete process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE;
    else process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE = savedToken;
    if (savedAmbient === undefined) delete process.env.ADM_SYNTHETIC_API_KEY;
    else process.env.ADM_SYNTHETIC_API_KEY = savedAmbient;
    if (authority) await authority.close();
    await rm(directory, { recursive: true });
  }
});

test("a pending login cannot persist after its lifecycle owner epoch changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-auth-fence-login-"));
  const authPath = join(directory, "auth.json");
  const owner = { epoch: 41 };
  let beginLogin;
  let finishLogin;
  let loginCount = 0;
  const loginStarted = new Promise((resolve) => (beginLogin = resolve));
  const provider = {
    id: "adm-fenced-login",
    name: "Fenced login fixture",
    auth: {
      apiKey: {
        name: "Fenced key",
        login: async () => {
          loginCount += 1;
          if (loginCount > 1)
            return {
              type: "api_key",
              key: "new-owner-login-secret",
            };
          beginLogin();
          return new Promise((resolve) => (finishLogin = resolve));
        },
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key } } : undefined,
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
  const createAuthority = async () => {
    const authority = await createProviderAuthAuthority({
      authPath,
      ownerGuard: createOwnerEpochGuard(async () => owner.epoch),
      configure: (runtime) => runtime.registerNativeProvider(provider),
    });
    await new Promise((resolve) => authority.server.listen(0, "127.0.0.1", resolve));
    return {
      authority,
      url: `http://127.0.0.1:${authority.server.address().port}`,
    };
  };
  const post = (url, path, value) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  let active = await createAuthority();
  try {
    assert.equal((await fetch(`${active.url}/health`)).status, 200);
    const start = await post(active.url, "/v1/provider-auth/login", {
      provider: provider.id,
      type: "api_key",
    });
    const { operationId } = await start.json();
    await loginStarted;

    const pollAccepted = new Promise((resolve) => {
      active.authority.server.once("request", (request) => {
        if (request.url === `/v1/provider-auth/login/${operationId}/events`)
          resolve();
      });
    });
    const pendingEvent = fetch(
      `${active.url}/v1/provider-auth/login/${operationId}/events`,
    );
    await pollAccepted;
    owner.epoch = 42;
    finishLogin({ type: "api_key", key: "must-not-persist-after-fence-loss" });
    const eventResponse = await pendingEvent;
    assert.equal(eventResponse.status, 200);
    assert.deepEqual((await eventResponse.json()).event, {
      type: "error",
      message:
        "adm-fenced-login: login failed (Lifecycle provider-auth owner fence is not current)",
    });
    assert.equal((await fetch(`${active.url}/health`)).status, 503);
    assert.doesNotMatch(await readFile(authPath, "utf8"), /must-not-persist/);

    await active.authority.close();
    active = await createAuthority();
    assert.equal((await fetch(`${active.url}/health`)).status, 200);
    const accepted = await post(active.url, "/v1/provider-auth/login", {
      provider: provider.id,
      type: "api_key",
    });
    const restartedOperation = (await accepted.json()).operationId;
    const completion = await fetch(
      `${active.url}/v1/provider-auth/login/${restartedOperation}/events`,
    );
    assert.equal((await completion.json()).event.type, "complete");
    assert.match(await readFile(authPath, "utf8"), /new-owner-login-secret/);
  } finally {
    await active.authority.close();
    await rm(directory, { recursive: true });
  }
});

test("OAuth refresh and logout recheck the owner epoch while the credential lock is held", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-auth-fence-mutation-"));
  const authPath = join(directory, "auth.json");
  const providerId = "adm-fenced-oauth";
  await writeFile(
    authPath,
    JSON.stringify({
      [providerId]: {
        type: "oauth",
        access: "old-access-secret",
        refresh: "old-refresh-secret",
        expires: Date.now() - 1000,
      },
    }),
  );
  const owner = { epoch: 73, advanceOnNextRead: false };
  let beginRefresh;
  let finishRefresh;
  const refreshStarted = new Promise((resolve) => (beginRefresh = resolve));
  const provider = {
    id: providerId,
    name: "Fenced OAuth fixture",
    auth: {
      oauth: {
        name: "Fenced OAuth",
        isSubscription: true,
        login: async () => {
          throw new Error("login not used");
        },
        refresh: async () => {
          beginRefresh();
          return new Promise((resolve) => (finishRefresh = resolve));
        },
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
  const createAuthority = async () => {
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
      configure: (runtime) => runtime.registerNativeProvider(provider),
      // This test drives the request-path refresh; the stored credential is
      // already expired, so a real schedule would refresh it on start.
      refreshScheduler: {
        now: () => Date.now(),
        setTimer: () => ({}),
        clearTimer: () => {},
      },
    });
    await new Promise((resolve) => authority.server.listen(0, "127.0.0.1", resolve));
    return {
      authority,
      url: `http://127.0.0.1:${authority.server.address().port}`,
    };
  };
  let active = await createAuthority();
  try {
    assert.equal((await fetch(`${active.url}/health`)).status, 200);
    const refreshRequest = fetch(
      `${active.url}/v1/provider-auth/resolve/${providerId}`,
    );
    await refreshStarted;
    owner.epoch = 74;
    finishRefresh({
      type: "oauth",
      access: "rotated-access-secret",
      refresh: "rotated-refresh-secret",
      expires: Date.now() + 60 * 60 * 1000,
    });
    const refreshResponse = await refreshRequest;
    assert.equal(refreshResponse.status, 400);
    const afterRefresh = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(afterRefresh[providerId].access, "old-access-secret");
    assert.equal(afterRefresh[providerId].refresh, "old-refresh-secret");
    assert.equal((await fetch(`${active.url}/health`)).status, 503);

    await active.authority.close();
    owner.epoch = 75;
    active = await createAuthority();
    assert.equal((await fetch(`${active.url}/health`)).status, 200);
    owner.advanceOnNextRead = true;
    const logoutResponse = await fetch(`${active.url}/v1/provider-auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: providerId }),
    });
    assert.equal(logoutResponse.status, 400);
    const afterLogout = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(afterLogout[providerId].refresh, "old-refresh-secret");
  } finally {
    await active.authority.close();
    await rm(directory, { recursive: true });
  }
});

test("shared auth retries a controller transport failure only after its lease gate reopens", async (t) => {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-gated-retry-"));
  const authPath = join(directory, "auth.json");
  const identityPath = join(directory, "pod-token");
  await writeFile(identityPath, "synthetic-pod-identity");
  const providerId = "adm-gated-auth";
  let providerRequests = 0;
  const model = {
    id: "gated-model",
    name: "Gated model",
    api: "adm-gated-api",
    provider: providerId,
    baseUrl: "https://provider.invalid/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 1000,
    maxTokens: 100,
  };
  const provider = {
    id: providerId,
    name: "Gated provider",
    auth: {
      apiKey: {
        name: "Synthetic key",
        login: async () => ({ type: "api_key", key: "gated-shared-secret" }),
        resolve: async ({ credential }) => credential?.key
          ? { auth: { apiKey: credential.key } }
          : undefined,
      },
    },
    getModels: () => [model],
    stream: () => { throw new Error("not used"); },
    streamSimple: (_model, _context, options) => {
      providerRequests += 1;
      assert.equal(options.apiKey, "gated-shared-secret");
      const stream = createAssistantMessageEventStream();
      stream.end({
        role: "assistant",
        content: [{ type: "text", text: "accepted after authority recovery" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      return stream;
    },
  };
  const authority = await createProviderAuthAuthority({
    authPath,
    configure(runtime) { runtime.registerNativeProvider(provider); },
  });
  const savedUrl = process.env.ADM_LIFECYCLE_URL;
  const savedIdentity = process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE;
  let resolveAttempts = 0;
  let suspendedResolve;
  const suspended = new Promise((resolve) => { suspendedResolve = resolve; });
  let available = true;
  let releaseWaiters = [];
  const availability = {
    wait(signal) {
      signal?.throwIfAborted();
      if (available) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener("abort", aborted);
          resolve();
        };
        const aborted = () => {
          releaseWaiters = releaseWaiters.filter((item) => item !== waiter);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", aborted, { once: true });
        releaseWaiters.push(waiter);
      });
    },
    suspend(error) {
      available = false;
      suspendedResolve(error);
    },
  };
  const proxy = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/v1/runtime/check") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ valid: true, holder: "same-pod-uid", fencingToken: 7 }));
      return;
    }
    if (request.url === "/v1/provider-auth/resolve" && resolveAttempts++ === 0) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "controller updating" } }));
      return;
    }
    const upstream = await fetch(`http://127.0.0.1:${authority.server.address().port}${request.url}`, {
      method: request.method,
      headers: request.headers.authorization
        ? { authorization: request.headers.authorization, "content-type": "application/json" }
        : { "content-type": "application/json" },
      ...(body ? { body } : {}),
    });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(await upstream.text());
  });
  try {
    await new Promise((resolve) => authority.server.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${proxy.address().port}`;
    process.env.ADM_LIFECYCLE_URL = url;
    process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE = identityPath;
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const { configureSharedProviderAuth } = await import("../src/models.ts");
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
    runtime.registerNativeProvider(provider);
    await configureSharedProviderAuth(runtime, [providerId], { availability });
    const login = await fetch(`http://127.0.0.1:${authority.server.address().port}/v1/provider-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: providerId, type: "api_key" }),
    });
    const { operationId } = await login.json();
    await fetch(`http://127.0.0.1:${authority.server.address().port}/v1/provider-auth/login/${operationId}/events`);

    const pending = runtime.completeSimple(model, {
      messages: [{ role: "user", content: "wait through controller update", timestamp: Date.now() }],
    });
    const firstOutcome = await Promise.race([
      suspended.then((error) => ({ kind: "suspended", error })),
      pending.then(
        (result) => ({ kind: "completed", result }),
        (error) => ({ kind: "failed", error }),
      ),
    ]);
    assert.equal(firstOutcome.kind, "suspended");
    const outage = await suspended;
    assert.match(String(outage), /503/);
    assert.equal(providerRequests, 0, "a provider request cannot escape while authority is suspended");
    assert.equal(resolveAttempts, 1, "shared auth resolve is attempted only once before recovery");
    const check = await fetch(`${url}/v1/runtime/check`, { method: "POST" });
    assert.deepEqual(await check.json(), { valid: true, holder: "same-pod-uid", fencingToken: 7 });
    available = true;
    for (const release of releaseWaiters) release();
    releaseWaiters = [];
    const result = await pending;
    assert.equal(result.stopReason, "stop", JSON.stringify(result));
    assert.equal(result.content[0].text, "accepted after authority recovery");
    assert.equal(resolveAttempts, 2);
    assert.equal(providerRequests, 1);

    const logout = await fetch(`http://127.0.0.1:${authority.server.address().port}/v1/provider-auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: providerId }),
    });
    assert.equal(logout.status, 200);
    const missing = await runtime.completeSimple(model, {
      messages: [{ role: "user", content: "do not retry missing auth", timestamp: Date.now() }],
    });
    assert.equal(missing.stopReason, "error");
    assert.match(missing.errorMessage, /Provider is not authenticated/);
    assert.equal(resolveAttempts, 3, "401 is terminal and does not enter the availability retry loop");
    assert.equal(providerRequests, 1);
  } finally {
    if (savedUrl === undefined) delete process.env.ADM_LIFECYCLE_URL;
    else process.env.ADM_LIFECYCLE_URL = savedUrl;
    if (savedIdentity === undefined) delete process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE;
    else process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE = savedIdentity;
    await new Promise((resolve) => proxy.close(resolve));
    await authority.close();
    await rm(directory, { recursive: true });
  }
});

test("provider-auth answers kubelet liveness on the Pod IP while credentials stay loopback-only (TASK-94)", async (t) => {
  const podIp = Object.values(networkInterfaces())
    .flat()
    .find((address) => address.family === "IPv4" && !address.internal)?.address;
  assert.ok(podIp, "the test needs a non-loopback IPv4 address to stand in for the Pod IP");
  const freePort = () =>
    new Promise((resolve) => {
      const server = createServer().listen(0, "0.0.0.0", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
  const port = await freePort();
  const probePort = await freePort();
  // The authority serves only while a lifecycle owner answers; stand one in
  // so the test does not depend on a real lifecycle holding 7433.
  const lifecycle = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", ownerEpoch: 1 }));
  });
  await new Promise((resolve) => lifecycle.listen(0, "127.0.0.1", resolve));
  t.after(() => lifecycle.close());
  const directory = await mkdtemp(join(tmpdir(), "adm-provider-auth-probe-"));
  const child = spawn(
    process.execPath,
    [
      new URL("../src/provider-auth-main.ts", import.meta.url).pathname,
      "--port", String(port),
      "--probe-port", String(probePort),
      "--auth-path", join(directory, "auth.json"),
      "--lifecycle-url", `http://127.0.0.1:${lifecycle.address().port}`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(async () => {
    child.kill("SIGKILL");
    await rm(directory, { recursive: true });
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  while (!output.includes("provider-auth liveness listening")) {
    const [chunk] = await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(([code]) => {
        throw new Error(`provider-auth exited ${code} before listening: ${output}`);
      }),
    ]);
    output += chunk;
  }
  const reachable = async (url) => {
    try {
      return (await fetch(url)).status;
    } catch {
      return "refused";
    }
  };
  assert.equal(await reachable(`http://${podIp}:${probePort}/health`), 200);
  assert.equal(await reachable(`http://${podIp}:${probePort}/v1/provider-auth/providers`), 404);
  assert.equal(await reachable(`http://${podIp}:${port}/health`), "refused");
  assert.equal(await reachable(`http://127.0.0.1:${port}/v1/provider-auth/providers`), 200);
});
