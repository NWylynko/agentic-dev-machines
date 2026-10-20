# Agentic Dev Machines

On-demand development workspaces for a homelab Kubernetes cluster, controlled through `adm` and opened in Herdr. Coding agents keep working after you disconnect. With the optional close-event watcher enabled, removing a bound Herdr space destroys its workspace and stops its owned activity.

**Status:** [portable Linux client checks](docs/client-validation-2026-10-18.md) verified shared workspace identity and files, disconnected agent execution and deletion, and completed history after reconnection. Native installer selection is covered by fixtures. Native macOS/arm64 runs, cross-node recovery, the node-failure loss window, live Herdr delivery, and shared-provider sessions still need validation.

## Install

Run on a macOS or Linux client with Node.js 24+ installed. Supported clients are macOS x86_64/arm64 and Linux amd64/arm64:

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh | sh
```

This downloads the release CLI, workspace runtime, terminal, and their dependencies. No clone, Rust, Go, or npm install is needed. Add `~/.local/bin` to your PATH. Use `adm update` to update the CLI and owned cluster services; settings are preserved and existing workspace images stay running. Select `adm update --workspace NAME` explicitly to update a workspace image and interrupt its agent.

Successful `main` builds publish a release automatically. See [installation details](docs/installation.md) for pinned versions, prerequisites, and updates.

## Setup

Your Kubernetes access and a cluster [StorageClass](deploy/storage.md) must already be configured. First interactive installation opens `adm setup`; otherwise run it yourself:

```sh
adm setup
adm list
adm doctor
adm create my-project
```

On another client that only needs access to an already-installed cluster, run `adm connect`; it verifies access and saves that device's kubeconfig selection without installing cluster resources.

Setup asks for the image, storage class, and optional default model, then offers to install or update the cluster controller. Client commands use the selected kubeconfig to open a temporary authenticated port-forward and close it when the command exits. No system service or permanent management host is required. See [installation details](docs/installation.md#in-cluster-lifecycle-owner) for prerequisites and advanced manual installation.

Every workspace starts with its durable agent. Choose a default model during setup or pass `--model PROVIDER/MODEL_ID` when creating a workspace; otherwise select one in `adm attach` with `/model`. Authenticate a provider once for the installation with `adm login [PROVIDER]`; use `adm logout PROVIDER` to revoke that shared login. Refresh credentials stay on the lifecycle persistent volume and are never copied into workspace Pods.

Work inside `/repos`. A plain workspace starts empty; clone there, or use `adm create my-project --repo OWNER/REPO` to prepare a checkout and start the shell and agent in it. Add `--branch feature/work` to check out a remote branch or create a local one from the remote default; `--base origin/release` selects another starting ref for a new branch. See [repository navigation](docs/operations.md#find-your-repositories) for plain and lazy-catalog examples.

In an interactive terminal, `adm create` attaches to the new workspace's durable agent when it is ready. Noninteractive use returns workspace JSON; pass `--no-attach` to force creation-only behavior. Use `adm create my-project --herdr` inside a Herdr session to create and bind a new Herdr space, then start one attach in its initial pane. This option works in scripts too and reports the current close-event delivery health without starting a watcher.

See [operations](docs/operations.md) for commands, Herdr integration, bots, and verification; [the implementation contract](docs/implementation-contract.md) for APIs; and [product requirements](docs/product-requirements.md) for the design and open decisions.

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses.
