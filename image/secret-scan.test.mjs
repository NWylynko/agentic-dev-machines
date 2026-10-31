import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanCredentialArtifacts } from "./scan-secrets.mjs";

test("credential scan rejects a fixture image with a planted dotenv file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "adm-image-secret-scan-"));
  t.after(() => rm(root, { recursive: true }));
  await mkdir(join(root, "etc", "adm"), { recursive: true });
  await writeFile(join(root, "etc", "adm", ".env"), "EXAMPLE=value\n");
  assert.match((await scanCredentialArtifacts(root)).join("\n"), /\.env: credential-shaped filename/);
});
