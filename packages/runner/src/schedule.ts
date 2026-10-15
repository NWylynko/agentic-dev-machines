import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type Conversation,
  type ConversationId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { ApiError } from "./types.ts";

/** Shortest recurrence the runner will admit. Terminal commands already speak in whole seconds. */
export const minimumLoopIntervalMs = 1000;

export type GoalRecord = {
  id: string;
  description: string;
  status: "active" | "completed" | "cancelled";
  createdAt: number;
};

export type LoopRecord = {
  id: string;
  prompt: string;
  intervalMs: number;
  nextAt: number;
  status: "active" | "cancelled";
  /** Set before the prompt is admitted so a crash still delivers this occurrence exactly once. */
  pendingRequestId: string;
};

type ScheduleState = {
  goals: GoalRecord[];
  loops: LoopRecord[];
};

type LoopInput = { loopId: string };
type LoopState =
  | { phase: "wait"; epoch: number }
  | { phase: "arm"; scheduledAt: number }
  | { phase: "deliver"; scheduledAt: number; requestId: string };
type LoopResult = { scheduledAt: number };

const Schedule = defineDoc<ScheduleState>({
  kind: "adm.schedule",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ goals: [], loops: [] }),
});

function requestIdFor(loopId: string, scheduledAt: number) {
  return `loop:${loopId}:${scheduledAt}`;
}

function scheduledAtFrom(requestId: string) {
  const value = Number(requestId.slice(requestId.lastIndexOf(":") + 1));
  if (!Number.isFinite(value))
    throw new Error(`Invalid loop delivery ${requestId}`);
  return value;
}

function replaceLoop(
  loops: LoopRecord[],
  loopId: string,
  update: (loop: LoopRecord) => LoopRecord,
) {
  const index = loops.findIndex((loop) => loop.id === loopId);
  if (index < 0) return;
  const current = loops[index];
  if (!current) return;
  loops[index] = update(current);
}

async function readLoop(
  runtime: TaskRuntime<LoopInput, LoopState, LoopResult, object>,
  call: Context,
  loopId: string,
) {
  const schedule = await runtime.snapshot(
    Schedule,
    runtime.conversationId,
    call,
  );
  return schedule?.loops.find((loop) => loop.id === loopId);
}

function finish(scheduledAt: number) {
  return {
    status: "terminal" as const,
    outcome: { status: "completed" as const, result: { scheduledAt } },
  };
}

const LoopTask = defineTask<LoopInput, LoopState, LoopResult>({
  name: "adm.loop",
  version: 1,
  initial: () => ({ phase: "wait", epoch: 0 }),
  phases: {
    wait: async (task, runtime, call) => {
      const loop = await readLoop(runtime, call, task.input.loopId);
      if (!loop || loop.status !== "active") {
        await runtime.commit(async () => finish(0), call);
        return;
      }
      if (loop.pendingRequestId) {
        await runtime.commit(
          async () => ({
            status: "running",
            checkpoint: {
              phase: "deliver",
              scheduledAt: scheduledAtFrom(loop.pendingRequestId),
              requestId: loop.pendingRequestId,
            },
          }),
          call,
        );
        return;
      }
      await runtime.sleep(loop.nextAt, call);
      const due = await readLoop(runtime, call, task.input.loopId);
      if (!due || due.status !== "active") {
        await runtime.commit(async () => finish(loop.nextAt), call);
        return;
      }
      if (due.pendingRequestId) {
        await runtime.commit(
          async () => ({
            status: "running",
            checkpoint: {
              phase: "deliver",
              scheduledAt: scheduledAtFrom(due.pendingRequestId),
              requestId: due.pendingRequestId,
            },
          }),
          call,
        );
        return;
      }
      if (due.nextAt > runtime.now()) {
        await runtime.commit(
          async () => ({
            status: "running",
            checkpoint: {
              phase: "wait",
              epoch: task.state.checkpoint.epoch + 1,
            },
          }),
          call,
        );
        return;
      }
      await runtime.commit(
        async () => ({
          status: "running",
          checkpoint: { phase: "arm", scheduledAt: due.nextAt },
        }),
        call,
      );
    },
    arm: async (task, runtime, call) => {
      const scheduledAt = task.state.checkpoint.scheduledAt;
      const requestId = requestIdFor(task.input.loopId, scheduledAt);
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(Schedule, runtime.conversationId);
        replaceLoop(doc.loops, task.input.loopId, (loop) => {
          if (
            loop.status !== "active" ||
            loop.pendingRequestId ||
            loop.nextAt !== scheduledAt
          )
            return loop;
          const now = runtime.now();
          let nextAt = scheduledAt + loop.intervalMs;
          if (!(nextAt > now)) nextAt = now + loop.intervalMs;
          return { ...loop, nextAt, pendingRequestId: requestId };
        });
        return {
          status: "running",
          checkpoint: { phase: "deliver", scheduledAt, requestId },
        };
      }, call);
    },
    deliver: async (task, runtime, call) => {
      const { scheduledAt, requestId } = task.state.checkpoint;
      const loop = await readLoop(runtime, call, task.input.loopId);
      if (loop?.status === "active" && loop.pendingRequestId === requestId) {
        const conversation = await runtime.conversation(
          runtime.conversationId,
          call,
        );
        if (!conversation) throw new Error("Loop conversation is gone");
        // Admission is idempotent: a restarted phase repeats this request id instead of sending another prompt.
        await conversation.submit(
          {
            type: "input",
            content: loop.prompt,
            requestId,
            whenBusy: "followUp",
          },
          call,
        );
      }
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(Schedule, runtime.conversationId);
        const current = doc.loops.find((item) => item.id === task.input.loopId);
        replaceLoop(doc.loops, task.input.loopId, (item) =>
          item.pendingRequestId === requestId
            ? { ...item, pendingRequestId: "" }
            : item,
        );
        if (!current || current.status !== "active") return finish(scheduledAt);
        return {
          status: "running",
          checkpoint: { phase: "wait", epoch: scheduledAt },
        };
      }, call);
    },
  },
  abort: async (task, runtime, call) => {
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(Schedule, runtime.conversationId);
      replaceLoop(doc.loops, task.input.loopId, (loop) =>
        loop.status === "active"
          ? { ...loop, status: "cancelled", pendingRequestId: "" }
          : loop,
      );
      return {
        status: "terminal",
        outcome: { status: "aborted", reason: "cancelled" },
      };
    }, call);
  },
});

