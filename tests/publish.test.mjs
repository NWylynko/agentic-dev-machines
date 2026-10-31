import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import YAML from "yaml";

const workflow = YAML.parse(await readFile(new URL("../.github/workflows/build.yml", import.meta.url), "utf8"));
const execute = promisify(execFile);
const assetNames = [
  "adm-linux-amd64.tar.gz", "adm-linux-arm64.tar.gz", "adm-darwin-amd64.tar.gz", "adm-darwin-arm64.tar.gz",
  "install.sh", "LICENSE", "adm-linux-amd64", "adm-linux-arm64", "adm-darwin-amd64", "adm-darwin-arm64",
  "adm-repositories-linux-amd64", "adm-repositories-linux-arm64", "SHA256SUMS",
];
// History is oldest first. newerCommit is the later main commit, but its prefix
// sorts before olderCommit, so hexadecimal order cannot choose the default download.
const newerCommit = "0123456789ab" + "1".repeat(28);
const olderCommit = "fedcba987654" + "2".repeat(28);
const unrelatedCommit = "999999999999" + "9".repeat(28);

async function assertFailure(promise, pattern) {
  const error = await promise.then(
    () => assert.fail("expected publish to fail"),
    (value) => value,
  );
  assert.match(error.stderr ?? "", pattern);
  return error;
}

async function releaseFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "adm-publish-"));
  t.after(() => rm(directory, { recursive: true }));
  const commands = join(directory, "commands"),
    statePath = join(directory, "github.json");
  await mkdir(commands);
  await mkdir(join(directory, "dist"));
  await writeFile(
    statePath,
    JSON.stringify({ releases: {}, latest: null, commits: [olderCommit, newerCommit], creations: 0 }),
  );
  const gh = join(commands, "gh");
  await writeFile(
    gh,
    String.raw`#!/usr/bin/env python3
import json, os, pathlib, sys
arguments = sys.argv[1:]
state_path = pathlib.Path(os.environ["ADM_PUBLISH_STATE"])
state = json.loads(state_path.read_text())
def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)
def option(name):
    for index, argument in enumerate(arguments):
        if argument == name and index + 1 < len(arguments):
            return arguments[index + 1]
        if argument.startswith(name + "="):
            return argument.split("=", 1)[1]
    return None
def missing():
    print("gh: Not Found (HTTP 404)", file=sys.stderr)
    sys.exit(1)
if not arguments:
    fail("missing gh command")
if arguments[0] == "api":
    if state.get("apiFailure"):
        fail("GitHub API authentication failed (HTTP 403)")
    endpoint = arguments[1]
    expression = option("--jq")
    prefix = "repos/" + os.environ["GITHUB_REPOSITORY"] + "/"
    if not endpoint.startswith(prefix):
        fail("unexpected API repository: " + endpoint)
    path = endpoint[len(prefix):]
    if path == "releases/latest":
        if expression != ".tag_name":
            fail("unexpected latest jq: " + str(expression))
        tag = state.get("latest")
        release = None if tag is None else state["releases"].get(tag)
        if release is None:
            missing()
        print(tag)
    elif path.startswith("releases/tags/"):
        if expression != ".draft":
            fail("unexpected tag jq: " + str(expression))
        release = state["releases"].get(path[len("releases/tags/"):])
        if release is None:
            missing()
        print("true" if release.get("draft") else "false")
    elif path.startswith("compare/"):
        if expression != ".status":
            fail("unexpected compare jq: " + str(expression))
        base, head = path[len("compare/"):].split("...")
        commits = state["commits"]
        def resolve(ref):
            if ref in commits:
                return ref
            release = state["releases"].get(ref)
            if release is None:
                return None
            commit = release.get("commit", release.get("target"))
            return commit if commit in commits else None
        base_commit, head_commit = resolve(base), resolve(head)
        if base_commit is None or head_commit is None:
            print("diverged")
        elif commits.index(head_commit) > commits.index(base_commit):
            print("ahead")
        elif commits.index(head_commit) < commits.index(base_commit):
            print("behind")
        else:
            print("identical")
    else:
        fail("unexpected API endpoint: " + endpoint)
elif arguments[:2] == ["release", "create"]:
    if option("--repo") != os.environ["GITHUB_REPOSITORY"]:
        fail("release create requires explicit --repo without checkout")
    tag = arguments[2]
    if tag in state["releases"]:
        fail("release already exists; immutable assets cannot be replaced")
    target = option("--target")
    notes = option("--notes-file")
    latest = option("--latest")
    if not target:
        fail("release create requires --target")
    if not notes:
        fail("release create requires --notes-file")
    if latest not in ("true", "false"):
        fail("release must choose latest explicitly")
    assets = {pathlib.Path(argument).name: pathlib.Path(argument).read_text() for argument in arguments[3:] if argument.startswith("dist/")}
    state["releases"][tag] = {"target": target, "commit": target, "assets": assets, "body": pathlib.Path(notes).read_text(), "prerelease": "--prerelease" in arguments, "draft": "--draft" in arguments, "latestFlag": latest}
    state["creations"] += 1
    if latest == "true":
        state["latest"] = tag
    state_path.write_text(json.dumps(state))
    print("https://github.com/" + os.environ["GITHUB_REPOSITORY"] + "/releases/tag/" + tag)
else:
    fail("unexpected gh command: " + " ".join(arguments))
`,
  );
  await chmod(gh, 0o755);
  const environment = {
    ...process.env,
    PATH: `${commands}:${process.env.PATH}`,
    ADM_PUBLISH_STATE: statePath,
    GITHUB_REPOSITORY: "NWylynko/agentic-dev-machines",
    GITHUB_EVENT_NAME: "push",
    GH_TOKEN: "fixture-token",
  };
  delete environment.GH_REPO;
  delete environment.GITHUB_TOKEN;
  const step = workflow.jobs.release.steps.find((entry) => entry.name === "Publish GitHub release");
  return {
    async artifacts(label) {
      for (const platform of ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"]) {
        const platformDir = join(directory, "dist", `adm-${platform}`);
        await mkdir(platformDir, { recursive: true });
        for (const name of [`adm-${platform}.tar.gz`, `adm-${platform}`])
          await writeFile(join(platformDir, name), `${label}: ${name}\n`);
        if (platform.startsWith("linux-"))
          await writeFile(join(platformDir, `adm-repositories-${platform}`), `${label}: adm-repositories-${platform}\n`);
      }
      await writeFile(join(directory, "dist/adm-linux-amd64/install.sh"), `${label}: install.sh\n`);
      await writeFile(join(directory, "dist/adm-linux-amd64/LICENSE"), `${label}: LICENSE\n`);
      await execute(process.execPath, [resolve("scripts/assemble-release.mjs"), "--dist", join(directory, "dist")]);
    },
    async state(update) {
      const value = JSON.parse(await readFile(statePath, "utf8"));
      if (update) {
        update(value);
        await writeFile(statePath, JSON.stringify(value));
      }
      return value;
    },
    async publish(commit, ref = "refs/heads/main") {
      return execute("bash", ["-e", "-o", "pipefail", "-c", step.run], {
        cwd: directory,
        env: {
          ...environment,
          GITHUB_SHA: commit,
          GITHUB_REF: ref,
          GITHUB_REF_NAME: basename(ref),
          GITHUB_REF_TYPE: ref.startsWith("refs/tags/") ? "tag" : "branch",
        },
      });
    },
  };
}

