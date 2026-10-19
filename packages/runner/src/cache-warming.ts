import type {
  Api,
  AssistantMessage,
  Context as ModelContext,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import type { CommitPublication } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CacheWarmingMode } from "./workspace-settings.ts";

type WarmStatus = {
  state: "inactive" | "scheduled" | "refreshing";
  reason?: string;
  nextWarmAt?: number;
  decision?: {
    phase: "streaming" | "idle";
    warmCost: number;
    missCost: number;
    continuationProbability: number;
    expectedSavings: number;
    economicsAvailable: boolean;
    action: "warm" | "stop";
  };
  extensionOverride?: boolean;
};

type WarmUsage = {
  provider: string;
  model: string;
  usage: Usage;
  timestamp: string;
};

type CacheWarmerApi = {
  start(
    request: {
      model: Model<Api>;
      context: ModelContext;
      options: ModelsSimpleStreamOptions;
    },
    isCurrent: () => boolean,
  ): void;
  onAgentSettled(): void;
  onModeChanged(): void;
  cancel(): void;
  readonly status: WarmStatus;
  onWarmed?: (entry: { provider: string; model: string; usage: Usage }) => void;
};

type CacheWarmerModule = {
  CacheWarmer: new (
    models: Pick<Models, "streamSimple">,
    sessionManager: {
      getBranch(): Array<{ type: string; message?: AssistantMessage }>;
      appendUsage(
        kind: string,
        provider: string,
        model: string,
        usage: Usage,
        note?: string,
      ): { provider: string; model: string; usage: Usage };
    },
    getMode: () => CacheWarmingMode,
  ) => CacheWarmerApi;
};

type PendingWarmRequest = {
  model: Model<Api>;
  context: ModelContext;
  options: ModelsSimpleStreamOptions;
  message?: AssistantMessage;
};

export class WorkspaceCacheWarming {
  readonly models: Models;
  private getMode: () => CacheWarmingMode;
  private assertActive: (signal?: AbortSignal) => Promise<void>;
  private report: (error: unknown) => void;
  private getCurrentModel: () => string | undefined;
  private getCurrentConversationId: () => number | undefined;
  private warmer?: CacheWarmerApi;
  private requests = new WeakMap<AssistantMessage, PendingWarmRequest>();
  private currentVersion = 0;
  private lastUsage?: WarmUsage;
  private awaitingAssistant?: AssistantMessage;
  private branch: Array<{ type: string; message?: AssistantMessage }> = [];
  private init: Promise<void> = Promise.resolve();
  private conversation?: Conversation;

  private constructor(
    models: Models,
    getMode: () => CacheWarmingMode,
    assertActive: (signal?: AbortSignal) => Promise<void>,
    report: (error: unknown) => void,
    getCurrentModel: () => string | undefined,
    getCurrentConversationId: () => number | undefined,
  ) {
    this.models = models;
    this.getMode = getMode;
    this.assertActive = assertActive;
    this.report = report;
    this.getCurrentModel = getCurrentModel;
    this.getCurrentConversationId = getCurrentConversationId;
  }

  static open(
    models: Models,
    getMode: () => CacheWarmingMode,
    assertActive: (signal?: AbortSignal) => Promise<void>,
    report: (error: unknown) => void,
    getCurrentModel: () => string | undefined,
    getCurrentConversationId: () => number | undefined,
  ) {
    return new WorkspaceCacheWarming(
      models,
      getMode,
      assertActive,
      report,
      getCurrentModel,
      getCurrentConversationId,
    );
  }

  get status(): WarmStatus & { lastUsage?: WarmUsage } {
    return {
      ...(this.warmer?.status ?? {
        state: "inactive" as const,
        reason: "cache warming initializing",
      }),
      ...(this.lastUsage ? { lastUsage: this.lastUsage } : {}),
    };
  }

  async ready() {
    await this.init;
  }

  async attachConversation(conversation: Conversation) {
    if (this.conversation) await this.cancel();
    this.conversation = conversation;
    this.lastUsage = undefined;
    this.branch = [];
    this.init = this.install();
    await this.init;
  }

  async afterResponse(message: AssistantMessage, conversationId: number) {
    await this.init;
    const request = this.requests.get(message);
    this.requests.delete(message);
    if (
      !request ||
      conversationId !== Number(this.conversation?.id) ||
      conversationId !== this.getCurrentConversationId() ||
      message.stopReason === "error" ||
      message.stopReason === "aborted"
    )
      return;
    request.message = message;
    this.branch = [{ type: "message", message }];
    this.awaitingAssistant = message;
    const version = ++this.currentVersion;
    const modelId = `${request.model.provider}/${request.model.id}`;
    this.warmer!.start(
      request,
      () =>
        this.currentVersion === version &&
        this.getMode() !== "off" &&
        this.currentModel() === modelId &&
        this.getCurrentConversationId() === Number(this.conversation?.id),
    );
    if (message.stopReason !== "toolUse") this.warmer!.onAgentSettled();
  }

  async modeChanged() {
    await this.init;
    this.currentVersion++;
    this.warmer?.onModeChanged();
  }

  async cancel() {
    this.currentVersion++;
    await this.init;
    this.warmer?.cancel();
  }

