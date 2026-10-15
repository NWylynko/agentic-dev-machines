import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import type { Workspace } from "./workspace.ts";
import { ApiError, type WorkspaceConfig } from "./types.ts";

const MessageReceipts = defineDoc<{ receipts: Record<string, number> }>({
  kind: "adm.bot-messages",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ receipts: {} }),
});

export function botExtension(
  config: WorkspaceConfig,
  assertActive: () => Promise<void>,
  lookup: (id: string) => Promise<Workspace>,
) {
  async function permittedAgent(id: string) {
    await assertActive();
    if (!config.allowedAgents?.includes(id))
      throw new Error("This bot is not permitted to supervise that agent");
    const agent = await lookup(id);
    if (agent.config.role !== "coding")
      throw new Error("Supervision targets must be coding agents");
    return agent;
  }
  return defineExtension({
    name: "bot-supervision",
    tools: [
      defineTool({
        name: "listAgents",
        description:
          "List live coding agents this bot is explicitly permitted to supervise, with their immutable IDs, names, and status.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => {
          await assertActive();
          const agents: { id: string; name: string; status: string }[] = [];
          const unavailable: string[] = [];
          for (const id of config.allowedAgents ?? []) {
            try {
              const agent = await lookup(id);
              if (
                agent.config.role !== "coding" ||
                agent.closed ||
                agent.passive
              ) {
                unavailable.push(id);
                continue;
              }
              const status = await agent.status();
              if (status.status === "deleted") {
                unavailable.push(id);
                continue;
              }
              agents.push({
                id,
                name: agent.config.name,
                status: status.status,
              });
            } catch (error) {
              if (
                error instanceof ApiError &&
                [404, 410].includes(error.status)
              ) {
                unavailable.push(id);
                continue;
              }
              throw error;
            }
          }
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  agents,
                  unavailable,
                  message: unavailable.length
                    ? `Permitted agents unavailable: ${unavailable.join(", ")}`
                    : agents.length
                      ? ""
                      : "No coding agents are assigned to this bot.",
                }),
              },
            ],
          };
        },
      }),
      defineTool({
        name: "sendMessage",
        description:
          "Publish an explicit message to the user in this bot conversation. Ordinary model output stays private.",
        parameters: Type.Object({
          text: Type.String({ minLength: 1, maxLength: 100000 }),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          await assertActive();
          const messageId = `${config.id}:${api.taskId}`;
          await api.commit(async (tx) => {
            const document = await tx.doc(MessageReceipts, api.conversationId);
            if (document.receipts[messageId] !== undefined) return;
            const entry = await tx.appendEntry(api.conversationId, {
              kind: "adm.message",
              data: { text: args.text, messageId, timestamp: Date.now() },
            });
            document.receipts[messageId] = Number(entry.id);
          }, context);
          return {
            output: [{ type: "text", text: `Published message ${messageId}` }],
          };
        },
      }),
      defineTool({
        name: "monitorAgent",
        description:
          "Inspect status and recent conversation output of an explicitly permitted coding agent.",
        parameters: Type.Object({ agentId: Type.String() }),
        replay: "safe",
        execute: async ({ agentId }) => {
          const agent = await permittedAgent(agentId);
          const status = await agent.status();
          const history = await agent.history(0, 1000, false);
          const recent = history.events
            .filter((event) => event.kind !== "tool")
            .slice(-20);
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  id: agentId,
                  status: status.status,
                  goals: status.goals,
                  loops: status.loops,
                  recent,
                }),
              },
            ],
          };
        },
      }),
      defineTool({
        name: "promptAgent",
        description:
          "Send a prompt to an explicitly permitted coding agent. Delivery is deduplicated if this tool resumes.",
        parameters: Type.Object({
          agentId: Type.String(),
          message: Type.String({ minLength: 1, maxLength: 100000 }),
        }),
        replay: "safe",
        execute: async ({ agentId, message }, api) => {
          const agent = await permittedAgent(agentId);
          const result = await agent.input(
            message,
            `bot:${config.id}:${api.taskId}`,
            "steer",
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
    ],
  });
}
