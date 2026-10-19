import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat as statFile,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { terminalKeybindings } from "./keybindings.ts";
import {
  Container,
  type Component,
  Editor,
  Input,
  Key,
  Markdown,
  SelectList,
  type SelectItem,
  type SelectListTheme,
  type TUI,
  matchesKey,
  stripTerminalSequences,
  Text,
  getNativeClipboard,
} from "@earendil-works/pi-tui";
import {
  ModelSelectorComponent,
  AssistantMessageComponent,
  ThinkingSelectorComponent,
  ToolExecutionComponent,
  TreeSelectorComponent,
  UserMessageComponent,
  SettingsSelectorComponent,
  copyToClipboard,
  initTheme,
  type ModelRuntime,
  type SettingsCallbacks,
  type SettingsConfig,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import type {
  ImageContent,
  Model,
  ModelsRefreshResult,
} from "@earendil-works/pi-ai";
export type WorkspaceEvent = {
  seq?: number;
  workspaceId: string;
  kind: "user" | "assistant" | "tool" | "message" | "status" | "live";
  data: any;
  timestamp: number;
};
type WorkspaceCacheWarming = {
  state: "inactive" | "scheduled" | "refreshing";
  reason?: string;
  nextWarmAt?: number;
  decision?: {
    phase: "streaming" | "idle";
    warmCost: number;
    missCost: number;
    continuationProbability: number;
    expectedSavings: number;
    economicsAvailable: boolean;
    action: "warm" | "stop";
  };
  extensionOverride?: boolean;
  lastUsage?: {
    provider: string;
    model: string;
    usage: unknown;
    timestamp: string;
  };
};
type ActiveBashOperation = {
  operationId: string;
  requestId: string;
  command: string;
  excludeFromContext: boolean;
};
type TerminalOptions = {
  url: string;
  workspaceId: string;
  tokenFile?: string;
  identityFile?: string;
  diagnostics?: boolean;
  adminCommand?: { executable: string; args: string[] };
  readClipboardImage?: () => Promise<
    { bytes: Uint8Array; mimeType: string } | undefined
  >;
  writeClipboard?: (text: string) => Promise<void>;
  tui?: TUI;
  onRender?: () => void;
  onDetach?: () => void;
};
const clean = (text: unknown) =>
  stripTerminalSequences(String(text ?? "")).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );
