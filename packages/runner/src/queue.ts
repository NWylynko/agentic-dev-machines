import {
  InboxDoc,
  type Conversation,
  type Harness,
  type InboxItem,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

function queuedInputText(items: readonly InboxItem[]) {
  const steering: string[] = [];
  const followUp: string[] = [];
  for (const item of items) {
    if (item.mode === "write") continue;
    const text =
      typeof item.content === "string"
        ? item.content
        : item.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    (item.mode === "steer" ? steering : followUp).push(text);
  }
  return { steering, followUp };
}

export async function workspaceInputQueue(
  harness: Harness,
  conversation: Conversation,
) {
  return queuedInputText(
    (await harness.snapshot(InboxDoc, conversation.id, context))?.items ?? [],
  );
}

export async function clearWorkspaceInputQueue(conversation: Conversation) {
  return conversation.commit(async (tx) => {
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const result = queuedInputText(inbox.items);
    for (let index = inbox.items.length - 1; index >= 0; index--) {
      const item = inbox.items[index]!;
      if (item.mode === "write") continue;
      tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
      inbox.items.splice(index, 1);
    }
    return {
      cleared: result.steering.length + result.followUp.length,
      ...result,
    };
  }, context);
}
