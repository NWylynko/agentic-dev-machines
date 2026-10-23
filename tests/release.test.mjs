import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import YAML from "yaml";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

test(
  "a release supplies lifecycle deployment and runs the CLI, terminal, provider runtime, and Code Mode without a checkout",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-release-test-"));
    let stopRunner = async () => {};
    t.after(async () => {
      await stopRunner();
      await rm(directory, { recursive: true });
    });
    const helper = join(directory, "adm-repositories");
    await writeFile(helper, "#!/bin/sh\nprintf 'release helper\\n'\n", {
      mode: 0o755,
    });
    const output = join(directory, "dist");
    const { stdout: built } = await execute(
      process.execPath,
      [
        join(project, "scripts/build-release.mjs"),
        "--version",
        "v9.8.7",
        "--image",
        "ghcr.io/example/adm:9.8.7",
        "--adm",
        resolve(
          process.env.ADM_RELEASE_TEST_ADM ?? join(project, "target/debug/adm"),
        ),
        "--repositories",
        helper,
        "--output",
        output,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const archive = basename(built.trim().split("\n").at(-1));
    await execute("sha256sum", ["--check", "SHA256SUMS"], { cwd: output });
    const unrelated = join(directory, "outside-checkout");
    await mkdir(unrelated);
    const hostTools = join(directory, "host-tools");
    await mkdir(hostTools);
    await writeFile(join(hostTools, "systemctl"), "#!/bin/sh\nexit 3\n", {
      mode: 0o755,
    });
    const environment = {
      ...process.env,
      HOME: join(directory, "home"),
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
      PATH: hostTools + delimiter + process.env.PATH,
    };
    delete environment.ADM_PROJECT_DIR;
    delete environment.ADM_STATE_DIR;
    const assets = new Map(
      await Promise.all(
        [archive, "SHA256SUMS"].map(async (name) => [
          "/" + name,
          await readFile(join(output, name)),
        ]),
      ),
    );
    const releaseServer = createHttpServer((request, response) => {
      const asset = assets.get(request.url);
      response.writeHead(asset ? 200 : 404);
      response.end(asset);
    });
    releaseServer.listen(0, "127.0.0.1");
    await once(releaseServer, "listening");
    t.after(
      () =>
        new Promise((resolve, reject) =>
          releaseServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    await execute(
      "sh",
      [
        join(project, "install.sh"),
        "--no-setup",
        "--base-url",
        `http://127.0.0.1:${releaseServer.address().port}`,
      ],
      {
        cwd: unrelated,
        env: environment,
      },
    );
    const adm = join(environment.HOME, ".local/bin/adm");
    const installed = dirname(dirname(await realpath(adm)));
    assert.match(
      await readFile(join(installed, "LICENSE"), "utf8"),
      /^MIT License\n[\s\S]*Copyright \(c\) 2026 Nick Wylynko[\s\S]*The above copyright notice and this permission notice/,
    );
    assert.equal(
      await readFile(join(installed, "VERSION"), "utf8"),
      "v9.8.7\n",
    );
    const lifecycleDirectory = join(installed, "deploy/lifecycle");
    const kustomization = YAML.parse(
      await readFile(join(lifecycleDirectory, "kustomization.yaml"), "utf8"),
    );
    assert.equal(kustomization.namespace, "adm-system");
    assert.deepEqual(kustomization.resources, ["control-plane.yaml"]);
    const lifecycleResources = YAML.parseAllDocuments(
      await readFile(
        join(lifecycleDirectory, kustomization.resources[0]),
        "utf8",
      ),
    ).map((document) => document.toJSON());
    const lifecycleDeployment = lifecycleResources.find(
      (resource) => resource.kind === "Deployment",
    );
    assert.equal(lifecycleDeployment.metadata.name, "adm-lifecycle");
    const lifecyclePod = lifecycleDeployment.spec.template.spec;
    assert.equal(
      lifecyclePod.initContainers[0].image,
      "ghcr.io/example/adm:9.8.7",
    );
    assert.equal(lifecyclePod.containers[0].image, "ghcr.io/example/adm:9.8.7");
    assert.equal(
      lifecyclePod.volumes.find((volume) => volume.name === "token").secret
        .defaultMode,
      0o440,
    );
    assert.ok(
      lifecycleResources.some(
        (resource) =>
          resource.kind === "Service" &&
          resource.metadata.name === "adm-lifecycle",
      ),
    );
    await execute(
      process.execPath,
      [join(project, "tests/shell-management.test.mjs"), adm],
      {
        cwd: unrelated,
        // Unix socket paths must fit Linux's 108-byte sun_path, even when
        // the release archive is built under a longer disk-backed TMPDIR.
        env: { ...environment, TMPDIR: "/tmp" },
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(
      await readFile(join(installed, "IMAGE"), "utf8"),
      "ghcr.io/example/adm:9.8.7\n",
    );
    assert.ok(
      (
        await readFile(join(installed, "runtime/provider-auth.mjs"), "utf8")
      ).includes("createProviderAuthAuthority"),
      "the released runtime must include the lifecycle provider-auth authority bundle",
    );
    const version = await execute(adm, ["--version"], {
      cwd: unrelated,
      env: environment,
    });
    assert.match(version.stdout, /^adm /);
    const manifest = await execute(adm, ["manifest", "release"], {
      cwd: unrelated,
      env: environment,
    });
    const deployment = JSON.parse(manifest.stdout).items.find(
      (resource) => resource.kind === "Deployment",
    );
    assert.equal(
      deployment.spec.template.spec.containers[0].image,
      "ghcr.io/example/adm:9.8.7",
    );
    await assert.rejects(
      execute(
        adm,
        ["update", "--workspace", "same", "--workspace", "same"],
        { cwd: unrelated, env: environment },
      ),
      /a workspace was selected more than once/,
    );
    assert.equal(await readFile(join(installed, "VERSION"), "utf8"), "v9.8.7\n");

    const lifecycleTokenFile = join(directory, "lifecycle-token");
    await writeFile(lifecycleTokenFile, "synthetic-lifecycle-token\n", { mode: 0o600 });
    const applied = join(directory, "controller-applied");
    const kubectlLog = join(directory, "kubectl.log");
    const targetImage = "ghcr.io/example/adm:9.8.7";
    const fixtureResources = YAML.parseAllDocuments(
      await readFile(join(installed, "deploy/lifecycle/control-plane.yaml"), "utf8"),
    ).map((document) => document.toJSON());
    const deploymentResource = fixtureResources.find(
      (resource) => resource.kind === "Deployment" && resource.metadata.name === "adm-lifecycle",
    );
    for (const container of [
      ...deploymentResource.spec.template.spec.initContainers,
      ...deploymentResource.spec.template.spec.containers,
    ]) container.image = targetImage;
    const resourcesFile = join(directory, "lifecycle-resources.json");
    await writeFile(resourcesFile, fixtureResources.map(JSON.stringify).join("\n"));
    const fakeKubectl = join(hostTools, "kubectl");
    await writeFile(
      fakeKubectl,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(kubectlLog)}
case "$*" in
  *"get namespace adm-system"*) printf '{"metadata":{"name":"adm-system","labels":{"app.kubernetes.io/part-of":"adm"}}}\\n' ;;
  *"get pvc adm-lifecycle-state"*) printf '{"metadata":{"name":"adm-lifecycle-state","namespace":"adm-system"},"spec":{"storageClassName":"installed-lifecycle-class"}}\\n' ;;
  *"get deployment adm-lifecycle"*)
    image=${JSON.stringify(targetImage)}
    [ ! -f ${JSON.stringify(applied)} ] || image=$(cut -d= -f2 ${JSON.stringify(applied)})
    printf '{"metadata":{"name":"adm-lifecycle","namespace":"adm-system"},"spec":{"selector":{"matchLabels":{"app.kubernetes.io/name":"adm-lifecycle"}},"template":{"spec":{"serviceAccountName":"adm-lifecycle","volumes":[{"name":"state","persistentVolumeClaim":{"claimName":"adm-lifecycle-state"}}],"initContainers":[{"image":"%s"}],"containers":[{"image":"%s"}]}}}}\\n' "$image" "$image"
    ;;
  *"get storageclass"*) printf '{"provisioner":"rook-ceph.rbd.csi.ceph.com"}\\n' ;;
  *"create --dry-run=client"*) cat ${JSON.stringify(resourcesFile)} ;;
  *"get secret adm-lifecycle-token"*) exit 0 ;;
  *"apply -f -"*) manifest=$(cat); printf '%s' "$manifest" > ${JSON.stringify(applied)}.manifest; printf 'image=${targetImage}\\n' > ${JSON.stringify(applied)} ;;
  *"rollout status deployment/adm-lifecycle"*) exit 0 ;;
  *"create secret generic adm-lifecycle-token"*) cat >/dev/null ;;
  *) echo "unexpected kubectl call: $*" >&2; exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    const failedWorkspaceOperations = new Set();
    const maintenanceCalls = [];
    let failSelectedWorkspace = false;
    const lifecycleServer = createHttpServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      if (request.headers.authorization !== "Bearer synthetic-lifecycle-token") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "selected token file was not forwarded" } }));
        return;
      }
      if (request.url.startsWith("/v1/runtime/maintenance/")) {
        maintenanceCalls.push(request.url);
        const value = request.url.endsWith("/extend")
          ? { workspaceIds: [], expiresAt: Math.floor(Date.now() / 1000) + 300 }
          : request.url.endsWith("/await")
            ? { ready: true }
            : { completed: true };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
        return;
      }
      const selectedId = "55f9ea63-5506-4b39-bab8-49c2fadd0e73";
      const selectedWorkspace = {
        id: selectedId,
        name: "selected-workspace",
        role: "coding",
        namespace: "adm-55f9ea6355064b39",
        phase: "ready",
        image: "ghcr.io/example/adm-dev:stale-workspace-image",
        storage_class: "adm-replicated",
        storage_size: "1Gi",
        cpu: "1",
        memory: "1Gi",
        agent_enabled: true,
        allow_node_local_storage: false,
        repositories: false,
        catalog: {},
        repository: null,
        cwd: "/repos",
        model: null,
        credential_env: [],
        mcp_servers: null,
        herdr_space: null,
        created_at: 1,
        last_error: null,
      };
      if (request.method === "GET" && request.url === "/v1/workspaces") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([selectedWorkspace]));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/operations") {
        assert.equal(body.kind, "update");
        assert.equal(body.workspaceId, selectedId);
        if (failSelectedWorkspace) failedWorkspaceOperations.add(body.operationId);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({
          operationId: body.operationId,
          workspaceId: body.workspaceId,
          kind: "update",
          status: failSelectedWorkspace ? "accepted" : "completed",
          stage: failSelectedWorkspace ? "accepted" : "completed",
        }));
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/v1/operations/")) {
        const operationId = request.url.split("/").at(-1);
        const failed = failedWorkspaceOperations.has(operationId);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          status: failed ? "failed" : "completed",
          stage: failed ? "failed" : "completed",
          lastError: failed ? "injected selected workspace update failure" : null,
        }));
        return;
      }
      if (request.method === "GET" && request.url === `/v1/workspaces/${selectedId}`) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ...selectedWorkspace,
          image: targetImage,
        }));
        return;
      }
      const maintenanceResponse = request.url.endsWith("/extend")
        ? { workspaceIds: [], expiresAt: Math.floor(Date.now() / 1000) + 300 }
        : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(maintenanceResponse));
    });
    lifecycleServer.listen(0, "127.0.0.1");
    await once(lifecycleServer, "listening");
    t.after(
      () =>
        new Promise((resolve, reject) =>
          lifecycleServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    await mkdir(join(environment.XDG_CONFIG_HOME, "adm"), { recursive: true });
    await writeFile(
      join(environment.XDG_CONFIG_HOME, "adm", "config.json"),
      JSON.stringify({
        image: "ghcr.io/example/adm-dev:stale-workspace-image",
        storageClass: "stale-workspace-storage",
        lifecycle: {
          url: `http://127.0.0.1:${lifecycleServer.address().port}`,
          forward: false,
          namespace: "adm-system",
          kubectl: fakeKubectl,
          kubeconfig: "/fixture/kubeconfig",
        },
      }),
    );
    const updateEnvironment = { ...environment, ADM_PROJECT_DIR: unrelated };
    const update = await execute(
      adm,
      [
        "update",
        "--version",
        "v9.8.7",
        "--base-url",
        `http://127.0.0.1:${releaseServer.address().port}`,
        "--lifecycle-token-file",
        lifecycleTokenFile,
        "--kubectl",
        fakeKubectl,
      ],
      { cwd: unrelated, env: updateEnvironment, maxBuffer: 1024 * 1024 },
    );
    assert.match(update.stderr, /controller release v9\.8\.7 observed/);
    assert.deepEqual(maintenanceCalls, [
      "/v1/runtime/maintenance/extend",
      "/v1/runtime/maintenance/await",
      "/v1/runtime/maintenance/complete",
    ]);
    assert.equal(await readFile(applied, "utf8"), `image=${targetImage}\n`);
    const appliedCalls = (await readFile(kubectlLog, "utf8"))
      .split("\n")
      .filter((call) => call.startsWith("apply "));
    assert.equal(appliedCalls.length, 2, "default update applies only the controller namespace and resources");
    const appliedManifest = await readFile(`${applied}.manifest`, "utf8");
    assert.match(appliedManifest, /installed-lifecycle-class/);
    assert.doesNotMatch(appliedManifest, /stale-workspace-storage/);
    assert.doesNotMatch(appliedManifest, /stale-workspace-image/);
    assert.equal(
      (await execute(adm, ["--version"], { cwd: unrelated, env: environment })).stdout,
      "adm 0.1.0\n",
    );
    const configPath = join(environment.XDG_CONFIG_HOME, "adm", "config.json");
    const savedConfig = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(
      savedConfig.image,
      "ghcr.io/example/adm-dev:stale-workspace-image",
      "an image from another repository is the user's own choice and survives updates",
    );
    // `adm setup` saves the release's own image as an explicit reference. An
    // update must advance it, or every new workspace keeps the setup-time runner
    // (TASK-62: fixes shipped, but fresh workspaces still ran the old release).
    await writeFile(
      configPath,
      JSON.stringify({ ...savedConfig, image: "ghcr.io/example/adm:sha-setup-time-release" }),
    );
    await execute(
      adm,
      [
        "update",
        "--version",
        "v9.8.7",
        "--base-url",
        `http://127.0.0.1:${releaseServer.address().port}`,
        "--lifecycle-token-file",
        lifecycleTokenFile,
        "--kubectl",
        fakeKubectl,
      ],
      { cwd: unrelated, env: updateEnvironment, maxBuffer: 1024 * 1024 },
    );
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      ...savedConfig,
      image: targetImage,
    });
    const freshManifest = await execute(adm, ["manifest", "fresh-after-update"], {
      cwd: unrelated,
      env: environment,
    });
    assert.equal(
      JSON.parse(freshManifest.stdout)
        .items.find((resource) => resource.kind === "Deployment")
        .spec.template.spec.containers[0].image,
      targetImage,
      "a workspace created after `adm update` runs the updated release",
    );
    await writeFile(configPath, JSON.stringify(savedConfig));
    const selectedUpdate = await execute(
      adm,
      [
        "update",
        "--version",
        "v9.8.7",
        "--base-url",
        `http://127.0.0.1:${releaseServer.address().port}`,
        "--lifecycle-token-file",
        lifecycleTokenFile,
        "--kubectl",
        fakeKubectl,
        "--workspace",
        "selected-workspace",
      ],
      { cwd: unrelated, env: updateEnvironment, maxBuffer: 1024 * 1024 },
    );
    assert.match(selectedUpdate.stderr, /selected workspace selected-workspace/);
    assert.match(selectedUpdate.stderr, /targets immutable ID 55f9ea63-5506-4b39-bab8-49c2fadd0e73/);
    failSelectedWorkspace = true;
    await assert.rejects(
      execute(
        adm,
        [
          "update",
          "--version",
          "v9.8.7",
          "--base-url",
          `http://127.0.0.1:${releaseServer.address().port}`,
          "--lifecycle-token-file",
          lifecycleTokenFile,
          "--kubectl",
          fakeKubectl,
          "--workspace",
          "selected-workspace",
        ],
        { cwd: unrelated, env: updateEnvironment, maxBuffer: 1024 * 1024 },
      ),
      (error) =>
        /adm update --version v9\.8\.7 .*--workspace 55f9ea63-5506-4b39-bab8-49c2fadd0e73 --operation-id [0-9a-f-]{36}/.test(
          error.stderr,
        ),
    );

    const terminal = await execute(
      process.execPath,
      [join(installed, "runtime/terminal.mjs"), "--help"],
      { cwd: unrelated },
    );
    assert.match(terminal.stdout, /Ctrl\+C detaches/);
    const provider = await execute(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const { ModelRuntime } = await import("@earendil-works/pi-coding-agent"); if (typeof ModelRuntime.create !== "function") throw new Error("Provider runtime missing");',
      ],
      { cwd: installed },
    );
    assert.equal(provider.stderr, "");
    const interactivePatch = await readFile(
      join(
        installed,
        "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
      ),
      "utf8",
    );
    assert.match(interactivePatch, /remotePorts\?\.projectTrust/);
    assert.match(interactivePatch, /authMetadata\.isAnthropicSubscription\(\)/);
    const interactiveMode = await execute(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const { InteractiveMode } = await import("@earendil-works/pi-coding-agent"); if (typeof InteractiveMode !== "function") throw new Error("InteractiveMode missing");',
      ],
      { cwd: installed },
    );
    assert.equal(interactiveMode.stderr, "");

    const identity = "release-fixture-pod-identity";
    const holder = "731db50f-237a-4f43-af54-a9d033e9c3b1";
    const tokenFile = join(directory, "projected-token");
    const workspaceConfig = join(directory, "workspace.json");
    await writeFile(tokenFile, identity + "\n", { mode: 0o600 });
    await writeFile(
      workspaceConfig,
      JSON.stringify({
        id: "release-bot",
        name: "release",
        role: "bot",
        environment: "pod",
        model: { provider: "faux", id: "faux-1" },
      }),
    );
    const lifecycle = createHttpServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      const authorized = request.headers.authorization === `Bearer ${identity}`;
      const initial = request.url.endsWith("/lease");
      const action = request.url.endsWith("/authorize");
      const valid =
        authorized &&
        (action ||
          (body.holder === holder && (initial || body.fencingToken === 1)));
      response.writeHead(valid ? 200 : 403, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          valid
            ? {
                holder,
                fencingToken: 1,
                expiresAt: Math.floor(Date.now() / 1000) + 60,
                valid: true,
                check: { valid: true },
              }
            : { error: { message: "invalid fixture identity or fence" } },
        ),
      );
    });
    lifecycle.listen(0, "127.0.0.1");
    await once(lifecycle, "listening");
    t.after(() => {
      lifecycle.closeAllConnections();
      return new Promise((resolve) => lifecycle.close(resolve));
    });
    const child = spawn(
      process.execPath,
      [
        join(installed, "runtime/runner.mjs"),
        "--port",
        "0",
        "--state-dir",
        join(directory, "state"),
        "--workspace-config",
        workspaceConfig,
        "--token-file",
        tokenFile,
        "--lifecycle-url",
        `http://127.0.0.1:${lifecycle.address().port}`,
        "--pod-uid",
        holder,
        "--provider",
        "faux",
      ],
      {
        cwd: unrelated,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    stopRunner = async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      const [code, signal] = await exited;
      lines.close();
      assert.equal(
        code,
        0,
        `Packaged runner did not shut down cleanly (${signal}): ${errors}`,
      );
    };
    const { url } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Packaged runner exited ${code}: ${errors}`)),
      );
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.ready) resolve(event);
        } catch {
          /* Diagnostic output. */
        }
      });
    });
    async function request(path, method = "GET", body) {
      const response = await fetch(url + path, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${identity}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    }
    assert.equal((await request("/health")).status, "ok");
    const path = "/v1/workspaces/release-bot";
    assert.equal((await request(path)).role, "bot");
    await request(path + "/input", "POST", {
      requestId: "release-worker",
      whenBusy: "followUp",
      message:
        "/faux " +
        JSON.stringify({
          calls: [
            {
              tool: "codemode",
              args: {
                code: 'await tools.sendMessage({text:"Packaged worker delivered this."})',
              },
            },
          ],
          answer: "Private response.",
        }),
    });
    const controller = new AbortController();
    const response = await fetch(url + path + "/events", {
      headers: { authorization: `Bearer ${identity}` },
      signal: AbortSignal.any([controller.signal, t.signal]),
    });
    assert.equal(response.status, 200);
    let buffer = "",
      delivered = false;
    try {
      for await (const bytes of response.body) {
        buffer += Buffer.from(bytes).toString();
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!data) continue;
          const event = JSON.parse(data.slice(6));
          if (
            event.kind === "message" &&
            event.data.text === "Packaged worker delivered this."
          ) {
            delivered = true;
            break;
          }
        }
        if (delivered) break;
      }
    } finally {
      controller.abort();
    }
    assert.ok(delivered, `Code Mode did not publish its message: ${errors}`);
    const history = await request(path + "/history");
    assert.ok(
      history.events.some(
        (event) =>
          event.kind === "message" &&
          event.data.text === "Packaged worker delivered this.",
      ),
    );
  },
);