test("main and version builds publish only after the image and binaries succeed", () => {
  const release = workflow.jobs.release;
  const eligible = new Function("github", "startsWith", `return (${release.if});`);
  const startsWith = (value, prefix) => value.startsWith(prefix);
  assert.deepEqual(release.needs, ["image", "binaries"]);
  const platforms = workflow.jobs.binaries.strategy.matrix.include.map((entry) => entry.platform).sort();
  assert.deepEqual(platforms, ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"]);
  assert.ok(release.steps.some((entry) => entry.name === "Assemble all platform assets and checksums"));
  for (const event_name of ["push", "workflow_dispatch"]) {
    assert.equal(eligible({ ref: "refs/heads/main", event_name }, startsWith), true);
  }
  assert.equal(eligible({ ref: "refs/tags/v1.2.3", event_name: "push" }, startsWith), true);
  assert.equal(eligible({ ref: "refs/heads/main", event_name: "pull_request" }, startsWith), false);
  assert.equal(eligible({ ref: "refs/pull/42/merge", event_name: "pull_request" }, startsWith), false);
  assert.equal(eligible({ ref: "refs/heads/feature", event_name: "workflow_dispatch" }, startsWith), false);
});

test("main publishes a complete immutable release and rerunning keeps its existing assets", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.artifacts("first build");
  await fixture.publish(newerCommit);
  let state = await fixture.state();
  assert.equal(state.latest, "sha-0123456789ab");
  const release = state.releases[state.latest];
  assert.equal(release.target, newerCommit);
  assert.equal(release.latestFlag, "true");
  assert.equal(release.prerelease, false);
  assert.equal(release.draft, false);
  assert.deepEqual(Object.keys(release.assets).sort(), [...assetNames].sort());
  for (const role of ["adm-control", "adm-repositories", "adm-workspace", "adm-code", "adm-bot"])
    assert.match(release.body, new RegExp(`agentic-dev-machines/${role}:sha-0123456789ab`));
  assert.match(release.body, /releases\/download\/sha-0123456789ab\/install\.sh/);
  await fixture.artifacts("rerun must not replace published bytes");
  await fixture.publish(newerCommit);
  state = await fixture.state();
  assert.equal(state.creations, 1);
  assert.deepEqual(state.releases[state.latest], release);
});

test("a later main build becomes the default download without changing the previous release", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.artifacts("older");
  await fixture.publish(olderCommit);
  const previous = (await fixture.state()).releases["sha-fedcba987654"];
  await fixture.artifacts("newer");
  await fixture.publish(newerCommit);
  const state = await fixture.state();
  assert.equal(state.latest, "sha-0123456789ab");
  assert.equal(state.releases["sha-0123456789ab"].latestFlag, "true");
  assert.equal(state.releases["sha-0123456789ab"].target, newerCommit);
  assert.equal(state.releases["sha-0123456789ab"].assets["install.sh"], "newer: install.sh\n");
  assert.deepEqual(state.releases["sha-fedcba987654"], previous);
});

