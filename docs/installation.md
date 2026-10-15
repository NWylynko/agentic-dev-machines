# Installation and updates

ADM installs on the Debian Linux x86_64 management host. MacBooks connect through Herdr/SSH; the installer does not install a macOS runtime.

The host needs Node.js 24+, `curl`, GNU `tar`, `sha256sum`, and `flock`. Running coding workspaces also needs `kubectl` configured for your cluster, Git, and a suitable [StorageClass](../deploy/storage.md). Repository discovery needs authenticated `gh`. The installer does not install system packages or change cluster resources.

## Install and configure

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh | sh
```

The script downloads `adm-linux-amd64.tar.gz` and verifies its checksum from the release's `SHA256SUMS`. It includes the CLI, repository helper, compiled runner and terminal, and pinned production Node dependencies. No checkout or build toolchain is needed.

The commands are installed in `$HOME/.local/bin`. Add that directory to your PATH if needed. The installation lives under `$XDG_DATA_HOME/adm/install`, or `$HOME/.local/share/adm/install` when XDG_DATA_HOME is unset. Versioned runtime files are separate from workspace and runner state.

First installation offers `adm setup` through the terminal. Setup configures the image, storage class, and optional default model, offers the installed Pi `/login` interface, and can create/start a systemd user service. With no terminal, installation prints the command to run later. `adm login` reopens provider authentication.

Settings are nonsecret JSON at `$XDG_CONFIG_HOME/adm/config.json`, normally `$HOME/.config/adm/config.json`. Explicit CLI flags override these defaults. Leaving the model unset means agent creation still requires `--model PROVIDER/MODEL_ID`; `--no-agent` disables the agent. Setup never changes your Kubernetes context or installs a storage backend. It saves an explicit image reference, so updates preserve your image choice too.

Provider authentication stays in Pi's management-host auth store. API keys must be injected into the runner process from Infisical; do not put them in ADM config, a service file, or a project `.env`. The generated service does not inherit keys from your login shell. Persistent user services after logout require operator-configured systemd lingering; setup reports this requirement.

```sh
adm doctor
adm start  # when not using the background service
adm create my-project
adm attach my-project
```

## Update or pin a version

Rerun the install command to get the latest release. Updates validate the download before changing the active installation, retain previous runtime directories, and preserve configuration, workspace metadata, conversations, and provider login. An active `adm-runner.service` restarts after the switch. Its restart failure is reported; inspect `systemctl --user status adm-runner.service` before continuing. Existing workspaces retain their image and storage settings.

For a runner started with `adm start`, stop it before updating and start it afterward. Closing terminal attachments detaches; it does not delete workspaces. Use the same `--state-dir` and `--runner-url` for custom runners. The installer recognizes the default state directory or `ADM_STATE_DIR`; custom runner locations remain operator-managed.

```sh
adm stop
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh | sh
adm start
```

To select a release or skip guided setup:

```sh
curl -fsSL https://raw.githubusercontent.com/NWylynko/agentic-dev-machines/main/install.sh -o /tmp/adm-install.sh
sh /tmp/adm-install.sh --version v0.1.0 --no-setup
```

`v0.1.0` is an example: choose a published release that contains the runtime bundle. No such release was published when this installer was introduced. `--base-url URL` selects an explicit alternative release asset directory. There is no source-build or provider fallback when a download or prerequisite fails.

The installer refuses to overwrite an existing unmanaged `adm` or `adm-repositories` command. For an older manual installation, stop its runner, move those executables aside, install, then run `adm setup` to replace any checkout-based service. Keep the existing state directory. This migrates the runtime without moving your workspaces.

## Developing from source

Contributors still use the checkout with Node.js 24+, Rust, and Go as pinned in `packages/repositories/go.mod`:

```sh
npm ci
cargo run -- doctor
cargo run -- start
```

`--project-dir` / `ADM_PROJECT_DIR` explicitly select a development checkout. Installed binaries normally discover the matching runtime beside their executable. The release bundle carries its matching published workspace image reference; source development defaults to the published `latest` image. Pass `--image adm-dev:0.1.0` for a locally built image.
