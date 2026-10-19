import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { DurableInteractiveRuntime } from "../src/native-runtime.ts";
import { WorkspaceTerminal } from "../src/terminal.ts";

test(
  "native exports preserve the Durable transcript and bot public-message boundary",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-native-export-"));
    const child = spawn(
      process.execPath,
      [
        new URL("../../runner/src/main.ts", import.meta.url).pathname,
        "--port",
        "0",
        "--state-dir",
        join(directory, "state"),
        "--provider",
        "faux",
        "--model",
        "faux-1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: directory },
      },
    );
    const exited = once(child, "exit");
    const lines = createInterface({ input: child.stdout });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      lines.close();
      await rm(directory, { recursive: true });
    });
    const url = await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Runner exited ${code}: ${errors}`)),
      );
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.ready) resolve(event.url);
        } catch {}
      });
    });
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.ok(
        response.ok,
        `${method} ${path}: ${response.status} ${await response.clone().text()}`,
      );
      return response.json();
    };
    for (const role of ["coding", "bot"] as const) {
      const id = `export-${role}`;
      const path = `/v1/workspaces/${id}`;
      await request(path, "PUT", {
        id,
        name: id,
        role,
        environment: "local",
        ...(role === "coding" ? { localRoot: join(directory, "repo") } : {}),
        model: { provider: "faux", id: "faux-1" },
      });
      const controller = new AbortController();
      const events = await fetch(url + path + "/events?diagnostics=true", {
        signal: controller.signal,
      });
      const reader = events.body!.getReader();
      const answer =
        role === "bot" ? "PRIVATE_BOT_REASONING" : "Coding export answer";
      const message =
        "/faux " +
        JSON.stringify({
          calls:
            role === "bot"
              ? [{ tool: "sendMessage", args: { text: "PUBLIC_BOT_MESSAGE" } }]
              : [
                  {
                    tool: "bash",
                    args: { command: "printf CODING_TOOL_OUTPUT" },
                  },
                ],
          answer,
        });
      await request(path + "/input", "POST", {
        message,
        requestId: `export-${role}-turn`,
      });
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        finished: for (;;) {
          const part = await reader.read();
          assert.equal(part.done, false);
          buffer += decoder.decode(part.value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trimEnd();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6));
            if (event.kind === "assistant" && event.data.text === answer)
              break finished;
          }
        }
      } finally {
        controller.abort();
        await reader.cancel().catch(() => {});
      }
      const transport = new WorkspaceTerminal({
        url,
        workspaceId: id,
        diagnostics: true,
      });
      const runtime = new DurableInteractiveRuntime(transport);
      try {
        await transport.connect();
        await runtime.initialize();
        const session = runtime.sessionProjection();
        const jsonl = join(directory, `${role}.jsonl`);
        assert.equal(await session.exportToJsonl(jsonl), jsonl);
        const records = (await readFile(jsonl, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(records[0].type, "session");
        assert.equal(records[0].version, 3);
        assert.equal(records[0].id, session.sessionId);
        assert.ok(records.some((entry) => entry.type === "message"));
        const html = join(directory, `${role}.html`);
        assert.equal(await session.exportToHtml(html), html);
        assert.equal((await stat(jsonl)).mode & 0o777, 0o600);
        assert.equal((await stat(html)).mode & 0o777, 0o600);
        const page = await readFile(html, "utf8");
        assert.match(page, /<!doctype html>/i);
        const encoded =
          /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(
            page,
          )?.[1];
        assert.ok(encoded, "Pi HTML export embeds its native session data");
        const data = JSON.parse(
          Buffer.from(encoded, "base64").toString("utf8"),
        );
        const transcript = JSON.stringify({ records, data });
        if (role === "bot") {
          assert.match(transcript, /PUBLIC_BOT_MESSAGE/);
          assert.ok(
            !records.some((entry) => entry.message?.role === "assistant"),
          );
          assert.ok(
            !data.entries.some(
              (entry: { message?: { role?: string } }) =>
                entry.message?.role === "assistant",
            ),
          );
        } else {
          assert.match(transcript, /CODING_TOOL_OUTPUT/);
          assert.match(transcript, /Coding export answer/);
        }
      } finally {
        await runtime.dispose();
        transport.close();
      }
    }
  },
);
