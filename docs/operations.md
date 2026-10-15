# Running ADM

ADM has two parts on the management host: the Rust CLI and one long-running Node runner. Development commands execute in Kubernetes, and model credentials stay on the management host. Terminal attachments are clients; closing one does not stop an agent.

## Management host

Install the standalone release with the command in the [README](../README.md), then run `adm setup`. The management host needs Node.js 24+, `kubectl`, and Git; `gh` is needed for repository discovery. Rust, Go, npm, and the checkout are only needed for source development. See [installation and updates](installation.md) for prerequisites, version selection, and migrating an older manual installation.

Make sure `$HOME/.local/bin` is on your shell's PATH. `adm doctor` reports tool availability, cluster readiness, the default StorageClass, runner health, and the selected local state directory. It preserves storage and runner error causes instead of treating every failure as a stopped service. Use `adm doctor --storage-class NAME` to inspect another class; node-local storage is labeled explicitly. Diagnostics do not allocate a workspace or install missing prerequisites.

Run `adm login` on the management host and use its `/login` command to configure the provider you intend to use. ADM uses the pinned Pi model runtime and its normal authentication store. Subscription compatibility depends on that provider integration; it has not been validated for every account. Keep API keys in Infisical and inject them into the runner's process; commit schema only and never create a project `.env` containing real values. Do not copy provider authentication into a workspace.

Choose a default model in `adm setup`, or select one explicitly with `--model PROVIDER/MODEL_ID` when creating an agent workspace. `faux/faux-1` is a deterministic local test provider and is available only when explicitly selected. It does not call an external model.

```sh
adm start
adm status my-project
```

`adm start` detaches the runner from the invoking terminal. For restart after a management-host reboot or runner crash, use `adm setup` to install the user service supervising `adm serve`. A manual [service template](../deploy/adm-runner.service) is also available. Do not start a second runner for the same state directory. Its owner lock rejects competing processes; SQLite is not a multi-owner database.

The default state directory is `$XDG_DATA_HOME/adm`, or `$HOME/.local/share/adm` when XDG_DATA_HOME is unset. `--state-dir` and `--runner-url` are global options. Use the same values in the service and every CLI command. The default runner URL is `http://127.0.0.1:7432`; remote unauthenticated binds are rejected.

`adm stop` stops a runner launched by `adm start` while preserving recoverable work. For the user service, use `systemctl --user stop adm-runner.service` and `systemctl --user start adm-runner.service`. Workspace deletion uses `adm destroy`, which has different semantics.

## Published builds

`.github/workflows/build.yml` checks the CLI, runner, and terminal on pull requests and on `main`. Markdown-only changes skip that workflow. FUSE repository tests stay on a machine with `/dev/fuse`. Pull requests that change the build smoke the workspace image, then stop. Pushes to `main` that change the build, version tags (`v*`), and manual runs from `main` publish the `linux/amd64` image to `ghcr.io/nwylynko/agentic-dev-machines`:

| Git ref  | Image tags                                  |
| -------- | ------------------------------------------- |
| `main`   | `latest`, `sha-<commit>`                    |
| `v0.1.0` | `0.1.0`, `v0.1.0`, `latest`, `sha-<commit>` |

After verification, image publishing, and runtime packaging pass, a `main` build automatically creates a GitHub release under `sha-<commit>` and marks it latest. Each release has its own assets, so a newer build does not overwrite files being downloaded. The release includes `install.sh`, `LICENSE`, `adm-linux-amd64.tar.gz`, compatibility binaries, and `SHA256SUMS`. The archive contains the CLI, repository helper, compiled runner/terminal, and their pinned production Node dependencies. The same files remain available as a workflow artifact. Installation needs no checkout. The bundle records its matching `sha-<commit>` workspace image reference; setup can select a different image.

