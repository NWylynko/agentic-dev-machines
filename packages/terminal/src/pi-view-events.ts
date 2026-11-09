import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  EntryRecord,
  LiveState,
  NestedToolSlot,
  ToolSlot,
  TranscriptView,
} from "@earendil-works/pi-durable";

export type WorkspaceRole = "coding" | "bot";

export function liveOf(view: TranscriptView | undefined): LiveState {
  return (view?.docs["pi.live"] as LiveState | undefined) ?? {};
}

export function viewEntries(view: TranscriptView | undefined) {
  const entries: EntryRecord[] = [];
  for (const item of view?.items ?? [])
    if (item.kind === "entry") entries.push(item.entry);
  return entries;
}

/**
 * The Pi message an entry shows as, or undefined for entries Pi does not show:
 * a bot's session holds only its users' messages and what it published.
 */
export function piMessage(
  entry: EntryRecord,
  role: WorkspaceRole,
): AgentMessage | undefined {
  const data = entry.data as Record<string, unknown> | undefined;
  if (entry.kind === "adm.message")
    return {
      role: "custom",
      customType: "adm.message",
      content: typeof data?.text === "string" ? data.text : "",
      display: true,
      details: data,
      timestamp: typeof data?.timestamp === "number" ? data.timestamp : 0,
    } as AgentMessage;
  if (role === "bot" && entry.model?.[0]?.role !== "user") return undefined;
  if (entry.kind === "admbash")
    return data?.message as AgentMessage | undefined;
  const message = entry.model?.[0] as AgentMessage | undefined;
  if (
    message &&
    ["user", "assistant", "toolResult"].includes(message.role) &&
    entry.model!.length === 1
  )
    return message;
  return undefined;
}

// The replica is immutable: an unchanged output or details keeps its identity.
type SlotState = { ended: boolean; output?: string; details?: unknown };

/**
 * Drives Pi InteractiveMode from the attached conversation's state: each view
 * change becomes the Pi events that show what changed. It remembers what it
 * has shown: the newest entry, whether Pi holds a streaming reply, and which
 * tool rows are open.
 */
export class PiViewEvents {
  private newestShown = 0;
  private streaming?: AgentMessage;
  private slots = new Map<string, SlotState>();
  private runShown = false;

  constructor(private readonly role: () => WorkspaceRole) {}

  /**
   * Pi just rendered `view`'s entries itself, which clears its streamed reply
   * and tool rows but not its working indicator: show only what follows.
   */
  rendered(view: TranscriptView | undefined) {
    this.newestShown = Number(viewEntries(view).at(-1)?.id ?? 0);
    this.streaming = undefined;
    this.slots.clear();
  }

  get working() {
    return this.runShown;
  }

