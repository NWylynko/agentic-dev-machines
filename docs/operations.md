# Running ADM

ADM has a Rust CLI and a long-running access runner on the management host. Coding agents execute in their workspace Pods, and provider credentials belong to the selected workspace. Terminal attachments are clients; closing one does not stop an agent.

## Management host

Install the standalone release with the command in the [README](../README.md), then run `adm setup`. The management host needs Node.js 24+, `kubectl`, and Git; `gh` is needed for repository discovery. Rust, Go, npm, and the checkout are only needed for source development. See [installation and updates](installation.md) for prerequisites, version selection, and migrating an older manual installation.

Make sure `$HOME/.local/bin` is on your shell's PATH. `adm doctor` reports tool availability, cluster readiness, the default StorageClass, runner health, and the selected local state directory. It preserves storage and runner error causes instead of treating every failure as a stopped service. Use `adm doctor --storage-class NAME` to inspect another class; node-local storage is labeled explicitly. Diagnostics do not allocate a workspace or install missing prerequisites.

Use Pi's `/login` in the selected coding workspace to create its private, writable authentication store at `/workspace/.adm/pi/auth.json`. The store lives on that workspace's private persistent volume, so Pod replacement retains refresh-token rotations and logout state. Pi commits a rotated refresh token before releasing the store lock; if the caller cancels while rotation is in flight, the runtime waits for the commit so the only valid refresh token is not lost. A separate workspace login has an independent token family. If an operator intentionally shares one OAuth token family, it must have one canonical mutable store owner; do not copy the same refresh token into multiple independently refreshing stores. For API keys, an operator can create a Secret in that workspace namespace and pass only a key reference, for example `--credential-env OPENAI_API_KEY=provider-auth:openai`. Secret values supplied as environment variables are read when the Pod starts, so replacing a Secret requires Pod replacement before that value reaches the process. The value is delivered to the dev container and is not saved in ADM workspace metadata or service units. Full root inside a workspace can read credentials delivered there, so scope each Secret to that workspace and provider. If the provider rejects refresh or credentials are revoked, the selected model request fails visibly; ADM does not select a fallback provider or credential source. Log out or repair the selected workspace credential, then explicitly retry the failed request. Subscription compatibility depends on the provider integration and has not been validated for every account. `adm login` configures the local Pi host store and does not copy it into workspaces.

Choose a default model in `adm setup`, or select one explicitly with `--model PROVIDER/MODEL_ID` when creating an agent workspace. `faux/faux-1` is a deterministic local test provider and is available only when explicitly selected. It does not call an external model.

```sh
adm start
adm status my-project
```

`adm start` detaches the runner from the invoking terminal. For restart after a management-host reboot or runner crash, use `adm setup` to install the user service supervising `adm serve`. A manual [service template](../deploy/adm-runner.service) is also available. Do not start a second runner for the same state directory. Its owner lock rejects competing processes; SQLite is not a multi-owner database.

