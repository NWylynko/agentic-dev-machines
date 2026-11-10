# Custom coding images

A coding workspace runs the `adm-code` image. If a project needs toolchains that `adm-code` does not have (Rust, Go, a JDK, a database client), build an image on top of it and create the project's workspaces from that image. This repository does the same for itself: the `adm-dev` target in [`image/Dockerfile`](../image/Dockerfile) adds Rust, Go and kubectl.

## What `adm-code` already has

- Node from the image (`/usr/local/bin/node`, version in `ADM_NODE_VERSION`), plus fnm for any other version.
- Build tools: `build-essential`, `curl`, `python3`, `pkg-config`, `openssh-client`, `unzip`, `xz-utils`, `bzip2`, `file`, `patch`, `gnupg`.
- `git`, `gh` (signed in through the cluster's GitHub login), Chromium, `tmux`, `nano`, zsh and passwordless `sudo`.
- Claude Code and the Docker CLI with compose and buildx, which talk to the workspace's own Docker engine.

Don't add something just because it is missing from your laptop. Check the image first:

```sh
docker run --rm --user 1000:1000 --entrypoint sh ghcr.io/nwylynko/agentic-dev-machines/adm-code:latest -c 'command -v cargo go java'
```

## Rules

### Build on the release your cluster runs

- Start `FROM ghcr.io/nwylynko/agentic-dev-machines/adm-code:latest`. `latest` is the newest release, which is what `adm update` installs.
- Only if your cluster is deliberately held on an older release, build from that release's tag instead (`adm-code:sha-<commit>`). The installed client records its release: `cat "$(dirname "$(dirname "$(readlink -f "$(command -v adm)")")")/VERSION"` prints e.g. `sha-1b6ed3a97cc5`.
- Rebuild on every `adm update`, with `docker build --pull` so Docker fetches the new `latest` rather than reusing its cached copy. Your image includes the agent runtime, Claude Code and the Docker CLI from the release you built on. Workspaces created from an old build keep running that old runtime.
- Push the image to a registry that every cluster node can pull from. ttl.sh images expire (24 h at most). A private GHCR package pulls with the cluster GitHub login: run `adm repos login github` with an account that can read the package (logins from before the `read:packages` scope was added need logging in again), then create the workspace. Other private registries are not supported.

### Only `/workspace` survives

- The workspace volume is mounted at `/workspace`. Everything else, including `/home/node`, `/usr` and `/opt`, comes from the image and resets when the Pod restarts or moves to another node. Anything an agent installs at runtime with `sudo apt`, `rustup` or `pip install --user` is gone after a restart.
- So put toolchains in the image.
- Put download and build caches on the volume with `ENV`, under `/workspace/.adm/`. Put their `bin` directories on `PATH` too, so tools installed with `cargo install` or `go install` persist:

  ```dockerfile
  ENV CARGO_HOME=/workspace/.adm/cargo \
      GOPATH=/workspace/.adm/go \
      PIP_CACHE_DIR=/workspace/.adm/pip-cache \
      PATH=/workspace/.adm/cargo/bin:/workspace/.adm/go/bin:$PATH
  ```

### Leave the base alone

The workspace runtime depends on these. Don't replace, move or reconfigure them:

- the entrypoint (`tini` → `/usr/local/bin/adm-dev-entrypoint`); don't set `ENTRYPOINT` or `CMD`
- user `node` (UID/GID 1000) and its home `/home/node`
- `/usr/local/bin/node`, `NODE_PATH` and everything under `/opt/adm`
- `/usr/local/share/adm/` (zsh setup), `/usr/local/bin/gh` (a wrapper ahead of `/usr/bin/gh`), the `adm-*` helpers in `/usr/local/bin`, and the system git config

**Don't change the image's Node.** A project gets its own Node version from `.node-version` or `.nvmrc`. Interactive shells switch to it when you `cd` into the repository, after you run `fnm install` once; fnm keeps installed versions on the workspace volume. Don't install another Node from apt or NodeSource on top.

**Install as root, check as UID 1000.** The Dockerfile runs as root, but the Pod runs as UID 1000 with most capabilities dropped. A tool installed under `/root`, or with files only root can read, works in `docker build` but fails in the workspace. Run every check as `--user 1000:1000`.

### Installing tools

- Copy toolchains from official images with versions pinned, e.g. `COPY --from=golang:1.26.5-bookworm /usr/local/go /usr/local/go`. You get a signed upstream build with no download script to maintain.
- For direct downloads, pin the version and check a sha256 in the Dockerfile. [`image/Dockerfile`](../image/Dockerfile) does this for fnm and kubectl.
- Keep it lean: run `rm -rf /var/lib/apt/lists/*` after apt, and leave package caches and docs out. Each node pulls the image the first time a workspace lands there, so a large image means a slow start.
- Toolchain test data can fail the credential scan. Go's standard library tests contain sample private keys. Remove them (see the `go-toolchain` stage) rather than adding a scanner exception.

## Example

The `adm-dev` image for this repository, written as a standalone Dockerfile:

```dockerfile
ARG ADM_RELEASE=latest

# Go without its own tests; their private-key fixtures fail the credential scan.
FROM golang:1.26.5-bookworm AS go-toolchain
RUN find /usr/local/go/src \( -name testdata -type d -o -name '*_test.go' \) -prune -exec rm -r {} + \
 && rm /usr/local/go/src/crypto/x509/platform_root_key.pem

FROM ghcr.io/nwylynko/agentic-dev-machines/adm-code:${ADM_RELEASE}
COPY --from=rust:1-bookworm /usr/local/rustup /usr/local/rustup
COPY --from=rust:1-bookworm /usr/local/cargo/bin /usr/local/cargo/bin
COPY --from=go-toolchain /usr/local/go /usr/local/go
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/workspace/.adm/cargo \
    GOPATH=/workspace/.adm/go \
    PATH=/workspace/.adm/cargo/bin:/workspace/.adm/go/bin:/usr/local/cargo/bin:/usr/local/go/bin:$PATH
RUN rustup component add clippy rustfmt && cargo --version && go version
```

`RUSTUP_HOME` stays in the image. The toolchain is part of the image, and the `rustup component add` at build time is what puts clippy and rustfmt there.

## Testing

A `--version` check proves little. Test the image the way a workspace uses it.

1. **Run the project's real CI on a volume, as UID 1000.** This mirrors a workspace: an initialized volume at `/workspace` and the project checked out on it.

   ```sh
   IMAGE=my-project-dev:test
   docker volume create dev-test
   docker run --rm --mount type=volume,src=dev-test,dst=/workspace --entrypoint /usr/local/bin/adm-init-workspace "$IMAGE" plain
   git archive HEAD | docker run --rm -i --user 1000:1000 --mount type=volume,src=dev-test,dst=/workspace \
     --entrypoint sh "$IMAGE" -ec 'mkdir /workspace/project && tar -x -C /workspace/project'
   docker run --rm --user 1000:1000 --mount type=volume,src=dev-test,dst=/workspace --entrypoint zsh "$IMAGE" \
     -ec 'cd /workspace/project && <install> && <lint> && <test>'
   docker volume rm dev-test
   ```

   Use a volume, not `--tmpfs`. Docker mounts tmpfs `noexec`, so binaries installed there (fnm's Node versions, for one) fail with confusing errors.

2. **Check you didn't break the base.** From an ADM checkout (`npm ci` first), run the `adm-code` smoke test against your image. It covers the runner's startup checks, Claude Code under tmux, the browser, fnm, the Docker CLI and sudo:

   ```sh
   npm run test:image -- "$IMAGE" adm-code
   ```

3. **Scan for credentials,** as CI does for every ADM image:

   ```sh
   root=$(mktemp -d); id=$(docker create "$IMAGE")
   docker export "$id" | tar -x -C "$root"; docker rm "$id"
   node image/scan-secrets.mjs "$root"
   ```

## Use it

```sh
adm create my-project --repo OWNER/REPO --role coding --image registry.example.com/my-project-dev:sha-<commit>
```

`--image` replaces only the agent container. The init and repositories containers still come from the release. The Pod also gets `DOCKER_HOST`, `TESTCONTAINERS_HOST_OVERRIDE=docker` and `TZ` from the lifecycle, so don't set them in the image.

Moving a workspace to a new build of your image:

- Don't run `adm update --workspace NAME` on it. That command always applies the release's stock `adm-code` image, which drops your toolchains. Agent history and the volume are kept, but the next restart has no Rust, Go, etc.
- No command moves an existing workspace to a different custom image. Push the work, `adm destroy NAME` (this deletes the workspace's volume), then `adm create` it again with the new `--image`.

## Limits

- No FUSE and no privileged containers in the workspace Pod. Tests that mount filesystems have to skip.
- Containers run through the workspace's Docker engine Pod (`DOCKER_HOST`), which runs rootless. `docker run --privileged` fails, and `--memory`/`--cpus` are not enforced. Published ports are at `docker:PORT`.
- `kubectl` in the image has no cluster credentials. The Pod's service account token only works with the ADM lifecycle.
