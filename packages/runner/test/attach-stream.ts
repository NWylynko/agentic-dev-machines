// Test clients of a runner's attach stream (`/events`): the conversation view,
// then the Chord ops of each commit that changes it.
import assert from "node:assert/strict";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

type Headers = Record<string, string>;
export type HistoryEvent = {
  seq: number;
  kind: string;
  data: Record<string, any>;
  workspaceId: string;
  timestamp: string;
};

/**
 * Follow the attach stream of workspace `path` on `base`, calling `onView` with
 * each revision of the view and the frame that made it ("view" or "ops"). The
 * first value `onView` returns other than undefined ends the stream.
 */
export async function followView<T>(
  base: string,
  path: string,
  onView: (
    view: ConversationView,
    frame: "view" | "ops",
  ) => T | undefined | Promise<T | undefined>,
  { query = "", headers = {} as Headers } = {},
): Promise<T> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}/events${query}`, {
    signal: controller.signal,
    headers,
  });
  assert.equal(response.status, 200, await errorText(response));
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream/,
  );
  let buffer = "";
  let view: ConversationView | undefined;
  try {
    for await (const bytes of response.body!) {
      buffer += Buffer.from(bytes).toString();
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const frame = buffer.slice(0, end).split("\n");
        buffer = buffer.slice(end + 2);
        const name = frame.find((line) => line.startsWith("event: "))?.slice(7);
        const data = frame.find((line) => line.startsWith("data: "));
        if (!data) continue;
        const payload = JSON.parse(data.slice(6));
        if (name === "view") view = payload.value as ConversationView;
        else if (name === "ops")
          view = applyImmutable(view, payload.ops as Op[]);
        else if (name === "error") throw new Error(payload.error);
        else continue;
        const result = await onView(view!, name);
        if (result !== undefined) return result;
      }
    }
    throw new Error("Event stream ended before the expected view");
  } finally {
    controller.abort();
  }
}

async function errorText(response: Response) {
  return response.ok ? "" : await response.clone().text();
}

/**
 * The first ADM history event after `after` matching `predicate`, read again
 * whenever the attached conversation changes.
 */
export async function nextHistoryEvent(
  base: string,
  path: string,
  predicate: (event: HistoryEvent) => boolean,
  { after = 0, diagnostics = false, headers = {} as Headers } = {},
): Promise<HistoryEvent> {
  return followView(
    base,
    path,
    async () => {
      const response = await fetch(
        `${base}${path}/history?after=${after}&limit=1000&diagnostics=${diagnostics}`,
        { headers },
      );
      assert.equal(response.status, 200, await errorText(response));
      return ((await response.json()).events as HistoryEvent[]).find(predicate);
    },
    { query: `?diagnostics=${diagnostics}`, headers },
  );
}

export const entryRole = (entry: EntryRecord) => entry.model?.[0]?.role;
