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
import { BotProfileDocument, botExtension } from "./bot.ts";
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
      data: { text: textContent(message.content) },
    };
  if (message?.role === "assistant")
    return {
      ...base,
      kind: "assistant",
      data: {
        text: textContent(message.content),
        stopReason: message.stopReason,
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
  private accepting = true;
  private admissions = Promise.resolve();
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
    assertActive: () => Promise<void>,
    loopTask: Workspace["loopTask"],
    mcpClose?: () => Promise<void>,
  ) {
    this.config = config;
    this.harness = harness;
    this.conversation = conversation;
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
    lookup?: (id: string) => Promise<Workspace>,
    passive = false,
    deferActivation = false,
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
      (message, requestId, loopId, generation, call) => {
        if (!openedWorkspace)
          throw new Error("Workspace is not ready to admit scheduled input");
        return openedWorkspace.admitLoopInput(
          message,
          requestId,
          loopId,
          generation,
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
        if (config.environment === "local") {
          await mkdir(config.localRoot!, { recursive: true });
          localEnv = new NodeExecutionEnv({ cwd: config.localRoot! });
        } else if (!passive) {
          kubeEnv = new KubernetesExecutionEnv({
            kubectl: config.kubectl ?? "kubectl",
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
        registry.install(botExtension(config, assertActive, lookup!));
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
      const harness = await Harness.open(
        storage,
        {
          models: await workspaceModels(config.model?.provider, authPath),
          registry,
          ...(execution ? { env: () => execution } : {}),
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
      const workspace = new Workspace(
        config,
        harness,
        conversation,
        assertActive,
        schedule.loopTask,
        mcp?.close,
      );
      openedWorkspace = workspace;
      workspace.lastError = reportedError;
      workspace.mcpError = mcpError;
      workspace.localEnv = localEnv;
      workspace.kubeEnv = kubeEnv;
      workspace.sandbox = sandbox;
      workspace.passive = passive;
      if (passive) workspace.accepting = false;
      if (!passive && !deferActivation) await workspace.activate();
      return workspace;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        openedWorkspace
          ? () => openedWorkspace!.close(true)
          : closeOpenedState,
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

  private async admitOnboarding() {
    await this.withAdmission(async () => {
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
    });
  }

  async activate() {
    if (this.passive || this.closed || !this.config.model) return;
    if (this.config.role === "bot" && this.config.onboardingRequired)
      await this.admitOnboarding();
    this.harness.resume();
  }

  saveGoal(input: unknown) {
    return this.withAdmission(() => applyGoal(this.conversation, input));
  }

  saveLoop(input: unknown) {
    return this.withAdmission(() =>
      applyLoop(this.conversation, input, this.loopTask),
    );
  }

  admitLoopInput(
    message: string,
    requestId: string,
    loopId: string,
    generation: number,
    call: Context,
  ) {
    return this.withAdmission(async () => {
      const schedule = await this.harness.snapshot(
        scheduleDocument,
        this.conversation.id,
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
      await this.conversation.submit(
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

  async history(after: number, limit: number, diagnostics: boolean) {
    const page = await this.conversation.entries(
      { order: "ascending", minEntryId: (after + 1) as never },
      limit,
      undefined,
      context,
    );
    return {
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