  observeCommit(publication: CommitPublication) {
    const conversation = this.conversation;
    if (!conversation) return;
    let contextChanged = false;
    for (const change of publication.changes) {
      if (
        change.type !== "entry" ||
        change.value.conversationId !== conversation.id
      )
        continue;
      const entry = change.value;
      if (entry.kind === "adm.cache_warm") continue;
      const response = entry.model?.find(
        (message): message is AssistantMessage => message.role === "assistant",
      );
      if (
        response &&
        this.awaitingAssistant &&
        sameAssistant(response, this.awaitingAssistant)
      ) {
        this.awaitingAssistant = undefined;
        continue;
      }
      if (
        entry.model?.length ||
        entry.head !== undefined ||
        entry.edits?.length
      )
        contextChanged = true;
    }
    if (contextChanged) void this.cancel();
  }

  private currentModel() {
    return this.getCurrentModel();
  }

  private async install() {
    const packageUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const moduleUrl = new URL("./core/cache-warmer.js", packageUrl).href;
    const { CacheWarmer } = (await import(moduleUrl)) as CacheWarmerModule;
    const conversation = this.conversation;
    if (!conversation) return;
    const entries = await conversation.entries(
      { order: "descending" },
      1000,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const previousAssistant = entries.items
      .flatMap(
        (entry) =>
          entry.model
            ?.filter(
              (message): message is AssistantMessage =>
                message.role === "assistant",
            )
            .map((message) => ({ type: "message", message })) ?? [],
      )
      .at(0);
    this.branch = previousAssistant ? [previousAssistant] : [];
    const usageEntries = await conversation.entries(
      { order: "descending" },
      1000,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const lastWarm = usageEntries.items.find(
      (entry) => entry.kind === "adm.cache_warm",
    )?.data as Partial<WarmUsage> | undefined;
    if (
      lastWarm &&
      typeof lastWarm.provider === "string" &&
      typeof lastWarm.model === "string" &&
      lastWarm.usage &&
      typeof lastWarm.timestamp === "string"
    )
      this.lastUsage = lastWarm as WarmUsage;
    const owner = this;
    const streamModels: Pick<Models, "streamSimple"> = {
      streamSimple(model, context, options) {
        const conversation = owner.conversation;
        const conversationId = Number(conversation?.id);
        return lazyStream(model, async () => {
          try {
            await owner.assertActive(options?.signal);
          } catch (error) {
            owner.report(error);
            void owner.cancel();
            throw error;
          }
          const stream = owner.models.streamSimple(model, context, options);
          return {
            async *[Symbol.asyncIterator]() {
              try {
                await owner.assertActive(options?.signal);
                for await (const event of stream) {
                  if (event.type === "done")
                    await owner.persistUsage(
                      "cache_warm",
                      event.message.provider,
                      event.message.responseModel ?? event.message.model,
                      event.message.usage,
                      new Date().toISOString(),
                      options?.signal,
                      conversation,
                      conversationId,
                    );
                  else if (event.type === "error") {
                    owner.report(
                      event.error.errorMessage ??
                        `Cache warming provider request ${event.error.stopReason}`,
                    );
                    void owner.cancel();
                  }
                  yield event;
                }
              } catch (error) {
                owner.report(error);
                void owner.cancel();
                throw error;
              }
            },
          };
        });
      },
    };
    this.warmer = new CacheWarmer(
      streamModels,
      {
        getBranch: () => owner.branch,
        appendUsage: (_kind, provider, model, usage) => ({
          provider,
          model,
          usage,
        }),
      },
      this.getMode,
    );
  }

  private async persistUsage(
    kind: string,
    provider: string,
    model: string,
    usage: Usage,
    timestamp: string,
    signal?: AbortSignal,
    conversation?: Conversation,
    conversationId?: number,
  ) {
    try {
      await this.assertActive(signal);
      if (
        !conversation ||
        conversation !== this.conversation ||
        conversationId !== this.getCurrentConversationId() ||
        signal?.aborted
      )
        return;
      await conversation.commit(
        (tx) =>
          tx.appendEntry(conversation.id, {
            kind: "adm.cache_warm",
            data: {
              kind,
              provider,
              model,
              usage: usage as unknown as JsonValue,
              timestamp,
            },
          }),
        BACKGROUND_CONTEXT,
      );
      this.lastUsage = { provider, model, usage, timestamp };
    } catch (error) {
      this.report(error);
      void this.cancel();
      throw error;
    }
  }

  wrapModels(): Models {
    const owner = this;
    return new Proxy(this.models, {
      get(target, property) {
        if (property === "streamSimple")
          return (
            model: Model<Api>,
            context: ModelContext,
            options?: ModelsSimpleStreamOptions,
          ) => {
            const stream = target.streamSimple(model, context, options);
            return new Proxy(stream, {
              get(source, key) {
                if (key === "result")
                  return async () => {
                    const message = await source.result();
                    if (
                      options?.cacheRetention !== "none" &&
                      message.stopReason !== "error" &&
                      message.stopReason !== "aborted"
                    )
                      owner.requests.set(message, {
                        model,
                        context,
                        options: options ?? {},
                      });
                    return message;
                  };
                const value = Reflect.get(source, key, source);
                return typeof value === "function" ? value.bind(source) : value;
              },
            });
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

function sameAssistant(left: AssistantMessage, right: AssistantMessage) {
  return (
    left.timestamp === right.timestamp &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.stopReason === right.stopReason
  );
}