The installer consumes the latest successful `main` release automatically. Optional `v*` tags also publish pinned releases; they do not change the installer's latest release. Rerunning the same build preserves published assets. An older or unrelated main build is published under its own tag and is not promoted over a newer published build. A draft left by a failed publish is not reused; delete that draft before rerunning the build. Markdown-only pushes skip publication; a manual Build run on `main` can publish that commit when needed.

The workflow token needs package write access; the first push creates the GHCR package. If that package is private, the cluster needs a pull credential. A node that cannot pull from GHCR still needs the image imported locally.

## Workspace image and storage

```sh
docker build -f image/Dockerfile -t adm-dev:0.1.0 .
```

For local image development, distribute that exact image to the cluster's nodes and pass `--image adm-dev:0.1.0`. Installed releases default to their matching published GHCR reference unless setup configured another image. Building it on the management host does not make it available to Kubernetes. ADM does not install node helpers or change container-runtime configuration.

Configure a replicated StorageClass as described in [storage.md](../deploy/storage.md). The default is `adm-replicated`; this repository does not install a storage backend. The filesystem must support the required mount behavior, and the runner's management-host SQLite store needs a WAL-compatible filesystem. Keep management-host state in the backup plan as well as workspace volumes.

For a deliberately node-local experiment, use `--storage-class local-path --allow-node-local-storage`. This acknowledges that replacement on a different node cannot recover that volume. It is useful for testing Pod replacement on the same node, not evidence of node-failure recovery.

## Coding workspaces

```sh
# Select your authenticated provider/model and configured storage class.
adm create my-project --model PROVIDER/MODEL_ID
adm attach my-project
adm shell my-project
adm prompt my-project 'Inspect the repository and describe its current state.'
adm list
adm status my-project
```

Use `--no-agent` for a shell-only workspace. By default `/repos` is an ordinary writable directory, so normal cloning works. Providing `--catalog` opts in to the lazy catalog; it cannot be combined with `--no-repositories` or the bot role. To seed the catalog without cloning repository contents:

```sh
adm-repositories discover --owner example-owner > /tmp/adm-catalog.json
adm create my-project --catalog /tmp/adm-catalog.json --model PROVIDER/MODEL_ID
```

Discovery authenticates `gh` on the management host. Fetching private repository contents also requires a scoped Git credential mechanism in the repository container; this is an operator prerequisite, not something the discovery JSON supplies. Credentials must not appear in remote URLs. No eager-clone fallback is used when an upstream lacks filtering support. A failed acquisition stays retryable after its cause is fixed.

