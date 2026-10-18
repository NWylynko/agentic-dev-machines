# Installation and updates

ADM installs on macOS x86_64/arm64 and Linux amd64/arm64 clients. Each client uses its existing Kubernetes access, including access over Tailscale, to connect to the same cluster workspaces.

The client needs Node.js 24+, `curl`, `tar`, a SHA-256 utility, and `kubectl` configured for the cluster. Installing or updating the cluster controller also needs permission to manage its namespace and RBAC plus a replicated [StorageClass](../deploy/storage.md). No systemd or launchd service is required. The installer does not install system packages or a storage backend. Repository discovery needs Git and authenticated `gh`.

## Install and configure

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh | sh
```

The script selects a native release archive (`adm-linux-amd64.tar.gz`, `adm-linux-arm64.tar.gz`, `adm-darwin-amd64.tar.gz`, or `adm-darwin-arm64.tar.gz`) and verifies it against the release's `SHA256SUMS`. Successful `main` builds publish all supported client archives together. Each contains the native CLI and Node production dependencies for that platform. No checkout or build toolchain is needed.

The commands are installed in `$HOME/.local/bin`. Add that directory to your PATH if needed. The installation lives under `$XDG_DATA_HOME/adm/install`, or `$HOME/.local/share/adm/install` when XDG_DATA_HOME is unset. Versioned runtime files are separate from workspace and lifecycle-service state.

First interactive installation opens `adm setup`. With no terminal, or with `--no-setup`, installation prints the command to run later. Setup asks for the workspace image, storage class, and optional default model, then offers to install or update the cluster controller; the default answer is yes.

Settings are nonsecret JSON at `$XDG_CONFIG_HOME/adm/config.json`, normally `$HOME/.config/adm/config.json`. They include image/storage/model defaults and, after setup, whether the client should use its command-scoped Kubernetes forward, plus namespace, kubectl command, and selected kubeconfig paths. Explicit lifecycle URLs remain available for advanced connections and override saved settings. Setup saves settings only after rollout and an authenticated API check succeed. It keeps your selected Kubernetes context and saves an explicit image reference, so updates preserve your image choice.

```sh
adm setup
adm list
```

Run `adm connect` on another client that should use an existing installation. It checks authenticated access and saves this client's kubeconfig, namespace, and kubectl selection. It does not install or modify cluster resources.

Provider login is performed inside a selected workspace and is kept on its private volume. Workspaces always create their durable agent; a model can be selected later in `adm attach` with `/model`.

Authenticate once for the ADM installation with `adm login [PROVIDER]`; omitting the provider opens Pi's provider and authentication-method selectors. Use `adm logout PROVIDER` to revoke that shared login. The lifecycle deployment stores provider credentials on its persistent state volume and resolves request auth only after validating the workspace's projected lifecycle identity. Workspace-scoped `--credential-env` Secret references remain available for explicit workspace environment configuration, but are separate from shared provider authentication. Do not put values in ADM config, service files, or project `.env` files.

## In-cluster lifecycle owner

The CLI uses the in-cluster lifecycle API for workspace creation, deletion, and directory reads. `adm setup` applies its namespace, service account and RBAC, persistent state claim, single-owner Deployment, and private ClusterIP Service. It uses the selected image for both controller containers and the selected StorageClass for its state claim, then waits for rollout. The cluster must be able to obtain that image. Setup rejects the node-local `local-path` provisioner for controller state.

Setup generates the internal lifecycle credential only when the `adm-system/adm-lifecycle-token` Secret is missing, and reuses an existing Secret. The CLI reads that credential into memory through the selected host kubeconfig. The default flow creates no local token file and stores no token value in ADM config or a service unit. This credential is separate from provider credentials; workspace Pods receive their own projected identities.

Ordinary commands open an ephemeral loopback forward to the private lifecycle Service, fetch its bearer credential from the Kubernetes Secret into memory, and close only their own `kubectl` process on exit. The lifecycle operation, agent turn, workspace files, and history remain in Kubernetes when the client disconnects.

Automatic setup uses namespace `adm-system`; the local port is selected by kubectl for each command. An explicit `--lifecycle-url` or `ADM_LIFECYCLE_URL` selects a separately managed connection with no automatic fallback. A custom namespace uses `--lifecycle-namespace`. Declining controller installation changes workspace defaults without installing cluster resources. The [lifecycle API guide](lifecycle-api.md) describes the API and authentication boundary.

Process tests cover automatic installation, credential reuse, command-scoped forwarding, connection verification, and visible rollout failures against Kubernetes/HTTP fixtures. [Portable Linux client checks](client-validation-2026-10-18.md) verify independent connections and continued Pod work against the existing controller. Native macOS/arm64 execution remains unverified. See [setup validation](setup-validation-2026-10-17.md) for the older exact image/manifest combination and remaining limits.

### Advanced manual installation

The release includes Kubernetes manifests at `$XDG_DATA_HOME/adm/install/current/deploy/lifecycle`, normally `$HOME/.local/share/adm/install/current/deploy/lifecycle`. Both controller images are pinned to the release image, and packaging preserves Kubernetes token-file permissions. From a checkout, use `deploy/lifecycle`; its source image reference is `latest`. Adapt the manifests consistently when choosing a custom namespace.

For a manually managed credential, have your secret manager provide a protected client-token file and the matching Kubernetes Secret `adm-lifecycle-token`, key `token`, in `adm-system`. Keep values out of shell history, manifests, and repository files. For a fresh manually managed installation:

```sh
kubectl create namespace adm-system --dry-run=client -o yaml | kubectl apply -f -
kubectl -n adm-system create secret generic adm-lifecycle-token --from-file=token=/secure/path/lifecycle-token
kubectl apply -k "${XDG_DATA_HOME:-$HOME/.local/share}/adm/install/current/deploy/lifecycle"
kubectl -n adm-system rollout status deployment/adm-lifecycle
kubectl -n adm-system port-forward service/adm-lifecycle 7433:7433
```

Supervise this manual port-forward separately and select the endpoint and protected token file:

```sh
export ADM_LIFECYCLE_URL=http://127.0.0.1:7433
export ADM_LIFECYCLE_TOKEN_FILE=/secure/path/lifecycle-token
adm doctor
adm list
```

An explicit `--lifecycle-token-file` or `ADM_LIFECYCLE_TOKEN_FILE` overrides the Kubernetes credential source. Passing it to `adm setup` also uses that credential when creating a missing Secret; setup rejects a mismatch with an existing Secret rather than rotating it. The service token grants full lifecycle API access; keep it on trusted management clients and out of workspace Pods. `/health` is public, so use `adm list` to verify authentication too.

If `adm list` reports `Connection refused`, run `adm setup` or inspect `kubectl -n adm-system get deployment,pods,service,pvc`. For Pods that are not ready, inspect `kubectl -n adm-system describe pod` and `kubectl -n adm-system logs deployment/adm-lifecycle`. A 401 response means the selected client credential does not match the running controller.

## Update or pin a version

Rerun the install command to get the latest successful `main` release. Each build has its own `sha-<commit>` release and matching workspace image; updating does not require a manual version tag. Markdown-only pushes skip the build. Optional `v*` tags publish pinned versions without changing the installer's default release.

`adm update` installs the selected CLI release, extends active runtime leases for a bounded controller maintenance window, waits for each active runtime to confirm that extension, then updates the owned controller and shared services to the release's pinned image. If a runtime cannot confirm the extension, the controller rollout does not start. After reconnecting to the updated controller and verifying its authenticated API, ADM clears that matching maintenance window so another update can begin immediately. If controller recovery or verification fails, the window remains bounded by its recorded expiry and the error reports its maintenance ID and expiry. Active workspace Pods and agent turns continue through this default update. The installer validates the download before activation, retains previous runtime directories, and preserves configuration. A controller update retains its credential and persistent state claim; a claim's StorageClass cannot be changed in place.

Workspace images change only when requested explicitly with `adm update --workspace NAME`. That operation updates the selected workspace Deployment, waits for its rollout, and verifies a ready Pod on the requested image has acquired its current lifecycle runtime lease before reporting success. It interrupts the selected agent. Workspace ID, repository files, and history remain on the existing workspace volume. Repeat the same `--operation-id` to resume a selected workspace update whose durable operation failed; the operation ID can only be used with exactly one selected workspace. Other workspaces keep their current images and running agents.

Closing terminal attachments detaches; it does not delete workspaces. Use `adm destroy NAME` to delete a workspace and stop its owned work.

To select a release or skip guided setup:

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh -o /tmp/adm-install.sh
sh /tmp/adm-install.sh --version v0.1.0 --no-setup
```