async function insertGoal(
  tx: Tx,
  conversationId: ConversationId,
  description: string,
) {
  const doc = await tx.doc(Schedule, conversationId);
  const goal: GoalRecord = {
    id: randomUUID(),
    description,
    status: "active",
    createdAt: Date.now(),
  };
  doc.goals.push(goal);
  return goal;
}

async function insertLoop(
  tx: Tx,
  conversationId: ConversationId,
  input: { prompt: string; intervalMs: number; nextAt: number },
) {
  const doc = await tx.doc(Schedule, conversationId);
  const loop: LoopRecord = {
    id: randomUUID(),
    prompt: input.prompt,
    intervalMs: input.intervalMs,
    nextAt: input.nextAt,
    status: "active",
    pendingRequestId: "",
  };
  doc.loops.push(loop);
  await tx.createTask(
    LoopTask,
    { loopId: loop.id },
    { ownership: { kind: "conversation" }, conversationId, background: true },
  );
  return loop;
}

function text(value: unknown, field: string, code: string) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 100_000
  )
    throw new ApiError(400, code, `${field} must be a nonempty string`);
  return value.trim();
}

function objectBody(input: unknown, code: string) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError(400, code, "JSON object required");
  return input as Record<string, unknown>;
}

export function publicSchedule(state: ScheduleState | undefined) {
  return {
    goals: (state?.goals ?? []).map((goal) => ({
      id: goal.id,
      description: goal.description,
      status: goal.status,
      createdAt: goal.createdAt,
    })),
    loops: (state?.loops ?? []).map((loop) => ({
      id: loop.id,
      prompt: loop.prompt,
      intervalMs: loop.intervalMs,
      nextAt: loop.nextAt,
      status: loop.status,
    })),
  };
}

export const scheduleDocument = Schedule;

export async function applyGoal(conversation: Conversation, input: unknown) {
  const body = objectBody(input, "INVALID_GOAL");
  if (body.id === undefined) {
    const description = text(body.description, "description", "INVALID_GOAL");
    return conversation.commit(
      (tx) => insertGoal(tx, conversation.id, description),
      context,
    );
  }
  if (typeof body.id !== "string" || body.id === "")
    throw new ApiError(400, "INVALID_GOAL", "Goal id must be a string");
  const description =
    body.description === undefined
      ? undefined
      : text(body.description, "description", "INVALID_GOAL");
  const status = body.status === undefined ? undefined : body.status;
  if (
    status !== undefined &&
    status !== "active" &&
    status !== "completed" &&
    status !== "cancelled"
  )
    throw new ApiError(
      400,
      "INVALID_GOAL",
      "Goal status must be active, completed, or cancelled",
    );
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(Schedule, conversation.id);
    const current = doc.goals.find((goal) => goal.id === body.id);
    if (!current) throw new ApiError(404, "GOAL_NOT_FOUND", "Goal not found");
    const index = doc.goals.findIndex((goal) => goal.id === body.id);
    const next: GoalRecord = {
      ...current,
      ...(description === undefined ? {} : { description }),
      ...(status === undefined ? {} : { status }),
    };
    doc.goals[index] = next;
    return next;
  }, context);
}

