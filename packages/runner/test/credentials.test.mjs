import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  workspaceCredentialRuntime,
  workspacePiAuthPath,
} from "../src/credentials.ts";

test("workspace Pi credentials survive runtime restart and logout only removes that workspace credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "adm-workspace-auth-"));
  const sentinel = "synthetic-provider-secret-do-not-log";
  try {
    assert.equal(workspacePiAuthPath(root), join(root, ".adm/pi/auth.json"));
    await mkdir(join(root, ".adm/pi"), { recursive: true });
    await writeFile(
      workspacePiAuthPath(root),
      JSON.stringify({ openai: { type: "api_key", key: sentinel } }),
      { mode: 0o600 },
    );
    const persisted = await readFile(workspacePiAuthPath(root), "utf8");
    assert.match(persisted, new RegExp(sentinel));

    const restarted = await workspaceCredentialRuntime(root);
    assert.equal(
      (await restarted.listCredentials()).some(
        ({ providerId }) => providerId === "openai",
      ),
      true,
    );
    await restarted.logout("openai");

    const afterLogout = await workspaceCredentialRuntime(root);
    assert.equal(
      (await afterLogout.listCredentials()).some(
        ({ providerId }) => providerId === "openai",
      ),
      false,
    );
    assert.doesNotMatch(
      await readFile(workspacePiAuthPath(root), "utf8"),
      new RegExp(sentinel),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("independent workspace auth paths do not share mutable OAuth state", async () => {
  const one = workspacePiAuthPath("/pod-one/workspace");
  const two = workspacePiAuthPath("/pod-two/workspace");
  assert.notEqual(one, two);
  assert.equal(one, "/pod-one/workspace/.adm/pi/auth.json");
  assert.equal(two, "/pod-two/workspace/.adm/pi/auth.json");
});

test("one workspace file store serializes OAuth rotation and retains the rotated token across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "adm-workspace-oauth-"));
  const authPath = workspacePiAuthPath(root);
  const sentinel = "synthetic-refresh-token";
  let refreshes = 0;
  let spent = false;
  const provider = {
    id: "adm-rotation-probe",
    auth: {
      oauth: {
        name: "synthetic rotation probe",
        async login() {
          throw new Error("login is not part of this test");
        },
        async refresh(credential) {
          refreshes += 1;
          if (spent) throw new Error("synthetic refresh token already rotated");
          spent = true;
          return {
            ...credential,
            access: "synthetic-next-access",
            refresh: "synthetic-next-refresh",
            expires: Date.now() + 60 * 60 * 1000,
          };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  };
  try {
    await mkdir(join(root, ".adm/pi"), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({
        "adm-rotation-probe": {
          type: "oauth",
          access: "synthetic-expired-access",
          refresh: sentinel,
          expires: 0,
        },
      }),
      { mode: 0o600 },
    );
    const first = await workspaceCredentialRuntime(root);
    first.registerNativeProvider(provider);
    await Promise.all([
      first.getAuth("adm-rotation-probe"),
      first.getAuth("adm-rotation-probe"),
    ]);
    assert.equal(refreshes, 1);

    const rotated = JSON.parse(await readFile(authPath, "utf8"))[
      "adm-rotation-probe"
    ];
    assert.equal(rotated.refresh, "synthetic-next-refresh");
    const restarted = await workspaceCredentialRuntime(root);
    restarted.registerNativeProvider(provider);
    await restarted.getAuth("adm-rotation-probe");
    assert.equal(refreshes, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("cancellation during OAuth rotation waits only for the caller and still persists the rotated token", async () => {
  const root = await mkdtemp(join(tmpdir(), "adm-workspace-oauth-cancel-"));
  const authPath = workspacePiAuthPath(root);
  let refreshStarted;
  const started = new Promise((resolve) => (refreshStarted = resolve));
  let finishRefresh;
  const refreshGate = new Promise((resolve) => (finishRefresh = resolve));
  const provider = {
    id: "adm-cancel-probe",
    auth: {
      oauth: {
        name: "synthetic cancellation probe",
        async login() {
          throw new Error("login is not part of this test");
        },
        async refresh(credential) {
          refreshStarted();
          await refreshGate;
          return {
            ...credential,
            access: "synthetic-after-cancel-access",
            refresh: "synthetic-after-cancel-refresh",
            expires: Date.now() + 60 * 60 * 1000,
          };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  };
  try {
    await mkdir(join(root, ".adm/pi"), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({
        "adm-cancel-probe": {
          type: "oauth",
          access: "synthetic-expired-access",
          refresh: "synthetic-before-cancel-refresh",
          expires: 0,
        },
      }),
      { mode: 0o600 },
    );
    const runtime = await workspaceCredentialRuntime(root);
    runtime.registerNativeProvider(provider);
    const controller = new AbortController();
    const canceledRequest = runtime.getAuth("adm-cancel-probe", {
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await assert.rejects(canceledRequest, { name: "AbortError" });
    finishRefresh();

    const restarted = await workspaceCredentialRuntime(root);
    restarted.registerNativeProvider(provider);
    const auth = await restarted.getAuth("adm-cancel-probe");
    assert.equal(auth.auth.apiKey, "synthetic-after-cancel-access");
    assert.equal(
      JSON.parse(await readFile(authPath, "utf8"))["adm-cancel-probe"].refresh,
      "synthetic-after-cancel-refresh",
    );
  } finally {
    finishRefresh();
    await rm(root, { recursive: true });
  }
});

test("revoked OAuth credentials fail visibly without switching to an ambient API key", async () => {
  const root = await mkdtemp(join(tmpdir(), "adm-workspace-oauth-failure-"));
  const authPath = workspacePiAuthPath(root);
  const envName = "ADM_SYNTHETIC_FALLBACK_KEY";
  const oldValue = process.env[envName];
  process.env[envName] = "synthetic-must-not-be-used";
  const provider = {
    id: "adm-revoked-probe",
    auth: {
      apiKey: {
        name: "synthetic fallback",
        async resolve() {
          return { auth: { apiKey: process.env[envName] } };
        },
      },
      oauth: {
        name: "synthetic revoked OAuth",
        async login() {
          throw new Error("login is not part of this test");
        },
        async refresh() {
          throw new Error("synthetic provider revoked refresh token");
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  };
  try {
    await mkdir(join(root, ".adm/pi"), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({
        "adm-revoked-probe": {
          type: "oauth",
          access: "synthetic-expired-access",
          refresh: "synthetic-revoked-refresh",
          expires: 0,
        },
      }),
      { mode: 0o600 },
    );
    const runtime = await workspaceCredentialRuntime(root);
    runtime.registerNativeProvider(provider);
    await assert.rejects(
      runtime.getAuth("adm-revoked-probe"),
      /OAuth refresh failed/,
    );
    assert.equal(
      JSON.parse(await readFile(authPath, "utf8"))["adm-revoked-probe"].refresh,
      "synthetic-revoked-refresh",
    );
  } finally {
    if (oldValue === undefined) delete process.env[envName];
    else process.env[envName] = oldValue;
    await rm(root, { recursive: true });
  }
});
