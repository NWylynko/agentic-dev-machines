import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderAuthAuthority } from "../src/provider-auth-authority.ts";
import { startMcpOAuthServer } from "./mcp-oauth-fixture.ts";
import { startPodLifecycle, startPodRunner } from "./pod-fixture.ts";

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile())
      files.push(await readFile(join(entry.parentPath, entry.name), "latin1"));
  return files.join("\n");
}

// The CLI under test: CI's `cargo test` builds it before `npm test`.
const admBinary =
  process.env.ADM_BIN ??
  join(
    process.env.CARGO_TARGET_DIR ??
      new URL("../../../target", import.meta.url).pathname,
    "debug",
    "adm",
  );

const plan = (calls, answer = "Connector step complete.") =>
  `/faux ${JSON.stringify({ calls, answer })}`;

test(
  "running coding and bot agents gain, use, and lose installation MCP connector tools without being recreated",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-connectors-"));
    const fixture = await startMcpOAuthServer();
    const authority = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
    });
    await new Promise((resolve) =>
      authority.server.listen(0, "127.0.0.1", resolve),
    );
    const authorityUrl = `http://127.0.0.1:${authority.server.address().port}`;
    const tokenFile = join(directory, "lifecycle-token");
    await writeFile(tokenFile, "operator-lifecycle-token\n", { mode: 0o600 });
    // The real CLI, connected to the authority's admin routes as the
    // lifecycle controller proxies them. Its "browser" follows the printed
    // authorization URL and the redirect to the CLI's loopback callback.
    const adm = async (...args) => {
      const child = spawn(
        admBinary,
        [
          ...args,
          "--lifecycle-url",
          authorityUrl,
          "--lifecycle-token-file",
          tokenFile,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, "client", "config"),
            XDG_STATE_HOME: join(directory, "client", "state"),
            XDG_DATA_HOME: join(directory, "client", "data"),
          },
        },
      );
      let stdout = "";
      let stderr = "";
      const browser = [];
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const link = /^(http\S+authorize\S+)$/m.exec(stdout);
        if (link && !browser.length)
          browser.push(
            fixture
              .approve(link[1])
              .then((callback) => fetch(callback))
              .then((page) => page.text()),
          );
      });
      const [code] = await once(child, "exit");
      assert.equal(code, 0, `adm ${args.join(" ")}: ${stdout}${stderr}`);
      return { stdout, page: await browser[0] };
    };
    const signIn = async () => {
      const result = await adm("mcp", "login", "linear");
      assert.equal(result.page, "Signed in to linear. You can close this tab.");
      return result;
    };
    const lifecycle = await startPodLifecycle({ authorityUrl });
    const coding = await startPodRunner(directory, lifecycle, {
      id: "coding-agent",
      name: "coding agent",
      role: "coding",
    });
    const bot = await startPodRunner(directory, lifecycle, {
      id: "bot-agent",
      name: "supervisor",
      role: "bot",
    });
    t.after(async () => {
      await coding.stop();
      await bot.stop();
      await lifecycle.close();
      await authority.close();
      await fixture.close();
      await rm(directory, { recursive: true });
    });
    const mcpTools = async (agent) =>
      (await agent.request()).body.tools.filter((name) =>
        name.startsWith("mcp_"),
      );
    for (const agent of [coding, bot]) {
      assert.deepEqual(await mcpTools(agent), []);
      assert.deepEqual((await agent.request()).body.connectors, []);
    }

    const added = await adm("mcp", "add", "linear", fixture.url);
    assert.match(
      added.stdout,
      /Open this URL in your browser to sign in to linear/,
    );
    assert.match(
      added.stdout,
      /Signed in to linear\. Every ADM agent can use its tools: lookup, hang/,
    );
    assert.equal(added.page, "Signed in to linear. You can close this tab.");
    assert.match(
      (await adm("mcp", "list")).stdout,
      /linear\s+signed in\s+http/,
    );

    // Each already-running agent picks the connector up on its next turn.
    const lookups = {};
    for (const agent of [coding, bot]) {
      const accepted = await agent.request("/input", "POST", {
        message: plan([
          { tool: "mcp_linear_lookup", args: { query: `TASK-${agent.id}` } },
        ]),
        requestId: `lookup-${agent.id}`,
      });
      assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
      lookups[agent.id] = await agent.event(
        (event) =>
          event.kind === "tool" && event.data.name === "mcp_linear_lookup",
      );
      assert.equal(lookups[agent.id].data.isError, false);
      assert.match(
        lookups[agent.id].data.text,
        new RegExp(`issue TASK-${agent.id}: fixture backlog item`),
      );
      const status = (await agent.request()).body;
      assert.deepEqual(await mcpTools(agent), [
        "mcp_linear_lookup",
        "mcp_linear_hang",
      ]);
      assert.deepEqual(status.connectors, [
        { name: "linear", status: "connected", tools: 2 },
      ]);
      const runtime = (await agent.request("/runtime-status")).body;
      assert.deepEqual(runtime.connectors, [
        { name: "linear", status: "connected" },
      ]);
    }
    // Bot Code Mode scripts reach connector tools too.
    await bot.request("/input", "POST", {
      message: plan([
        {
          tool: "codemode",
          args: {
            code: 'return await tools.mcp_linear_lookup({ query: "from-code" })',
          },
        },
      ]),
      requestId: "code-mode-lookup",
    });
    const scripted = await bot.event(
      (event) => event.kind === "tool" && event.data.name === "codemode",
      lookups["bot-agent"].seq,
    );
    assert.equal(scripted.data.isError, false, scripted.data.text);
    assert.match(scripted.data.text, /issue from-code: fixture backlog item/);
    assert.ok(
      lifecycle.connectorRequests.some(
        (request) =>
          request.sourceId === "bot-agent" &&
          request.path === "/v1/runtime/connectors/token",
      ),
    );

    // Expired access tokens are refreshed by the authority, not the Pod.
    fixture.expireAccessTokens();
    await coding.request("/input", "POST", {
      message: plan([
        { tool: "mcp_linear_lookup", args: { query: "after-expiry" } },
      ]),
      requestId: "lookup-after-expiry",
    });
    const refreshed = await coding.event(
      (event) =>
        event.kind === "tool" &&
        event.data.name === "mcp_linear_lookup" &&
        event.data.text.includes("after-expiry"),
      lookups["coding-agent"].seq,
    );
    assert.equal(refreshed.data.isError, false);
    assert.ok(
      fixture.events.some(
        (event) => event.type === "token" && event.grant === "refresh_token",
      ),
    );

    // Aborting a turn cancels the in-flight MCP call.
    await bot.request("/input", "POST", {
      message: plan([{ tool: "mcp_linear_hang", args: {} }]),
      requestId: "hang",
    });
    while (!fixture.events.some((event) => event.tool === "hang"))
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await bot.request("/abort", "POST", {})).status, 200);
    const cancelled = await bot.event(
      (event) => event.kind === "tool" && event.data.name === "mcp_linear_hang",
      lookups["bot-agent"].seq,
    );
    assert.equal(cancelled.data.isError, true);
    assert.match(cancelled.data.text, /mcp_linear_hang was aborted/);
    assert.ok(
      fixture.events.some(
        (event) =>
          event.type === "notification" &&
          event.method === "notifications/cancelled",
      ),
    );

    // A revoked grant fails the next call visibly with the sign-in command.
    fixture.revokeGrant();
    await coding.request("/input", "POST", {
      message: plan([
        { tool: "mcp_linear_lookup", args: { query: "after-revoke" } },
      ]),
      requestId: "lookup-after-revoke",
    });
    const revoked = await coding.event(
      (event) =>
        event.kind === "tool" &&
        event.data.name === "mcp_linear_lookup" &&
        event.seq > refreshed.seq,
      refreshed.seq,
    );
    assert.equal(revoked.data.isError, true);
    assert.match(revoked.data.text, /needs sign-in: run adm mcp login linear/);
    await coding.request("/input", "POST", {
      message: "status check",
      requestId: "after-revoke-status",
    });
    assert.deepEqual(await mcpTools(coding), []);
    await coding.request("/input", "POST", {
      message: "/faux-inspect-system-prompt",
      requestId: "inspect-after-revoke",
    });
    const inspected = await coding.event(
      (event) =>
        event.kind === "assistant" &&
        event.data.text.includes("mcp-connectors"),
      revoked.seq,
    );
    // The agent itself is told which connector needs sign-in and how.
    assert.match(
      inspected.data.text,
      /linear: unavailable. MCP connector linear needs sign-in: run adm mcp login linear/,
    );
    assert.equal(
      (await coding.request()).body.connectors[0].status,
      "sign_in_required",
    );
    assert.match(
      (await coding.request("/runtime-status")).body.connectors[0].error,
      /adm mcp login linear/,
    );

    // Signing in again restores the tools for the running agent.
    await signIn();
    await coding.request("/input", "POST", {
      message: plan([{ tool: "mcp_linear_lookup", args: { query: "again" } }]),
      requestId: "lookup-again",
    });
    const again = await coding.event(
      (event) =>
        event.kind === "tool" &&
        event.data.name === "mcp_linear_lookup" &&
        event.data.text.includes("again"),
      revoked.seq,
    );
    assert.equal(again.data.isError, false);

    // Signing out takes the tools away from running agents.
    await adm("mcp", "logout", "linear");
    await bot.request("/input", "POST", {
      message: plan([{ tool: "mcp_linear_lookup", args: { query: "out" } }]),
      requestId: "lookup-signed-out",
    });
    const signedOut = await bot.event(
      (event) =>
        event.kind === "tool" &&
        event.data.name === "mcp_linear_lookup" &&
        event.seq > cancelled.seq,
      cancelled.seq,
    );
    assert.equal(signedOut.data.isError, true);
    assert.match(signedOut.data.text, /mcp_linear_lookup is not available/);
    assert.deepEqual(await mcpTools(bot), []);

    // Deleting a connected workspace closes its MCP session.
    await signIn();
    await coding.request("/input", "POST", {
      message: "reconnect",
      requestId: "reconnect",
    });
    assert.equal((await mcpTools(coding)).length, 2);
    // Delete between turns: deletion during a turn is a separate concern.
    await coding.event(
      (event) =>
        event.kind === "assistant" && event.data.text === "Echo: reconnect",
      again.seq,
    );
    const closedBefore = fixture.events.filter(
      (event) => event.type === "session-closed",
    ).length;
    const deleted = await coding.request("", "DELETE");
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.ok(
      fixture.events.filter((event) => event.type === "session-closed").length >
        closedBefore,
    );

    // Removing the connector removes it from the other running agent.
    assert.match(
      (await adm("mcp", "remove", "linear")).stdout,
      /Removed MCP connector linear/,
    );
    assert.match((await adm("mcp", "list")).stdout, /No MCP connectors/);
    await bot.request("/input", "POST", {
      message: "after removal",
      requestId: "after-removal",
    });
    assert.deepEqual(await mcpTools(bot), []);
    assert.deepEqual((await bot.request()).body.connectors, []);

    // No issued token reaches workspace files, configuration, or logs.
    const workspaceData = [
      await filesUnder(coding.directory),
      await filesUnder(bot.directory),
      coding.errors,
      bot.errors,
    ].join("\n");
    const issued = [
      ...fixture.accessTokens.keys(),
      ...fixture.refreshTokens.keys(),
      ...fixture.issuedTokens,
    ];
    assert.ok(issued.length > 0);
    for (const token of issued)
      assert.ok(!workspaceData.includes(token), token);
  },
);
