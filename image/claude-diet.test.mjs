// `adm claude` puts Claude Code on a diet: only the tools and context a coding
// agent needs, like Pi. Drives the real `adm-claude run` (the command the
// workspace's tmux session runs) and the real `claude` against a fake
// Anthropic API, and asserts on exactly what Claude sends the model.
// The claude.ai account extras (synced skills, claude.ai connectors) need a
// real subscription login to appear, so they are checked live with `/context`
// (docs/operations.md), not here.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startFakeAnthropic } from "./fake-anthropic.mjs";

const admClaude = new URL("./adm-claude", import.meta.url).pathname;
const claude = await promisify(execFile)("sh", ["-c", "command -v claude"])
  .then(({ stdout }) => stdout.trim())
  .catch(() => "");

// The built-in tools a workspace's Claude keeps (Nick, 2026-11-16).
const kept = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "ToolSearch", "Skill", "AskUserQuestion"];

test(
  "adm claude offers only the kept built-in tools, no bundled skills, and still the repo's own skills",
  { timeout: 120000, skip: claude ? false : "claude is not on PATH" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-claude-diet-"));
    const model = startFakeAnthropic(() => [{ type: "text", text: "done" }]);
    t.after(async () => {
      model.server.closeAllConnections();
      await new Promise((resolve) => model.server.close(resolve));
      await rm(directory, { recursive: true });
    });
    await new Promise((resolve) => model.server.listen(0, "127.0.0.1", resolve));

    const checkout = join(directory, "repo");
    await mkdir(join(checkout, ".claude", "skills", "repo-release"), { recursive: true });
    await writeFile(
      join(checkout, ".claude", "skills", "repo-release", "SKILL.md"),
      "---\nname: repo-release\ndescription: Cut a release of this repository.\n---\nRun the release script.\n",
    );
    const state = join(directory, "state");
    await mkdir(state);
    await writeFile(join(state, "mcp.json"), '{"mcpServers":{}}\n');
    const workspace = join(directory, "workspace.json");
    await writeFile(workspace, JSON.stringify({ name: "diet", cwd: checkout, repositories: true }));

    const child = spawn(admClaude, ["run", "-p", "hello"], {
      cwd: checkout,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        ADM_CLAUDE_STATE: state,
        ADM_WORKSPACE_CONFIG: workspace,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.server.address().port}`,
        ANTHROPIC_API_KEY: "sk-ant-fixture",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const [code] = await once(child, "close");
    assert.equal(code, 0, output);

    const turn = model.requests.find((body) => JSON.stringify(body.messages).includes("hello"));
    assert.ok(turn, `no model request carried the prompt:\n${output}`);
    const tools = turn.tools.map((tool) => tool.name).sort();
    const extra = tools.filter((name) => !kept.includes(name));
    assert.deepEqual(extra, [], `tools beyond the kept set: ${extra.join(", ")}`);
    for (const name of ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "Skill"])
      assert.ok(tools.includes(name), `${name} is offered`);

    const sent = JSON.stringify([turn.system, turn.messages]);
    for (const bundled of ["dataviz", "claude-api", "keybindings-help", "fewer-permission-prompts", "plugin-authoring"])
      assert.ok(!sent.includes(bundled), `bundled skill ${bundled} is not listed`);
    assert.ok(sent.includes("repo-release"), "the repo's own skill is still listed");
    assert.ok(sent.includes("kept on this machine's local disk"), "the /repos note is in the prompt");
  },
);
