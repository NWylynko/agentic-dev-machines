import { EventEmitter } from "node:events";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension as DurableExtension } from "@earendil-works/pi-durable";
import type {
  AgentToolResult,
  Extension as PiExtension,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";

export type LoadedPiExtension = Pick<
  PiExtension,
  "path" | "tools" | "commands" | "shortcuts" | "handlers" | "flags"
>;

export type ExtensionCommandEvent =
  | {
      type: "ui_request";
      seq: number;
      requestId: string;
      method: "select" | "confirm" | "input" | "editor" | "getEditorText";
      title?: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      prefill?: string;
      timeout?: number;
    }
  | {
      type: "notification";
      seq: number;
      message: string;
      level: "info" | "warning" | "error";
    }
  | { type: "status"; seq: number; key: string; text?: string }
  | { type: "title"; seq: number; title: string }
  | { type: "editor_text"; seq: number; text: string }
  | { type: "working_message"; seq: number; message?: string }
  | { type: "working_visible"; seq: number; visible: boolean }
  | {
      type: "result";
      seq: number;
      command: string;
    }
  | {
      type: "error";
      seq: number;
      code: string;
      message: string;
    };

type UiResult = string | boolean | undefined;
type UiMethod = "select" | "confirm" | "input" | "editor" | "getEditorText";
type PendingUi = {
  method: UiMethod;
  options?: string[];
  resolve(value: UiResult): void;
  reject(error: Error): void;
};

export class ExtensionCommandOperation extends EventEmitter {
  readonly id = crypto.randomUUID();
  readonly signal: AbortSignal;
  readonly command: string;
  private readonly controller = new AbortController();
  private readonly history: ExtensionCommandEvent[] = [];
  private readonly pending = new Map<string, PendingUi>();
  private sequence = 0;
  private finished = false;
  private readonly handler: (context: ExtensionCommandContext) => Promise<void> | void;
  private readonly cwd: string;
  private readonly assertActive: (signal?: AbortSignal) => Promise<void>;

  constructor(
    command: string,
    handler: (context: ExtensionCommandContext) => Promise<void> | void,
    cwd: string,
    assertActive: (signal?: AbortSignal) => Promise<void>,
  ) {
    super();
    this.command = command;
    this.handler = handler;
    this.cwd = cwd;
    this.assertActive = assertActive;
    this.signal = this.controller.signal;
  }

  start() {
    void this.run();
  }

  get done() {
    return this.finished;
  }

  eventsAfter(sequence: number) {
    return this.history.filter((event) => event.seq > sequence);
  }

  respond(requestId: string, result: unknown) {
    const pending = this.pending.get(requestId);
    if (!pending || !validUiResult(pending.method, pending.options, result))
      return false;
    this.pending.delete(requestId);
    pending.resolve(result === null ? undefined : result as UiResult);
    return true;
  }

  cancel() {
    if (this.finished) return;
    this.controller.abort(new Error("Extension command was cancelled"));
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.reject(new Error("Extension command was cancelled"));
    }
  }

  private async run() {
    try {
      await this.assertActive(this.signal);
      await this.handler(this.commandContext());
      await this.assertActive(this.signal);
      this.publish({ type: "result", command: this.command });
    } catch (error) {
      const cancelled = this.signal.aborted;
      this.publish({
        type: "error",
        code: cancelled ? "EXTENSION_COMMAND_CANCELLED" : "EXTENSION_COMMAND_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.finished = true;
      this.emit("finish");
    }
  }

  private commandContext(): ExtensionCommandContext {
    const ui = {
      select: (
        title: string,
        options: string[],
        opts?: ExtensionUIDialogOptions,
      ) => this.request("select", { title, options }, opts),
      confirm: (
        title: string,
        message: string,
        opts?: ExtensionUIDialogOptions,
      ) => this.request("confirm", { title, message }, opts),
      input: (
        title: string,
        placeholder?: string,
        opts?: ExtensionUIDialogOptions,
      ) => this.request("input", { title, placeholder }, opts),
      editor: (
        title: string,
        prefill?: string,
        opts?: ExtensionUIDialogOptions,
      ) => this.request("editor", { title, prefill }, opts),
      notify: (message: string, type: "info" | "warning" | "error" = "info") =>
        this.publish({ type: "notification", message, level: type }),
      setStatus: (key: string, text: string | undefined) =>
        this.publish({ type: "status", key, ...(text === undefined ? {} : { text }) }),
      setTitle: (title: string) => this.publish({ type: "title", title }),
      setWorkingMessage: (message?: string) =>
        this.publish({ type: "working_message", message }),
      setWorkingVisible: (visible: boolean) =>
        this.publish({ type: "working_visible", visible }),
      setEditorText: (text: string) => this.publish({ type: "editor_text", text }),
      getEditorText: () => this.request("getEditorText", {}),
      pasteToEditor: (text: string) => this.publish({ type: "editor_text", text }),
      setWorkingIndicator: unsupportedUi("setWorkingIndicator"),
      setHiddenThinkingLabel: unsupportedUi("setHiddenThinkingLabel"),
      setWidget: unsupportedUi("setWidget"),
      setFooter: unsupportedUi("setFooter"),
      setHeader: unsupportedUi("setHeader"),
      custom: unsupportedUi("custom"),
      onTerminalInput: unsupportedUi("onTerminalInput"),
      addAutocompleteProvider: unsupportedUi("addAutocompleteProvider"),
      setEditorComponent: unsupportedUi("setEditorComponent"),
      getEditorComponent: unsupportedUi("getEditorComponent"),
      get theme() {
        throw new Error("Pi extension operation ui.theme is not supported by the Durable bridge");
      },
      getAllThemes: unsupportedUi("getAllThemes"),
      getTheme: unsupportedUi("getTheme"),
      setTheme: unsupportedUi("setTheme"),
      getToolsExpanded: unsupportedUi("getToolsExpanded"),
      setToolsExpanded: unsupportedUi("setToolsExpanded"),
    } as unknown as ExtensionUIContext;
    const context = {
      ui,
      mode: "rpc",
      hasUI: true,
      cwd: this.cwd,
      signal: this.signal,
      isIdle: () => true,
      isProjectTrusted: () => true,
      abort: unsupportedUi("abort"),
      shutdown: unsupportedUi("shutdown"),
      getContextUsage: () => undefined,
      getSystemPrompt: unsupportedUi("getSystemPrompt"),
      getSystemPromptOptions: unsupportedUi("getSystemPromptOptions"),
      waitForIdle: unsupportedUi("waitForIdle"),
      newSession: unsupportedUi("newSession"),
      fork: unsupportedUi("fork"),
      navigateTree: unsupportedUi("navigateTree"),
      switchSession: unsupportedUi("switchSession"),
      reload: unsupportedUi("reload"),
      compact: unsupportedUi("compact"),
    } as unknown as ExtensionCommandContext;
    return unsupportedSurface("ctx", context);
  }

  private request(
    method: "select" | "confirm" | "input" | "editor" | "getEditorText",
    fields: Omit<Extract<ExtensionCommandEvent, { type: "ui_request" }>, "type" | "seq" | "requestId" | "method">,
    opts?: ExtensionUIDialogOptions,
  ): Promise<UiResult> {
    const signal = opts?.signal;
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    if (signal?.aborted)
      return Promise.resolve(method === "confirm" ? false : undefined);
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(requestId);
        this.signal.removeEventListener("abort", onOperationAbort);
        signal?.removeEventListener("abort", onDialogAbort);
      };
      const onOperationAbort = () => {
        cleanup();
        reject(this.signal.reason ?? new Error("Extension command cancelled"));
      };
      const onDialogAbort = () => {
        cleanup();
        resolve(method === "confirm" ? false : undefined);
      };
      this.pending.set(requestId, {
        method,
        options: fields.options,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      this.signal.addEventListener("abort", onOperationAbort, { once: true });
      signal?.addEventListener("abort", onDialogAbort, { once: true });
      this.publish({
        type: "ui_request",
        requestId,
        method,
        ...fields,
        ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
      });
    });
  }

  private publish(event: ExtensionCommandEvent extends infer E
    ? E extends { seq: number }
      ? Omit<E, "seq">
      : never
    : never) {
    const current = { ...event, seq: ++this.sequence } as ExtensionCommandEvent;
    this.history.push(current);
    this.emit("event", current);
  }
}

export function createDurableExtensionBridge(
  extensions: readonly LoadedPiExtension[],
  assertActive: (signal?: AbortSignal) => Promise<void>,
): DurableExtension {
  const tools = extensions.flatMap((extension) =>
    [...extension.tools.values()].map(({ definition: tool }) =>
      defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as never,
        replay: "unsafe" as const,
        execute: async (args, api, context) => {
          await assertActive(context.abortSignal);
          let lastOutput = "";
          const result = await tool.execute(
            `adm-${api.callId}`,
            args as never,
            context.abortSignal,
            (partial) => {
              const text = partial.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
              if (!text) return;
              const delta = text.startsWith(lastOutput)
                ? text.slice(lastOutput.length)
                : text;
              lastOutput = text;
              if (delta) api.output(delta);
            },
            unsupportedToolContext() as ExtensionToolContext,
          );
          return {
            output: result.content as never,
            ...(result.isError ? { isError: true } : {}),
            ...(result.details === undefined
              ? {}
              : { details: result.details as never }),
          };
        },
      }),
    ),
  );
  return defineExtension({ name: "workspace-pi-extensions", tools });
}