const execFileAsync = promisify(execFile);
const detectImageMimeType = (bytes: Uint8Array): string => {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    )
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  throw new Error("Clipboard data is not a supported PNG, JPEG, or WebP image");
};
const piAssistantMessage = (message: any) => ({
  ...message,
  content: Array.isArray(message?.content)
    ? message.content
    : typeof message?.content === "string"
      ? [{ type: "text", text: message.content }]
      : [],
});

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
const markdownTheme = {
  heading: (text: string) => `\x1b[1m${text}\x1b[0m`,
  link: (text: string) => `\x1b[4m${text}\x1b[0m`,
  linkUrl: (text: string) => `\x1b[2m${text}\x1b[0m`,
  code: (text: string) => `\x1b[36m${text}\x1b[0m`,
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => `\x1b[2m${text}\x1b[0m`,
  quote: (text: string) => text,
  quoteBorder: (text: string) => `\x1b[2m${text}\x1b[0m`,
  hr: (text: string) => `\x1b[2m${text}\x1b[0m`,
  listBullet: (text: string) => text,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[0m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[0m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[0m`,
};
const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};
const shortcut = (id: string) => {
  const keys = terminalKeybindings.getKeys(id as any);
  return keys.length
    ? keys
        .map((key) =>
          key.replace(
            /(^|\+)([a-z])/g,
            (_match, separator, letter) =>
              `${separator}${letter.toUpperCase()}`,
          ),
        )
        .join(" / ")
    : "unbound";
};
const selectorTheme: SelectListTheme = {
  selectedPrefix: (text) => text,
  selectedText: (text) => text,
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
};
export class WorkspaceTerminal extends Container {
  private options: TerminalOptions;
  private input: Input | Editor;
  private heading = new Text("");
  private transcript = new Container();
  private statusLine = new Text("");
  private records: WorkspaceEvent[] = [];
  private role: "coding" | "bot" = "coding";
  private workspaceName = "";
  private workingDirectory = "/workspace";
  private conversationId?: number;
  private activeBash: ActiveBashOperation[] = [];
  private cacheWarming?: WorkspaceCacheWarming;
  private cursor = 0;
  private controller?: AbortController;
  private closed = false;
  private connected = false;
  private connecting = false;
  private status = "Connecting…";
  private hideThinking = false;
  private currentModel = "model unavailable";
  private thinkingLevel = "off";
  private usageText = "usage unavailable";
  private costText = "$0.000";
  private contextText = "context unavailable";
  private liveMessage?: any;
  private liveTools = new Map<string, any>();
  private toolViews: ToolExecutionComponent[] = [];
  private assistantViews: AssistantMessageComponent[] = [];
  private toolsExpanded = false;
  private startupExpanded = false;
  private inputPending = false;
  private pendingInput?: {
    message: string;
    requestId: string;
    whenBusy: string;
    images?: ImageContent[];
  };
  private pendingImages: ImageContent[] = [];
  private modelSelector?: ModelSelectorComponent;
  private activeSelector?: Component & { handleInput(data: string): void };
  private modelRuntime?: RemoteModelRuntime;
  private workspaceEventListeners = new Set<(event: WorkspaceEvent) => void>();
  constructor(options: TerminalOptions) {
    super();
    this.options = options;
    if (options.tui) initTheme("dark");
    this.input = options.tui
      ? new Editor(options.tui, editorTheme)
      : new Input();
    this.input.onSubmit = (value) => {
      void this.submit(value);
    };
    if (this.input instanceof Editor)
      this.input.onChange = () => this.options.onRender?.();
    this.addChild(this.heading);
    this.addChild(this.transcript);
    this.addChild(this.statusLine);
    this.addChild(this.input);
    this.refresh();
  }
  get focused() {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }
  private refresh() {
    this.toolViews = [];
    this.assistantViews = [];
    const startup = this.startupExpanded
      ? `▛▀▜  Pi v1.2.0\n▌ ▌  Esc interrupt · Ctrl+C detach · / commands · Ctrl+O more\nCtrl+T thinking · Shift+Tab cycle thinking · /model select model · Shift+Enter new line\nCtrl+R reconnect · Ctrl+C detach · /help commands\n\nPi can explain its own features and look up its docs. Ask it how to use Pi.`
      : `▛▀▜  Pi v1.2.0\n▌ ▌  Esc interrupt · Ctrl+C detach · / commands · Ctrl+O more\nPress Ctrl+O to show full startup help.\n\nPi can explain its own features and look up its docs. Ask it how to use Pi.`;
    this.heading.setText(
      `${this.options.diagnostics ? "⚠ DIAGNOSTICS · PRIVATE MODEL/TOOL OUTPUT\n" : ""}${startup}`,
    );
    this.transcript.clear();
    for (const item of this.records) {
      if (
        this.role === "bot" &&
        !this.options.diagnostics &&
        !["user", "message", "status"].includes(item.kind)
      )
        continue;
      const label =
        item.kind === "user"
          ? "You"
          : item.kind === "message"
            ? "Bot"
            : item.kind === "tool"
              ? `Tool ${clean(item.data?.name)}`
              : item.kind === "status"
                ? "Status"
                : "Agent";
      const body = clean(item.data?.text ?? item.data?.message ?? item.data);
      if (item.kind === "tool") {
        const name = clean(item.data?.name || "unknown");
        const call = this.records
          .flatMap((record) => record.data?.message?.content ?? [])
          .find(
            (part: any) =>
              part?.type === "toolCall" && part.id === item.data?.toolCallId,
          );
        if (this.options.tui && item.data?.message) {
          const tool = new ToolExecutionComponent(
            name,
            String(item.data.toolCallId ?? ""),
            call?.arguments ?? {},
            { outputPad: 1 },
            undefined,
            this.options.tui,
            "/repos",
          );
          tool.markExecutionStarted();
          tool.setArgsComplete();
          tool.updateResult({
            content: item.data.message.content ?? [],
            details: item.data.message.details,
            isError: item.data.message.isError === true,
            durationMs: item.data.message.durationMs,
          });
          tool.setExpanded(this.toolsExpanded);
          this.toolViews.push(tool);
          this.transcript.addChild(tool);
        } else {
          const outcome = item.data?.isError ? "failed" : "complete";
          this.transcript.addChild(
            new Text(`Tool · ${name} · ${outcome}`, 1, 0),
          );
          this.transcript.addChild(new Markdown(body, 1, 1, markdownTheme));
        }
      } else if (item.kind === "status") {
        this.transcript.addChild(new Text(`Status: ${body}`, 1, 1));
      } else if (
        item.kind === "assistant" &&
        this.options.tui &&
        item.data?.message
      ) {
        const assistant = new AssistantMessageComponent(
          piAssistantMessage(item.data.message),
          this.hideThinking,
          markdownTheme,
          "Thinking hidden",
          1,
        );
        this.assistantViews.push(assistant);
        this.transcript.addChild(assistant);
      } else if (
        item.kind === "user" &&
        this.options.tui &&
        item.data?.message
      ) {
        const content = item.data.message.content;
        const userText =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter((part: any) => part?.type === "text")
                  .map((part: any) => part.text)
                  .join("\n")
              : "";
        this.transcript.addChild(
          new UserMessageComponent(
            `${userText}${Array.isArray(content) && content.some((part: any) => part?.type === "image") ? `${userText ? "\n" : ""}[Image attached]` : ""}`,
            markdownTheme,
            1,
          ),
        );
      } else {
        this.transcript.addChild(
          new Markdown(`**${label}**\n\n${body}`, 1, 1, markdownTheme),
        );
      }
    }
    if (this.liveMessage && (this.role !== "bot" || this.options.diagnostics)) {
      this.transcript.addChild(new Text("Agent · responding", 1, 0));
      if (this.options.tui) {
        const assistant = new AssistantMessageComponent(
          piAssistantMessage(this.liveMessage),
          this.hideThinking,
          markdownTheme,
          "Thinking hidden",
          1,
        );
        this.assistantViews.push(assistant);
        this.transcript.addChild(assistant);
      } else {
        this.transcript.addChild(
          new Markdown(
            clean(
              piAssistantMessage(this.liveMessage)
                .content.map((part: any) => part.text ?? "")
                .join(""),
            ),
            1,
            1,
            markdownTheme,
          ),
        );
      }
    }
    if (this.options.tui && (this.role !== "bot" || this.options.diagnostics)) {
      for (const [id, tool] of this.liveTools) {
        const view = new ToolExecutionComponent(
          tool.name,
          id,
          tool.args ?? {},
          { outputPad: 1 },
          undefined,
          this.options.tui!,
          "/repos",
        );
        view.markExecutionStarted();
        if (tool.argsComplete) view.setArgsComplete();
        if (tool.result) view.updateResult(tool.result);
        view.setExpanded(this.toolsExpanded);
        this.toolViews.push(view);
        this.transcript.addChild(view);
      }
    }
    this.statusLine.setText(
      `${clean(this.workingDirectory)}\n${clean(this.costText)} · ${clean(this.contextText)} · ${clean(this.usageText)} · ${clean(this.currentModel)} · ${clean(this.thinkingLevel)} · ${clean(this.status)}\nEnter: send or steer · Shift+Enter: new line · ${shortcut("app.tools.expand")}: tool details · ${shortcut("app.thinking.toggle")}: thinking · ${shortcut("app.thinking.cycle")}: cycle thinking · /help for commands · Ctrl+R: reconnect · Ctrl+C: detach`,
    );
    this.options.onRender?.();
  }
  private endpoint(path: string) {
    const base = new URL(this.options.url);
    if (!["http:", "https:"].includes(base.protocol))
      throw new Error("Runner URL must use http or https");
    return new URL(
      `/v1/workspaces/${encodeURIComponent(this.options.workspaceId)}${path}`,
      base,
    );
  }
  private async authorizationHeaders() {
    if (!this.options.tokenFile && !this.options.identityFile)
      return {} as Record<string, string>;
    const token = this.options.identityFile
      ? await projectedPodToken(
          this.options.identityFile,
          this.options.workspaceId,
        )
      : (await readFile(this.options.tokenFile!, "utf8")).trim();
    if (!token) throw new Error("Workspace runtime token file is empty");
    return { authorization: `Bearer ${token}` } as Record<string, string>;
  }
  async request<T = any>(
    path: string,
    body?: unknown,
    signal: AbortSignal | undefined = this.controller?.signal,
    method?: "GET" | "POST" | "PUT",
  ) {
    const response = await fetch(this.endpoint(path), {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(await this.authorizationHeaders()),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (!response.ok) {
      let detail: any;
      try {
        detail = await response.json();
      } catch {}
      throw new Error(
        detail?.error?.message ?? `Runner returned HTTP ${response.status}`,
      );
    }
    return response.json() as Promise<T>;
  }
  async *subscribeOperationEvents<T extends { seq: number }>(
    path: string,
    signal?: AbortSignal,
  ): AsyncGenerator<T> {
    const response = await fetch(this.endpoint(path), {
      headers: {
        ...(await this.authorizationHeaders()),
        accept: "text/event-stream",
      },
      signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`Runner returned HTTP ${response.status} for operation stream`);
    if (!response.headers.get("content-type")?.includes("text/event-stream"))
      throw new Error("Runner returned a non-event-stream operation response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") {
            if (dataLines.length) yield JSON.parse(dataLines.join("\n")) as T;
            dataLines = [];
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
    } finally {
      await reader.cancel();
    }
    if (dataLines.length) yield JSON.parse(dataLines.join("\n")) as T;
  }
  /** Observe the same authorized, cursor-replayed stream used by the terminal UI. */
  subscribeWorkspaceEvents(listener: (event: WorkspaceEvent) => void) {
    this.workspaceEventListeners.add(listener);
    return () => this.workspaceEventListeners.delete(listener);
  }
  getRemoteSnapshot() {
    return {
      workspaceId: this.options.workspaceId,
      connected: this.connected,
      diagnostics: this.options.diagnostics === true,
      status: this.status,
      workspaceName: this.workspaceName,
      role: this.role,
      cwd: this.workingDirectory,
      conversationId: this.conversationId,
      activeBash: [...this.activeBash],
      cacheWarming: this.cacheWarming,
      cursor: this.cursor,
      events: this.records.slice(),
      models: this.modelRuntime?.getAvailableSnapshot() ?? [],
      selectedModel: this.modelRuntime?.selected,
      thinkingLevel: this.thinkingLevel,
      liveMessage: this.liveMessage,
      liveTools: new Map(this.liveTools),
    };
  }
  async executeBash(
    command: string,
    onChunk: (chunk: string) => void,
    options: {
      excludeFromContext?: boolean;
      id?: string;
      signal?: AbortSignal;
      onAdmitted?: (operationId: string) => void;
    },
  ) {
    const requestId = options.id ?? randomUUID();
    const admission = await this.request<{ operationId: string }>(
      "/bash",
      {
        command,
        requestId,
        ...(options.excludeFromContext ? { excludeFromContext: true } : {}),
      },
      options.signal,
    );
    if (!admission.operationId)
      throw new Error("Runner did not admit the bash operation");
    options.onAdmitted?.(admission.operationId);
    const response = await fetch(
      this.endpoint(
        `/bash/${encodeURIComponent(admission.operationId)}/events`,
      ),
      { headers: await this.authorizationHeaders(), signal: options.signal },
    );
    if (!response.ok || !response.body)
      throw new Error(`Runner bash stream returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let dataLines: string[] = [];
    let result: Record<string, unknown> | undefined;
    const dispatch = () => {
      if (dataLines.length === 0) return;
      let payload: unknown;
      try {
        payload = JSON.parse(dataLines.join("\n"));
      } catch {
        throw new Error("Runner returned invalid bash event data");
      }
      if (eventName === "output") {
        const chunk = payload as { text?: unknown };
        if (typeof chunk.text !== "string")
          throw new Error("Runner bash output event was malformed");
        onChunk(chunk.text);
      } else if (eventName === "result") {
        if (!payload || typeof payload !== "object")
          throw new Error("Runner bash result event was malformed");
        result = payload as Record<string, unknown>;
      }
      eventName = "message";
      dataLines = [];
    };
    while (!result) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) dispatch();
        else if (line.startsWith(":")) {
          /* SSE keepalive */
        } else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:"))
          dataLines.push(line.slice(5).trimStart());
        newline = buffer.indexOf("\n");
      }
    }
    await reader.cancel();
    if (!result)
      throw new Error("Runner bash stream ended before a result was received");
    if (result.command !== command || typeof result.output !== "string")
      throw new Error(
        "Runner returned a bash result for a different operation",
      );
    return {
      output: result.output,
      exitCode:
        typeof result.exitCode === "number" ? result.exitCode : undefined,
      cancelled: result.cancelled === true,
      truncated: result.truncated === true,
      ...(typeof result.fullOutputPath === "string"
        ? { fullOutputPath: result.fullOutputPath }
        : {}),
    };
  }
  async abortBash(operationId: string) {
    return this.request(`/bash/${encodeURIComponent(operationId)}/abort`, {});
  }
  async runProviderAuth(action: "login" | "logout", provider?: string) {
    if (action === "logout" && !provider)
      throw new Error("Provider is required for logout");
    await this.runAdminCommand(action, provider ? [provider] : []);
  }
  async connect() {
    if (this.connecting || this.closed) return;
    this.closeModelSelector();
    this.connecting = true;
    this.connected = false;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.status = "Connecting…";
    this.refresh();
    try {
      const workspace = await this.request("", undefined, controller.signal);
      if (!["coding", "bot"].includes(workspace.role))
        throw new Error("Runner returned an invalid workspace role");
      const conversationId = Number.isSafeInteger(workspace.conversationId)
        ? (workspace.conversationId as number)
        : undefined;
      if (
        conversationId !== undefined &&
        this.conversationId !== undefined &&
        conversationId !== this.conversationId
      ) {
        this.records = [];
        this.cursor = 0;
        this.liveMessage = undefined;
        this.liveTools.clear();
        this.usageText = "usage unavailable";
        this.costText = "$0.000";
        this.contextText = "context unavailable";
      }
      this.conversationId = conversationId;
      this.activeBash = Array.isArray(workspace.activeBash)
        ? workspace.activeBash
        : [];
      this.cacheWarming = workspace.cacheWarming;
      this.role = workspace.role;
      this.workspaceName = workspace.name;
      if (typeof workspace.cwd === "string" && workspace.cwd.trim())
        this.workingDirectory = workspace.cwd;
      const [catalog, settings] = await Promise.all([
        this.request("/models", undefined, controller.signal),
        this.request("/settings", undefined, controller.signal),
      ]);
      this.modelRuntime = new RemoteModelRuntime(this, catalog);
      this.currentModel = catalog.selected
        ? `${catalog.selected.provider}/${catalog.selected.id}`
        : "model unavailable";
      this.thinkingLevel = settings.thinkingLevel ?? "off";
      const workspaceStatus =
        workspace.status === "error"
          ? `Provider error · ${clean(workspace.error ?? "The provider request failed")}`
          : clean(workspace.status);
      this.status = workspaceStatus;
      let more = true;
      while (more) {
        const page = await this.request(
          `/history?after=${this.cursor}&limit=200&diagnostics=${!!this.options.diagnostics}`,
          undefined,
          controller.signal,
        );
        if (!Array.isArray(page.events))
          throw new Error("Runner returned invalid history");
        if (
          conversationId !== undefined &&
          page.activeConversationId !== conversationId
        )
          throw new Error(
            "Workspace session changed while loading history; reconnect to reload it",
          );
        const before = this.cursor;
        for (const item of page.events) this.receive(item);
        if (
          Number.isSafeInteger(page.nextAfter) &&
          page.nextAfter >= this.cursor
        )
          this.cursor = page.nextAfter;
        more = page.hasMore === true;
        if (more && before === this.cursor)
          throw new Error("Runner history cursor did not advance");
      }
      const response = await fetch(
        this.endpoint(
          `/events?after=${this.cursor}&diagnostics=${!!this.options.diagnostics}${conversationId === undefined ? "" : `&conversationId=${conversationId}`}`,
        ),
        {
          signal: controller.signal,
          headers: {
            accept: "text/event-stream",
            ...(await this.authorizationHeaders()),
          },
        },
      );
      if (!response.ok)
        throw new Error(`Event stream returned HTTP ${response.status}`);
      if (!response.headers.get("content-type")?.includes("text/event-stream"))
        throw new Error("Runner did not return an event stream");
      this.connected = true;
      this.status = `Connected · ${workspaceStatus}`;
      this.refresh();
      if (!catalog.selected) this.openModelSelector();
      void this.consume(response, controller);
    } catch (error) {
      if (!controller.signal.aborted) {
        this.status = `Connection unavailable: ${error instanceof Error ? error.message : error}. Press Ctrl+R to retry.`;
        this.refresh();
      }
    } finally {
      this.connecting = false;
    }
  }
  private receive(item: WorkspaceEvent) {
    if (item?.kind === "live") {
      if (item.workspaceId !== this.options.workspaceId)
        throw new Error("Runner returned a live event for another workspace");
      const event = item.data;
      if (event?.type === "snapshot") {
        this.liveMessage = event.generation?.message;
        this.liveTools.clear();
        for (const tool of [
          ...(event.tools ?? []),
          ...(event.nestedTools ?? []),
        ])
          this.liveTools.set(tool.callId, {
            name: tool.name,
            args: tool.arguments ?? {},
            output: tool.output ?? "",
            details: tool.details,
            argsComplete: true,
            result: {
              content: [{ type: "text", text: tool.output ?? "" }],
              details: tool.details,
            },
          });
      } else if (event?.type === "message_start") {
        this.liveMessage = event.message;
      } else if (event?.type === "message_update") {
        this.liveMessage ??= {
          role: "assistant",
          content: [],
          usage: event.usage,
        };
        this.liveMessage.usage = event.usage;
        const content = (this.liveMessage.content ??= []);
        for (const change of event.changes ?? []) {
          const index = change.contentIndex;
          if (change.type === "message") this.liveMessage = change.message;
          else if (
            change.type === "text_start" ||
            change.type === "thinking_start" ||
            change.type === "toolcall_start"
          )
            content[index] = change.block;
          else if (change.type === "block") content[index] = change.block;
          else if (
            change.type === "text_delta" ||
            change.type === "thinking_delta"
          ) {
            if (!content[index])
              content[index] = {
                type: change.type === "text_delta" ? "text" : "thinking",
                [change.type === "text_delta" ? "text" : "thinking"]: "",
              };
            const field = change.type === "text_delta" ? "text" : "thinking";
            content[index][field] =
              (content[index][field] ?? "") + change.delta;
          } else if (change.type === "toolcall_delta") {
            const block = content[index];
            if (block?.type === "toolCall") {
              let cursor = (block.arguments ??= {});
              for (let i = 0; i < change.path.length - 1; i++) {
                const segment = change.path[i]!;
                const next = change.path[i + 1];
                cursor = cursor[segment] ??= typeof next === "number" ? [] : {};
              }
              const leaf = change.path.at(-1);
              if (leaf !== undefined)
                cursor[leaf] = `${cursor[leaf] ?? ""}${change.delta}`;
            }
          }
        }
      } else if (event?.type === "tool_execution_start") {
        this.liveTools.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
        });
      } else if (event?.type === "tool_execution_update") {
        const tool = this.liveTools.get(event.toolCallId) ?? {
          name: event.toolName,
        };
        if (event.output?.set !== undefined) tool.output = event.output.set;
        else if (event.output)
          tool.output = `${tool.output ?? ""}${event.output.append ?? ""}`;
        if (event.details !== undefined) tool.details = event.details;
        tool.argsComplete = true;
        tool.result = {
          content: [{ type: "text", text: tool.output ?? "" }],
          details: tool.details,
        };
        this.liveTools.set(event.toolCallId, tool);
      } else if (event?.type === "tool_execution_end") {
        this.liveTools.delete(event.toolCallId);
      } else if (event?.type === "turn_end") {
        this.liveMessage = undefined;
        this.liveTools.clear();
      } else if (event?.type === "usage_changed") {
        this.usageText = `${event.usage?.totalTokens ?? 0} tokens`;
      }
      const usage = event?.usage ?? this.liveMessage?.usage;
      if (usage) this.usageText = `${usage.totalTokens ?? 0} tokens`;
      this.refresh();
      for (const listener of this.workspaceEventListeners) listener(item);
      return;
    }
    if (
      !item ||
      typeof item.seq !== "number" ||
      !Number.isSafeInteger(item.seq) ||
      item.seq < 1 ||
      item.workspaceId !== this.options.workspaceId ||
      !["user", "assistant", "tool", "message", "status"].includes(item.kind)
    )
      throw new Error("Runner returned an invalid event");
    if (item.seq <= this.cursor) return;
    this.cursor = item.seq;
    this.liveMessage = undefined;
    if (item.kind === "tool") this.liveTools.delete(item.data?.toolCallId);
    this.records.push(item);
    if (item.kind === "assistant") this.refreshUsage();
    if (item.kind === "status")
      this.status = clean(item.data?.status ?? item.data?.text ?? "Connected");
    else if (item.kind === "assistant" && item.data?.stopReason === "error")
      this.status = `Provider error · ${clean(item.data?.error ?? "The provider request failed")}`;
    this.refresh();
    for (const listener of this.workspaceEventListeners) listener(item);
  }
  private refreshUsage() {
    const assistantEvents = this.records.filter(
      (event) => event.kind === "assistant" && event.data?.message?.usage,
    );
    if (!assistantEvents.length) return;
    const totals = assistantEvents.reduce(
      (summary, event) => {
        const usage = event.data.message.usage;
        summary.tokens += Number(usage.totalTokens) || 0;
        summary.cost += Number(usage.cost?.total) || 0;
        summary.lastContext =
          (Number(usage.input) || 0) +
          (Number(usage.cacheRead) || 0) +
          (Number(usage.cacheWrite) || 0);
        return summary;
      },
      { tokens: 0, cost: 0, lastContext: 0 },
    );
    this.usageText = `${totals.tokens} tokens`;
    this.costText = `$${totals.cost.toFixed(3)}`;
    const contextWindow = this.modelRuntime?.getModel(
      this.modelRuntime.selected?.provider ?? "",
      this.modelRuntime.selected?.id ?? "",
    )?.contextWindow;
    this.contextText = contextWindow
      ? `${((totals.lastContext / contextWindow) * 100).toFixed(1)}%/${Math.round(contextWindow / 1000)}k`
      : `${totals.lastContext} context tokens`;
  }
  private async consume(response: Response, controller: AbortController) {
    try {
      if (!response.body) throw new Error("Event stream has no response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "",
        data: string[] = [],
        eventType = "message";
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        if (buffer.length > 4 * 1024 * 1024)
          throw new Error("Runner sent an oversized event");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") {
            if (data.length) {
              const item = JSON.parse(data.join("\n"));
              if (eventType === "live") item.kind = "live";
              this.receive(item);
            }
            data = [];
            eventType = "message";
          } else if (line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("event:")) eventType = line.slice(6).trim();
        }
      }
      if (!controller.signal.aborted) {
        this.connected = false;
        this.status =
          "Disconnected. Press Ctrl+R to reconnect; agents keep working.";
        this.refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.connected = false;
        this.status = `Disconnected: ${error instanceof Error ? error.message : error}. Press Ctrl+R to reconnect.`;
        this.refresh();
      }
    }
  }
  handleInput(data: string) {
    if (this.activeSelector) {
      this.activeSelector.handleInput(data);
      this.options.onRender?.();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.close();
      this.options.onDetach?.();
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      void this.connect();
      return;
    }
    if (terminalKeybindings.matches(data, "app.tools.expand" as any)) {
      if (this.toolViews.length) {
        this.toolsExpanded = !this.toolsExpanded;
        for (const tool of this.toolViews) tool.setExpanded(this.toolsExpanded);
        this.options.onRender?.();
      } else {
        this.startupExpanded = !this.startupExpanded;
        this.refresh();
      }
      return;
    }
    if (terminalKeybindings.matches(data, "app.thinking.toggle" as any)) {
      this.hideThinking = !this.hideThinking;
      for (const assistant of this.assistantViews)
        assistant.setHideThinkingBlock(this.hideThinking);
      this.status = `Thinking blocks ${this.hideThinking ? "hidden" : "shown"} on this terminal`;
      this.refresh();
      return;
    }
    if (terminalKeybindings.matches(data, "app.thinking.cycle" as any)) {
      const selected = this.modelRuntime?.selected;
      const model =
        selected && this.modelRuntime?.getModel(selected.provider, selected.id);
      if (!model?.reasoning) {
        this.status = "Current model does not support thinking";
        this.refresh();
        return;
      }
      const levels = [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ];
      const currentIndex = levels.indexOf(this.thinkingLevel);
      void this.chooseThinkingLevel(
        levels[(currentIndex + 1) % levels.length]!,
      );
      return;
    }
    if (terminalKeybindings.matches(data, "app.editor.external" as any)) {
      void this.openExternalEditor();
      return;
    }
    if (terminalKeybindings.matches(data, "app.clipboard.pasteImage" as any)) {
      void this.pasteClipboardImage();
      return;
    }
    if (this.inputPending) return;
    if (matchesKey(data, Key.escape)) {
      void this.submit("/abort");
      return;
    }
    this.input.handleInput(data);
    this.options.onRender?.();
  }
  async submit(value: string) {
    const message = value.trim();
    if (!message || this.closed || this.inputPending) return;
    this.inputPending = true;
    this.status = "Processing command…";
    if (this.input instanceof Editor) this.setInputText(value);
    this.refresh();
    const clearInput = () => this.setInputText("");
    try {
      if (message === "/help") {
        this.status =
          "/model · /settings · /thinking · /session · /copy · /export [PATH] · /resume · /new · /fork · /tree · /hotkeys · /compact [INSTRUCTIONS] · /reset [HANDOFF] · /retry · /followup TEXT · /abort [all] · /newgoal TEXT · /loop SECONDS TEXT · /goals · /loops · /complete-goal ID · /cancel-goal ID · /cancel-loop ID · /status · /reconnect · /detach\n/model opens Pi's model selector; /thinking changes the durable thinking level; /session shows the selected workspace conversation; /copy copies the latest assistant reply or explicit bot message; /export writes this Durable transcript to a local Markdown file; /resume selects a durable branch; /new creates an empty durable conversation in this workspace; /fork opens the durable tree; /retry retries a safe failed provider turn.";
        this.status +=
          "\n/import PATH.jsonl imports native Pi messages; /share PATH saves a local transcript copy; /bash opens an interactive shell in this coding workspace.";
        clearInput();
        return;
      }
      if (message === "/detach") {
        clearInput();
        this.close();
        this.options.onDetach?.();
        return;
      }
      if (message === "/reconnect") {
        await this.connect();
        clearInput();
        return;
      }
      if (message === "/status") {
        const workspace = await this.request("");
        const status =
          workspace.status === "error"
            ? `Provider error · ${clean(workspace.error ?? "The provider request failed")}`
            : clean(workspace.status);
        this.status = `${status} · ${workspace.goals?.length ?? 0} goals · ${workspace.loops?.length ?? 0} loops`;
        clearInput();
        return;
      }
      if (message === "/login" || message.startsWith("/login ")) {
        const provider = message.slice(6).trim();
        await this.runAdminCommand("login", provider ? [provider] : []);
        clearInput();
        return;
      }
      if (message.startsWith("/logout")) {
        const [, provider, extra] =
          /^\/logout(?:\s+(\S+))?(?:\s+(\S+))?$/.exec(message) ?? [];
        if (!provider || extra) throw new Error("Usage: /logout PROVIDER");
        await this.runAdminCommand("logout", [provider]);
        clearInput();
        return;
      }
      if (message === "/bash") {
        if (this.role !== "coding")
          throw new Error(
            "Bots have no development shell or repository access",
          );
        await this.runAdminCommand("shell", [
          this.options.workspaceId,
          "--",
          "bash",
        ]);
        clearInput();
        return;
      }
      if (message === "/model") {
        if (!this.connected)
          throw new Error("Reconnect before selecting a model");
        if (!this.modelRuntime)
          this.modelRuntime = new RemoteModelRuntime(
            this,
            await this.request("/models"),
          );
        this.openModelSelector();
        clearInput();
        return;
      }
      if (message === "/settings") {
        if (!this.connected)
          throw new Error("Reconnect before changing settings");
        await this.openSettingsSelector();
        clearInput();
        return;
      }
      if (message === "/thinking") {
        if (!this.connected)
          throw new Error("Reconnect before changing settings");
        this.openThinkingSelector();
        clearInput();
        return;
      }
      if (message === "/session") {
        if (!this.connected)
          throw new Error("Reconnect before viewing session information");
        const navigation = await this.request("/branches");
        if (
          !Number.isSafeInteger(navigation.activeConversationId) ||
          !Array.isArray(navigation.branches)
        )
          throw new Error(
            "Runner returned invalid workspace session information",
          );
        const branches = navigation.branches;
        const prompts = this.records.filter(
          (record) => record.kind === "user",
        ).length;
        const replies =
          this.role === "bot"
            ? undefined
            : this.records.filter((record) => record.kind === "assistant")
                .length;
        const toolResults =
          this.role === "bot"
            ? undefined
            : this.records.filter((record) => record.kind === "tool").length;
        const usage = this.records
          .filter((record) => record.kind === "assistant")
          .map((record) => record.data?.message?.usage)
          .filter((value) => value && typeof value === "object")
          .reduce(
            (totals, value) => ({
              tokens: totals.tokens + (Number(value.totalTokens) || 0),
              cost: totals.cost + (Number(value.cost?.total) || 0),
            }),
            { tokens: 0, cost: 0 },
          );
        this.status = [
          `Workspace session ${clean(navigation.activeConversationId)}`,
          `${branches.length} durable conversations`,
          `${prompts} ${prompts === 1 ? "prompt" : "prompts"}`,
          ...(replies === undefined
            ? []
            : [`${replies} ${replies === 1 ? "reply" : "replies"}`]),
          ...(toolResults === undefined
            ? []
            : [
                `${toolResults} tool ${toolResults === 1 ? "result" : "results"}`,
              ]),
          ...(this.role === "bot" ? [] : [`${usage.tokens} tokens`]),
          ...(this.role === "bot" || usage.cost <= 0
            ? []
            : [`$${usage.cost.toFixed(3)}`]),
        ].join(" · ");
        clearInput();
        return;
      }
      if (message === "/copy") {
        const kind = this.role === "bot" ? "message" : "assistant";
        const latest = [...this.records]
          .reverse()
          .find((record) => record.kind === kind);
        const text = latest?.data?.text;
        if (typeof text !== "string" || !text.trim())
          throw new Error(
            this.role === "bot"
              ? "No published bot message to copy in this conversation"
              : "No assistant reply to copy in this conversation",
          );
        await (this.options.writeClipboard ?? copyToClipboard)(text);
        this.status =
          this.role === "bot"
            ? "Copied latest published bot message"
            : "Copied latest assistant reply";
        clearInput();
        return;
      }
      if (
        message === "/export" ||
        message.startsWith("/export ") ||
        message.startsWith("/share ")
      ) {
        if (!this.connected)
          throw new Error("Reconnect before exporting the selected transcript");
        const suppliedPath = message
          .slice(7)
          .trim()
          .replace(/^(?:"(.*)"|'(.*)')$/, "$1$2");
        const path = resolve(
          suppliedPath || `adm-session-${this.conversationId ?? "current"}.md`,
        );
        const exported = this.records
          .filter(
            (record) =>
              this.role !== "bot" || ["user", "message"].includes(record.kind),
          )
          .map((record) => {
            const heading =
              record.kind === "user"
                ? "You"
                : record.kind === "message"
                  ? "Bot"
                  : record.kind === "tool"
                    ? `Tool: ${clean(record.data?.name || "unknown")}`
                    : record.kind === "status"
                      ? "Status"
                      : "Assistant";
            const body =
              record.data?.text ??
              record.data?.message?.content
                ?.map((part: any) =>
                  part?.type === "text"
                    ? part.text
                    : part?.type === "image"
                      ? "[image]"
                      : "",
                )
                .filter(Boolean)
                .join("\n") ??
              record.data?.message ??
              "";
            return `## ${heading}\n\n${clean(body)}\n`;
          });
        await writeFile(
          path,
          `# Workspace session ${this.conversationId ?? "unknown"}\n\n${exported.join("\n")}`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        this.status = `${message.startsWith("/share ") ? "Shared transcript saved" : "Exported transcript"} to ${path}`;
        clearInput();
        return;
      }
      if (message.startsWith("/import ")) {
        if (!this.connected)
          throw new Error("Reconnect before importing a Pi transcript");
        if (this.role !== "coding")
          throw new Error("Bots cannot import coding-agent transcripts");
        const suppliedPath = message
          .slice(8)
          .trim()
          .replace(/^(?:"(.*)"|'(.*)')$/, "$1$2");
        if (!suppliedPath) throw new Error("Usage: /import PATH.jsonl");
        const path = resolve(suppliedPath);
        const file = await statFile(path);
        if (!file.isFile() || file.size > 8 * 1024 * 1024)
          throw new Error(
            "Pi transcript must be a regular file no larger than 8 MiB",
          );
        const imported = importedPiSession(await readFile(path, "utf8"));
        const result = await this.request("/import", {
          session: imported.session,
          selectedLeafId: imported.selectedLeafId,
          entries: imported.entries,
        });
        this.records = [];
        this.cursor = 0;
        await this.connect();
        this.status = `Imported ${result.importedMessages} messages across ${result.importedBranches} branches from ${clean(basename(path))}`;
        this.refresh();
        clearInput();
        return;
      }
      if (message === "/resume") {
        if (!this.connected)
          throw new Error("Reconnect before selecting a branch");
        await this.openBranchSelector();
        clearInput();
        return;
      }
      if (message === "/new") {
        if (!this.connected)
          throw new Error("Reconnect before creating a new session");
        const result = await this.request("/new", {});
        if (!Number.isSafeInteger(result.activeConversationId))
          throw new Error("Runner returned an invalid new conversation ID");
        this.records = [];
        this.cursor = 0;
        this.liveMessage = undefined;
        this.liveTools.clear();
        this.currentModel = result.model
          ? `${result.model.provider}/${result.model.id}`
          : "model unavailable";
        clearInput();
        await this.connect();
        this.status = `Connected · New workspace session ${result.activeConversationId}`;
        this.refresh();
        return;
      }
      if (message === "/fork") {
        if (!this.connected)
          throw new Error("Reconnect before opening the tree");
        await this.openTreeSelector();
        clearInput();
        return;
      }
      if (message === "/tree") {
        if (!this.connected)
          throw new Error("Reconnect before opening the tree");
        await this.openTreeSelector();
        clearInput();
        return;
      }
      if (message === "/hotkeys") {
        this.status = `Keyboard shortcuts\nEnter: send or steer · Shift+Enter: new line · ${shortcut("app.tools.expand")}: expand tool details · ${shortcut("app.thinking.toggle")}: toggle thinking · ${shortcut("app.thinking.cycle")}: cycle thinking · Esc: abort · Ctrl+R: reconnect · Ctrl+C: detach (fixed)\nCommands: /model · /settings · /thinking · /session · /copy · /export · /resume · /new · /fork · /tree · /hotkeys · /compact · /reset · /retry`;
        clearInput();
        return;
      }
      if (message === "/compact" || message.startsWith("/compact ")) {
        const result = await this.request("/compact", {
          instructions: message.slice(8).trim() || undefined,
        });
        this.status = `Compaction queued · task ${clean(result.taskId)}`;
        clearInput();
        return;
      }
      if (message === "/reset" || message.startsWith("/reset ")) {
        const handoff = message.slice(6).trim() || undefined;
        await this.request("/reset", { handoff });
        this.records = [];
        this.cursor = 0;
        this.status = "New context started";
        clearInput();
        void this.connect();
        return;
      }
      if (!this.connected)
        throw new Error(
          "Connection unavailable; use /reconnect before sending work",
        );
      if (message === "/abort" || message === "/abort all") {
        await this.request("/abort", { background: message === "/abort all" });
        this.status = "Abort requested";
        clearInput();
        return;
      }
      if (message === "/retry") {
        await this.request("/retry", {});
        this.status = "Provider retry queued";
        clearInput();
        return;
      }
      if (message.startsWith("/goal ") || message.startsWith("/newgoal ")) {
        await this.request("/goals", {
          description: message
            .slice(message.startsWith("/newgoal ") ? 9 : 6)
            .trim(),
        });
        this.status = "Goal saved";
        clearInput();
        return;
      }
      if (message.startsWith("/loop ")) {
        const match = /^\/loop\s+(\d+)\s+([\s\S]+)$/.exec(message);
        if (!match || Number(match[1]) < 1)
          throw new Error("Usage: /loop SECONDS PROMPT");
        await this.request("/loops", {
          intervalMs: Number(match[1]) * 1000,
          prompt: match[2],
        });
        this.status = "Loop saved";
        clearInput();
        return;
      }
      if (message === "/goals" || message === "/loops") {
        const workspace = await this.request("");
        const goals = message === "/goals";
        const entries = goals ? workspace.goals : workspace.loops;
        if (!Array.isArray(entries))
          throw new Error(
            `Runner returned an invalid ${goals ? "goals" : "loops"} list`,
          );
        this.status = entries.length
          ? `${goals ? "Goals" : "Loops"}:\n${entries
              .map((entry: any) => {
                const text = goals ? entry.description : entry.prompt;
                return `${clean(entry.id)} · ${clean(entry.status)} · ${clean(text)}`;
              })
              .join("\n")}`
          : `No ${goals ? "goals" : "loops"}`;
        clearInput();
        return;
      }
      const update =
        /^\/(complete-goal|cancel-goal|cancel-loop)(?:\s+(\S+))?$/.exec(
          message,
        );
      if (update) {
        const [, command, id] = update;
        if (!id) throw new Error(`Usage: /${command} ID`);
        const goal = command !== "cancel-loop";
        const status = command === "complete-goal" ? "completed" : "cancelled";
        await this.request(goal ? "/goals" : "/loops", { id, status });
        this.status = goal
          ? status === "completed"
            ? "Goal marked completed"
            : "Goal cancelled"
          : "Loop cancelled";
        clearInput();
        return;
      }
      if (message.startsWith("/") && !message.startsWith("/followup "))
        throw new Error("This command is unavailable in adm attach; use /help");
      const followUp = message.startsWith("/followup ");
      const content = followUp ? message.slice(10).trim() : message;
      const whenBusy = followUp ? "followUp" : "steer";
      const images = this.pendingImages;
      if (
        this.pendingInput?.message !== content ||
        this.pendingInput?.whenBusy !== whenBusy ||
        JSON.stringify(this.pendingInput?.images ?? []) !==
          JSON.stringify(images)
      )
        this.pendingInput = {
          message: content,
          requestId: randomUUID(),
          whenBusy,
          ...(images.length ? { images } : {}),
        };
      await this.request("/input", this.pendingInput);
      this.pendingInput = undefined;
      this.pendingImages = [];
      if (this.input instanceof Editor) this.input.addToHistory(content);
      this.status = followUp ? "Follow-up queued" : "Input accepted";
      clearInput();
    } catch (error) {
      this.status = `Error: ${error instanceof Error ? error.message : error}`;
      if (this.input instanceof Editor && !this.input.getText())
        this.setInputText(value);
    } finally {
      this.inputPending = false;
      this.refresh();
    }
  }
  private openModelSelector() {
    if (this.modelSelector || !this.options.tui || !this.modelRuntime) return;
    initTheme("dark");
    const selected = this.modelRuntime.selected;
    const current = selected
      ? this.modelRuntime.getModel(selected.provider, selected.id)
      : undefined;
    const selector = new WorkspaceModelSelector(
      this.options.tui,
      current,
      this.modelRuntime as unknown as ModelRuntime,
      [],
      (model) => {
        void this.chooseModel(model);
      },
      () => this.closeModelSelector(),
    );
    this.modelSelector = selector;
    this.showSelector(selector);
  }
  private showSelector(
    selector: Component & { handleInput(data: string): void },
  ) {
    this.closeSelector();
    this.activeSelector = selector;
    this.input.focused = false;
    this.addChild(selector);
    this.options.onRender?.();
  }
  private closeSelector() {
    if (this.activeSelector) {
      this.removeChild(this.activeSelector);
      this.activeSelector = undefined;
    }
    this.input.focused = true;
    this.refresh();
  }
  private async openSettingsSelector() {
    initTheme("dark");
    const model = this.modelRuntime?.getModel(
      this.modelRuntime.selected?.provider ?? "",
      this.modelRuntime.selected?.id ?? "",
    );
    const config: SettingsConfig = {
      autoCompact: false,
      defaultModel: model ? `${model.provider}/${model.id}` : "",
      currentModel: model,
      availableDefaultModels: model ? [model] : [],
      showImages: false,
      imageWidthCells: 80,
      autoResizeImages: true,
      blockImages: false,
      enableSkillCommands: false,
      steeringMode: "all",
      followUpMode: "all",
      transport: "auto",
      httpIdleTimeoutMs: 300_000,
      cacheWarmingMode: "off",
      thinkingLevel: this.thinkingLevel as SettingsConfig["thinkingLevel"],
      availableThinkingLevels: [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
      modelThinkingLevels: {},
      currentTheme: "dark",
      terminalTheme: "dark",
      availableThemes: ["dark"],
      hideThinkingBlock: this.hideThinking,
      mermaidRenderingMode: "final",
      showCacheMissNotices: false,
      collapseChangelog: false,
      enableInstallTelemetry: false,
      doubleEscapeAction: "none",
      treeFilterMode: "default",
      showHardwareCursor: false,
      editorPaddingX: 0,
      outputPad: 0,
      autocompleteMaxVisible: 10,
      quietStartup: false,
      defaultProjectTrust: "ask",
      clearOnShrink: false,
      showTerminalProgress: true,
      tuiMode: "regular",
      fullscreenExitOutput: "transcript",
      fullscreenScrollbar: "auto",
      fullscreenCopyOnSelect: false,
      fullscreenWheelScrollLines: "auto",
      warnings: {},
    };
    const unavailable = (setting: string) => {
      this.status = `${setting} is not configurable through adm attach`;
      this.closeSelector();
    };
    const callbacks: SettingsCallbacks = {
      onAutoCompactChange: () => unavailable("Auto-compact"),
      onShowImagesChange: () => unavailable("Image display"),
      onImageWidthCellsChange: () => unavailable("Image width"),
      onAutoResizeImagesChange: () => unavailable("Image resizing"),
      onBlockImagesChange: () => unavailable("Image blocking"),
      onEnableSkillCommandsChange: () => unavailable("Skill commands"),
      onSteeringModeChange: () => unavailable("Steering mode"),
      onFollowUpModeChange: () => unavailable("Follow-up mode"),
      onTransportChange: () => unavailable("Provider transport"),
      onHttpIdleTimeoutMsChange: () => unavailable("HTTP idle timeout"),
      onCacheWarmingModeChange: () => unavailable("Cache warming"),
      onModelThinkingLevelChange: (provider, modelId, level) => {
        if (provider === model?.provider && modelId === model.id)
          void this.chooseThinkingLevel(level);
        else unavailable("Per-model thinking overrides");
      },
      onModelThinkingLevelRemove: () =>
        unavailable("Per-model thinking overrides"),
      onThemeChange: () => unavailable("Themes"),
      onHideThinkingBlockChange: (hidden) => {
        this.hideThinking = hidden;
        for (const assistant of this.assistantViews)
          assistant.setHideThinkingBlock(hidden);
        this.status = `Thinking blocks ${hidden ? "hidden" : "shown"} on this terminal`;
        this.refresh();
      },
      onMermaidRenderingModeChange: () => unavailable("Mermaid rendering"),
      onShowCacheMissNoticesChange: () => unavailable("Cache notices"),
      onCollapseChangelogChange: () => unavailable("Changelog display"),
      onEnableInstallTelemetryChange: () => unavailable("Telemetry"),
      onDoubleEscapeActionChange: () => unavailable("Double Escape action"),
      onTreeFilterModeChange: () => unavailable("Tree filter"),
      onShowHardwareCursorChange: () => unavailable("Hardware cursor"),
      onEditorPaddingXChange: () => unavailable("Editor padding"),
      onOutputPadChange: () => unavailable("Output padding"),
      onAutocompleteMaxVisibleChange: () => unavailable("Autocomplete size"),
      onQuietStartupChange: () => unavailable("Startup display"),
      onDefaultProjectTrustChange: () => unavailable("Project trust"),
      onClearOnShrinkChange: () => unavailable("Terminal clearing"),
      onShowTerminalProgressChange: () => unavailable("Terminal progress"),
      onTuiModeChange: () => unavailable("TUI mode"),
      onFullscreenExitOutputChange: () => unavailable("Fullscreen output"),
      onFullscreenScrollbarChange: () => unavailable("Fullscreen scrollbar"),
      onFullscreenCopyOnSelectChange: () => unavailable("Fullscreen copy"),
      onFullscreenWheelScrollLinesChange: () =>
        unavailable("Fullscreen scrolling"),
      onWarningsChange: () => unavailable("Warnings"),
      onCancel: () => this.closeSelector(),
    };
    const selector = new SettingsSelectorComponent(config, callbacks);
    const interactiveSelector = new Container() as Container & {
      handleInput(data: string): void;
    };
    interactiveSelector.addChild(selector);
    interactiveSelector.handleInput = (data) =>
      selector.getSettingsList().handleInput(data);
    this.showSelector(interactiveSelector);
  }
  private openThinkingSelector() {
    initTheme("dark");
    const selector = new ThinkingSelectorComponent(
      this.thinkingLevel as any,
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as any,
      (level) => void this.chooseThinkingLevel(level),
      () => this.closeSelector(),
    );
    this.showSelector(selector);
  }
  private async chooseThinkingLevel(level: string) {
    try {
      const settings = await this.request(
        "/settings",
        { thinkingLevel: level },
        this.controller?.signal,
        "PUT",
      );
      this.thinkingLevel = settings.thinkingLevel;
      this.status = `Thinking level selected · ${clean(this.thinkingLevel)}`;
    } catch (error) {
      this.status = `Settings change failed: ${error instanceof Error ? error.message : error}`;
    } finally {
      this.closeSelector();
    }
  }
  private async openBranchSelector() {
    const navigation = await this.request("/branches");
    const branches: SelectItem[] = (navigation.branches ?? []).map(
      (branch: any) => ({
        value: String(branch.conversationId),
        label: `Workspace session ${branch.conversationId}`,
        description: branch.parentConversationId
          ? `Forked from ${branch.parentConversationId} at entry ${branch.forkEntryId}`
          : "Workspace root conversation",
      }),
    );
    if (branches.length < 2) {
      this.status = "This workspace has one durable session";
      this.refresh();
      return;
    }
    initTheme("dark");
    const selector = new SelectList(branches, 8, selectorTheme);
    selector.setSelectedIndex(
      Math.max(
        0,
        branches.findIndex(
          (branch) => branch.value === String(navigation.activeConversationId),
        ),
      ),
    );
    selector.onSelect = (branch) =>
      void this.chooseBranch(Number(branch.value));
    selector.onCancel = () => this.closeSelector();
    this.showSelector(selector);
  }
  private async chooseBranch(conversationId: number) {
    try {
      const result = await this.request(
        "/branch",
        { conversationId },
        this.controller?.signal,
        "PUT",
      );
      this.records = [];
      this.cursor = 0;
      this.liveMessage = undefined;
      this.liveTools.clear();
      this.currentModel = result.model
        ? `${result.model.provider}/${result.model.id}`
        : "model unavailable";
      this.status = `Attached to workspace session ${conversationId}`;
      this.closeSelector();
      await this.connect();
    } catch (error) {
      this.status = `Session selection failed: ${error instanceof Error ? error.message : error}`;
      this.closeSelector();
    }
  }
  private async openTreeSelector() {
    let after = 0;
    let events: WorkspaceEvent[] = [];
    let activeConversationId: number | undefined;
    let hasMore = true;
    while (hasMore) {
      const page = await this.request(
        `/tree?after=${after}&limit=200&diagnostics=${!!this.options.diagnostics}`,
      );
      if (!Number.isSafeInteger(page.activeConversationId))
        throw new Error("Runner returned an invalid workspace conversation ID");
      if (
        activeConversationId !== undefined &&
        page.activeConversationId !== activeConversationId
      )
        throw new Error(
          "Workspace session changed while loading history; reopen the tree",
        );
      activeConversationId = page.activeConversationId;
      events = events.concat(page.events ?? []);
      hasMore = page.hasMore === true;
      if (hasMore && page.nextAfter <= after)
        throw new Error("Runner tree cursor did not advance");
      after = page.nextAfter;
    }
    let root: SessionTreeNode | undefined;
    let parent: SessionTreeNode | undefined;
    for (const event of events) {
      if (!event.data?.message || !["user", "assistant"].includes(event.kind))
        continue;
      const node = {
        entry: {
          type: "message",
          id: String(event.seq),
          parentId: parent?.entry.id ?? null,
          timestamp: event.timestamp,
          message: event.data.message,
        },
        children: [],
      } as unknown as SessionTreeNode;
      if (!root) root = node;
      else parent!.children.push(node);
      parent = node;
    }
    if (!root) {
      this.status = "This workspace session has no messages to branch";
      this.refresh();
      return;
    }
    initTheme("dark");
    const selector = new TreeSelectorComponent(
      [root],
      parent?.entry.id ?? null,
      24,
      (entryId) => void this.forkAtEntry(Number(entryId)),
      () => this.closeSelector(),
    );
    this.showSelector(selector);
  }
  private async forkAtEntry(entryId: number) {
    try {
      const result = await this.request(
        "/tree",
        { entryId },
        this.controller?.signal,
        "POST",
      );
      this.records = [];
      this.cursor = 0;
      this.liveMessage = undefined;
      this.liveTools.clear();
      this.status = `Branched at entry ${entryId} · session ${result.activeConversationId}`;
      this.closeSelector();
      await this.connect();
    } catch (error) {
      this.status = `Branch creation failed: ${error instanceof Error ? error.message : error}`;
      this.closeSelector();
    }
  }
  private async chooseModel(model: Model<any>) {
    try {
      const result = await this.request(
        "/model",
        { provider: model.provider, modelId: model.id },
        this.controller?.signal,
        "PUT",
      );
      if (this.modelRuntime) this.modelRuntime.selected = result.selected;
      this.currentModel = `${model.provider}/${model.id}`;
      this.refreshUsage();
      this.status = `Model selected · ${clean(model.provider)}/${clean(model.id)}`;
    } catch (error) {
      this.status = `Model selection failed: ${error instanceof Error ? error.message : error}`;
    } finally {
      this.closeModelSelector();
    }
  }
  private async runAdminCommand(command: string, args: string[]) {
    const adminCommand = this.options.adminCommand;
    if (!adminCommand)
      throw new Error(
        "Provider authentication is unavailable in this attach session",
      );
    if (this.controller) this.controller.abort();
    this.connected = false;
    this.options.tui?.stop();
    let commandError: unknown;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          adminCommand.executable,
          [...adminCommand.args, command, ...args],
          { stdio: "inherit", env: process.env },
        );
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`adm ${command} exited ${signal ?? code}`));
        });
      });
    } catch (error) {
      commandError = error;
    } finally {
      this.options.tui?.start();
      await this.connect();
    }
    if (commandError) throw commandError;
  }
  private closeModelSelector() {
    this.modelSelector?.dispose();
    this.modelSelector = undefined;
    this.closeSelector();
  }
  private setInputText(value: string) {
    if (this.input instanceof Editor) this.input.setText(value);
    else this.input.setValue(value);
  }
  private async openExternalEditor() {
    const command = process.env.VISUAL || process.env.EDITOR;
    if (!command?.trim()) {
      this.status = "Set EDITOR or VISUAL to use the external editor";
      this.refresh();
      return;
    }
    const [executable, ...args] = command.trim().split(/\s+/);
    const directory = await mkdtemp(join(tmpdir(), "adm-pi-editor-"));
    const path = join(directory, "prompt.txt");
    const prompt =
      this.input instanceof Editor
        ? this.input.getText()
        : this.input.getValue();
    await writeFile(path, prompt, { encoding: "utf8", mode: 0o600 });
    this.options.tui?.stop();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable!, [...args, path], {
          stdio: "inherit",
          env: process.env,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`Editor exited ${signal ?? code}`));
        });
      });
      const edited = await readFile(path, "utf8");
      if (this.input instanceof Editor) this.input.setText(edited);
      else this.input.setValue(edited);
      this.status = "External editor updated the prompt";
    } catch (error) {
      this.status = `External editor failed: ${error instanceof Error ? error.message : error}`;
    } finally {
      this.options.tui?.start();
      await rm(directory, { recursive: true });
      this.refresh();
    }
  }
  private async pasteClipboardImage() {
    try {
      const image = this.options.readClipboardImage
        ? await this.options.readClipboardImage()
        : await getNativeClipboard()
            ?.getImage()
            .then((bytes) =>
              bytes
                ? { bytes, mimeType: detectImageMimeType(bytes) }
                : undefined,
            );
      if (!image) throw new Error("No image is available on the clipboard");
      if (!["image/png", "image/jpeg", "image/webp"].includes(image.mimeType))
        throw new Error("Clipboard image must be PNG, JPEG, or WebP");
      if (!image.bytes.length || image.bytes.length > 4 * 1024 * 1024)
        throw new Error("Clipboard image exceeds the 4 MiB prompt limit");
      this.pendingImages = [
        {
          type: "image",
          mimeType: image.mimeType,
          data: Buffer.from(image.bytes).toString("base64"),
        },
      ];
      this.status = `Image attached from clipboard · ${(image.bytes.length / 1024).toFixed(0)} KiB`;
    } catch (error) {
      this.status = `Clipboard image unavailable: ${error instanceof Error ? error.message : error}`;
    }
    this.refresh();
  }
  close() {
    this.closed = true;
    this.connected = false;
    this.controller?.abort();
    this.modelSelector?.dispose();
    this.modelSelector = undefined;
    this.closeSelector();
    this.status = "Detached; agents keep working";
    this.refresh();
  }
}

