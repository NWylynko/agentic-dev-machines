// A coding workspace whose harness is "claude" (TASK-141): Claude Code works
// there, in tmux session `claude` (image/adm-claude), and Pi takes no turns.
// The runner reads Claude's state for status, listAgents and `adm list`.
//
// Status comes from `$CLAUDE_CONFIG_DIR/sessions/<pid>.json`, the record
// Claude rewrites on every change (`idle` | `busy` | `waiting`). It is
// undocumented, so image/claude-agent.test.mjs and
// packages/runner/test/claude-agent.test.mjs run the real claude against it
// and fail loudly if a Claude bump changes it
// (research/claude-code/tui-driving.md). Hooks miss an Escape; the record
// does not.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { realpathSync, watch } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ApiError, type WorkspaceConfig } from "./types.ts";

const execFileAsync = promisify(execFile);

/** How long Claude may take from tmux start to its first session record. */
const CLAUDE_READY_DEADLINE_MS = Number(
  process.env.ADM_CLAUDE_READY_DEADLINE_MS ?? 60_000,
);

/** Pi-only routes a Claude Code agent refuses (TASK-142). */
export const claudeAgentUnsupportedActions = new Set([
  "goals",
  "loops",
  "model",
  "resume",
  "retry",
  "compact",
]);

export function claudeAgentUnsupported(action: string): ApiError {
  return new ApiError(
    409,
    "CLAUDE_CODE_AGENT",
    `${action} is not supported for Claude Code agents: they run Claude Code in tmux, not Pi. Prompt, monitor or abort them instead`,
  );
}

type ClaudeSessionRecord = {
  pid: number;
  sessionId: string;
  cwd: string;
  status: "idle" | "busy" | "waiting";
  waitingFor?: string;
};

export type ClaudeAgentStatus = {
  /** runtime-status activity: idle | running | waiting | unavailable | error */
  status: "idle" | "running" | "waiting" | "unavailable" | "error";
  error?: string;
  waitingFor?: string;
  sessionId?: string;
};

export class ClaudeCodeSession {
  readonly config: WorkspaceConfig;
  readonly state: string;
  readonly configDir: string;
  private reportedStuckPid?: number;

  constructor(config: WorkspaceConfig) {
    this.config = config;
    if (!config.localRoot)
      throw new Error(
        `Claude Code workspace ${config.id} has no localRoot for Claude's state`,
      );
    // Same default as image/adm-claude: the workspace volume.
    this.state =
      process.env.ADM_CLAUDE_STATE ?? join(config.localRoot, ".adm", "claude");
    this.configDir = join(this.state, "config");
  }

  /** tmux, on the Pod's (or TMUX_TMPDIR's) default server. */
  async tmux(...args: string[]) {
    return (await execFileAsync("tmux", args)).stdout;
  }

  /** The tmux pane running Claude, if session `claude` exists. */
  async pane() {
    let output: string;
    try {
      // "=claude:": exactly session claude, not claude-credentials.
      output = await this.tmux(
        "display-message",
        "-p",
        "-t",
        "=claude:",
        "#{pane_pid} #{session_created}",
      );
    } catch {
      return undefined;
    }
    const [pid, created] = output.trim().split(" ").map(Number);
    return { pid: pid!, createdAt: created! * 1000 };
  }