export async function applyLoop(conversation: Conversation, input: unknown) {
  const body = objectBody(input, "INVALID_LOOP");
  if (body.id === undefined) {
    const prompt = text(body.prompt, "prompt", "INVALID_LOOP");
    if (
      typeof body.intervalMs !== "number" ||
      !Number.isInteger(body.intervalMs) ||
      body.intervalMs < minimumLoopIntervalMs ||
      body.intervalMs > 366 * 24 * 60 * 60 * 1000
    ) {
      throw new ApiError(
        400,
        "INVALID_LOOP",
        `intervalMs must be an integer number of milliseconds from ${minimumLoopIntervalMs} through one year`,
      );
    }
    if (
      body.nextAt !== undefined &&
      (typeof body.nextAt !== "number" || !Number.isFinite(body.nextAt))
    )
      throw new ApiError(
        400,
        "INVALID_LOOP",
        "nextAt must be a finite timestamp",
      );
    const nextAt =
      typeof body.nextAt === "number"
        ? body.nextAt
        : Date.now() + body.intervalMs;
    return conversation.commit(
      (tx) =>
        insertLoop(tx, conversation.id, {
          prompt,
          intervalMs: body.intervalMs as number,
          nextAt,
        }),
      context,
    );
  }
  if (typeof body.id !== "string" || body.id === "")
    throw new ApiError(400, "INVALID_LOOP", "Loop id must be a string");
  const status = body.status === undefined ? undefined : body.status;
  if (status !== undefined && status !== "active" && status !== "cancelled")
    throw new ApiError(
      400,
      "INVALID_LOOP",
      "Loop status must be active or cancelled",
    );
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(Schedule, conversation.id);
    const index = doc.loops.findIndex((loop) => loop.id === body.id);
    const current = doc.loops[index];
    if (!current) throw new ApiError(404, "LOOP_NOT_FOUND", "Loop not found");
    const next: LoopRecord = {
      ...current,
      ...(status === undefined ? {} : { status }),
    };
    doc.loops[index] = next;
    return {
      id: next.id,
      prompt: next.prompt,
      intervalMs: next.intervalMs,
      nextAt: next.nextAt,
      status: next.status,
    };
  }, context);
}

export const scheduleExtension = defineExtension({
  name: "adm-schedule",
  tasks: [LoopTask],
  tools: [
    defineTool({
      name: "saveGoal",
      description:
        "Create or update a durable goal for this session. Pass an id to revise it.",
      parameters: Type.Object({
        description: Type.String({ minLength: 1, maxLength: 100000 }),
        id: Type.Optional(Type.String()),
        status: Type.Optional(
          Type.Union([
            Type.Literal("active"),
            Type.Literal("completed"),
            Type.Literal("cancelled"),
          ]),
        ),
      }),
      replay: "safe",
      execute: async (args, api, call) => {
        const saved = await api.memo("goal", args.id ?? randomUUID(), call);
        const goal = await api.commit(async (tx) => {
          const doc = await tx.doc(Schedule, api.conversationId);
          const index = doc.goals.findIndex((item) => item.id === saved);
          if (index < 0) {
            const created: GoalRecord = {
              id: saved,
              description: args.description,
              status: args.status ?? "active",
              createdAt: Date.now(),
            };
            doc.goals.push(created);
            return created;
          }
          const next: GoalRecord = {
            ...doc.goals[index]!,
            description: args.description,
            ...(args.status ? { status: args.status } : {}),
          };
          doc.goals[index] = next;
          return next;
        }, call);
        return { output: [{ type: "text", text: JSON.stringify(goal) }] };
      },
    }),
    defineTool({
      name: "saveLoop",
      description:
        "Create durable recurring work. The prompt is delivered with a stable request id and the next trigger is saved before delivery.",
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1, maxLength: 100000 }),
        intervalMs: Type.Integer({ minimum: minimumLoopIntervalMs }),
        nextAt: Type.Optional(Type.Number()),
      }),
      replay: "safe",
      execute: async (args, api, call) => {
        const loopId = await api.memo("loop-id", randomUUID(), call);
        const loop = await api.commit(async (tx) => {
          const doc = await tx.doc(Schedule, api.conversationId);
          const existing = doc.loops.find((item) => item.id === loopId);
          if (existing) return existing;
          const created: LoopRecord = {
            id: loopId,
            prompt: args.prompt,
            intervalMs: args.intervalMs,
            nextAt: args.nextAt ?? Date.now() + args.intervalMs,
            status: "active",
            pendingRequestId: "",
          };
          doc.loops.push(created);
          await tx.createTask(
            LoopTask,
            { loopId },
            {
              ownership: { kind: "conversation" },
              conversationId: api.conversationId,
              background: true,
            },
          );
          return created;
        }, call);
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                id: loop.id,
                prompt: loop.prompt,
                intervalMs: loop.intervalMs,
                nextAt: loop.nextAt,
                status: loop.status,
              }),
            },
          ],
        };
      },
    }),
  ],
});
