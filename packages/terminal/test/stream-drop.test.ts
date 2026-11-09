import test from "node:test";
import assert from "node:assert/strict";
import {
  attachThroughProxy,
  fauxPrompt,
  keepaliveMs,
  occurrences,
} from "./attach-harness.ts";
import { TERMINAL_TEST_TIMEOUT_MS } from "./wait-budget.ts";

const assistantText = (
  entry: import("@earendil-works/pi-durable").EntryRecord,
) => {
  const message = entry.model?.[0];
  return message?.role === "assistant"
    ? message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    : undefined;
};

test(
  "a native terminal whose event stream is killed mid-turn shows it is disconnected, reconnects on its own, and shows the gap once",
  { timeout: TERMINAL_TEST_TIMEOUT_MS },
  async (t) => {
    const attached = await attachThroughProxy(t, "stream-drop-killed");
    await attached.submit(fauxPrompt({ answer: "Reply before the drop" }));
    await attached.settledReply("Reply before the drop");

    const tool = await attached.blockingTool();
    const answered = attached.entry(
      (entry) => assistantText(entry) === "Reply sent while disconnected",
    );
    await attached.submit(
      fauxPrompt({
        calls: [{ tool: "bash", args: { command: tool.command } }],
        answer: "Reply sent while disconnected",
      }),
    );
    await tool.started;
    await attached.waitScreen("the running turn", (text) =>
      text.includes("Working"),
    );

    // The runner restarts: its stream is cut and reconnection fails until it
    // is back.
    attached.proxyControl.outage = true;
    attached.proxyControl.eventStreams.at(-1)!.response.destroy();
    const disconnected = await attached.waitScreen(
      "the disconnected state",
      (text) => text.includes("Ctrl+R to retry now"),
    );
    assert.match(
      disconnected,
      /Disconnected \(event stream failed: [^)]+\) · retrying every \d+s · Ctrl\+R to retry now · Connection unavailable/,
    );

    // The turn finishes while the terminal cannot see it.
    await tool.release("released-while-disconnected");
    await answered;
    attached.proxyControl.outage = false;

    const recovered = await attached.settledReply(
      "Reply sent while disconnected",
    );
    for (const text of [
      "Reply before the drop",
      "released-while-disconnected",
      "Reply\\u0020before\\u0020the\\u0020drop",
    ])
      assert.equal(occurrences(recovered, text), 1, recovered);

    // The recovered stream is live.
    await attached.submit(fauxPrompt({ answer: "Reply after recovering" }));
    await attached.settledReply("Reply after recovering");

    const drops = await attached.streamDrops();
    assert.equal(drops.length, 1, JSON.stringify(drops));
    assert.equal(drops[0].reason, "error");
    assert.equal(drops[0].workspaceId, "stream-drop-killed");
    assert.ok(Number.isSafeInteger(drops[0].upMs) && drops[0].upMs > 0);
    assert.match(
      attached.runnerErrors(),
      /"event":"workspace_events_closed"/,
      "the runner logs the stream it lost",
    );
  },
);

test(
  "a native terminal notices a silent half-open event stream within its keepalive deadline and reconnects",
  { timeout: TERMINAL_TEST_TIMEOUT_MS },
  async (t) => {
    const attached = await attachThroughProxy(t, "stream-drop-silent");
    await attached.submit(fauxPrompt({ answer: "Reply before the silence" }));
    await attached.settledReply("Reply before the silence");

    // The connection stays open but nothing more arrives on it.
    const silent = attached.proxyControl.eventStreams.at(-1)!;
    silent.incoming.unpipe(silent.response);
    silent.incoming.pause();
    const silencedAt = Date.now();

    // A prompt still reaches the agent; its reply appears once the terminal
    // has noticed the silence and reconnected.
    await attached.submit(
      fauxPrompt({ answer: "Reply after a silent stream" }),
    );
    const recovered = await attached.settledReply(
      "Reply after a silent stream",
    );
    assert.equal(occurrences(recovered, "Reply before the silence"), 1);
    assert.ok(
      silent.response.destroyed,
      "the terminal closed the silent stream",
    );

    const drops = await attached.streamDrops();
    assert.equal(drops.length, 1, JSON.stringify(drops));
    assert.equal(drops[0].reason, "silence");
    assert.ok(drops[0].upMs > 0);
    assert.ok(
      Date.parse(drops[0].at) - silencedAt < 10 * keepaliveMs,
      `silence detected within a bounded time: ${JSON.stringify(drops[0])}`,
    );
  },
);