test("an older main build keeps its own release without moving the newer default download", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.artifacts("newer");
  await fixture.publish(newerCommit);
  await fixture.artifacts("older");
  await fixture.publish(olderCommit);
  const state = await fixture.state();
  assert.equal(state.latest, "sha-0123456789ab");
  assert.equal(state.creations, 2);
  assert.equal(state.releases["sha-fedcba987654"].latestFlag, "false");
  assert.equal(state.releases["sha-fedcba987654"].target, olderCommit);
  assert.match(state.releases["sha-fedcba987654"].assets.SHA256SUMS, /adm-darwin-arm64\.tar\.gz/);
  assert.match(state.releases["sha-0123456789ab"].assets.SHA256SUMS, /adm-darwin-arm64\.tar\.gz/);
  assert.notEqual(
    state.releases["sha-fedcba987654"].assets.SHA256SUMS,
    state.releases["sha-0123456789ab"].assets.SHA256SUMS,
  );
});

test("a main build unrelated to the current default publishes without replacing it", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.artifacts("current");
  await fixture.publish(newerCommit);
  await fixture.artifacts("unrelated");
  await fixture.publish(unrelatedCommit);
  const state = await fixture.state();
  assert.equal(state.latest, "sha-0123456789ab");
  assert.equal(state.releases["sha-999999999999"].latestFlag, "false");
  assert.equal(state.releases["sha-999999999999"].target, unrelatedCommit);
});

test("version tags stay pinned and never replace the default download", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.artifacts("version before any main release");
  await fixture.publish(newerCommit, "refs/tags/v1.2.3");
  let state = await fixture.state();
  assert.equal(state.latest, null);
  assert.equal(state.releases["v1.2.3"].latestFlag, "false");
  assert.equal(state.releases["v1.2.3"].target, newerCommit);
  assert.match(state.releases["v1.2.3"].body, /releases\/download\/v1\.2\.3\/install\.sh/);
  assert.match(state.releases["v1.2.3"].body, /agentic-dev-machines\/adm-code:sha-0123456789ab/);

  await fixture.artifacts("older main");
  await fixture.publish(olderCommit);
  assert.equal((await fixture.state()).latest, "sha-fedcba987654");

  await fixture.artifacts("newer version");
  await fixture.publish(newerCommit, "refs/tags/v1.2.4");
  const pinned = (await fixture.state()).releases["v1.2.4"];
  assert.equal(pinned.latestFlag, "false");
  assert.equal(pinned.target, newerCommit);
  assert.equal((await fixture.state()).latest, "sha-fedcba987654");

  await fixture.artifacts("version rerun must not replace published bytes");
  await fixture.publish(newerCommit, "refs/tags/v1.2.4");
  state = await fixture.state();
  assert.equal(state.creations, 3);
  assert.deepEqual(state.releases["v1.2.4"], pinned);
});

test("a main build of the same commit becomes the default download", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.state((state) => {
    state.releases["v9.9.9"] = {
      target: newerCommit,
      assets: {},
      body: "pinned",
      prerelease: false,
      draft: false,
      latestFlag: "true",
    };
    state.latest = "v9.9.9";
  });
  await fixture.artifacts("main");
  await fixture.publish(newerCommit);
  const state = await fixture.state();
  assert.equal(state.latest, "sha-0123456789ab");
  assert.equal(state.releases["sha-0123456789ab"].latestFlag, "true");
  assert.equal(state.releases["v9.9.9"].body, "pinned");
});

test("a draft release fails instead of being treated as published", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.artifacts("partial");
  await fixture.state((state) => {
    state.releases["sha-0123456789ab"] = {
      target: newerCommit,
      assets: {},
      body: "",
      prerelease: false,
      draft: true,
      latestFlag: "false",
    };
  });
  await assertFailure(fixture.publish(newerCommit), /draft/);
  const state = await fixture.state();
  assert.equal(state.creations, 0);
  assert.equal(state.latest, null);
});

test("a latest release recorded on a branch name still yields to a later main commit", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.state((state) => {
    state.releases["v0.1.0"] = {
      target: "main",
      commit: olderCommit,
      assets: {},
      body: "tagged",
      prerelease: false,
      draft: false,
      latestFlag: "true",
    };
    state.latest = "v0.1.0";
  });
  await fixture.artifacts("later main");
  await fixture.publish(newerCommit);
  const state = await fixture.state();
  assert.equal(state.latest, "sha-0123456789ab");
  assert.equal(state.releases["v0.1.0"].body, "tagged");
});

test("a GitHub API failure stops publication before a release is created", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.artifacts("build");
  await fixture.state((state) => {
    state.apiFailure = true;
  });
  await assertFailure(fixture.publish(newerCommit), /HTTP 403/);
  const state = await fixture.state();
  assert.equal(state.creations, 0);
  assert.equal(state.latest, null);
});
