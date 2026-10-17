import { createModels, type Models } from "@earendil-works/pi-ai/models";
import type { JsonValue } from "@earendil-works/chord";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { join } from "node:path";
import { workspaceCredentialRuntime } from "./credentials.ts";

export async function workspaceModels(
  provider: string | undefined,
  authPath?: string,
  workspaceRoot = "/workspace",
): Promise<Models> {
  if (provider !== "faux") {
    if (!authPath)
      return workspaceCredentialRuntime(workspaceRoot, {
        allowModelNetwork: true,
      });
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    return ModelRuntime.create({
      authPath,
      modelsStorePath: join(workspaceRoot, ".adm", "pi", "models-store.json"),
      allowModelNetwork: true,
      refreshOnCreate: false,
    });
  }
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const answer: FauxResponseFactory = (transcript) => {
    faux.appendResponses([answer]);
    const index = transcript.messages.findLastIndex(
      (message) => message.role === "user",
    );
    const input = transcript.messages[index];
    const text =
      input?.role === "user"
        ? typeof input.content === "string"
          ? input.content
          : input.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
        : "";
    const turns = transcript.messages
      .slice(index + 1)
      .filter(
        (message) =>
          message.role === "assistant" && message.stopReason === "toolUse",
      ).length;
    const failAfterTools = text.startsWith("/faux-fail-after-tools ");
    const planPrefix = failAfterTools ? "/faux-fail-after-tools " : "/faux ";
    if (text.startsWith("/faux-fail-once ")) {
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          "Authentication credentials are invalid (faux injected failure)",
      });
    }
    if (text.startsWith("ADM bot onboarding:")) {
      if (turns === 0)
        return fauxAssistantMessage(
          fauxToolCall("sendMessage", {
            text: "What identity and purpose would you like me to have?",
          }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("I am ready for setup details.");
    }
    if (text === "/faux-inspect-system-prompt")
      return fauxAssistantMessage(
        JSON.stringify(
          transcript.messages.map((message) => ({
            role: message.role,
            content:
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
          })),
        ),
      );
    if (failAfterTools && turns > 0) {
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          "Authentication credentials are invalid after a completed tool (faux injected failure)",
      });
    }
    if (text.startsWith(planPrefix)) {
      const plan = JSON.parse(text.slice(planPrefix.length)) as {
        calls?: { tool: string; args: Record<string, JsonValue> }[];
        answer?: string;
      };
      const call = plan.calls?.[turns];
      if (call)
        return fauxAssistantMessage(fauxToolCall(call.tool, call.args), {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage(plan.answer ?? "Synthetic task complete.");
    }
    return fauxAssistantMessage(`Echo: ${text}`);
  };
  faux.setResponses([answer]);
  models.setProvider(faux.provider);
  return models;
}
