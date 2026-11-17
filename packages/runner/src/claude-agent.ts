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
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
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
  "input",
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
}