class WorkspaceModelSelector extends ModelSelectorComponent {
  render(width: number) {
    return super
      .render(width)
      .map((line) =>
        line.replace(
          "Use /login to add providers.",
          "Set workspace credentials.",
        ),
      );
  }
}

class RemoteModelRuntime {
  models: Model<any>[];
  selected?: { provider: string; id: string };
  private error?: string;

  constructor(
    private terminal: WorkspaceTerminal,
    catalog: any,
  ) {
    this.models = Array.isArray(catalog.models) ? catalog.models : [];
    this.selected = catalog.selected;
    this.error = catalog.error;
  }

  getAvailableSnapshot() {
    return this.models;
  }

  getModel(provider: string, id: string) {
    return this.models.find(
      (model) => model.provider === provider && model.id === id,
    );
  }

  getError() {
    return this.error;
  }

  async refresh(options: {
    signal?: AbortSignal;
  }): Promise<ModelsRefreshResult> {
    const catalog = await this.terminal.request(
      "/models?refresh=true",
      undefined,
      options.signal,
    );
    this.models = Array.isArray(catalog.models) ? catalog.models : [];
    this.selected = catalog.selected;
    this.error = catalog.error;
    return {
      aborted: catalog.refresh?.aborted === true,
      errors: new Map(
        (catalog.refresh?.errors ?? []).map((entry: any) => [
          entry.provider,
          new Error(entry.message),
        ]),
      ),
    };
  }
}

