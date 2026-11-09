# Build all ADM runtime roles from shared, pinned build stages.
# Build from the repository root: docker build -f image/Dockerfile --target adm-code .

# ADM's own Node: the build, the control plane, and the workspaces' runner and helpers.
ARG NODE_VERSION=24.18.0

FROM golang:1.26.5-bookworm AS go-build
WORKDIR /src/repositories
COPY packages/repositories/go.mod packages/repositories/go.sum ./
RUN go mod download
COPY packages/repositories/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/adm-repositories .
COPY packages/repositories/ARTIFACTFS /tmp/ARTIFACTFS
RUN go install "github.com/cloudflare/artifact-fs/cmd/artifact-fs@$(tr -d '\n' < /tmp/ARTIFACTFS)"

FROM node:${NODE_VERSION}-bookworm AS js-build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/runner/package.json packages/runner/package.json
COPY packages/terminal/package.json packages/terminal/package.json
COPY scripts/patch-pi-interactive.mjs scripts/patch-pi-interactive.mjs
RUN npm ci --ignore-scripts && node scripts/patch-pi-interactive.mjs
COPY packages/runner packages/runner
RUN npx esbuild packages/runner/src/main.ts --bundle --platform=node --format=esm --packages=external --outfile=/out/runner.mjs \
 && npx esbuild packages/runner/src/provider-auth-main.ts --bundle --platform=node --format=esm --packages=external --outfile=/out/provider-auth.mjs \
 && npx esbuild packages/runner/src/remote-env-server.ts --bundle --platform=node --format=esm --outfile=/out/workspace-env.mjs \
 && npm prune --omit=dev --ignore-scripts

FROM rust:1.89-bookworm AS adm-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY install.sh ./install.sh
RUN cargo build --release --bin adm

FROM debian:bookworm-slim AS kubectl-build
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.34.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eux; arch="${TARGETARCH:-amd64}"; \
    curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    curl -fsSLo /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256"; \
    echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum --check; chmod 0755 /usr/local/bin/kubectl

FROM node:${NODE_VERSION}-bookworm AS node-dist

# fnm installs the Node versions a project asks for (.node-version, .nvmrc) onto the work volume.
FROM debian:bookworm-slim AS fnm-build
ARG TARGETARCH
ARG FNM_VERSION=1.39.0
ARG FNM_SHA256_AMD64=7807664f39d39fc518da1c35ba0181e4b3267603c4b1dedeb4b5fc6ae440a224
ARG FNM_SHA256_ARM64=4eaff58b2c5bf30d0934027572dd0b5bbb60d2a1af309230b53662d4b1d45599
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -eux; case "${TARGETARCH:-amd64}" in \
      amd64) asset=fnm-linux; sha="$FNM_SHA256_AMD64" ;; \
      arm64) asset=fnm-arm64; sha="$FNM_SHA256_ARM64" ;; \
      *) echo "no fnm build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/fnm.zip "https://github.com/Schniz/fnm/releases/download/v${FNM_VERSION}/${asset}.zip"; \
    echo "$sha  /tmp/fnm.zip" | sha256sum --check; \
    unzip /tmp/fnm.zip -d /usr/local/bin; chmod 0755 /usr/local/bin/fnm; /usr/local/bin/fnm --version

FROM debian:bookworm-slim AS adm-workspace
ARG NODE_VERSION
ARG OH_MY_ZSH_REVISION=4d4cfc287e9d887b81242c0e431b5f49f9cec5c1
COPY LICENSE /usr/share/licenses/adm/LICENSE
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates dtach git tini nano sudo wget zsh \
 && printf '#1000 ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/adm && chmod 0440 /etc/sudoers.d/adm \
 && groupadd --gid 1000 node && useradd --uid 1000 --gid 1000 --create-home --shell /usr/bin/zsh node \
 && rm -rf /var/lib/apt/lists/*
