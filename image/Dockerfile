# Development workspace image referenced by adm manifests as adm-dev:0.1.0.
# Provider refresh credentials live in the lifecycle persistent volume; the image contains no keys.
#
# One image serves every ADM container, so a release pins a single image:
#   - workspace Pod, `workspace` container: tini -> adm-dev-entrypoint -> runner.mjs (the agent)
#   - workspace Pod, `repositories` sidecar: adm-repositories + artifact-fs (FUSE repo catalog)
#   - adm-lifecycle Deployment: `adm lifecycle-serve` (needs kubectl) and provider-auth.mjs
# `adm-dev-entrypoint --check` asserts the files below exist; keep the two in sync.
#
# Build from the repo root: docker build -f image/Dockerfile .

# Repository catalog sidecar and the artifact-fs FUSE filesystem it mounts.
# Static (CGO off) so the binaries run on the Node-based final image unchanged.
FROM golang:1.26.5-bookworm AS go-build
WORKDIR /src/repositories
COPY packages/repositories/go.mod packages/repositories/go.sum ./
# Module download is its own layer so source edits don't refetch dependencies.
RUN go mod download
COPY packages/repositories/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/adm-repositories .
# ARTIFACTFS pins the artifact-fs version; the test host installs the same pin (docs/operations.md).
COPY packages/repositories/ARTIFACTFS /tmp/ARTIFACTFS
RUN go install "github.com/cloudflare/artifact-fs/cmd/artifact-fs@$(tr -d '\n' < /tmp/ARTIFACTFS)"

# Runner, provider-auth and workspace-env bundles plus their production node_modules.
FROM node:24.18.0-bookworm AS js-build
WORKDIR /src
COPY package.json package-lock.json ./
# Every workspace manifest is needed for `npm ci` to accept the lockfile.
COPY packages/runner/package.json packages/runner/package.json
COPY packages/terminal/package.json packages/terminal/package.json
COPY scripts/patch-pi-interactive.mjs scripts/patch-pi-interactive.mjs
RUN npm ci --ignore-scripts
# Patch pi-coding-agent's InteractiveMode in node_modules; the script refuses any version but the one it targets.
RUN node scripts/patch-pi-interactive.mjs
COPY packages/runner packages/runner
# runner and provider-auth keep packages external and load them from /opt/adm/node_modules (NODE_PATH).
# workspace-env is fully bundled: the runner `kubectl exec`s it as a bare `node` script.
# Prune afterwards so only runtime dependencies are copied into the final image.
RUN npx esbuild packages/runner/src/main.ts --bundle --platform=node --format=esm --packages=external --outfile=/out/runner.mjs \
 && npx esbuild packages/runner/src/provider-auth-main.ts --bundle --platform=node --format=esm --packages=external --outfile=/out/provider-auth.mjs \
 && npx esbuild packages/runner/src/remote-env-server.ts --bundle --platform=node --format=esm --outfile=/out/workspace-env.mjs \
 && npm prune --omit=dev --ignore-scripts

# The adm CLI, run in-cluster as the lifecycle controller.
FROM rust:1.89-bookworm AS adm-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# src/update.rs embeds install.sh with include_str!, so the build fails without it.
COPY install.sh ./install.sh
RUN cargo build --release --bin adm

# kubectl for the lifecycle controller (leases, Pod access) and the runner's `kubectl exec`.
# Downloaded in its own stage and checksum-verified so curl stays out of the final image.
FROM debian:bookworm-slim AS kubectl-build
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.34.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    curl -fsSLo /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256"; \
    echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum --check; \
    chmod 0755 /usr/local/bin/kubectl

