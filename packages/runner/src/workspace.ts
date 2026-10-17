import { EventEmitter } from "node:events";
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
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defaultRemoteEnv, KubernetesExecutionEnv } from "./kubernetes-env.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { workspaceModels } from "./models.ts";
import {
  activeWorkspaceConversation,
  forkWorkspaceBranch,
  initializeNavigation,
  selectWorkspaceBranch,
  workspaceBranches,
} from "./navigation.ts";
import type { Models } from "@earendil-works/pi-ai/models";
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

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

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
  harness: Awaited<ReturnType<typeof Harness.open>>;
  conversation: Awaited<
    ReturnType<Awaited<ReturnType<typeof Harness.open>>["root"]>
  >;
  events = new EventEmitter();
  closed = false;
  passive = false;
  lastError?: string;
  mcpError?: string;
  localEnv?: NodeExecutionEnv;
  kubeEnv?: KubernetesExecutionEnv;
  private execution?: ExecutionEnv;
  private accepting = true;
  private admissions = Promise.resolve();
  private models: Models;
  private readonly assertActive: () => Promise<void>;
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
    assertActive: () => Promise<void>,
    loopTask: Workspace["loopTask"],
    mcpClose?: () => Promise<void>,
  ) {
    this.config = config;
    this.harness = harness;
    this.conversation = conversation;
    this.models = models;
    this.assertActive = assertActive;
    this.loopTask = loopTask;
    this.mcpClose = mcpClose;
    this.unsubscribe = harness.subscribeCommits(() =>
      this.events.emit("change"),
    );
  }

  static async open(
    config: WorkspaceConfig,
    directory: string,
    assertActive: () => Promise<void>,
    authPath?: string,
    botAgents?: BotAgentManagement,
    passive = false,
    deferActivation = false,
    runtimeProvider?: string,
  ): Promise<Workspace> {
    if (!passive) await assertActive();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
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
      registry.install(
        defineExtension({
          name: "workspace-lifecycle",
          hooks: [
            hook(ToolTask, {
              beforeTool: async () => {
                await assertActive();
                return undefined;
              },
            }),
            hook(GenerationTask, {
              beforeRequest: async () => {
                await assertActive();
                return undefined;
              },
              afterResponse: async (message) => {
                reportedError =
                  message.stopReason === "error"
                    ? (message.errorMessage ?? "The provider request failed")
                    : undefined;
                if (openedWorkspace) openedWorkspace.lastError = reportedError;
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
      );
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
          models,
          registry,
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
        assertActive,
        schedule.loopTask,
        mcp?.close,
      );
      openedWorkspace = workspace;
      workspace.lastError = reportedError;
      workspace.mcpError = mcpError;
      workspace.localEnv = localEnv;
      workspace.kubeEnv = kubeEnv;
      workspace.execution = localEnv ?? kubeEnv;
      workspace.sandbox = sandbox;
      workspace.passive = passive;
      if (passive) workspace.accepting = false;
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
    message: string,
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

  async modelCatalog(signal?: AbortSignal, refresh = false) {
    if (signal?.aborted) throw signal.reason;
    const refreshResult = refresh
      ? await this.models.refresh({ signal })
      : undefined;
    const available = await this.models.getAvailable(undefined, { signal });
    const providers = await Promise.all(
      this.models.getProviders().map(async (provider) => ({
        id: provider.id,
        name: provider.name,
        authenticated:
          (await this.models.checkAuth(provider.id, { signal })) !== undefined,
      })),
    );
    const selected = (await this.conversation.agent(context)).model;
    return {
      selected: selected
        ? { provider: selected.provider, id: selected.modelId }
        : undefined,
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
    return workspaceBranches(this.harness);
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
    return { thinkingLevel: agent.thinkingLevel };
  }

  async changeThinkingLevel(level: string) {
    const valid = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    if (!valid.includes(level))
      throw new ApiError(
        400,
        "INVALID_THINKING_LEVEL",
        "Thinking level is not supported by Pi",
      );
    return this.withAdmission(async () => {
      await this.assertIdleForNavigation();
      await this.conversation.configure(
        { thinkingLevel: level as never },
        context,
      );
      return this.settings();
    });
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
    await this.admissions;
    if (destroy) await this.conversation.abort(context, { background: true });
    this.closed = true;
    this.unsubscribe();
    await this.kubeEnv?.cleanup(context);
    await this.localEnv?.cleanup(context);
    await this.harness.close(context);
    await this.sandbox?.close();
    await this.mcpClose?.();
    this.events.emit("close");
  }
}
