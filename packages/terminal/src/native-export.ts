import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  renderSessionHtml,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

export type DurableSessionExport = {
  role: "coding" | "bot";
  id: string;
  cwd: string;
  created?: string;
  name?: string;
  entries: readonly SessionEntry[];
  systemPrompt?: string;
  tools?: readonly { name: string; description: string; parameters: unknown }[];
};

function exportTranscript(data: DurableSessionExport) {
  const timestamp =
    data.created ?? data.entries[0]?.timestamp ?? new Date().toISOString();
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: data.id,
    timestamp,
    cwd: data.cwd,
  };
  let parentId: string | null = null;
  const entries = data.entries
    .filter(
      (entry) =>
        data.role === "coding" ||
        (entry.type === "message" &&
          (entry.message.role === "user" ||
            (entry.message.role === "custom" &&
              entry.message.customType === "adm.message" &&
              entry.message.display))),
    )
    .map((entry) => {
      const projected = { ...entry, parentId };
      parentId = entry.id;
      return projected;
    });
  if (data.name) {
    const entry: SessionEntry = {
      type: "session_info",
      id: crypto.randomUUID(),
      parentId,
      timestamp,
      name: data.name,
    };
    entries.push(entry);
    parentId = entry.id;
  }
  return {
    header,
    entries,
    leafId: parentId,
    ...(data.role === "coding"
      ? { systemPrompt: data.systemPrompt, tools: data.tools }
      : {}),
  };
}

function writePrivateExport(
  path: string | undefined,
  extension: "html" | "jsonl",
  contents: string,
) {
  const requested =
    path ??
    `pi-session-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.${extension}`;
  const expanded =
    requested === "~"
      ? homedir()
      : requested.startsWith("~/")
        ? resolve(homedir(), requested.slice(2))
        : requested;
  const destination = resolve(expanded);
  mkdirSync(dirname(destination), { recursive: true });
  const file = openSync(destination, "w", 0o600);
  try {
    fchmodSync(file, 0o600);
    writeFileSync(file, contents, "utf8");
  } finally {
    closeSync(file);
  }
  return destination;
}

export function exportDurableSessionJsonl(
  data: DurableSessionExport,
  outputPath?: string,
) {
  const transcript = exportTranscript(data);
  const jsonl =
    [transcript.header, ...transcript.entries]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  return writePrivateExport(outputPath, "jsonl", jsonl);
}

export async function exportDurableSessionHtml(
  data: DurableSessionExport,
  outputPath?: string,
  options?: { themeName?: string },
) {
  return writePrivateExport(
    outputPath,
    "html",
    renderSessionHtml(exportTranscript(data), options?.themeName),
  );
}
