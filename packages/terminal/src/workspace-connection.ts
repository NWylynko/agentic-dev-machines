import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { Model } from "@earendil-works/pi-ai";
import {
  ConversationTranscript,
  type ConversationView,
  type TranscriptView,
} from "@earendil-works/pi-durable";

export type WorkspaceCacheWarming = {
  state: "inactive" | "scheduled" | "refreshing";
  reason?: string;
  nextWarmAt?: number;
  extensionOverride?: boolean;
};
export type ActiveBashOperation = {
  operationId: string;
  requestId: string;
  command: string;
  excludeFromContext: boolean;
};
export type ProviderMetadata = {
  id: string;
  authenticated?: boolean;
  authType?: "api_key" | "oauth";
  subscription?: boolean;
};
export type ModelCatalog = {
  models?: Model<any>[];
  providers?: ProviderMetadata[];
  selected?: { provider: string; id: string };
  error?: string;
  refresh?: {
    aborted?: boolean;
    errors?: { provider: string; message: string }[];
  };
};
export type ConnectionOptions = {
  url: string;
  workspaceId: string;
  tokenFile?: string;
  identityFile?: string;
  diagnostics?: boolean;
  adminCommand?: { executable: string; args: string[] };
};
export type EventStreamDrop = {
  reason: "end" | "error" | "silence";
  upMs: number;
  detail?: string;
};
/**
 * A change of the attached conversation: `previous` is undefined on the first
 * view of a conversation, after attaching or switching branches.
 */
export type ViewChange = {
  previous?: TranscriptView;
  next: TranscriptView;
};

const execFileAsync = promisify(execFile);

/**
 * The client side of one workspace runner: authorized requests, and a replica
 * of the selected conversation's Durable view that follows `/events` and keeps
 * the whole transcript in a `ConversationTranscript`.
 */
export class WorkspaceConnection {
  role: "coding" | "bot" = "coding";
  workspaceName = "";
  cwd = "/workspace";
  conversationId?: number;
  activeBash: ActiveBashOperation[] = [];
  cacheWarming?: WorkspaceCacheWarming;
  status = "Connecting…";
  connected = false;
  catalog?: ModelCatalog;
  view?: TranscriptView;
  private replica?: ConversationView;
  private transcript?: ConversationTranscript;
  private controller?: AbortController;
  private connecting?: Promise<void>;
  private closed = false;
  private viewListeners = new Set<(change: ViewChange) => void>();
  private dropListeners = new Set<(drop: EventStreamDrop) => void>();

  constructor(readonly options: ConnectionOptions) {}