  async record(pid: number): Promise<ClaudeSessionRecord | undefined> {
    let text: string;
    try {
      text = await readFile(
        join(this.configDir, "sessions", `${pid}.json`),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return JSON.parse(text) as ClaudeSessionRecord;
    } catch {
      return undefined; // mid-write; the next read sees the whole record
    }
  }

  async screen() {
    return (await this.tmux("capture-pane", "-p", "-t", "=claude:"))
      .split("\n")
      .filter((line) => line.trim())
      .slice(-15)
      .join("\n");
  }

  async status(): Promise<ClaudeAgentStatus> {
    const pane = await this.pane();
    if (!pane) {
      const started = await access(join(this.state, "enabled")).then(
        () => true,
        () => false,
      );
      return started
        ? {
            status: "error",
            error: `Claude Code is not running: its tmux session claude ended. See why with adm claude ${this.config.name}`,
          }
        : { status: "unavailable" };
    }
    const record = await this.record(pane.pid);
    if (!record) {
      // No record yet: Claude is starting, or stuck on a screen nobody
      // answers. Decided when status is read, so no timer runs.
      if (Date.now() - pane.createdAt < CLAUDE_READY_DEADLINE_MS)
        return { status: "unavailable" };
      const screen = await this.screen().catch((error) => String(error));
      const error = `Claude Code has not become ready ${Math.round(CLAUDE_READY_DEADLINE_MS / 1000)} s after it started in tmux session claude; its screen:\n${screen}`;
      if (this.reportedStuckPid !== pane.pid) {
        this.reportedStuckPid = pane.pid;
        process.stderr.write(
          `${JSON.stringify({ level: "error", event: "claude_not_ready", workspace: this.config.id, pid: pane.pid, screen })}\n`,
        );
      }
      return { status: "error", error: error.slice(0, 2000) };
    }
    const activity = { idle: "idle", busy: "running", waiting: "waiting" }[
      record.status
    ] as ClaudeAgentStatus["status"] | undefined;
    if (!activity)
      return {
        status: "error",
        error: `Claude Code's session record has status ${JSON.stringify(record.status)}, which this ADM release does not know: Claude changed its session record`,
      };
    return {
      status: activity,
      ...(record.waitingFor ? { waitingFor: record.waitingFor } : {}),
      sessionId: record.sessionId,
    };
  }

  /**
   * Types a prompt into Claude and submits it (TASK-142): one tmux call
   * pastes it as a bracketed paste (newlines stay text) and presses Enter.
   * Typed mid-turn, Claude queues it and takes it at its next safe point, so
   * steer and followUp both just type. Confirmed by the transcript: a user
   * entry, or a queue-operation enqueue, with this text.
   */
  async input(
    message: string,
    requestId: string | undefined,
    whenBusy: "steer" | "followUp" | "reject",
  ) {
    if (!message.trim())
      throw new ApiError(400, "INVALID_MESSAGE", "Input requires text");
    const delivered = requestId
      ? this.deliveredInputs.get(requestId)
      : undefined;
    if (delivered) return delivered;
    const status = await this.status();
    if (status.status === "waiting")
      throw new ApiError(
        409,
        "CLAUDE_CODE_WAITING",
        `Claude Code is waiting for an answer to its own question (${status.waitingFor ?? "input needed"}): a prompt would be typed into that question. Abort it first, or answer it with adm claude ${this.config.name}`,
      );
    if (status.status === "error" || status.status === "unavailable")
      throw new ApiError(
        409,
        "CLAUDE_CODE_NOT_READY",
        `Claude Code cannot take a prompt: ${status.error ?? "it has not started yet"}`,
      );
    if (status.status === "running" && whenBusy === "reject")
      throw new ApiError(
        409,
        "AGENT_BUSY",
        "Claude Code is working on a turn; send with whenBusy steer or followUp to queue the prompt",
      );
    const transcript = await this.transcriptFile();
    const offset = transcript
      ? ((await stat(transcript).catch(() => undefined))?.size ?? 0)
      : 0;
    // load-buffer reads stdin: an argument is capped ("command too long").
    const buffer = `adm-input-${randomUUID()}`;
    const load = spawn("tmux", ["load-buffer", "-b", buffer, "-"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let loadError = "";
    load.stderr.on("data", (chunk) => (loadError += chunk));
    load.stdin.end(message);
    const [code] = await once(load, "close");
    if (code !== 0)
      throw new Error(`tmux load-buffer failed (${code}): ${loadError}`);
    await this.tmux(
      "paste-buffer",
      "-p",
      "-d",
      "-b",
      buffer,
      "-t",
      "=claude:",
      ";",
      "send-keys",
      "-t",
      "=claude:",
      "Enter",
    );
    const expected = message.trim();
    const directory = transcript
      ? dirname(transcript)
      : this.transcriptDirectory();
    await whenDirectoryShows(
      directory,
      async () => {
        const file = transcript ?? (await this.transcriptFile());
        if (!file) return undefined;
        // offset counts bytes, and the transcript is not ASCII.
        const lines = (await readFile(file))
          .subarray(transcript ? offset : 0)
          .toString("utf8")
          .split("\n");
        lines.pop(); // an unfinished line
        return lines.some((line) => {
          let entry: TranscriptEntry;
          try {
            entry = JSON.parse(line);
          } catch {
            return false;
          }
          return (entry.type === "queue-operation" &&
            entry.operation === "enqueue" &&
            entry.content?.trim() === expected) ||
            (entry.type === "user" &&
              !entry.isMeta &&
              userText(entry)?.trim() === expected)
            ? true
            : false;
        })
          ? true
          : undefined;
      },
      async () => {
        const screen = await this.screen().catch((error) => String(error));
        process.stderr.write(
          `${JSON.stringify({ level: "error", event: "claude_prompt_unconfirmed", workspace: this.config.id, requestId, screen })}\n`,
        );
        return new ApiError(
          504,
          "CLAUDE_CODE_PROMPT_UNCONFIRMED",
          `Claude Code did not take the prompt within ${CLAUDE_INPUT_DEADLINE_MS / 1000} s; its screen:\n${screen}`.slice(
            0,
            2000,
          ),
        );
      },
      CLAUDE_INPUT_DEADLINE_MS,
    );
    const result = {
      status: "admitted",
      queued: status.status === "running",
    };
    if (requestId) {
      this.deliveredInputs.set(requestId, result);
      // Only a retry after a lost acknowledgement needs the receipt.
      if (this.deliveredInputs.size > 256)
        this.deliveredInputs.delete(this.deliveredInputs.keys().next().value!);
    }
    return result;
  }

  /** Escape to Claude, as a person would: ends the turn or Claude's question. */
  async abort() {
    const before = await this.status();
    // Escape when idle does nothing useful, and two in a row open Claude's
    // rewind menu: press it only while Claude works or asks.
    if (before.status !== "running" && before.status !== "waiting")
      return before;
    await this.tmux("send-keys", "-t", "=claude:", "Escape");
    const pane = await this.pane();
    if (!pane) return this.status();
    await whenDirectoryShows(
      join(this.configDir, "sessions"),
      async () =>
        (await this.record(pane.pid))?.status === "idle" ? true : undefined,
      async () => {
        const screen = await this.screen().catch((error) => String(error));
        return new ApiError(
          504,
          "CLAUDE_CODE_ABORT_UNCONFIRMED",
          `Claude Code is not idle ${CLAUDE_INPUT_DEADLINE_MS / 1000} s after Escape; its screen:\n${screen}`.slice(
            0,
            2000,
          ),
        );
      },
      CLAUDE_INPUT_DEADLINE_MS,
    );
    return this.status();
  }

  /**
   * The bot's view of the conversation (TASK-142): prompts (typed by anyone,
   * including Nick attached with adm claude or the app) and the final reply
   * of each turn, never tool calls or results, so the bot's context stays
   * small. `seq` is the position in that list.
   */
  async history(after: number, limit: number) {
    const file = await this.transcriptFile();
    const entries = file
      ? (await readFile(file, "utf8"))
          .split("\n")
          .filter((line) => line.trim())
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as TranscriptEntry];
            } catch {
              return []; // the line Claude is writing now
            }
          })
      : [];
    const events = claudeTranscriptHistory(entries).map((event, index) => ({
      seq: index + 1,
      ...event,
    }));
    const page = events.slice(after, after + limit);
    return {
      harness: "claude",
      events: page,
      nextAfter: page.at(-1)?.seq ?? after,
      hasMore: after + limit < events.length,
    };
  }

  /** Claude keeps a conversation per physical cwd (/repos is a symlink). */
  transcriptDirectory() {
    const cwd = realpathSync(this.config.cwd ?? this.config.localRoot!);
    return join(this.configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  }

  /**
   * The current conversation: the newest transcript for the cwd, which is
   * also the one `claude --continue` resumes after a Pod restart.
   */
  async transcriptFile() {
    const directory = this.transcriptDirectory();
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) =>
        name.endsWith(".jsonl"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const files = await Promise.all(
      names.map(async (name) => ({
        file: join(directory, name),
        modified: (await stat(join(directory, name))).mtimeMs,
      })),
    );
    return files.sort((a, b) => b.modified - a.modified)[0]?.file;
  }

  private deliveredInputs = new Map<
    string,
    { status: string; queued: boolean }
  >();
}

