import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

const main = new URL("../src/main.ts", import.meta.url);

test(
  "mutation endpoints reject non-object JSON bodies without affecting the workspace",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-runner-body-"));
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
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const exited = once(child, "exit");
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Runner exited ${code}: ${errors}`)),
      );
      lines.on("line", (line) => {
        try {
          const value = JSON.parse(line);
          if (value.ready) resolve(value);
        } catch {
          /* Other stdout is diagnostic. */
        }
      });
    });
    let url;
    try {
      ({ url } = await ready);
    } catch (error) {
      child.kill("SIGTERM");
      await exited;
      throw error;
    }
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      lines.close();
    });

    async function request(path, method = "GET", body) {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }

    const id = "body-validation-workspace";
    const path = `/v1/workspaces/${id}`;
    const config = {
      id,
      name: "body-validation",
      role: "coding",
      environment: "local",
      localRoot: join(directory, "repo"),
      model: { provider: "faux", id: "faux-1" },
    };
    assert.equal((await request(path, "PUT", config)).status, 200);

    for (const invalid of [null, [], "invalid"]) {
      for (const action of ["input", "abort", "goals", "loops", "resume"]) {
        const response = await request(`${path}/${action}`, "POST", invalid);
        assert.equal(
          response.status,
          400,
          `${action} should reject ${JSON.stringify(invalid)}`,
        );
        assert.equal(response.body.error.code, "INVALID_BODY");
      }
      const response = await request(path, "PUT", invalid);
      assert.equal(
        response.status,
        400,
        `PUT should reject ${JSON.stringify(invalid)}`,
      );
      assert.equal(response.body.error.code, "INVALID_BODY");
    }

    assert.equal((await request(`${path}/history`)).body.events.length, 0);
    const status = await request(path);
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "idle");
    assert.deepEqual(status.body.goals, []);
    assert.deepEqual(status.body.loops, []);
    assert.equal((await request(`${path}/abort`, "POST")).status, 200);
    assert.equal((await request("/health")).body.status, "ok");
  },
);