# The official Node build, laid out as in the node image so `npm install -g` lands on PATH.
COPY --from=node-dist /usr/local/bin/node /usr/local/bin/node
COPY --from=node-dist /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-dist /usr/local/include/node /usr/local/include/node
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && node --version && npm --version
COPY --from=fnm-build /usr/local/bin/fnm /usr/local/bin/fnm
RUN git init /opt/adm/oh-my-zsh \
 && git -C /opt/adm/oh-my-zsh remote add origin https://github.com/ohmyzsh/ohmyzsh.git \
 && git -C /opt/adm/oh-my-zsh fetch --depth=1 origin "$OH_MY_ZSH_REVISION" \
 && git -C /opt/adm/oh-my-zsh checkout --detach FETCH_HEAD \
 && apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY image/zshrc /usr/local/share/adm/zshrc
COPY image/zsh-identity.zsh /usr/local/share/adm/zsh-identity.zsh
COPY --from=js-build /out/runner.mjs /opt/adm/runner.mjs
COPY --from=js-build /out/workspace-env.mjs /opt/adm/workspace-env.mjs
COPY --from=js-build /src/node_modules /opt/adm/node_modules
COPY image/adm-dev-entrypoint /usr/local/bin/adm-dev-entrypoint
COPY image/adm-init-workspace /usr/local/bin/adm-init-workspace
COPY image/adm-shell-session /usr/local/bin/adm-shell-session
RUN chown root:root /usr/local/bin/adm-dev-entrypoint /usr/local/bin/adm-init-workspace /usr/local/bin/adm-shell-session /usr/local/share/adm/zshrc /usr/local/share/adm/zsh-identity.zsh \
 && chmod 755 /usr/local/bin/adm-dev-entrypoint /usr/local/bin/adm-init-workspace /usr/local/bin/adm-shell-session \
 && ln -sfn /workspace/.adm/catalog /repos \
 && ln -sfn /workspace/.adm/zsh/.zshrc /home/node/.zshrc \
 && printf '\n# ADM interactive workspace shells.\n. /usr/local/share/adm/zsh-identity.zsh\n' >> /etc/zsh/zshrc
ENV NODE_PATH=/opt/adm/node_modules \
    ADM_NODE_VERSION=${NODE_VERSION} \
    FNM_DIR=/workspace/.adm/fnm \
    LANG=C.UTF-8
WORKDIR /
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/adm-dev-entrypoint"]

