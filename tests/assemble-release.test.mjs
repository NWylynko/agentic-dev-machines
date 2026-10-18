import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = resolve("scripts/assemble-release.mjs");
const platforms = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];

test("release assembly requires and checksums every native client asset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adm-release-assembly-"));
  t.after(() => rm(directory, { recursive: true }));
  for (const platform of platforms) {
    const path = join(directory, `adm-${platform}`);
    await mkdir(path);
    for (const name of [`adm-${platform}.tar.gz`, `adm-${platform}`, ...(platform.startsWith("linux-") ? [`adm-repositories-${platform}`] : [])])
      await writeFile(join(path, name), `${platform}:${name}`);
  }
  await writeFile(join(directory, "adm-linux-amd64/install.sh"), "installer");
  await writeFile(join(directory, "adm-linux-amd64/LICENSE"), "license");
  await execute(process.execPath, [script, "--dist", directory]);
  const output = join(directory, "release"), sums = await readFile(join(output, "SHA256SUMS"), "utf8");
  for (const platform of platforms) {
    const name = `adm-${platform}.tar.gz`;
    const hash = createHash("sha256").update(await readFile(join(output, name))).digest("hex");
    assert.ok(sums.includes(`${hash}  ${name}\n`));
  }
  await rm(join(directory, "adm-darwin-arm64/adm-darwin-arm64"));
  await assert.rejects(execute(process.execPath, [script, "--dist", directory]));
});
