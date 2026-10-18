import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failLifecycleAvailability,
  restoreLifecycleAvailability,
  suspendLifecycleAvailability,
  waitForLifecycleAvailability,
} from "../src/lifecycle-availability.ts";

test("a canceled availability waiter is removed and does not reopen later", async () => {
  restoreLifecycleAvailability();
  suspendLifecycleAvailability(new Error("controller down"));
  const controller = new AbortController();
  const waiting = waitForLifecycleAvailability(controller.signal);
  controller.abort(new DOMException("client disconnected", "AbortError"));
  await assert.rejects(waiting, { name: "AbortError" });
  restoreLifecycleAvailability();
  await waitForLifecycleAvailability();
});

test("terminal fencing rejects waiters without leaving rejected shared promises", async () => {
  restoreLifecycleAvailability();
  suspendLifecycleAvailability(new Error("controller down"));
  const waiting = waitForLifecycleAvailability();
  const fence = new Error("runtime lease expired");
  failLifecycleAvailability(fence);
  await assert.rejects(waiting, fence);
  await assert.rejects(waitForLifecycleAvailability(), fence);
});
