#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const binary = join(root, "target/debug/adm");
const kubectl = process.env.ADM_KUBECTL ?? "kubectl";
const enabled = process.env.ADM_LIVE_CLUSTER === "1";

async function lifecycleArgs() {
  const url = process.env.ADM_LIFECYCLE_URL;
  const tokenFile = process.env.ADM_LIFECYCLE_TOKEN_FILE;
  assert.ok(
    url,
    "ADM_LIVE_CLUSTER=1 requires ADM_LIFECYCLE_URL for the installed lifecycle API.",
  );
  assert.ok(
    tokenFile,
    "ADM_LIVE_CLUSTER=1 requires ADM_LIFECYCLE_TOKEN_FILE for the client credential.",
  );
  await access(tokenFile);
  return ["--lifecycle-url", url, "--lifecycle-token-file", tokenFile];
}

function run(file, args, { input, env = process.env, timeout = 180_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr };
      if (code === 0) resolveRun(result);
      else
        reject(
          new Error(
            `${file} ${args.join(" ")} failed (${signal ?? code}): ${stderr || stdout}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

async function adm(state, args, input) {
  return run(
    binary,
    [
      "--state-dir",
      state,
      "--kubectl",
      kubectl,
      ...(await lifecycleArgs()),
      ...args,
    ],
    { input },
  );
}

async function kubectlRun(args, input) {
  return run(kubectl, args, { input });
}

function json(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${output}`, {
      cause: error,
    });
  }
}

async function expectNamespaceAbsent(namespace) {
  try {
    const result = await kubectlRun([
      "get",
      "namespace",
      namespace,
      "-o",
      "json",
    ]);
    throw new Error(`Namespace ${namespace} still exists: ${result.stdout}`);
  } catch (error) {
    if (!/notfound|not found/i.test(error.message)) throw error;
  }
}

function pointManifestAtWorkspace(manifest, workspace) {
  const items = manifest.items;
  assert.ok(Array.isArray(items), "adm manifest must return a Kubernetes List");
  for (const item of items) {
    if (item.kind === "Namespace") item.metadata.name = workspace.namespace;
    if (item.metadata?.namespace) item.metadata.namespace = workspace.namespace;
    if (item.metadata?.labels?.["adm.dev/workspace-id"] !== undefined) {
      item.metadata.labels["adm.dev/workspace-id"] = workspace.id;
      item.metadata.labels["app.kubernetes.io/managed-by"] = "adm";
    }
    if (
      item.spec?.selector?.matchLabels?.["adm.dev/workspace-id"] !== undefined
    ) {
      item.spec.selector.matchLabels["adm.dev/workspace-id"] = workspace.id;
    }
    if (
      item.spec?.template?.metadata?.labels?.["adm.dev/workspace-id"] !==
      undefined
    ) {
      item.spec.template.metadata.labels["adm.dev/workspace-id"] = workspace.id;
    }
    if (
      item.spec?.podSelector?.matchLabels?.["adm.dev/workspace-id"] !==
      undefined
    ) {
      item.spec.podSelector.matchLabels["adm.dev/workspace-id"] = workspace.id;
    }
  }
  return manifest;
}

async function assertOwnedNamespace(workspace) {
  const namespace = json(
    (await kubectlRun(["get", "namespace", workspace.namespace, "-o", "json"]))
      .stdout,
    `namespace ${workspace.namespace}`,
  );
  assert.equal(
    namespace.metadata?.labels?.["app.kubernetes.io/managed-by"],
    "adm",
  );
  assert.equal(
    namespace.metadata?.labels?.["adm.dev/workspace-id"],
    workspace.id,
  );
  return namespace;
}

async function cleanupWorkspace(state, workspace) {
  try {
    await assertOwnedNamespace(workspace);
  } catch (error) {
    if (/notfound|not found/i.test(error.message)) return;
    throw error;
  }
  await adm(state, ["destroy", workspace.id]);
  await expectNamespaceAbsent(workspace.namespace);
}

if (!enabled) {
  process.stdout.write(
    "Cluster contract skipped; set ADM_LIVE_CLUSTER=1 to enable it.\n",
  );
} else {
  const state = await mkdtemp(join(tmpdir(), "adm-cluster-contract-state-"));
  const label = `cluster-contract-${randomBytes(4).toString("hex")}`;
  const space = `cluster-contract-space-${randomBytes(4).toString("hex")}`;
  const catalogPath = join(state, "catalog.json");
  const created = [];
  let failure;

  try {
    await writeFile(catalogPath, JSON.stringify({ repositories: [] }));

    const first = json(
      (await adm(state, ["create", label, "--role", "bot"])).stdout,
      "adm create bot",
    );
    created.push(first);
    assert.equal(first.role, "bot");
    assert.equal(first.agent_enabled, true);
    assert.equal(first.phase, "ready");
    await assertOwnedNamespace(first);

    const list = json(
      (await adm(state, ["list", "--json", "--all"])).stdout,
      "adm list --all",
    );
    assert.equal(list.length, 1);
    assert.equal(list[0].id, first.id);
    assert.equal(list[0].namespace, first.namespace);
    const status = json(
      (await adm(state, ["status", first.id, "--json"])).stdout,
      "adm status --json",
    );
    assert.equal(status.workspace.id, first.id);
    assert.equal(status.agent.status, "needs_model");

    const generated = json(
      (
        await adm(state, [
          "manifest",
          `${label}-contract`,
          "--catalog",
          catalogPath,
        ])
      ).stdout,
      "adm manifest --catalog",
    );
    const dryRun = pointManifestAtWorkspace(generated, first);
    const kinds = dryRun.items.map((item) => item.kind).sort();
    assert.deepEqual(kinds, [
      "ConfigMap",
      "Deployment",
      "Namespace",
      "NetworkPolicy",
      "PersistentVolumeClaim",
    ]);
    await kubectlRun(
      ["apply", "--dry-run=server", "-f", "-"],
      JSON.stringify(dryRun),
    );

    await adm(state, ["herdr", "bind", first.id, space]);
    const event =
      JSON.stringify({
        event: "workspace_closed",
        data: { type: "workspace_closed", workspace_id: space },
      }) + "\n";
    await adm(state, ["herdr", "events"], event);
    const afterClose = json(
      (await adm(state, ["list", "--json", "--all"])).stdout,
      "adm list after close",
    );
    assert.equal(
      afterClose.find((item) => item.id === first.id)?.phase,
      "deleted",
    );
    await expectNamespaceAbsent(first.namespace);

    const second = json(
      (await adm(state, ["create", label, "--role", "bot"])).stdout,
      "adm recreate bot label",
    );
    created.push(second);
    assert.equal(second.name, first.name);
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.namespace, first.namespace);
    await assertOwnedNamespace(second);

    const destroyed = json(
      (await adm(state, ["destroy", second.id])).stdout,
      "adm destroy recreated workspace",
    );
    assert.equal(destroyed.phase, "deleted");
    await expectNamespaceAbsent(second.namespace);
    process.stdout.write(
      `Cluster contract passed for ${first.id} and ${second.id}.\n`,
    );
  } catch (error) {
    failure = error;
  } finally {
    for (const workspace of created.reverse()) {
      try {
        await cleanupWorkspace(state, workspace);
      } catch (error) {
        failure = failure
          ? new AggregateError(
              [failure, error],
              "Cluster contract and cleanup both failed",
            )
          : error;
      }
    }
    await rm(state, { recursive: true });
  }

  if (failure) {
    process.stderr.write(
      `Cluster contract failed: ${failure.stack ?? failure}\n`,
    );
    process.exitCode = 1;
  }
}