  get workspaceId() {
    return this.options.workspaceId;
  }
  get diagnostics() {
    return this.options.diagnostics === true;
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

  /** One runner request; independent of the attach stream, which may drop. */
  async request<T = any>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    method?: "GET" | "POST" | "PUT",
  ): Promise<T> {
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

  async loadModelCatalog(signal?: AbortSignal, refresh = false) {
    this.catalog = await this.request<ModelCatalog>(
      refresh ? "/models?refresh=true" : "/models",
      undefined,
      signal,
    );
    return this.catalog;
  }

  /** Follow the changes of the attached conversation. */
  subscribeView(listener: (change: ViewChange) => void) {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }
  /** Learn when the attach stream ends, errors, or falls silent. */
  subscribeEventStreamDrops(listener: (drop: EventStreamDrop) => void) {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  /**
   * (Re)attach: read the workspace, follow its selected conversation from where
   * this client's transcript ends, and load whatever of the transcript it lacks.
   * Rejects when the workspace cannot be reached; `status` says why.
   */
  connect() {
    if (this.closed)
      return Promise.reject(new Error("The workspace connection is closed"));
    this.connecting ??= this.attach().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async attach() {
    this.connected = false;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.status = "Connecting…";
    try {
      const workspace = await this.request("", undefined, controller.signal);
      if (!["coding", "bot"].includes(workspace.role))
        throw new Error("Runner returned an invalid workspace role");
      if (!Number.isSafeInteger(workspace.conversationId))
        throw new Error("Runner returned no selected conversation");
      if (workspace.conversationId !== this.conversationId) {
        this.transcript = undefined;
        this.replica = undefined;
        this.view = undefined;
      }
      this.conversationId = workspace.conversationId as number;
      this.role = workspace.role;
      this.workspaceName = workspace.name;
      const cwd = workspace.cwd ?? workspace.localRoot;
      if (typeof cwd === "string" && cwd.trim()) this.cwd = cwd;
      this.activeBash = Array.isArray(workspace.activeBash)
        ? workspace.activeBash
        : [];
      this.cacheWarming = workspace.cacheWarming;
      const workspaceStatus =
        workspace.status === "error"
          ? `Provider error · ${workspace.error ?? "The provider request failed"}`
          : String(workspace.status);
      const conversationId = this.conversationId;
      this.transcript ??= new ConversationTranscript(
        async (query, limit) => {
          const page = await this.request<{
            items: ConversationView["entries"];
            hasMore: boolean;
          }>(
            `/entries?${entriesQuery({ ...query, limit, diagnostics: this.diagnostics })}`,
            undefined,
            // The attach in progress: the transcript outlives a reconnect.
            this.controller?.signal,
          );
          return {
            items: page.items,
            ...(page.hasMore ? { next: {} } : {}),
          };
        },
        { pageSize: 200 },
      );
      const transcript = this.transcript;
      const from = transcript.resume?.from;
      const response = await fetch(
        this.endpoint(
          `/events?conversationId=${conversationId}&diagnostics=${this.diagnostics}${from === undefined ? "" : `&from=${from}`}`,
        ),
        {
          signal: controller.signal,
          headers: {
            accept: "text/event-stream",
            ...(await this.authorizationHeaders()),
          },
        },
      );
      if (!response.ok) {
        let detail: any;
        try {
          detail = await response.json();
        } catch {}
        throw new Error(
          detail?.error?.message ??
            `Event stream returned HTTP ${response.status}`,
        );
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream"))
        throw new Error("Runner did not return an event stream");
      const keepaliveMs = Number(
        response.headers.get("x-adm-events-keepalive-ms"),
      );
      if (!Number.isSafeInteger(keepaliveMs) || keepaliveMs < 1)
        throw new Error("Runner did not declare its event-stream keepalive");
      if (!response.body) throw new Error("Event stream has no response body");
      const frames = sseFrames(response.body, keepaliveMs);
      const first = await frames.next();
      if (first.done || first.value.event !== "view")
        throw new Error("Runner did not start the event stream with a view");
      const opened = first.value.data as {
        workspaceId: string;
        conversationId: number;
        value: ConversationView;
      };
      if (
        opened.workspaceId !== this.options.workspaceId ||
        opened.conversationId !== conversationId
      )
        throw new Error("Runner returned the view of another conversation");
      this.replica = opened.value;
      this.publish(transcript.merge(this.replica));
      await this.loadWholeTranscript(transcript);
      this.connected = true;
      this.status = `Connected · ${workspaceStatus}`;
      void this.follow(frames, controller, transcript);
    } catch (error) {
      controller.abort();
      if (this.controller === controller) this.controller = undefined;
      this.status = `Connection unavailable: ${error instanceof Error ? error.message : error}`;
      throw error;
    }
  }

  // Pi renders the session's whole transcript, so attach loads all of it.
  private async loadWholeTranscript(transcript: ConversationTranscript) {
    for (;;) {
      const items = this.view?.items ?? [];
      if (items[0]?.kind === "earlier") {
        this.publish(await transcript.loadEarlier(BACKGROUND_CONTEXT));
        continue;
      }
      const gap = items.find((item) => item.kind === "gap");
      if (gap?.kind !== "gap") return;
      this.publish(await transcript.fillGap(gap, BACKGROUND_CONTEXT));
    }
  }

  private publish(next: TranscriptView) {
    const previous = this.view;
    if (previous === next) return;
    this.view = next;
    for (const listener of this.viewListeners) listener({ previous, next });
  }

  private async follow(
    frames: AsyncGenerator<SseFrame, EventStreamDrop>,
    controller: AbortController,
    transcript: ConversationTranscript,
  ) {
    const openedAt = Date.now();
    let drop: EventStreamDrop;
    try {
      for (;;) {
        const frame = await frames.next();
        if (frame.done) {
          drop = frame.value;
          break;
        }
        if (frame.value.event === "error")
          throw new Error(
            (frame.value.data as { error?: string }).error ??
              "The runner's event stream failed",
          );
        if (frame.value.event !== "ops")
          throw new Error(
            `Runner sent an unexpected ${frame.value.event} event`,
          );
        this.replica = applyImmutable(
          this.replica,
          (frame.value.data as { ops: Op[] }).ops,
        );
        this.publish(transcript.merge(this.replica!));
        // A window that skipped entries (a stall or an overflow) leaves a gap.
        await this.loadWholeTranscript(transcript);
      }
    } catch (error) {
      drop = {
        reason: "error",
        upMs: Date.now() - openedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (controller.signal.aborted) return;
    controller.abort();
    this.connected = false;
    this.status = `Disconnected (${eventStreamDropText(drop)}). Agents keep working.`;
    try {
      await logTerminalEvent({
        event: "event_stream_dropped",
        workspaceId: this.options.workspaceId,
        conversationId: this.conversationId,
        newestEntry: transcript.newest,
        ...drop,
      });
    } catch (error) {
      this.status = `${this.status} Terminal log unavailable: ${error instanceof Error ? error.message : error}`;
    }
    for (const listener of this.dropListeners) listener(drop);
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
      throw new Error(
        `Runner returned HTTP ${response.status} for operation stream`,
      );
    if (!response.headers.get("content-type")?.includes("text/event-stream"))
      throw new Error("Runner returned a non-event-stream operation response");
    for await (const frame of sseFrames(response.body)) yield frame.data as T;
  }

  async executeBash(
    command: string,
    onChunk: (chunk: string) => void,
    options: {
      excludeFromContext?: boolean;
      id: string;
      signal?: AbortSignal;
      onAdmitted?: (operationId: string) => void;
    },
  ) {
    const admission = await this.request<{ operationId: string }>(
      "/bash",
      {
        command,
        requestId: options.id,
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
    let result: Record<string, unknown> | undefined;
    for await (const frame of sseFrames(response.body)) {
      if (frame.event === "output") {
        const chunk = frame.data as { text?: unknown };
        if (typeof chunk.text !== "string")
          throw new Error("Runner bash output event was malformed");
        onChunk(chunk.text);
      } else if (frame.event === "result") {
        if (!frame.data || typeof frame.data !== "object")
          throw new Error("Runner bash result event was malformed");
        result = frame.data as Record<string, unknown>;
        break;
      }
    }
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

  abortBash(operationId: string) {
    return this.request(`/bash/${encodeURIComponent(operationId)}/abort`, {});
  }

  /**
   * Run `adm COMMAND ARGS` on this client with the terminal handed over (the
   * caller stops its UI first), then reattach: the command may change what the
   * workspace can do, such as its providers.
   */
  async runAdminCommand(command: string, args: string[]) {
    const adminCommand = this.options.adminCommand;
    if (!adminCommand)
      throw new Error(`adm ${command} is unavailable in this attach session`);
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
    }
    await this.connect();
    if (commandError) throw commandError;
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.controller?.abort();
    this.status = "Detached; agents keep working";
  }
}

function entriesQuery(query: {
  order?: string;
  minEntryId?: number;
  maxEntryId?: number;
  limit: number;
  diagnostics: boolean;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return params.toString();
}

type SseFrame = { event: string; data: unknown };

/**
 * The frames of one server-sent event stream. With `keepaliveMs`, three
 * silent keepalive intervals end it as a half-open connection (`silence`).
 */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  keepaliveMs?: number,
): AsyncGenerator<SseFrame, EventStreamDrop> {
  const openedAt = Date.now();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let silenced = false;
  let silenceDeadline: ReturnType<typeof setTimeout> | undefined;
  const armSilenceDeadline = () => {
    if (keepaliveMs === undefined) return;
    clearTimeout(silenceDeadline);
    silenceDeadline = setTimeout(() => {
      silenced = true;
      void reader.cancel();
    }, 3 * keepaliveMs);
  };
  let buffer = "",
    data: string[] = [],
    event = "message";
  try {
    armSilenceDeadline();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      armSilenceDeadline();
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 64 * 1024 * 1024)
        throw new Error("Runner sent an oversized event");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
          data = [];
          event = "message";
        } else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
    }
    return {
      reason: silenced ? "silence" : "end",
      upMs: Date.now() - openedAt,
    };
  } finally {
    clearTimeout(silenceDeadline);
    await reader.cancel().catch(() => {});
  }
}

export function eventStreamDropText(drop: EventStreamDrop) {
  return drop.reason === "silence"
    ? "event stream went silent"
    : drop.reason === "end"
      ? "event stream ended"
      : `event stream failed: ${drop.detail}`;
}

// JSON lines under $XDG_STATE_HOME/adm/terminal.log: the attached terminal
// owns the screen, so its diagnostics cannot go to stderr.
export function terminalLogPath() {
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "adm",
    "terminal.log",
  );
}

async function logTerminalEvent(record: Record<string, unknown>) {
  const path = terminalLogPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
  );
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

// The runtime token of the verified workspace Pod, read again for every
// request so a rotated projected token keeps working.
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
