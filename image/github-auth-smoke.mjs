import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import { createServer } from "node:https";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function runGitHttpBackend(
  request,
  response,
  repositories,
  acceptedTokens,
) {
  const route = /^\/(org\/(?:alpha|beta)\.git)(\/.*)?$/.exec(
    new URL(request.url, "https://github.com").pathname,
  );
  const repository = route?.[1];
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(
    request.headers.authorization ?? "",
  );
  const identity = match
    ? Buffer.from(match[1], "base64").toString("utf8").split(":", 2)
    : [];
  const password = identity.length === 2 ? identity[1] : "";
  if (!repository || !acceptedTokens.get(repository)?.has(password)) {
    response.writeHead(401, {
      "www-authenticate": 'Basic realm="synthetic GitHub fixture"',
      "content-type": "text/plain",
    });
    response.end("synthetic credential rejected\n");
    return;
  }

  const input = [];
  request.on("data", (chunk) => input.push(chunk));
  request.on("end", () => {
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: repositories,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        PATH_INFO: `/${repository}${route[2] ?? ""}`,
        QUERY_STRING: new URL(request.url, "https://github.com").search.slice(
          1,
        ),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: request.headers["content-length"] ?? "0",
        REMOTE_USER: "synthetic-workspace",
        REMOTE_ADDR: "127.0.0.1",
        SERVER_PROTOCOL: "HTTP/1.1",
        SERVER_NAME: "github.com",
        SERVER_PORT: String(request.socket.localPort),
        HTTP_HOST: request.headers.host ?? "github.com",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") throw error;
    });
    child.stdin.end(Buffer.concat(input));
    child.once("error", () => {
      if (!response.headersSent)
        response.writeHead(500).end("fixture backend failed\n");
    });
    child.once("close", (code) => {
      if (response.headersSent) return;
      const bytes = Buffer.concat(output);
      const separator = bytes.indexOf("\r\n\r\n");
      if (code !== 0 || separator < 0) {
        response.writeHead(500).end("fixture backend failed\n");
        return;
      }
      const headers = bytes.subarray(0, separator).toString("latin1");
      const status = /^Status: (\d+)/m.exec(headers);
      const forwardedHeaders = headers
        .split("\r\n")
        .filter((line) => !line.startsWith("Status: "))
        .flatMap((line) => {
          const index = line.indexOf(":");
          return index < 0
            ? []
            : [[line.slice(0, index), line.slice(index + 1).trim()]];
        });
      response.writeHead(
        Number(status?.[1] ?? 200),
        Object.fromEntries(forwardedHeaders),
      );
      response.end(bytes.subarray(separator + 4));
    });
  });
}