# Final runtime image. Node base because the runner, provider-auth and agent tooling are Node.
FROM node:24.18.0-bookworm
# Pinned commit, not a branch, so rebuilds produce the same shell.
ARG OH_MY_ZSH_REVISION=4d4cfc287e9d887b81242c0e431b5f49f9cec5c1
COPY LICENSE /usr/share/licenses/adm/LICENSE
# tini: PID 1 that forwards signals and reaps zombies. fuse3: artifact-fs mounts.
# chromium: headless browser for browser.mjs. gh comes from GitHub's apt repo (not in Debian).
# The workspace user is UID 1000 (node in this base image) and gets passwordless sudo,
# so agents can install their own tools inside their own Pod.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates git tini fuse3 chromium nano sudo wget zsh \
 && install -d -m 0755 /etc/apt/keyrings \
 && wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && printf '#1000 ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/adm \
 && chmod 0440 /etc/sudoers.d/adm \
 && rm -rf /var/lib/apt/lists/*
# git asks this helper for github.com credentials; it answers from the workspace's GH_TOKEN Secret.
# Set in system config so it applies to every user and repo without touching the workspace volume.
COPY image/adm-git-credential /usr/local/bin/adm-git-credential
RUN chmod 0755 /usr/local/bin/adm-git-credential \
 && git config --system --add credential.https://github.com.helper '!/usr/local/bin/adm-git-credential'
# Fetch only the pinned commit. Shell state (history, custom, cache) lives on /workspace; see image/zshrc.
RUN git init /opt/adm/oh-my-zsh \
 && git -C /opt/adm/oh-my-zsh remote add origin https://github.com/ohmyzsh/ohmyzsh.git \
 && git -C /opt/adm/oh-my-zsh fetch --depth=1 origin "$OH_MY_ZSH_REVISION" \
 && git -C /opt/adm/oh-my-zsh checkout --detach FETCH_HEAD
# Template only: adm-init-workspace copies it to /workspace/.adm/zsh/.zshrc on first start.
COPY image/zshrc /usr/local/share/adm/zshrc
COPY --from=go-build /out/adm-repositories /usr/local/bin/adm-repositories
COPY --from=go-build /go/bin/artifact-fs /usr/local/bin/artifact-fs
COPY --from=js-build /out/runner.mjs /opt/adm/runner.mjs
COPY --from=js-build /out/provider-auth.mjs /opt/adm/provider-auth.mjs
COPY --from=js-build /src/node_modules /opt/adm/node_modules
# Git wrapper the privileged repositories sidecar runs: drops capabilities so repo-configured
# helpers can't inherit its mount authority. Must stay root-owned in the image (see the file).
COPY packages/repositories/git /usr/local/lib/adm-repositories/git
COPY image/adm-dev-entrypoint /usr/local/bin/adm-dev-entrypoint
COPY image/adm-init-workspace /usr/local/bin/adm-init-workspace
COPY image/browser.mjs /opt/adm/browser.mjs
COPY --from=js-build /out/workspace-env.mjs /opt/adm/workspace-env.mjs
COPY --from=adm-build /src/target/release/adm /usr/local/bin/adm
COPY --from=kubectl-build /usr/local/bin/kubectl /usr/local/bin/kubectl
# Root-own the executables so the UID 1000 workspace user can't replace code the
# privileged sidecar or the controller runs. /repos points at the sidecar's catalog
# mount on the workspace volume; it dangles until adm-init-workspace creates it.
RUN chown root:root \
      /usr/local/bin/adm-repositories \
      /usr/local/bin/adm \
      /usr/local/bin/kubectl \
      /usr/local/bin/artifact-fs \
      /usr/local/bin/adm-dev-entrypoint \
      /usr/local/bin/adm-init-workspace \
      /usr/local/lib/adm-repositories/git \
      /usr/local/share/adm/zshrc \
 && chmod 755 \
      /usr/local/bin/adm-repositories \
      /usr/local/bin/artifact-fs \
      /usr/local/bin/adm-dev-entrypoint \
      /usr/local/bin/adm-init-workspace \
      /usr/local/lib/adm-repositories/git \
      /usr/local/share/adm/zshrc \
 && ln -sfn /workspace/.adm/catalog /repos
# Lets the bundles (built with --packages=external) resolve their dependencies.
ENV NODE_PATH=/opt/adm/node_modules
WORKDIR /
# Kubernetes overrides `command` for the sidecar and controller containers; the workspace
# container keeps this entrypoint, which starts the runner when given no arguments.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/adm-dev-entrypoint"]
