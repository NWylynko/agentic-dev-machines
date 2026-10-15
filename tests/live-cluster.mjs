import assert from "node:assert/strict";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const enabled = process.env.ADM_LIVE_CLUSTER === "1";

function requiredImage() {
  const image = process.env.ADM_LIVE_IMAGE;
  assert.ok(
    image,
    "Set ADM_LIVE_IMAGE to a tagged image imported into every schedulable Kubernetes node.",
  );
  return image;
}

function imageAliases(reference) {
  const slash = reference.lastIndexOf("/");
  const hasTag = reference.includes("@") || reference.indexOf(":") > slash;
  const tagged = hasTag ? reference : reference + ":latest";
  const first = tagged.split("/", 1)[0];
  const normalized = !tagged.includes("/")
    ? "docker.io/library/" + tagged
    : first.includes(".") || first.includes(":") || first === "localhost"
      ? tagged
      : "docker.io/" + tagged;
  return new Set([
    reference,
    tagged,
    normalized,
    normalized.replace(/^docker\.io\//, "index.docker.io/"),
  ]);
}

async function run(file, args, timeout = 60_000) {
  try {
    return await execFile(file, args, {
      cwd: root,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
  } catch (error) {
    const output = (error.stderr || error.stdout || error.message).trim();
    throw new Error(file + " " + args.join(" ") + " failed: " + output, {
      cause: error,
    });
  }
}

function json(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(label + " returned invalid JSON: " + output, {
      cause: error,
    });
  }
}

function name() {
  return "adm-live-" + randomBytes(5).toString("hex");
}

async function adm(binary, state, kubectl, args) {
  return run(
    binary,
    ["--state-dir", state, "--kubectl", kubectl, ...args],
    300_000,
  );
}

async function k(binary, args) {
  return run(binary, args, 180_000);
}

function notFound(error) {
  return /notfound|not found/i.test(error.message);
}

async function checkImageCache(kubectl, image) {
  const nodes = json(
    (await k(kubectl, ["get", "nodes", "-o", "json"])).stdout,
    "kubectl get nodes",
  ).items;
  const candidates = nodes.filter((node) => {
    if (node.spec?.unschedulable) return false;
    if (
      node.status?.conditions?.some(
        (condition) =>
          condition.type === "Ready" && condition.status !== "True",
      )
    )
      return false;
    return !node.spec?.taints?.some(
      (taint) => taint.effect === "NoSchedule" || taint.effect === "NoExecute",
    );
  });
  assert.ok(
    candidates.length,
    "No Ready schedulable Kubernetes nodes were found.",
  );
  const aliases = imageAliases(image);
  const missing = candidates
    .filter((node) => {
      const names = new Set(
        (node.status?.images ?? []).flatMap((entry) => entry.names ?? []),
      );
      return ![...aliases].some((entry) => names.has(entry));
    })
    .map((node) => node.metadata.name);
  assert.deepEqual(
    missing,
    [],
    "Image " +
      image +
      " is missing from schedulable node caches: " +
      missing.join(", ") +
      ". Import this exact image into each node's k3s containerd, then rerun with ADM_LIVE_IMAGE=" +
      image +
      ". This test does not install privileged node helpers or transfer images.",
  );
}

async function assertNamespaceOwned(kubectl, namespace, id) {
  const object = json(
    (await k(kubectl, ["get", "namespace", namespace, "-o", "json"])).stdout,
    "namespace " + namespace,
  );
  assert.equal(
    object.metadata?.labels?.["app.kubernetes.io/managed-by"],
    "adm",
    "Namespace is not marked as adm-owned.",
  );
  assert.equal(
    object.metadata?.labels?.["adm.dev/workspace-id"],
    id,
    "Namespace has a different immutable workspace ID.",
  );
}

async function pods(kubectl, namespace, id) {
  const items = json(
    (
      await k(kubectl, [
        "get",
        "pods",
        "-n",
        namespace,
        "-l",
        "adm.dev/workspace-id=" + id,
        "-o",
        "json",
      ])
    ).stdout,
    "workspace Pods",
  ).items;
  assert.equal(
    items.length,
    1,
    "Expected one workspace Pod, found " + items.length,
  );
  return items[0];
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function startForward(binary, state, kubectl, workspace, localPort) {
  const child = spawn(
    binary,
    [
      "--state-dir",
      state,
      "--kubectl",
      kubectl,
      "port",
      workspace,
      "43117",
      "--local-port",
      String(localPort),
    ],
    {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  child.output = "";
  child.exitCode = null;
  child.stdout.setEncoding("utf8").on("data", (data) => {
    child.output += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    child.output += data;
  });
  child.once("exit", (code) => {
    child.exitCode = code;
  });
  return child;
}

async function stopForward(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(5000),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function preview(binary, state, kubectl, workspace, children) {
  const localPort = await reservePort();
  const child = startForward(binary, state, kubectl, workspace, localPort);
  children.add(child);
  const url = "http://127.0.0.1:" + localPort;
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        "adm port exited with " + child.exitCode + ": " + child.output.trim(),
      );
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { child, body: await response.text() };
      lastError = new Error("HTTP " + response.status);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(
    "Preview did not become available at " + url + ": " + lastError,
  );
}

function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function startHttp(binary, state, kubectl, workspace, marker) {
  const source =
    "require('node:http').createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>" +
    marker +
    "</title><h1>" +
    marker +
    "</h1>')}).listen(43117,'0.0.0.0')";
  await adm(binary, state, kubectl, [
    "exec",
    workspace,
    "--",
    "bash",
    "-lc",
    "nohup node -e " +
      quote(source) +
      " >/tmp/" +
      workspace +
      "-http.log 2>&1 </dev/null & echo $!",
  ]);
}

async function cleanup(binary, state, kubectl, workspaceName, id) {
  if (!id) return;
  const entries = json(
    (await adm(binary, state, kubectl, ["list", "--json", "--all"])).stdout,
    "adm list --all",
  );
  const entry = entries.find(
    (item) => item.id === id && item.name === workspaceName,
  );
  if (!entry || entry.phase === "deleted") return;
  try {
    await assertNamespaceOwned(kubectl, entry.namespace, id);
  } catch (error) {
    if (!notFound(error)) throw error;
  }
  await adm(binary, state, kubectl, ["destroy", id]);
}

test(
  "real CLI preserves a workspace across Pod replacement and restores preview routing",
  {
    skip: !enabled
      ? "Set ADM_LIVE_CLUSTER=1 to create and destroy uniquely owned Kubernetes resources."
      : false,
  },
  async (t) => {
    const image = requiredImage();
    const binary = resolve(
      process.env.ADM_BIN || join(root, "target/debug/adm"),
    );
    const kubectl = process.env.ADM_KUBECTL || "kubectl";
    await checkImageCache(kubectl, image);
    const state = await mkdtemp(join(tmpdir(), "adm-live-state-"));
    const workspace = name();
    const active = [];
    const children = new Set();
    const createArgs = [
      "create",
      workspace,
      "--image",
      image,
      "--storage-class",
      "local-path",
      "--storage-size",
      "1Gi",
      "--cpu",
      "1",
      "--memory",
      "1Gi",
      "--allow-node-local-storage",
      "--no-agent",
      "--no-repositories",
    ];
    const createTracked = async () => {
      try {
        const created = json(
          (await adm(binary, state, kubectl, createArgs)).stdout,
          "adm create",
        );
        active.push(created.id);
        return created;
      } catch (error) {
        const entries = json(
          (await adm(binary, state, kubectl, ["list", "--json", "--all"])).stdout,
          "adm list --all after failed create",
        );
        const partial = entries.find(
          (entry) => entry.name === workspace && entry.phase !== "deleted",
        );
        if (partial && !active.includes(partial.id)) active.push(partial.id);
        throw error;
      }
    };

    t.after(async () => {
      for (const child of children) await stopForward(child);
      for (const id of active.reverse())
        await cleanup(binary, state, kubectl, workspace, id);
      await rm(state, { recursive: true });
    });

    const created = await createTracked();
    assert.equal(created.phase, "ready");
    const namespace = created.namespace;
    const firstPod = await pods(kubectl, namespace, created.id);
    const oldPod = firstPod.metadata.name;
    const oldNode = firstPod.spec.nodeName;
    assert.ok(oldNode, "Workspace Pod is not scheduled.");
    assert.equal(firstPod.spec.automountServiceAccountToken, false);
    assert.equal(firstPod.status.phase, "Running");
    assert.ok(
      firstPod.status.conditions?.some(
        (condition) =>
          condition.type === "Ready" && condition.status === "True",
      ),
    );
    await assertNamespaceOwned(kubectl, namespace, created.id);

    const claims = json(
      (await k(kubectl, ["get", "pvc", "-n", namespace, "-o", "json"])).stdout,
      "workspace PVCs",
    ).items;
    assert.ok(
      claims.some(
        (claim) =>
          claim.metadata?.labels?.["adm.dev/workspace-id"] === created.id &&
          claim.status?.phase === "Bound",
      ),
      "Workspace PVC must be bound before persistence checks.",
    );

    const repo = "/workspace/.adm/live-" + workspace;
    const gitCommand = [
      "set -eu",
      "mkdir -p " + repo,
      "git -C " + repo + " init -q",
      "git -C " + repo + " config user.name 'ADM live test'",
      "git -C " + repo + " config user.email 'adm-live-test@example.invalid'",
      "printf '%s\\n' " + workspace + " > " + repo + "/tracked.txt",
      "git -C " + repo + " add tracked.txt",
      "git -C " + repo + " commit -qm 'persist live fixture'",
      "printf '%s\\n' " + created.id + " > " + repo + "/untracked.txt",
      "git -C " + repo + " rev-parse HEAD",
    ].join(" && ");
    const head = (
      await adm(binary, state, kubectl, [
        "exec",
        workspace,
        "--",
        "bash",
        "-lc",
        gitCommand,
      ])
    ).stdout.trim();
    assert.match(head, /^[a-f0-9]{40}$/);

    const marker = "ADM_LIVE_PREVIEW_" + workspace;
    await startHttp(binary, state, kubectl, workspace, marker);
    const before = await preview(binary, state, kubectl, workspace, children);
    assert.ok(before.body.includes(marker));
    const browser = await adm(binary, state, kubectl, [
      "browser",
      workspace,
      "http://127.0.0.1:43117",
    ]);
    assert.ok(
      browser.stdout.includes(marker),
      "Chromium did not render the fixture page.",
    );
    await stopForward(before.child);
    children.delete(before.child);

    await assertNamespaceOwned(kubectl, namespace, created.id);
    const beforeDelete = await pods(kubectl, namespace, created.id);
    assert.equal(beforeDelete.metadata.name, oldPod);
    await k(kubectl, [
      "delete",
      "pod",
      oldPod,
      "-n",
      namespace,
      "--wait=true",
      "--timeout=90s",
    ]);
    await k(kubectl, [
      "wait",
      "--for=condition=available",
      "deployment/workspace",
      "-n",
      namespace,
      "--timeout=180s",
    ]);

    const replacement = await pods(kubectl, namespace, created.id);
    assert.notEqual(replacement.metadata.name, oldPod);
    assert.equal(
      replacement.spec.nodeName,
      oldNode,
      "Local-path volume should pin replacement to its original node.",
    );
    assert.equal(replacement.status.phase, "Running");
    const checkGit = [
      "set -eu",
      'test "$(cat ' + repo + '/untracked.txt)" = ' + created.id,
      'test "$(git -C ' + repo + ' rev-parse HEAD)" = ' + head,
      "git -C " + repo + " status --porcelain --untracked-files=all",
    ].join(" && ");
    const afterGit = (
      await adm(binary, state, kubectl, [
        "exec",
        workspace,
        "--",
        "bash",
        "-lc",
        checkGit,
      ])
    ).stdout;
    assert.match(afterGit, /\\?\\? untracked\\.txt/);

    await startHttp(binary, state, kubectl, workspace, marker);
    const after = await preview(binary, state, kubectl, workspace, children);
    assert.ok(
      after.body.includes(marker),
      "Forwarded preview did not reach the replacement Pod.",
    );
    await stopForward(after.child);
    children.delete(after.child);

    const status = json(
      (await adm(binary, state, kubectl, ["status", workspace, "--json"])).stdout,
      "adm status --json",
    );
    assert.equal(status.cluster.pods[0].spec.nodeName, oldNode);

    const deleted = json(
      (await adm(binary, state, kubectl, ["destroy", created.id])).stdout,
      "adm destroy",
    );
    assert.equal(deleted.phase, "deleted");
    active.splice(active.indexOf(created.id), 1);
    await assert.rejects(
      k(kubectl, ["get", "namespace", namespace, "-o", "json"]),
      notFound,
      "Destroy must remove the owned namespace and its private PVC.",
    );

    const reused = await createTracked();
    assert.equal(reused.phase, "ready");
    assert.notEqual(
      reused.id,
      created.id,
      "Reusing a label must receive a fresh identity.",
    );
    assert.notEqual(reused.namespace, namespace);
    await assertNamespaceOwned(kubectl, reused.namespace, reused.id);
    const reusedPod = await pods(kubectl, reused.namespace, reused.id);
    assert.equal(reusedPod.spec.automountServiceAccountToken, false);

    const destroyedAgain = json(
      (await adm(binary, state, kubectl, ["destroy", reused.id])).stdout,
      "adm destroy reused label",
    );
    assert.equal(destroyedAgain.phase, "deleted");
    active.splice(active.indexOf(reused.id), 1);
    await assert.rejects(
      k(kubectl, ["get", "namespace", reused.namespace, "-o", "json"]),
      notFound,
    );
  },
);
