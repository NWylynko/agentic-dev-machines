import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  ImageContent,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import type {
  AgentEvent as DurableAgentEvent,
  NestedToolExecutionResult,
} from "@earendil-works/pi-durable";
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
  type ExtensionUIContext,
  type ResolvedCommand,
  type ExtensionShortcut,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  exportDurableSessionHtml,
  exportDurableSessionJsonl,
} from "./native-export.ts";
import {
  importedPiSession,
  WorkspaceTerminal,
  type WorkspaceEvent,
} from "./terminal.ts";

type SessionModel = Model<Api>;
type WorkspaceSettings = {
  thinkingLevel: ThinkingLevel;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  autoCompact: boolean;
  scopedModels: string[];
  cacheWarmingMode: "off" | "streaming" | "idle";
  sessionName?: string;
};
type WorkspaceQueue = { steering: string[]; followUp: string[] };
type RemoteExtensions = {
  extensions: {
    name: string;
    path: string;
    active: boolean;
    commands: { name: string; path: string; description?: string }[];
    shortcuts: { name: string; key: string; description?: string }[];
  }[];
  diagnostics: { type: string; message: string; path?: string }[];
};
type ExtensionOperationEvent = {
  seq: number;
  type:
    | "ui_request"
    | "notification"
    | "status"
    | "title"
    | "editor_text"
    | "working_message"
    | "working_visible"
    | "result"
    | "error";
  requestId?: string;
  method?: "select" | "confirm" | "input" | "editor" | "getEditorText";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  level?: "info" | "warning" | "error";
  key?: string;
  text?: string;
  visible?: boolean;
  command?: string;
  code?: string;
};
const workspaceThinkingLevels = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
function parseWorkspaceSettings(value: Partial<WorkspaceSettings>) {
  const settings: Partial<WorkspaceSettings> = {};
  if (value.thinkingLevel !== undefined) {
    if (!workspaceThinkingLevels.has(value.thinkingLevel))
      throw new Error("Runner returned an unsupported thinking level");
    settings.thinkingLevel = value.thinkingLevel;
  }
  if (value.steeringMode !== undefined) {
    if (!isQueueMode(value.steeringMode))
      throw new Error("Runner returned an unsupported steering mode");
    settings.steeringMode = value.steeringMode;
  }
  if (value.followUpMode !== undefined) {
    if (!isQueueMode(value.followUpMode))
      throw new Error("Runner returned an unsupported follow-up mode");
    settings.followUpMode = value.followUpMode;
  }
  if (value.autoCompact !== undefined) {
    if (typeof value.autoCompact !== "boolean")
      throw new Error("Runner returned an invalid auto-compaction setting");
    settings.autoCompact = value.autoCompact;
  }
  if (value.scopedModels !== undefined) {
    if (
      !Array.isArray(value.scopedModels) ||
      value.scopedModels.some((model) => typeof model !== "string")
    )
      throw new Error("Runner returned invalid scoped model settings");
    settings.scopedModels = [...value.scopedModels];
  }
  if (value.cacheWarmingMode !== undefined) {
    if (!["off", "streaming", "idle"].includes(value.cacheWarmingMode))
      throw new Error("Runner returned an unsupported cache warming mode");
    settings.cacheWarmingMode = value.cacheWarmingMode;
  }
  if (value.sessionName !== undefined) {
    if (typeof value.sessionName !== "string")
      throw new Error("Runner returned an invalid session name");
    settings.sessionName = value.sessionName;
  }
  return settings;
}
function parseWorkspaceQueue(value: Partial<WorkspaceQueue>): WorkspaceQueue {
  const steering = value.steering;
  const followUp = value.followUp;
  if (
    !Array.isArray(steering) ||
    steering.some((message) => typeof message !== "string") ||
    !Array.isArray(followUp) ||
    followUp.some((message) => typeof message !== "string")
  )
    throw new Error("Runner returned an invalid queued-message projection");
  return { steering: [...steering], followUp: [...followUp] };
}
const shortcutBases = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./!@#$%^&*()_+|~{}:?<>".split(
    "",
  ),
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
function isKeyId(value: string): value is KeyId {
  const parts = value.split("+");
  const base = parts.pop();
  const modifiers = parts;
  return Boolean(
    base &&
    shortcutBases.has(base) &&
    modifiers.length <= 3 &&
    new Set(modifiers).size === modifiers.length &&
    modifiers.every((modifier) =>
      ["ctrl", "shift", "alt", "super"].includes(modifier),
    ),
  );
}
function isQueueMode(value: string): value is "all" | "one-at-a-time" {
  return value === "all" || value === "one-at-a-time";
}
type DurableToolExecutionEnd = Extract<
  DurableAgentEvent,
  { type: "tool_execution_end" }
