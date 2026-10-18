import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

async function startRunner(directory) {
  const child = spawn(
    process.execPath,
    [
      new URL("../src/main.ts", import.meta.url).pathname,
      "--port",
      "0",
      "--state-dir",
      join(directory, "state"),
      "--provider",
      "faux",
      "--model",
      "faux-1",
    ],
    {
      env: { ...process.env, HOME: directory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`runner exited ${code}: ${errors}`)),
    );
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.ready) resolve(event.url);
      } catch {}
    });
  });
  return {
    async inspectPrompt(path) {
      const controller = new AbortController();
      const stream = await fetch(url + path + "/events", {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      const reader = stream.body.getReader();
      try {
        const admitted = await this.request(path + "/input", "POST", {
          message: "/faux-inspect-system-prompt",
          requestId: "resource-prompt-inspection",
        });
        assert.equal(admitted.status, 202);
        let buffer = "";
        const decoder = new TextDecoder();
        for (;;) {
          const part = await reader.read();
          if (part.done)
            throw new Error("Runner events closed before prompt inspection");
          buffer += decoder.decode(part.value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trimEnd();
            buffer = buffer.slice(newline + 1);
            if (line.startsWith("data: ")) {
              const event = JSON.parse(line.slice(6));
              if (event.kind === "assistant")
                return JSON.parse(event.data.text);
            }
          }
        }
      } finally {
        controller.abort();
        await reader.cancel().catch(() => {});
      }
    },
    async request(path, method = "GET", data) {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: response.status, body: await response.json() };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      lines.close();
    },
  };
}

