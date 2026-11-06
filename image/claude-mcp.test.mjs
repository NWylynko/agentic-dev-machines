// Claude Code in a workspace Pod gets the installation MCP connectors
// (TASK-90): `adm-claude-mcp config` writes Claude's MCP config from the
// token-free runtime catalog, and Claude's `headersHelper` runs
// `adm-claude-mcp headers` for a short-lived token per connection, so the Pod
// never holds a connector grant. Drives the real `claude` binary against a fake
// Anthropic API that asks for one fixture tool call.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProviderAuthAuthority } from "../packages/runner/src/provider-auth-authority.ts";
import {
  signInConnector,
  startMcpOAuthServer,
} from "../packages/runner/test/mcp-oauth-fixture.ts";

const helper = new URL("./adm-claude-mcp", import.meta.url).pathname;
const claude = await promisify(execFile)("sh", ["-c", "command -v claude"])
  .then(({ stdout }) => stdout.trim())
  .catch(() => "");

// A fake Anthropic Messages API: while the fixture tool has not answered, the
// model calls it; once a tool_result comes back, it records it and finishes.
function startFakeModel() {
  const results = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (!request.url.startsWith("/v1/messages") || request.url.includes("count_tokens"))
      return response.writeHead(404).end();
    const body = JSON.parse(raw);
    const last = body.messages.at(-1);
    const toolResult = Array.isArray(last?.content)
      ? last.content.find((part) => part.type === "tool_result")
      : undefined;
    if (toolResult) results.push(toolResult);
    const wantsTool =
      !toolResult && body.tools?.some((tool) => tool.name === "mcp__fixture__lookup");
    const content = wantsTool
      ? [{ type: "tool_use", id: "toolu_fixture", name: "mcp__fixture__lookup", input: { query: "ADM-1" } }]
      : [{ type: "text", text: "done" }];
    const message = {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: wantsTool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify(message));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { ...message, content: [], stop_reason: null } });
    content.forEach((block, index) => {
      if (block.type === "text") {
        event("content_block_start", { index, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
      } else {
        event("content_block_start", { index, content_block: { ...block, input: {} } });
        event("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        });
      }
      event("content_block_stop", { index });
    });
    event("message_delta", {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    event("message_stop", {});
    response.end();
  });
  return { server, results };
}

function run(command, args, env, cwd) {
  const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
}

test(
  "Claude Code lists and calls an installation connector tool through short-lived tokens, and loses it on remove",
  { timeout: 120000, skip: claude ? false : "claude is not on PATH" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-claude-mcp-"));
    const fixture = await startMcpOAuthServer();
    const authority = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
    });
    const model = startFakeModel();
    t.after(async () => {
      authority.server.closeAllConnections();
      model.server.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => authority.server.close(resolve)),
        new Promise((resolve) => model.server.close(resolve)),
        fixture.close(),
      ]);
      await rm(directory, { recursive: true });
    });
    await new Promise((resolve) => authority.server.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => model.server.listen(0, "127.0.0.1", resolve));
    const authorityUrl = `http://127.0.0.1:${authority.server.address().port}`;
    const admin = (method, path, body) =>
      fetch(authorityUrl + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body && JSON.stringify(body),
      }).then(async (response) => {
        assert.ok(response.ok, `${method} ${path}: ${await response.text()}`);
      });
    await admin("POST", "/v1/connectors", { name: "fixture", url: fixture.url });
    await signInConnector(authorityUrl, fixture, "fixture");

    const identity = join(directory, "identity-token");
    await writeFile(identity, "pod-identity\n");
    const config = join(directory, "mcp.json");
    const env = {
      // headersHelper runs `adm-claude-mcp`, installed in /usr/local/bin in the image.
      PATH: `${dirname(helper)}:${process.env.PATH}`,
      HOME: directory,
      ADM_LIFECYCLE_URL: authorityUrl,
      ADM_LIFECYCLE_TOKEN_FILE: identity,
      CLAUDE_CONFIG_DIR: join(directory, "claude"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.server.address().port}`,
      ANTHROPIC_API_KEY: "sk-ant-fixture",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      // Offer MCP tools directly instead of behind ToolSearch.
      ENABLE_TOOL_SEARCH: "false",
    };

    const written = await run(helper, ["config", config], env, directory);
    assert.equal(written.code, 0, written.stderr);
    const text = await readFile(config, "utf8");
    for (const secret of fixture.issuedTokens)
      assert.ok(!text.includes(secret), "the config holds no connector token");
    assert.deepEqual(Object.keys(JSON.parse(text).mcpServers), ["fixture"]);

    const ask = () =>
      run(
        claude,
        [
          "-p",
          "look up ADM-1",
          "--mcp-config",
          config,
          "--strict-mcp-config",
          "--allowedTools",
          "mcp__fixture__lookup",
        ],
        env,
        directory,
      );
    const first = await ask();
    assert.equal(first.code, 0, first.stderr + first.stdout);
    assert.deepEqual(
      fixture.events.filter((event) => event.type === "call").map((event) => event.tool),
      ["lookup"],
    );
    assert.match(JSON.stringify(model.results[0]), /issue ADM-1: fixture backlog item/);

    await admin("DELETE", "/v1/connectors/fixture");
    model.results.length = 0;
    const second = await ask();
    assert.equal(
      fixture.events.filter((event) => event.type === "call").length,
      1,
      "a removed connector is never called again",
    );
    assert.ok(
      !JSON.stringify(model.results).includes("fixture backlog item"),
      `${JSON.stringify(model.results)}\n${second.stderr}`,
    );
  },
);
