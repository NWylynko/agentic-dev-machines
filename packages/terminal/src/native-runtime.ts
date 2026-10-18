import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createExtensionRuntime,
  SettingsManager,
  type PromptTemplate,
  type Skill,
  type ResourceDiagnostic,
  type SourceInfo,
  type ProjectTrustDecision,
  type ProjectTrustStoreEntry,
  type ProjectTrustUpdate,
  type Theme,
  type AgentSessionEvent,
  type SessionEntry,
  type SessionInfo,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  importedPiSession,
  WorkspaceTerminal,
  type WorkspaceEvent,
} from "./terminal.ts";

type SessionModel = Model<Api>;
type WorkspaceSnapshot = ReturnType<WorkspaceTerminal["getRemoteSnapshot"]>;
type DurablePiEventListener = (
  event: AgentSessionEvent,
) => void | Promise<void>;
type ProviderMetadata = {
  id: string;
  authenticated?: boolean;
  authType?: "api_key" | "oauth";
  subscription?: boolean;
};
type ModelCatalog = {
  models?: SessionModel[];
  providers?: ProviderMetadata[];
  selected?: { provider: string; id: string };
  error?: string;
  refresh?: {
    aborted?: boolean;
    errors?: { provider: string; message: string }[];
  };
};
type WorkspaceResourceSnapshot = {
  cwd: string;
  trust: { trusted: boolean; trustRequired: boolean; source: string | null };
  themes: {
    name: string;
    path: string;
    sourceInfo: SourceInfo;
    json: unknown;
  }[];
  prompts: PromptTemplate[];
  skills: Skill[];
  agentsFiles: { path: string; content: string }[];
  extensions: {
    name: string;
    path: string;
    active: false;
    sourceInfo?: SourceInfo;
  }[];
  diagnostics: ResourceDiagnostic[];
  systemPrompt?: string;
  systemPromptSource?: { path: string };
  appendSystemPrompt: string[];
  appendSystemPromptSources?: { path: string }[];
};
type ThemeFactory = (
  json: unknown,
  mode?: string,
  sourcePath?: string,
  sourceInfo?: SourceInfo,
) => Theme;
type RemoteDurableSession = ReturnType<
  DurableInteractiveRuntime["sessionProjection"]
>;

const createThemeFromJson = (
  PiCodingAgent as typeof PiCodingAgent & { createThemeFromJson?: ThemeFactory }
).createThemeFromJson;

const entryMessages = (snapshot: WorkspaceSnapshot): SessionEntry[] => {
  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  for (const event of snapshot.events) {
    if (snapshot.role === "bot" && !["user", "message"].includes(event.kind))
      continue;
    const message = event.data?.message as AgentMessage | undefined;
    const publicBotMessage: AgentMessage | undefined =
      snapshot.role === "bot" && event.kind === "message"
        ? {
            role: "custom",
            customType: "adm.message",
            content:
              typeof event.data?.text === "string" ? event.data.text : "",
            display: true,
            details: event.data,
            timestamp: event.timestamp,
          }
        : undefined;
    const visibleMessage = publicBotMessage ?? message;
    if (
      !visibleMessage ||
      !["user", "assistant", "toolResult", "custom"].includes(
        visibleMessage.role,
      )
    )
      continue;
    const entry: SessionEntry = {
      type: "message",
      id: String(event.seq),
      parentId,
      timestamp: new Date(event.timestamp).toISOString(),
      message: visibleMessage,
    };
    entries.push(entry);
    parentId = entry.id;
  }
  return entries;
};