Kubernetes access stays on the management host. `adm create` records the host-side `KUBECONFIG` path list for each coding workspace and passes it to the runner's `kubectl` process, including after runner restart. Use `--kubeconfig PATHS` or `KUBECONFIG` to select a file or the normal colon-separated merge list; relative entries are made absolute. If neither is set, ADM records `$HOME/.kube/config`. An empty `KUBECONFIG` uses that same default; empty entries inside a merge list are rejected clearly. The runner stores only these paths, never kubeconfig contents. Existing coding workspaces registered before this setting was added fail tool calls clearly and never fall back to the runner's ambient Kubernetes context. Repair one in place with `adm reconnect NAME --kubeconfig PATHS`; omit the flag to use the current CLI default. ADM verifies the namespace's immutable workspace ID with the selected connection, refuses while work is active, and keeps the same files, workspace ID, and history. Do not copy kubeconfig files into the development container.

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
adm create my-project --repo OWNER/REPO --model PROVIDER/MODEL_ID
adm attach my-project
adm shell my-project
adm shell my-project --manage
adm prompt my-project 'Inspect the repository and describe its current state.'
adm list
adm status my-project
adm inspect my-project
```

`adm create` writes lifecycle stage starts and elapsed stage/total durations to stderr and returns its workspace record on stdout. It reports the StorageClass lookup, resource apply, deployment readiness, optional repository preparation, and runner startup/registration separately. `adm destroy` returns its durable operation receipt after deletion is admitted; use `adm destroy NAME --wait` to wait for completion and receive the deleted workspace record. A repeated destroy by name resumes the same deletion operation. The lifecycle service records cleanup stages, timings, and failures in the operation receipt and workspace status. These timings cover ADM's synchronous calls; for example, deployment readiness includes whatever Kubernetes waits on before the Deployment becomes Available, such as storage binding, scheduling, and initialization. Use the slowest stage to guide further measurements; the CLI does not infer a cause or split Kubernetes internals into separate durations.

If an older coding workspace's tool calls report that no Kubernetes connection is pinned, verify that the selected host kubeconfig reaches the intended cluster and run `adm reconnect NAME --kubeconfig PATHS`. The command checks the namespace's `adm.dev/workspace-id` ownership label, then updates the runner's persisted host connection while retaining the same namespace, workspace ID, files, Durable history, goals, and loops. If active work blocks the rebind, stop it deliberately with `adm abort NAME`, then retry. Restarting the runner alone does not change a registered connection. The `--kubeconfig` argument accepts the ordinary colon-separated merge list; CLI-relative entries are resolved from the current directory.

Every workspace starts with a durable agent. Without a configured default, select a model after attaching with `/model`; input remains paused until a model is selected. By default `/repos` is an ordinary writable directory, so normal cloning works. `--repo OWNER/REPO` performs a normal full clone of a public GitHub repository into `/repos/OWNER/REPO`; Git checks out the remote's advertised default branch. The shell and coding agent start there. The clone uses the private workspace volume and does not enable the lazy catalog. Private repository authentication is not configured by this option, and the clone does not use shallow or filtered fetches. Providing `--catalog` opts in to the lazy catalog; it cannot be combined with `--no-repositories` or the bot role. `--repo` cannot be combined with `--catalog`, `--no-repositories`, or bot workspaces.

`adm shell NAME` opens zsh with pinned Oh My Zsh at the workspace's selected working directory (`/repos` by default, or the selected repository root). Its editable `.zshrc` and history live under `/workspace/.adm/zsh` (`ZDOTDIR`), are seeded once, and survive Pod replacement. Shell startup never downloads updates. For a catalog workspace, `pwd -P` may show its backing storage path under `/workspace/.adm`; that is the same directory through the `/repos` view. Commands supplied to `adm shell NAME -- COMMAND...` or `adm exec` run as given and keep their own working-directory behavior.

Use `adm shell NAME --manage` when you also need the current agent controls from inside that shell. The private `adm` client supports `adm status [--json]`, `adm history [--after N] [--limit N]`, `adm prompt MESSAGE`, `adm abort [--background]`, and `adm help`. History defaults to 200 entries; its response limit is 1 MiB, so use a smaller `--limit` if it reports an oversized response. It can address only the workspace selected on the management host; workspace IDs, host state, credentials, and the runner URL are not passed into the development container. Same-workspace processes can use the allowed actions while the managed session is open. Closing the shell closes the temporary management relay and leaves the agent running. The ordinary `adm shell NAME` path does not start a relay. Use the management host for `adm list`, creation/deletion, port forwarding, `exec`, and other workspace operations.

The workspace image includes `nano`, GitHub CLI (`gh`), and passwordless `sudo`. `gh` comes from GitHub's signed Debian repository and takes the current stable package when the image is built; an existing image stays at that package version until rebuilt. Git's credential helper uses only an explicit `GH_TOKEN` supplied to that workspace. It applies to HTTPS remotes on `github.com`; Git author identity remains the repository's separate `user.name` and `user.email` settings. The helper does not save credentials in Git or `gh` config, and it does not send the token to other hosts.

Provision a fine-grained token through the selected secret manager, limited to the repository or repositories the workspace needs and with repository `Contents: read and write` permission for pushes. Have the cluster's secret controller create a key such as `token` in the workspace's own namespace, then select that key when creating the workspace:

```sh
adm create package-workspace \
  --credential-env GH_TOKEN=github-auth:token \
  --repo OWNER/REPO
