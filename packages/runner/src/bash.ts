import { defineTask } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export type BashResult = {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
};
export type BashInput = {
  operationId: string;
  requestId: string;
  command: string;
  excludeFromContext?: boolean;
};
type BashState = { phase: "execute"; intent?: true };
export type BashHooks = {
  assertActive(signal?: AbortSignal): Promise<void>;
  output(operationId: string, text: string, stream: "stdout" | "stderr"): void;
};
const maxOutputBytes = 1024 * 1024;
const piCodingAgentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const { bashExecutionToText: piBashExecutionToText } = (await import(
  new URL("./core/messages.js", piCodingAgentUrl).href
)) as { bashExecutionToText(message: BashResult): string };

export const UserBashTask = defineTask<
  BashInput,
  BashState,
  BashResult,
  BashHooks
>({
  name: "adm.user-bash",
  version: 1,
  initial: () => ({ phase: "execute" }),
  phases: {
    async execute(task, runtime, context) {
      if (task.state.checkpoint.intent) {
        const result = interrupted(task.input, runtime.now());
        await finish(task.input, result, runtime, context, true);
        return;
      }
      await runtime.commit(
        (_tx, current) => ({
          status: "running",
          checkpoint: { ...current.state.checkpoint, intent: true },
        }),
        context,
      );
      const command = task.input.command;
      let output = "";
      let bytes = 0;
      let truncated = false;
      const env = await runtime.env(context);
      if (!env) {
        await finish(
          task.input,
          {
            ...base(task.input, runtime.now()),
            output: "Workspace execution environment is unavailable",
            exitCode: 127,
          },
          runtime,
          withAbortSignal(runtime.signal, context),
        );
        return;
      }
      await runtime.hooks.each("assertActive", (assertActive) =>
        assertActive(runtime.signal),
      );
      const outputWrites: Promise<void>[] = [];
      let executed: Awaited<ReturnType<ExecutionEnv["exec"]>>;
      try {
        executed = await env.exec(
          command,
          {
            spill: { afterBytes: maxOutputBytes, afterLines: 10_000 },
            onOutput(text, _context, info) {
              output += text;
              bytes += Buffer.byteLength(text);
              while (bytes > maxOutputBytes && output.length) {
                truncated = true;
                const cut = Math.max(1, Math.floor(output.length / 8));
                const removed = output.slice(0, cut);
                output = output.slice(cut);
                bytes -= Buffer.byteLength(removed);
              }
              outputWrites.push(
                runtime.hooks
                  .each("output", (emit) =>
                    emit(task.input.operationId, text, info.stream),
                  )
                  .then(() => {})
                  .catch((error) => runtime.report(error)),
              );
            },
          },
          withAbortSignal(runtime.signal, context),
        );
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        await Promise.all(outputWrites);
        await finish(
          task.input,
          {
            ...base(task.input, runtime.now()),
            output: error instanceof Error ? error.message : String(error),
            exitCode: 127,
          },
          runtime,
          context,
        );
        return;
      }
      await Promise.all(outputWrites);
      if (!executed.ok) {
        await finish(
          task.input,
          {
            ...base(task.input, runtime.now()),
            output: executed.error.message,
            exitCode: 127,
          },
          runtime,
          context,
        );
        return;
      }
      const result: BashResult = {
        role: "bashExecution",
        command,
        output,
        exitCode: executed.value.exitCode,
        cancelled: runtime.signal.aborted,
        truncated,
        ...(executed.value.spillPath
          ? { fullOutputPath: executed.value.spillPath }
          : {}),
        timestamp: runtime.now(),
        ...(task.input.excludeFromContext ? { excludeFromContext: true } : {}),
      };
      await finish(task.input, result, runtime, context);
    },
  },
  async abort(task, runtime, context) {
    const result = interrupted(task.input, runtime.now());
    await finish(task.input, result, runtime, context, true);
  },
});

function base(input: BashInput, timestamp: number): BashResult {
  return {
    role: "bashExecution",
    command: input.command,
    output: "",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp,
    ...(input.excludeFromContext ? { excludeFromContext: true } : {}),
  };
}
function interrupted(input: BashInput, timestamp: number): BashResult {
  return {
    ...base(input, timestamp),
    output: "Command interrupted after execution intent; it was not restarted.",
    exitCode: 130,
    cancelled: true,
  };
}
async function finish(
  input: BashInput,
  result: BashResult,
  runtime: import("@earendil-works/pi-durable").TaskRuntime<
    BashInput,
    BashState,
    BashResult,
    BashHooks
  >,
  context: Context,
  aborted = false,
) {
  await runtime.commit(async (tx, current) => {
    const modelText = bashExecutionToText(result);
    await tx.appendEntry(current.conversationId, {
      kind: "admbash",
      data: {
        operationId: input.operationId,
        requestId: input.requestId,
        message: result,
        timestamp: result.timestamp,
      } as JsonObject,
      ...(!input.excludeFromContext
        ? {
            model: [
              { role: "user", content: modelText, timestamp: result.timestamp },
            ],
          }
        : {}),
    });
    return {
      status: "terminal",
      outcome: aborted
        ? { status: "aborted", reason: "aborted", result }
        : { status: "completed", result },
    };
  }, context);
}

export function bashExecutionToText(result: BashResult): string {
  return piBashExecutionToText(result);
}
