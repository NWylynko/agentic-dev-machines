import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension as DurableExtension } from "@earendil-works/pi-durable";

type PiTool = {
  name: string;
  label: string;
  description: string;
  parameters: never;
  execute(
    id: string,
    args: never,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<{ content: never[]; isError?: boolean; details?: never }>;
};

type PiCommand = {
  name: string;
  description?: string;
  handler(args: string, context: never): Promise<void>;
};

export type LoadedPiExtension = {
  path: string;
  tools: Map<string, { definition: PiTool }>;
  commands: Map<string, PiCommand>;
};

export type ExtensionNotification = {
  message: string;
  type?: "info" | "warning" | "error";
};

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
        execute: async (args, _api, context) => {
          await assertActive(context.abortSignal);
          const result = await tool.execute(
            `adm-${_api.callId}`,
            args as never,
            context.abortSignal,
            undefined,
            unsupportedToolContext() as never,
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

export async function executePiCommand(
  extensions: readonly LoadedPiExtension[],
  name: string,
  args: string,
  cwd: string,
  assertActive: () => Promise<void>,
) {
  const command = extensions
    .flatMap((extension) => [...extension.commands.values()])
    .find((candidate) => candidate.name === name);
  if (!command) return undefined;
  await assertActive();
  const notifications: ExtensionNotification[] = [];
  await command.handler(args, commandContext(cwd, notifications) as never);
  await assertActive();
  return { command: name, notifications };
}

function commandContext(cwd: string, notifications: ExtensionNotification[]) {
  return unsupportedSurface("ctx", {
    cwd,
    mode: "rpc",
    hasUI: true,
    ui: unsupportedSurface("ctx.ui", {
      notify(message: string, type: ExtensionNotification["type"] = "info") {
        notifications.push({ message, type });
      },
      select: unsupported("ui.select"),
      confirm: unsupported("ui.confirm"),
      input: unsupported("ui.input"),
      custom: unsupported("ui.custom"),
      editor: unsupported("ui.editor"),
    }),
    isIdle: () => true,
    isProjectTrusted: () => true,
    getContextUsage: () => undefined,
    getSystemPrompt: unsupported("getSystemPrompt"),
    abort: unsupported("abort"),
    shutdown: unsupported("shutdown"),
    compact: unsupported("compact"),
    waitForIdle: unsupported("waitForIdle"),
    newSession: unsupported("newSession"),
    fork: unsupported("fork"),
    navigateTree: unsupported("navigateTree"),
  });
}

function unsupportedToolContext() {
  return {
    mode: "rpc",
    hasUI: false,
    ui: {
      notify: unsupported("ui.notify"),
      select: unsupported("ui.select"),
      confirm: unsupported("ui.confirm"),
      input: unsupported("ui.input"),
      custom: unsupported("ui.custom"),
      editor: unsupported("ui.editor"),
    },
    executeTool: unsupported("executeTool"),
    isIdle: () => false,
    isProjectTrusted: () => true,
  };
}

function unsupported(operation: string) {
  return () => {
    throw new Error(
      `Pi extension operation ${operation} is not supported by the Durable bridge`,
    );
  };
}

function unsupportedSurface<T extends object>(name: string, value: T): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (Reflect.has(target, property))
        return Reflect.get(target, property, receiver);
      return unsupported(`${name}.${String(property)}`);
    },
  });
}
