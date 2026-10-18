import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";

const exec = promisify(execFile);

export async function verifyLifecycleKubeconfigProjection(image) {
  const resources = YAML.parseAllDocuments(
    await readFile(
      new URL("../deploy/lifecycle/control-plane.yaml", import.meta.url),
      "utf8",
    ),
    { version: "1.1" },
  ).map((document) => document.toJSON());
  const deployment = resources.find(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.metadata.name === "adm-lifecycle",
  );
  const pod = deployment.spec.template.spec;
  const controller = pod.containers.find(
    (container) => container.name === "lifecycle",
  );
  const kubeconfig = controller.env.find(
    (variable) => variable.name === "KUBECONFIG",
  ).value;
  const configMap = resources.find(
    (resource) =>
      resource.kind === "ConfigMap" &&
      resource.metadata.name === "adm-lifecycle-kubeconfig",
  );
  const volume = pod.volumes.find(
    (volume) => volume.configMap?.name === configMap.metadata.name,
  );
  const mount = controller.volumeMounts.find(
    (mount) => mount.name === volume.name,
  );
  const projection = await mkdtemp(
    join(tmpdir(), "adm-lifecycle-kubeconfig-smoke-"),
  );
  try {
    await chmod(projection, 0o755);
    for (const [key, value] of Object.entries(configMap.data)) {
      await writeFile(join(projection, key), value, { mode: 0o644 });
    }
    const { stdout } = await exec("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--user",
      "1000:1000",
      "--mount",
      `type=bind,src=${projection},dst=${mount.mountPath},readonly`,
      "--env",
      `KUBECONFIG=${kubeconfig}`,
      "--entrypoint",
      "/usr/local/bin/kubectl",
      image,
      "config",
      "view",
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.server}",
    ]);
    assert.equal(
      stdout,
      "https://kubernetes.default.svc",
      "controller kubectl must load the kubeconfig projected by its manifest",
    );
  } finally {
    await rm(projection, { recursive: true });
  }
}
