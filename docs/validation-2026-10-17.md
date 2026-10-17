# Validation — 2026-10-17

This run resumed the existing Linear worktrees with GPT-6 Luna agents. The
completed commits are integrated on local `main`; publication is separate.

## Verified behavior

- Default destroy returns after durable admission. `--wait` observes completion
  or the persisted error. The CLI/HTTP process test holds namespace deletion,
  restarts the lifecycle owner, replays concurrent requests, and protects reused
  names. Against the preceding source, it fails because default destroy waits
  for finalization.
- Lifecycle receipts retain detailed stages and timings. Early provisioning
  errors persist as failures. List prints immutable workspace IDs.
- Runtime authorization rejects expired bot leases and replaced Pod identities.
  The HTTP regression returned 200 for the expired owner before the fix and
  rejects it afterward. These are process tests with a fake Kubernetes boundary.
- Four Herdr CLI/socket fixtures pass for verified binding, explicit close
  events, durable asynchronous admission, and journal replay.
- Installer fixtures pass 10/10; the release-publication fixture passes. These
  tests publish no real release.
- The complete Rust suite, formatting, Clippy, and TypeScript checks pass on the
  final integrated runtime. The combined npm suite passes 46 runner/browser/RBAC
  tests and 20 terminal tests, including actual PTY interactions, mapped
  keybindings, protected Markdown export, and bot visibility checks.
- Bot management uses authenticated requests between isolated workspace
  runtimes. Tests cover discovery after bot creation, direct tools and Code
  Mode, paginated history, control/model operations, cancellation, durable
  goal/loop receipts, and lifecycle admission/status. The Rust HTTP scenario
  checks live-owner authorization, operation reads, delete replay during and
  after cleanup, and immutable identity across name reuse.
- The actual release archive installs and runs without a checkout. Its packaged
  Pod-mode runtime uses a mounted workspace identity and an HTTP lifecycle
  fixture, then executes Code Mode through the installed worker/WASM assets.
  The test also exercises the compiled CLI, managed shell, and terminal assets.
- The remote-environment cancellation fixture now publishes its command PID
  atomically and validates it before signaling. An empty PID-file read had
  caused one combined verification run to signal process group zero. The
  focused three-case suite and the complete npm rerun pass after correction.

## Combined workspace image

The immutable source snapshot `0f5a372` built as `adm-dev:verify-0f5a372`
(local image ID `sha256:5f5080ed4b0e6efd24f9aa05ee6e035a2255a8b23525ce61635b4317e5fd4698`).
Its full image smoke passes. This supersedes the earlier `bfee530` and
`a5adf68` container snapshots and includes bot lifecycle management and the
Pi controls. Later changes affect documentation and the host-side cancellation
test fixture only; runtime/image source is unchanged.

The smoke exercises the packaged Durable runtime performing a real coding-tool
write and retaining history after process restart, ordinary UID 1000 and sudo,
package/system operations, Chromium, GitHub CLI, actual Git HTTP pushes from
shell and coding tools, credential absence/rejection/rotation/isolation, and
zsh/Oh My Zsh with persistent editable configuration and history. Credentials
are synthetic. The runtime uses an isolated HTTP lifecycle fixture in the
container; this does not establish Kubernetes rollout or distributed durability.

## Live prerequisites still required

The configured cluster has three Ready nodes and the `adm-replicated` Longhorn
StorageClass. All three nodes still have the older
`ghcr.io/nwylynko/agentic-dev-machines:sha-9937cfd9ddc4` image cached.

The earlier validation-image publication attempt failed because GHCR rejected
the configured Docker token. The final image remains local. The SSH connection as
`nick` was denied by Tailscale policy. No node helper or runtime configuration
was installed or changed. A working operator-managed image distribution path
is needed before current-image live cluster acceptance can run.

Herdr 0.9.3/protocol 22 is installed, but this process has no owning Herdr pane
or session socket. The installed `herdr --skill` requires an agent to run inside
Herdr and says, “Do not inspect or control the focused Herdr session from outside
Herdr.” No live space was modified. The owning-pane setup is documented in
[operations](operations.md#herdr-ownership-and-deletion).

Actual Kubernetes Pod replacement, unattended work during access-plane loss,
live Herdr close delivery, and sudden-node-loss durability are not established
by the container and fixture results above.

## Linear handoff

TASK-36, TASK-38, TASK-39, TASK-40, TASK-41, TASK-42, TASK-46, TASK-50,
TASK-51, and TASK-52 are Done with local verification evidence. TASK-22 and
TASK-47 remain In Review for current-image live acceptance; TASK-44 remains
In Review for the owning-Herdr-pane check. TASK-25 remains In Review with the
implemented mappings and remaining native-interface gaps in
[the parity checklist](pi-terminal-parity.md). No new image, release, or source
commit was published during this run.
