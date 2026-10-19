import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceBehaviorSettings } from "../src/workspace-settings.ts";

test("workspace behavior settings recheck authority before publishing the file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-settings-fence-"));
  t.after(() => rm(directory, { recursive: true }));
  const settings = await WorkspaceBehaviorSettings.open(directory, async () => {
    throw new Error("lease expired");
  });
  await assert.rejects(
    settings.update({ autoCompact: false }),
    /lease expired/,
  );
  assert.equal(settings.current.autoCompact, true);
  await assert.rejects(readFile(join(directory, "adm-settings.json")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(directory), []);
});
