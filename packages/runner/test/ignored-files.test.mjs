// TASK-81: in a workspace with /repos, files git ignores live on node-local
// disk and are deleted when the Pod is replaced. Coding agents are told, so
// they reinstall dependencies and recreate .env rather than assume they persist.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPodLifecycle, startPodRunner } from "./pod-fixture.ts";
import { IGNORED_FILES_NOTE } from "../src/ignored-files.ts";

const systemPrompt = async (runner) => {
  await runner.request("/input", "POST", {
    message: "/faux-inspect-system-prompt",
    requestId: "inspect",
  });
  return (
    await runner.event(
      (event) =>
        event.kind === "assistant" && event.data.text.includes("sections"),
    )
  ).data.text;
};

test(
  "coding agents with /repos are told ignored files are wiped when the Pod is replaced; others are not",
  { timeout: 60000 },
  async (t) => {
    const holder = {};
    t.after(async () => {
      await holder.withRepos?.stop();
      await holder.plain?.stop();
      await holder.lifecycle?.close();
      holder.authority?.close();
      if (holder.directory) await rm(holder.directory, { recursive: true });
    });
    holder.directory = await mkdtemp(join(tmpdir(), "adm-ignored-files-"));
    holder.authority = createServer((request, response) =>
      response.writeHead(404, { "content-type": "application/json" }).end("{}"),
    ).listen(0, "127.0.0.1");
    await once(holder.authority, "listening");
    holder.lifecycle = await startPodLifecycle({
      authorityUrl: `http://127.0.0.1:${holder.authority.address().port}`,
    });
    holder.withRepos = await startPodRunner(
      holder.directory,
      holder.lifecycle,
      {
        id: "with-repos",
        name: "with repos",
        role: "coding",
        repositories: true,
      },
    );
    holder.plain = await startPodRunner(holder.directory, holder.lifecycle, {
      id: "plain",
      name: "plain",
      role: "coding",
    });
    assert.match(
      await systemPrompt(holder.withRepos),
      /git ignores[^]*deleted whenever this workspace's Pod is replaced/,
    );
    assert.doesNotMatch(await systemPrompt(holder.plain), /git ignores/);
  },
);

test("Claude Code gets the same note as Pi agents", async () => {
  const launcher = await readFile(
    new URL("../../../image/adm-claude", import.meta.url),
    "utf8",
  );
  assert.ok(
    launcher.includes(IGNORED_FILES_NOTE),
    "image/adm-claude's ignored-files note differs from packages/runner/src/ignored-files.ts",
  );
});
