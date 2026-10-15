# Validation on 2026-10-15

This report records verification of the CLI/Herdr, runner lifecycle, terminal, browser, and repository fixes as of 2026-10-15. It separates executed proofs from infrastructure prerequisites.

## Verified

- The real Rust CLI passes its 16 end-to-end cases: isolated manifests, immutable ownership, creation retry under the same ID, permanent deletion and label reuse, startup readiness, explicit provider selection, visible cluster errors, and the Herdr socket/event journal protocol. Rust formatting and Clippy with warnings denied pass.
- The runner uses real Pi Durable 1.2.0 and SQLite in tests. Subprocess kill/restart restores conversation, work, goals, loops, and delivery state. Disconnecting a terminal does not abort work. Deliberate deletion rejects later admission and cancels owned activity. Bots cannot access coding tools directly or through Code Mode; only explicit messages enter their chat.
- Provider failures remain visible after restart. Explicit resume deduplicates admission and refuses a failed turn after tool activity. These tests use the explicitly selected faux provider, not a paid provider account.
- Competing runner processes cannot acquire the same owner database, even if stale owner metadata is restored while one process is alive. Database and directory privacy and symlink rejection are tested.
- A real remote-environment subprocess cleans up detached shell groups after stdin EOF, SIGTERM, and stdout disconnection. Cancellation does not reverse effects already completed.
- Terminal tests exercise real HTTP/SSE and a real terminal process in a PTY, including provider failure/resume, detach/reconnect, retained failed input, bot visibility, and goal/loop inspection and cancellation.
- Repository tests use actual FUSE mounts and Git. Two workspaces keep private edits, indexes, local commits, refs, and untracked files. A second active repository does not alias the first. Remounts retain work, inode identity stays stable, symlink bytes survive Git staging/commit, unused repositories remain unhydrated, rejected clones stay rejected on retry, and backend death fails loudly. The complete suite passed 20 consecutive runs, then passed the integrated final run. Go vet passes.
- `image/Dockerfile` built successfully as both `adm-dev:0.1.0` and `adm-dev:validation-20261015`. The smoke test runs UID/GID 1000 with all capabilities dropped, no host mounts, no published ports, and no external network. It verifies entrypoint contents, a real Git commit, Chromium DOM and PNG screenshot output against an internal fixture, browser profile cleanup, and normal container removal.
- `ADM_LIVE_CLUSTER=1 npm run test:cluster-contract` passed on a k3s cluster. It created uniquely owned bot namespaces, validated coding resources through server-side dry run, destroyed the correct namespace through an explicit Herdr removal event, recreated the same label under a new immutable ID, and verified namespace cleanup. No real Herdr session was modified.
- TypeScript, Prettier, shell syntax, and whitespace checks pass.

The filesystem investigation reproduced and fixed two distinct races: Go's runtime poller consumed mount-change events before the explicit watcher, and the generic loopback file opener unnecessarily opened the ArtifactFS root directory on every file access. The latter could fail while constructing a directory snapshot. The replacement uses a path-only directory anchor with the original no-symlink resolution policy; no retry timer masks either failure.

## Still requires infrastructure or account access

At the time of this report, the test cluster had only the `local-path` StorageClass and no cached ADM workspace image on any node. The full `test:cluster` preflight failed explicitly before allocating resources. Building an image on the management host does not distribute it to the nodes.

Image distribution remained a prerequisite: no registry push credentials or node-side image-loading path were configured for the test. No node helpers were installed. Completing the full coding-workspace cluster run requires distributing the image through an operator-managed registry or node import.

Cross-node filesystem recovery, planned node movement, sudden-node-failure loss windows, private GitHub fetch credentials inside the repository sidecar, live provider account refresh/allowances, connectivity from client laptops, and live Herdr watcher installation had not been demonstrated. The source does not silently select an alternative storage backend, provider, or execution environment.

The watcher journals events it receives before deleting workspaces. The installed Herdr API has no replay cursor for close events that occur while the watcher is disconnected. It never treats an empty workspace list as a deletion event.

## Fault-test cleanup

The final passing test runs cleaned up their mounts and containers. Earlier intentionally timed-out experiments left dead catalog test mounts whose backend processes had exited. Such faults can require operator cleanup: inspect test mounts and outstanding references before ordinary unmount. Test mounts must be distinguished from project workspaces and user data volumes.
