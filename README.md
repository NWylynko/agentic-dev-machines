# Agentic Dev Machines

On-demand development workspaces for a homelab Kubernetes cluster, controlled through `adm` and opened in Herdr. Coding agents keep working after you disconnect. Removing a Herdr space destroys its workspace and stops its owned activity.

**Status:** local workflows are tested; real cluster deployment, cross-node recovery, and the node-failure loss window still need validation.

## Install

Run on your Debian Linux x86_64 management host with Node.js 24+ installed:

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh | sh
```

This downloads the release binaries, runner, terminal, and their dependencies. No clone, Rust, Go, or npm install is needed. Add `~/.local/bin` to your PATH. Rerun the same command to update; settings and workspace state are preserved.

Successful `main` builds publish a release automatically. See [installation details](docs/installation.md) for pinned versions, prerequisites, and updates.

## Setup

First install opens guided setup for the workspace image, storage class, default model, optional local Pi login, and background service. Run `adm setup` to change these later. Local Pi login does not copy credentials into coding workspaces.

Your Kubernetes access and [storage class](deploy/storage.md) must already be configured. Then:

```sh
adm doctor
adm start  # unnecessary if setup started the background service
adm create my-project
adm attach my-project
```

Choose a default model during setup, or pass `--model PROVIDER/MODEL_ID` when creating a workspace. `--no-agent` creates a shell-only workspace. Provider credentials are configured for each coding workspace through Pi login or an operator-managed credential source; they are not copied from the management host.

Work inside `/repos`. A plain workspace starts empty; clone there, or use `adm create my-project --repo OWNER/REPO` to prepare a checkout and start the shell and agent in it. See [repository navigation](docs/operations.md#find-your-repositories) for plain and lazy-catalog examples.

See [operations](docs/operations.md) for commands, Herdr integration, bots, and verification; [the implementation contract](docs/implementation-contract.md) for APIs; and [product requirements](docs/product-requirements.md) for the design and open decisions.

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses.
