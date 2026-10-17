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
});
