// Fake Anthropic API for the Claude Code TUI-driving spike (TASK-141/142).
//   node tui-fake-api.mjs PORT LOGFILE      (standalone, for poking by hand)
//   import { startTuiFake } from "./tui-fake-api.mjs"
// Replies "ECHO: <last user text>". A prompt containing HOLD streams
// "working... " and then holds the stream open until release() (or GET
// /release). A prompt containing TOOL:<command> gets one Bash tool call.
// Every /v1/messages request is kept in `requests` (and appended to LOGFILE).
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Claude Code 2.1.326 ends `messages` with a role "system" environment block,
// so the newest input is the last *user* message.
const lastUserBlocks = (body) => {
  const message = body.messages.findLast((m) => m.role === "user");
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
};
const texts = (blocks) =>
  blocks
    .filter((b) => b.type === "text" && !b.text.startsWith("<system-reminder>"))
    .map((b) => b.text)
    .join(" | ");

export function startTuiFake({ log } = {}) {
  const requests = [];
  const listeners = new Set();
  let held = [];
  const note = (entry) => {
    const line = { at: new Date().toISOString(), ...entry };
    requests.push(line);
    if (log) appendFileSync(log, JSON.stringify(line) + "\n");
    listeners.forEach((listener) => listener(line));
  };
  const release = () => {
    const waiting = held;
    held = [];
    waiting.forEach((resolve) => resolve());
    return waiting.length;
  };
  // Resolves with the first request (already seen or future) matching `test`.
  const waitFor = (test) =>
    new Promise((resolve) => {
      const seen = requests.find(test);
      if (seen) return resolve(seen);
      const listener = (line) => test(line) && (listeners.delete(listener), resolve(line));
      listeners.add(listener);
    });
  const server = createServer(async (req, res) => {
    if (req.url === "/release") return res.end(`released ${release()}\n`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    // Claude Code hooks report here too (curl -d @- .../hook), so hook events
    // and model requests land in one ordered stream.
    if (req.url === "/hook") {
      const input = JSON.parse(raw);
      note({ hook: input.hook_event_name, input });
      return res.end("{}");
    }
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) return res.writeHead(404).end();
    const body = JSON.parse(raw);
    const blocks = lastUserBlocks(body);
    const text = texts(blocks);
    const afterTool = blocks.some((b) => b.type === "tool_result");
    // A request carrying a tool result continues a turn (a mid-turn message
    // may ride along with it): it never asks for TOOL/HOLD/ASK.
    const fresh = afterTool ? "" : text;
    note({ stream: !!body.stream, messages: body.messages.length, roles: body.messages.map((m) => m.role[0]).join(""), afterTool, text });
    const reply = `ECHO: ${text}`;
    const start = { id: `msg_fake_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ...start, content: [{ type: "text", text: reply }], stop_reason: "end_turn" }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const finish = (stop_reason) => {
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
      event("message_stop", {});
      res.end();
    };
    event("message_start", { message: start });
    const bash = fresh.match(/TOOL:(.*)$/m);
    const ask = fresh.includes("ASK");
    if (bash || ask) {
      const [name, input] = bash
        ? ["Bash", { command: bash[1], description: "spike tool call" }]
        : ["AskUserQuestion", { questions: [{ question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "red" }, { label: "Blue", description: "blue" }] }] }];
      event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${requests.length}`, name, input: {} } });
      event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      return finish("tool_use");
    }
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    if (fresh.includes("HOLD")) {
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "working... " } });
      const closed = new Promise((resolve) => res.on("close", resolve));
      await Promise.race([new Promise((resolve) => held.push(resolve)), closed]);
      if (res.destroyed) return note({ aborted: text });
    }
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
    finish("end_turn");
  });
  return { server, requests, release, waitFor };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [port, log] = process.argv.slice(2);
  startTuiFake({ log }).server.listen(+port, "127.0.0.1", () => console.log(`fake on ${port}`));
}
