import { randomUUID } from "node:crypto";
import {
  Container,
  Editor,
  Input,
  Key,
  Markdown,
  type TUI,
  matchesKey,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
export type WorkspaceEvent = {
  seq: number;
  workspaceId: string;
  kind: "user" | "assistant" | "tool" | "message" | "status";
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
export class WorkspaceTerminal extends Container {
  private options: TerminalOptions;
  private input: Input | Editor;
  private heading = new Text("");
  private transcript = new Container();
  private statusLine = new Text("");
  private records: WorkspaceEvent[] = [];
  private role = "";
  private workspaceName = "";
  private cursor = 0;
  private controller?: AbortController;
  private closed = false;
  private connected = false;
  private connecting = false;
  private status = "Connecting…";
  private inputPending = false;
  private pendingInput?: {
    message: string;
    requestId: string;
    whenBusy: string;
  };
  constructor(options: TerminalOptions) {
    super();
    this.options = options;
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
        const outcome = item.data?.isError ? "failed" : "complete";
        this.transcript.addChild(new Text(`Tool · ${name} · ${outcome}`, 1, 0));
        this.transcript.addChild(new Markdown(body, 1, 1, markdownTheme));
      } else if (item.kind === "status") {
        this.transcript.addChild(new Text(`Status: ${body}`, 1, 1));
      } else {
        this.transcript.addChild(
          new Markdown(`**${label}**\n\n${body}`, 1, 1, markdownTheme),
        );
      }
    }
    this.statusLine.setText(
      `${clean(this.status)}\nEnter: steer · Shift+Enter: new line · /followup · /help · Ctrl+R: reconnect · Ctrl+C: detach`,
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
  private async request(
    path: string,
    body?: unknown,
    signal: AbortSignal | undefined = this.controller?.signal,
  ) {
    const response = await fetch(this.endpoint(path), {
      method: body === undefined ? "GET" : "POST",
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
      this.role = workspace.role;
      this.workspaceName = workspace.name;
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
          `/events?after=${this.cursor}&diagnostics=${!!this.options.diagnostics}`,
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
    if (
      !item ||
      !Number.isSafeInteger(item.seq) ||
      item.seq < 1 ||
      item.workspaceId !== this.options.workspaceId ||
      !["user", "assistant", "tool", "message", "status"].includes(item.kind)
    )
      throw new Error("Runner returned an invalid event");
    if (item.seq <= this.cursor) return;
    this.cursor = item.seq;
    this.records.push(item);
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
        data: string[] = [];
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
            if (data.length) this.receive(JSON.parse(data.join("\n")));
            data = [];
          } else if (line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
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
    if (matchesKey(data, Key.ctrl("c"))) {
      this.close();
      this.options.onDetach?.();
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      void this.connect();
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
          "/followup TEXT · /abort [all] · /resume · /newgoal TEXT · /loop SECONDS TEXT · /goals · /loops · /complete-goal ID · /cancel-goal ID · /cancel-loop ID · /status · /reconnect · /detach\nPi-native /model, /compact, /tree, and /settings are unavailable in adm attach. /resume retries this workspace's safe failed turn.";
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
      if (message === "/resume") {
        await this.request("/resume", {});
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
  private setInputText(value: string) {
    if (this.input instanceof Editor) this.input.setText(value);
    else this.input.setValue(value);
  }
  close() {
    this.closed = true;
    this.connected = false;
    this.controller?.abort();
    this.status = "Detached; agents keep working";
    this.refresh();
  }
}