class DurableSessionManagerProjection {
  constructor(private readonly runtime: DurableInteractiveRuntime) {}
  getCwd() {
    return this.runtime.snapshot().cwd;
  }
  getSessionName() {
    return this.runtime.snapshot().workspaceName;
  }
  getSessionFile(): undefined {
    return undefined;
  }
  getSessionDir() {
    return this.getCwd();
  }
  usesDefaultSessionDir() {
    return false;
  }
  getSessionId() {
    return `workspace-${this.runtime.snapshot().conversationId ?? "pending"}`;
  }
  getSessionNameValue() {
    return this.getSessionName();
  }
  getEntries() {
    return entryMessages(this.runtime.snapshot());
  }
  getEntryCount() {
    return this.getEntries().length;
  }
  getLeafId() {
    return this.getEntries().at(-1)?.id ?? null;
  }
  getLeafEntry() {
    return this.getEntries().at(-1);
  }
  getBranch() {
    return this.getEntries();
  }
  buildContextEntries() {
    return this.getEntries();
  }
  getTree(): SessionTreeNode[] {
    const roots: SessionTreeNode[] = [];
    const nodes = new Map<string, SessionTreeNode>();
    for (const entry of this.getEntries()) {
      const node: SessionTreeNode = { entry, children: [] };
      nodes.set(entry.id, node);
      if (entry.parentId === null) roots.push(node);
      else nodes.get(entry.parentId)?.children.push(node);
    }
    return roots;
  }
  appendLabelChange(): never {
    throw new Error(
      "Durable workspace labels are not available through this Pi session view",
    );
  }
}

class DurableModelRuntimeProjection {
  private models: SessionModel[] = [];
  private selected?: { provider: string; id: string };
  private error?: string;
  constructor(private readonly runtime: DurableInteractiveRuntime) {
    this.refreshSnapshot();
  }
  refreshSnapshot() {
    const snapshot = this.runtime.snapshot();
    this.models = [...snapshot.models];
    this.selected = snapshot.selectedModel;
  }
  getAvailableSnapshot() {
    return this.models;
  }
  getAvailable() {
    return Promise.resolve(this.models);
  }
  getModel(provider: string, id: string) {
    return this.models.find(
      (model) => model.provider === provider && model.id === id,
    );
  }
  getError() {
    return this.error;
  }
  getProviders(): ProviderMetadata[] {
    return this.runtime.snapshot().catalog?.providers ?? [];
  }
  getProvider(providerId: string) {
    return this.getProviders().find((provider) => provider.id === providerId);
  }
  async logout(providerId: string, options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) throw new Error("Logout cancelled");
    await this.runtime.transport.runProviderAuth("logout", providerId);
    if (!options?.signal?.aborted) await this.refresh(options);
  }
  getProviderAuthStatus(providerId: string) {
    return this.getProvider(providerId)?.authenticated
      ? "available"
      : "missing";
  }
  isUsingOAuth(providerId: string) {
    return this.getProvider(providerId)?.authType === "oauth";
  }
  isUsingSubscription(providerId: string) {
    return this.getProvider(providerId)?.subscription === true;
  }
  async checkAuth(providerId: string) {
    const provider = this.getProvider(providerId);
    return provider?.authenticated
      ? { type: provider.authType ?? ("api_key" as const) }
      : undefined;
  }
  async refresh(options: { signal?: AbortSignal } = {}) {
    const catalog = await this.runtime.transport.request<ModelCatalog>(
      "/models?refresh=true",
      undefined,
      options.signal,
    );
    this.runtime.updateCatalog(catalog);
    this.refreshSnapshot();
    this.error = typeof catalog.error === "string" ? catalog.error : undefined;
    return {
      aborted: catalog.refresh?.aborted === true,
      errors: new Map<string, Error>(
        (catalog.refresh?.errors ?? []).map(
          (entry: { provider: string; message: string }) => [
            entry.provider,
            new Error(entry.message),
          ],
        ),
      ),
    };
  }
  select(provider: string, id: string) {
    this.selected = { provider, id };
  }
}

class DurableAgentProjection {
  readonly signal = new AbortController().signal;
  get state() {
    return this.runtime.agentState();
  }
  constructor(private readonly runtime: DurableInteractiveRuntime) {}
}