test(
  "workspace resource discovery honors persistent project trust and reload without executing extensions",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-resources-"));
    const project = join(directory, "project");
    for (const path of ["prompts", "skills/review", "extensions", "themes"])
      await mkdir(join(project, ".pi", path), { recursive: true });
    await writeFile(
      join(project, "AGENTS.md"),
      "Use the workspace conventions.",
    );
    await writeFile(
      join(project, ".pi/prompts/review.md"),
      "---\ndescription: Review changes\n---\nReview $ARGUMENTS carefully.",
    );
    await writeFile(
      join(project, ".pi/skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review a change\n---\nRead the complete diff.",
    );
    await writeFile(join(project, ".pi/SYSTEM.md"), "Workspace system prompt.");
    const theme = JSON.parse(
      await readFile(
        new URL(
          "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    theme.name = "workspace-theme";
    await writeFile(
      join(project, ".pi/themes/workspace.json"),
      JSON.stringify(theme),
    );
    const sentinel = join(directory, "extension-executed");
    await writeFile(
      join(project, ".pi/extensions/unsafe.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); export default () => {};`,
    );
    let runner = await startRunner(directory);
    t.after(async () => {
      await runner?.stop();
      await rm(directory, { recursive: true });
    });
    const path = "/v1/workspaces/resource-demo";
    assert.equal(
      (
        await runner.request(path, "PUT", {
          id: "resource-demo",
          name: "resources",
          role: "coding",
          environment: "local",
          localRoot: project,
          model: { provider: "faux", id: "faux-1" },
        })
      ).status,
      200,
    );
    const initial = await runner.request(path + "/resources");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.cwd, project);
    assert.deepEqual(initial.body.trust, {
      trusted: false,
      trustRequired: true,
      source: null,
    });
    assert.deepEqual(initial.body.prompts, []);
    assert.deepEqual(initial.body.skills, []);
    assert.deepEqual(initial.body.extensions, []);
    assert.equal(initial.body.systemPrompt, undefined);
    assert.ok(
      initial.body.agentsFiles.some((file) =>
        file.content.includes("workspace conventions"),
      ),
    );
    assert.equal(
      (await runner.request(path + "/trust", "PUT", { trusted: "yes" })).status,
      400,
    );
    const trusted = await runner.request(path + "/trust", "PUT", {
      trusted: true,
    });
    assert.equal(trusted.status, 200);
    assert.equal(trusted.body.trust.trusted, true);
    assert.equal(
      trusted.body.prompts[0].content,
      "Review $ARGUMENTS carefully.",
    );
    assert.match(trusted.body.skills[0].content, /complete diff/);
    assert.equal(
      trusted.body.skills[0].baseDir,
      join(project, ".pi/skills/review"),
    );
    assert.equal(trusted.body.skills[0].disableModelInvocation, false);
    assert.equal(trusted.body.skills[0].sourceInfo.scope, "project");
    assert.equal(trusted.body.prompts[0].sourceInfo.scope, "project");
    assert.equal(trusted.body.themes[0].json.name, "workspace-theme");
    assert.deepEqual(trusted.body.themes[0].json.colors, theme.colors);
    assert.equal(trusted.body.systemPrompt, "Workspace system prompt.");
    const providerMessages = await runner.inspectPrompt(path);
    const providerSystem = providerMessages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    assert.match(providerSystem, /Workspace system prompt\./);
    assert.match(providerSystem, /Use the workspace conventions\./);
    assert.match(providerSystem, /Review a change/);
    assert.ok(
      trusted.body.extensions.some(
        (extension) =>
          extension.path.endsWith("unsafe.js") && extension.active === false,
      ),
    );
    assert.ok(
      trusted.body.diagnostics.some((diagnostic) =>
        /not activated/.test(diagnostic.message),
      ),
    );
    await assert.rejects(access(sentinel), { code: "ENOENT" });
    await writeFile(
      join(project, ".pi/prompts/review.md"),
      "---\ndescription: Updated review\n---\nReview the updated changes.",
    );
    assert.equal(
      (await runner.request(path + "/resources")).body.prompts[0].description,
      "Review changes",
    );
    const reloaded = await runner.request(
      path + "/resources/reload",
      "POST",
      {},
    );
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.body.prompts[0].description, "Updated review");
    await runner.stop();
    runner = await startRunner(directory);
    assert.equal((await runner.request(path + "/trust")).body.trusted, true);
    assert.equal(
      (await runner.request(path + "/resources")).body.prompts[0].description,
      "Updated review",
    );
    assert.ok(
      (
        await readFile(
          join(directory, "state/sessions/resource-demo/pi/trust.json"),
          "utf8",
        )
      ).includes(project),
    );
    assert.equal(
      (await runner.request(path + "/trust", "PUT", { trusted: false })).body
        .prompts.length,
      0,
    );
    const parentTrust = await runner.request(path + "/trust", "PUT", {
      updates: [
        { path: directory, decision: true },
        { path: project, decision: null },
      ],
    });
    assert.equal(parentTrust.status, 200);
    assert.equal(parentTrust.body.trust.source, directory);
    assert.equal(parentTrust.body.trust.trusted, true);
    assert.equal(
      (
        await runner.request(path + "/trust", "PUT", {
          updates: [{ path: join(directory, "other-project"), decision: true }],
        })
      ).status,
      400,
    );
    await assert.rejects(access(sentinel), { code: "ENOENT" });
  },
);

test(
  "bot resource endpoints cannot read a configured coding directory",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-bot-resources-"));
    const runner = await startRunner(directory);
    t.after(async () => {
      await runner.stop();
      await rm(directory, { recursive: true });
    });
    const path = "/v1/workspaces/bot-resources";
    assert.equal(
      (
        await runner.request(path, "PUT", {
          id: "bot-resources",
          name: "bot resources",
          role: "bot",
          environment: "local",
        })
      ).status,
      200,
    );
    for (const [endpoint, method, data] of [
      ["resources", "GET"],
      ["trust", "GET"],
      ["trust", "PUT", { trusted: true }],
      ["resources/reload", "POST", {}],
    ]) {
      const response = await runner.request(
        path + "/" + endpoint,
        method,
        data,
      );
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, "CODING_RESOURCES_REQUIRED");
    }
  },
);
