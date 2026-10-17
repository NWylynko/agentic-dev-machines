# Installation and updates

ADM installs on the Debian Linux x86_64 management host. Client laptops connect through Herdr/SSH; the installer runs on the management host.

The host needs Node.js 24+, `curl`, GNU `tar`, `sha256sum`, and `flock`. Guided setup also needs `kubectl` configured with permission to install the controller's namespace and RBAC, a replicated [StorageClass](../deploy/storage.md), and a running systemd user manager with `systemctl` and `systemd-notify` available. The installer does not install system packages or a storage backend. Repository discovery needs Git and authenticated `gh`.

## Install and configure

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh | sh
```

The script downloads `adm-linux-amd64.tar.gz` and verifies its checksum from the release's `SHA256SUMS`. Successful `main` builds automatically publish a release containing the CLI, repository helper, compiled runner and terminal, and pinned production Node dependencies. No checkout or build toolchain is needed.

The commands are installed in `$HOME/.local/bin`. Add that directory to your PATH if needed. The installation lives under `$XDG_DATA_HOME/adm/install`, or `$HOME/.local/share/adm/install` when XDG_DATA_HOME is unset. Versioned runtime files are separate from workspace and lifecycle-service state.

First interactive installation opens `adm setup`. With no terminal, or with `--no-setup`, installation prints the command to run later. Setup asks for the workspace image, storage class, and optional default model, then offers to install or update the cluster controller and enable its connection; the default answer is yes.

Settings are nonsecret JSON at `$XDG_CONFIG_HOME/adm/config.json`, normally `$HOME/.config/adm/config.json`. They include image/storage/model defaults and, after successful controller setup, the lifecycle URL, namespace, kubectl command, and selected kubeconfig paths. Explicit flags and environment settings override the corresponding connection defaults. When installing the controller, setup saves settings only after rollout and an authenticated API check succeed. It keeps your selected Kubernetes context and saves an explicit image reference, so updates preserve your image choice.

```sh
adm setup
adm list
```

Provider login is performed inside a selected workspace and is kept on its private volume. Workspaces always create their durable agent; a model can be selected later in `adm attach` with `/model`.

Configure each workspace's credentials with `adm login NAME` or references to keys in a Secret in that workspace's namespace. For API keys, pass references such as `--credential-env OPENAI_API_KEY=provider-auth:openai`; ADM stores only the environment name and Secret/key reference and maps the value into that workspace's container. No particular secret manager is required. Do not put values in ADM config, service files, or project `.env` files.

## In-cluster lifecycle owner

The CLI uses the in-cluster lifecycle API for workspace creation, deletion, and directory reads. `adm setup` applies its namespace, service account and RBAC, persistent state claim, single-owner Deployment, and private ClusterIP Service. It uses the selected image for both controller containers and the selected StorageClass for its state claim, then waits for rollout. The cluster must be able to obtain that image. Setup rejects the node-local `local-path` provisioner for controller state.

Setup generates the internal lifecycle credential only when the `adm-system/adm-lifecycle-token` Secret is missing, and reuses an existing Secret. The CLI reads that credential into memory through the selected host kubeconfig. The default flow creates no local token file and stores no token value in ADM config or a service unit. This credential is separate from provider credentials; workspace Pods receive their own projected identities.

Setup installs and enables `adm-lifecycle-forward.service` in your systemd user manager. Its `Type=notify` startup completes when the loopback port-forward is ready; setup then checks the authenticated lifecycle API before saving connection settings. Check or restart the connection with:

```sh
systemctl --user status adm-lifecycle-forward.service
journalctl --user -u adm-lifecycle-forward.service
systemctl --user restart adm-lifecycle-forward.service
```

Keeping this connection available after logout requires operator-configured user lingering. Agents run inside their workspace Pods and continue independently of the management-host connection.

Automatic setup uses namespace `adm-system` and a loopback URL, normally `http://127.0.0.1:7433`. Select another local port with `adm --lifecycle-url http://127.0.0.1:PORT setup`. A custom namespace or a separately managed connection uses the advanced manual installation below. Declining controller installation changes workspace defaults without installing cluster resources or a connection service. The [lifecycle API guide](lifecycle-api.md) describes the API and authentication boundary.

Process tests cover automatic installation, credential reuse, connection verification, and visible rollout failures against Kubernetes/systemd fixtures. This is not a claim of a completed live control-plane installation or full runtime-image validation; see [current validation](validation-2026-10-17.md).

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

If `adm list` reports `Connection refused`, run `adm setup` or inspect the connection service above and `kubectl -n adm-system get deployment,pods,service,pvc`. For Pods that are not ready, inspect `kubectl -n adm-system describe pod` and `kubectl -n adm-system logs deployment/adm-lifecycle`. A 401 response means the selected client credential does not match the running controller.

## Update or pin a version

Rerun the install command to get the latest successful `main` release. Each build has its own `sha-<commit>` release and matching workspace image; updating does not require a manual version tag. Markdown-only pushes skip the build. Optional `v*` tags publish pinned versions without changing the installer's default release.

Updates validate the download before changing the active installation, retain previous runtime directories, and preserve configuration. The installer itself does not restart services or change cluster resources on updates. Run `adm setup` afterward and select the desired image to update the controller and its supervised connection; the existing credential and persistent state claim are retained. A claim's StorageClass cannot be changed in place. Existing workspaces retain their image and storage settings and continue independently of the installer.

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
