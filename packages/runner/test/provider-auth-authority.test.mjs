import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { createProviderAuthAuthority } from "../src/provider-auth-authority.ts";

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
    authority.server.on("request", (request) =>
      observedIdentityTokens.push(request.headers.authorization),
    );
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
