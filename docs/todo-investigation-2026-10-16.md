# Todo investigation — 2026-10-16

Investigated the 12 Agentic Dev Machines Todo tickets against `748282de5c65f0474a80d5a66feccd44080a22cb`, existing binaries/tests, pinned Pi 1.2.0 source, GitHub repository metadata, and installed Herdr 0.9.3/protocol 22. This work changes research documentation and Linear scope only. No implementation, repository tests, deployments, real workspaces, or provider credentials were changed.

The target is settled: all agent computation belongs in workspace pods, the host is an access plane, bots broadly manage coding agents, and agents have unattended root/sudo inside their own containers. Earlier host execution, individual bot grants, and human-only sudo descriptions document the current implementation or superseded choices, not the required design.

**Early-alpha scope update:** build fresh workspaces in the new design. No legacy data/configuration import, compatibility layers, or upgrade workflows are needed. Persistence and restart correctness apply to newly created workspaces. TASK-49 is canceled; TASK-48 is merged back into TASK-22.

## Investigation and ticket structure

| Ticket                                              | Finding and implementation boundary                                                                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TASK-22](https://linear.app/wylynko/issue/TASK-22) | Single implementation item for fresh pod-local runtimes and authenticated access. No old-session transfer.                                                                                                                    |
| [TASK-35](https://linear.app/wylynko/issue/TASK-35) | The reported singular repository spelling fails; the plural public repository clones without credentials. Fix concise errors and accurate failed-workspace recovery, not speculative GitHub credential copying.               |
| [TASK-36](https://linear.app/wylynko/issue/TASK-36) | Full bot lifecycle control needs the shared lifecycle boundary, paginated history/control/schedule operations, replay receipts, and TASK-38's persistent model API. Keep one user feature using those foundations.            |
| [TASK-37](https://linear.app/wylynko/issue/TASK-37) | Merge into TASK-45: bare and explicit grouped help share one entry point and integration test.                                                                                                                                |
| [TASK-38](https://linear.app/wylynko/issue/TASK-38) | The selection API/UI is missing, and registration can report success while ignoring model changes. Use the existing Durable configuration operation and Pi selector UI; retain the broader full-interface request in TASK-25. |
| [TASK-39](https://linear.app/wylynko/issue/TASK-39) | Sudo support works in the newer cached image/profile. Enable it for new workspaces using the current image; no legacy-profile or image-upgrade path.                                                                          |
| [TASK-40](https://linear.app/wylynko/issue/TASK-40) | List displays configured enablement while status displays live activity. Use consistent meanings, one batch activity overview, and detailed selected status without per-row cluster calls.                                    |
| [TASK-41](https://linear.app/wylynko/issue/TASK-41) | A foreground CLI currently owns deletion completion. Persisted failures and restart-safe cleanup require TASK-47 before the default/`--wait` behavior can be correct.                                                         |
| [TASK-42](https://linear.app/wylynko/issue/TASK-42) | There is no runtime Infisical integration to remove. Generic setup is straightforward; pod delivery, restart, logout, and shared OAuth refresh ownership need an explicit credential contract.                                |
| [TASK-43](https://linear.app/wylynko/issue/TASK-43) | One diagnostic report can support human default and explicit JSON without changing health or exit semantics.                                                                                                                  |
| [TASK-44](https://linear.app/wylynko/issue/TASK-44) | The watcher protocol fixtures pass. Setup lacks a worked ID/bind/pane/supervision path; real session delivery has not been proven.                                                                                            |
| [TASK-45](https://linear.app/wylynko/issue/TASK-45) | Own the merged grouped-help and successful bare-invocation behavior. Keep completion work in the separate Backlog TASK-46.                                                                                                    |
| [TASK-47](https://linear.app/wylynko/issue/TASK-47) | New shared in-cluster lifecycle owner: authoritative identity/spec/operation state, creation, cancellation fencing, deletion and durable receipts/errors. Survives deletion of managed workspace pods.                        |
| [TASK-48](https://linear.app/wylynko/issue/TASK-48) | Merged into TASK-22 after the alpha scope correction; a parent plus one runtime child is redundant.                                                                                                                           |
| [TASK-49](https://linear.app/wylynko/issue/TASK-49) | Canceled: existing-installation migration is out of scope in early alpha.                                                                                                                                                     |

The lifecycle service is one authoritative boundary, not another agent owner or a second provisioner. Keep it in Kubernetes, outside the namespaces it deletes. The access host must not become a persistent cleanup or model worker. Start with one fresh authoritative lifecycle store and enforce current-design ownership/tombstone semantics. No host registry import or dual-store compatibility machinery is needed.

The important implementation order is TASK-47 and the credential contract before pod runtime integration; the shared model API before complete bot configuration. Presentation/help work and the targeted repository error fix can proceed independently. No implementation is claimed by these ticket relationships.

Detailed primary-source traces, probes, and tests to write first:

- [Runtime, restart behavior, model selection, and credentials](todo-runtime-research-2026-10-16.md).
- [Bot management and own-pod administration](todo-management-research-2026-10-16.md).
- [CLI output, help, and deletion](todo-cli-research-2026-10-16.md).

## TASK-35: repository failure reproduced and narrowed

Three causes needed distinction: an incorrect repository slug; an intentionally private repository without in-container authentication; or broken container Git/network behavior. The screenshot uses `nwylynko/agentic-dev-machine`, whereas this checkout is `NWylynko/agentic-dev-machines`.

Read-only checks against the [GitHub repository API](https://docs.github.com/en/rest/repos/repos#get-a-repository) returned:

| Repository                      | Anonymous API                      | Existing `gh` connection | Credential-free Git                                     |
| ------------------------------- | ---------------------------------- | ------------------------ | ------------------------------------------------------- |
| `NWylynko/agentic-dev-machine`  | 404                                | 404                      | Exit 128, password acquisition failure                  |
| `NWylynko/agentic-dev-machines` | 200, public, default branch `main` | Same metadata            | Exit 0, HEAD `748282de5c65f0474a80d5a66feccd44080a22cb` |

The existing real CLI was then exercised with the existing fake Kubernetes fixture from [tests/cli.rs:187](../tests/cli.rs#L187). The fixture ran the actual repository-preparation shell script and real Git in temporary private directories, with Git credential helpers/config disabled. It provisioned no real Kubernetes resources and contacted no model provider.

1. `create reported --no-agent --repo nwylynko/agentic-dev-machine` failed in repository preparation. The persisted SQLite record was `phase=failed`, with its Git failure and the entire preparation script in `last_error`.
2. `create public-control --no-agent --repo nwylynko/agentic-dev-machines` reached `phase=ready` with a normal public checkout and no credentials. This rules out a universal requirement to transfer host `gh` login for this public repository.
3. Repeating `create reported` with the corrected plural slug failed before provisioning: “unfinished creation with different options; destroy it before changing its configuration.” The repository is part of the immutable creation specification.
4. A desired-behavior assertion that the error omit the full preparation script failed for the expected reason. The debug loop is `python3 /tmp/adm-todo-detective-20261016/repo-cli-probe.py --assert-concise`; source/results are temporary session artifacts, not repository regression tests.

The exact password-error wording differs between Git environments; the stage and failure category match the report. This is not a reproduction against the user's original live pod. A 404 is not a universal proof that a repository cannot exist privately; for this supplied public repository spelling, both API checks and the successful control establish the concrete remedy.

The error becomes enormous because [kubectl:359](../src/workspaces.rs#L359) formats every argument into its failure context and [prepare_repository:638](../src/workspaces.rs#L638) passes a multiline script as one argument. Repository validation at [line 150](../src/workspaces.rs#L150) validates syntax, not existence. The immutable retry check is at [line 501](../src/workspaces.rs#L501), including repository/cwd at [line 704](../src/workspaces.rs#L704).

### Concrete scope

Keep TASK-35 as one bug ticket: show the repository, failed preparation stage, exit/cause, and useful recovery without echoing the script. Preserve the raw cause, but describe inaccessible repositories as missing/private/inaccessible rather than declaring authentication is always the cause. Do not add a new mandatory preflight API or ambient credential transfer solely to diagnose a spelling error.

Correct the earlier broad retry criterion: same-spec transient/network/authentication failures remain retryable under the same identity, preserving published edits. Changing a mistyped immutable repository currently requires inspecting and deliberately destroying the failed workspace before creating the corrected one. Explain that consequence; do not silently mutate repository identity or delete potential work to make a retry succeed.

Tests to write first: real Git/local upstream plus the public CLI fixture; missing upstream versus valid public checkout; concise current/persisted failure; no agent admission after failed clone; same-spec retry retains edits; changed repository gets explicit safe recovery guidance. Existing full clone, interrupted staging, edit-preserving retry, and deletion-race cases in [tests/cli.rs](../tests/cli.rs) should be extended, not replaced.

## TASK-44: installation path and evidence limits

Installed `herdr --version` reports **0.9.3**; `herdr api schema --json` reports **protocol 22**, schema version 1. The schema has `workspace.list`, `workspace.get`, `session.snapshot`, `pane.list`, `events.subscribe`, and `workspace.close`. Workspace objects carry immutable `workspace_id`; pane objects identify their owning workspace. No close-feed replay cursor exists in this installed schema.

The installed CLI exposes `herdr workspace list/get`, `herdr pane current`, `herdr tab ...`, and `herdr api snapshot`. These are concrete setup aids; no plugin installation is implemented by `adm herdr hook`. That command only prints a JSON instruction to run the watcher ([herdr.rs:38](../src/herdr.rs#L38)). Bare `adm herdr` instead prints a missing-subcommand error. `bind` accepts an arbitrary nonempty ID and saves it without validating an actual Herdr space ([line 30](../src/herdr.rs#L30)). There is no ADM command creating the Herdr panes or supervising the watcher for the operator.

The snapshot's globally focused workspace must not be assumed to be the invoking pane's owner: focus can change independently. Prefer the actual current-pane/session context and explicit immutable space identity when binding. Preserve the requirement to use the owning session's socket rather than guessing another session's socket.

Three existing real CLI/socket tests passed directly from the already-built harness:

```text
target/debug/deps/cli-ca313534eb39ec37 herdr_ --nocapture
3 passed: explicit schema event cleanup;
subscription/notification ordering and explicit-close-only deletion;
received-close journal recovery after cleanup failure.
```

These tests use isolated Unix sockets and fake Kubernetes, not a live Herdr removal. They initially hit sandbox socket restrictions, then passed outside that restriction. The stdin-event test ran even in the sandbox. No build or fix was needed.

This agent process has no `HERDR_ENV`, `HERDR_SOCKET_PATH`, or pane identity. A snapshot attempt could not reach a session in this execution context. Official linked Herdr web documentation was also unavailable through the available fetch paths; the installed CLI/schema and repository tests are the primary evidence used here. No watcher was attached to another session, no real space was removed, and live Herdr delivery remains unverified.

### Concrete scope

Keep TASK-44 as one integration/setup ticket. Provide one copyable path that obtains the actual space ID, creates/binds the ADM workspace, opens its shell/agent panes, runs the watcher in a supervised pane, and displays human-readable active/failure state. Explain where each command runs and how supervision restarts the watcher. Use the real installed CLI/schema; do not call a printed JSON command a completed plugin install.

The bridge should journal each received close and submit it to TASK-47's durable lifecycle boundary. Only acknowledge/clear local work after durable admission; namespace finalization must not block consuming later close events. TASK-41 provides default/explicit-wait behavior over that operation. Keep the inability to replay events missed while disconnected visible; neither an empty snapshot nor a lost socket proves deletion.

Tests to write first: ID/pane binding with a focus change; two bound spaces and an unrelated space; close before/after subscription acknowledgement; delayed/failed service admission and restart/retry; no duplicate destructive operation. After implementation, verify a disposable owned live Herdr space with a pod runtime: shell/attach work; terminal/access disconnection leaves the agent running; explicit space close cancels work and removes only its resources. Record actual version/setup/delivery evidence. This real-session check is still required, not silently replaced by fixture success.

## Verification boundary

The companion notes record targeted existing integration checks passing, seven expected failing CLI behavior probes, real isolated HTTP/SQLite/model-state and Pi-selector probes, synthetic credential/OAuth tests, and the cached TASK-33 image's offline Git/Chromium/Tini/apt smoke. The three Herdr cases above include cases also run by the CLI investigator; counts should not be summed as distinct coverage.

Successful cached-image smoke does not prove a running cluster's image selection, real agent-to-pod sudo, or rollout. Synthetic OAuth proves the duplicate-shared-refresh-credential hazard, not real subscription compatibility. Controlled Pod replacement does not prove sudden-node-loss recovery. Those limits are retained in the corresponding tickets.

TASK-25 was reopened during this investigation with a request for the full Pi interface and model selector; TASK-38 must respect that selector direction. The broader interface request and new low-priority zsh completion TASK-46 remain Backlog work rather than being silently merged away. The current ticket scopes keep all requested new-design behavior, with the help merge, runtime consolidation, and canceled migration work recorded explicitly.