async function git(directory, ...args) {
  return exec("git", ["-C", directory, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function docker(...args) {
  try {
    return await exec("docker", args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const detail = [error.stderr?.trim(), error.stdout?.trim()]
      .filter(Boolean)
      .join("\n");
    const wrapped = new Error(
      `docker ${args.slice(0, 3).join(" ")} failed: ${detail}`,
      {
        cause: error,
      },
    );
    wrapped.stderr = error.stderr?.toString() ?? "";
    wrapped.stdout = error.stdout?.toString() ?? "";
    throw wrapped;
  }
}

async function addCommit(directory, message) {
  await writeFile(join(directory, "README.md"), `${message}\n`);
  await git(directory, "add", "README.md");
  await git(directory, "commit", "-m", message);
}

async function createWorkspace({
  image,
  name,
  directory,
  repository,
  proxyPort,
  fixtureDirectory,
  envFile,
  created,
}) {
  await docker(
    "create",
    "--name",
    name,
    "--user",
    "1000:1000",
    "--network",
    "host",
    "--add-host",
    "github.com:127.0.0.1",
    "--mount",
    `type=bind,src=${directory},dst=/workspace`,
    "--mount",
    `type=bind,src=${fixtureDirectory},dst=/fixture,readonly`,
    ...(envFile ? ["--env-file", envFile] : []),
    image,
  );
  created.add(name);
  await docker("start", name);
  await docker(
    "exec",
    name,
    "sh",
    "-eu",
    "-c",
    `git -C /workspace/${repository} config http.sslCAInfo /fixture/cert.pem && git -C /workspace/${repository} config --local http.proxy http://127.0.0.1:${proxyPort} && test "$(git config --system --get-urlmatch credential.helper https://github.com/org/fixture.git)" = '!/usr/local/bin/adm-git-credential'`,
  );
}

async function runShellPush(name, repository) {
  return docker(
    "exec",
    name,
    "sh",
    "-c",
    `cd /workspace/${repository} && GIT_TERMINAL_PROMPT=0 git push origin HEAD:main`,
  );
}

async function runAgentToolPush(name, repository) {
  return docker(
    "exec",
    name,
    "node",
    "/fixture/coding-tool-push.mjs",
    repository,
  );
}

export async function verifyGitHubPushAuthentication(image) {
  const root = await mkdtemp(join(tmpdir(), "adm-github-push-"));
  await chmod(root, 0o755);
  const fixtureDirectory = join(root, "fixture");
  const repositoriesDirectory = join(root, "repositories");
  await mkdir(fixtureDirectory, { mode: 0o755 });
  const fallbackConfig = join(fixtureDirectory, "gh-config");
  await mkdir(fallbackConfig, { mode: 0o755 });
  await writeFile(
    join(fallbackConfig, "hosts.yml"),
    "github.com:\n    oauth_token: synthetic-alpha-v1\n    git_protocol: https\n",
    { mode: 0o644 },
  );
  await mkdir(join(repositoriesDirectory, "org"), { recursive: true });
  const alphaDirectory = join(repositoriesDirectory, "org", "alpha.git");
  const betaDirectory = join(repositoriesDirectory, "org", "beta.git");
  const alphaWorkspace = join(root, "workspace-alpha");
  const betaWorkspace = join(root, "workspace-beta");
  await mkdir(alphaWorkspace);
  await mkdir(betaWorkspace);
  const acceptedTokens = new Map([
    ["org/alpha.git", new Set(["synthetic-alpha-v1"])],
    ["org/beta.git", new Set(["synthetic-beta-v1"])],
  ]);
  const cert = join(fixtureDirectory, "cert.pem");
  const key = join(fixtureDirectory, "key.pem");
  const containerNames = [
    `adm-github-push-a-${process.pid}`,
    `adm-github-push-b-${process.pid}`,
    `adm-github-push-missing-${process.pid}`,
  ];
  const created = new Set();
  let server;
  let proxy;
  let failure;

  try {
    await exec("node_modules/.bin/esbuild", [
      new URL("./coding-tool-push.mjs", import.meta.url).pathname,
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${join(fixtureDirectory, "coding-tool-push.mjs")}`,
    ]);
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=github.com",
      "-addext",
      "subjectAltName=DNS:github.com,IP:127.0.0.1",
    ]);
    await chmod(cert, 0o644);
    for (const repository of [alphaDirectory, betaDirectory]) {
      await exec("git", [
        "init",
        "--bare",
        "--initial-branch=main",
        repository,
      ]);
      await exec("git", [
        "-C",
        repository,
        "config",
        "http.receivepack",
        "true",
      ]);
    }
    for (const [directory, repository] of [
      [alphaWorkspace, "alpha"],
      [betaWorkspace, "beta"],
    ]) {
      const workingTree = join(directory, repository);
      await exec("git", ["init", "--initial-branch=main", workingTree]);
      await git(workingTree, "config", "user.name", "Synthetic workspace");
      await git(workingTree, "config", "user.email", "fixture@example.invalid");
      await addCommit(workingTree, `${repository} initial`);
    }

    server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (request, response) =>
        runGitHttpBackend(
          request,
          response,
          repositoriesDirectory,
          acceptedTokens,
        ),
    );
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const fixturePort = server.address().port;
    proxy = createHttpServer();
    proxy.on("connect", (request, client, head) => {
      if (request.url !== "github.com:443") {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = connect(fixturePort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const proxyPort = proxy.address().port;
    for (const [directory, repository] of [
      [alphaWorkspace, "alpha"],
      [betaWorkspace, "beta"],
    ]) {
      const workingTree = join(directory, repository);
      await git(
        workingTree,
        "remote",
        "add",
        "origin",
        `https://github.com/org/${repository}.git`,
      );
    }

    const envFileA = join(root, "workspace-alpha.env");
    const envFileB = join(root, "workspace-beta.env");
    await writeFile(envFileA, "GH_TOKEN=synthetic-alpha-v1\n", { mode: 0o600 });
    await writeFile(envFileB, "GH_TOKEN=synthetic-beta-v1\n", { mode: 0o600 });
    await createWorkspace({
      image,
      name: containerNames[0],
      directory: alphaWorkspace,
      repository: "alpha",
      proxyPort,
      fixtureDirectory,
      envFile: envFileA,
      created,
    });
    await createWorkspace({
      image,
      name: containerNames[1],
      directory: betaWorkspace,
      repository: "beta",
      proxyPort,
      fixtureDirectory,
      envFile: envFileB,
      created,
    });

    await runShellPush(containerNames[0], "alpha");
    await runAgentToolPush(containerNames[1], "beta");
    assert.equal(
      (
        await git(join(alphaWorkspace, "alpha"), "remote", "get-url", "origin")
      ).stdout.trim(),
      "https://github.com/org/alpha.git",
      "the remote URL must remain credential-free",
    );

    await docker(
      "exec",
      containerNames[0],
      "sh",
      "-c",
      "output=$(printf 'protocol=https\\nhost=example.invalid\\n\\n' | GIT_TERMINAL_PROMPT=0 git -C /workspace/alpha credential fill 2>/dev/null || true); test -z \"$output\"",
    );
    await docker(
      "exec",
      containerNames[0],
      "sh",
      "-c",
      "output=$(printf 'protocol=https\\nhost=github.com:8443\\n\\n' | GIT_TERMINAL_PROMPT=0 git -C /workspace/alpha credential fill 2>/dev/null || true); test -z \"$output\"",
    );

    const isolated = await docker(
      "exec",
      containerNames[0],
      "sh",
      "-c",
      "cd /workspace/alpha && GIT_TERMINAL_PROMPT=0 git push https://github.com/org/beta.git HEAD:main",
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error) => ({ code: 1, stderr: error.stderr ?? "" }),
    );
    assert.equal(
      isolated.code,
      1,
      "a workspace token must not authorize another repository",
    );
    assert.match(isolated.stderr, /Authentication failed|rejected/i);

    await docker(
      "create",
      "--name",
      containerNames[2],
      "--user",
      "1000:1000",
      "--network",
      "host",
      "--add-host",
      "github.com:127.0.0.1",
      "--mount",
      `type=bind,src=${alphaWorkspace},dst=/workspace`,
      "--mount",
      `type=bind,src=${fixtureDirectory},dst=/fixture,readonly`,
      "--env",
      "GH_CONFIG_DIR=/fixture/gh-config",
      "--env",
      "GITHUB_TOKEN=synthetic-ambient-must-not-be-used",
      "--env",
      `GIT_CONFIG_COUNT=1`,
      "--env",
      "GIT_CONFIG_KEY_0=http.proxy",
      "--env",
      `GIT_CONFIG_VALUE_0=http://127.0.0.1:${proxyPort}`,
      image,
    );
    created.add(containerNames[2]);
    await docker("start", containerNames[2]);
    const missing = await docker(
      "exec",
      containerNames[2],
      "sh",
      "-c",
      "cd /workspace/alpha && GIT_TERMINAL_PROMPT=0 git push https://github.com/org/alpha.git HEAD:missing",
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error) => ({ code: 1, stderr: error.stderr ?? "" }),
    );
    assert.equal(
      missing.code,
      1,
      "missing credentials must fail noninteractively",
    );
    assert.match(missing.stderr, /GH_TOKEN|workspace Secret|credential/i);

    await addCommit(
      join(alphaWorkspace, "alpha"),
      "alpha rotated token commit",
    );
    acceptedTokens.set("org/alpha.git", new Set(["synthetic-alpha-v2"]));
    const stale = await runShellPush(containerNames[0], "alpha").then(
      () => ({ code: 0, stderr: "" }),
      (error) => ({ code: 1, stderr: error.stderr ?? "" }),
    );
    assert.equal(stale.code, 1, "the old token must fail after it is revoked");
    assert.match(stale.stderr, /Authentication failed|rejected/i);
    assert.match(stale.stderr, /GH_TOKEN Secret.*repository write permission/i);

    await docker("stop", "--time", "5", containerNames[0]);
    await docker("rm", containerNames[0]);
    created.delete(containerNames[0]);
    await writeFile(envFileA, "GH_TOKEN=synthetic-alpha-v2\n", { mode: 0o600 });
    await createWorkspace({
      image,
      name: containerNames[0],
      directory: alphaWorkspace,
      repository: "alpha",
      proxyPort,
      fixtureDirectory,
      envFile: envFileA,
      created,
    });
    await runAgentToolPush(containerNames[0], "alpha");
  } catch (error) {
    failure = error;
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
    for (const name of created) {
      await docker("stop", "--time", "5", name).catch(() => {});
      await docker("rm", name);
    }
    await rm(root, { recursive: true });
  }

  if (failure) throw failure;
}