/** A view of the Pod's current Durable conversation. It never creates a Pi AgentSession. */
export class DurableInteractiveRuntime {
  readonly services = {
    agentDir: resolve(
      process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? "."}/.config`,
      "adm",
      "terminal",
    ),
  };
  readonly session: ReturnType<DurableInteractiveRuntime["sessionProjection"]>;
  readonly remotePorts = {
    isRemote: true as const,
    projectTrust: {
      get: (_cwd: string): ProjectTrustDecision =>
        this.resources?.trust.trusted ?? null,
      getEntry: (_cwd: string): ProjectTrustStoreEntry | null => {
        const current = this.resources?.trust;
        return current?.source
          ? { path: current.source, decision: current.trusted }
          : null;
      },
      set: async (cwd: string, decision: ProjectTrustDecision) => {
        if (this.snapshot().role === "bot")
          throw new Error(
            "Project trust controls are unavailable to bot workspaces",
          );
        await this.setTrustUpdates([{ path: cwd, decision }]);
      },
      setMany: async (updates: ProjectTrustUpdate[]) => {
        if (this.snapshot().role === "bot")
          throw new Error(
            "Project trust controls are unavailable to bot workspaces",
          );
        await this.setTrustUpdates(updates);
      },
      hasTrustRequiringResources: (_cwd: string) =>
        this.resources?.trust.trustRequired ?? false,
    },
    authMetadata: {
      isAnthropicSubscription: async () => {
        const provider = this.snapshot().catalog?.providers?.find(
          (item) => item.id === "anthropic",
        );
        return provider?.subscription === true;
      },
    },
    authActions: {
      login: async () => {
        if (this.snapshot().role !== "coding")
          throw new Error(
            "Provider authentication is unavailable to bot workspaces",
          );
        await this.transport.runProviderAuth("login");
        await this.modelRuntime.refresh();
      },
    },
  };
  private current: WorkspaceSnapshot;
  private catalog?: ModelCatalog;
  private resources?: WorkspaceResourceSnapshot;
  private settings: { thinkingLevel: ThinkingLevel } = { thinkingLevel: "off" };
  private listeners = new Set<DurablePiEventListener>();
  private unlisten: () => void;
  private settingsManager: SettingsManager;
  private modelRuntime: DurableModelRuntimeProjection;
  private sessionManager: DurableSessionManagerProjection;
  private agent: DurableAgentProjection;
  private beforeSessionInvalidate?: () => void;
  private rebindSession?: (session: RemoteDurableSession) => Promise<void>;
  private streaming = false;
  private compacting = false;
  private promptCount = 0;
  private tokens = 0;
  private cost = 0;
  private lastUsage?: Record<string, number>;
  private activeBashOperationId?: string;
  private extensionRunner = {
    getRegisteredCommands: () => [],
    getShortcuts: () => new Map(),
    getCommandDiagnostics: () => [],
    getShortcutDiagnostics: () => [],
    getMarkdownTransformers: () => [],
    resolveToolRenderers: (_name: string, fallback: () => unknown) =>
      fallback(),
    getEntryRenderer: () => undefined,
    getMessageRenderer: () => undefined,
  };
  private resourceLoader = {
    getThemes: () => {
      const snapshot = this.requireResources();
      return {
        themes: snapshot.themes.map((theme) => {
          if (!createThemeFromJson)
            throw new Error(
              "Pinned Pi theme remote JSON support is missing; rebuild the release runtime",
            );
          return createThemeFromJson(
            theme.json,
            undefined,
            theme.path,
            theme.sourceInfo,
          );
        }),
        diagnostics: snapshot.diagnostics.filter(
          (item) => !item.path || item.path.toLowerCase().endsWith(".json"),
        ),
      };
    },
    getSkills: () => {
      const snapshot = this.requireResources();
      return {
        skills: snapshot.skills,
        diagnostics: snapshot.diagnostics.filter((item) =>
          item.path?.toLowerCase().includes("skill"),
        ),
      };
    },
    getPrompts: () => {
      const snapshot = this.requireResources();
      return {
        prompts: snapshot.prompts,
        diagnostics: snapshot.diagnostics.filter((item) =>
          item.path?.toLowerCase().includes("prompt"),
        ),
      };
    },
    getExtensions: () => {
      const snapshot = this.requireResources();
      const discovered = snapshot.extensions.length > 0;
      const warnings = [
        ...snapshot.diagnostics
          .filter((item) => item.type === "warning")
          .map((item) => ({
            path: item.path ?? snapshot.cwd,
            warning: item.message,
          })),
        ...(discovered
          ? [
              {
                path: snapshot.cwd,
                warning:
                  "Extensions are discovered in the workspace but are not activated for Durable conversations.",
              },
            ]
          : []),
      ];
      return {
        extensions: [],
        errors: snapshot.diagnostics
          .filter((item) => item.type === "error")
          .map((item) => ({
            path: item.path ?? snapshot.cwd,
            error: item.message,
          })),
        warnings,
        runtime: createExtensionRuntime(),
      };
    },
    getAgentsFiles: () => ({
      agentsFiles: this.requireResources().agentsFiles,
    }),
    getSystemPrompt: () => this.requireResources().systemPrompt,
    getSystemPromptSource: () => this.requireResources().systemPromptSource,
    getAppendSystemPrompt: () => this.requireResources().appendSystemPrompt,
    getAppendSystemPromptSources: () =>
      this.requireResources().appendSystemPromptSources ?? [],
    extendResources: () => {
      throw new Error(
        "Pi extensions are discovered but not activated for Durable conversations",
      );
    },
    reload: async (options?: { beforeSessionStart?: () => void }) => {
      await this.reloadResources();
      options?.beforeSessionStart?.();
      await this.session.bindExtensions();
    },
  };

  constructor(readonly transport: WorkspaceTerminal) {
    this.current = transport.getRemoteSnapshot();
    this.settingsManager = SettingsManager.create(
      process.cwd(),
      this.services.agentDir,
    );
    this.modelRuntime = new DurableModelRuntimeProjection(this);
    this.sessionManager = new DurableSessionManagerProjection(this);
    this.agent = new DurableAgentProjection(this);
    this.session = this.sessionProjection();
    this.unlisten = transport.subscribeWorkspaceEvents((event) =>
      this.onWorkspaceEvent(event),
    );
  }

  async initialize() {
    this.current = this.transport.getRemoteSnapshot();
    if (!this.current.connected)
      throw new Error(
        `Connect to the workspace before starting Pi InteractiveMode: ${this.current.status}`,
      );
    const settingsRequest = this.transport.request<{ thinkingLevel?: string }>(
      "/settings",
    );
    const resourcesRequest =
      this.current.role === "bot"
        ? Promise.resolve<WorkspaceResourceSnapshot>({
            cwd: this.current.cwd,
            trust: { trusted: false, trustRequired: false, source: null },
            themes: [],
            prompts: [],
            skills: [],
            agentsFiles: [],
            extensions: [],
            diagnostics: [],
            appendSystemPrompt: [],
          })
        : this.transport.request<WorkspaceResourceSnapshot>("/resources");
    const [data, resources] = await Promise.all([
      settingsRequest,
      resourcesRequest,
    ]);
    this.resources = resources;
    if (typeof data.thinkingLevel === "string")
      this.settings.thinkingLevel = data.thinkingLevel as ThinkingLevel;
    this.current = this.transport.getRemoteSnapshot();
    this.modelRuntime.refreshSnapshot();
  }

  snapshot(): WorkspaceSnapshot & { catalog?: ModelCatalog } {
    this.current = this.transport.getRemoteSnapshot();
    return { ...this.current, catalog: this.catalog };
  }
  updateCatalog(catalog: ModelCatalog) {
    this.catalog = catalog;
  }
  agentState() {
    const model = this.session.model;
    return {
      systemPrompt: "",
      ...(model ? { model } : {}),
      thinkingLevel: this.settings.thinkingLevel,
      tools: [],
      messages: this.session.messages,
      isStreaming: this.streaming,
      ...(this.snapshot().liveMessage
        ? { streamingMessage: this.snapshot().liveMessage }
        : {}),
      pendingToolCalls: new Set<string>(),
    };
  }

  sessionProjection() {
    const runtime = this;
    const manager = this.sessionManager;
    const settings = this.settingsManager;
    const modelRuntime = this.modelRuntime;
    const agent = this.agent;
    const resources = this.resourceLoader;
    const extensionRunner = this.extensionRunner;
    const session = {
      agent,
      sessionManager: manager,
      settingsManager: settings,
      modelRuntime,
      resourceLoader: resources,
      extensionRunner,
      get promptTemplates() {
        return resources.getPrompts().prompts;
      },
      scopedModels: [],
      get state() {
        return agent.state;
      },
      get messages() {
        return manager
          .buildContextEntries()
          .flatMap((entry) =>
            entry.type === "message" ? [entry.message] : [],
          );
      },
      get model() {
        const selected = runtime.snapshot().selectedModel;
        return selected
          ? modelRuntime.getModel(selected.provider, selected.id)
          : undefined;
      },
      get thinkingLevel() {
        return runtime.settings.thinkingLevel;
      },
      get steeringMode() {
        return "all";
      },
      get followUpMode() {
        return "all";
      },
      get isStreaming() {
        return runtime.streaming;
      },
      get isIdle() {
        return !runtime.streaming && !runtime.compacting;
      },
      get isCompacting() {
        return runtime.compacting;
      },
      get isBashRunning() {
        return false;
      },
      get autoCompactionEnabled() {
        return true;
      },
      get retryAttempt() {
        return 0;
      },
      get pendingMessageCount() {
        return 0;
      },
      get sessionFile() {
        return undefined;
      },
      get systemPrompt() {
        return runtime.resourceLoader.getSystemPrompt() ?? "";
      },
      get cacheWarmingStatus() {
        return undefined;
      },
      get sessionId() {
        return manager.getSessionId();
      },
      get sessionName() {
        return manager.getSessionName();
      },
      getAvailableThinkingLevels: () => runtime.availableThinkingLevels(),
      getContextUsage: () => runtime.contextUsage(),
      getSessionStats: () => runtime.sessionStats(),
      getLastAssistantText: () => runtime.lastAssistantText(),
      getUserMessagesForForking: () => runtime.userMessagesForForking(),
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      getToolDefinition: () => undefined,
      getToolDefinitions: () => [],
      executeBash: (
        command: string,
        onChunk?: (chunk: string) => void,
        options?: { excludeFromContext?: boolean; id?: string },
      ) => runtime.executeBash(command, onChunk, options),
      recordBashResult: () => {
        /* The workspace executor persists the result before its SSE event. */
      },
      exportToHtml: async () => {
        throw new Error(
          "Pi HTML export is not available for remote Durable conversations",
        );
      },
      exportToJsonl: () => {
        throw new Error(
          "Pi JSONL export is not available for remote Durable conversations",
        );
      },
      clearQueue: () => {
        throw new Error(
          "Queue editing requires the workspace conversation-control API",
        );
      },
      followUp: async (message: string) =>
        runtime.prompt(message, { streamingBehavior: "followUp" }),
      steer: async (message: string) =>
        runtime.prompt(message, { streamingBehavior: "steer" }),
      abortRetry: () => {
        void runtime.abort();
      },
      abortCompaction: () => {
        void runtime.abort();
      },
      abortBranchSummary: () => {
        throw new Error(
          "Branch summaries are not active in this remote Durable runtime",
        );
      },
      setScopedModels: () => {
        throw new Error(
          "Scoped model settings require the workspace runtime API",
        );
      },
      setCacheWarmingMode: () => {
        throw new Error(
          "Cache warming settings are not exposed by the workspace runtime API",
        );
      },
      subscribe: (listener: DurablePiEventListener) =>
        runtime.subscribe(listener),
      prompt: (
        message: string,
        options?: {
          images?: unknown[];
          streamingBehavior?: "steer" | "followUp";
        },
      ) => runtime.prompt(message, options),
      abort: () => runtime.abort(),
      abortBash: () => runtime.abortBash(),
      waitForIdle: () => runtime.waitForIdle(),
      setModel: (model: SessionModel) => runtime.setModel(model),
      cycleModel: (direction: "forward" | "backward") =>
        runtime.cycleModel(direction),
      setThinkingLevel: (level: ThinkingLevel) =>
        runtime.setThinkingLevel(level),
      cycleThinkingLevel: () => runtime.cycleThinkingLevel(),
      setAutoCompactionEnabled: () => {
        throw new Error(
          "Auto-compaction configuration is not exposed by the Durable runtime yet",
        );
      },
      setSteeringMode: () => {
        throw new Error(
          "Steering mode is not exposed by the Durable runtime yet",
        );
      },
      setFollowUpMode: () => {
        throw new Error(
          "Follow-up mode is not exposed by the Durable runtime yet",
        );
      },
      setSessionName: () => {
        throw new Error(
          "Workspace naming is managed by ADM, not a local Pi session",
        );
      },
      compact: (instructions?: string) => runtime.compact(instructions),
      reset: (handoff?: string) => runtime.reset(handoff),
      navigateTree: (entryId: string) => runtime.forkEntry(entryId),
      bindExtensions: async () => {
        if (runtime.snapshotResources().extensions.length)
          throw new Error(
            "Workspace extensions are discovered but cannot be activated until the Durable extension bridge is available",
          );
      },
      getAvailableTools: () => [],
      getActiveToolNames: () => [],
      getSteeringMode: () => "all",
      getFollowUpMode: () => "all",
    };
    return session;
  }

  private requireResources() {
    if (!this.resources)
      throw new Error("Workspace resources have not been loaded");
    return this.resources;
  }
  snapshotResources() {
    return this.requireResources();
  }
  private async reloadResources() {
    this.resources = await this.transport.request<WorkspaceResourceSnapshot>(
      "/resources/reload",
      {},
      undefined,
      "POST",
    );
  }
  private async setTrustUpdates(updates: ProjectTrustUpdate[]) {
    const response = await this.transport.request<WorkspaceResourceSnapshot>(
      "/trust",
      { updates },
      undefined,
      "PUT",
    );
    this.resources = response;
  }

  private availableThinkingLevels(): ThinkingLevel[] {
    const model = this.session.model as SessionModel | undefined;
    return model?.reasoning
      ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
      : ["off"];
  }
  private contextUsage() {
    const selected = this.snapshot().selectedModel;
    const model = selected
      ? this.modelRuntime.getModel(selected.provider, selected.id)
      : undefined;
    const tokens = this.lastUsage
      ? Number(this.lastUsage.input ?? 0) +
        Number(this.lastUsage.cacheRead ?? 0) +
        Number(this.lastUsage.cacheWrite ?? 0)
      : null;
    return model
      ? {
          tokens,
          contextWindow: model.contextWindow,
          percent:
            tokens === null ? null : (tokens / model.contextWindow) * 100,
        }
      : undefined;
  }
  private sessionStats() {
    const entries = this.sessionManager.getEntries();
    return {
      sessionFile: undefined,
      sessionId: this.sessionManager.getSessionId(),
      userMessages: entries.filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      ).length,
      assistantMessages: entries.filter(
        (entry) =>
          entry.type === "message" && entry.message.role === "assistant",
      ).length,
      toolCalls: entries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content.some((part) => part.type === "toolCall"),
      ).length,
      toolResults: entries.filter(
        (entry) =>
          entry.type === "message" && entry.message.role === "toolResult",
      ).length,
      totalMessages: entries.length,
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: this.tokens,
      },
      cost: this.cost,
      contextUsage: this.contextUsage(),
    };
  }
  private lastAssistantText() {
    const entry = this.sessionManager
      .getEntries()
      .findLast(
        (item) => item.type === "message" && item.message.role === "assistant",
      );
    if (entry?.type !== "message" || entry.message.role !== "assistant")
      return null;
    return entry.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  private userMessagesForForking() {
    return this.sessionManager.getEntries().flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const text =
        typeof entry.message.content === "string"
          ? entry.message.content
          : entry.message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      return [{ entryId: entry.id, text }];
    });
  }
  private async prompt(
    message: string,
    options?: { images?: unknown[]; streamingBehavior?: "steer" | "followUp" },
  ) {
    const images = options?.images;
    await this.transport.request("/input", {
      message,
      ...(images?.length ? { images } : {}),
      requestId: randomUUID(),
      whenBusy:
        options?.streamingBehavior === "followUp" ? "followUp" : "steer",
    });
  }
  private async abort() {
    await this.transport.request("/abort", { background: false });
  }
  private async executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean; id?: string },
  ) {
    if (this.snapshot().role !== "coding")
      throw new Error("Bash is unavailable to bot workspaces");
    try {
      return await this.transport.executeBash(command, onChunk ?? (() => {}), {
        ...(options ?? {}),
        onAdmitted: (operationId) => {
          this.activeBashOperationId = operationId;
        },
      });
    } finally {
      this.activeBashOperationId = undefined;
    }
  }
  private async abortBash() {
    const operationId = this.activeBashOperationId;
    if (!operationId) return;
    await this.transport.abortBash(operationId);
  }
  private async setModel(model: SessionModel) {
    const result = await this.transport.request(
      "/model",
      { provider: model.provider, modelId: model.id },
      undefined,
      "PUT",
    );
    this.modelRuntime.select(result.selected.provider, result.selected.id);
  }
  private async cycleModel(direction: "forward" | "backward") {
    const models = this.modelRuntime.getAvailableSnapshot();
    if (models.length < 2) return undefined;
    const selected = this.snapshot().selectedModel;
    const at = selected
      ? models.findIndex(
          (model) =>
            model.provider === selected.provider && model.id === selected.id,
        )
      : -1;
    const next =
      models[
        (at + (direction === "forward" ? 1 : -1) + models.length) %
          models.length
      ]!;
    await this.setModel(next);
    return {
      model: next,
      thinkingLevel: this.settings.thinkingLevel,
      isScoped: false,
    };
  }
  private async setThinkingLevel(level: ThinkingLevel) {
    await this.transport.request(
      "/settings",
      { thinkingLevel: level },
      undefined,
      "PUT",
    );
    this.settings.thinkingLevel = level;
  }
  async listSessions(): Promise<SessionInfo[]> {
    const navigation = await this.transport.request<{
      branches?: {
        sessionInfo?: Omit<SessionInfo, "created" | "modified"> & {
          created: string;
          modified: string;
        };
      }[];
    }>("/branches");
    if (!Array.isArray(navigation.branches))
      throw new Error("Runner returned invalid Durable session navigation");
    return navigation.branches.map(({ sessionInfo }) => {
      if (
        !sessionInfo ||
        typeof sessionInfo.path !== "string" ||
        typeof sessionInfo.id !== "string"
      )
        throw new Error(
          "Runner returned a Durable branch without Pi session metadata",
        );
      const created = new Date(sessionInfo.created);
      const modified = new Date(sessionInfo.modified);
      if (
        !Number.isFinite(created.getTime()) ||
        !Number.isFinite(modified.getTime())
      )
        throw new Error("Runner returned invalid Durable session timestamps");
      return { ...sessionInfo, created, modified };
    });
  }
  private async cycleThinkingLevel() {
    const levels = this.availableThinkingLevels();
    const next =
      levels[
        (levels.indexOf(this.settings.thinkingLevel) + 1) % levels.length
      ]!;
    await this.setThinkingLevel(next);
    return next;
  }
  private async compact(instructions?: string) {
    this.compacting = true;
    try {
      await this.transport.request("/compact", { instructions });
    } finally {
      this.compacting = false;
    }
    return undefined;
  }
  private async reset(handoff?: string) {
    await this.transport.request("/reset", { handoff });
  }
  private async forkEntry(entryId: string) {
    const result = await this.transport.request("/tree", {
      entryId: Number(entryId),
    });
    return { cancelled: false, editorText: result.selectedText };
  }
  private subscribe(listener: DurablePiEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private onWorkspaceEvent(event: WorkspaceEvent) {
    const snapshot = this.snapshot();
    if (snapshot.role === "bot") {
      const allowed =
        event.kind === "user" ||
        event.kind === "message" ||
        (event.kind === "status" && snapshot.diagnostics);
      if (!allowed) return;
    }
    if (event.kind === "live") {
      const data = event.data;
      if (data?.type === "snapshot") {
        this.streaming = !!data.generation;
        const message = data.generation?.message;
        if (message)
          void this.emit({
            type: "message_start",
            message,
          } as AgentSessionEvent);
        if (this.streaming)
          void this.emit({ type: "agent_start" } as AgentSessionEvent);
      } else if (data?.type === "message_start") {
        this.streaming = true;
        void this.emit({ type: "agent_start" } as AgentSessionEvent);
        void this.emit({
          type: "message_start",
          message: data.message,
        } as AgentSessionEvent);
      } else if (data?.type === "message_update") {
        const message = this.snapshot().liveMessage;
        if (message)
          void this.emit({
            type: "message_update",
            message,
          } as AgentSessionEvent);
      } else if (data?.type === "tool_execution_start") {
        void this.emit(data as AgentSessionEvent);
      } else if (data?.type === "tool_execution_update") {
        const tool = this.snapshot().liveTools.get(data.toolCallId);
        void this.emit({
          type: "tool_execution_update",
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          partialResult: tool?.result ?? { content: [] },
        } as AgentSessionEvent);
      } else if (data?.type === "tool_execution_end") {
        void this.emit(data as AgentSessionEvent);
      } else if (data?.type === "turn_start") {
        this.streaming = true;
        void this.emit({ type: "turn_start" } as AgentSessionEvent);
      } else if (data?.type === "turn_end") {
        this.streaming = false;
        void this.emit({
          type: "agent_end",
          messages: this.session.messages,
          willRetry: false,
        } as AgentSessionEvent);
        void this.emit({
          type: "agent_settled",
          aborted: false,
        } as AgentSessionEvent);
      }
      return;
    }
    const message = event.data?.message as AgentMessage | undefined;
    if (event.kind === "assistant" && message?.role === "assistant") {
      this.accumulateUsage(message);
      void this.emit({ type: "message_end", message } as AgentSessionEvent);
    } else if (event.kind === "user" && message?.role === "user") {
      this.promptCount++;
      void this.emit({ type: "message_start", message } as AgentSessionEvent);
    } else if (event.kind === "tool" && message?.role === "toolResult") {
      void this.emit({ type: "message_end", message } as AgentSessionEvent);
    } else if (event.kind === "message" && this.snapshot().role === "bot") {
      const publicMessage: AgentMessage = {
        role: "custom",
        customType: "adm.message",
        content: typeof event.data?.text === "string" ? event.data.text : "",
        display: true,
        details: event.data,
        timestamp: event.timestamp,
      };
      void this.emit({
        type: "message_end",
        message: publicMessage,
      } as AgentSessionEvent);
    } else if (event.kind === "status") {
      void this.emit({
        type: "entry_appended",
        entry: {
          type: "custom",
          id: String(event.seq),
          parentId: null,
          timestamp: new Date(event.timestamp).toISOString(),
          customType: "adm.status",
          data: event.data,
        },
      } as AgentSessionEvent);
    }
  }
  private accumulateUsage(message: AgentMessage) {
    if (message.role !== "assistant" || !message.usage) return;
    this.lastUsage = message.usage as unknown as Record<string, number>;
    this.tokens += Number(message.usage.totalTokens) || 0;
    this.cost += Number(message.usage.cost?.total) || 0;
  }
  private async emit(event: AgentSessionEvent) {
    for (const listener of this.listeners) await listener(event);
  }
  private async waitForIdle() {
    if (!this.streaming && !this.compacting) return;
    await new Promise<void>((resolve) => {
      const remove = this.subscribe((event) => {
        if (event.type === "agent_settled") {
          remove();
          resolve();
        }
      });
    });
  }
  async newSession(): Promise<{ cancelled: boolean }> {
    this.beforeSessionInvalidate?.();
    await this.transport.request("/new", {});
    await this.refreshSessionView();
    return { cancelled: false };
  }
  async fork(
    entryId: string,
  ): Promise<{ cancelled: boolean; selectedText?: string }> {
    this.beforeSessionInvalidate?.();
    const result = await this.transport.request<{ selectedText?: string }>(
      "/tree",
      { entryId: Number(entryId) },
    );
    await this.refreshSessionView();
    return {
      cancelled: false,
      ...(result.selectedText ? { selectedText: result.selectedText } : {}),
    };
  }
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const suffix = sessionPath.slice(sessionPath.lastIndexOf(":") + 1);
    const conversationId = Number(suffix);
    if (!Number.isSafeInteger(conversationId) || conversationId < 1)
      throw new Error(
        "Pi session selector returned an invalid Durable conversation ID",
      );
    this.beforeSessionInvalidate?.();
    await this.transport.request(
      "/branch",
      { conversationId },
      undefined,
      "PUT",
    );
    await this.refreshSessionView();
    return { cancelled: false };
  }
  async importFromJsonl(inputPath: string): Promise<{ cancelled: boolean }> {
    const file = await stat(inputPath);
    if (!file.isFile() || file.size > 8 * 1024 * 1024)
      throw new Error(
        "Pi transcript must be a regular file no larger than 8 MiB",
      );
    const imported = importedPiSession(await readFile(inputPath, "utf8"));
    this.beforeSessionInvalidate?.();
    await this.transport.request("/import", {
      session: imported.session,
      selectedLeafId: imported.selectedLeafId,
      entries: imported.entries,
    });
    await this.refreshSessionView();
    return { cancelled: false };
  }
  setBeforeSessionInvalidate(callback?: () => void) {
    this.beforeSessionInvalidate = callback;
  }
  setRebindSession(
    callback?: (session: RemoteDurableSession) => Promise<void>,
  ) {
    this.rebindSession = callback;
  }
  private async refreshSessionView() {
    await this.transport.connect();
    this.current = this.transport.getRemoteSnapshot();
    this.modelRuntime.refreshSnapshot();
    await this.rebindSession?.(this.session);
  }
  async dispose() {
    this.unlisten();
  }
}
