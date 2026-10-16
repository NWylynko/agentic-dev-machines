import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ExecutionError,
  err,
  FileError,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileWatcher,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { decode, encode } from "./env-protocol.ts";

export const defaultRemoteEnv = "/opt/adm/workspace-env.mjs";

type Failure = {
  type?: string;
  code?: string;
  message?: string;
  path?: string;
  spillPath?: string;
};
type Envelope = {
  id?: number;
  event?: string;
  ok?: boolean;
  value?: unknown;
  error?: Failure;
  text?: string;
  stream?: "stdout" | "stderr";
  skipped?: { bytes: number; newlines: number; endsWithNewline: boolean };
  change?: WatchChange;
  handle?: number;
};

type Pending = {
  resolve: (message: Envelope) => void;
  reject: (error: Error) => void;
  onOutput?: ShellExecOptions["onOutput"];
  onWatch?: (change: WatchChange) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

function restoreError(error: Failure | undefined) {
  const message = error?.message || "Workspace command failed";
  if (error?.type === "FileError")
    return new FileError(
      (error.code as FileError["code"]) || "unknown",
      message,
      error.path,
    );
  const failure = new ExecutionError(
    (error?.code as ExecutionError["code"]) || "unknown",
    message,
  );
  if (error?.spillPath) failure.spillPath = error.spillPath;
  return failure;
}

/** Coding tools for one Kubernetes workspace. Every call runs in that workspace's dev container. */
export class KubernetesExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private readonly kubectl: string;
  private readonly kubeconfig?: string;
  private readonly namespace: string;
  private readonly container: string;
  private readonly script: string;
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly watches = new Map<number, (change: WatchChange) => void>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private starting?: Promise<void>;

  constructor(options: {
    kubectl: string;
    kubeconfig?: string;
    namespace: string;
    container: string;
    cwd: string;
    script: string;
  }) {
    if (!options.cwd.startsWith("/"))
      throw new Error("Kubernetes workspace cwd must be absolute");
    this.id = `kubernetes:${options.namespace}/${options.container}`;
    this.cwd = options.cwd;
    this.kubectl = options.kubectl;
    this.kubeconfig = options.kubeconfig;
    this.namespace = options.namespace;
    this.container = options.container;
    this.script = options.script;
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      if (pending.signal && pending.abort)
        pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
    this.pending.clear();
    this.watches.clear();
    this.child = undefined;
  }

  private accept(message: Envelope) {
    const pending =
      message.id === undefined ? undefined : this.pending.get(message.id);
    if (message.event === "watch") {
      const listener =
        (message.handle ? this.watches.get(message.handle) : undefined) ??
        pending?.onWatch;
      listener?.(message.change ?? { paths: [] });
      return;
    }
    if (!pending) return;
    if (message.event === "output") {
      pending.onOutput?.(message.text ?? "", BACKGROUND_CONTEXT, {
        stream: message.stream ?? "stdout",
        ...(message.skipped ? { skipped: message.skipped } : {}),
      });
      return;
    }
    const handle =
      message.value &&
      typeof message.value === "object" &&
      "handle" in message.value
        ? Number((message.value as { handle: number }).handle)
        : message.handle;
    if (pending.onWatch && handle) this.watches.set(handle, pending.onWatch);
    this.pending.delete(message.id!);
    if (pending.signal && pending.abort)
      pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(message);
  }

  private async ensure(context: Context) {
    const kubeconfig = this.kubeconfig;
    if (!kubeconfig)
      throw new ExecutionError(
        "spawn_error",
        "This coding workspace has no pinned Kubernetes connection. Rebind it in place with `adm reconnect NAME --kubeconfig PATHS` after selecting the correct host kubeconfig.",
      );
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
      return;
    if (this.starting) return this.starting;
    this.starting = Promise.resolve()
      .then(() => {
        const child = spawn(
          this.kubectl,
          [
            "exec",
            "-i",
            "-n",
            this.namespace,
            "deployment/workspace",
            "-c",
            this.container,
            "--",
            "node",
            this.script,
            "--cwd",
            this.cwd,
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, KUBECONFIG: kubeconfig },
          },
        );
        this.child = child;
        this.buffer = "";
        child.stdout.on("data", (chunk: Buffer) => {
          this.buffer += chunk.toString("utf8");
          if (this.buffer.length > 64 * 1024 * 1024) {
            this.fail(
              new ExecutionError(
                "unknown",
                "Workspace environment sent an oversized response",
              ),
            );
            child.kill("SIGTERM");
            return;
          }
          let newline = this.buffer.indexOf("\n");
          while (newline >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (line.trim()) {
              try {
                this.accept(JSON.parse(line) as Envelope);
              } catch {
                this.fail(
                  new ExecutionError(
                    "unknown",
                    "Workspace environment returned invalid JSON",
                  ),
                );
                child.kill("SIGTERM");
                return;
              }
            }
            newline = this.buffer.indexOf("\n");
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8000);
        });
        child.on("error", (error) =>
          this.fail(new ExecutionError("spawn_error", error.message)),
        );
        child.on("exit", (code, signal) => {
          if (this.child !== child) return;
          this.fail(
            new ExecutionError(
              "spawn_error",
              `Workspace environment exited (${signal ?? code}): ${this.stderr.trim()}`,
            ),
          );
        });
        context.abortSignal?.throwIfAborted();
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  private async rpc(
    method: string,
    args: unknown[],
    context: Context,
    hooks?: Pick<Pending, "onOutput" | "onWatch">,
  ): Promise<Envelope> {
    context.abortSignal?.throwIfAborted();
    await this.ensure(context);
    context.abortSignal?.throwIfAborted();
    const child = this.child;
    if (!child)
      return {
        ok: false,
        error: {
          type: "ExecutionError",
          code: "spawn_error",
          message: "Workspace environment is not running",
        },
      };
    const id = this.nextId++;
    const result = new Promise<Envelope>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        ...hooks,
        signal: context.abortSignal,
      };
      this.pending.set(id, pending);
      const abort = () => this.send({ id, cancel: true });
      pending.abort = abort;
      if (context.abortSignal) {
        if (context.abortSignal.aborted) abort();
        else
          context.abortSignal.addEventListener("abort", abort, { once: true });
      }
    });
    this.send({ id, method, args: encode(args), cwd: this.cwd });
    return result;
  }

  private send(message: unknown) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async invoke<T, E>(
    method: string,
    args: unknown[],
    context: Context,
    hooks?: Pick<Pending, "onOutput" | "onWatch">,
  ): Promise<Result<T, E>> {
    try {
      const message = await this.rpc(method, args, context, hooks);
      if (!message.ok) return err(restoreError(message.error) as E);
      return ok(decode(message.value) as T);
    } catch (error) {
      return err(
        (error instanceof ExecutionError || error instanceof FileError
          ? error
          : new ExecutionError(
              "unknown",
              error instanceof Error ? error.message : String(error),
            )) as E,
      );
    }
  }

  absolutePath(path: string, context: Context) {
    return this.invoke<string, FileError>("absolutePath", [path], context);
  }
  joinPath(parts: string[], context: Context) {
    return this.invoke<string, FileError>("joinPath", [parts], context);
  }
  readTextFile(path: string, context: Context) {
    return this.invoke<string, FileError>("readTextFile", [path], context);
  }
  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ) {
    return this.invoke<string[], FileError>(
      "readTextLines",
      [path, options],
      context,
    );
  }
  readBinaryFile(path: string, context: Context) {
    return this.invoke<Uint8Array, FileError>(
      "readBinaryFile",
      [path],
      context,
    );
  }
  writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.invoke<void, FileError>("writeFile", [path, content], context);
  }
  appendFile(path: string, content: string | Uint8Array, context: Context) {
    return this.invoke<void, FileError>("appendFile", [path, content], context);
  }
  truncateFile(path: string, size: number, context: Context) {
    return this.invoke<void, FileError>("truncateFile", [path, size], context);
  }
  flushFile(path: string, context: Context) {
    return this.invoke<void, FileError>("flushFile", [path], context);
  }
  renameFile(sourcePath: string, destinationPath: string, context: Context) {
    return this.invoke<void, FileError>(
      "renameFile",
      [sourcePath, destinationPath],
      context,
    );
  }
  fileInfo(path: string, context: Context) {
    return this.invoke<FileInfo, FileError>("fileInfo", [path], context);
  }
  listDir(path: string, context: Context) {
    return this.invoke<FileInfo[], FileError>("listDir", [path], context);
  }
  canonicalPath(path: string, context: Context) {
    return this.invoke<string, FileError>("canonicalPath", [path], context);
  }
  exists(path: string, context: Context) {
    return this.invoke<boolean, FileError>("exists", [path], context);
  }
  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ) {
    return this.invoke<void, FileError>("createDir", [path, options], context);
  }
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ) {
    return this.invoke<void, FileError>("remove", [path, options], context);
  }
  createTempDir(prefix: string | undefined, context: Context) {
    return this.invoke<string, FileError>("createTempDir", [prefix], context);
  }
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ) {
    return this.invoke<string, FileError>("createTempFile", [options], context);
  }

  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    const opened = await this.invoke<{ handle: number }, FileError>(
      "openTextLineReader",
      [path],
      context,
    );
    if (!opened.ok) return opened;
    const handle = opened.value.handle;
    return ok({
      readLine: (call) =>
        this.invoke<TextLine | undefined, FileError>(
          "text.readLine",
          [handle],
          call,
        ),
      close: async (call) => {
        await this.invoke<void, FileError>("text.close", [handle], call);
      },
    });
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const opened = await this.invoke<{ handle: number }, FileError>(
      "openBinaryReader",
      [path, options],
      context,
    );
    if (!opened.ok) return opened;
    const handle = opened.value.handle;
    return ok({
      info: (call) =>
        this.invoke<FileInfo, FileError>("binary.info", [handle], call),
      read: (offset, length, call) =>
        this.invoke<Uint8Array, FileError>(
          "binary.read",
          [handle, offset, length],
          call,
        ),
      scanLines: (scan, call) =>
        this.invoke("binary.scanLines", [handle, scan], call),
      close: async (call) => {
        await this.invoke<void, FileError>("binary.close", [handle], call);
      },
    });
  }

  async openDirReader(
    path: string,
    context: Context,
  ): Promise<Result<DirReader, FileError>> {
    const opened = await this.invoke<{ handle: number }, FileError>(
      "openDirReader",
      [path],
      context,
    );
    if (!opened.ok) return opened;
    const handle = opened.value.handle;
    return ok({
      next: (maxEntries, call) =>
        this.invoke("dir.next", [handle, maxEntries], call),
      close: async (call) => {
        await this.invoke<void, FileError>("dir.close", [handle], call);
      },
    });
  }

  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    const opened = await this.invoke<
      { handle: number; mode: FileWatcher["mode"] },
      FileError
    >("watch", [targets], context, { onWatch: onChange });
    if (!opened.ok) return opened;
    const handle = opened.value.handle;
    return ok({
      mode: opened.value.mode,
      close: async (call) => {
        this.watches.delete(handle);
        await this.invoke<void, FileError>("watch.close", [handle], call);
      },
    });
  }

  exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const { onOutput, ...rest } = options ?? {};
    return this.invoke<ShellExecResult, ExecutionError>(
      "exec",
      [command, rest],
      context,
      { onOutput },
    );
  }

  async cleanup(context: Context) {
    const child = this.child;
    if (!child) return;
    await this.invoke<void, ExecutionError>("cleanup", [], context).catch(
      () => undefined,
    );
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await closed;
    }
    if (this.child === child) this.child = undefined;
  }
}
