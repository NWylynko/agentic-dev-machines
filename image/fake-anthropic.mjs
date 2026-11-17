// A fake Anthropic Messages API for driving the real `claude` binary in tests.
// `respond(body)` returns the content blocks of the reply; every request body
// is kept in `requests`, so a test can assert exactly what Claude sent.
import { createServer } from "node:http";

export function startFakeAnthropic(respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (!request.url.startsWith("/v1/messages") || request.url.includes("count_tokens"))
      return response.writeHead(404).end();
    const body = JSON.parse(raw);
    requests.push(body);
    const content = respond(body);
    const wantsTool = content.some((block) => block.type === "tool_use");
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
  return { server, requests };
}
