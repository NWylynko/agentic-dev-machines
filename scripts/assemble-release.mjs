#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const platforms = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];
const args = process.argv.slice(2);
const dist = resolve(args[0] === "--dist" ? args[1] : "dist");
if (args.length > 2 || (args.length && args[0] !== "--dist"))
  throw new Error("Usage: assemble-release.mjs [--dist DIRECTORY]");
const output = join(dist, "release");
await mkdir(output, { recursive: true });
const assets = [];
for (const platform of platforms) {
  const directory = join(dist, `adm-${platform}`);
  const names = [`adm-${platform}.tar.gz`, `adm-${platform}`];
  if (platform.startsWith("linux-")) names.push(`adm-repositories-${platform}`);
  for (const name of names) {
    await readFile(join(directory, name));
    await copyFile(join(directory, name), join(output, name));
    assets.push(name);
  }
}
for (const name of ["install.sh", "LICENSE"]) {
  await readFile(join(dist, "adm-linux-amd64", name));
  await copyFile(join(dist, "adm-linux-amd64", name), join(output, name));
  assets.push(name);
}
const checksums = [];
for (const name of assets) {
  const hash = createHash("sha256").update(await readFile(join(output, name))).digest("hex");
  checksums.push(`${hash}  ${name}`);
}
await writeFile(join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);