  /** The Pi events that move Pi from what it shows to `next`. */
  events(next: TranscriptView): AgentSessionEvent[] {
    const events: AgentSessionEvent[] = [];
    const emit = (event: object) => events.push(event as AgentSessionEvent);
    const live = liveOf(next);
    const entries = viewEntries(next);
    if (live.run && !this.runShown) {
      this.runShown = true;
      emit({ type: "agent_start" });
      emit({ type: "turn_start" });
    }
    for (const entry of entries) {
      if (Number(entry.id) <= this.newestShown) continue;
      this.newestShown = Number(entry.id);
      if (entry.kind === "adm.status") {
        emit({
          type: "entry_appended",
          entry: {
            type: "custom",
            id: String(entry.id),
            parentId: null,
            timestamp: new Date(
              Number((entry.data as { timestamp?: number })?.timestamp ?? 0),
            ).toISOString(),
            customType: "adm.status",
            data: entry.data,
          },
        });
        continue;
      }
      const message = piMessage(entry, this.role());
      if (!message) continue;
      if (message.role === "assistant") {
        // The streamed reply Pi shows is this entry: finish it.
        if (!this.streaming) emit({ type: "message_start", message });
        this.streaming = undefined;
        emit({ type: "message_end", message });
      } else if (
        message.role === "toolResult" ||
        message.role === "bashExecution"
      ) {
        emit({ type: "message_end", message });
      } else {
        emit({ type: "message_start", message });
        emit({ type: "message_end", message });
      }
    }
    const partial = live.generation?.message as AgentMessage | undefined;
    if (partial && partial !== this.streaming) {
      emit({
        type: this.streaming ? "message_update" : "message_start",
        message: partial,
      });
      this.streaming = partial;
    }
    const slots: (ToolSlot | NestedToolSlot)[] = [
      ...(live.tools ?? []),
      ...(live.nestedTools ?? []),
    ];
    const present = new Set<string>();
    for (const slot of slots) {
      present.add(slot.callId);
      let state = this.slots.get(slot.callId);
      if (!state) {
        state = { ended: false };
        this.slots.set(slot.callId, state);
        emit({
          type: "tool_execution_start",
          toolCallId: slot.callId,
          toolName: slot.name,
          args: toolArguments(slot, entries),
          ...("parentCallId" in slot
            ? { parentToolCallId: slot.parentCallId }
            : {}),
        });
      }
      if (state.ended) continue;
      if (slot.status === "done") {
        state.ended = true;
        emit(toolExecutionEnd(slot, entries));
      } else if (
        slot.output !== state.output ||
        slot.details !== state.details
      ) {
        state.output = slot.output;
        state.details = slot.details;
        emit({
          type: "tool_execution_update",
          toolCallId: slot.callId,
          toolName: slot.name,
          partialResult: {
            content: [{ type: "text", text: slot.output ?? "" }],
            details: slot.details,
          },
        });
      }
    }
    // A row whose slot left before it was done: its run or caller ended first.
    for (const [callId, state] of this.slots) {
      if (present.has(callId)) continue;
      this.slots.delete(callId);
      if (!state.ended)
        emit({
          type: "tool_execution_end",
          toolCallId: callId,
          toolName: "",
          result: {
            content: [
              {
                type: "text",
                text: "Tool call ended without a result: its run ended first.",
              },
            ],
          },
          isError: true,
        });
    }
    if (!live.run && this.runShown) {
      this.runShown = false;
      this.streaming = undefined;
      this.slots.clear();
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled", aborted: false });
    }
    return events;
  }
}

// A model-issued call's arguments are in its assistant entry; a nested call's
// in its slot.
function toolArguments(
  slot: ToolSlot | NestedToolSlot,
  entries: readonly EntryRecord[],
) {
  if ("arguments" in slot) return slot.arguments;
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]!.model?.[0];
    if (message?.role !== "assistant") continue;
    for (const part of message.content)
      if (part.type === "toolCall" && part.id === slot.callId)
        return part.arguments;
  }
  return {};
}

// Pi's tool row renders `result.content`: a model-issued call's result entry,
// a nested call's summary, or why a faulted call has neither.
function toolExecutionEnd(
  slot: ToolSlot | NestedToolSlot,
  entries: readonly EntryRecord[],
) {
  const call = {
    type: "tool_execution_end" as const,
    toolCallId: slot.callId,
    toolName: slot.name,
    ...("parentCallId" in slot ? { parentToolCallId: slot.parentCallId } : {}),
  };
  if ("summary" in slot && slot.summary)
    return {
      ...call,
      result: {
        content: slot.summary.error
          ? [{ type: "text" as const, text: slot.summary.error }]
          : [],
      },
      isError: slot.summary.isError,
      durationMs: slot.summary.durationMs,
    };
  const entryId = "entry" in slot ? slot.entry : undefined;
  const message = entries.find((entry) => entry.id === entryId)?.model?.[0];
  if (message?.role === "toolResult")
    return {
      ...call,
      result: { content: message.content, details: message.details },
      isError: message.isError,
      durationMs: message.durationMs,
    };
  return {
    ...call,
    result: {
      content: [
        {
          type: "text" as const,
          text: "Tool call ended without a result: its task faulted or was orphaned.",
        },
      ],
    },
    isError: true,
  };
}