/** How long Claude may take to show a prompt or an Escape in its files. */
const CLAUDE_INPUT_DEADLINE_MS = 15_000;

type TranscriptEntry = {
  type?: string;
  operation?: string;
  content?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  attachment?: { type?: string; prompt?: string };
  message?: {
    content?: string | { type: string; text?: string }[];
  };
};

function userText(entry: TranscriptEntry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  // An Escape during a tool call or question comes back as its result.
  const interrupted = content.find(
    (block) =>
      block.type === "text" &&
      block.text?.startsWith("[Request interrupted by user"),
  );
  if (interrupted) return interrupted.text;
  if (content.some((block) => block.type === "tool_result")) return undefined;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Prompts and final replies from Claude's transcript jsonl
 * (research/claude-code/tui-driving.md, section 5). Skips subagents, meta
 * entries, tool calls and results, and the line types Claude adds over time.
 */
export function claudeTranscriptHistory(entries: TranscriptEntry[]) {
  const history: (
    | { kind: "user"; text: string; midTurn?: true }
    | { kind: "assistant"; text: string }
    | { kind: "interrupted" }
  )[] = [];
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    // Typed mid-turn and delivered with a tool result, in the same turn.
    if (
      entry.type === "attachment" &&
      entry.attachment?.type === "queued_command" &&
      typeof entry.attachment.prompt === "string"
    )
      history.push({
        kind: "user",
        text: entry.attachment.prompt,
        midTurn: true,
      });
    if (entry.type === "user" && !entry.isMeta) {
      const text = userText(entry);
      if (text === undefined) continue;
      if (text.startsWith("[Request interrupted by user"))
        history.push({ kind: "interrupted" });
      else history.push({ kind: "user", text });
    }
    if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
      const text = entry.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (!text) continue;
      const previous = history.at(-1);
      // Only the latest text of a turn is kept: its final reply.
      if (previous?.kind === "assistant") previous.text = text;
      else history.push({ kind: "assistant", text });
    }
  }
  return history;
}

/**
 * Resolves once `check` finds what it looks for, re-checking whenever
 * `directory` changes. The deadline is unavoidable: Claude may never write
 * what is waited for (it ignored the keys), and only a deadline can say so;
 * every success is an event.
 */
function whenDirectoryShows<T>(
  directory: string,
  check: () => Promise<T | undefined>,
  failure: () => Promise<Error>,
  deadlineMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    // Watch before the first check, so no change falls between them.
    const watcher = watch(directory);
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      watcher.close();
      settle();
    };
    const deadline = setTimeout(() => {
      failure().then(
        (error) => finish(() => reject(error)),
        (error) => finish(() => reject(error)),
      );
    }, deadlineMs);
    let checking = Promise.resolve();
    const recheck = () => {
      checking = checking
        .then(async () => {
          if (done) return;
          const value = await check();
          if (value !== undefined) finish(() => resolve(value));
        })
        .catch((error) => finish(() => reject(error)));
    };
    watcher.on("change", recheck);
    watcher.on("error", (error) => finish(() => reject(error)));
    recheck();
  });
}
