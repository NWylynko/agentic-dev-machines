// A coding agent reports to the bot that manages it (TASK-140).
//
// Coding side: a workspace with a `manager` (a bot's immutable ID) gets the
// messageManager tool, which posts to the lifecycle's
// /v1/workspaces/MANAGER/runtime/message with the Pod's token. Coding Pods
// cannot reach bot Pods, so the lifecycle forwards the text to the bot runner's
// /v1/workspaces/MANAGER/agent-messages with a one-delivery bearer, and its
// authorize answer names the agent (src/manager_messages.rs).
//
// Bot side: agentMessageInput turns that into a follow-up turn marked
// `[agent NAME ID]`, deduplicated by the agent's request ID.
import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { readFile } from "node:fs/promises";
import type { ConnectorLifecycle } from "./connectors.ts";
import { ApiError, type WorkspaceConfig } from "./types.ts";

export type AgentMessageAuthorization = {
  allowed?: boolean;
  agent?: { id?: unknown; name?: unknown };
};

/** How the bot's system section describes agent messages. */
export const agentMessagesBotNote =
  "Messages that start with [agent NAME ID] come from a coding agent you manage, sent with its messageManager tool; they are not from the user. Act on them, and tell the user with sendMessage when they need to know.";

export function managerMessageExtension(
  config: WorkspaceConfig,
  lifecycle: ConnectorLifecycle,
  assertActive: (signal?: AbortSignal) => Promise<void>,
) {
  const manager = config.manager!;
  return defineExtension({
    name: "manager-messages",
    tools: [
      defineTool({
        name: "messageManager",
        description:
          "Send a short message to the bot that manages you, e.g. a finished result with its PR link, a blocker, or a question. The bot reads it as a new turn after its current one.",
        parameters: obj({
          text: str({ minLength: 1, maxLength: 20000 }),
        }),
        replay: "safe",
        execute: async ({ text }, api, context) => {
          await assertActive(context.abortSignal);
          const token = (await readFile(lifecycle.tokenFile, "utf8")).trim();
          const response = await fetch(
            new URL(
              `/v1/workspaces/${encodeURIComponent(manager)}/runtime/message`,
              lifecycle.url,
            ),
            {
              method: "POST",
              redirect: "error",
              signal: context.abortSignal
                ? AbortSignal.any([
                    context.abortSignal,
                    AbortSignal.timeout(30_000),
                  ])
                : AbortSignal.timeout(30_000),
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              // The task ID is stable across replays of this call, so a
              // retry after a lost acknowledgement delivers once.
              body: JSON.stringify({
                text,
                requestId: `${config.id}:${api.taskId}`,
              }),
            },
          );
          const reply = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          if (!response.ok)
            throw new Error(
              `Message to manager bot ${manager} failed with HTTP ${response.status}: ${reply.error?.message ?? "no detail"}`,
            );
          return {
            output: [
              { type: "text", text: `Delivered to manager bot ${manager}.` },
            ],
          };
        },
      }),
    ],
  });
}

/** The bot conversation input for one authorized agent message. */
export function agentMessageInput(
  authorization: AgentMessageAuthorization | undefined,
  data: Record<string, unknown>,
) {
  const agent = authorization?.agent;
  if (typeof agent?.id !== "string" || typeof agent.name !== "string")
    throw new ApiError(
      403,
      "AGENT_MESSAGE_FORBIDDEN",
      "Agent messages arrive only through the lifecycle",
    );
  if (
    typeof data.text !== "string" ||
    !data.text.trim() ||
    data.text.length > 20000
  )
    throw new ApiError(
      400,
      "INVALID_AGENT_MESSAGE",
      "Agent message text must be 1-20000 characters",
    );
  if (
    typeof data.requestId !== "string" ||
    data.requestId.length < 1 ||
    data.requestId.length > 128
  )
    throw new ApiError(
      400,
      "INVALID_REQUEST_ID",
      "Agent message requestId must be 1-128 characters",
    );
  return {
    content: `[agent ${agent.name} ${agent.id}] ${data.text}`,
    requestId: `agent-message:${agent.id}:${data.requestId}`,
  };
}
