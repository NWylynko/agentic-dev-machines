# Installation and updates

ADM installs on the Debian Linux x86_64 management host. Client laptops connect through Herdr/SSH; the installer runs on the management host.

The host needs Node.js 24+, `curl`, GNU `tar`, `sha256sum`, and `flock`. Running coding workspaces also needs `kubectl` configured for your cluster, Git, and a suitable [StorageClass](../deploy/storage.md). Repository discovery needs authenticated `gh`. The installer does not install system packages or change cluster resources.

## Install and configure

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh | sh
```

The script downloads `adm-linux-amd64.tar.gz` and verifies its checksum from the release's `SHA256SUMS`. Successful `main` builds automatically publish a release containing the CLI, repository helper, compiled runner and terminal, and pinned production Node dependencies. No checkout or build toolchain is needed.

The commands are installed in `$HOME/.local/bin`. Add that directory to your PATH if needed. The installation lives under `$XDG_DATA_HOME/adm/install`, or `$HOME/.local/share/adm/install` when XDG_DATA_HOME is unset. Versioned runtime files are separate from workspace and lifecycle-service state.

First installation offers `adm setup` through the terminal. Setup configures the workspace image, storage class, and optional default model. Provider login is performed inside a selected workspace and is kept on its private volume. With no terminal, installation prints the command to run later.

Settings are nonsecret JSON at `$XDG_CONFIG_HOME/adm/config.json`, normally `$HOME/.config/adm/config.json`. Explicit CLI flags override these defaults. Workspaces always create their durable agent; a model can be selected later in `adm attach` with `/model`. Setup never changes your Kubernetes context or installs a storage backend. It saves an explicit image reference, so updates preserve your image choice too.

Configure each workspace's credentials with `adm login NAME` or references to keys in a Secret in that workspace's namespace. For API keys, pass references such as `--credential-env OPENAI_API_KEY=provider-auth:openai`; ADM stores only the environment name and Secret/key reference and maps the value into that workspace's container. No particular secret manager is required. Do not put values in ADM config, service files, or project `.env` files.

## In-cluster lifecycle owner

The CLI uses the in-cluster lifecycle API for workspace creation, deletion, and directory reads. Install the control plane after configuring the `adm-replicated` StorageClass and publishing an ADM image containing the matching `adm` and `kubectl` binaries. The [lifecycle API guide](lifecycle-api.md) describes the API and authentication boundary.

Create the namespace, then create a protected client token file and put the same token in the Kubernetes Secret. Generate and transfer the token through your secret manager; keep it out of shell history, manifests, and repository files. The Secret must be named `adm-lifecycle-token` in `adm-system`, with key `token`. Apply `deploy/lifecycle/control-plane.yaml` after the Secret exists. It creates the service account and RBAC, persistent state claim, single-owner Deployment, and private ClusterIP Service.

The management host reaches that private Service through a supervised local port-forward:

```sh
kubectl create namespace adm-system --dry-run=client -o yaml | kubectl apply -f -
kubectl -n adm-system create secret generic adm-lifecycle-token --from-file=token=/secure/path/lifecycle-token
kubectl apply -f deploy/lifecycle/control-plane.yaml
kubectl -n adm-system port-forward service/adm-lifecycle 7433:7433
```

Point `ADM_LIFECYCLE_URL` to `http://127.0.0.1:7433` and `ADM_LIFECYCLE_TOKEN_FILE` to the protected client token file. Supervise the port-forward separately from the CLI. The service token grants full lifecycle API access; keep it on trusted management clients and do not mount it into workspace Pods. Fake-Kubernetes coverage checks the manifest and API. A separate live API-permission check verifies the lifecycle role's target-bound TokenRequest, TokenReview, Pod exec, and namespace retry permissions using an older cached base image; see [the operations guide](operations.md#verification). The full control-plane install and the new runtime image have not been validated end to end on the cluster.

```sh
adm doctor
adm create my-project
adm attach my-project
```

## Update or pin a version

Rerun the install command to get the latest successful `main` release. Each build has its own `sha-<commit>` release and matching workspace image; updating does not require a manual version tag. Markdown-only pushes skip the build. Optional `v*` tags publish pinned versions without changing the installer's default release.

Updates validate the download before changing the active installation, retain previous runtime directories, and preserve configuration. Workspace Pods continue running independently of an installer update. Existing workspaces retain their image and storage settings.

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
cargo run -- doctor
cargo run -- create my-project
```

`--project-dir` / `ADM_PROJECT_DIR` explicitly select a development checkout. Installed binaries normally discover the matching runtime beside their executable. The release bundle carries its matching published workspace image reference; source development defaults to the published `latest` image. Pass `--image adm-dev:0.1.0` for a locally built image.
