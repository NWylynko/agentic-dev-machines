import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  hook,
  Harness,
  ToolTask,
  type EntryRecord,
  type ConversationId,
  type TaskInspection,
  type UserInput,
  type Cursor,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defaultRemoteEnv, KubernetesExecutionEnv } from "./kubernetes-env.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { WorkspaceResources } from "./resources.ts";
import { UserBashTask, type BashInput, type BashResult } from "./bash.ts";
import { WorkspaceCacheWarming } from "./cache-warming.ts";
import {
  createDurableExtensionBridge,
  createCommandOperation,
  createShortcutOperation,
  ExtensionCommandOperation,
  ExtensionOperationsDocument,
  type ExtensionCommandState,
  type ExtensionCommandEvent,
  type ExtensionOperationReceipt,
} from "./extensions.ts";
import {
  workspaceModels,
  workspaceProviderMetadata,
  type LifecycleAuthorityAvailability,
} from "./models.ts";
import {
  activeWorkspaceConversation,
  createWorkspaceConversation,
  createWorkspaceImportedTree,
  forkWorkspaceBranch,
  initializeNavigation,
  nameWorkspaceConversation,
  selectWorkspaceBranch,
  workspaceBranchList,
  workspaceBranches,
} from "./navigation.ts";
import { clearWorkspaceInputQueue, workspaceInputQueue } from "./queue.ts";
import type { Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { BotProfileDocument, botExtension } from "./bot.ts";
import type { BotAgentManagement } from "./bot-management.ts";
import { openMcpExtension } from "./mcp.ts";
import {
  applyGoal,
  applyLoop,
  createScheduleExtension,
  publicSchedule,
  scheduleDocument,
} from "./schedule.ts";
import { ApiError, type RunnerEvent, type WorkspaceConfig } from "./types.ts";
import {
  parseWorkspaceSettingsPatch,
  WorkspaceBehaviorSettings,
} from "./workspace-settings.ts";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

type BashHistoryData = {
  operationId: string;
  requestId: string;
  message: BashResult;
  timestamp: number;
};

export function entryEvent(
  config: WorkspaceConfig,
  entry: EntryRecord,
): RunnerEvent | undefined {
  const custom = entry.data as Record<string, unknown> | undefined;
  const message = entry.model?.[0];
  const timestamp = new Date(
    typeof custom?.timestamp === "number"
      ? custom.timestamp
      : typeof message?.timestamp === "number"
        ? message.timestamp
        : 0,
  ).toISOString();
  const base = { seq: Number(entry.id), workspaceId: config.id, timestamp };
  if (entry.kind === "adm.message")
    return { ...base, kind: "message", data: custom ?? {} };
  if (entry.kind === "adm.status")
    return { ...base, kind: "status", data: custom ?? {} };
  if (entry.kind === "admbash")
    return { ...base, kind: "message", data: custom ?? {} };
  if (message?.role === "user")
    return {
      ...base,
      kind: "user",
      data: { text: textContent(message.content), message },
    };
  if (message?.role === "assistant")
    return {
      ...base,
      kind: "assistant",
      data: {
        text: textContent(message.content),
        message,
        stopReason: message.stopReason,
        usage: message.usage,
        ...(message.errorMessage ? { error: message.errorMessage } : {}),
      },
    };
  if (message?.role === "toolResult")
    return {
      ...base,
      kind: "tool",
      data: {
        name: message.toolName,
        text: textContent(message.content),
        isError: message.isError,
        message,
        toolCallId: message.toolCallId,
        details: message.details,
        durationMs: message.durationMs,
      },
    };
  return undefined;
}

function agentIsBusy(task: TaskInspection) {
  const state = task.record.state;
  if (state.status === "terminal" || state.status === "completing")
    return state.status !== "terminal";
  if (
    task.record.kind !== "adm.loop" ||
    !state.checkpoint ||
    typeof state.checkpoint !== "object" ||
    Array.isArray(state.checkpoint)
  )
    return true;
  return state.checkpoint.phase !== "wait";
}

export class Workspace {
  config: WorkspaceConfig;
  resources?: WorkspaceResources;
  harness: Awaited<ReturnType<typeof Harness.open>>;
  conversation: Awaited<
    ReturnType<Awaited<ReturnType<typeof Harness.open>>["root"]>
  >;
  events = new EventEmitter();
  private bashStreams = new Map<
    string,
    {
      next: number;
      bytes: number;
      chunks: {
        operationId: string;
        sequence: number;
        text: string;
        stream: "stdout" | "stderr";
      }[];
    }
  >();
  closed = false;
  passive = false;
  lastError?: string;
  mcpError?: string;
  localEnv?: NodeExecutionEnv;
  kubeEnv?: KubernetesExecutionEnv;
  private execution?: ExecutionEnv;
  private accepting = true;
  private extensionOperations = new Map<string, ExtensionCommandOperation>();
  private extensionRequests = new Map<
    string,
    { fingerprint: string; operationId: string }
  >();
  private extensionIdle = true;
  private extensionUsage?: { tokens: number; contextWindow: number };
  private admissions = Promise.resolve();
  private models: Models;
  private behaviorSettings: WorkspaceBehaviorSettings;
  private cacheWarming: WorkspaceCacheWarming;
  private registry: ReturnType<typeof createRegistry>;
  private readonly assertActive: (signal?: AbortSignal) => Promise<void>;
  private readonly loopTask: ReturnType<
    typeof createScheduleExtension
  >["loopTask"];
  private unsubscribe: () => void;
  private sandbox?: CodemodeSandbox;
  private mcpClose?: () => Promise<void>;
  private constructor(
    config: WorkspaceConfig,
    harness: Workspace["harness"],
    conversation: Workspace["conversation"],
    models: Models,
    behaviorSettings: WorkspaceBehaviorSettings,
    cacheWarming: WorkspaceCacheWarming,
    registry: ReturnType<typeof createRegistry>,
    assertActive: (signal?: AbortSignal) => Promise<void>,
    loopTask: Workspace["loopTask"],
    mcpClose?: () => Promise<void>,
  ) {
    this.config = config;
    this.harness = harness;
    this.conversation = conversation;
    this.models = models;
    this.behaviorSettings = behaviorSettings;
    this.cacheWarming = cacheWarming;
    this.registry = registry;
    this.assertActive = assertActive;
    this.loopTask = loopTask;
    this.mcpClose = mcpClose;
    this.unsubscribe = harness.subscribeCommits((publication) => {
      this.cacheWarming.observeCommit(publication);
      this.events.emit("change");
      for (const operationId of this.bashStreams.keys())
        void this.bashResult(operationId).then((result) => {
          if (result) this.bashStreams.delete(operationId);
        });
    });
  }

  async extensionContext(
    signal?: AbortSignal,
    generationBusy = false,
  ): Promise<ExtensionContext> {
    signal?.throwIfAborted();
    const selected = (await this.conversation.agent(context)).model;
    const model = selected
      ? this.models.getModel(selected.provider, selected.modelId)
      : undefined;
    if (model && this.extensionUsage)
      this.extensionUsage.contextWindow = model.contextWindow;
    const registry = new Proxy(
      {
        getAll: () => this.models.getModels(),
        find: (provider: string, modelId: string) =>
          this.models.getModel(provider, modelId),
        getProvider: (provider: string) => this.models.getProvider(provider),
        getProviderDisplayName: (provider: string) =>
          this.models.getProvider(provider)?.name ?? provider,
      },
      {
        get(target, property, receiver) {
          if (Reflect.has(target, property))
            return Reflect.get(target, property, receiver);
          throw new Error(
            `Pi extension operation modelRegistry.${String(property)} is not supported by the Durable bridge`,
          );
        },
      },
    );
    const ui = new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(
            `Pi extension operation ui.${String(property)} is not available in this Durable context`,
          );
        },
      },
    ) as ExtensionUIContext;
    return {
      ui,
      mode: "rpc",
      hasUI: false,
      cwd: this.config.cwd ?? this.config.localRoot ?? "/workspace",
      sessionManager: new Proxy(
        {},
        {
          get: (_target, property) => {
            throw new Error(
              `Pi sessionManager.${String(property)} is unavailable because this workspace uses Durable history`,
            );
          },
        },
      ) as ExtensionContext["sessionManager"],
      modelRegistry: registry as unknown as ExtensionContext["modelRegistry"],
      model,
      scopedModels: [],
      signal,
      isIdle: () => (generationBusy ? false : this.extensionIdle),
      isProjectTrusted: () => this.resources?.trust().trusted ?? false,
      hasPendingMessages: () => {
        throw new Error(
          "Pi pending-message state is not available through Durable conversations",
        );
      },
      abort: () => {
        void this.conversation.abort(context, { background: true });
      },
      shutdown: () => {
        throw new Error(
          "Pi extension shutdown is not available in a Durable workspace",
        );
      },
      getContextUsage: () => {
        if (!this.extensionUsage) return undefined;
        const percent = this.extensionUsage.contextWindow
          ? (this.extensionUsage.tokens / this.extensionUsage.contextWindow) *
            100
          : null;
        return {
          tokens: this.extensionUsage.tokens,
          contextWindow: this.extensionUsage.contextWindow,
          percent,
        };
      },
      compact: (options) => {
        void this.conversation.compact(options?.customInstructions, context);
      },
      getSystemPrompt: () => {
        throw new Error(
          "Pi getSystemPrompt is unavailable outside a provider request",
        );
      },
    };
  }

  static async open(
    config: WorkspaceConfig,
    directory: string,
    assertActive: (signal?: AbortSignal) => Promise<void>,
    authPath?: string,
    botAgents?: BotAgentManagement,
    passive = false,
    deferActivation = false,
    runtimeProvider?: string,
    availability?: LifecycleAuthorityAvailability,
  ): Promise<Workspace> {
    if (!passive) await assertActive();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const behaviorSettings = await WorkspaceBehaviorSettings.open(
      directory,
      () => assertActive(),
    );
    let openedWorkspace: Workspace | undefined;
    let reportedError: string | undefined;
    let mcpError: string | undefined;
    const recordError = (error: unknown) => {
      reportedError = (
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      ).slice(0, 2000);
      if (openedWorkspace) openedWorkspace.lastError = reportedError;
    };
    const recordMcpError = (error: unknown) => {
      mcpError = (
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      ).slice(0, 2000);
      if (openedWorkspace) openedWorkspace.mcpError = mcpError;
    };
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "workspace-user-bash",
        tasks: [UserBashTask],
        hooks: [
          hook(UserBashTask, {
            assertActive: (signal) => assertActive(signal),
            output: (operationId, text, stream) => {
              const workspace = openedWorkspace;
              if (!workspace) return;
              const state = workspace.bashStreams.get(operationId) ?? {
                next: 1,
                bytes: 0,
                chunks: [],
              };
              const chunk = {
                operationId,
                sequence: state.next++,
                text,
                stream,
              };
              state.chunks.push(chunk);
              state.bytes += Buffer.byteLength(text);
              while (state.bytes > 256 * 1024 && state.chunks.length) {
                const dropped = state.chunks.shift()!;
                state.bytes -= Buffer.byteLength(dropped.text);
              }
              workspace.bashStreams.set(operationId, state);
              workspace.events.emit("bash", chunk);
            },
          }),
        ],
      }),
    );
    const schedule = createScheduleExtension(
      (message, requestId, loopId, generation, conversationId, call) => {
        if (!openedWorkspace)
          throw new Error("Workspace is not ready to admit scheduled input");
        return openedWorkspace.admitLoopInput(
          message,
          requestId,
          loopId,
          generation,
          conversationId,
          call,
        );
      },
    );
    registry.install(schedule.extension);
    let localEnv: NodeExecutionEnv | undefined;
    let kubeEnv: KubernetesExecutionEnv | undefined;
    let sandbox: CodemodeSandbox | undefined;
    let mcp: Awaited<ReturnType<typeof openMcpExtension>> | undefined;
    let closeOpenedState: (() => Promise<void>) | undefined;
    try {
      if (config.role === "coding") {
        registry.install(CodingTools);
        if (config.environment === "local" || config.environment === "pod") {
          await mkdir(config.localRoot!, { recursive: true });
          localEnv = new NodeExecutionEnv({
            cwd: config.cwd ?? config.localRoot!,
          });
        } else if (!passive) {
          kubeEnv = new KubernetesExecutionEnv({
            kubectl: config.kubectl ?? "kubectl",
            kubeconfig: config.kubeconfig,
            namespace: config.namespace!,
            container: config.container ?? "dev",
            cwd: config.cwd ?? "/repos",
            script: config.remoteEnv ?? defaultRemoteEnv,
          });
        }
      }
      if (config.role === "bot") {
        if (!passive && config.mcpServers?.length) {
          mcp = await openMcpExtension(config, assertActive, recordMcpError);
          registry.install(mcp.extension);
        }
        sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
        if (!botAgents)
          throw new Error("Bot agent management transport is not configured");
        registry.install(botExtension(config, assertActive, botAgents));
        registry.install(createCodemodeExtension({ sandbox, models: false }));
      }
      const resources =
        config.role === "coding" && config.environment !== "kubernetes"
          ? new WorkspaceResources(config, directory, () => assertActive())
          : undefined;
      if (resources && !passive) {
        await resources.reload();
        registry.install(
          createDurableExtensionBridge(resources.extensions(), assertActive),
        );
      }
      registry.install(
        defineExtension({
          name: "workspace-lifecycle",
          hooks: [
            hook(ToolTask, {
              beforeTool: async (_call, _api, context) => {
                await assertActive(context.abortSignal);
                return undefined;
              },
            }),
            hook(GenerationTask, {
              beforeRequest: async (request, _api, context) => {
                await assertActive(context.abortSignal);
                openedWorkspace?.setExtensionGenerationBusy(true);
                return resources
                  ? {
                      messages: await resources.requestMessages(
                        request.messages,
                      ),
                    }
                  : undefined;
              },
              afterResponse: async (message, api) => {
                openedWorkspace?.setExtensionGenerationBusy(false);
                openedWorkspace?.setExtensionUsage(message.usage.totalTokens);
                reportedError =
                  message.stopReason === "error"
                    ? (message.errorMessage ?? "The provider request failed")
                    : undefined;
                if (openedWorkspace) openedWorkspace.lastError = reportedError;
                await openedWorkspace?.cacheWarming.afterResponse(
                  message,
                  Number(api.conversationId),
                );
              },
            }),
          ],
        }),
      );
      const execution: ExecutionEnv | undefined = localEnv ?? kubeEnv;
      const databasePath = join(directory, "session.sqlite");
      const storage = await openNodeSqliteStorage(databasePath);
      closeOpenedState = () => storage.close(context);
      await chmod(databasePath, 0o600);
      const models = await workspaceModels(
        config.model?.provider ?? runtimeProvider,
        authPath,
        config.localRoot ?? "/workspace",
        availability,
      );
      const cacheWarming = WorkspaceCacheWarming.open(
        models,
        () => behaviorSettings.current.cacheWarmingMode,
        assertActive,
        recordError,
        () =>
          openedWorkspace?.config.model
            ? `${openedWorkspace.config.model.provider}/${openedWorkspace.config.model.id}`
            : undefined,
        () =>
          openedWorkspace?.conversation
            ? Number(openedWorkspace.conversation.id)
            : undefined,
      );
      const harnessModels = cacheWarming.wrapModels();
      const fencedStorage = new Proxy(storage, {
        get(target, property) {
          if (property === "commit")
            return async (...args: Parameters<typeof target.commit>) => {
              if (config.environment === "pod") await assertActive();
              return target.commit(...args);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const harness = await Harness.open(
        fencedStorage,
        {
          models: harnessModels,
          registry,
          settings: behaviorSettings.harness,
          ...(execution ? { env: () => openedWorkspace!.execution! } : {}),
          onReport: recordError,
        },
        context,
      );
      closeOpenedState = () => harness.close(context);
      const conversation = await harness.root(context, {
        agent: config.model
          ? {
              model: {
                provider: config.model.provider,
                modelId: config.model.id,
              },
            }
          : {},
        init:
          config.role === "bot" && config.onboardingRequired
            ? async (tx, conversationId) => {
                const profile = await tx.doc(
                  BotProfileDocument,
                  conversationId,
                );
                profile.state = "collecting";
                profile.approvedToolGrants = (config.mcpServers ?? []).flatMap(
                  (server) =>
                    server.tools.map((tool) => `${server.id}:${tool}`),
                );
              }
            : undefined,
      });
      await initializeNavigation(harness, Number(conversation.id));
      const activeConversation = await activeWorkspaceConversation(harness);
      await cacheWarming.attachConversation(activeConversation);
      const selectedModel = (await activeConversation.agent(context)).model;
      const effectiveConfig: WorkspaceConfig = {
        ...config,
        ...(selectedModel
          ? {
              model: {
                provider: selectedModel.provider,
                id: selectedModel.modelId,
              },
            }
          : { model: undefined }),
      };
      const workspace = new Workspace(
        effectiveConfig,
        harness,
        activeConversation,
        models,
        behaviorSettings,
        cacheWarming,
        registry,
        assertActive,
        schedule.loopTask,
        mcp?.close,
      );
      openedWorkspace = workspace;
      workspace.resources = resources;
      if (!passive) workspace.refreshExtensionRegistry();
      workspace.lastError = reportedError;
      workspace.mcpError = mcpError;
      workspace.localEnv = localEnv;
      workspace.kubeEnv = kubeEnv;
      workspace.execution = localEnv ?? kubeEnv;
      workspace.sandbox = sandbox;
      workspace.passive = passive;
      if (passive) workspace.accepting = false;
      if (!passive) await workspace.recoverExtensionOperations();
      if (!passive && !deferActivation) await workspace.activate();
      return workspace;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        openedWorkspace ? () => openedWorkspace!.close(true) : closeOpenedState,
        openedWorkspace ? undefined : mcp?.close,
        openedWorkspace ? undefined : sandbox?.close.bind(sandbox),
        openedWorkspace ? undefined : kubeEnv?.cleanup.bind(kubeEnv, context),
        openedWorkspace ? undefined : localEnv?.cleanup.bind(localEnv, context),
      ]) {
        if (!cleanup) continue;
        try {
          await cleanup();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Workspace open failed and cleanup was incomplete",
        );
      throw error;
    }
  }

  async status() {
    const inspection = await this.harness.inspect(context);
    const schedule = publicSchedule(
      await this.harness.snapshot(
        scheduleDocument,
        this.conversation.id,
        context,
      ),
    );
    const busy = inspection.tasks.some((task) => agentIsBusy(task));
    const activeBash = inspection.tasks.flatMap((task) => {
      if (
        task.record.kind !== "adm.user-bash" ||
        Number(task.record.conversationId) !== Number(this.conversation.id)
      )
        return [];
      const input = task.record.input as BashInput;
      return [
        {
          operationId: input.operationId,
          requestId: input.requestId,
          command: input.command,
          excludeFromContext: input.excludeFromContext === true,
        },
      ];
    });
    const recent = await this.conversation.entries(
      { order: "descending" },
      1000,
      undefined,
      context,
    );
    const latestAssistant = recent.items.find(
      (entry) => entry.model?.[0]?.role === "assistant",
    )?.model?.[0];
    const error =
      latestAssistant?.role === "assistant" &&
      latestAssistant.stopReason === "error"
        ? (latestAssistant.errorMessage ?? "The provider request failed")
        : (this.mcpError ?? this.lastError);
    const profile =
      this.config.role === "bot"
        ? await this.harness.snapshot(
            BotProfileDocument,
            this.conversation.id,
            context,
          )
        : undefined;
    const status =
      this.passive || this.closed
        ? "deleted"
        : !this.config.model
          ? "needs_model"
          : busy
            ? "running"
            : error
              ? "error"
              : "idle";
    return {
      ...this.config,
      conversationId: Number(this.conversation.id),
      ...(profile ? { profile } : {}),
      activeBash,
      cacheWarming: this.cacheWarming.status,
      status,
      goals: schedule.goals,
      loops: schedule.loops,
      tasks: inspection.tasks,
      error,
      tools: (await this.conversation.agent(context)).tools.map(
        (tool) => tool.name,
      ),
    };
  }

  async input(
    message: UserInput,
    requestId?: string,
    whenBusy: "steer" | "followUp" | "reject" = "steer",
  ) {
    return this.withAdmission(async () => {
      if (!this.config.model)
        throw new ApiError(
          409,
          "MODEL_REQUIRED",
          "Select a model before submitting input",
        );
      const submission = await this.conversation.submit(
        {
          type: "input",
          content: message,
          ...(requestId ? { requestId } : {}),
          whenBusy,
        },
        context,
      );
      return { submissionId: Number(submission.id), status: "admitted" };
    });
  }

  // The conversation's own model; reads no catalogue and makes no provider
  // requests, so runtime status stays fast while the catalogue is slow.
  async conversationSelectedModel() {
    const selected = (await this.conversation.agent(context)).model;
    return selected
      ? { provider: selected.provider, id: selected.modelId }
      : undefined;
  }

  async modelCatalog(signal?: AbortSignal, refresh = false) {
    if (signal?.aborted) throw signal.reason;
    const refreshResult = refresh
      ? await this.models.refresh({ signal })
      : undefined;
    const available = await this.models.getAvailable(undefined, { signal });
    const providers = await workspaceProviderMetadata(this.models, signal);
    return {
      selected: await this.conversationSelectedModel(),
      providers,
      models: available.map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        api: model.api,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        input: model.input,
      })),
      error: refreshResult?.errors.size
        ? [...refreshResult.errors.values()]
            .map((error) => error.message)
            .join("; ")
        : providers.length > 0 && available.length === 0
          ? "Set workspace credentials before selecting a model."
          : undefined,
      refresh: refreshResult
        ? {
            aborted: refreshResult.aborted,
            errors: [...refreshResult.errors].map(([provider, error]) => ({
              provider,
              message: error.message,
            })),
          }
        : undefined,
    };
  }

  async toolMetadata() {
    if (this.config.role !== "coding")
      throw new ApiError(
        403,
        "CODING_RESOURCES_REQUIRED",
        "Tool definitions are available only to the owning coding workspace",
      );
    const agent = await this.conversation.agent(context);
    return {
      tools: agent.tools.map((tool) => ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      activeToolNames: agent.tools.map((tool) => tool.name),
    };
  }

  async changeModel(provider: string, modelId: string) {
    return this.withAdmission(async () => {
      const inspection = await this.harness.inspect(context);
      if (inspection.tasks.some((task) => agentIsBusy(task)))
        throw new ApiError(
          409,
          "WORKSPACE_BUSY",
          "Model changes apply to the next request; wait for active work to finish",
        );
      const available = await this.models.getAvailable(provider);
      const model = available.find((entry) => entry.id === modelId);
      if (!model) {
        const exists = this.models.getModel(provider, modelId);
        if (!exists)
          throw new ApiError(
            400,
            "MODEL_NOT_FOUND",
            "That model is not in the configured catalog",
          );
        throw new ApiError(
          409,
          "MODEL_AUTH_REQUIRED",
          `Provider ${provider} is not authenticated for model ${modelId}`,
        );
      }
      await this.conversation.configure(
        { model: { provider, modelId } },
        context,
      );
      await this.cacheWarming.cancel();
      const effective = (await this.conversation.agent(context)).model;
      this.config = {
        ...this.config,
        model: effective
          ? { provider: effective.provider, id: effective.modelId }
          : undefined,
      };
      await this.activateWhileAdmitted();
      return { selected: this.config.model };
    });
  }

  private async queueOnboarding() {
    await this.assertActive();
    const profile = await this.harness.snapshot(
      BotProfileDocument,
      this.conversation.id,
      context,
    );
    if (!profile || profile.state === "ready") return;
    await this.conversation.submit(
      {
        type: "input",
        content:
          "ADM bot onboarding: ask the user to choose your identity and purpose. Use sendMessage to publish the setup question, then wait for the user's answer. Save confirmed details with saveProfile.",
        requestId: `onboarding:${this.config.id}`,
        whenBusy: "followUp",
      },
      context,
    );
  }

  private async admitOnboarding() {
    await this.withAdmission(() => this.queueOnboarding());
  }

  private async activateWhileAdmitted() {
    if (this.passive || this.closed || !this.config.model) return;
    if (this.config.role === "bot" && this.config.onboardingRequired)
      await this.queueOnboarding();
    this.harness.resume();
  }

  async activate() {
    if (this.passive || this.closed || !this.config.model) return;
    if (this.config.role === "bot" && this.config.onboardingRequired)
      await this.admitOnboarding();
    this.harness.resume();
  }

  async rebindKubernetesConnection(
    kubectl: string,
    kubeconfig: string,
    persist: (config: WorkspaceConfig) => Promise<void>,
  ) {
    return this.withAdmission(async () => {
      if (
        this.config.role !== "coding" ||
        this.config.environment !== "kubernetes"
      )
        throw new ApiError(
          409,
          "CONNECTION_NOT_SUPPORTED",
          "Only Kubernetes coding workspaces have a host connection to rebind",
        );
      const inspection = await this.harness.inspect(context);
      if (inspection.tasks.some((task) => agentIsBusy(task)))
        throw new ApiError(
          409,
          "WORKSPACE_BUSY",
          "Workspace work is active; stop it with adm abort NAME, then retry the reconnect",
        );
      const config = { ...this.config, kubectl, kubeconfig };
      const execution = new KubernetesExecutionEnv({
        kubectl,
        kubeconfig,
        namespace: config.namespace!,
        container: config.container ?? "dev",
        cwd: config.cwd ?? "/repos",
        script: config.remoteEnv ?? defaultRemoteEnv,
      });
      await persist(config);
      await this.kubeEnv?.cleanup(context);
      this.config = config;
      this.kubeEnv = execution;
      this.execution = execution;
      return this.status();
    });
  }

  saveGoal(input: unknown, requestId?: string) {
    return this.withAdmission(() =>
      applyGoal(this.conversation, input, requestId),
    );
  }

  saveLoop(input: unknown, requestId?: string) {
    return this.withAdmission(() =>
      applyLoop(this.conversation, input, this.loopTask, requestId),
    );
  }

  admitLoopInput(
    message: string,
    requestId: string,
    loopId: string,
    generation: number,
    conversationId: ConversationId,
    call: Context,
  ) {
    return this.withAdmission(async () => {
      const schedule = await this.harness.snapshot(
        scheduleDocument,
        conversationId,
        call,
      );
      const loop = schedule?.loops.find((entry) => entry.id === loopId);
      if (
        !loop ||
        loop.status !== "active" ||
        (loop.generation ?? 1) !== generation ||
        loop.pendingRequestId !== requestId
      )
        return false;
      const owner = await this.harness.conversation(conversationId, call);
      if (!owner) return false;
      await owner.submit(
        { type: "input", content: message, requestId, whenBusy: "followUp" },
        call,
      );
      return true;
    });
  }

  async resume() {
    return this.withAdmission(async () => {
      const page = await this.conversation.entries(
        { order: "descending" },
        1000,
        undefined,
        context,
      );
      const entries = page.items;
      const latestTurnIndex = entries.findIndex((entry) => {
        const role = entry.model?.[0]?.role;
        return role === "assistant" || role === "user";
      });
      const latestTurn = entries[latestTurnIndex];
      const message = latestTurn?.model?.[0];
      if (message?.role === "user" && typeof message.content === "string") {
        const match =
          /^Continue the unanswered request from assistant error entry (\d+)\.$/.exec(
            message.content,
          );
        if (match) {
          const sourceEntryId = match[1]!;
          const submission = await this.conversation.submit(
            {
              type: "input",
              content: message.content,
              requestId: `resume:${sourceEntryId}`,
            },
            context,
          );
          return { submissionId: Number(submission.id), status: "admitted" };
        }
      }
      const inspection = await this.harness.inspect(context);
      if (inspection.tasks.some((task) => agentIsBusy(task)))
        throw new ApiError(
          409,
          "WORKSPACE_BUSY",
          "The workspace already has active work",
        );
      if (message?.role !== "assistant" || message.stopReason !== "error")
        throw new ApiError(
          409,
          "NO_RESUMABLE_FAILURE",
          "The latest turn has no provider failure to resume",
        );
      const userIndex = entries.findIndex(
        (entry, index) =>
          index > latestTurnIndex && entry.model?.[0]?.role === "user",
      );
      if (userIndex < 0)
        throw new ApiError(
          409,
          "NO_RESUMABLE_INPUT",
          "The failed provider request has no retained user input",
        );
      const toolEffect = entries
        .slice(latestTurnIndex + 1, userIndex)
        .some((entry) => {
          const earlier = entry.model?.[0];
          return (
            earlier?.role === "toolResult" ||
            (earlier?.role === "assistant" &&
              earlier.content.some((part) => part.type === "toolCall"))
          );
        });
      if (toolEffect)
        throw new ApiError(
          409,
          "RESUME_AFTER_TOOL_EFFECT",
          "A tool ran before the provider failed. Submit an explicit follow-up to avoid repeating completed actions.",
        );
      const errorEntryId = String(latestTurn.id);
      const content = `Continue the unanswered request from assistant error entry ${errorEntryId}.`;
      const submission = await this.conversation.submit(
        { type: "input", content, requestId: `resume:${errorEntryId}` },
        context,
      );
      return { submissionId: Number(submission.id), status: "admitted" };
    });
  }

  async branches() {
    return workspaceBranchList(this.harness, {
      id: this.config.id,
      cwd: this.config.cwd ?? this.config.localRoot ?? "/workspace",
      role: this.config.role,
    });
  }

  async newSession() {
    return this.withAdmission(async () => {
      await this.assertIdleForNavigation();
      const active = this.conversation;
      const agent = await active.agent(context);
      const botProfile =
        this.config.role === "bot"
          ? await this.harness.snapshot(BotProfileDocument, active.id, context)
          : undefined;
      const result = await createWorkspaceConversation(
        this.harness,
        Number(active.id),
        {
          ...(agent.model
            ? {
                model: {
                  provider: agent.model.provider,
                  modelId: agent.model.modelId,
                },
              }
            : {}),
          thinkingLevel: agent.thinkingLevel,
        },
        botProfile
          ? async (tx, conversationId) => {
              const profile = await tx.doc(BotProfileDocument, conversationId);
              profile.state = botProfile.state;
              profile.identity = botProfile.identity;
              profile.purpose = botProfile.purpose;
              profile.approvedToolGrants = botProfile.approvedToolGrants;
            }
          : undefined,
      );
      this.conversation = await activeWorkspaceConversation(this.harness);
      await this.cacheWarming.attachConversation(this.conversation);
      const selected = (await this.conversation.agent(context)).model;
      this.config = {
        ...this.config,
        model: selected
          ? { provider: selected.provider, id: selected.modelId }
          : undefined,
      };
      this.events.emit("branch");
      return { ...result, model: this.config.model };
    });
  }

  async importMessages(
    branches: readonly {
      leafId: string;
      entries: readonly {
        id: string;
        parentId: string | null;
        message: Message;
      }[];
    }[],
    selectedLeafId: string,
    sourceSession?: { id?: string; cwd?: string },
  ) {
    if (this.config.role !== "coding")
      throw new ApiError(
        403,
        "BOT_IMPORT_FORBIDDEN",
        "Bots cannot import coding-agent transcripts",
      );
    return this.withAdmission(async () => {
      await this.assertIdleForNavigation();
      const active = this.conversation;
      const agent = await active.agent(context);
      const result = await createWorkspaceImportedTree(
        this.harness,
        Number(active.id),
        {
          ...(agent.model
            ? {
                model: {
                  provider: agent.model.provider,
                  modelId: agent.model.modelId,
                },
              }
            : {}),
          thinkingLevel: agent.thinkingLevel,
        },
        selectedLeafId,
        branches,
        sourceSession,
      );
      this.conversation = await activeWorkspaceConversation(this.harness);
      await this.cacheWarming.attachConversation(this.conversation);
      const selected = (await this.conversation.agent(context)).model;
      this.config = {
        ...this.config,
        model: selected
          ? { provider: selected.provider, id: selected.modelId }
          : undefined,
      };
      this.events.emit("branch");
      return {
        ...result,
        model: this.config.model,
        importedMessages:
          branches.find((branch) => branch.leafId === selectedLeafId)?.entries
            .length ?? 0,
      };
    });
  }

  async selectBranch(conversationId: number) {
    return this.withAdmission(async () => {
      await this.assertIdleForNavigation();
      const navigation = await workspaceBranches(this.harness);
      if (
        !navigation.branches.some(
          (branch) => branch.conversationId === conversationId,
        )
      )
        throw new ApiError(
          404,
          "BRANCH_NOT_FOUND",
          "Unknown workspace conversation",
        );
      await selectWorkspaceBranch(this.harness, conversationId);
      const conversation = await activeWorkspaceConversation(this.harness);
      this.conversation = conversation;
      await this.cacheWarming.attachConversation(conversation);
      const selected = (await conversation.agent(context)).model;
      this.config = {
        ...this.config,
        model: selected
          ? { provider: selected.provider, id: selected.modelId }
          : undefined,
      };
      this.events.emit("branch");
      return {
        activeConversationId: Number(conversation.id),
        model: this.config.model,
      };
    });
  }

  async forkBranch(entryId: number) {
    return this.withAdmission(async () => {
      await this.assertIdleForNavigation();
      const entry = await this.conversation.entries(
        { order: "ascending", minEntryId: entryId as never },
        1,
        undefined,
        context,
      );
      if (Number(entry.items[0]?.id) !== entryId)
        throw new ApiError(
          404,
          "ENTRY_NOT_FOUND",
          "Entry is not part of the selected workspace conversation",
        );
      const fork = await forkWorkspaceBranch(
        this.harness,
        Number(this.conversation.id),
        entryId,
      );
      this.conversation = await activeWorkspaceConversation(this.harness);
      await this.cacheWarming.attachConversation(this.conversation);
      const selected = (await this.conversation.agent(context)).model;
      this.config = {
        ...this.config,
        model: selected
          ? { provider: selected.provider, id: selected.modelId }
          : undefined,
      };
      this.events.emit("branch");
      return fork;
    });
  }

  async tree(after = 0, limit = 200, diagnostics = false) {
    const page = await this.conversation.entries(
      { order: "ascending", minEntryId: (after + 1) as never },
      limit,
      undefined,
      context,
    );
    return {
      activeConversationId: Number(this.conversation.id),
      events: page.items
        .map((entry) => entryEvent(this.config, entry))
        .filter(
          (event): event is RunnerEvent =>
            !!event &&
            (diagnostics ||
              this.config.role !== "bot" ||
              ["user", "message", "status"].includes(event.kind)),
        ),
      nextAfter: Number(page.items.at(-1)?.id ?? after),
      hasMore: page.next !== undefined,
    };
  }

  async compact(instructions?: string) {
    return this.withAdmission(async () => ({
      taskId: Number(await this.conversation.compact(instructions, context)),
    }));
  }

  async reset(handoff?: string) {
    return this.withAdmission(async () => {
      await this.conversation.reset(handoff, context);
      return {
        activeConversationId: Number(this.conversation.id),
        status: "accepted",
      };
    });
  }

  async settings() {
    const agent = await this.conversation.agent(context);
    const navigation = await workspaceBranches(this.harness);
    const name = navigation.branches.find(
      (branch) => branch.conversationId === Number(this.conversation.id),
    )?.name;
    return {
      thinkingLevel: agent.thinkingLevel,
      ...this.behaviorSettings.current,
      ...(name ? { sessionName: name } : {}),
    };
  }

  async reloadResources() {
    if (!this.resources)
      throw new ApiError(
        403,
        "CODING_RESOURCES_REQUIRED",
        "Extensions are available only in coding workspaces",
      );
    await this.cacheWarming.cancel();
    await this.clearExtensionRegistry();
    const snapshot = await this.resources.reload();
    this.refreshExtensionRegistry();
    return snapshot;
  }

  async clearExtensionRegistry() {
    for (const operation of this.extensionOperations.values())
      operation.cancel();
    await Promise.all(
      [...this.extensionOperations.values()].map(
        (operation) =>
          new Promise<void>((resolve) =>
            operation.done ? resolve() : operation.once("finish", resolve),
          ),
      ),
    );
    this.registry.install(createDurableExtensionBridge([], this.assertActive));
  }

  refreshExtensionRegistry() {
    if (!this.resources) return;
    this.registry.install(
      createDurableExtensionBridge(
        this.resources.extensions(),
        this.assertActive,
        (signal, generationBusy) =>
          this.extensionContext(signal, generationBusy),
      ),
    );
  }

  setExtensionGenerationBusy(busy: boolean) {
    this.extensionIdle = !busy;
  }

  setExtensionUsage(tokens: number) {
    this.extensionUsage = {
      tokens,
      contextWindow: this.extensionUsage?.contextWindow ?? 0,
    };
  }

  private extensionCommandState(): ExtensionCommandState {
    return {
      isIdle: () => this.extensionIdle,
      isProjectTrusted: () => this.resources?.trust().trusted ?? false,
      getContextUsage: () => {
        if (!this.extensionUsage) return undefined;
        const tokens = this.extensionUsage.tokens;
        const contextWindow = this.extensionUsage.contextWindow;
        return {
          tokens,
          contextWindow,
          percent: contextWindow ? (tokens / contextWindow) * 100 : null,
        };
      },
    };
  }

  private async startExtensionOperation(
    operation: ExtensionCommandOperation | undefined,
    label: string,
    requestId?: string,
    fingerprint = label,
  ) {
    if (!operation)
      throw new ApiError(404, "EXTENSION_OPERATION_NOT_FOUND", label);
    const requestedOperation = operation;
    if (!requestId?.trim() || requestId.length > 128)
      throw new ApiError(
        400,
        "INVALID_REQUEST_ID",
        "requestId must be a nonempty string up to 128 characters",
      );
    let operationId = requestedOperation.id;
    await this.withAdmission(async () => {
      await this.assertActive(requestedOperation.signal);
      const receipts = await this.harness.snapshot(
        ExtensionOperationsDocument,
        this.conversation.id,
        context,
      );
      const previous = receipts?.requests.find(
        (item) => item.requestId === requestId,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError(
            409,
            "EXTENSION_REQUEST_ID_REUSED",
            "requestId was already used for another extension operation",
          );
        const stored = receipts?.operations.find(
          (item) => item.id === previous.operationId,
        );
        if (stored) {
          const existing =
            this.extensionOperations.get(stored.id) ??
            this.restoreExtensionOperation(stored);
          this.extensionOperations.set(existing.id, existing);
        }
        operationId = previous.operationId;
        return;
      }
      const acceptedOperation = requestedOperation;
      await this.harness.commit(async (tx) => {
        const document = await tx.doc(
          ExtensionOperationsDocument,
          this.conversation.id,
        );
        const terminal = new Set([
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ]);
        while (document.operations.length >= 128) {
          const oldestTerminal = document.operations.findIndex((item) =>
            terminal.has(item.status),
          );
          if (oldestTerminal < 0)
            throw new ApiError(
              503,
              "EXTENSION_RECEIPTS_FULL",
              "Extension operation receipts are full; no accepted operation was discarded",
            );
          document.operations.splice(oldestTerminal, 1);
        }
        document.operations.push({
          id: acceptedOperation.id,
          requestId,
          fingerprint,
          command: acceptedOperation.command,
          status: "accepted",
          events: [],
        });
        document.requests.push({
          requestId,
          fingerprint,
          operationId: acceptedOperation.id,
          command: acceptedOperation.command,
          status: "accepted",
        });
      }, context);
      acceptedOperation.setPersistence(
        (event) => this.persistExtensionEvent(acceptedOperation.id, event),
        async (status) => {
          await this.finishExtensionReceipt(acceptedOperation.id, status);
          if (
            this.extensionOperations.get(acceptedOperation.id) ===
            acceptedOperation
          )
            this.extensionOperations.delete(acceptedOperation.id);
        },
      );
      this.extensionOperations.set(acceptedOperation.id, acceptedOperation);
      acceptedOperation.start();
    });
    return { operationId };
  }

  async extensionCommand(name: string, args: string, requestId?: string) {
    if (!this.resources || this.config.role !== "coding")
      throw new ApiError(
        403,
        "CODING_RESOURCES_REQUIRED",
        "Extensions are available only in coding workspaces",
      );
    return this.startExtensionOperation(
      createCommandOperation(
        this.resources.extensions(),
        name,
        args,
        this.config.cwd ?? this.config.localRoot!,
        (signal) => this.assertActive(signal),
        this.extensionCommandState(),
      ),
      `Unknown Pi extension command: ${name}`,
      requestId,
      JSON.stringify(["command", name, args]),
    );
  }

  async extensionShortcut(shortcut: string, requestId?: string) {
    if (!this.resources || this.config.role !== "coding")
      throw new ApiError(
        403,
        "CODING_RESOURCES_REQUIRED",
        "Extensions are available only in coding workspaces",
      );
    return this.startExtensionOperation(
      createShortcutOperation(
        this.resources.extensions(),
        shortcut,
        this.config.cwd ?? this.config.localRoot!,
        (signal) => this.assertActive(signal),
        this.extensionCommandState(),
      ),
      `Unknown Pi extension shortcut: ${shortcut}`,
      requestId,
      JSON.stringify(["shortcut", shortcut]),
    );
  }

  private restoreExtensionOperation(receipt: ExtensionOperationReceipt) {
    const operation = new ExtensionCommandOperation(
      receipt.command,
      undefined,
      this.config.cwd ?? this.config.localRoot ?? "/workspace",
      this.assertActive,
      { id: receipt.id, history: receipt.events, status: receipt.status },
    );
    return operation;
  }

  private async recoverExtensionOperations() {
    await this.harness.commit(async (tx) => {
      const document = await tx.doc(
        ExtensionOperationsDocument,
        this.conversation.id,
      );
      for (const receipt of document.operations) {
        if (receipt.status !== "accepted") continue;
        receipt.status = "interrupted";
        const request = document.requests.find(
          (item) => item.operationId === receipt.id,
        );
        if (request) request.status = "interrupted";
        receipt.events.push({
          type: "error",
          seq: (receipt.events.at(-1)?.seq ?? 0) + 1,
          code: "EXTENSION_COMMAND_INTERRUPTED",
          message:
            "The workspace restarted while this command was running; it was not repeated.",
        });
        receipt.events = receipt.events.slice(-256);
      }
    }, context);
  }

  private async persistExtensionEvent(
    id: string,
    event: ExtensionCommandEvent,
  ) {
    await this.harness.commit(async (tx) => {
      const document = await tx.doc(
        ExtensionOperationsDocument,
        this.conversation.id,
      );
      const receipt = document.operations.find((item) => item.id === id);
      if (!receipt) throw new Error(`Missing durable extension receipt ${id}`);
      receipt.events.push(event);
      receipt.events = receipt.events.slice(-256);
    }, context);
  }

  private async finishExtensionReceipt(
    id: string,
    status: ExtensionOperationReceipt["status"],
  ) {
    await this.harness.commit(async (tx) => {
      const document = await tx.doc(
        ExtensionOperationsDocument,
        this.conversation.id,
      );
      const receipt = document.operations.find((item) => item.id === id);
      if (!receipt) throw new Error(`Missing durable extension receipt ${id}`);
      receipt.status = status;
      const request = document.requests.find((item) => item.operationId === id);
      if (request) request.status = status;
    }, context);
  }

  async extensionOperation(id: string) {
    const active = this.extensionOperations.get(id);
    if (active) return active;
    const document = await this.harness.snapshot(
      ExtensionOperationsDocument,
      this.conversation.id,
      context,
    );
    const receipt = document?.operations.find((item) => item.id === id);
    if (!receipt) return undefined;
    const restored = this.restoreExtensionOperation(receipt);
    this.extensionOperations.set(id, restored);
    return restored;
  }

  async extensionRequestByOperation(id: string) {
    const document = await this.harness.snapshot(
      ExtensionOperationsDocument,
      this.conversation.id,
      context,
    );
    return document?.requests.find((item) => item.operationId === id);
  }

  async startBash(
    command: string,
    requestId: string,
    excludeFromContext = false,
  ) {
    if (this.config.role !== "coding")
      throw new ApiError(
        403,
        "BASH_FORBIDDEN",
        "Bash is available only to coding workspaces",
      );
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.length > 100_000
    )
      throw new ApiError(
        400,
        "INVALID_BASH",
        "Bash requires a nonempty command up to 100000 characters",
      );
    if (typeof requestId !== "string" || !requestId || requestId.length > 200)
      throw new ApiError(
        400,
        "INVALID_REQUEST_ID",
        "Bash requires a requestId up to 200 characters",
      );
    return this.withAdmission(async () => {
      const completed = await this.findBashEntry(
        (data) => data.requestId === requestId,
      );
      if (completed) return { operationId: completed.operationId };
      const inspection = await this.harness.inspect(context);
      const active = inspection.tasks.find(
        (item) =>
          item.record.kind === "adm.user-bash" &&
          (item.record.input as BashInput).requestId === requestId,
      );
      if (active)
        return { operationId: (active.record.input as BashInput).operationId };
      const operationId = randomUUID();
      const input: BashInput = {
        operationId,
        requestId,
        command,
        ...(excludeFromContext ? { excludeFromContext: true } : {}),
      };
      await this.conversation.commit(
        (tx) =>
          tx.createTask(UserBashTask, input, {
            ownership: { kind: "conversation" },
            background: true,
          }),
        context,
      );
      return { operationId };
    });
  }

  async abortBash(operationId: string) {
    const inspection = await this.harness.inspect(context);
    const task = inspection.tasks.find(
      (item) =>
        item.record.kind === "adm.user-bash" &&
        (item.record.input as BashInput).operationId === operationId,
    );
    if (!task) return { status: "completed" as const };
    await this.harness.abortTask(task.record.id, context);
    return { status: "aborted" as const };
  }

  async bashResult(operationId: string): Promise<BashResult | undefined> {
    return (
      await this.findBashEntry((data) => data.operationId === operationId)
    )?.message;
  }

  private async findBashEntry(
    predicate: (data: BashHistoryData) => boolean,
  ): Promise<BashHistoryData | undefined> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.conversation.entries(
        { order: "descending" },
        1000,
        cursor,
        context,
      );
      const entry = page.items.find(
        (item) =>
          item.kind === "admbash" && predicate(item.data as BashHistoryData),
      );
      if (entry) return entry.data as BashHistoryData;
      cursor = page.next;
    } while (cursor);
    return undefined;
  }

  async bashReplay(operationId: string, after = 0) {
    const result = await this.bashResult(operationId);
    if (result)
      return {
        result,
        chunks: [] as {
          operationId: string;
          sequence: number;
          text: string;
          stream: "stdout" | "stderr";
        }[],
      };
    return {
      chunks: (this.bashStreams.get(operationId)?.chunks ?? []).filter(
        (chunk) => chunk.sequence > after,
      ),
    };
  }

  async changeSettings(value: unknown) {
    const patch = parseWorkspaceSettingsPatch(value);
    return this.withAdmission(async () => {
      if (patch.scopedModels?.length) {
        const available = new Set(
          (await this.models.getAvailable()).map(
            (model) => `${model.provider}/${model.id}`,
          ),
        );
        if (patch.scopedModels.some((id) => !available.has(id)))
          throw new ApiError(
            400,
            "INVALID_MODEL_SCOPE",
            "Model scope must contain only authenticated models in this workspace catalogue",
          );
      }
      if (patch.thinkingLevel !== undefined) {
        await this.assertIdleForNavigation();
        await this.conversation.configure(
          { thinkingLevel: patch.thinkingLevel as never },
          context,
        );
      }
      await this.behaviorSettings.update(patch);
      if (patch.cacheWarmingMode !== undefined)
        await this.cacheWarming.modeChanged();
      if (patch.sessionName !== undefined)
        await nameWorkspaceConversation(this.harness, patch.sessionName);
      return this.settings();
    });
  }

  async inputQueue() {
    return workspaceInputQueue(this.harness, this.conversation);
  }

  async clearInputQueue() {
    return this.withAdmission(() =>
      clearWorkspaceInputQueue(this.conversation),
    );
  }

  private async assertIdleForNavigation() {
    const inspection = await this.harness.inspect(context);
    if (inspection.tasks.some((task) => agentIsBusy(task)))
      throw new ApiError(
        409,
        "WORKSPACE_BUSY",
        "Wait for active workspace work to finish before changing the conversation",
      );
  }

  private async withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.admissions.then(async () => {
      if (!this.accepting || this.passive || this.closed)
        throw new ApiError(
          410,
          "WORKSPACE_DELETED",
          "This workspace is no longer accepting work",
        );
      await this.assertActive();
      return operation();
    });
    this.admissions = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async history(
    after: number,
    limit: number,
    diagnostics: boolean,
    conversation = this.conversation,
  ) {
    const page = await conversation.entries(
      { order: "ascending", minEntryId: (after + 1) as never },
      limit,
      undefined,
      context,
    );
    return {
      activeConversationId: Number(conversation.id),
      events: page.items
        .map((entry) => entryEvent(this.config, entry))
        .filter(
          (event): event is RunnerEvent =>
            !!event &&
            (diagnostics ||
              this.config.role !== "bot" ||
              ["user", "message", "status"].includes(event.kind)),
        ),
      nextAfter: Number(page.items.at(-1)?.id ?? after),
      hasMore: page.next !== undefined,
    };
  }

  async close(destroy = false) {
    if (this.closed) return;
    this.accepting = false;
    for (const operation of this.extensionOperations.values())
      operation.cancel();
    const errors: unknown[] = [];
    const attempt = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => this.admissions);
    this.closed = true;
    await attempt(() => this.cacheWarming.cancel());
    try {
      this.unsubscribe();
    } catch (error) {
      errors.push(error);
    }
    if (destroy)
      await attempt(() =>
        this.conversation.abort(context, { background: true }),
      );
    for (const cleanup of [
      () => this.kubeEnv?.cleanup(context),
      () => this.localEnv?.cleanup(context),
      () => this.harness.close(context),
      () => this.sandbox?.close(),
      () => this.mcpClose?.(),
    ])
      await attempt(async () => {
        await cleanup();
      });
    try {
      this.events.emit("close");
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      const detail = errors
        .map((error) =>
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
        )
        .join("; ");
      throw new AggregateError(
        errors,
        `Workspace ${this.config.id} shutdown incomplete: ${detail}`,
      );
    }
  }
}
