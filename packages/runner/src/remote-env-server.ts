import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { decode, encode } from "./env-protocol.ts";

const cwdIndex = process.argv.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : "";
if (!cwd || !cwd.startsWith("/")) {
  process.stderr.write("workspace-env: --cwd must be an absolute directory\n");
  process.exit(1);
}

const env = new NodeExecutionEnv({ cwd });
const handles = new Map<
  number,
  { kind: string; value: { close(call: Context): Promise<void> } }
>();
const cancels = new Map<number, (reason?: unknown) => void>();
let nextHandle = 0;
let disconnected = false;
let shutdownPromise: Promise<void> | undefined;
const activeCalls = new Set<Promise<void>>();

const simple = new Set([
  "absolutePath",
  "joinPath",
  "readTextFile",
  "readTextLines",
  "readBinaryFile",
  "writeFile",
  "appendFile",
  "truncateFile",
  "flushFile",
  "renameFile",
  "fileInfo",
  "listDir",
  "canonicalPath",
  "exists",
  "createDir",
  "remove",
  "createTempDir",
  "createTempFile",
]);

function send(message: unknown) {
  if (disconnected || process.stdout.destroyed || process.stdout.writableEnded)
    return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function encodeError(error: unknown) {
  if (error instanceof FileError)
    return {
      type: "FileError",
      code: error.code,
      message: error.message,
      path: error.path,
    };
  if (error instanceof ExecutionError)
    return {
      type: "ExecutionError",
      code: error.code,
      message: error.message,
      spillPath: error.spillPath,
    };
  return {
    type: "Error",
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

function encodeResult(result: {
  ok: boolean;
  value?: unknown;
  error?: unknown;
}) {
  if (!result.ok) return { ok: false, error: encodeError(result.error) };
  return { ok: true, value: encode(result.value) };
}

function handleOf(id: unknown, kind: string) {
  const handle = handles.get(Number(id));
  if (!handle || handle.kind !== kind) return undefined;
  return handle.value;
}

async function perform(
  id: number,
  method: string,
  args: unknown[],
  call: Context,
) {
  const decoded = args.map((item) => decode(item));
  if (simple.has(method)) {
    const operation = env[method as keyof NodeExecutionEnv] as unknown as
      | ((
          this: NodeExecutionEnv,
          ...args: unknown[]
        ) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>)
      | undefined;
    if (typeof operation !== "function")
      return {
        ok: false,
        error: {
          type: "FileError",
          code: "not_supported",
          message: `${method} is not available`,
        },
      };
    return encodeResult(await operation.apply(env, [...decoded, call]));
  }
  if (method === "cleanup") {
    for (const handle of handles.values())
      await handle.value.close(call).catch(() => undefined);
    handles.clear();
    await env.cleanup(call);
    return { ok: true, value: null };
  }
  if (method === "exec") {
    const [command, options] = decoded as [
      string | string[],
      { onOutput?: unknown } | undefined,
    ];
    const executable = options ? { ...options } : {};
    delete executable.onOutput;
    return encodeResult(
      await env.exec(
        command,
        {
          ...executable,
          onOutput: (text, _call, info) =>
            send({
              id,
              event: "output",
              text,
              stream: info.stream,
              skipped: info.skipped,
            }),
        },
        call,
      ),
    );
  }
  if (
    method === "openBinaryReader" ||
    method === "openTextLineReader" ||
    method === "openDirReader"
  ) {
    const opened =
      method === "openBinaryReader"
        ? await env.openBinaryReader(
            decoded[0] as string,
            decoded[1] as { noFollow?: boolean } | undefined,
            call,
          )
        : method === "openTextLineReader"
          ? await env.openTextLineReader(decoded[0] as string, call)
          : await env.openDirReader(decoded[0] as string, call);
    if (!opened.ok) return encodeResult(opened);
    const handle = ++nextHandle;
    const kind =
      method === "openBinaryReader"
        ? "binary"
        : method === "openTextLineReader"
          ? "text"
          : "dir";
    handles.set(handle, { kind, value: opened.value });
    return { ok: true, value: { handle, kind } };
  }
  if (method === "watch") {
    let handle = 0;
    const opened = await env.watch(
      decoded[0] as Parameters<NodeExecutionEnv["watch"]>[0],
      (change) =>
        send({
          id,
          event: "watch",
          ...(handle ? { handle } : {}),
          change: encode(change),
        }),
      call,
    );
    if (!opened.ok) return encodeResult(opened);
    handle = ++nextHandle;
    handles.set(handle, { kind: "watch", value: opened.value });
    return { ok: true, value: { handle, mode: opened.value.mode } };
  }
  const [kind, name] = method.split(".");
  const resource = handleOf(decoded[0], kind ?? "") as
    | { close(call: Context): Promise<void>; [key: string]: unknown }
    | undefined;
  if (!resource || !name)
    return {
      ok: false,
      error: {
        type: "FileError",
        code: "invalid",
        message: `Unknown environment call ${method}`,
      },
    };
  if (name === "close") {
    await resource.close(call);
    handles.delete(Number(decoded[0]));
    return { ok: true, value: null };
  }
  const operation = resource[name as keyof typeof resource];
  if (typeof operation !== "function")
    return {
      ok: false,
      error: {
        type: "FileError",
        code: "not_supported",
        message: `${method} is not available`,
      },
    };
  const result = await operation.apply(resource, [...decoded.slice(1), call]);
  return encodeResult(result);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (disconnected) return;
  const task = (async () => {
    let id = 0;
    try {
      const message = JSON.parse(line) as {
        id?: number;
        cancel?: boolean;
        method?: string;
        args?: unknown[];
        cwd?: string;
      };
      id = message.id ?? 0;
      if (message.cancel) {
        cancels.get(id)?.();
        return;
      }
      if (typeof message.cwd === "string" && message.cwd.startsWith("/"))
        env.cwd = message.cwd;
      const active = withCancel(BACKGROUND_CONTEXT);
      cancels.set(id, active.cancel);
      const value = await perform(
        id,
        message.method ?? "",
        message.args ?? [],
        active.context,
      );
      send({ id, event: "result", ...value });
    } catch (error) {
      send({ id, event: "result", ok: false, error: encodeError(error) });
    } finally {
      cancels.delete(id);
    }
  })();
  activeCalls.add(task);
  void task.finally(() => activeCalls.delete(task)).catch(() => undefined);
});

function shutdown(closeInput: boolean) {
  if (shutdownPromise) return shutdownPromise;
  if (disconnected) return Promise.resolve();
  disconnected = true;
  lines.close();
  if (closeInput && !process.stdin.destroyed) process.stdin.destroy();
  for (const cancel of cancels.values())
    cancel(new Error("workspace environment transport closed"));
  shutdownPromise = (async () => {
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
    while (activeCalls.size > 0) await Promise.allSettled([...activeCalls]);
    for (const handle of handles.values())
      await handle.value.close(BACKGROUND_CONTEXT).catch(() => undefined);
    handles.clear();
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
    process.exitCode = 0;
  })();
  return shutdownPromise;
}

lines.on("close", () => {
  void shutdown(false);
});
process.on("SIGTERM", () => {
  void shutdown(true);
});
process.on("SIGINT", () => {
  void shutdown(true);
});
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    void shutdown(true);
    return;
  }
  process.stderr.write(`workspace-env: stdout failed: ${error.message}\n`);
  void shutdown(true);
});
process.stdout.on("close", () => {
  void shutdown(true);
});
