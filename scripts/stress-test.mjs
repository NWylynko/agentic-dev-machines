#!/usr/bin/env node
// Repeats one node:test file (optionally one test name) to reproduce intermittent
// failures and hangs. A run that outlives --deadline is a HANG: its whole process
// group (test runner plus spawned runtimes) is killed and its TAP log kept.
//
//   node scripts/stress-test.mjs packages/runner/test/http.test.mjs \
//     --name "lifecycle against the caller" --runs 20 --parallel 2 --deadline 40
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    runs: { type: "string", default: "20" },
    parallel: { type: "string", default: "1" },
    deadline: { type: "string", default: "60" },
  },
});
const [file] = positionals;
if (!file) throw new Error("usage: stress-test.mjs TEST_FILE [--name PATTERN]");
const runs = Number(values.runs);
const deadlineMs = Number(values.deadline) * 1000;
const logs = await mkdtemp(join(tmpdir(), "adm-stress-"));
const outcomes = { PASS: 0, FAIL: 0, HANG: 0 };

async function stressRun(index) {
  const log = join(logs, `${index}.log`);
  const output = createWriteStream(log);
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      ...(values.name ? [`--test-name-pattern=${values.name}`] : []),
      file,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  let hung = false;
  const deadline = setTimeout(() => {
    hung = true;
    process.kill(-child.pid, "SIGKILL");
  }, deadlineMs);
  const [code] = await once(child, "exit");
  clearTimeout(deadline);
  const outcome = hung ? "HANG" : code === 0 ? "PASS" : "FAIL";
  outcomes[outcome] += 1;
  console.log(`${outcome} ${index}${outcome === "PASS" ? "" : ` ${log}`}`);
}

let next = 1;
await Promise.all(
  Array.from({ length: Number(values.parallel) }, async () => {
    while (next <= runs) await stressRun(next++);
  }),
);
console.log(JSON.stringify({ ...outcomes, logs }));
process.exitCode = outcomes.PASS === runs ? 0 : 1;
