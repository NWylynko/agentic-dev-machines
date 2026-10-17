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
  integrated Pod runtime. The combined npm suite passes 43 runner/browser/RBAC
  tests and 17 terminal tests. The subsequent clipboard/session-statistics
  change passes 18 terminal tests, including bot visibility checks.
- The actual release archive installs and runs without a checkout. Its packaged
  Pod-mode runtime uses a mounted workspace identity and an HTTP lifecycle
  fixture, then executes Code Mode through the installed worker/WASM assets.
  The test also exercises the compiled CLI, managed shell, and terminal assets.

## Combined workspace image

The immutable source snapshot `a5adf68` built as `adm-dev:verify-a5adf68`
(image configuration `sha256:7d902902e298ca1f5a7fa4f5f7b2201d48da3a0439b8d386c0cde90d6802c442`).
Its full image smoke passes. This supersedes the earlier `bfee530` container
snapshot and includes the runtime ownership and release-fixture corrections.

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

Publishing the new image under the unique validation tag failed because GHCR
rejected the configured Docker token. The existing SSH import connection as
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
