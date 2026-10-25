import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";

test("lifecycle may request tokens only for workspace runtime service accounts", async () => {
  const documents = YAML.parseAllDocuments(
    await readFile(
      new URL("../deploy/lifecycle/control-plane.yaml", import.meta.url),
      "utf8",
    ),
  ).map((document) => document.toJSON());
  const role = documents.find(
    (document) =>
      document.kind === "ClusterRole" &&
      document.metadata.name === "adm-lifecycle",
  );
  assert.ok(role);
  assert.ok(
    role.rules.some(
      (rule) =>
        rule.apiGroups.length === 1 &&
        rule.apiGroups[0] === "" &&
        rule.resources.length === 1 &&
        rule.resources[0] === "serviceaccounts/token" &&
        rule.resourceNames.length === 1 &&
        rule.resourceNames[0] === "adm-runtime" &&
        rule.verbs.length === 1 &&
        rule.verbs[0] === "create",
    ),
    "TokenRequest permission must be resource-name limited to adm-runtime",
  );
  const namespaceRule = role.rules.find((rule) =>
    rule.resources.includes("namespaces"),
  );
  assert.ok(
    namespaceRule.verbs.includes("patch") &&
      namespaceRule.verbs.includes("update"),
  );
  assert.ok(
    role.rules.some(
      (rule) =>
        rule.apiGroups.length === 1 &&
        rule.apiGroups[0] === "" &&
        rule.resources.length === 1 &&
        rule.resources[0] === "pods/exec" &&
        rule.verbs.includes("create") &&
        rule.verbs.includes("get"),
    ),
    "repository preparation needs only the Pod exec subresource",
  );
  assert.ok(
    role.rules.every(
      (rule) =>
        !rule.resources.some((resource) =>
          ["roles", "rolebindings"].includes(resource),
        ),
    ),
    "the lifecycle controller must not mint additional RBAC grants",
  );
  const nodeRules = role.rules.filter((rule) =>
    rule.resources.includes("nodes"),
  );
  assert.deepEqual(
    nodeRules.map((rule) => [rule.apiGroups, rule.resources, rule.verbs]),
    [[[""], ["nodes"], ["get", "list"]]],
    "moving workspaces off down nodes (TASK-82) reads node readiness and never changes nodes",
  );
});

test("provider auth authority shares the lifecycle image and persistent state without a public port", async () => {
  const documents = YAML.parseAllDocuments(
    await readFile(
      new URL("../deploy/lifecycle/control-plane.yaml", import.meta.url),
      "utf8",
    ),
  ).map((document) => document.toJSON());
  const deployment = documents.find(
    (document) =>
      document.kind === "Deployment" &&
      document.metadata.name === "adm-lifecycle",
  );
  assert.ok(deployment);
  const controller = deployment.spec.template.spec.containers.find(
    (container) => container.name === "lifecycle",
  );
  const authority = deployment.spec.template.spec.containers.find(
    (container) => container.name === "provider-auth",
  );
  assert.ok(controller);
  assert.ok(authority);
  assert.deepEqual(authority.command, ["node", "/opt/adm/provider-auth.mjs"]);
  assert.equal(authority.image, controller.image);
  assert.ok(
    authority.volumeMounts.some(
      (mount) => mount.name === "state" && mount.mountPath === "/var/lib/adm",
    ),
    "shared credentials must use the lifecycle persistent volume",
  );
  assert.ok(
    authority.args.includes("--probe-port"),
    "the loopback-bound authority needs a Pod-IP liveness listener for kubelet",
  );
  const service = documents.find(
    (document) =>
      document.kind === "Service" && document.metadata.name === "adm-lifecycle",
  );
  assert.ok(service);
  assert.ok(
    service.spec.ports.every((port) => port.port !== 7434),
    "the provider authority must not be exposed as a Service port",
  );
});

test("lifecycle Pod probes are kubelet HTTP checks and provider-auth cannot take the Service offline (TASK-94)", async () => {
  const documents = YAML.parseAllDocuments(
    await readFile(
      new URL("../deploy/lifecycle/control-plane.yaml", import.meta.url),
      "utf8",
    ),
  ).map((document) => document.toJSON());
  const pod = documents.find(
    (document) =>
      document.kind === "Deployment" &&
      document.metadata.name === "adm-lifecycle",
  ).spec.template.spec;
  for (const container of [...(pod.initContainers ?? []), ...pod.containers])
    for (const probe of ["readinessProbe", "livenessProbe", "startupProbe"])
      assert.equal(
        container[probe]?.exec,
        undefined,
        `${container.name} ${probe} must not start a process per check`,
      );
  const authority = pod.containers.find(
    (container) => container.name === "provider-auth",
  );
  assert.equal(
    authority.readinessProbe,
    undefined,
    "provider-auth readiness must not gate the lifecycle Service endpoints",
  );
  assert.deepEqual(authority.livenessProbe.httpGet, {
    path: "/health",
    port: "auth-liveness",
  });
  assert.equal(authority.livenessProbe.timeoutSeconds, 3);
  assert.ok(
    authority.ports.some(
      (port) => port.name === "auth-liveness" && port.containerPort === 7435,
    ),
  );
});

test("the lifecycle container requests CPU so a busy node schedules it fairly (TASK-96)", async () => {
  const documents = YAML.parseAllDocuments(
    await readFile(
      new URL("../deploy/lifecycle/control-plane.yaml", import.meta.url),
      "utf8",
    ),
  ).map((document) => document.toJSON());
  const controller = documents
    .find(
      (document) =>
        document.kind === "Deployment" &&
        document.metadata.name === "adm-lifecycle",
    )
    .spec.template.spec.containers.find(
      (container) => container.name === "lifecycle",
    );
  assert.ok(
    controller.resources?.requests?.cpu,
    "the lifecycle container needs a CPU request",
  );
});
