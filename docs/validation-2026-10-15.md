# Validation on 2026-10-15

GPT-6 Luna agents implemented and reviewed the CLI/Herdr, runner lifecycle, terminal, browser, and repository fixes. The parent integrated them and ran the public checks. This report separates executed proofs from infrastructure prerequisites.

## Verified

- The real Rust CLI passes its 16 end-to-end cases: isolated manifests, immutable ownership, creation retry under the same ID, permanent deletion and label reuse, startup readiness, explicit provider selection, visible cluster errors, and the Herdr socket/event journal protocol. Rust formatting and Clippy with warnings denied pass.
- The runner uses real Pi Durable 1.2.0 and SQLite in tests. Subprocess kill/restart restores conversation, work, goals, loops, and delivery state. Disconnecting a terminal does not abort work. Deliberate deletion rejects later admission and cancels owned activity. Bots cannot access coding tools directly or through Code Mode; only explicit messages enter their chat.
- Provider failures remain visible after restart. Explicit resume deduplicates admission and refuses a failed turn after tool activity. These tests use the explicitly selected faux provider, not a paid provider account.
- Competing runner processes cannot acquire the same owner database, even if stale owner metadata is restored while one process is alive. Database and directory privacy and symlink rejection are tested.
- A real remote-environment subprocess cleans up detached shell groups after stdin EOF, SIGTERM, and stdout disconnection. Cancellation does not reverse effects already completed.
- Terminal tests exercise real HTTP/SSE and a real terminal process in a PTY, including provider failure/resume, detach/reconnect, retained failed input, bot visibility, and goal/loop inspection and cancellation.
- Repository tests use actual FUSE mounts and Git. Two workspaces keep private edits, indexes, local commits, refs, and untracked files. A second active repository does not alias the first. Remounts retain work, inode identity stays stable, symlink bytes survive Git staging/commit, unused repositories remain unhydrated, rejected clones stay rejected on retry, and backend death fails loudly. The complete suite passed 20 consecutive runs, then passed the integrated final run. Go vet passes.
- `image/Dockerfile` built successfully as both `adm-dev:0.1.0` and `adm-dev:validation-20261015`. The smoke test runs UID/GID 1000 with all capabilities dropped, no host mounts, no published ports, and no external network. It verifies entrypoint contents, a real Git commit, Chromium DOM and PNG screenshot output against an internal fixture, browser profile cleanup, and normal container removal.
- `ADM_LIVE_CLUSTER=1 npm run test:cluster-contract` passed on the three-node k3s cluster. It created uniquely owned bot namespaces, validated coding resources through server-side dry run, destroyed the correct namespace through an explicit Herdr removal event, recreated the same label under a new immutable ID, and verified namespace cleanup. No real Herdr session was modified.
- TypeScript, Prettier, shell syntax, and whitespace checks pass.

The filesystem investigation reproduced and fixed two distinct races: Go's runtime poller consumed mount-change events before the explicit watcher, and the generic loopback file opener unnecessarily opened the ArtifactFS root directory on every file access. The latter could fail while constructing a directory snapshot. The replacement uses a path-only directory anchor with the original no-symlink resolution policy; no retry timer masks either failure.

## Still requires infrastructure or account access

The cluster currently has only the `local-path` StorageClass and no cached ADM workspace image on any node. The full `test:cluster` preflight fails explicitly before allocating resources. Building an image on the management host does not distribute it to the nodes.

The proposed temporary node helpers would mount the nodes' container-runtime sockets. Automatic approval review rejected that action because it grants broad host-runtime control without specific authorization. No helpers were created, and that restriction was not bypassed. Normal GitHub authentication lacks the registry write scope required for an image push. Completing the full coding-workspace cluster run requires an approved image registry/distribution path or explicit permission for node-side image loading.

Cross-node filesystem recovery, planned node movement, sudden-node-failure loss windows, private GitHub fetch credentials inside the repository sidecar, live provider account refresh/allowances, MacBook port connectivity, and live Herdr watcher installation have not been demonstrated. The source does not silently select an alternative storage backend, provider, or execution environment.

The watcher journals events it receives before deleting workspaces. The installed Herdr API has no replay cursor for close events that occur while the watcher is disconnected. It never treats an empty workspace list as a deletion event.

## Residue from intentionally timed-out fault tests

The final passing test runs clean up their mounts and containers. Earlier timeout experiments left three dead catalog mounts under temporary test directories. Their backend processes were identified and terminated. Ordinary `fusermount3 -u` reports them busy; ordinary root unmount could not run because sudo requires a password. No forced/lazy unmount or forced file deletion was used.

An operator can inspect and ordinarily unmount these exact test paths:

```sh
sudo umount /tmp/TestRepositoryFilesystem1687816529/001/a/repos
sudo umount /tmp/TestRepositoryFilesystem2407792877/001/b/repos
sudo umount /tmp/TestRepositoryFilesystem4101371627/001/a/repos
```

If ordinary unmount still refuses, inspect its outstanding references before taking further action. These are test mounts, not project workspaces or user data volumes.
