import { stripTerminalSequences } from "@earendil-works/pi-tui";

const clean = (text: unknown) =>
  stripTerminalSequences(String(text ?? "")).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );

/**
 * The selected branch of a native Pi JSONL session, as messages for the
 * runner's /import: Pi's own state entries (model and thinking changes,
 * labels) are dropped; anything else unsupported fails the import.
 */
export function importedPiSession(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  let header: Record<string, any>;
  try {
    header = JSON.parse(lines.shift() ?? "null");
  } catch {
    throw new Error("Invalid native Pi session header");
  }
  if (!header || header.type !== "session")
    throw new Error("File is not a native Pi JSONL session");
  const entries: Record<string, any>[] = [];
  const byId = new Map<string, Record<string, any>>();
  for (let index = 0; index < lines.length; index++) {
    let entry: any;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      throw new Error(`Invalid Pi transcript JSON on line ${index + 2}`);
    }
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      !entry.id ||
      byId.has(entry.id) ||
      (entry.parentId !== null && typeof entry.parentId !== "string") ||
      typeof entry.timestamp !== "string" ||
      !Number.isFinite(Date.parse(entry.timestamp))
    )
      throw new Error(`Invalid Pi session entry on line ${index + 2}`);
    if (entry.parentId !== null && !byId.has(entry.parentId))
      throw new Error(
        `Pi transcript has a missing parent on line ${index + 2}`,
      );
    byId.set(entry.id, entry);
    entries.push(entry);
  }
  const leafId =
    typeof header.leafId === "string" ? header.leafId : entries.at(-1)?.id;
  if (!leafId || !byId.has(leafId))
    throw new Error("Pi transcript has no valid selected branch leaf");
  const ignoredState = new Set([
    "model_change",
    "thinking_level_change",
    "usage",
    "session_info",
    "label",
  ]);
  const messageNodes = new Map<
    string,
    { id: string; parentId: string | null; message: any }
  >();
  for (const entry of entries) {
    if (entry.type === "message") {
      if (
        !entry.message ||
        !["user", "assistant", "toolResult"].includes(entry.message.role)
      )
        throw new Error(`Unsupported Pi message entry: ${clean(entry.id)}`);
      let parentId = entry.parentId;
      while (parentId && !messageNodes.has(parentId))
        parentId = byId.get(parentId)?.parentId ?? null;
      messageNodes.set(entry.id, {
        id: entry.id,
        parentId,
        message: entry.message,
      });
      continue;
    }
    if (!ignoredState.has(entry.type))
      throw new Error(
        `Unsupported Pi transcript entry type: ${clean(entry.type)}`,
      );
  }
  let selectedMessageLeaf: string | null = leafId;
  while (selectedMessageLeaf && !messageNodes.has(selectedMessageLeaf))
    selectedMessageLeaf = byId.get(selectedMessageLeaf)?.parentId ?? null;
  const messages = [...messageNodes.values()];
  if (!messages.length || messages.length > 1000)
    throw new Error("Pi session must contain one to 1000 supported messages");
  if (!selectedMessageLeaf)
    throw new Error("Selected Pi branch contains no messages");
  return {
    session: {
      ...(typeof header.id === "string" ? { id: header.id } : {}),
      ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}),
    },
    selectedLeafId: selectedMessageLeaf,
    entries: messages,
  };
}
