#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const project = resolve(new URL("../", import.meta.url).pathname);
const dependency = join(
  project,
  "node_modules/@earendil-works/pi-coding-agent",
);
const temp = await mkdtemp(join(tmpdir(), "adm-pi-interactive-patch-"));
const copied = join(temp, "pi-coding-agent");
try {
  await cp(dependency, copied, { recursive: true });
  await symlink(join(project, "node_modules"), join(copied, "node_modules"));
  const patcher = join(project, "scripts/patch-pi-interactive.mjs");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(process.execPath, [patcher, copied], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `patch attempt ${attempt + 1} failed: ${result.stderr}`,
    );
  }
  const source = await readFile(
    join(copied, "dist/modes/interactive/interactive-mode.js"),
    "utf8",
  );
  assert.match(source, /remotePorts\?\.projectTrust/);
  assert.match(source, /authMetadata\.isAnthropicSubscription\(\)/);
  assert.match(source, /remotePorts\?\.isRemote \? \[undefined\]/);
  const remoteAuthBranch = source.match(
    /if \(this\.runtimeHost\.remotePorts\?\.authMetadata\) \{[\s\S]*?\n            }/,
  )?.[0];
  assert.ok(remoteAuthBranch);
  assert.doesNotMatch(remoteAuthBranch, /getAuth\(/);
  const declaration = await readFile(
    join(copied, "dist/modes/interactive/interactive-mode.d.ts"),
    "utf8",
  );
  assert.match(declaration, /RemoteInteractiveModeRuntime/);
  assert.match(declaration, /RemoteInteractiveModeSession/);
  assert.match(declaration, /InteractiveModeAuthMetadataPort/);
  assert.match(declaration, /isRemote: true/);
  assert.match(
    declaration,
    /constructor\(runtimeHost: AgentSessionRuntime \| RemoteInteractiveModeRuntime/,
  );
  const modulePath = join(copied, "dist/modes/interactive/interactive-mode.js");
  const typeFixture = join(temp, "remote-runtime.ts");
  await writeFile(
    typeFixture,
    `import { InteractiveMode } from ${JSON.stringify(modulePath)};\nimport { createThemeFromJson } from ${JSON.stringify(join(copied, "dist/index.js"))};\ntype Runtime = import(${JSON.stringify(modulePath)}).RemoteInteractiveModeRuntime;\ndeclare const runtime: Runtime;\nnew InteractiveMode(runtime);\nvoid createThemeFromJson;\n`,
  );
  const typeCheck = spawnSync(
    join(project, "node_modules/.bin/tsc"),
    [
      "--noEmit",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      typeFixture,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    typeCheck.status,
    0,
    `patched InteractiveMode remote runtime type failed: ${typeCheck.stdout}${typeCheck.stderr}`,
  );
  const adapterConfig = join(temp, "adapter-tsconfig.json");
  await writeFile(
    adapterConfig,
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        baseUrl: project,
        paths: {
          "@earendil-works/pi-coding-agent": [join(copied, "dist/index.d.ts")],
        },
      },
      files: [join(project, "packages/terminal/src/main.ts")],
    }),
  );
  const adapterCheck = spawnSync(
    join(project, "node_modules/.bin/tsc"),
    ["--noEmit", "--project", adapterConfig],
    { encoding: "utf8" },
  );
  assert.equal(
    adapterCheck.status,
    0,
    `Durable runtime does not satisfy patched InteractiveMode contract (status ${adapterCheck.status}, error ${adapterCheck.error?.message ?? "none"}): ${adapterCheck.stdout}${adapterCheck.stderr}`,
  );
  await import(pathToFileURL(join(copied, "dist/index.js")).href);
} finally {
  await rm(temp, { recursive: true });
}
