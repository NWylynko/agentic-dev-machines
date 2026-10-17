import { randomUUID } from "node:crypto";
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
} from "@earendil-works/pi-tui";
import {
  ModelSelectorComponent,
  AssistantMessageComponent,
  ThinkingSelectorComponent,
  ToolExecutionComponent,
  TreeSelectorComponent,
  UserMessageComponent,
  initTheme,
  type ModelRuntime,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import type { Model, ModelsRefreshResult } from "@earendil-works/pi-ai";
export type WorkspaceEvent = {
  seq?: number;
  workspaceId: string;
  kind: "user" | "assistant" | "tool" | "message" | "status" | "live";
  data: any;
  timestamp: number;
};
type TerminalOptions = {
  url: string;
  workspaceId: string;
  diagnostics?: boolean;
  tui?: TUI;
  onRender?: () => void;
  onDetach?: () => void;
};
const clean = (text: unknown) =>
  stripTerminalSequences(String(text ?? "")).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );
const piAssistantMessage = (message: any) => ({
  ...message,
  content: Array.isArray(message?.content)
    ? message.content
    : typeof message?.content === "string"
      ? [{ type: "text", text: message.content }]
      : [],
});
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
  private role = "";
  private workspaceName = "";
  private conversationId?: number;
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
  private liveMessage?: any;
  private liveTools = new Map<string, any>();
  private toolViews: ToolExecutionComponent[] = [];
  private assistantViews: AssistantMessageComponent[] = [];
  private toolsExpanded = false;
  private inputPending = false;
  private pendingInput?: {
    message: string;
    requestId: string;
    whenBusy: string;
  };
  private modelSelector?: ModelSelectorComponent;
  private activeSelector?: Component & { handleInput(data: string): void };
  private modelRuntime?: RemoteModelRuntime;
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
    this.heading.setText(
      `adm · ${clean(this.workspaceName || this.options.workspaceId)}${this.role ? ` · ${this.role}` : ""}${this.options.diagnostics ? " · DIAGNOSTICS" : ""}`,
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
          new UserMessageComponent(userText, markdownTheme, 1),
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
      `${clean(this.status)} · ${clean(this.currentModel)} · thinking ${clean(this.thinkingLevel)} · ${clean(this.usageText)}\nEnter: steer · Shift+Enter: new line · Ctrl+O: tool details · Ctrl+T: thinking · Shift+Tab: cycle thinking · /model · /settings · /thinking · /session · /resume · /fork · /tree · /hotkeys · /compact · /reset · /retry · Ctrl+R: reconnect · Ctrl+C: detach`,
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
  async request(
    path: string,
    body?: unknown,
    signal: AbortSignal | undefined = this.controller?.signal,
    method?: "GET" | "POST" | "PUT",
  ) {
    const response = await fetch(this.endpoint(path), {
      method: method ?? (body === undefined ? "GET" : "POST"),
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
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
    return response.json();
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
      }
      this.conversationId = conversationId;
      this.role = workspace.role;
      this.workspaceName = workspace.name;
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
        { signal: controller.signal, headers: { accept: "text/event-stream" } },
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
    if (item.kind === "assistant" && item.data?.message?.usage) {
      const usage = item.data.message.usage;
      this.usageText = `${usage.totalTokens ?? 0} tokens`;
    }
    if (item.kind === "status")
      this.status = clean(item.data?.status ?? item.data?.text ?? "Connected");
    else if (item.kind === "assistant" && item.data?.stopReason === "error")
      this.status = `Provider error · ${clean(item.data?.error ?? "The provider request failed")}`;
    this.refresh();
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
    if (matchesKey(data, "ctrl+o")) {
      this.toolsExpanded = !this.toolsExpanded;
      for (const tool of this.toolViews) tool.setExpanded(this.toolsExpanded);
      this.options.onRender?.();
      return;
    }
    if (matchesKey(data, "ctrl+t")) {
      this.hideThinking = !this.hideThinking;
      for (const assistant of this.assistantViews)
        assistant.setHideThinkingBlock(this.hideThinking);
      this.status = `Thinking blocks ${this.hideThinking ? "hidden" : "shown"} on this terminal`;
      this.refresh();
      return;
    }
    if (matchesKey(data, "shift+tab")) {
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
          "/model · /settings · /thinking · /session · /resume · /fork · /tree · /hotkeys · /compact [INSTRUCTIONS] · /reset [HANDOFF] · /retry · /followup TEXT · /abort [all] · /newgoal TEXT · /loop SECONDS TEXT · /goals · /loops · /complete-goal ID · /cancel-goal ID · /cancel-loop ID · /status · /reconnect · /detach\n/model opens Pi's model selector; /thinking changes the durable thinking level; /session shows the selected workspace conversation; /resume selects a durable branch; /fork opens the durable tree; /retry retries a safe failed provider turn.";
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
        this.status = `Workspace session ${clean(navigation.activeConversationId)} · ${branches.length} durable conversations`;
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
        this.status =
          "Keyboard shortcuts\nEnter: send or steer · Shift+Enter: new line · Ctrl+O: expand tool details · Ctrl+T: toggle thinking · Shift+Tab: cycle thinking · Esc: abort · Ctrl+R: reconnect · Ctrl+C: detach\nCommands: /model · /settings · /thinking · /session · /resume · /fork · /tree · /hotkeys · /compact · /reset · /retry";
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
      if (
        this.pendingInput?.message !== content ||
        this.pendingInput?.whenBusy !== whenBusy
      )
        this.pendingInput = {
          message: content,
          requestId: randomUUID(),
          whenBusy,
        };
      await this.request("/input", this.pendingInput);
      this.pendingInput = undefined;
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
    const selector = new SelectList(
      [
        { value: "thinking", label: `Thinking level · ${this.thinkingLevel}` },
        {
          value: "thinking-visibility",
          label: `Thinking blocks · ${this.hideThinking ? "hidden" : "shown"}`,
        },
      ],
      6,
      selectorTheme,
    );
    selector.onSelect = (item) => {
      this.closeSelector();
      if (item.value === "thinking") this.openThinkingSelector();
      else {
        this.hideThinking = !this.hideThinking;
        this.status = `Thinking blocks ${this.hideThinking ? "hidden" : "shown"} on this terminal`;
        this.refresh();
      }
    };
    selector.onCancel = () => this.closeSelector();
    this.showSelector(selector);
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
      this.status = `Model selected · ${clean(model.provider)}/${clean(model.id)}`;
    } catch (error) {
      this.status = `Model selection failed: ${error instanceof Error ? error.message : error}`;
    } finally {
      this.closeModelSelector();
    }
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
