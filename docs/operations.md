# Running ADM

ADM has two parts on the management host: the Rust CLI and one long-running Node runner. Development commands execute in Kubernetes, and model credentials stay on the management host. Terminal attachments are clients; closing one does not stop an agent.

## Management host

Use Node 24 or newer, Rust, Go 1.26, `kubectl`, and Git. `gh` is needed for repository discovery. Keep this checkout available: the CLI launches the runner and terminal from it, including its installed npm dependencies.

```sh
npm ci
cargo install --path . --root "$HOME/.local"
go build -C packages/repositories -o "$HOME/.local/bin/adm-repositories" .
adm doctor
```

Make sure `$HOME/.local/bin` is on your shell's PATH. `adm doctor` reports tool availability, cluster readiness, the default StorageClass, runner health, and the selected local state directory. It preserves storage and runner error causes instead of treating every failure as a stopped service. Use `adm doctor --storage-class NAME` to inspect another class; node-local storage is labeled explicitly. Diagnostics do not allocate a workspace or install missing prerequisites.

Run `npm exec -- pi` on the management host and use its `/login` command to configure the provider you intend to use. ADM uses the pinned Pi model runtime and its normal authentication store. Subscription compatibility depends on that provider integration; it has not been validated for every account. API keys follow the home-level `SECRETS.md`: inject them from Infisical into the runner's process, and never create a project `.env` containing values. Do not copy provider authentication into a workspace.

Select a model explicitly with `--model PROVIDER/MODEL_ID` when creating an agent workspace. `faux/faux-1` is a deterministic local test provider and is available only when explicitly selected. It does not call an external model.

```sh
adm start
adm status my-project
```

`adm start` detaches the runner from the invoking terminal. For restart after a management-host reboot or runner crash, supervise `adm serve` with a user service; an example is [deploy/adm-runner.service](../deploy/adm-runner.service). Replace its checkout and executable paths before installing it. Do not start a second runner for the same state directory. Its owner lock rejects competing processes; SQLite is not a multi-owner database.

The default state directory is `$XDG_DATA_HOME/adm`, or `$HOME/.local/share/adm` when XDG_DATA_HOME is unset. `--state-dir` and `--runner-url` are global options. Use the same values in the service and every CLI command. The default runner URL is `http://127.0.0.1:7432`; remote unauthenticated binds are rejected.

`adm stop` stops the runner while preserving recoverable work. Restart it with `adm start`, or let the service supervise it. Workspace deletion uses `adm destroy`, which has different semantics.

## Published builds

`.github/workflows/build.yml` checks the CLI, runner, and terminal on pull requests and on `main`. Markdown-only changes skip that workflow. FUSE repository tests stay on a machine with `/dev/fuse`. Pull requests that change the build smoke the workspace image, then stop. Pushes to `main` that change the build, version tags (`v*`), and manual runs from `main` publish the `linux/amd64` image to `ghcr.io/nwylynko/agentic-dev-machines`:

| Git ref | Image tags |
| --- | --- |
| `main` | `latest`, `sha-<commit>` |
| `v0.1.0` | `0.1.0`, `v0.1.0`, `latest`, `sha-<commit>` |

A version tag creates a GitHub release with `adm-linux-amd64` and `adm-repositories-linux-amd64`. Pushes to `main` that change the build upload those same binaries as a workflow artifact. The release CLI still needs this checkout and `npm ci`, because it launches the runner and terminal from the source tree. Run it from the checkout, or pass `--project-dir` / `ADM_PROJECT_DIR`. A binary built on the management host with `cargo install --path .` keeps using that checkout while the path exists.

```sh
install -m 755 adm-linux-amd64 "$HOME/.local/bin/adm"
install -m 755 adm-repositories-linux-amd64 "$HOME/.local/bin/adm-repositories"
adm create my-project --image ghcr.io/nwylynko/agentic-dev-machines:0.1.0 --model PROVIDER/MODEL_ID
```

The workflow token needs package write access; the first push creates the GHCR package. If that package is private, the cluster needs a pull credential. A node that cannot pull from GHCR still needs the image imported locally.

## Workspace image and storage

```sh
docker build -f image/Dockerfile -t adm-dev:0.1.0 .
```

Distribute that exact image to the cluster's nodes, or use the published GHCR reference with `--image`. Building it on the management host does not make it available to Kubernetes. ADM does not install node helpers or change container-runtime configuration.

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
adm-repositories discover --owner nwylynko > /tmp/adm-catalog.json
adm create my-project --catalog /tmp/adm-catalog.json --model PROVIDER/MODEL_ID
```

Discovery authenticates `gh` on the management host. Fetching private repository contents also requires a scoped Git credential mechanism in the repository container; this is an operator prerequisite, not something the discovery JSON supplies. Credentials must not appear in remote URLs. No eager-clone fallback is used when an upstream lacks filtering support. A failed acquisition stays retryable after its cause is fixed.

The repository service requires FUSE, mount propagation, and a Linux kernel supporting unique mount identities (`STATX_MNT_ID_UNIQUE`, available since Linux 6.8 according to [statx(2)](https://man7.org/linux/man-pages/man2/statx.2.html)). It fails clearly when that support is unavailable. The repository sidecar currently has elevated mount authority; the `dev` container drops all capabilities and receives neither a service-account token nor management-host credentials. Treat the sidecar as a separate trusted component. The immutable-upstream cache is optional and must be mounted read-only; each workspace's Git state and writable files remain private.

## Bot workspaces

```sh
adm create supervisor --role bot --model PROVIDER/MODEL_ID --allow-agent CODING_WORKSPACE_ID
adm attach supervisor
```

Use immutable IDs from `adm list` for supervision grants. A bot can observe and prompt only those targets, manage goals and loops, and publish through `sendMessage`. It has no coding filesystem, shell, or development browser, including through Code Mode. Ordinary model text stays in diagnostics. `adm attach supervisor --diagnostics` explicitly opts in to seeing those records.

## Errors and recovery

The terminal supports `/status`, `/resume`, `/reconnect`, `/abort`, `/abort all`, `/newgoal DESCRIPTION`, and `/loop SECONDS PROMPT`. See the [terminal controls](../packages/terminal/README.md).

An authentication or allowance error is retained in history and status. Restore the selected provider's credentials or capacity, then use `/resume`. Resume reuses its request identity and is allowed only when no tool ran during the failed turn. After a tool may have changed files or external systems, inspect that state and send an explicit follow-up instead. ADM does not switch providers, billing methods, or execution environments on failure.

Kubernetes resolves shell commands and port forwards against `deployment/workspace`, not a remembered Pod name. After a runtime replacement, reopen the shell or rerun the port command. Existing operating-system processes do not move between Pods.

```sh
adm port my-project 3000 --local-port 3000
adm browser my-project http://127.0.0.1:3000 --screenshot /workspace/preview.png
```

From a MacBook, forward that management-host port over your normal SSH connection: `ssh -L 3000:127.0.0.1:3000 MANAGEMENT_HOST`. Open `http://127.0.0.1:3000` on the MacBook. Port forwarding binds to loopback. A failed forward reports interruption; rerunning it resolves the current runtime.

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

The suite checks that this image is present on every schedulable node before creating anything. Ordinary `npm test` does not mutate the cluster. Passing the local-path experiment does not prove cross-node storage durability, a sudden-node-failure loss window, live account refresh, or MacBook connectivity.
