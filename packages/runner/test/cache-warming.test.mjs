import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { WorkspaceCacheWarming } from "../src/cache-warming.ts";

function fixtureConversation() {
  const entries = [
    {
      id: 1,
      conversationId: 1,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          api: "faux",
          provider: "faux",
          model: "cache-fixture",
          content: [{ type: "text", text: "prior" }],
          usage: {
            input: 1000,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1001,
            cost: {
              input: 1,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 1,
            },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      ],
    },
  ];
  return {
    id: 1,
    entries: async () => ({ items: [...entries] }),
    commit: async (write) =>
      write({
        appendEntry: async (conversationId, value) => {
          const entry = { id: entries.length + 1, conversationId, ...value };
          entries.push(entry);
          return entry;
        },
      }),
    stored: entries,
  };
}

test("cache warming replays the real bounded request and persists actual usage", async (t) => {
  const faux = fauxProvider({
    models: [
      {
        id: "cache-fixture",
        cost: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    tokensPerSecond: 0,
  });
  Object.assign(faux.models[0], { promptCache: { short: 20, long: 120 } });
  faux.setResponses([fauxAssistantMessage("real response")]);
  const models = createModels();
  const requests = [];
  models.setProvider({
    ...faux.provider,
    streamSimple: (model, context, options) => {
      requests.push({ model, context, options });
      return faux.provider.streamSimple(model, context, options);
    },
  });
  const conversation = fixtureConversation();
  let mode = "streaming";
  let modelIdentity = "faux/cache-fixture";
  const errors = [];
  const cache = WorkspaceCacheWarming.open(
    models,
    () => mode,
    async () => {},
    (error) => errors.push(String(error)),
    () => modelIdentity,
    () => 1,
  );
  await cache.attachConversation(conversation);
  const request = models.getModel("faux", "cache-fixture");
  assert.ok(request);
  const result = await cache
    .wrapModels()
    .streamSimple(
      request,
      { messages: [{ role: "user", content: "inspect this prompt" }] },
      { sessionId: "cache-fixture-session", maxTokens: 64 },
    )
    .result();
  await cache.afterResponse(result, 1);
  assert.equal(cache.status.state, "inactive");
  assert.equal(cache.status.reason, "agent run settled");
  mode = "idle";
  faux.appendResponses([
    fauxAssistantMessage("real response"),
    fauxAssistantMessage("bounded warm response"),
  ]);
  const idleResult = await cache
    .wrapModels()
    .streamSimple(
      request,
      { messages: [{ role: "user", content: "inspect this prompt" }] },
      { sessionId: "cache-fixture-session", maxTokens: 64 },
    )
    .result();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  await cache.afterResponse(idleResult, 1);
  assert.equal(cache.status.state, "scheduled");
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(faux.state.callCount, 3);
  assert.equal(requests[2].options.maxTokens, 1);
  assert.equal(requests[2].options.maxRetries, 0);
  assert.equal(requests[2].options.sessionId, "cache-fixture-session");
  const warm = conversation.stored.find(
    (entry) => entry.kind === "adm.cache_warm",
  );
  assert.equal(warm.data.kind, "cache_warm");
  assert.ok(warm.data.usage);
  assert.equal(cache.status.lastUsage.provider, "faux");
  assert.deepEqual(errors, []);
  await cache.cancel();
  const restarted = WorkspaceCacheWarming.open(
    models,
    () => mode,
    async () => {},
    () => {},
    () => modelIdentity,
    () => 1,
  );
  await restarted.attachConversation(conversation);
  assert.equal(restarted.status.lastUsage.provider, "faux");
  await restarted.cancel();
});

test("cache warming cancels before a request after mode, model, or lease changes", async (t) => {
  const faux = fauxProvider({
    models: [
      {
        id: "cache-fixture",
        cost: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    tokensPerSecond: 0,
  });
  Object.assign(faux.models[0], { promptCache: { short: 20, long: 120 } });
  faux.setResponses([fauxAssistantMessage("real response")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const conversation = fixtureConversation();
  let mode = "idle";
  let modelIdentity = "faux/cache-fixture";
  let fenced = false;
  const errors = [];
  const cache = WorkspaceCacheWarming.open(
    models,
    () => mode,
    async () => {
      if (fenced) throw new Error("lease expired");
    },
    (error) => errors.push(String(error)),
    () => modelIdentity,
    () => 1,
  );
  await cache.attachConversation(conversation);
  const request = models.getModel("faux", "cache-fixture");
  assert.ok(request);
  const result = await cache
    .wrapModels()
    .streamSimple(request, { messages: [{ role: "user", content: "prompt" }] })
    .result();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  await cache.afterResponse(result, 1);
  modelIdentity = "faux/changed";
  assert.equal(cache.status.state, "inactive");
  assert.equal(cache.status.reason, "conversation context changed");
  modelIdentity = "faux/cache-fixture";
  fenced = true;
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(faux.state.callCount, 1);
  assert.equal(cache.status.state, "inactive");
  assert.ok(errors.some((error) => error.includes("lease expired")));
  await cache.cancel();
});
