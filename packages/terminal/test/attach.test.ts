import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assistantText,
  attachThroughProxy,
  fauxPrompt,
  occurrences,
  startWorkspace,
} from "./attach-harness.ts";
import { WorkspaceConnection } from "../src/workspace-connection.ts";
import { TERMINAL_TEST_TIMEOUT_MS } from "./wait-budget.ts";

test(
  "attach shows a provider catalog error instead of a blank screen (TASK-97)",
  { timeout: TERMINAL_TEST_TIMEOUT_MS },
  async (t) => {
    const workspace = await startWorkspace(t, "catalog-error");
    const error =
      "xai: token refresh failed (HTTP 400 invalid_grant): run adm login xai";
    workspace.proxyControl.override = (request) =>
      request.path.includes("/models")
        ? {
            status: 200,
            body: {
              providers: [{ id: "xai", authenticated: false }],
              models: [],
              error,
            },
          }
        : undefined;
    const terminal = await workspace.attach();
    await terminal.waitScreen("the provider error", (text) =>
      text.replace(/\s+/g, " ").includes(error),
    );
  },
);

test(
  "attach without a model opens Pi's model selector and the choice is the workspace's",
  { timeout: TERMINAL_TEST_TIMEOUT_MS },
  async (t) => {
    const workspace = await startWorkspace(t, "choose-model", { model: null });
    const chosen = workspace.proxyControl.nextRequest(
      (request) => request.method === "PUT" && request.path.endsWith("/model"),
    );
    const terminal = await workspace.attach();
    await terminal.waitScreen("Pi's model selector", (text) =>
      text.includes("faux-1"),
    );
    terminal.child.stdin!.write("\r");
    await chosen;
    // Pi acknowledges the model once the workspace has answered.
    await terminal.waitScreen("the model acknowledgement", (text) =>
      text.includes("Model: faux-1"),
    );
    const models = await (
      await fetch(`${workspace.runnerUrl}/v1/workspaces/choose-model/models`)
    ).json();
    assert.equal(models.selected.provider, "faux");
    await terminal.submit(
      fauxPrompt({ answer: "Answered by the chosen model" }),
    );
    await terminal.settledReply("Answered by the chosen model");
  },
);

test(
  "detaching mid-run leaves the agent working, and the next attach shows the finished run once",
  { timeout: TERMINAL_TEST_TIMEOUT_MS },
  async (t) => {
    const attached = await attachThroughProxy(t, "detach-mid-run");
    const tool = await attached.blockingTool();
    const answered = attached.entry(
      (entry) => assistantText(entry) === "Finished after detaching",
    );
    await attached.submit(
      fauxPrompt({
        calls: [{ tool: "bash", args: { command: tool.command } }],
        answer: "Finished after detaching",
      }),
    );
    await tool.started;
    await attached.waitScreen("the running tool", (text) =>
      text.includes("Working"),
    );
    assert.equal(await attached.detach(), 0);
    assert.ok(
      !attached.proxyControl.requests.some((request) =>
        request.path.endsWith("/abort"),
      ),
      "detaching never aborts the agent",
    );
    await tool.release("output-while-detached");
    await answered;

    const again = await attached.attach();
    const shown = await again.settledReply("Finished after detaching");
    assert.equal(occurrences(shown, "output-while-detached"), 1, shown);
  },
);

test("a terminal re-reads the verified Pod identity, so a rotated token keeps the attach and prompts authorized", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-terminal-identity-"));
  t.after(() => rm(directory, { recursive: true }));
  const identityPath = join(directory, "identity.json");
  const tokenPath = join(directory, "projection");
  const kubectlPath = join(directory, "kubectl");
  await writeFile(tokenPath, "projected-runtime-token-1\n", { mode: 0o600 });
  await writeFile(
    identityPath,
    JSON.stringify({
      workspaceId: "work",
      namespace: "adm-work",
      podName: "workspace-0",
      podUid: "a1b2c3d4-e5f6-47a8-9012-123456789abc",
      container: "dev",
      kubectl: kubectlPath,
      kubeconfig: "/tmp/kubeconfig",
    }),
    { mode: 0o600 },
  );
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // kubectl reports the Pod ready and reads its projected token file.
  await writeFile(
    kubectlPath,
    `#!/bin/sh\nif [ "$1" = get ]; then printf '%s' '{"metadata":{"uid":"a1b2c3d4-e5f6-47a8-9012-123456789abc","namespace":"adm-work","labels":{"adm.dev/workspace-id":"work"}},"spec":{"serviceAccountName":"adm-runtime"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}'; else cat ${shellQuote(tokenPath)}; fi\n`,
    { mode: 0o700 },
  );
  // A runner that checks only the bearer token.
  const observed: string[] = [];
  const server = createServer(async (request, response) => {
    observed.push(request.headers.authorization ?? "");
    if (
      !request.headers.authorization?.startsWith(
        "Bearer projected-runtime-token-",
      )
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.url?.includes("/events")) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-adm-events-keepalive-ms": "60000",
      });
      response.write(
        `event: view\ndata: ${JSON.stringify({
          workspaceId: "work",
          conversationId: 1,
          value: { conversation: { id: 1 }, entries: [], docs: {} },
        })}\n\n`,
      );
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.method === "POST"
          ? { submissionId: 2, status: "admitted" }
          : {
              id: "work",
              name: "demo",
              role: "coding",
              status: "idle",
              conversationId: 1,
            },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const connection = new WorkspaceConnection({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    workspaceId: "work",
    identityFile: identityPath,
  });
  t.after(() => connection.close());
  await connection.connect();
  assert.equal(connection.connected, true, connection.status);
  await writeFile(tokenPath, "projected-runtime-token-2\n", { mode: 0o600 });
  await connection.request("/input", { message: "hello", requestId: "r" });
  assert.ok(observed.includes("Bearer projected-runtime-token-1"));
  assert.ok(observed.includes("Bearer projected-runtime-token-2"));
});
