import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  LiveState,
  ScanOrder,
} from "@earendil-works/pi-durable";
import { ApiError } from "./types.ts";

/**
 * What a bot shows its users: their own messages, what it published with
 * sendMessage, and ADM status lines. Its turns, tools and reasoning stay private.
 */
export function isPublicBotEntry(entry: EntryRecord) {
  if (entry.kind === "adm.message" || entry.kind === "adm.status") return true;
  return entry.kind !== "admbash" && entry.model?.[0]?.role === "user";
}

/**
 * A bot's attach view: public entries, and of `pi.live` only whether a run is
 * working. Its other documents (agent, usage, inbox, provider) stay private.
 */
export function publicBotView(view: ConversationView): ConversationView {
  const live = view.docs["pi.live"] as LiveState | undefined;
  return {
    conversation: view.conversation,
    entries: view.entries.filter(isPublicBotEntry),
    ...(view.before === undefined ? {} : { before: view.before }),
    docs: { "pi.live": live?.run ? { run: live.run } : {} },
  };
}

function entryIdParam(url: URL, name: string) {
  const text = url.searchParams.get(name);
  if (text === null) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ApiError(
      400,
      "INVALID_ENTRY_ID",
      `${name} must be a positive Durable entry ID`,
    );
  return value as EntryId;
}

/** The window an attach starts from: `from`, the entry after the newest one the client has. */
export function attachWindow(url: URL) {
  const from = entryIdParam(url, "from");
  return from === undefined ? undefined : { from };
}

/**
 * One page of `conversation.entries()` for `ConversationTranscript`, from the
 * query string. A bot's page holds `limit` public entries or ends the history:
 * an empty page means there is nothing more, never that a page was private.
 */
export async function attachEntriesPage(
  conversation: Conversation,
  url: URL,
  publicOnly: boolean,
) {
  const order = (url.searchParams.get("order") ?? "descending") as ScanOrder;
  if (order !== "ascending" && order !== "descending")
    throw new ApiError(
      400,
      "INVALID_ORDER",
      "order must be ascending or descending",
    );
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new ApiError(400, "INVALID_LIMIT", "limit must be 1..1000");
  const minEntryId = entryIdParam(url, "minEntryId");
  const maxEntryId = entryIdParam(url, "maxEntryId");
  const query = {
    order,
    ...(minEntryId === undefined ? {} : { minEntryId }),
    ...(maxEntryId === undefined ? {} : { maxEntryId }),
  };
  const items: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries(
      query,
      limit - items.length,
      cursor,
      context,
    );
    for (const entry of page.items)
      if (!publicOnly || isPublicBotEntry(entry)) items.push(entry);
    cursor = page.next;
  } while (cursor && items.length < limit);
  return { items, hasMore: cursor !== undefined };
}
