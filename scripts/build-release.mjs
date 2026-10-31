#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { build } from "esbuild";
import YAML from "yaml";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const platformName =
  process.platform === "darwin" ? "darwin" : process.platform;
if (
  !["linux", "darwin"].includes(platformName) ||
  !["x64", "arm64"].includes(process.arch)
)
  throw new Error(
    `Unsupported release platform: ${process.platform}/${process.arch}`,
  );
const platform = `${platformName}-${process.arch === "x64" ? "amd64" : "arm64"}`;
const { values } = parseArgs({
  options: Object.fromEntries(
    ["version", "control-image", "repositories-image", "workspace-image", "code-image", "bot-image", "adm", "repositories", "output"].map((name) => [
      name,
      { type: "string" },
    ]),
  ),
});
for (const name of ["version", "control-image", "repositories-image", "workspace-image", "code-image", "bot-image", "adm", "output"]) {
  if (!values[name]) throw new Error(`--${name} is required`);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(values.version))
  throw new Error("--version must be a release tag or build identifier");
for (const name of ["control-image", "repositories-image", "workspace-image", "code-image", "bot-image"])
  if (/\s/.test(values[name])) throw new Error(`--${name} must be a single image reference`);
const output = resolve(values.output);
const staging = await mkdtemp(join(tmpdir(), "adm-release-"));
try {
  await mkdir(join(staging, "bin"));
  const binaries = [[values.adm, "adm"]];
  if (values.repositories)
    binaries.push([values.repositories, "adm-repositories"]);
  else if (platform.startsWith("linux-"))
    throw new Error("Linux release packages require --repositories");
  for (const [source, name] of binaries) {
    const destination = join(staging, "bin", name);
    await copyFile(resolve(source), destination);
    await chmod(destination, 0o755);
  }
  for (const file of [
    "LICENSE",
    "package.json",
    "package-lock.json",
    "packages/runner/package.json",
    "packages/terminal/package.json",
    "scripts/patch-pi-interactive.mjs",
  ]) {
    const destination = join(staging, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(project, file), destination);
  }
  const lifecycleDirectory = join(staging, "deploy/lifecycle");
  await mkdir(lifecycleDirectory, { recursive: true });
  await copyFile(
    join(project, "deploy/lifecycle/kustomization.yaml"),
    join(lifecycleDirectory, "kustomization.yaml"),
  );
  const lifecycleResources = YAML.parseAllDocuments(
    await readFile(
      join(project, "deploy/lifecycle/control-plane.yaml"),
      "utf8",
    ),
    { version: "1.1" },
  ).map((document) => document.toJSON());
  const lifecyclePod = lifecycleResources.find(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.metadata.name === "adm-lifecycle",
  ).spec.template.spec;
  for (const container of [
    ...lifecyclePod.initContainers,
    ...lifecyclePod.containers,
  ]) {
    container.image = values["control-image"];
  }
  await writeFile(
    join(lifecycleDirectory, "control-plane.yaml"),
    lifecycleResources
      .map((resource) => YAML.stringify(resource))
      .join("---\n"),
  );
  await build({
    entryPoints: {
      runner: join(project, "packages/runner/src/main.ts"),
      "provider-auth": join(
        project,
        "packages/runner/src/provider-auth-main.ts",
      ),
      terminal: join(project, "packages/terminal/src/main.ts"),
      "shell-management": join(
        project,
        "packages/runner/src/shell-management.ts",
      ),
    },
    outdir: join(staging, "runtime"),
    outExtension: { ".js": ".mjs" },
    bundle: true,
    packages: "external",
    platform: "node",
    target: "node24",
    format: "esm",
  });
  // Preserve dependency-owned workers, WASM and native assets at their published paths.
  await execute(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: staging, maxBuffer: 1024 * 1024 },
  );
  await execute(
    process.execPath,
    [
      join(project, "scripts/patch-pi-interactive.mjs"),
      join(staging, "node_modules/@earendil-works/pi-coding-agent"),
    ],
    { cwd: project, maxBuffer: 1024 * 1024 },
  );
  await writeFile(join(staging, "VERSION"), values.version + "\n");
  for (const [filename, option] of [
    ["CONTROL_IMAGE", "control-image"],
    ["REPOSITORIES_IMAGE", "repositories-image"],
    ["WORKSPACE_IMAGE", "workspace-image"],
    ["CODE_IMAGE", "code-image"],
    ["BOT_IMAGE", "bot-image"],
  ]) await writeFile(join(staging, filename), values[option] + "\n");
  await mkdir(output, { recursive: true });
  const archive = `adm-${platform}.tar.gz`;
  await execute("tar", ["-czf", join(output, archive), "-C", staging, "."]);
  const binaryAssets = binaries.map(([source, name]) => [
    name,
    `${name}-${platform}`,
  ]);
  for (const [name, artifact] of binaryAssets)
    await copyFile(join(staging, "bin", name), join(output, artifact));
  await copyFile(join(staging, "LICENSE"), join(output, "LICENSE"));
  const sums = [];
  for (const name of [
    archive,
    "LICENSE",
    ...binaryAssets.map(([, artifact]) => artifact),
  ]) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(output, name)))
      hash.update(chunk);
    sums.push(`${hash.digest("hex")}  ${name}`);
  }
  await writeFile(join(output, "SHA256SUMS"), sums.join("\n") + "\n");
  console.log(join(output, archive));
} finally {
  await rm(staging, { recursive: true });
}
