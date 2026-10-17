# Agentic Dev Machines

On-demand development workspaces for a homelab Kubernetes cluster, controlled through `adm` and opened in Herdr. Coding agents keep working after you disconnect. Removing a Herdr space destroys its workspace and stops its owned activity.

**Status:** workspace runtime and lifecycle tests pass. The lifecycle Kubernetes permission boundary has been checked live; full workspace-image startup, cross-node recovery, the node-failure loss window, and live provider sessions still need validation.

## Install

Run on your Debian Linux x86_64 management host with Node.js 24+ installed:

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh | sh
```

This downloads the release CLI, workspace runtime, terminal, and their dependencies. No clone, Rust, Go, or npm install is needed. Add `~/.local/bin` to your PATH. Rerun the same command to update; settings are preserved.

Successful `main` builds publish a release automatically. See [installation details](docs/installation.md) for pinned versions, prerequisites, and updates.

## Setup

Your Kubernetes access, replicated [StorageClass](deploy/storage.md), and systemd user session must already be configured. First interactive installation opens `adm setup`; otherwise run it yourself:

```sh
adm setup
adm list
adm doctor
adm create my-project
adm attach my-project
```

Setup asks for the image, storage class, and optional default model, then installs the cluster controller and enables its supervised management-host connection by default. It creates an internal credential in Kubernetes when needed and reuses it on later runs. No local token file or manual port-forward is needed for this setup. See [installation details](docs/installation.md#in-cluster-lifecycle-owner) for prerequisites and advanced manual installation.

Every workspace starts with its durable agent. Choose a default model during setup or pass `--model PROVIDER/MODEL_ID` when creating a workspace; otherwise select one in `adm attach` with `/model`. Provider credentials belong to each workspace and are not copied from the management host.

Work inside `/repos`. A plain workspace starts empty; clone there, or use `adm create my-project --repo OWNER/REPO` to prepare a checkout and start the shell and agent in it. See [repository navigation](docs/operations.md#find-your-repositories) for plain and lazy-catalog examples.

See [operations](docs/operations.md) for commands, Herdr integration, bots, and verification; [the implementation contract](docs/implementation-contract.md) for APIs; and [product requirements](docs/product-requirements.md) for the design and open decisions.

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses.