>;
function isToolContentBlock(
  value: unknown,
): value is TextContent | ImageContent {
  const block = value as Record<string, unknown> | null;
  return (
    typeof block === "object" &&
    block !== null &&
    ((block.type === "text" && typeof block.text === "string") ||
      (block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"))
  );
}
// Durable's nested output is a string for one text item, an image, "" for
// none, a content list, or a tool's structured value; diagnostics explain an
// error result the Harness wrote itself.
function nestedToolResultContent(
  result: NestedToolExecutionResult,
): (TextContent | ImageContent)[] {
  const output = result.structuredOutput;
  if (output === undefined)
    return result.diagnostics.map(({ message }) => ({
      type: "text",
      text: message,
    }));
  if (typeof output === "string")
    return output ? [{ type: "text", text: output }] : [];
  const blocks: unknown[] = Array.isArray(output) ? output : [output];
  if (blocks.every(isToolContentBlock)) return blocks;
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}
// Pi's tool row renders `result.content`. Durable ends a model-issued call
// with its toolResult entry, a nested call with its result, and a faulted or
// orphaned call with neither.
function piToolExecutionEnd(event: DurableToolExecutionEnd) {
  const call = {
    type: "tool_execution_end" as const,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    ...(event.parentToolCallId
      ? { parentToolCallId: event.parentToolCallId }
      : {}),
  };
  const message = event.entry?.model?.find(
    (candidate) =>
      candidate.role === "toolResult" &&
      candidate.toolCallId === event.toolCallId,
  );
  if (message?.role === "toolResult")
    return {
      ...call,
      result: { content: message.content, details: message.details },
      isError: message.isError,
      durationMs: message.durationMs,
    };
  if (event.result)
    return {
      ...call,
      result: {
        content: nestedToolResultContent(event.result),
        details: event.result.details,
      },
      isError: event.result.isError,
      durationMs: event.result.durationMs,
    };
  return {
    ...call,
    result: {
      content: [
        {
          type: "text" as const,
          text: event.entry
            ? "Durable ended this tool call with an entry that has no tool result."
            : "Tool call ended without a result: its task faulted or was orphaned, or its run ended first.",
        },
      ],
    },
    isError: true,
  };
}
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
      !["user", "assistant", "toolResult", "custom", "bashExecution"].includes(
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
    return this.runtime.sessionName();
  }
  getSessionFile(): undefined {
    return undefined;
  }
  isPersisted() {
    return false;
  }
  getSessionDir() {
    return this.getCwd();
  }
  usesDefaultSessionDir() {
    return false;
  }
  getSessionId() {
    const snapshot = this.runtime.snapshot();
    return `${snapshot.workspaceId}:${snapshot.conversationId ?? "pending"}`;
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
  private toolDefinitions: ToolDefinition[] = [];
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
    reconnect: async () => this.refreshSessionView(),
    supportsBash: false,
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
  private settings: WorkspaceSettings = {
    thinkingLevel: "off",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompact: true,
    scopedModels: [],
    cacheWarmingMode: "off",
  };
  private queue: WorkspaceQueue = { steering: [], followUp: [] };
  private extensions: RemoteExtensions = { extensions: [], diagnostics: [] };
  private extensionUi?: ExtensionUIContext;
  private remoteCommands: ResolvedCommand[] = [];
  private remoteShortcuts = new Map<string, ExtensionShortcut>();
  private listeners = new Set<DurablePiEventListener>();
  private unlisten: () => void;
  private settingsManager: SettingsManager;
  private modelRuntime: DurableModelRuntimeProjection;
  private sessionManager: DurableSessionManagerProjection;
  private agent: DurableAgentProjection;
  private beforeSessionInvalidate?: () => void;
  private rebindSession?: (session: RemoteDurableSession) => Promise<void>;
  private streaming = false;
  // Pi has a streaming assistant component: a live partial it was given.
  private piStreamingAssistant = false;
  // Saved entries shown in Pi's chat by an event since Pi last rendered the
  // session's records. Live `message_end` and history both carry each saved
  // message, in no guaranteed order; whichever arrives first shows it.
  private savedEntriesShown = new Set<number>();
  private compacting = false;
  private promptCount = 0;
  private tokens = 0;
  private cost = 0;
  private lastUsage?: Record<string, number>;
  private activeBashOperationId?: string;
  private extensionRunner = {
    getRegisteredCommands: () => this.remoteCommands,
    getCommand: (name: string) =>
      this.remoteCommands.find((command) => command.name === name),
    getShortcuts: () => this.remoteShortcuts,
    getCommandDiagnostics: () => this.extensions.diagnostics,
    getShortcutDiagnostics: () => this.extensions.diagnostics,
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
    Object.defineProperty(this.remotePorts, "supportsBash", {
      enumerable: true,
      get: () => this.snapshot().role === "coding",
    });
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
    const settingsRequest =
      this.transport.request<Partial<WorkspaceSettings>>("/settings");
    const queueRequest =
      this.transport.request<Partial<WorkspaceQueue>>("/queue");
    const extensionsRequest =
      this.current.role === "coding"
        ? this.transport.request<RemoteExtensions>("/extensions")
        : Promise.resolve<RemoteExtensions>({
            extensions: [],
            diagnostics: [],
          });
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
    const [data, queue, extensions, resources] = await Promise.all([
      settingsRequest,
      queueRequest,
      extensionsRequest,
      resourcesRequest,
    ]);
    this.resources = resources;
    const tools =
      this.current.role === "coding"
        ? await this.transport.request<{
            tools: Pick<
              ToolDefinition,
              "name" | "label" | "description" | "parameters"
            >[];
          }>("/tools")
        : { tools: [] };
    this.toolDefinitions = tools.tools.map((tool) => ({
      ...tool,
      execute: async () => {
        throw new Error("Tools execute only inside the owning workspace");
      },
    }));
    this.settings = {
      ...this.settings,
      ...parseWorkspaceSettings(data),
    };
    this.queue = parseWorkspaceQueue(queue);
    this.configureExtensions(extensions);
    this.current = this.transport.getRemoteSnapshot();
    this.modelRuntime.refreshSnapshot();
  }

  snapshot(): WorkspaceSnapshot & { catalog?: ModelCatalog } {
    this.current = this.transport.getRemoteSnapshot();
    return {
      ...this.current,
      catalog: this.catalog,
      ...(this.catalog
        ? {
            models: this.catalog.models ?? this.current.models,
            selectedModel: this.catalog.selected,
          }
        : {}),
    };
  }
  settingsValue() {
    return this.settings;
  }
  sessionName() {
    return this.settings.sessionName || undefined;
  }
  isBashRunning() {
    return Boolean(
      this.activeBashOperationId || this.snapshot().activeBash.length,
    );
  }
  updateCatalog(catalog: ModelCatalog) {
    this.catalog = catalog;
  }
  private configureExtensions(catalog: RemoteExtensions) {
    this.extensions = catalog;
    const commands: ResolvedCommand[] = [];
    for (const name of [
      "goal",
      "loop",
      "abort",
      "retry",
      "reconnect",
      "status",
    ]) {
      commands.push({
        name,
        invocationName: name,
        sourceInfo: {
          path: "adm",
          source: "adm",
          scope: "user",
          origin: "package",
          baseDir: "adm",
        },
        handler: async (args) => {
          if (name === "reconnect") await this.refreshSessionView();
          else {
            await this.transport.submit(`/${name}${args ? " " + args : ""}`);
            this.current = this.transport.getRemoteSnapshot();
          }
          this.extensionUi?.notify(this.snapshot().status, "info");
        },
      });
    }
    const shortcuts = new Map<string, ExtensionShortcut>();
    for (const extension of catalog.extensions) {
      if (!extension.active) continue;
      for (const command of extension.commands) {
        commands.push({
          name: command.name,
          invocationName: command.name,
          sourceInfo: {
            path: command.path,
            source: extension.name,
            scope: "project",
            origin: "package",
            baseDir: extension.path,
          },
          ...(command.description ? { description: command.description } : {}),
          handler: async (args) =>
            this.runExtensionOperation("command", command.name, args),
        });
      }
      for (const shortcut of extension.shortcuts) {
        if (!isKeyId(shortcut.key))
          throw new Error(
            `Runner returned invalid extension shortcut key ${shortcut.key}`,
          );
        shortcuts.set(shortcut.key, {
          shortcut: shortcut.key,
          extensionPath: extension.path,
          ...(shortcut.description
            ? { description: shortcut.description }
            : {}),
          handler: async () =>
            this.runExtensionOperation("shortcut", shortcut.name, ""),
        });
      }
    }
    this.remoteCommands = commands;
    this.remoteShortcuts = shortcuts;
  }
  private async runExtensionOperation(
    kind: "command" | "shortcut",
    name: string,
    args: string,
  ) {
    const ui = this.extensionUi;
    if (!ui)
      throw new Error(
        "Pi extension UI is not ready for this workspace command",
      );
    const requestId = randomUUID();
    const route =
      kind === "command" ? "/extensions/commands" : "/extensions/shortcuts";
    const admission = await this.transport.request<{ operationId: string }>(
      route,
      kind === "command" ? { name, args, requestId } : { name, requestId },
    );
    let after = 0;
    for await (const event of this.transport.subscribeOperationEvents<ExtensionOperationEvent>(
      `/extensions/commands/${encodeURIComponent(admission.operationId)}/events?after=${after}`,
    )) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= after)
        throw new Error(
          "Runner returned an invalid extension operation sequence",
        );
      after = event.seq;
      if (event.type === "ui_request") {
        if (!event.requestId || !event.method)
          throw new Error("Runner returned an invalid extension UI request");
        const options =
          event.timeout === undefined ? undefined : { timeout: event.timeout };
        let result: string | boolean | null;
        if (event.method === "select")
          result =
            (await ui.select(
              event.title ?? "Select",
              event.options ?? [],
              options,
            )) ?? null;
        else if (event.method === "confirm")
          result = await ui.confirm(
            event.title ?? "Confirm",
            event.message ?? "",
            options,
          );
        else if (event.method === "input")
          result =
            (await ui.input(
              event.title ?? "Input",
              event.placeholder,
              options,
            )) ?? null;
        else if (event.method === "editor")
          result =
            (await ui.editor(event.title ?? "Edit", event.prefill)) ?? null;
        else result = ui.getEditorText();
        await this.transport.request(
          `/extensions/commands/${encodeURIComponent(admission.operationId)}/ui`,
          { requestId: event.requestId, result },
        );
      } else if (event.type === "notification") {
        if (event.message) ui.notify(event.message, event.level ?? "info");
      } else if (event.type === "status") {
        if (event.key) ui.setStatus(event.key, event.text);
      } else if (event.type === "title") {
        if (event.title) ui.setTitle(event.title);
      } else if (event.type === "editor_text") {
        ui.setEditorText(event.text ?? "");
      } else if (event.type === "working_message") {
        ui.setWorkingMessage(event.message);
      } else if (event.type === "working_visible") {
        ui.setWorkingVisible(event.visible === true);
      } else if (event.type === "error") {
        throw new Error(
          event.message ??
            `Extension ${kind} failed (${event.code ?? "unknown"})`,
        );
      } else if (event.type === "result") {
        return;
      } else {
        throw new Error(
          `Runner returned unsupported extension event ${event.type}`,
        );
      }
    }
    throw new Error("Extension operation stream ended before a result");
  }
  agentState() {
    const model = this.session.model;
    return {
      systemPrompt: "",
      ...(model ? { model } : {}),
      thinkingLevel: this.settings.thinkingLevel,
      tools: this.toolDefinitions,
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
      get scopedModels() {
        const available = modelRuntime.getAvailableSnapshot();
        return runtime.settingsValue().scopedModels.flatMap((id) => {
          const model = available.find(
            (candidate) => `${candidate.provider}/${candidate.id}` === id,
          );
          return model ? [{ model }] : [];
        });
      },
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
        return runtime.settings.steeringMode;
      },
      get followUpMode() {
        return runtime.settings.followUpMode;
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
        return runtime.isBashRunning();
      },
      get autoCompactionEnabled() {
        return runtime.settings.autoCompact;
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
        return runtime.snapshot().cacheWarming;
      },
      get sessionId() {
        return manager.getSessionId();
      },
      get sessionName() {
        return runtime.sessionName();
      },
      getAvailableThinkingLevels: () => runtime.availableThinkingLevels(),
      getContextUsage: () => runtime.contextUsage(),
      getSessionStats: () => runtime.sessionStats(),
      getLastAssistantText: () => runtime.lastAssistantText(),
      getUserMessagesForForking: () => runtime.userMessagesForForking(),
      getSteeringMessages: () => [...runtime.queue.steering],
      getFollowUpMessages: () => [...runtime.queue.followUp],
      getToolDefinition: (name: string) =>
        runtime.toolDefinitions.find((tool) => tool.name === name),
      getToolDefinitions: () => runtime.toolDefinitions,
      executeBash: (
        command: string,
        onChunk?: (chunk: string) => void,
        options?: { excludeFromContext?: boolean; id?: string },
      ) => runtime.executeBash(command, onChunk, options),
      recordBashResult: () => {
        /* The workspace executor persists the result before its SSE event. */
      },
      exportToHtml: async (
        outputPath?: string,
        options?: { themeName?: string },
      ) =>
        exportDurableSessionHtml(
          {
            role: runtime.snapshot().role,
            id: manager.getSessionId(),
            cwd: manager.getCwd(),
            name: runtime.sessionName(),
            entries: manager.getBranch(),
            ...(runtime.snapshot().role === "coding"
              ? {
                  systemPrompt: resources.getSystemPrompt() ?? "",
                  tools: runtime.toolDefinitions.map(
                    ({ name, description, parameters }) => ({
                      name,
                      description,
                      parameters,
                    }),
                  ),
                }
              : {}),
          },
          outputPath,
          options,
        ),
      exportToJsonl: (outputPath?: string) =>
        exportDurableSessionJsonl(
          {
            role: runtime.snapshot().role,
            id: manager.getSessionId(),
            cwd: manager.getCwd(),
            name: runtime.sessionName(),
            entries: manager.getBranch(),
            ...(runtime.snapshot().role === "coding"
              ? { systemPrompt: resources.getSystemPrompt() ?? "" }
              : {}),
          },
          outputPath,
        ),
      clearQueue: () => runtime.clearQueue(),
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
      setScopedModels: (models: { model: SessionModel }[]) =>
        runtime.updateSettings({
          scopedModels: models.map(
            ({ model }) => `${model.provider}/${model.id}`,
          ),
        }),
      setCacheWarmingMode: (mode: "off" | "streaming" | "idle") =>
        runtime.updateSettings({ cacheWarmingMode: mode }),
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
      setAutoCompactionEnabled: (enabled: boolean) =>
        runtime.updateSettings({ autoCompact: enabled }),
      setSteeringMode: (mode: "all" | "one-at-a-time") =>
        runtime.updateSettings({ steeringMode: mode }),
      setFollowUpMode: (mode: "all" | "one-at-a-time") =>
        runtime.updateSettings({ followUpMode: mode }),
      setSessionName: (name: string) =>
        runtime.updateSettings({ sessionName: name }),
      compact: (instructions?: string) => runtime.compact(instructions),
      reset: (handoff?: string) => runtime.reset(handoff),
      navigateTree: (entryId: string) => runtime.forkEntry(entryId),
      bindExtensions: async (options?: { uiContext?: ExtensionUIContext }) => {
        runtime.extensionUi = options?.uiContext;
      },
      getAvailableTools: () => runtime.toolDefinitions,
      getActiveToolNames: () =>
        runtime.toolDefinitions.map((tool) => tool.name),
      getSteeringMode: () => runtime.settings.steeringMode,
      getFollowUpMode: () => runtime.settings.followUpMode,
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
    if (message.startsWith("/")) {
      const [invocation, ...rest] = message.slice(1).split(/\s+/);
      const command = this.remoteCommands.find(
        (candidate) => candidate.invocationName === invocation,
      );
      if (command) {
        await this.runExtensionOperation(
          "command",
          command.name,
          rest.join(" "),
        );
        return;
      }
    }
    const images = options?.images;
    await this.transport.request("/input", {
      message,
      ...(images?.length ? { images } : {}),
      requestId: randomUUID(),
      whenBusy:
        options?.streamingBehavior === "followUp" ? "followUp" : "steer",
    });
    await this.refreshQueue();
  }
  private async refreshQueue() {
    this.queue = parseWorkspaceQueue(
      await this.transport.request<WorkspaceQueue>("/queue"),
    );
  }
  private async clearQueue() {
    const withdrawn = await this.transport.request<WorkspaceQueue>(
      "/queue/clear",
      {},
      undefined,
      "POST",
    );
    this.queue = parseWorkspaceQueue(withdrawn);
    return this.queue;
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
    const operationId =
      this.activeBashOperationId ?? this.snapshot().activeBash[0]?.operationId;
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
    this.updateCatalog({
      ...this.catalog,
      models: this.modelRuntime.getAvailableSnapshot(),
      selected: result.selected,
    });
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
      isScoped: this.settings.scopedModels.includes(
        `${next.provider}/${next.id}`,
      ),
    };
  }
  private async setThinkingLevel(level: ThinkingLevel) {
    await this.updateSettings({ thinkingLevel: level });
  }
  private async updateSettings(patch: Partial<WorkspaceSettings>) {
    const saved = await this.transport.request<Partial<WorkspaceSettings>>(
      "/settings",
      patch,
      undefined,
      "PUT",
    );
    this.settings = { ...this.settings, ...parseWorkspaceSettings(saved) };
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
        if (message) {
          this.piStreamingAssistant = true;
          void this.emit({
            type: "message_start",
            message,
          } as AgentSessionEvent);
        }
        if (this.streaming)
          void this.emit({ type: "agent_start" } as AgentSessionEvent);
      } else if (data?.type === "message_start") {
        this.streaming = true;
        void this.emit({ type: "agent_start" } as AgentSessionEvent);
        // Durable also starts each saved message it did not stream, directly
        // before its `message_end`; those are shown from their entry.
        if (
          data.message?.role === "assistant" &&
          !this.savedMessageShown(data.message)
        ) {
          this.piStreamingAssistant = true;
          void this.emit({
            type: "message_start",
            message: data.message,
          } as AgentSessionEvent);
        }
      } else if (data?.type === "message_end") {
        const message = data.entry?.model?.[0] as AgentMessage | undefined;
        const entryId = Number(data.entry?.id);
        // An entry already among the session's records is already shown.
        if (
          (message?.role === "assistant" || message?.role === "user") &&
          !this.snapshot().events.some((record) => record.seq === entryId)
        )
          this.showSavedMessage(entryId, message);
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
        void this.emit(piToolExecutionEnd(data) as AgentSessionEvent);
      } else if (data?.type === "turn_start") {
        this.streaming = true;
        void this.emit({ type: "turn_start" } as AgentSessionEvent);
      } else if (data?.type === "turn_end") {
        this.streaming = false;
        // Pi drops a streaming component its turn did not finish; a saved
        // reply still on its way is shown from its entry.
        this.piStreamingAssistant = false;
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
      this.showSavedMessage(event.seq!, message);
    } else if (event.kind === "user" && message?.role === "user") {
      this.promptCount++;
      this.showSavedMessage(event.seq!, message);
    } else if (event.kind === "tool" && message?.role === "toolResult") {
      void this.emit({ type: "message_end", message } as AgentSessionEvent);
    } else if (event.kind === "message" && message?.role === "bashExecution") {
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
  // Show a saved message once, whichever of live and history brings it first.
  // It finishes Pi's streaming assistant component when there is one: that is
  // this message, because live events arrive in order and a later partial only
  // starts after this message's live `message_end`. Otherwise it starts its own
  // component, e.g. after Pi's `agent_end` dropped the streamed one.
  private showSavedMessage(entryId: number, message: AgentMessage) {
    if (this.savedEntriesShown.has(entryId)) return;
    this.savedEntriesShown.add(entryId);
    if (!(message.role === "assistant" && this.piStreamingAssistant))
      void this.emit({ type: "message_start", message } as AgentSessionEvent);
    void this.emit({ type: "message_end", message } as AgentSessionEvent);
    if (message.role === "assistant") this.piStreamingAssistant = false;
  }
  // A saved assistant message already among the session's records, so shown.
  private savedMessageShown(message: AgentMessage) {
    const saved = JSON.stringify(message);
    return this.snapshot().events.some(
      (record) =>
        record.kind === "assistant" &&
        JSON.stringify(record.data?.message) === saved,
    );
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
    await this.initialize();
    this.current = this.transport.getRemoteSnapshot();
    this.modelRuntime.refreshSnapshot();
    // Pi synchronously re-renders exactly the session's records when rebound;
    // live-shown entries not yet among them are shown again from history.
    this.savedEntriesShown.clear();
    this.piStreamingAssistant = false;
    await this.rebindSession?.(this.session);
  }
  async dispose() {
    this.unlisten();
  }
}