```

The namespace Secret must exist before the Pod starts. ADM stores only its name and key reference; the Kubernetes Pod receives the value as `GH_TOKEN`. Never place the token in a remote URL, shell command, workspace file, ADM configuration, or image. The image fails Git authentication with actionable guidance when `GH_TOKEN` is missing, and reports when GitHub rejects the workspace token. After updating the Secret, replace the Pod so the process receives the new environment value; for example, get the namespace from `adm status NAME --json` and run `kubectl -n WORKSPACE_NAMESPACE rollout restart deployment/workspace`. Updating a Secret alone does not change an existing process. Limit each token to the repositories that workspace is allowed to write. GitHub documents [`GH_TOKEN`](https://cli.github.com/manual/gh_help_environment) for headless CLI authentication and [`gh auth setup-git`](https://cli.github.com/manual/gh_auth_setup-git) for configuring Git's credential helper.

New coding workspaces permit unattended administration inside their own container by default:

```sh
adm create package-workspace
adm shell package-workspace
# Inside the workspace shell:
sudo apt-get update
sudo apt-get install -y ripgrep
```

The workspace and ordinary commands still run as UID 1000. The container gets the capabilities needed for sudo and apt; it does not grant host access or a service-account token. Bots use the same profile when TASK-22 provides their workspace Pods. Installed packages and other operating-system changes live in the replaceable container and disappear when Kubernetes replaces its Pod. Repository files, Git state, and agent history follow their separate persistence rules.

To seed the catalog without cloning repository contents:

```sh
adm-repositories discover --owner example-owner > /tmp/adm-catalog.json
adm create my-project --catalog /tmp/adm-catalog.json --model PROVIDER/MODEL_ID
```

Discovery authenticates `gh` on the management host. GitHub HTTPS authentication in a coding workspace uses its explicit `GH_TOKEN` Secret reference described above. The lazy catalog sidecar does not receive that token, so private lazy fetches need a separate credential design. Credentials must not appear in remote URLs. No eager-clone fallback is used when an upstream lacks filtering support. A failed acquisition stays retryable after its cause is fixed.

The repository service requires FUSE, mount propagation, and a Linux kernel supporting unique mount identities (`STATX_MNT_ID_UNIQUE`, available since Linux 6.8 according to [statx(2)](https://man7.org/linux/man-pages/man2/statx.2.html)). It fails clearly when that support is unavailable. The repository sidecar currently has elevated mount authority; the `dev` container has the standard own-container administration profile while retaining UID 1000 for ordinary work. It receives neither a service-account token nor management-host credentials. Treat the sidecar as a separate trusted component. The immutable-upstream cache is optional and must be mounted read-only; each workspace's Git state and writable files remain private.

## Find your repositories

Use `/repos` for your work. Its contents depend on how the workspace was created:

| Creation choice | What you find | Next action |
| --- | --- | --- |
| Plain workspace | Empty, writable directory | Clone a repository into `/repos` |
| `--repo OWNER/REPO` | A private Git checkout at `/repos/OWNER/REPO` | The default shell and coding agent start in that checkout |
| `--catalog FILE` | Owner and repository listings from that catalog | Enter a listed repository to acquire its files |

For a plain workspace, run these inside `adm shell NAME`:

```sh
cd /repos
git clone https://github.com/NWylynko/agentic-dev-machines.git
cd agentic-dev-machines
git status
```

To prepare that checkout during creation instead, run `adm create NAME --repo NWylynko/agentic-dev-machines` on the management host. This uses an ordinary private clone and does not enable the lazy catalog.

For a catalog containing `NWylynko/agentic-dev-machines`, run these inside its shell:

```sh
cd /repos
ls
ls /repos/NWylynko
cd /repos/NWylynko/agentic-dev-machines
git status
```

Use names actually present in your catalog. The root and owner listings are read-only; files and Git state inside acquired repositories are private and writable. Listing or reading within a repository triggers acquisition, which can take time or report an upstream/authentication error.

`/workspace/.adm/catalog`, `.adm/git`, `.adm/repositories`, and `.adm/views` hold backing state. Normal work belongs under `/repos`. If you ran `ls .*` in `/workspace`, the shell expanded `.*` to the hidden `.adm` directory and `ls` showed its contents. Those names are children of `.adm`, so `cd repositories` from `/workspace` fails. Use `ls -la /workspace` to see the directory itself, then return to `/repos`.

## Bot workspaces

```sh
adm create supervisor --role bot --model PROVIDER/MODEL_ID --allow-agent CODING_WORKSPACE_ID
adm attach supervisor
```

Bots execute their model and tools in the long-running management-host runner. Their Kubernetes namespace intentionally has no workspace Pod. Creation reports this location on stderr while stdout remains the workspace JSON. `adm status supervisor` identifies the management host and distinguishes a reachable agent from an unavailable runner; `adm inspect supervisor` provides detailed diagnostics.

On that host, inspect a service runner with `systemctl --user show adm-runner.service -p MainPID -p ActiveState` and `journalctl --user -u adm-runner.service`. A runner launched by `adm start` writes `runner.pid` and `runner.log` in the ADM state directory (default `$XDG_DATA_HOME/adm`, or `~/.local/share/adm`). Registration and conversations are under `runner/workspaces.json` and `runner/sessions/ID/session.sqlite`. Use the same `--state-dir` and `--runner-url` as the owning runner when inspecting it.

New bot conversations start one durable setup turn. The bot asks for an identity and purpose and publishes the setup question through `sendMessage`; its saved profile appears in future model instructions and survives runner restarts. Existing bot conversations without a profile are left unchanged during upgrade. Ordinary model output remains private in diagnostics.

MCP access is configured by the host with a nonsecret JSON file that grants exact stdio server tools. Environment values are looked up by reference in the runner process and passed only to that MCP server; the runner does not pass its other environment through.

```json
[
  {
    "id": "notes",
    "command": "/usr/bin/node",
    "args": ["/opt/notes-mcp.mjs"],
    "tools": ["search_notes"],
    "secretEnv": { "NOTES_TOKEN": "MCP_NOTES_TOKEN" }
  }
]
```

```sh
adm create supervisor --role bot --model PROVIDER/MODEL_ID --mcp-config /etc/adm/supervisor-mcp.json
```

The config stores only the environment reference name, never its value. Only listed tools are registered for the bot and Code Mode. Read-only MCP tools may replay after recovery when the server marks them read-only; other calls are not replayed after interruption. Unsupported transports or malformed grants fail registration, while connection failures remain visible in status.

Use immutable IDs from `adm list` for supervision grants. A bot can use `listAgents` to discover the names and status of its live permitted coding agents, then observe and prompt those targets. Deleted or missing grants are reported as unavailable and never transfer to a workspace that reuses the same name. The bot can also manage goals and loops and publish through `sendMessage`. It has no coding filesystem, shell, or development browser, including through Code Mode. `adm attach supervisor --diagnostics` explicitly opts in to seeing diagnostics.

`adm list` shows each workspace's persisted phase and agent configuration alongside current activity and the full immutable ID. It makes one bounded runner directory request for all activity and does not contact Kubernetes; if the runner or an individual record is unavailable, activity is shown as `unavailable` with its cause. `adm list --json` returns the complete stored records plus an `activity` object; add `--all` to include deleted workspaces. `adm status NAME` expands the selected workspace with namespace, model, CPU, memory, storage, runtime readiness/state, agent activity, node, and available failure causes. Its table labels persisted `PHASE`, runtime readiness, and agent `ACTIVITY` separately. Bot workspaces currently have no Pod and identify the management host as their location. Use `adm status NAME --json` for the complete status payload, or `adm inspect NAME` for labeled diagnostics. `adm inspect NAME --json` returns the same payload as status JSON.

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
adm destroy my-project --wait
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