type PodIdentity = {
  workspaceId: string;
  namespace: string;
  podName: string;
  podUid: string;
  container: "dev" | "bot";
  kubectl: string;
  kubeconfig: string;
};

async function projectedPodToken(identityPath: string, workspaceId: string) {
  const identity = JSON.parse(
    await readFile(identityPath, "utf8"),
  ) as PodIdentity;
  if (
    identity.workspaceId !== workspaceId ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(identity.namespace) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(identity.podName) ||
    !/^[0-9a-f-]{36}$/i.test(identity.podUid) ||
    !["dev", "bot"].includes(identity.container) ||
    !identity.kubectl ||
    !identity.kubeconfig
  )
    throw new Error("Workspace Pod identity descriptor is invalid");
  const options = {
    encoding: "utf8" as const,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, KUBECONFIG: identity.kubeconfig },
  };
  const podResult = await execFileAsync(
    identity.kubectl,
    ["get", "pod", identity.podName, "-n", identity.namespace, "-o", "json"],
    options,
  );
  const pod = JSON.parse(podResult.stdout) as {
    metadata?: {
      uid?: string;
      namespace?: string;
      labels?: Record<string, string>;
    };
    spec?: { serviceAccountName?: string };
    status?: {
      phase?: string;
      conditions?: Array<{ type?: string; status?: string }>;
    };
  };
  const ready = pod.status?.conditions?.some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  );
  if (
    pod.metadata?.uid !== identity.podUid ||
    pod.metadata.namespace !== identity.namespace ||
    pod.metadata.labels?.["adm.dev/workspace-id"] !== identity.workspaceId ||
    pod.spec?.serviceAccountName !== "adm-runtime" ||
    pod.status?.phase !== "Running" ||
    !ready
  )
    throw new Error(
      "Workspace Pod identity changed or is not ready; reattach to refresh runtime access",
    );
  const tokenResult = await execFileAsync(
    identity.kubectl,
    [
      "exec",
      "-n",
      identity.namespace,
      identity.podName,
      "-c",
      identity.container,
      "--",
      "cat",
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    ],
    options,
  );
  return tokenResult.stdout.trim();
}
