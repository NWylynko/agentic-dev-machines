# Running ADM

ADM has a Rust CLI and an in-cluster lifecycle service. Every supported client uses its Kubernetes access to reach the cluster; coding and bot agents, their model requests, tools, MCP servers, goals, and schedules run in their own workspace Pods. Terminal and shell attachments are clients; closing one does not stop an agent.

## Client connection

Install ADM on any supported macOS or Linux client with configured Kubernetes access, then run `adm setup` if first installation did not open it. Setup offers to install or update the cluster controller. Client lifecycle commands create a temporary authenticated port-forward that ends with the command. Git and `gh` are needed for repository discovery. Rust, Go, npm, and the checkout are only needed for source development. See [installation and updates](installation.md) for supported platforms and prerequisites.

```sh
adm setup
adm list
adm doctor
```

Setup creates the internal lifecycle credential in Kubernetes only when its Secret is missing and reuses it on later runs. Each client reads it through its selected kubeconfig into memory; no local token file is created by default. Nonsecret connection settings are saved after rollout and an authenticated API check succeed. Explicit `--lifecycle-token-file` or `ADM_LIFECYCLE_TOKEN_FILE` selects a protected client file instead. Automatic setup uses `adm-system`; see [advanced manual installation](installation.md#advanced-manual-installation) for separately managed connections.

`adm doctor` shows whether lifecycle access used the selected explicit URL or a command-scoped port-forward, and reports the actual loopback endpoint for the current invocation. The lifecycle controller continues admitted operations and workspace agents after the client exits.

Make sure `$HOME/.local/bin` is on your shell's PATH. `adm doctor` reports local tools, cluster readiness, the default StorageClass, and the selected CLI state directory. Use `adm doctor --storage-class NAME` to inspect another class; node-local storage is labeled explicitly. Diagnostics do not allocate a workspace or install missing prerequisites.

`adm system-log` prints the last hour of logs from the cluster-owned ADM services (`lifecycle` and `provider-auth`), merged in time order with each line prefixed by its service. It reads them with `kubectl logs` through your kubeconfig and needs no lifecycle connection. `--service NAME` limits it to one service, `--since 6h` reads further back, and `--follow` keeps streaming (lines then appear in arrival order). provider-auth logs one JSON line per login, logout, refresh and error, never a token, so `adm system-log --service provider-auth` is the first place to look when agents can't authenticate.

Use `adm login [PROVIDER]` to authenticate once for every existing and new workspace, or `adm logout PROVIDER` to revoke that account. Omitting the provider opens Pi's provider and authentication-method selectors. The host CLI relays Pi's prompts and sign-in instructions while the lifecycle deployment owns the durable auth store on its persistent volume. Agents send their exact projected Pod identity to the lifecycle controller for each auth resolution; the controller validates the current Pod and lease before the authority returns request auth. OAuth refresh is serialized and persisted centrally, and refresh credentials never reach workspace Pods. Requests already admitted when logout begins may finish; requests resolved after logout fail with an explicit authentication error. ADM does not select a fallback provider or credential source. Workspace-scoped `--credential-env` Secret references configure explicit environment variables independently and are not used as a fallback by shared provider authentication.

Choose a default model in `adm setup`, or select one explicitly with `--model PROVIDER/MODEL_ID` when creating an agent workspace. `faux/faux-1` is a deterministic local test provider and is available only when explicitly selected. It does not call an external model.

```sh
adm status my-project
adm attach my-project
```

`adm start`, `adm serve`, and `adm stop` do not start a host-side agent runtime. Workspace Pods start and supervise their own agents independently of the management host, CLI, SSH, and terminal connections.

Kubernetes credentials stay on each client. `adm create` records the selected `KUBECONFIG` path list for each coding workspace so coding tools keep using the selected cluster after Pod replacement. Use `--kubeconfig PATHS` or `KUBECONFIG` to select a file or the normal colon-separated merge list; relative entries are made absolute. If neither is set, ADM uses `$HOME/.kube/config`. Kubeconfig contents never enter a workspace Pod. `adm reconnect NAME --kubeconfig PATHS` verifies namespace ownership and updates the coding-tool connection while preserving the workspace ID, files, and history.

The default CLI state directory is `$XDG_DATA_HOME/adm`, or `$HOME/.local/share/adm` when XDG_DATA_HOME is unset. Lifecycle state and deletion work are owned by the in-cluster service on its persistent volume. See [controller installation](installation.md#in-cluster-lifecycle-owner) and [the lifecycle API](lifecycle-api.md) for the management connection and authentication boundary.

## Published builds

`.github/workflows/build.yml` checks the CLI, runner, and terminal on pull requests and on `main`. Markdown-only changes skip that workflow. FUSE repository tests stay on a machine with `/dev/fuse`. Pull requests that change the build smoke the workspace image, then stop. Pushes to `main` that change the build, version tags (`v*`), and manual runs from `main` publish the `linux/amd64` image to `ghcr.io/nwylynko/agentic-dev-machines`:

| Git ref  | Image tags                                  |
| -------- | ------------------------------------------- |
| `main`   | `latest`, `sha-<commit>`                    |
| `v0.1.0` | `0.1.0`, `v0.1.0`, `latest`, `sha-<commit>` |

After verification and image publishing pass on all native client runners, a `main` build automatically creates a GitHub release under `sha-<commit>` and marks it latest. The release includes native archives for Linux amd64/arm64 and macOS x86_64/arm64, plus checksums. Each archive contains the CLI, compiled runner/terminal, native production Node dependencies, and lifecycle deployment manifests; Linux archives also include the repository helper. Both controller images in the bundled manifests match the release image. Installation needs no checkout. The bundle records its matching `sha-<commit>` workspace image reference; setup can select a different image.

The installer consumes the latest successful `main` release automatically. Optional `v*` tags also publish pinned releases; they do not change the installer's latest release. Rerunning the same build preserves published assets. An older or unrelated main build is published under its own tag and is not promoted over a newer published build. A draft left by a failed publish is not reused; delete that draft before rerunning the build. Markdown-only pushes skip publication; a manual Build run on `main` can publish that commit when needed.

The installer preserves settings and leaves services running on updates. Rerun `adm setup` and select the desired image to update the controller and its management connection. Setup retains its existing credential and PVC; its StorageClass cannot be changed in place. Existing workspace Pods keep their own image and storage settings.

The workflow token needs package write access; the first push creates the GHCR package. If that package is private, the cluster needs a pull credential. A node that cannot pull from GHCR still needs the image imported locally.

## Workspace image and storage

```sh
docker build -f image/Dockerfile -t adm-dev:0.1.0 .
```

For local image development, distribute that exact image to the cluster's nodes and pass `--image adm-dev:0.1.0`. Installed releases default to their matching published GHCR reference unless setup configured another image. Building it on the management host does not make it available to Kubernetes. ADM does not install node helpers or change container-runtime configuration.

Configure a replicated StorageClass as described in [storage.md](../deploy/storage.md). The default is `adm-replicated`; this repository does not install a storage backend. The filesystem must support the required mount behavior. Include the lifecycle service's SQLite PVC and workspace volumes in the backup plan; SQLite WAL compatibility is required for the lifecycle state volume.

When a node stays not Ready for 3 minutes, the lifecycle moves each workspace Pod on it by force deleting that Pod. Its Deployment then starts a replacement on a healthy node, where the replicated volume reattaches. Any agent turn in progress on the dead node is lost and must be resumed. A node that keeps going down and coming back moves its workspaces each time. Kubernetes holds an RWO volume on an unreachable node for up to 6 more minutes (its force-detach timeout) before the replacement can mount it, so expect roughly 10 minutes from failure to a working workspace. The runtime lease ensures a returning old Pod never owns the workspace again. Nothing moves if the lifecycle Pod itself is on the dead node. Node-local volumes cannot move.

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

`adm create` writes lifecycle stage starts and elapsed stage/total durations to stderr and returns its workspace record on stdout. It reports the StorageClass lookup, resource apply, deployment readiness, optional repository preparation, and runner startup/registration separately. For `--repo`, creation waits until the owned Pod container is running, prepares the private checkout, then waits for Deployment readiness so a missing repository path cannot block startup. `adm destroy` returns its durable lifecycle operation receipt after deletion is admitted; use `adm destroy NAME --wait` to wait for completion and receive the deleted workspace record. A repeated destroy resumes the same operation, including after service restart. The lifecycle service records a tombstone before namespace cleanup, and stores cleanup stages, timings, and failures in the operation receipt and workspace status. These timings cover ADM's synchronous calls; for example, deployment readiness includes whatever Kubernetes waits on before the Deployment becomes Available, such as storage binding, scheduling, and initialization. Use the slowest stage to guide further measurements; the CLI does not infer a cause or split Kubernetes internals into separate durations.

When both stdin and stdout are terminals, a successful `adm create NAME` attaches once to that workspace's durable agent. Without a default model, the normal `/model` selector remains available in the terminal. Pipes and redirected output stay creation-only and return the ready workspace JSON; use `--no-attach` to request that behavior explicitly from an interactive shell. If attachment fails after creation, the error includes the immutable workspace ID and the recovery command `adm attach IMMUTABLE_ID`. Closing or detaching the terminal leaves the workspace and agent running.

If coding tools cannot use Kubernetes, verify that the selected host kubeconfig reaches the intended cluster and run `adm reconnect NAME --kubeconfig PATHS`. The command checks the namespace's immutable workspace ownership, then updates the Pod runtime's host-side tool connection while retaining the namespace, workspace ID, files, history, goals, and loops. If active work blocks the rebind, stop it deliberately with `adm abort NAME`, then retry. A workspace Pod replacement retains the registered connection. The `--kubeconfig` argument accepts the ordinary colon-separated merge list; CLI-relative entries are resolved from the current directory.

Every workspace starts with a durable agent. Without a configured default, select a model after attaching with `/model`; input remains paused until a model is selected. By default `/repos` is an ordinary writable directory, so normal cloning works. `--repo OWNER/REPO` performs a normal full clone of a public GitHub repository into `/repos/OWNER/REPO`; Git checks out the remote's advertised default branch. The shell and coding agent start there. The clone uses the private workspace volume and does not enable the lazy catalog. Private repository authentication is not configured by this option, and the clone does not use shallow or filtered fetches. Providing `--catalog` opts in to the lazy catalog; it cannot be combined with `--no-repositories` or the bot role. `--repo` cannot be combined with `--catalog`, `--no-repositories`, or bot workspaces.

Add `--branch BRANCH` to open the repository on that branch. An existing `origin/BRANCH` is checked out with remote tracking. Otherwise ADM creates a local branch from the remote's advertised default branch, which may have any name. `--base REF` selects a different starting commit for a new branch; use a Git ref such as `origin/release`, a tag, or a commit ID. An existing remote branch takes precedence over `--base`. New branches remain local until you push them. Both flags require `--repo`, and `--base` also requires `--branch`.

```sh
adm create feature-work --repo OWNER/REPO --branch feature/work
adm create release-fix --repo OWNER/REPO --branch fix/release --base origin/release
```

Branch validation and checkout happen inside the owning Pod, in staging before the repository is published at `/repos/OWNER/REPO`. A missing base fails creation without publishing a checkout. The persisted creation choices include branch and base; retries with changed choices are rejected. To retry a failed create, repeat the same command and options; the workspace ID, namespace, private volume, published files, edits and branch changes are retained. Passing the original `--operation-id` from `adm status NAME --json` (`workspace.creation_operation_id`) also replays that operation. If another create attempt is still running, the error identifies its operation instead of starting another provisioner. Deleting the workspace ends this retry path; creating the name again allocates a new identity.

`adm shell NAME` opens an interactive zsh login shell with pinned Oh My Zsh at the workspace's selected working directory (`/repos` by default, or the selected repository root). `SHELL` is `/usr/bin/zsh`, which is also the workspace user's login shell. The editable startup file is `~/.zshrc`. That path is `/workspace/.adm/zsh/.zshrc` on the private volume: the image symlinks `~/.zshrc` there, the file is seeded once, and edits survive Pod replacement. History lives in the same directory. Interactive shells include `$HOME/.local/bin` on `PATH`. A managed shell keeps its `adm` client ahead of that directory. Shell startup never downloads updates. For a catalog workspace, `pwd -P` may show its backing storage path under `/workspace/.adm`; that is the same directory through the `/repos` view. Commands supplied to `adm shell NAME -- COMMAND...` or `adm exec` run as given. They do not source `~/.zshrc`, and they do not gain the interactive `PATH`.

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

The workspace and ordinary commands still run as UID 1000. The container gets the capabilities needed for sudo and apt; it does not grant host access. Each Pod receives only its own projected lifecycle identity. Installed packages and other operating-system changes live in the replaceable container and disappear when Kubernetes replaces its Pod. Repository files, Git state, and agent history follow their separate persistence rules.

To seed the catalog without cloning repository contents:

```sh
adm-repositories discover --owner example-owner > /tmp/adm-catalog.json
adm create my-project --catalog /tmp/adm-catalog.json --model PROVIDER/MODEL_ID
```

Discovery authenticates `gh` on the management host. GitHub HTTPS authentication in a coding workspace uses its explicit `GH_TOKEN` Secret reference described above. The lazy catalog sidecar does not receive that token, so private lazy fetches need a separate credential design. Credentials must not appear in remote URLs. No eager-clone fallback is used when an upstream lacks filtering support. A failed acquisition stays retryable after its cause is fixed.

The repository service requires FUSE, mount propagation, and a Linux kernel supporting unique mount identities (`STATX_MNT_ID_UNIQUE`, available since Linux 6.8 according to [statx(2)](https://man7.org/linux/man-pages/man2/statx.2.html)). It fails clearly when that support is unavailable. The repository sidecar currently has elevated mount authority; the `dev` container has the standard own-container administration profile while retaining UID 1000 for ordinary work. It receives neither a service-account token nor management-host credentials. Treat the sidecar as a separate trusted component. The immutable-upstream cache is optional and must be mounted read-only; each workspace's Git state and writable files remain private.

## Find your repositories

Use `/repos` for your work. Its contents depend on how the workspace was created:

| Creation choice     | What you find                                   | Next action                                               |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Plain workspace     | Empty, writable directory                       | Clone a repository into `/repos`                          |
| `--repo OWNER/REPO` | A private Git checkout at `/repos/OWNER/REPO`   | The default shell and coding agent start in that checkout |
| `--catalog FILE`    | Owner and repository listings from that catalog | Enter a listed repository to acquire its files            |

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
adm create supervisor --role bot --model PROVIDER/MODEL_ID
adm attach supervisor
```

Bots execute their model and tools in their own workspace Pod. They can discover and control all live coding-agent workspaces through the authenticated lifecycle and runtime APIs, without repository, shell, or general cross-workspace access. `adm status supervisor` reports runtime readiness; `adm inspect supervisor` provides detailed diagnostics.

New bot conversations start one durable setup turn. The bot asks for an identity and purpose and publishes the setup question through `sendMessage`; its saved profile appears in future model instructions and survives Pod replacement. Ordinary model output remains private in diagnostics.

Bots and coding agents get external tools from the installation's MCP connectors (see [MCP connectors](#mcp-connectors)).

Bots discover all live coding agents with `listAgents` and address them by immutable workspace ID. They can inspect status and paginated history (including tool events), prompt, steer or follow up, resume or abort foreground/background work, manage goals and loops, change models, and admit create/delete operations. Operation IDs provide durable receipts; `monitorAgentOperation` reads completion and failure after admission. Every target call is authorized against the caller's current Pod identity and lease. A deleted target's receipt remains tied to its immutable ID if a name is reused. Bots have no coding filesystem, shell, or development browser, including through Code Mode. `adm attach supervisor --diagnostics` explicitly opts in to seeing diagnostics.

`adm list` shows persisted workspace phase alongside live Pod readiness and agent activity. The lifecycle service makes one bounded Pod-directory request and reads every Pod's runtime status at once under a 1-second collection bound, so one hung runtime delays a list by at most about a second. Runtime status (activity and selected model only) needs no token: the workspace NetworkPolicy admits port 7432 only from the lifecycle Pod and, for coding workspaces, bot Pods. A failed status read stays `unavailable` with its cause. `adm list --json` includes an `activity` object; add `--all` to include deleted workspaces. `adm status NAME` reports namespace, requested and selected model, resources, Pod readiness/node, activity, and available failure causes. `adm inspect NAME` provides the same labeled diagnostics, and JSON modes preserve the full payload. Deleted state takes precedence over any stale Pod/runtime report.

## MCP connectors

An MCP connector is a remote MCP server shared by every coding agent and bot in the installation. Add one and sign in with the browser:

```sh
adm mcp add linear https://mcp.linear.app/mcp
adm mcp list
adm mcp login linear    # sign in again, for example after the grant was revoked
adm mcp logout linear   # every agent loses its tools until the next sign-in
adm mcp remove linear
```

`adm mcp add` registers the server with the cluster authority (the lifecycle deployment's provider-auth container), prints the authorization URL and opens it in a browser when it can. The authority discovers the server's OAuth metadata, registers a client dynamically and uses PKCE; the browser returns to a loopback port on the device running `adm`, which passes only the one-time code to the authority. The browser therefore has to run on the same device as the CLI. The authority stores the grant on its persistent volume beside provider credentials, refreshes it centrally, and gives workspace Pods only access tokens after validating their projected identity. Refresh tokens never reach a Pod, and no token is written to ADM config, workspace files, logs or chat.

Running agents pick up connector changes at their next turn without being recreated. Their tools are named `mcp_<connector>_<tool>`, are available to bot Code Mode scripts, and each call fetches a current access token, so a removed or signed-out connector fails visibly even before its tools are withdrawn. The agent's prompt lists each connector's state and the `adm mcp login NAME` command when one needs sign-in. `adm status NAME` prints `MCP connector NAME unavailable for ...` with the cause. Aborting a turn cancels its in-flight MCP call, and closing or deleting a workspace closes its MCP sessions. Read-only MCP tools may replay after recovery when the server marks them read-only; other calls are not replayed after interruption.

Only remote Streamable HTTP servers with OAuth sign-in are supported. Every agent receives every connector; choosing which agents get which connectors is not available yet. The per-workspace `--mcp-config` stdio grants were removed.

## Errors and recovery

The terminal supports `/status`, `/resume`, `/reconnect`, `/abort`, `/abort all`, `/newgoal DESCRIPTION`, and `/loop SECONDS PROMPT`. See the [terminal controls](../packages/terminal/README.md).

Each workspace runtime holds and renews a lifecycle fence. If it cannot verify that fence, it records the cause, closes its harness and scheduled work, returns unhealthy readiness, and rejects new requests and Durable commits. The Pod's liveness probe restarts the runtime after three failed checks at ten-second intervals; the replacement must acquire a fresh fence before serving. This is fail-stop behavior, not a provider or host-runtime fallback. The directory reports runtime status as unavailable with the observed cause while it cannot reach the Pod.

An authentication or allowance error is retained in history and status. Restore the selected provider's credentials or capacity, then use `/resume`. Resume reuses its request identity and is allowed only when no tool ran during the failed turn. After a tool may have changed files or external systems, inspect that state and send an explicit follow-up instead. ADM does not switch providers, billing methods, or execution environments on failure.

Kubernetes resolves shell commands and port forwards against `deployment/workspace`, not a remembered Pod name. After a runtime replacement, reopen the shell or rerun the port command. Existing operating-system processes do not move between Pods.

```sh
adm port my-project 3000 --local-port 3000
adm browser my-project http://127.0.0.1:3000 --screenshot /workspace/preview.png
```

The port is available on the client device running `adm port`; open `http://127.0.0.1:3000` there or use that device's own network forwarding tools to expose it. ADM binds to loopback by default. A failed forward reports interruption; rerunning it resolves the current runtime.

## Herdr ownership and deletion

Herdr integration is configured independently on each client device. Use `adm create NAME --herdr` inside a Herdr session to create a ready ADM workspace, create a new stock-Herdr space labeled with its name, bind them by immutable IDs, and queue exactly one `adm attach IMMUTABLE_ID` in the returned initial pane. The command uses the client's current local directory as Herdr's cwd and does not change the invoking space's focus. It preserves the selected ADM connection paths without passing a bearer value. `--herdr` works in noninteractive commands; it cannot be combined with `--no-attach` or `--herdr-space`. If any handoff step fails after ADM creation, the error identifies the workspace ID and any created Herdr space ID and gives `adm attach IMMUTABLE_ID` as recovery. The initial pane is marked local so the device shell router does not replace this host-side attach with a remote shell. Other panes in the bound space use the workspace's saved cwd. Binding sets Herdr's `terminal.default_shell` to the device router and runs `herdr server reload-config`, because a running Herdr server only reads `config.toml` at start or reload; `adm herdr disable` reloads after restoring the previous shell. Both fail with the reload error if the running server cannot apply it. Named Herdr sessions share `config.toml`, so another already-running session needs its own `herdr server reload-config`. If a routed pane cannot reach its workspace, the pane shows the error and stays open until Enter instead of closing silently.

```sh
# In an existing local pane of the Herdr session
adm create my-project --herdr
# Or bind a workspace to the current space separately
adm create another-project
adm herdr bind another-project "$HERDR_WORKSPACE_ID"
adm attach IMMUTABLE_ID

# Optional: start close-event cleanup inside this Herdr session under a
# supervisor of your choice. This is independent of shell routing and binding.
adm herdr watch --socket "$HERDR_SOCKET_PATH"
adm herdr status
adm herdr disable
adm herdr hook
```

The optional watcher listens only for explicit `workspace.closed` events from the exact current Herdr socket. It syncs one close receipt per immutable ADM workspace ID before requesting deletion and removes only that receipt after admission succeeds; restart replays the receipts that remain. `adm herdr status` verifies the installer's live watcher control socket, its confirmed subscription, and the matching Herdr socket. `adm herdr disable` stops ADM-owned watchers and restores Herdr's previous shell setting. Herdr has no replay cursor, so a close missed while disconnected cannot be recovered; a lost connection is never treated as deletion. The watcher and live Herdr delivery still need acceptance in an actual Herdr session.

The association is scoped by device, Herdr server session, and immutable Herdr space ID, so a repeated ID on another device or session cannot delete the wrong ADM workspace. Without the optional watcher, closing a Herdr space does not clean up its ADM workspace. Ordinary ADM commands do not require Herdr or its watcher.

Deletion writes a durable tombstone before cancellation and runtime cleanup. Repeating it finishes interrupted cleanup, and recreating the same label gets a different ID. Old goals, loops, input, and operation receipts remain bound to the deleted immutable ID and cannot attach to the replacement. Retained conversation history is passive; archive expiry is not implemented.

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

The CLI tests need Python 3, Node.js, and zsh on the test host: their Pod fixtures execute the real workspace shell arguments locally. The Node tests use real HTTP/SSE, SQLite, subprocess kills/restarts, a terminal PTY, and Chromium. They need permission to open loopback sockets and run a browser. The Go filesystem tests need `/dev/fuse`, FUSE mount permission, and the pinned `artifact-fs` binary on PATH. Install that pin with `go install github.com/cloudflare/artifact-fs/cmd/artifact-fs@$(cat packages/repositories/ARTIFACTFS)`. A missing FUSE device produces an explicit skip; a missing binary with FUSE available fails.

The lighter cluster contract check needs no workspace image or storage provisioner. It creates and removes uniquely owned bot namespaces, validates the coding manifests with the real API's server-side dry run, and exercises explicit Herdr-event cleanup and label reuse:

```sh
ADM_LIVE_CLUSTER=1 npm run test:cluster-contract
```

These opt-in cluster test scripts currently require explicit `ADM_LIFECYCLE_URL` and `ADM_LIFECYCLE_TOKEN_FILE` settings for their test connection. They use the protected client-file mode described in [advanced manual installation](installation.md#advanced-manual-installation); ordinary CLI use after `adm setup` uses its saved Kubernetes credential source. The tests never fall back to a host runner.

The full opt-in cluster suite creates coding workspaces, checks normal Git and untracked work after Pod replacement, checks browser and forwarded-port behavior, then destroys its namespaces and claims. It uses local-path deliberately and never drains a node:

```sh
cargo build
ADM_LIVE_CLUSTER=1 ADM_LIFECYCLE_URL=http://127.0.0.1:7433 ADM_LIFECYCLE_TOKEN_FILE=/secure/path/lifecycle-token ADM_LIVE_IMAGE=adm-dev:0.1.0 npm run test:cluster
```

The suite checks that this image is present on every schedulable node before creating anything. Ordinary `npm test` does not mutate the cluster. Passing the local-path experiment does not prove cross-node storage durability, a sudden-node-failure loss window, live account refresh, or connectivity from client laptops.

On 2026-10-16, an isolated Kubernetes permission check verified the lifecycle role against a Pod using an older cached image: target Pod-bound `adm-runtime` TokenRequest succeeded, TokenReview confirmed the namespace, ServiceAccount, Pod UID, and audience, an unrelated audience was rejected, another ServiceAccount name and TokenRequest from the workspace ServiceAccount were forbidden, Pod exec ran as UID 1000, and a namespace apply retry succeeded. The temporary namespaces, ClusterRole, and binding were removed. This validates those API permissions only; it does not validate the new workspace image, full runtime startup, provider access, or persistence across a real Pod replacement.