The repository service requires FUSE, mount propagation, and a Linux kernel supporting unique mount identities (`STATX_MNT_ID_UNIQUE`, available since Linux 6.8 according to [statx(2)](https://man7.org/linux/man-pages/man2/statx.2.html)). It fails clearly when that support is unavailable. The repository sidecar currently has elevated mount authority; the `dev` container drops all capabilities and receives neither a service-account token nor management-host credentials. Treat the sidecar as a separate trusted component. The immutable-upstream cache is optional and must be mounted read-only; each workspace's Git state and writable files remain private.

## Bot workspaces

```sh
adm create supervisor --role bot --model PROVIDER/MODEL_ID --allow-agent CODING_WORKSPACE_ID
adm attach supervisor
```

Use immutable IDs from `adm list` for supervision grants. A bot can use `listAgents` to discover the names and status of its live permitted coding agents, then observe and prompt those targets. Deleted or missing grants are reported as unavailable and never transfer to a workspace that reuses the same name. The bot can also manage goals and loops and publish through `sendMessage`. It has no coding filesystem, shell, or development browser, including through Code Mode. Ordinary model text stays in diagnostics. `adm attach supervisor --diagnostics` explicitly opts in to seeing those records.

`adm list` prints the workspace name, role, persisted lifecycle phase, agent configuration, and full immutable ID from local state. It works without contacting Kubernetes or the runner. Use `adm list --json` to get the complete stored records as a JSON array; add `--all` to include deleted workspaces.

## Errors and recovery

The terminal supports `/status`, `/resume`, `/reconnect`, `/abort`, `/abort all`, `/newgoal DESCRIPTION`, and `/loop SECONDS PROMPT`. See the [terminal controls](../packages/terminal/README.md).

An authentication or allowance error is retained in history and status. Restore the selected provider's credentials or capacity, then use `/resume`. Resume reuses its request identity and is allowed only when no tool ran during the failed turn. After a tool may have changed files or external systems, inspect that state and send an explicit follow-up instead. ADM does not switch providers, billing methods, or execution environments on failure.

Kubernetes resolves shell commands and port forwards against `deployment/workspace`, not a remembered Pod name. After a runtime replacement, reopen the shell or rerun the port command. Existing operating-system processes do not move between Pods.

```sh
adm port my-project 3000 --local-port 3000
adm browser my-project http://127.0.0.1:3000 --screenshot /workspace/preview.png
```

From your laptop, forward that management-host port over your normal SSH connection: `ssh -L 3000:127.0.0.1:3000 MANAGEMENT_HOST`. Open `http://127.0.0.1:3000` in your laptop's browser. Port forwarding binds to loopback. A failed forward reports interruption; rerunning it resolves the current runtime.

## Herdr ownership and deletion

Associate a workspace with the immutable Herdr workspace ID using `--herdr-space ID` during creation or `adm herdr bind NAME ID`. The removal bridge consumes actual Herdr `workspace_closed` events. Losing the event connection or restarting Herdr is not a removal event.

```sh
adm herdr hook
adm destroy my-project
adm list --all
```

In a supervised pane inside the owning Herdr session, run `adm herdr watch --socket "$HERDR_SOCKET_PATH"`. The watcher requires `HERDR_ENV=1` and that exact session socket; it never attaches to another session by guessing its path. It journals every received close event before attempting cleanup, then replays unfinished cleanup on restart. Restart the watcher on failure. The current Herdr API has no replay cursor, so a close event missed while disconnected is not recoverable from its feed. The watcher never destroys a workspace merely because a list is empty after startup. Live Herdr installation and delivery remain an operator validation step.

Deletion writes a durable tombstone before cancellation and runtime cleanup. Repeating it finishes interrupted cleanup, and recreating the same label gets a different ID. Old goals, loops, input, and supervision grants cannot attach to that new ID. Retained conversation history is passive; archive expiry is not implemented.

## Verification

```sh
cargo fmt --check
cargo test
npm run check
npm test
npm run test:install
npm run test:publish
cargo build --bin adm
npm run test:release
npm run test:repositories
npm run test:image -- adm-dev:0.1.0
```

The Node tests use real HTTP/SSE, SQLite, subprocess kills/restarts, a terminal PTY, and Chromium. They need permission to open loopback sockets and run a browser. The Go filesystem tests need `/dev/fuse`, FUSE mount permission, and the pinned `artifact-fs` binary on PATH. Install that pin with `go install github.com/cloudflare/artifact-fs/cmd/artifact-fs@$(cat packages/repositories/ARTIFACTFS)`. A missing FUSE device produces an explicit skip; a missing binary with FUSE available fails.

The lighter cluster contract check needs no workspace image or storage provisioner. It creates and removes uniquely owned bot namespaces, validates the coding manifests with the real API's server-side dry run, and exercises explicit Herdr-event cleanup and label reuse:

```sh
ADM_LIVE_CLUSTER=1 npm run test:cluster-contract
```

The full opt-in cluster suite creates coding workspaces, checks normal Git and untracked work after Pod replacement, checks browser and forwarded-port behavior, then destroys its namespaces and claims. It uses local-path deliberately and never drains a node:

```sh
cargo build
ADM_LIVE_CLUSTER=1 ADM_LIVE_IMAGE=adm-dev:0.1.0 npm run test:cluster
```

The suite checks that this image is present on every schedulable node before creating anything. Ordinary `npm test` does not mutate the cluster. Passing the local-path experiment does not prove cross-node storage durability, a sudden-node-failure loss window, live account refresh, or connectivity from client laptops.
