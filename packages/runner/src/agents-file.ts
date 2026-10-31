// One coding runtime's view of the installation AGENTS.md. The cluster
// authority is the source. A failed read is recorded and left out of the
// next provider request, so an old copy is never presented as current.
import { readFile } from "node:fs/promises";
import type { ConnectorLifecycle } from "./connectors.ts";
import type { SharedAgentsFile } from "./resources.ts";

export type AgentsFileStatus = {
  source: "installation";
  status: "current" | "unavailable";
  revision: number | null;
  error?: string;
};

function causeOf(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export class WorkspaceAgentsFile {
  private lifecycle: ConnectorLifecycle;
  // Unset until the first provider request reads the document.
  private view: AgentsFileStatus | undefined;

  constructor(lifecycle: ConnectorLifecycle) {
    this.lifecycle = lifecycle;
  }

  status(): AgentsFileStatus | undefined {
    return this.view;
  }

  /** Read the installation document for the next provider request. */
  async refresh(): Promise<SharedAgentsFile | undefined> {
    try {
      const token = (await readFile(this.lifecycle.tokenFile, "utf8")).trim();
      if (!token)
        throw new Error("Projected lifecycle identity token is empty");
      const response = await fetch(
        `${this.lifecycle.url.replace(/\/$/, "")}/v1/runtime/agents-file`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const value = (await response.json().catch(() => ({}))) as {
        revision?: unknown;
        content?: unknown;
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(
          value.error?.message ??
            `shared agents file request failed (${response.status})`,
        );
      if (
        !Number.isSafeInteger(value.revision) ||
        typeof value.content !== "string"
      )
        throw new Error("shared agents file response is invalid");
      this.view = {
        source: "installation",
        status: "current",
        revision: value.revision as number,
      };
      return {
        revision: value.revision as number,
        content: value.content,
      };
    } catch (error) {
      const cause = causeOf(error);
      this.view = {
        source: "installation",
        status: "unavailable",
        revision: null,
        error: `shared agents file could not be read (${cause}); it was not applied to this turn`,
      };
      process.stderr.write(
        `${JSON.stringify({
          time: new Date().toISOString(),
          level: "warn",
          event: "agents_file_unavailable",
          cause,
        })}\n`,
      );
      return undefined;
    }
  }
}
