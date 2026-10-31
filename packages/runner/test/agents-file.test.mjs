import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderAuthAuthority } from "../src/provider-auth-authority.ts";
import { startPodLifecycle, startPodRunner } from "./pod-fixture.ts";

const SHARED = "SHARED-AGENTS-SENTINEL follow the installation rules.";
const REPO = "REPO-AGENTS-SENTINEL follow this repository.";
const admBinary =
  process.env.ADM_BIN ??
  join(
    process.env.CARGO_TARGET_DIR ??
      new URL("../../../target", import.meta.url).pathname,
    "debug",
    "adm",
  );

function systemText(inspected) {
  return inspected
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

test(
  "a shared agents file reaches every coding agent on its next turn and never a bot",
  { timeout: 90000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "adm-agents-file-"));
    const logs = [];
    const authority = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
      log: (line) => logs.push(line),
    });
    await new Promise((resolve) =>
      authority.server.listen(0, "127.0.0.1", resolve),
    );
    const authorityUrl = `http://127.0.0.1:${authority.server.address().port}`;
    const tokenFile = join(directory, "lifecycle-token");
    await writeFile(tokenFile, "operator-lifecycle-token\n", { mode: 0o600 });
    const editorDir = join(directory, "editors");
    await mkdir(editorDir, { recursive: true });
    const editor = async (name, source) => {
      const path = join(editorDir, name);
      await writeFile(path, source, { mode: 0o700 });
      return path;
    };
    const failEditor = await editor(
      "fail.js",
      `const { writeFile } = require("node:fs/promises");
writeFile(process.argv[2], ${JSON.stringify(`${SHARED}\n`)}).then(() => process.exit(2));
`,
    );
    const unchangedEditor = await editor("unchanged.js", "process.exit(0);\n");
    const raceEditor = await editor(
      "race.js",
      `const { writeFile } = require("node:fs/promises");
(async () => {
  const response = await fetch(process.env.AUTHORITY_URL + "/v1/agents-file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "from the other client\\n", baseRevision: 0 }),
  });
  if (!response.ok) {
    console.error(await response.text());
    process.exit(2);
  }
  await writeFile(process.argv[2], "from the losing editor\\n");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    );
    const saveEditor = await editor(
      "save.js",
      `const { writeFile } = require("node:fs/promises");
writeFile(process.argv[2], ${JSON.stringify(`${SHARED}\n`)}).catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
    );
    const adm = async (
      args,
      { editor: editorCommand, allowFailure = false } = {},
    ) => {
      const child = spawn(
        admBinary,
        [
          ...args,
          "--lifecycle-url",
          authorityUrl,
          "--lifecycle-token-file",
          tokenFile,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, "client", "config"),
            XDG_STATE_HOME: join(directory, "client", "state"),
            XDG_DATA_HOME: join(directory, "client", "data"),
            ...(editorCommand
              ? {
                  EDITOR: `node ${editorCommand}`,
                  AUTHORITY_URL: authorityUrl,
                }
              : {}),
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const [code] = await once(child, "exit");
      if (!allowFailure)
        assert.equal(code, 0, `adm ${args.join(" ")}: ${stdout}${stderr}`);
      return { code, stdout, stderr };
    };
    const lifecycle = await startPodLifecycle({ authorityUrl });
    await mkdir(join(directory, "coding-one", "repos"), { recursive: true });
    await writeFile(
      join(directory, "coding-one", "repos", "AGENTS.md"),
      `${REPO}\n`,
    );
    await writeFile(
      join(directory, "coding-one", "repos", "keep-me.txt"),
      "private workspace file\n",
    );
    const coding = await startPodRunner(directory, lifecycle, {
      id: "coding-one",
      name: "coding one",
      role: "coding",
    });
    const codingTwo = await startPodRunner(directory, lifecycle, {
      id: "coding-two",
      name: "coding two",
      role: "coding",
    });
    const bot = await startPodRunner(directory, lifecycle, {
      id: "bot-agent",
      name: "supervisor",
      role: "bot",
    });
    let restarted;
    let createdLater;
    t.after(async () => {
      await coding.stop();
      await codingTwo.stop();
      await bot.stop();
      await restarted?.stop();
      await createdLater?.stop();
      await lifecycle.close();
      await authority.close();
      await rm(directory, { recursive: true });
    });
    const cursors = new Map();
    const inspect = async (agent, requestId) => {
      const after = cursors.get(agent.id) ?? 0;
      const accepted = await agent.request("/input", "POST", {
        message: "/faux-inspect-system-prompt",
        requestId,
      });
      assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
      const event = await agent.event(
        (item) =>
          item.kind === "assistant" &&
          item.seq > after &&
          String(item.data.text).startsWith("["),
        after,
      );
      cursors.set(agent.id, event.seq);
      return systemText(JSON.parse(event.data.text));
    };

    const before = await inspect(coding, "inspect-before");
    assert.equal(before.includes(SHARED), false);
    assert.equal(before.includes("Shared installation AGENTS.md"), false);
    assert.ok(before.includes(REPO), before);
    const initial = await adm(["agents-file", "--show"]);
    assert.match(initial.stdout, /revision: 0/);
    assert.equal(initial.stdout.includes(SHARED), false);

    const failed = await adm(["agents-file"], {
      editor: failEditor,
      allowFailure: true,
    });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /was not changed/);
    const unchanged = await adm(["agents-file"], { editor: unchangedEditor });
    assert.match(unchanged.stdout, /unchanged/);
    const raced = await adm(["agents-file"], {
      editor: raceEditor,
      allowFailure: true,
    });
    assert.notEqual(raced.code, 0);
    assert.match(raced.stderr, /revision/);
    assert.ok(
      logs.some((line) => line.includes("agents_file_rejected")),
      logs.join("\n"),
    );
    const shownAfterRace = await adm(["agents-file", "--show"]);
    assert.match(shownAfterRace.stdout, /from the other client/);
    assert.match(shownAfterRace.stdout, /revision: 1/);
    assert.equal(shownAfterRace.stdout.includes("losing editor"), false);

    const saved = await adm(["agents-file"], { editor: saveEditor });
    assert.match(saved.stdout, /revision 2/);
    assert.match(saved.stdout, /next turn/);
    const secondClient = await adm(["agents-file", "--show"]);
    assert.match(secondClient.stdout, /source: installation/);
    assert.match(secondClient.stdout, /revision: 2/);
    assert.ok(secondClient.stdout.includes(SHARED));
    const stored = JSON.parse(
      await readFile(join(directory, "authority", "agents-file.json"), "utf8"),
    );
    assert.equal(stored.revision, 2);
    assert.equal(stored.content, `${SHARED}\n`);

    for (const agent of [coding, codingTwo]) {
      const prompt = await inspect(agent, `inspect-after-${agent.id}`);
      assert.equal(prompt.split(SHARED).length - 1, 1, prompt);
      assert.match(prompt, /revision 2/);
      if (agent === coding) {
        assert.ok(prompt.indexOf(SHARED) < prompt.indexOf(REPO), prompt);
        assert.equal(prompt.split(REPO).length - 1, 1, prompt);
      }
      const runtime = (await agent.request("/runtime-status")).body;
      assert.deepEqual(
        {
          source: runtime.agentsFile.source,
          status: runtime.agentsFile.status,
          revision: runtime.agentsFile.revision,
        },
        { source: "installation", status: "current", revision: 2 },
      );
    }
    const botPrompt = await inspect(bot, "inspect-bot");
    assert.equal(botPrompt.includes(SHARED), false, botPrompt);
    assert.equal(botPrompt.includes("Shared installation AGENTS.md"), false);
    assert.equal(
      (await bot.request("/runtime-status")).body.agentsFile,
      undefined,
    );
    assert.equal(
      lifecycle.agentsFileRequests.some(
        (request) => request.sourceId === "bot-agent",
      ),
      false,
    );
    assert.match(
      await readFile(join(coding.directory, "repos", "AGENTS.md"), "utf8"),
      new RegExp(REPO),
    );

    lifecycle.failAgentsFile = true;
    const dropped = await inspect(coding, "inspect-unavailable");
    assert.equal(dropped.includes(SHARED), false, dropped);
    assert.ok(dropped.includes(REPO), dropped);
    const unavailable = (await coding.request("/runtime-status")).body;
    assert.equal(unavailable.agentsFile.status, "unavailable");
    assert.equal(unavailable.agentsFile.revision, null);
    assert.match(unavailable.agentsFile.error, /not applied/);
    assert.match(coding.errors, /agents_file_unavailable/);
    lifecycle.failAgentsFile = false;
    const restored = await inspect(coding, "inspect-restored");
    assert.equal(restored.split(SHARED).length - 1, 1, restored);

    const history = await coding.request("/history");
    assert.equal(history.status, 200);
    assert.match(JSON.stringify(history.body), /faux-inspect-system-prompt/);
    await coding.stop();
    restarted = await startPodRunner(directory, lifecycle, {
      id: "coding-one",
      name: "coding one",
      role: "coding",
    });
    assert.equal(
      await readFile(join(coding.directory, "repos", "keep-me.txt"), "utf8"),
      "private workspace file\n",
    );
    const afterRestart = await inspect(restarted, "inspect-restarted");
    assert.equal(afterRestart.split(SHARED).length - 1, 1, afterRestart);
    const restartedHistory = await restarted.request("/history");
    assert.match(
      JSON.stringify(restartedHistory.body),
      /faux-inspect-system-prompt/,
    );

    createdLater = await startPodRunner(directory, lifecycle, {
      id: "coding-three",
      name: "coding three",
      role: "coding",
    });
    const later = await inspect(createdLater, "inspect-later");
    assert.equal(later.split(SHARED).length - 1, 1, later);

    const reopened = await createProviderAuthAuthority({
      authPath: join(directory, "authority", "auth.json"),
    });
    await new Promise((resolve) =>
      reopened.server.listen(0, "127.0.0.1", resolve),
    );
    t.after(() => reopened.close());
    const persisted = await fetch(
      `http://127.0.0.1:${reopened.server.address().port}/v1/agents-file`,
    );
    assert.equal(persisted.status, 200);
    assert.equal((await persisted.json()).content, `${SHARED}\n`);
  },
);