export function createCommandOperation(
  extensions: readonly LoadedPiExtension[],
  name: string,
  args: string,
  cwd: string,
  assertActive: (signal?: AbortSignal) => Promise<void>,
) {
  const command = extensions
    .flatMap((extension) => [...extension.commands.values()])
    .find((candidate) => candidate.name === name);
  return command
    ? new ExtensionCommandOperation(
        name,
        (context) => command.handler(args, context),
        cwd,
        assertActive,
      )
    : undefined;
}

export function createShortcutOperation(
  extensions: readonly LoadedPiExtension[],
  shortcut: string,
  cwd: string,
  assertActive: (signal?: AbortSignal) => Promise<void>,
) {
  const registration = extensions
    .flatMap((extension) => [...extension.shortcuts.values()])
    .find((candidate) => candidate.shortcut === shortcut);
  return registration
    ? new ExtensionCommandOperation(
        `shortcut:${shortcut}`,
        (context) => registration.handler(context),
        cwd,
        assertActive,
      )
    : undefined;
}

function unsupportedToolContext() {
  const ui = new Proxy(
    {
      notify: unsupportedUi("ui.notify"),
      select: unsupportedUi("ui.select"),
      confirm: unsupportedUi("ui.confirm"),
      input: unsupportedUi("ui.input"),
      editor: unsupportedUi("ui.editor"),
      custom: unsupportedUi("ui.custom"),
    },
    { get: (_target, property) => unsupportedUi(`ui.${String(property)}`) },
  ) as unknown as ExtensionUIContext;
  return unsupportedSurface("ctx", {
    mode: "rpc" as const,
    hasUI: false,
    cwd: "",
    ui,
    signal: undefined,
    isIdle: () => false,
    isProjectTrusted: () => true,
    getContextUsage: () => undefined,
    getSystemPrompt: unsupportedUi("getSystemPrompt"),
    abort: unsupportedUi("abort"),
    shutdown: unsupportedUi("shutdown"),
    executeTool: unsupportedUi("executeTool"),
    tools: [],
  }) as unknown as ExtensionToolContext;
}

function unsupportedSurface<T extends object>(name: string, value: T): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (Reflect.has(target, property))
        return Reflect.get(target, property, receiver);
      throw new Error(
        `Pi extension operation ${name}.${String(property)} is not supported by the Durable bridge`,
      );
    },
  });
}

function unsupportedUi(name: string) {
  return () => {
    throw new Error(
      `Pi extension operation ui.${name} is not supported by the Durable bridge`,
    );
  };
}

function validUiResult(
  method: PendingUi["method"],
  options: string[] | undefined,
  value: unknown,
): value is UiResult {
  if (method === "confirm") return typeof value === "boolean";
  if (method === "getEditorText") return typeof value === "string";
  if (value === null) return true;
  if (typeof value !== "string") return false;
  return method !== "select" || options?.includes(value) === true;
}
