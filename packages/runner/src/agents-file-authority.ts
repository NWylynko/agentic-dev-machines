// Installation-wide coding instructions, owned by the cluster authority beside
// provider credentials and MCP connectors. Coding Pods read the document;
// bots are refused by the lifecycle before this process sees them.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_AGENTS_FILE_BYTES = 256 * 1024;

export type AgentsFileDocument = {
  source: "installation";
  revision: number;
  content: string;
  updatedAt: string | null;
};

type StoredAgentsFile = {
  revision: number;
  content: string;
  updatedAt: string | null;
};

class AgentsFileError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function createAgentsFileAuthority({
  statePath,
  ownerGuard,
  log = () => {},
}: {
  statePath: string;
  ownerGuard?: () => Promise<boolean>;
  log?: (
    level: "info" | "warn",
    event: string,
    fields?: Record<string, unknown>,
  ) => void;
}) {
  let state: StoredAgentsFile = {
    revision: 0,
    content: "",
    updatedAt: null,
  };
  try {
    const info = await lstat(statePath);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Shared agents file store must be a regular file");
    await chmod(statePath, 0o600);
    const stored = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as StoredAgentsFile;
    if (
      !Number.isSafeInteger(stored.revision) ||
      stored.revision < 0 ||
      typeof stored.content !== "string"
    )
      throw new Error("Shared agents file store is invalid");
    state = {
      revision: stored.revision,
      content: stored.content,
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let writes: Promise<unknown> = Promise.resolve();
  let closed = false;

  function published(): AgentsFileDocument {
    return {
      source: "installation",
      revision: state.revision,
      content: state.content,
      updatedAt: state.updatedAt,
    };
  }

  function persist(change: (draft: StoredAgentsFile) => void) {
    const write = writes.then(async () => {
      if (closed) throw new Error("Shared agents file store is closed");
      const draft = { ...state };
      change(draft);
      if (ownerGuard && !(await ownerGuard()))
        throw new AgentsFileError(
          503,
          "AGENTS_FILE_UNAVAILABLE",
          "Lifecycle provider-auth owner fence is not current",
        );
      const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(draft));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, statePath);
      const directory = await open(dirname(statePath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      state = draft;
    });
    writes = write.catch(() => {});
    return write;
  }

  async function save(content: unknown, baseRevision: unknown) {
    if (typeof content !== "string" || content.includes("\0"))
      throw new AgentsFileError(
        400,
        "INVALID_AGENTS_FILE",
        "content must be text",
      );
    if (Buffer.byteLength(content) > MAX_AGENTS_FILE_BYTES)
      throw new AgentsFileError(
        400,
        "INVALID_AGENTS_FILE",
        "shared agents file is limited to 256 KiB",
      );
    if (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0)
      throw new AgentsFileError(
        400,
        "INVALID_AGENTS_FILE",
        "baseRevision must be the revision that was loaded",
      );
    if (baseRevision !== state.revision) {
      log("warn", "agents_file_rejected", {
        reason: "stale",
        baseRevision,
        revision: state.revision,
      });
      throw new AgentsFileError(
        409,
        "STALE_AGENTS_FILE",
        `shared agents file changed since it was loaded (current revision ${state.revision}); reload it and edit again`,
      );
    }
    if (content === state.content) return published();
    await persist((draft) => {
      draft.revision += 1;
      draft.content = content;
      draft.updatedAt = new Date().toISOString();
    });
    log("info", "agents_file_saved", { revision: state.revision });
    return published();
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    if (path !== "/v1/agents-file" && path !== "/v1/runtime/agents-file")
      return false;
    try {
      if (request.method === "GET") return send(response, 200, published());
      if (request.method === "PUT" && path === "/v1/agents-file") {
        const value = await body(request);
        return send(
          response,
          200,
          await save(value.content, value.baseRevision),
        );
      }
      throw new AgentsFileError(
        405,
        "METHOD_NOT_ALLOWED",
        "this agents file route does not allow that method",
      );
    } catch (error) {
      if (error instanceof AgentsFileError)
        send(response, error.status, {
          error: { code: error.code, message: error.message },
        });
      else
        send(response, 400, {
          error: {
            code: "AGENTS_FILE_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      return true;
    }
  }

  return {
    handle,
    async close() {
      closed = true;
      await writes;
    },
  };
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
  return true;
}

async function body(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_AGENTS_FILE_BYTES + 1024)
      throw new AgentsFileError(
        400,
        "INVALID_AGENTS_FILE",
        "shared agents file is limited to 256 KiB",
      );
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new AgentsFileError(
      400,
      "INVALID_AGENTS_FILE",
      "request body must be JSON",
    );
  }
}