FROM adm-workspace AS adm-code
# Claude Code for `adm claude` (TASK-90); pinned, since the Pod cannot auto-update a root-owned install.
ARG CLAUDE_CODE_VERSION=2.1.316
# Everyday build tools a coding agent expects; npm needs python3, make and g++ for native modules.
RUN apt-get update && apt-get install -y --no-install-recommends git chromium nano wget ca-certificates tmux \
    build-essential curl python3 pkg-config openssh-client unzip xz-utils bzip2 file patch gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm /etc/chromium.d/apikeys \
 && rm -rf /var/lib/apt/lists/*
COPY image/adm-git-credential /usr/local/bin/adm-git-credential
COPY image/adm-github-token /usr/local/bin/adm-github-token
COPY image/adm-git-identity /usr/local/bin/adm-git-identity
# Ahead of /usr/bin/gh on PATH: gives gh the cluster's GitHub login (TASK-111).
COPY image/adm-gh /usr/local/bin/gh
COPY image/browser.mjs /opt/adm/browser.mjs
# `artifact-fs add-repo` sets core.fsmonitor in each shared git dir to a hook that
# execs /usr/local/bin/artifact-fs fsmonitor-hook. The hook only reads ArtifactFS
# state under /workspace/.adm/repositories, so the same pinned binary at the same
# path lets git in this container use it instead of failing every command.
COPY --from=go-build /go/bin/artifact-fs /usr/local/bin/artifact-fs
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force && claude --version
# Docker CLI, compose and buildx (static binaries), for the workspace's Docker engine Pod
# through DOCKER_HOST; same release as the engine image pinned in src/workspaces.rs.
COPY --from=docker.io/library/docker:29.9.3-cli@sha256:2357639ad1ea7d0194134bf3292622fd4e562483966ed674e5d7c945b5f3b28d /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker.io/library/docker:29.9.3-cli@sha256:2357639ad1ea7d0194134bf3292622fd4e562483966ed674e5d7c945b5f3b28d /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
COPY image/adm-claude /usr/local/bin/adm-claude
COPY image/adm-claude-mcp /usr/local/bin/adm-claude-mcp
COPY image/adm-claude-credentials /usr/local/bin/adm-claude-credentials
RUN chown root:root /usr/local/bin/artifact-fs \
 && chmod 0755 /usr/local/bin/artifact-fs /usr/local/bin/adm-git-credential /usr/local/bin/adm-github-token /usr/local/bin/adm-git-identity /usr/local/bin/gh /usr/local/bin/adm-claude /usr/local/bin/adm-claude-mcp /usr/local/bin/adm-claude-credentials \
 && git config --system --add credential.https://github.com.helper '!/usr/local/bin/adm-git-credential' \
 && git config --system include.path /workspace/.adm/gitconfig

FROM adm-workspace AS adm-bot

# Go without its own tests: they carry private-key fixtures the image credential scan rejects,
# and building programs never needs them.
FROM go-build AS go-toolchain
RUN find /usr/local/go/src \( -name testdata -type d -o -name '*_test.go' \) -prune -exec rm -r {} + \
 && rm /usr/local/go/src/crypto/x509/platform_root_key.pem

# A coding workspace for working on ADM itself: `adm create --role coding --image .../adm-dev:<tag>`.
# Rust tracks stable like CI; the cargo registry and Go module caches live on the work volume.
FROM adm-code AS adm-dev
COPY --from=rust:1-bookworm /usr/local/rustup /usr/local/rustup
COPY --from=rust:1-bookworm /usr/local/cargo/bin /usr/local/cargo/bin
COPY --from=go-toolchain /usr/local/go /usr/local/go
COPY --from=kubectl-build /usr/local/bin/kubectl /usr/local/bin/kubectl
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/workspace/.adm/cargo \
    GOPATH=/workspace/.adm/go \
    PATH=/workspace/.adm/cargo/bin:/workspace/.adm/go/bin:/usr/local/cargo/bin:/usr/local/go/bin:$PATH
RUN rustup component add clippy rustfmt && cargo --version && cargo clippy --version && go version && kubectl version --client

FROM debian:bookworm-slim AS adm-repositories
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fuse3 git util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=go-build /out/adm-repositories /usr/local/bin/adm-repositories
COPY --from=go-build /go/bin/artifact-fs /usr/local/bin/artifact-fs
COPY packages/repositories/git /usr/local/lib/adm-repositories/git
RUN chown root:root /usr/local/bin/adm-repositories /usr/local/bin/artifact-fs /usr/local/lib/adm-repositories/git \
 && chmod 0755 /usr/local/bin/adm-repositories /usr/local/bin/artifact-fs /usr/local/lib/adm-repositories/git
# The sidecar mounts FUSE as UID/GID 1000 through setuid fusermount3, which needs /etc/mtab
# (containerd does not create it) and a passwd entry for the mounting user.
RUN ln -s /proc/self/mounts /etc/mtab \
 && groupadd --gid 1000 node && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin node

FROM node:${NODE_VERSION}-bookworm AS adm-control
COPY --from=adm-build /src/target/release/adm /usr/local/bin/adm
COPY --from=kubectl-build /usr/local/bin/kubectl /usr/local/bin/kubectl
# gh runs `gh auth login --web` for `adm repos login github` (TASK-111).
RUN install -d -m 0755 /etc/apt/keyrings \
 && wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
COPY --from=js-build /out/provider-auth.mjs /opt/adm/provider-auth.mjs
COPY --from=js-build /src/node_modules /opt/adm/node_modules
ENV NODE_PATH=/opt/adm/node_modules
WORKDIR /
