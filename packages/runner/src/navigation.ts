import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Harness,
} from "@earendil-works/pi-durable";

type Branch = {
  conversationId: number;
  parentConversationId?: number;
  forkEntryId?: number;
  createdAt: number;
};

type WorkspaceNavigation = {
  activeConversationId: number;
  branches: Branch[];
};

const navigationDocument = defineDoc<WorkspaceNavigation>({
  kind: "adm.workspace-navigation",
  version: 1,
  scope: "session",
  initial: () => ({ activeConversationId: 0, branches: [] }),
});

export async function initializeNavigation(
  harness: Harness,
  rootConversationId: number,
) {
  const state = await harness.snapshot(navigationDocument, context);
  if (state?.activeConversationId) return state;
  return harness.commit(async (tx) => {
    const navigation = await tx.doc(navigationDocument);
    navigation.activeConversationId = rootConversationId;
    navigation.branches = [
      { conversationId: rootConversationId, createdAt: Date.now() },
    ];
    return navigation;
  }, context);
}

export async function workspaceBranches(harness: Harness) {
  return (
    (await harness.snapshot(navigationDocument, context)) ?? {
      activeConversationId: 0,
      branches: [],
    }
  );
}

export async function activeWorkspaceConversation(
  harness: Harness,
): Promise<Conversation> {
  const state = await workspaceBranches(harness);
  const conversation = await harness.conversation(
    state.activeConversationId as unknown as ConversationId,
    context,
  );
  if (!conversation)
    throw new Error(
      "Active workspace conversation is missing from Durable history",
    );
  return conversation;
}

export async function selectWorkspaceBranch(
  harness: Harness,
  conversationId: number,
) {
  const state = await workspaceBranches(harness);
  if (
    !state.branches.some((branch) => branch.conversationId === conversationId)
  )
    throw new Error("Unknown workspace conversation");
  const conversation = await harness.conversation(
    conversationId as unknown as ConversationId,
    context,
  );
  if (!conversation)
    throw new Error("Workspace conversation is missing from Durable history");
  await harness.commit(async (tx) => {
    const navigation = await tx.doc(navigationDocument);
    navigation.activeConversationId = conversationId;
  }, context);
  return { activeConversationId: conversationId };
}

export async function forkWorkspaceBranch(
  harness: Harness,
  conversationId: number,
  entryId: number,
) {
  const state = await workspaceBranches(harness);
  if (state.activeConversationId !== conversationId)
    throw new Error("Workspace conversation changed; reload the history tree");
  const parent = await harness.conversation(
    conversationId as unknown as ConversationId,
    context,
  );
  if (!parent)
    throw new Error(
      "Active workspace conversation is missing from Durable history",
    );
  const fork = await harness.commit(async (tx) => {
    const child = await tx.forkConversation(
      parent.id,
      entryId as unknown as EntryId,
      {
        ownership: { kind: "ownerless" },
      },
    );
    const branch: Branch = {
      conversationId: child.id as unknown as number,
      parentConversationId: conversationId,
      forkEntryId: entryId,
      createdAt: Date.now(),
    };
    const navigation = await tx.doc(navigationDocument);
    navigation.branches.push(branch);
    navigation.activeConversationId = child.id;
    return { id: child.id as unknown as number, branch };
  }, context);
  return { activeConversationId: fork.id, branch: fork.branch };
}
