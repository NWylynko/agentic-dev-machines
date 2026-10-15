# Agentic Dev Machines

On-demand development workspaces for a homelab Kubernetes cluster, controlled through `adm` and opened in Herdr. Coding agents keep working after you disconnect. Removing a Herdr space destroys its workspace and stops its owned activity.

**Status:** local workflows are tested; real cluster deployment, cross-node recovery, and the node-failure loss window still need validation.

## Install

Run on your Debian Linux x86_64 management host with Node.js 24+ installed:

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh | sh
```

This downloads the release binaries, runner, terminal, and their dependencies. No clone, Rust, Go, or npm install is needed. Add `~/.local/bin` to your PATH. Rerun the same command to update; settings and workspace state are preserved.

The download requires a published GitHub release containing the runtime bundle. See [installation details](docs/installation.md) for pinned versions, prerequisites, and updates.

## Setup

First install opens guided setup for the workspace image, storage class, default model, provider login, and optional background service. Run `adm setup` to change these later.

Your Kubernetes access and [storage class](deploy/storage.md) must already be configured. Then:

```sh
adm doctor
adm start  # unnecessary if setup started the background service
adm create my-project
adm attach my-project
```

Choose a default model during setup, or pass `--model PROVIDER/MODEL_ID` when creating a workspace. `--no-agent` creates a shell-only workspace. Provider credentials stay on the management host.

See [operations](docs/operations.md) for commands, Herdr integration, bots, and verification; [the implementation contract](docs/implementation-contract.md) for APIs; and [product requirements](docs/product-requirements.md) for the design and open decisions.

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses.