`v0.1.0` is an example: choose an existing version or `sha-<commit>` tag from [Releases](https://github.com/NWylynko/agentic-dev-machines/releases). `--base-url URL` selects an explicit alternative release asset directory. There is no source-build or provider fallback when a download or prerequisite fails.

The installer refuses to overwrite an existing unmanaged `adm` or `adm-repositories` command. This early-alpha design does not migrate host-runner state or configuration. Retire an older installation separately before using the in-cluster lifecycle design.

## zsh completions

Generate the completion file with the installed `adm` and add its directory to zsh's function path:

```sh
mkdir -p ~/.zfunc
adm completions zsh > ~/.zfunc/_adm
```

Add these lines to `~/.zshrc` (or merge them with an existing completion setup), then open a new shell or run `source ~/.zshrc`:

```zsh
fpath=(~/.zfunc $fpath)
autoload -Uz compinit
compinit
```

After upgrading `adm`, regenerate `~/.zfunc/_adm` with `adm completions zsh > ~/.zfunc/_adm` to pick up new commands and options. The command prints the script to standard output and does not edit shell configuration.

## Developing from source

Contributors still use the checkout with Node.js 24+, Rust, and Go as pinned in `packages/repositories/go.mod`:

```sh
npm ci
cargo run -- setup
cargo run -- doctor
cargo run -- create my-project
```

`--project-dir` / `ADM_PROJECT_DIR` explicitly select a development checkout. Installed binaries normally discover the matching runtime beside their executable. The release bundle carries its matching published workspace image reference; source development defaults to the published `latest` image. Pass `--image adm-dev:0.1.0` for a locally built image.
