import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { watch as watchDirectory } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const remoteEnv = fileURLToPath(
  new URL("../src/remote-env-server.ts", import.meta.url),
);

function waitForMarker(directory, marker) {
  return new Promise((resolve) => {
    const watcher = watchDirectory(directory);
    const timeout = setTimeout(() => {
      watcher.close();
      resolve(false);
    }, 1000);
    watcher.on("change", (_event, filename) => {
      if (filename === marker) {
        clearTimeout(timeout);
        watcher.close();
        resolve(true);
      }
    });
  });
}

async function waitForFile(directory, filename) {
  const path = join(directory, filename);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const watcher = watchDirectory(directory);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`file was not created: ${path}`)),
        5000,
      );
      watcher.on("change", async (_event, changed) => {
        if (changed !== filename) return;
        clearTimeout(timeout);
        try {
          resolve(await readFile(path, "utf8"));
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    watcher.close();
  }
}

async function processGroup(group) {
  const active = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const state = fields[0];
      const processGroup = Number(fields[2]);
      if (processGroup === group && state !== "Z") active.push(Number(entry));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
    }
  }
  return active;
}

for (const close of ["eof", "sigterm", "stdout"]) {
  test(
    `remote environment ${close} stops detached commands before exit`,
    { timeout: 15_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "adm-remote-env-"));
      const marker = "released-after-close";
      const markerPath = join(directory, marker);
      const pidPath = join(directory, "shell-pid");
      const source = `trap 'printf leaked > ${markerPath}' USR1; ${close === "stdout" ? `echo $$ > ${pidPath}; echo ready` : "echo $$"}; sleep 60 & wait`;
      const server = spawn(
        process.execPath,
        ["--import", "tsx", remoteEnv, "--cwd", directory],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const lines = createInterface({ input: server.stdout });
      let stderr = "";
      server.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      let group;
      const pidReady =
        close === "stdout"
          ? undefined
          : new Promise((resolve, reject) => {
              const timeout = setTimeout(
                () =>
                  reject(
                    new Error(`remote command produced no PID: ${stderr}`),
                  ),
                5000,
              );
              lines.on("line", (line) => {
                const message = JSON.parse(line);
                if (message.id === 1 && message.event === "output") {
                  const candidate = Number(message.text.trim());
                  if (Number.isInteger(candidate) && candidate > 0) {
                    clearTimeout(timeout);
                    resolve(candidate);
                  }
                }
              });
              server.once("exit", (code) =>
                reject(new Error(`remote server exited ${code}: ${stderr}`)),
              );
            });
      const exited = once(server, "exit");
      t.after(async () => {
        const groupToStop =
          group ??
          Number.parseInt(
            await readFile(pidPath, "utf8").catch((error) => {
              if (error.code !== "ENOENT") throw error;
              return "";
            }),
            10,
          );
        if (Number.isInteger(groupToStop) && groupToStop > 0) {
          try {
            process.kill(-groupToStop, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        if (server.exitCode === null && server.signalCode === null) {
          server.kill("SIGKILL");
          await exited;
        }
        lines.close();
        await rm(directory, { recursive: true });
      });

      if (close === "stdout") server.stdout.destroy();
      server.stdin.write(
        JSON.stringify({
          id: 1,
          method: "exec",
          args: [["sh", "-c", source], {}],
          cwd: directory,
        }) + "\n",
      );
      group =
        close === "stdout"
          ? Number((await waitForFile(directory, "shell-pid")).trim())
          : await pidReady;
      if (close === "eof") server.stdin.end();
      else if (close === "sigterm") server.kill("SIGTERM");
      const [code, signal] = await exited;
      assert.equal(
        signal,
        null,
        `remote server exited by ${signal}: ${stderr}`,
      );
      assert.equal(code, 0, stderr);

      const markerCreated = waitForMarker(directory, marker);
      try {
        process.kill(-group, "SIGUSR1");
        await markerCreated;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      assert.deepEqual(
        await processGroup(group),
        [],
        "no detached command process may survive its remote environment",
      );
      await assert.rejects(readFile(markerPath), { code: "ENOENT" });
    },
  );
}
