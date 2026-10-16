# CLI Todo investigation — 2026-10-16

Research only: TASK-37, TASK-40, TASK-41, TASK-43, and TASK-45. No application code, tests, or configuration were changed. These recommendations incorporate Nick's decisions that all agent execution belongs in workspace pods, the management host is an access plane, bots broadly control agents, and agents control their own containers.

## Evidence and boundaries

Read the complete five Linear issues, relations, and comments (none had comments), home/project AGENTS.md, README, operations and implementation contracts, and the research/debugging skills. Existing uncommitted repository changes were left alone.

The public executable used was the existing `target/debug/adm`; no build was run. A throwaway `/tmp/adm-cli-detective.py` drove it against the existing fake-kubectl fixture extracted from [tests/cli.rs](../tests/cli.rs#L187), synthetic kubeconfig/config/state, and an isolated loopback HTTP fixture. No live cluster commands were executed. Raw evidence is temporarily in `/tmp/adm-cli-detective-xi41wgs0/results.json`; the CLI-termination probe is in `detach-result.json`. Temporary paths are session evidence, not durable dependencies of this note.

Seven desired-behavior probes were red for the expected reasons: successful bare help; grouped help; human doctor; doctor `--json`; equivalent list/status activity; nonblocking destruction; persisted cleanup failure. Existing help success/error behavior and offline-list/no-state-allocation guards passed.

Seven existing integration tests were executed directly from their already-compiled test binaries and passed: doctor causes/storage; local list/JSON; three status cases; immutable identity/name reuse; Herdr cleanup replay. These verify today's contract, not the requested new behavior. Some existing tests deliberately assert behavior these tickets will change.

## TASK-37 + TASK-45: merge the two help changes

**Observed.** Bare `adm` exits 2 with empty stdout and `requires a subcommand` on stderr. `adm help` and `adm --help` both exit 0 with identical stdout. There are 22 actual top-level commands plus Clap's generated `help`, under one `Commands:` heading. Invalid commands still exit 2. Help and doctor did not allocate a workspace database in the fresh fixture.

**Cause.** The required `Cli.command: Action` is [src/main.rs:35](../src/main.rs#L35). The complete flat command declaration is [src/main.rs:39](../src/main.rs#L39), with parsing at [src/main.rs:880](../src/main.rs#L880). Help exits before default configuration and command dispatch, so it can remain independent of a runner, cluster, model, or even a malformed user configuration.

**Smallest coherent scope.** Merge TASK-37 into TASK-45 (or retain TASK-37 and rename it “Show grouped help for bare adm and explicit help”). Both change the same top-level help entry point and should share one executable test. Preserve all command names, arguments, aliases, command-specific help, and ordinary parse errors. Generate descriptions from Clap's existing command metadata, rather than maintaining a second handwritten command-description inventory.

Proposed grouping:

| Workspace commands                                                                                            | ADM management                                                  |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| create, list, status, inspect, destroy, reconnect, attach, shell, exec, port, prompt, abort, history, browser | manifest, setup, login, start, serve, stop, doctor, herdr, help |

Keep `reconnect` with the workspace it repairs and `manifest` with operational diagnostics. This is presentation grouping, not new nested CLI syntax. The installed Clap builder exposes one `subcommand_help_heading`; argument `help_heading` settings alone do not provide multiple subcommand groups. Choose a small top-level rendering/customization seam and preserve Clap for parsing and per-command help.

**Test first.** Invoke the real executable with no arguments, `help`, and `--help`; require successful stdout containing the same grouped content and every supported command exactly once. Run with nonexistent kubectl/runner and a malformed config, and assert no state is created. Check `help create`/`create --help`, `herdr --help`, an invalid command, and an invalid flag. The current bare/group assertions already fail without modifying implementation.

**Dependencies.** Independent of pod migration and the lifecycle service. Coordinate Herdr discoverability with TASK-44, but no hard dependency is justified.

## TASK-40: align meanings before adding data

**Observed on the same workspace records.**

```text
adm list
NAME        ROLE    PHASE  AGENT     ID
idle        coding  ready  enabled   <immutable-id>
busy        coding  ready  enabled   <immutable-id>
shell-only  coding  ready  disabled  <immutable-id>

adm status idle
NAME  ROLE    PHASE  POD                 AGENT  NODE
idle  coding  ready  NotReady (Running)  idle   node-a
Pod readiness: ContainersNotReady
```

The busy row's status reports `running`. Both list and status truthfully show the stored creation phase `ready` while the Pod is currently NotReady: creation history and live readiness are separate dimensions. A trace of the fixture confirmed that `list` makes **zero** HTTP/kubectl calls. Its agent field is configuration, while status's agent field is current runner activity. A failed cluster query becomes explicit `unavailable` while preserving local state.

**Cause and existing contract.** [src/main.rs:276](../src/main.rs#L276) renders `agent_enabled` as AGENT; [src/main.rs:323](../src/main.rs#L323) gathers live status; [src/main.rs:385](../src/main.rs#L385) renders activity under AGENT. [tests/cli.rs:410](../tests/cli.rs#L410) and [docs/operations.md](operations.md) deliberately specify an offline list with complete stored records under `--json`. Status and inspect share the complete JSON payload, checked at [tests/cli.rs:1274](../tests/cli.rs#L1274). The runner's activity values are defined at [packages/runner/src/workspace.ts:366](../packages/runner/src/workspace.ts#L366).

**Recommended product shape.** Keep one ticket. Shared labels must distinguish `Phase` (persisted lifecycle), `Agent configured` (enabled/disabled), `Agent` (live idle/running/error/unavailable), and `Runtime` (Pod readiness). Make list the overview and status a labeled expansion with ID, namespace, model/configuration, node/readiness, resources, and failure causes; keep inspect for raw diagnostic detail.

If the overview is intended to show activity, fetch **one** existing `GET /v1/workspaces` response and join by immutable ID; do not call the full status implementation once per row. A missing/unreachable live record must say `unavailable`, never `idle`. Current HTTP requests can take up to 60 seconds ([src/runner.rs:27](../src/runner.rs#L27)), and full coding status also invokes kubectl twice. Define a bounded overview request and an explicit unavailable result. Pod readiness can remain a per-workspace status detail, avoiding a cluster fanout just to list activity. Deliberately retain/document the existing `list --json` record shape, or explicitly define its extension before changing tests.

The smallest alternative preserves list's offline contract and renames its AGENT column `AGENT CONFIG`; it fixes the semantic collision but does not give an activity overview. That is a product tradeoff, not an implementation detail to hide.

**Test first.** Create multiple coding/bot records through the public CLI with synthetic runner statuses for idle/running/error, plus disabled agents, failed creation, deletion, and missing runner records. Compare the meaning of shared list/status fields; assert one batch overview request, no per-row cluster calls, explicit unavailable data, complete JSON, and useful selected-workspace details. Preserve NotReady-with-Running and initialization failure coverage. Existing status tests are at [tests/cli.rs:1274](../tests/cli.rs#L1274), [tests/cli.rs:1434](../tests/cli.rs#L1434), and the following cluster-failure case.

**Dependencies.** Field alignment does not need TASK-22 to finish. TASK-22 must remove current hardcoded bot “management host/no Pod” reporting at [src/main.rs:391](../src/main.rs#L391) and [src/main.rs:545](../src/main.rs#L545). Integrate the overview with the new pod directory when it arrives. TASK-41 adds deletion progress/failure detail consumed by this output; do not merge the two tickets merely because both touch status.

## TASK-41: durable cleanup needs an owner outside the workspace

**Observed.** At a deterministic fake-kubectl finalization gate, default `destroy` remained running with phase `deleting`, a durable tombstone already present, and these arguments:

```text
delete namespace <owned-namespace>
--ignore-not-found=true --wait=true --timeout=180s
```

Only releasing finalization let the CLI print phase `deleted`. `destroy NAME --wait` is currently rejected by the argument parser. The fixture observed agent cancellation via HTTP DELETE before namespace deletion. Repeating destruction by immutable ID succeeds; recreating the label obtains a new ID, and destroying the old ID leaves the new namespace intact.

**Additional reproduced gap.** A forced deletion failure exits 1 and prints its exact cause, but the stored workspace remains `deleting` with `last_error: null`. In a second probe, terminating only the CLI while its fake kubectl child was waiting, then allowing that child to finish, removed the namespace but left durable metadata stuck at `deleting` with no error. Resource deletion and completion recording currently depend on that foreground process surviving.

**Current owners.**

- Rust [src/workspaces.rs:712](../src/workspaces.rs#L712) verifies ownership, writes deleting state/tombstone, cancels agent activity, waits for namespace removal, and finally stores `deleted`. Failures after admission do not persist a cleanup error. A durable tombstone prevents recovery/admissions, but is not itself a cleanup worker.
- Runner [packages/runner/src/main.ts:609](../packages/runner/src/main.ts#L609) DELETE tombstones and closes the Durable workspace; it does not delete Kubernetes resources or reconcile Rust's workspace database. Startup [packages/runner/src/main.ts:233](../packages/runner/src/main.ts#L233) opens its registered sessions passively when tombstoned; it has no general resource-deletion recovery loop.
- [packages/runner/src/workspace.ts:645](../packages/runner/src/workspace.ts#L645) cancels background work and cleans up environments before closing the store.
- Herdr [src/herdr.rs:82](../src/herdr.rs#L82) fsyncs a close journal and invokes that same foreground destruction path. Its replay at [src/herdr.rs:130](../src/herdr.rs#L130) recovers received Herdr closes, not arbitrary CLI destroy requests. Waiting for one namespace also delays consumption of later Herdr events.

**Recommended split.** Extract one shared prerequisite ticket: **“Persist and reconcile workspace lifecycle operations in an in-cluster service.”** Its narrow concern is owned lifecycle intent/admission, cancellation fencing, deletion progress, and completion/failure recovery. Place it outside namespaces it destroys. Persist operations by immutable workspace ID with one owner/restart-safe admission and ownership verification on cleanup attempts. CLI, Herdr close events, and bot lifecycle tools must call this same contract. An acknowledged deletion must reject new/recovered activity and cannot disappear on a CLI/service restart. Expose operation status/error/timings for observers. Keep identity and live connection metadata authoritative in one place; do not quietly create two independent lifecycle databases on host and cluster.

This service belongs in Kubernetes under Nick's access-plane decision. Do not add a persistent host worker, and do not rely on the agent pod to finalize its own deletion. The specific persistence primitive need not be settled in this investigation; durable lifecycle state and one authoritative owner are the required seam. Existing local SQLite state will need an explicit lifecycle-metadata handoff; moving agent history is separate TASK-22 work.

Then keep TASK-41 as the CLI behavior change: default returns after the service durably admits deletion; `--wait` observes the same operation until confirmed completion or a visible failure. Repeated requests use the same immutable operation/target, status shows requested/in-progress/failed/completed, and reconnecting a waiter does not start another deletion. Do not treat `kubectl --wait=false` or an unsupervised detached child as fulfillment.

**Test first.** Turn the existing delayed-removal fixture at [tests/cli.rs:260](../tests/cli.rs#L260) into two cases: default returns while finalization is gated; `--wait` remains blocked until confirmation. Kill the admitting CLI; kill/restart the lifecycle owner between durable admission, cancellation, namespace deletion, and completion recording; then require convergence without reviving agent input/goals/loops. Inject delete failure and require persisted cause/status. Repeat by ID, reuse the human label, replace ownership, and verify only the intended resource is affected. Have CLI and Herdr/bot request the same deletion concurrently. Cancellation and typed HTTP error guards already exist at [tests/cli.rs:1009](../tests/cli.rs#L1009); ownership at [tests/cli.rs:1576](../tests/cli.rs#L1576); Herdr replay at [tests/cli.rs:1730](../tests/cli.rs#L1730).

**Dependencies.** TASK-41 and bot lifecycle control in TASK-36 depend on the shared lifecycle seam. TASK-44 should submit its journaled closes there and test recovery. Coordinate this service's boundary with TASK-22, but do not require all of history migration/runtime redesign before beginning narrowly scoped lifecycle work. Keep the CLI output ticket separate from this prerequisite.

## TASK-43: one report, two renderings

**Observed.** Default doctor exits 0 with complete JSON (tools, cluster, clusterError, storage, runner, state). `doctor --json` exits 2 as an unknown argument. Healthy fixtures identify the ready node and selected replicated StorageClass, retaining the note that class availability does not prove replication or a failure loss window. The existing doctor integration test additionally passed missing-storage, local-path, replicated-class, and runner-503-cause cases. Doctor did not create a workspace database.

**Cause and smallest scope.** [src/diagnostics.rs:6](../src/diagnostics.rs#L6) gathers a report and always calls `print_json`; [src/main.rs:127](../src/main.rs#L127) has only the StorageClass flag. Add the explicit format flag, collect the same report once, and render labeled human rows by default. Preserve the complete existing JSON keys/values with `--json`; keep stored-config/explicit StorageClass precedence in [src/main.rs:923](../src/main.rs#L923). Preserve missing-storage actions, local-path warning, actual cluster/runner causes, and the replication caveat.

Tool checks currently collapse a missing executable and a failed `--version` into the same boolean ([src/diagnostics.rs:7](../src/diagnostics.rs#L7)). Do not invent a more specific cause in the new renderer. Retaining existing causes and labeling unavailable tools is presentation; expanding tool probe diagnostics would be a deliberate report-schema extension. No new provisioning, health semantics, dependency installation, or automatic recovery belongs in this ticket. Today's doctor returns success even with unavailable components; changing that exit policy should be explicit separate work.

**Test first.** Extend [tests/doctor.rs:11](../tests/doctor.rs#L11) to exercise default human and explicit JSON output against healthy and unavailable fixtures. This is the repository's current doctor JSON-parsing caller and must pass `--json` deliberately. Require tool/node/storage/runner/state labels, actual returned failure messages, meaningful next action/warnings, selected-class precedence, and no allocated state or apply/create/delete calls. Preserve `--json` report parity independently of human whitespace.

**Dependencies.** No hard dependency. Keep separate from TASK-40: these are distinct command contracts and test seams, despite both being formatting work.

## Suggested Linear investigation summaries

- **Merged TASK-37/TASK-45:** Confirmed bare invocation exits 2; explicit help succeeds but is flat. One top-level help change can make all three entry points use grouped content while retaining all 23 command entries and parse errors. Scope: CLI help metadata/renderer and one real-executable integration test; independent of runtime architecture.
- **TASK-40:** Reproduced AGENT=`enabled` in offline list versus `idle/running` in live status; `ready` phase is stored creation state and may coexist with NotReady Pod. Recommend a compact activity overview from one batch directory request and detailed selected status, with explicit unavailable results and separate configuration/lifecycle/readiness meanings. Decide/preserve the JSON contract deliberately; no per-workspace request fanout.
- **TASK-41:** Reproduced blocking namespace finalization, absent `--wait`, and stuck `deleting` after CLI termination; cleanup failure is not persisted. Split shared durable in-cluster lifecycle ownership from the CLI default/`--wait` change. Reuse that service for Herdr/bot requests, preserving cancellation and immutable target protection. Avoid host/background-child cleanup ownership.
- **TASK-43:** Confirmed default JSON and rejected `--json`; existing unavailable/storage-cause fixtures pass. Add human rendering plus explicit JSON over one report; preserve causes, caveats, state read-only behavior, and existing exit semantics. Keep as independent presentation work.
