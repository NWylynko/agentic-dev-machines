import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Conversation,
  type ConversationId,
  type ConversationInit,
  type EntryId,
  type AgentChange,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";

type Branch = {
  conversationId: number;
  parentConversationId?: number;
  forkEntryId?: number;
  createdAt: number;
  name?: string;
};

type WorkspaceNavigation = {
  activeConversationId: number;
  branches: Branch[];
  incompleteImports?: { conversationId: number; createdAt: number }[];
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

export async function nameWorkspaceConversation(
  harness: Harness,
  name: string,
) {
  await harness.commit(async (tx) => {
    const navigation = await tx.doc(navigationDocument);
    const branch = navigation.branches.find(
      (item) => item.conversationId === navigation.activeConversationId,
    );
    if (!branch)
      throw new Error("Active Durable conversation has no navigation record");
    if (name) branch.name = name;
    else delete branch.name;
  }, context);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join(" ");
}

async function branchSessionInfo(
  harness: Harness,
  branch: Branch,
  workspace: { id: string; cwd: string; role: "coding" | "bot" },
) {
  const conversation = await harness.conversation(
    branch.conversationId as unknown as ConversationId,
    context,
  );
  if (!conversation) return undefined;

  let cursor:
    | Awaited<ReturnType<typeof conversation.entries>>["next"]
    | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let modified = branch.createdAt;
  const allMessages: string[] = [];
  do {
    const page = await conversation.entries(
      { order: "ascending" },
      1000,
      cursor,
      context,
    );
    for (const entry of page.items) {
      if (workspace.role === "bot" && entry.kind === "adm.message") {
        const data = entry.data as
          | { text?: unknown; timestamp?: unknown }
          | undefined;
        if (typeof data?.timestamp === "number")
          modified = Math.max(modified, data.timestamp);
        if (typeof data?.text === "string" && data.text) {
          messageCount++;
          allMessages.push(data.text);
        }
        continue;
      }
      for (const message of entry.model ?? []) {
        if (workspace.role === "bot" && message.role !== "user") continue;
        messageCount++;
        if (message.role !== "user" && message.role !== "assistant") continue;
        if (typeof message.timestamp === "number")
          modified = Math.max(modified, message.timestamp);
        const text = messageText(message.content);
        if (!text) continue;
        allMessages.push(text);
        if (!firstMessage && message.role === "user") firstMessage = text;
      }
    }
    cursor = page.next;
  } while (cursor);

  const id = `${workspace.id}:${branch.conversationId}`;
  return {
    path: id,
    id,
    cwd: workspace.cwd,
    ...(branch.name ? { name: branch.name } : {}),
    created: new Date(branch.createdAt).toISOString(),
    modified: new Date(modified).toISOString(),
    messageCount,
    firstMessage,
    allMessagesText: allMessages.join(" "),
  };
}

export async function workspaceBranchList(
  harness: Harness,
  workspace: { id: string; cwd: string; role: "coding" | "bot" },
) {
  const state = await workspaceBranches(harness);
  const branches = await Promise.all(
    state.branches.map(async (branch) => ({
      ...branch,
      sessionInfo: await branchSessionInfo(harness, branch, workspace),
    })),
  );
  return { ...state, branches };
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

export async function createWorkspaceConversation(
  harness: Harness,
  parentConversationId: number,
  agent: AgentChange,
  initialize?: ConversationInit,
) {
  const state = await workspaceBranches(harness);
  if (state.activeConversationId !== parentConversationId)
    throw new Error("Workspace conversation changed; retry creating a session");
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent,
      init: async (tx, conversationId) => {
        const navigation = await tx.doc(navigationDocument);
        if (navigation.activeConversationId !== parentConversationId)
          throw new Error(
            "Workspace conversation changed; retry creating a session",
          );
        navigation.branches.push({
          conversationId: Number(conversationId),
          parentConversationId,
          createdAt: Date.now(),
        });
        navigation.activeConversationId = Number(conversationId);
        await initialize?.(tx, conversationId);
      },
    },
    context,
  );
  return { activeConversationId: Number(conversation.id) };
}

