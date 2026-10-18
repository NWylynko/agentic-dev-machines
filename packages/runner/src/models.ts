import { createModels, type Models } from "@earendil-works/pi-ai/models";
import type { JsonValue } from "@earendil-works/chord";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { workspaceCredentialRuntime } from "./credentials.ts";
import type { SharedProviderCatalog } from "./provider-auth-authority.ts";

export async function workspaceModels(
  provider: string | undefined,
  authPath?: string,
  workspaceRoot = "/workspace",
  waitForAuthority?: (signal?: AbortSignal) => Promise<void>,
): Promise<Models> {
  if (provider !== "faux") {
    const runtime = await workspaceCredentialRuntime(workspaceRoot, {
      allowModelNetwork: true,
      ...(authPath
        ? {
            authPath,
            modelsStorePath: join(
              workspaceRoot,
              ".adm",
              "pi",
              "models-store.json",
            ),
          }
        : {}),
    });
    return configureSharedProviderAuth(runtime, undefined, {
      waitForAuthority,
    });
  }
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const answer: FauxResponseFactory = (transcript) => {
    faux.appendResponses([answer]);
    const index = transcript.messages.findLastIndex(
      (message) => message.role === "user",
    );
    const input = transcript.messages[index];
    const text =
      input?.role === "user"
        ? typeof input.content === "string"
          ? input.content
          : input.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
        : "";
    const turns = transcript.messages
      .slice(index + 1)
      .filter(
        (message) =>
          message.role === "assistant" && message.stopReason === "toolUse",
      ).length;
    const failAfterTools = text.startsWith("/faux-fail-after-tools ");
    const planPrefix = failAfterTools ? "/faux-fail-after-tools " : "/faux ";
    if (text.startsWith("/faux-fail-once ")) {
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          "Authentication credentials are invalid (faux injected failure)",
      });
    }
    if (text.startsWith("ADM bot onboarding:")) {
      if (turns === 0)
        return fauxAssistantMessage(
          fauxToolCall("sendMessage", {
            text: "What identity and purpose would you like me to have?",
          }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("I am ready for setup details.");
    }
    if (text === "/faux-inspect-system-prompt")
      return fauxAssistantMessage(
        JSON.stringify(
          transcript.messages.map((message) => ({
            role: message.role,
            content:
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
          })),
        ),
      );
    if (failAfterTools && turns > 0) {
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          "Authentication credentials are invalid after a completed tool (faux injected failure)",
      });
    }
    if (text.startsWith(planPrefix)) {
      const plan = JSON.parse(text.slice(planPrefix.length)) as {
        calls?: { tool: string; args: Record<string, JsonValue> }[];
        answer?: string;
      };
      const call = plan.calls?.[turns];
      if (call)
        return fauxAssistantMessage(fauxToolCall(call.tool, call.args), {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage(plan.answer ?? "Synthetic task complete.");
    }
    return fauxAssistantMessage(`Echo: ${text}`);
  };
  faux.setResponses([answer]);
  models.setProvider(faux.provider);
  return models;
}

export async function configureSharedProviderAuth<
  T extends {
    getProviders(): readonly { id: string }[];
    getProvider(id: string): any;
    registerNativeProvider(provider: any): void;
  },
>(
  runtime: T,
  selectedProviders?: readonly string[],
  options: {
    waitForAuthority?: (signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  const lifecycleUrl = process.env.ADM_LIFECYCLE_URL;
  if (!lifecycleUrl) return runtime;
  const identityFile =
    process.env.ADM_LIFECYCLE_IDENTITY_TOKEN_FILE ??
    "/var/run/secrets/kubernetes.io/serviceaccount/token";
  async function sharedRequest(
    path: string,
    signal?: AbortSignal,
    body?: unknown,
  ) {
    await options.waitForAuthority?.(signal);
    signal?.throwIfAborted();
    const token = (await readFile(identityFile, "utf8")).trim();
    if (!token) throw new Error("Projected lifecycle identity token is empty");
    return fetch(
      `${lifecycleUrl!.replace(/\/$/, "")}/v1/provider-auth/${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      },
    );
  }
  let catalog: SharedProviderCatalog = {};
  const catalogRequests = new Map<
    AbortSignal | undefined,
    Promise<SharedProviderCatalog>
  >();
  function sharedCatalog(signal?: AbortSignal): Promise<SharedProviderCatalog> {
    const pending = catalogRequests.get(signal);
    if (pending) return pending;
    const request = (async () => {
      const response = await sharedRequest("catalog", signal);
      if (!response.ok)
        throw new Error(
          `Shared provider catalogue failed (${response.status})`,
        );
      catalog = (await response.json()) as SharedProviderCatalog;
      return catalog;
    })();
    catalogRequests.set(signal, request);
    void request.finally(() => catalogRequests.delete(signal)).catch(() => {});
    return request;
  }
  for (const id of selectedProviders ??
    runtime.getProviders().map(({ id }) => id)) {
    const provider = runtime.getProvider(id);
    if (!provider) continue;
    const name =
      provider.auth.oauth?.name ?? provider.auth.apiKey?.name ?? provider.name;
    runtime.registerNativeProvider({
      ...provider,
      filterModels: (models: { id: string }[]) =>
        models.filter((model) => catalog[id]?.models.includes(model.id)),
      filterAllModels: (models: { id: string }[]) =>
        models.filter((model) => catalog[id]?.allModels.includes(model.id)),
      auth: {
        // Retain Pi's subscription classification. The workspace credential
        // store is empty; credential delivery and refresh stay in the authority.
        ...(provider.auth.oauth ? { oauth: provider.auth.oauth } : {}),
        apiKey: {
          name,
          check: async ({ signal }: { signal: AbortSignal }) =>
            (await sharedCatalog(signal))[id]?.auth,
          resolve: async ({ signal }: { signal: AbortSignal }) => {
            const response = await sharedRequest("resolve", signal, {
              provider: id,
            });
            if (response.status === 401)
              throw new Error("Provider is not authenticated");
            if (!response.ok)
              throw new Error(
                `Shared provider authentication failed (${response.status})`,
              );
            return await response.json();
          },
        },
      },
    });
  }
  return runtime;
}
