import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const main = new URL("../src/main.ts", import.meta.url);

function contend(directory) {
  const child = spawn(
    process.execPath,
    [
      main.pathname,
      "--port",
      "0",
      "--state-dir",
      directory,
      "--provider",
      "faux",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  let diagnostics = "";
  child.stderr.on("data", (data) => {
    diagnostics += data;
  });
  const outcome = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve({ ready: false, diagnostics }));
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.ready) resolve({ ready: true, url: value.url });
      } catch {
        /* The readiness record is the only public stdout contract. */
      }
    });
  });
  return {
    child,
    outcome,
    async stop() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
      lines.close();
    },
  };
}

test(
  "simultaneous recovery admits exactly one runner owner",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "adm-owner-race-"));
    try {
      for (let round = 0; round < 4; round++) {
        // A dead process's file is normal after SIGKILL. All contenders see it.
        await writeFile(
          join(directory, "owner.json"),
          JSON.stringify({ pid: 2147483647, processStart: "dead" }),
        );
        const contenders = Array.from({ length: 6 }, () => contend(directory));
        try {
          const results = await Promise.all(
            contenders.map((item) => item.outcome),
          );
          const owners = results.filter((item) => item.ready);
          assert.equal(
            owners.length,
            1,
            `round ${round}: multiple processes acquired the same durable store`,
          );
          assert.equal((await fetch(owners[0].url + "/health")).status, 200);
        } finally {
          await Promise.all(contenders.map((item) => item.stop()));
        }
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);

test(
  "restored stale owner metadata cannot displace a live runner",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "adm-owner-restored-stale-"),
    );
    const first = contend(directory);
    t.after(async () => {
      await first.stop();
      await rm(directory, { recursive: true });
    });
    const current = await first.outcome;
    assert.equal(current.ready, true, current.diagnostics);
    assert.equal(
      (await stat(join(directory, "owner.sqlite"))).mode & 0o777,
      0o600,
    );

    await writeFile(
      join(directory, "owner.json"),
      JSON.stringify({ pid: 2147483647, processStart: "restored-dead-owner" }),
    );
    const second = contend(directory);
    try {
      const rejected = await second.outcome;
      assert.equal(rejected.ready, false);
      assert.match(
        rejected.diagnostics,
        /Another runner owns this state directory/,
      );
      assert.equal((await fetch(current.url + "/health")).status, 200);
    } finally {
      await second.stop();
    }
  },
);

test("a symlinked owner database is rejected without touching its target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adm-owner-symlink-state-"));
  const targetDirectory = await mkdtemp(
    join(tmpdir(), "adm-owner-symlink-target-"),
  );
  const target = join(targetDirectory, "external.sqlite");
  const runner = contend(directory);
  try {
    await writeFile(target, "leave this file alone", { mode: 0o644 });
    await symlink(target, join(directory, "owner.sqlite"));
    const result = await runner.outcome;
    assert.equal(result.ready, false);
    assert.match(result.diagnostics, /regular file|symbolic link/i);
    assert.equal((await stat(target)).mode & 0o777, 0o644);
    assert.equal(await readFile(target, "utf8"), "leave this file alone");
  } finally {
    await runner.stop();
    await rm(directory, { recursive: true });
    await rm(targetDirectory, { recursive: true });
  }
});