export async function createWorkspaceImportedTree(
  harness: Harness,
  parentConversationId: number,
  agent: AgentChange,
  selectedLeafId: string,
  branches: readonly {
    leafId: string;
    entries: readonly {
      id: string;
      parentId: string | null;
      message: Message;
    }[];
  }[],
  sourceSession?: { id?: string; cwd?: string },
) {
  const selected = branches.find((branch) => branch.leafId === selectedLeafId);
  if (!selected) throw new Error("Imported selected branch is missing");
  const state = await workspaceBranches(harness);
  if (state.activeConversationId !== parentConversationId)
    throw new Error(
      "Workspace conversation changed; retry importing the session",
    );
  const selectedDurableIds = new Map<string, EntryId>();
  const appendEntry = async (
    tx: Parameters<Parameters<Harness["commit"]>[0]>[0],
    target: ConversationId,
    entry: (typeof selected.entries)[number],
  ) => {
    const record = await tx.appendEntry(target, {
      kind: "adm.imported-message",
      model: [entry.message],
      data: {
        imported: true,
        sourceEntryId: entry.id,
        timestamp:
          typeof entry.message.timestamp === "number"
            ? entry.message.timestamp
            : Date.now(),
        ...(sourceSession ? { sourceSession } : {}),
      },
    });
    return record.id;
  };
  const root = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent,
      init: async (tx, conversationId) => {
        for (const entry of selected.entries)
          selectedDurableIds.set(
            entry.id,
            await appendEntry(tx, conversationId, entry),
          );
      },
    },
    context,
  );
  const importedBranches: Branch[] = [
    {
      conversationId: Number(root.id),
      parentConversationId,
      createdAt: Date.now(),
    },
  ];
  try {
    await harness.commit(async (tx) => {
      for (const branch of branches) {
        if (branch.leafId === selectedLeafId) continue;
        let shared = 0;
        while (
          shared < selected.entries.length &&
          shared < branch.entries.length &&
          selected.entries[shared].id === branch.entries[shared].id
        )
          shared++;
        if (shared === 0)
          throw new Error(
            "Imported native branches have no shared history root",
          );
        const forkEntryId = selectedDurableIds.get(
          selected.entries[shared - 1].id,
        );
        if (!forkEntryId)
          throw new Error("Imported branch point was not persisted");
        const child = await tx.forkConversation(root.id, forkEntryId, {
          ownership: { kind: "ownerless" },
        });
        for (const entry of branch.entries.slice(shared))
          await appendEntry(tx, child.id, entry);
        importedBranches.push({
          conversationId: Number(child.id),
          parentConversationId: Number(root.id),
          forkEntryId: Number(forkEntryId),
          createdAt: Date.now(),
        });
      }
      const navigation = await tx.doc(navigationDocument);
      if (navigation.activeConversationId !== parentConversationId)
        throw new Error(
          "Workspace conversation changed; retry importing the session",
        );
      navigation.branches.push(...importedBranches);
      navigation.activeConversationId = Number(root.id);
    }, context);
  } catch (error) {
    try {
      await harness.commit(async (tx) => {
        const navigation = await tx.doc(navigationDocument);
        navigation.incompleteImports ??= [];
        navigation.incompleteImports.push({
          conversationId: Number(root.id),
          createdAt: Date.now(),
        });
      }, context);
    } catch (trackingError) {
      throw new Error(
        `Import failed before branch publication; staged conversation ${Number(root.id)} could not be recorded for inspection.`,
        { cause: new AggregateError([error, trackingError]) },
      );
    }
    throw new Error(
      `Import could not publish its Durable branch tree. The previous selection is unchanged by this import; staged conversation ${Number(root.id)} is recorded as incomplete.`,
      { cause: error },
    );
  }
  return {
    activeConversationId: Number(root.id),
    importedBranches: branches.length,
    importedMessages: selected.entries.length,
  };
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
