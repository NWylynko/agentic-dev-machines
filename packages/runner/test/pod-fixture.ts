// Lifecycle-owned Pod runners for end-to-end tests. The fake lifecycle grants
// each registered workspace its own lease and authorizes callers by their
// projected identity token, as the controller does after TokenReview. Runtime
// connector routes are forwarded to a real connector authority, exactly as the
// controller proxies them, after the same identity check.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { nextHistoryEvent } from "./attach-stream.ts";

const main = new URL("../src/main.ts", import.meta.url).pathname;

export async function startPodLifecycle({
  authorityUrl,
}: {
  authorityUrl: string;
}) {
  const identities = new Map<string, { id: string; role: "coding" | "bot" }>();
  const connectorRequests: { sourceId: string; path: string }[] = [];
  const agentsFileRequests: { sourceId: string; path: string }[] = [];
  let failAgentsFile = false;
  const server = createServer(async (request, response) => {
    const headers = { "content-type": "application/json" };
    const source = identities.get(
      request.headers.authorization?.replace(/^Bearer /, "") ?? "",
    );
    const requestUrl = request.url ?? "/";
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (!source)
      return response
        .writeHead(403, headers)
        .end(JSON.stringify({ error: { message: "forbidden" } }));
    const sourceId = source.id;
    if (request.method === "GET" && requestUrl === "/v1/runtime/agents-file") {
      if (source.role !== "coding")
        return response.writeHead(403, headers).end(
          JSON.stringify({
            error: {
              message: "shared agents file is restricted to coding workspaces",
            },
          }),
        );
      if (failAgentsFile)
        return response.writeHead(503, headers).end(
          JSON.stringify({
            error: { message: "agents file authority is down" },
          }),
        );
      agentsFileRequests.push({ sourceId, path: requestUrl });
      const upstream = await fetch(authorityUrl + requestUrl);
      return response
        .writeHead(upstream.status, headers)
        .end(await upstream.text());
    }
    if (
      request.method === "POST" &&
      requestUrl.startsWith("/v1/runtime/connectors/")
    ) {
      connectorRequests.push({ sourceId, path: requestUrl });
      const upstream = await fetch(authorityUrl + requestUrl, {
        method: "POST",
        headers,
        body: raw,
      });
      return response
        .writeHead(upstream.status, headers)
        .end(await upstream.text());
    }
    const runtime =
      /^\/v1\/workspaces\/([^/]+)\/runtime\/(authorize|lease|lease\/renew|check)$/.exec(
        requestUrl,
      );
    if (request.method === "POST" && runtime) {
      const value = raw ? JSON.parse(raw) : {};
      if (runtime[2] === "authorize")
        return response
          .writeHead(200, headers)
          .end(JSON.stringify({ allowed: true }));
      if (decodeURIComponent(runtime[1]!) !== sourceId)
        return response
          .writeHead(403, headers)
          .end(JSON.stringify({ error: { message: "not authorized" } }));
      return response.writeHead(200, headers).end(
        JSON.stringify({
          workspaceId: sourceId,
          holder: value.holder,
          fencingToken: 1,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          valid: true,
        }),
      );
    }
    response
      .writeHead(404, headers)
      .end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    identities,
    connectorRequests,
    agentsFileRequests,
    get failAgentsFile() {
      return failAgentsFile;
    },
    set failAgentsFile(value: boolean) {
      failAgentsFile = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export type PodLifecycle = Awaited<ReturnType<typeof startPodLifecycle>>;
export type RunnerEvent = {
  seq: number;
  kind: string;
  data: Record<string, any>;
};

/** Start one runner process that owns a single mounted Pod workspace. */
export async function startPodRunner(
  root: string,
  lifecycle: PodLifecycle,
  {
    id,
    name,
    role,
    model = true,
    env = {},
    repositories = false,
  }: {
    id: string;
    name: string;
    role: "coding" | "bot";
    model?: boolean;
    env?: Record<string, string>;
    repositories?: boolean;
  },
) {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  const token = `identity-${id}`;
  const tokenFile = join(directory, "projected-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  lifecycle.identities.set(token, { id, role });
  const workspaceConfig = join(directory, "workspace.json");
  await writeFile(
    workspaceConfig,
    JSON.stringify({
      id,
      name,
      role,
      environment: "pod",
      ...(role === "coding" ? { localRoot: join(directory, "repos") } : {}),
      ...(model ? { model: { provider: "faux", id: "faux-1" } } : {}),
      ...(repositories ? { repositories: true } : {}),
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      main,
      "--port",
      "0",
      "--state-dir",
      join(directory, "state"),
      "--token-file",
      tokenFile,
      "--workspace-config",
      workspaceConfig,
      "--lifecycle-url",
      lifecycle.url,
      "--pod-uid",
      randomUUID(),
      "--provider",
      "faux",
      ...(model ? ["--model", "faux-1"] : []),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: directory, ...env },
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Runner exited ${code}: ${errors}`)),
    );
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.ready) resolve(value.url);
      } catch {
        /* Other stdout is diagnostic. */
      }
    });
  });
  const path = `/v1/workspaces/${id}`;
  return {
    id,
    url,
    directory,
    tokenFile,
    get errors() {
      return errors;
    },
    async request(
      suffix = "",
      method = "GET",
      body?: unknown,
    ): Promise<{ status: number; body: any }> {
      const response = await fetch(url + path + suffix, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    /** Wait for a history event after `after` that satisfies `predicate`. */
    event(
      predicate: (event: RunnerEvent) => boolean,
      after = 0,
    ): Promise<RunnerEvent> {
      return nextHistoryEvent(url, path, predicate, {
        after,
        diagnostics: true,
        headers: { authorization: `Bearer ${token}` },
      });
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      lines.close();
    },
  };
}
