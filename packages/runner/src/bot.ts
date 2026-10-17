import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import type { BotAgentManagement } from "./bot-management.ts";
import type { WorkspaceConfig } from "./types.ts";

const MessageReceipts = defineDoc<{ receipts: Record<string, number> }>({
  kind: "adm.bot-messages",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ receipts: {} }),
});

export type BotProfile = {
  state: "needs_setup" | "collecting" | "ready";
  identity: string;
  purpose: string;
  approvedToolGrants: string[];
};

export const BotProfileDocument = defineDoc<BotProfile>({
  kind: "adm.bot-profile",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    state: "needs_setup",
    identity: "",
    purpose: "",
    approvedToolGrants: [],
  }),
});

export function botExtension(
  config: WorkspaceConfig,
  assertActive: () => Promise<void>,
  agents: BotAgentManagement,
) {
  return defineExtension({
    name: "bot-supervision",
    sections: [
      {
        key: "bot-profile",
        render: async (input, context) => {
          const profile = await input.read.snapshot(
            BotProfileDocument,
            input.conversationId,
            context,
          );
          if (!profile) return undefined;
          if (profile.state !== "ready")
            return "You are a bot being set up. Ask the user for your identity and purpose. Publish setup questions and confirmations only by calling sendMessage. Save a confirmed identity and purpose with saveProfile before acting on them. The host controls MCP grants: you may ask the user to grant a tool, but cannot grant it yourself or claim to have access before it is available.";
          return `You are ${profile.identity}. Your purpose is: ${profile.purpose}\nApproved MCP tools: ${profile.approvedToolGrants.length ? profile.approvedToolGrants.join(", ") : "none"}. The host controls these grants: you may ask the user to grant an additional tool, but cannot grant it yourself or claim to have access before it is available. Publish user-facing messages only with sendMessage.`;
        },
      },
    ],
    tools: [
      defineTool({
        name: "saveProfile",
        description:
          "Save the identity and purpose confirmed by the user during bot setup.",
        parameters: Type.Object({
          identity: Type.String({ minLength: 1, maxLength: 160 }),
          purpose: Type.String({ minLength: 1, maxLength: 2000 }),
        }),
        replay: "safe",
        execute: async ({ identity, purpose }, api, context) => {
          await assertActive();
          if (!identity.trim() || !purpose.trim())
            throw new Error("Bot identity and purpose must not be blank");
          await api.commit(async (tx) => {
            const profile = await tx.doc(
              BotProfileDocument,
              api.conversationId,
            );
            profile.state = "ready";
            profile.identity = identity.trim();
            profile.purpose = purpose.trim();
          }, context);
          return {
            output: [{ type: "text", text: "Bot profile saved." }],
          };
        },
      }),
      defineTool({
        name: "listAgents",
        description:
          "List live coding agents in this ADM installation, with immutable IDs, names, runtime phase, and agent activity.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, _api, context) => {
          await assertActive();
          const directory = await agents.list(context.abortSignal);
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  agents: directory.map((agent) => ({
                    id: agent.id,
                    name: agent.name,
                    status:
                      agent.runtime_status?.activity?.status ?? agent.phase,
                    phase: agent.phase,
                    ready: agent.runtime_status?.ready ?? false,
                    ...(agent.runtime_status?.activity?.error
                      ? { error: agent.runtime_status.activity.error }
                      : {}),
                  })),
                  unavailable: directory
                    .filter((agent) => !agent.runtime_status?.podIP)
                    .map((agent) => agent.id),
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
          "Inspect a coding agent's status and one cursor page of full history, including tool activity. Continue with after=nextAfter while hasMore is true.",
        parameters: Type.Object({
          agentId: Type.String(),
          after: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        }),
        replay: "safe",
        execute: async ({ agentId, after, limit }, _api, context) => {
          await assertActive();
          const [status, history] = await Promise.all([
            agents.status(agentId, context.abortSignal),
            agents.history(
              agentId,
              after ?? 0,
              limit ?? 200,
              context.abortSignal,
            ),
          ]);
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({ id: agentId, status, history }),
              },
            ],
          };
        },
      }),
      defineTool({
        name: "promptAgent",
        description:
          "Prompt a coding agent, steering its current turn or queuing a follow-up. Delivery is deduplicated after a lost acknowledgement.",
        parameters: Type.Object({
          agentId: Type.String(),
          message: Type.String({ minLength: 1, maxLength: 100000 }),
          whenBusy: Type.Optional(
            Type.Union([
              Type.Literal("steer"),
              Type.Literal("followUp"),
              Type.Literal("reject"),
            ]),
          ),
        }),
        replay: "safe",
        execute: async ({ agentId, message, whenBusy }, api, context) => {
          await assertActive();
          const result = await agents.prompt(
            agentId,
            message,
            `bot:${config.id}:${api.taskId}`,
            whenBusy ?? "steer",
            context.abortSignal,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
      defineTool({
        name: "resumeAgent",
        description: "Resume a coding agent after a provider failure.",
        parameters: Type.Object({ agentId: Type.String() }),
        replay: "safe",
        execute: async ({ agentId }, _api, context) => {
          await assertActive();
          const result = await agents.resume(agentId, context.abortSignal);
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
      defineTool({
        name: "abortAgent",
        description: "Abort a coding agent's current turn or background task.",
        parameters: Type.Object({
          agentId: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        replay: "safe",
        execute: async ({ agentId, background }, _api, context) => {
          await assertActive();
          const result = await agents.abort(
            agentId,
            background ?? false,
            context.abortSignal,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
      defineTool({
        name: "saveAgentGoal",
        description:
          "Create or update a coding agent's durable goal. Pass an id and status to update or complete an existing goal.",
        parameters: Type.Object({
          agentId: Type.String(),
          goal: Type.Object({
            description: Type.Optional(
              Type.String({ minLength: 1, maxLength: 100000 }),
            ),
            id: Type.Optional(Type.String()),
            status: Type.Optional(
              Type.Union([
                Type.Literal("active"),
                Type.Literal("completed"),
                Type.Literal("cancelled"),
              ]),
            ),
          }),
        }),
        replay: "safe",
        execute: async ({ agentId, goal }, api, context) => {
          await assertActive();
          const result = await agents.saveGoal(
            agentId,
            goal,
            `bot:${config.id}:${api.taskId}`,
            context.abortSignal,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
      defineTool({
        name: "saveAgentLoop",
        description:
          "Create or update recurring work for a coding agent. Loop creation is durable and deduplicated after a lost acknowledgement.",
        parameters: Type.Object({
          agentId: Type.String(),
          loop: Type.Object({
            prompt: Type.Optional(
              Type.String({ minLength: 1, maxLength: 100000 }),
            ),
            intervalMs: Type.Optional(Type.Integer({ minimum: 1000 })),
            nextAt: Type.Optional(Type.Integer()),
            id: Type.Optional(Type.String()),
            status: Type.Optional(
              Type.Union([Type.Literal("active"), Type.Literal("cancelled")]),
            ),
          }),
        }),
        replay: "safe",
        execute: async ({ agentId, loop }, api, context) => {
          await assertActive();
          const result = await agents.saveLoop(
            agentId,
            loop,
            `bot:${config.id}:${api.taskId}`,
            context.abortSignal,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
      defineTool({
        name: "configureAgentModel",
        description: "Change the selected model for a coding agent.",
        parameters: Type.Object({
          agentId: Type.String(),
          provider: Type.String({ minLength: 1 }),
          modelId: Type.String({ minLength: 1 }),
        }),
        replay: "safe",
        execute: async ({ agentId, provider, modelId }, _api, context) => {
          await assertActive();
          const result = await agents.changeModel(
            agentId,
            provider,
            modelId,
            context.abortSignal,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
      defineTool({
        name: "createAgent",
        description:
          "Create a coding-agent workspace through the durable lifecycle service. Creation choices are explicit and the operation receipt can be replayed after a lost acknowledgement.",
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 63 }),
          image: Type.String({ minLength: 1 }),
          storageClass: Type.String({ minLength: 1 }),
          storageSize: Type.String({ minLength: 1 }),
          cpu: Type.String({ minLength: 1 }),
          memory: Type.String({ minLength: 1 }),
          model: Type.Optional(
            Type.Object({
              provider: Type.String({ minLength: 1 }),
              id: Type.String({ minLength: 1 }),
            }),
          ),
          repository: Type.Optional(Type.String({ minLength: 1 })),
        }),
        replay: "safe",
        execute: async (args, api, context: Context) => {
          await assertActive();
          const operationId = await api.memo(
            "create-agent-operation-id",
            randomUUID(),
            context,
          );
          const spec = {
            name: args.name,
            role: "coding",
            image: args.image,
            storage_class: args.storageClass,
            storage_size: args.storageSize,
            cpu: args.cpu,
            memory: args.memory,
            agent_enabled: true,
            allow_node_local_storage: false,
            repositories: false,
            catalog: {},
            repository: args.repository,
            cwd: args.repository ? `/repos/${args.repository}` : "/repos",
            model: args.model,
            credential_env: [],
            mcp_servers: null,
            herdr_space: null,
          };
          const result = await agents.createAgent(
            operationId,
            spec,
            context.abortSignal,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
      defineTool({
        name: "destroyAgent",
        description:
          "Durably admit destruction of a coding agent by immutable workspace ID. The receipt remains inspectable and replayable if the acknowledgement is lost.",
        parameters: Type.Object({ agentId: Type.String() }),
        replay: "safe",
        execute: async ({ agentId }, api, context: Context) => {
          await assertActive();
          const operationId = await api.memo(
            "destroy-agent-operation-id",
            randomUUID(),
            context,
          );
          const result = await agents.destroyAgent(
            operationId,
            agentId,
            context.abortSignal,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
    ],
  });
}
