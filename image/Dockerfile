# Development workspace image referenced by adm manifests as adm-dev:0.1.0.
# Provider refresh credentials live in the lifecycle persistent volume; the image contains no keys.

FROM golang:1.26.5-bookworm AS go-build
WORKDIR /src/repositories
COPY packages/repositories/go.mod packages/repositories/go.sum ./
RUN go mod download
COPY packages/repositories/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/adm-repositories .
COPY packages/repositories/ARTIFACTFS /tmp/ARTIFACTFS
RUN go install "github.com/cloudflare/artifact-fs/cmd/artifact-fs@$(tr -d '\n' < /tmp/ARTIFACTFS)"

FROM node:24.18.0-bookworm AS js-build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/runner/package.json packages/runner/package.json
COPY packages/terminal/package.json packages/terminal/package.json
RUN npm ci --ignore-scripts
COPY packages/runner packages/runner
RUN npx esbuild packages/runner/src/main.ts --bundle --platform=node --format=esm --packages=external --outfile=/out/runner.mjs \
 && npx esbuild packages/runner/src/provider-auth-main.ts --bundle --platform=node --format=esm --packages=external --outfile=/out/provider-auth.mjs \
 && npx esbuild packages/runner/src/remote-env-server.ts --bundle --platform=node --format=esm --outfile=/out/workspace-env.mjs \
 && npm prune --omit=dev --ignore-scripts

FROM rust:1.89-bookworm AS adm-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --bin adm

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

FROM node:24.18.0-bookworm
ARG OH_MY_ZSH_REVISION=4d4cfc287e9d887b81242c0e431b5f49f9cec5c1
COPY LICENSE /usr/share/licenses/adm/LICENSE
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
COPY image/adm-git-credential /usr/local/bin/adm-git-credential
RUN chmod 0755 /usr/local/bin/adm-git-credential \
 && git config --system --add credential.https://github.com.helper '!/usr/local/bin/adm-git-credential'
RUN git init /opt/adm/oh-my-zsh \
 && git -C /opt/adm/oh-my-zsh remote add origin https://github.com/ohmyzsh/ohmyzsh.git \
 && git -C /opt/adm/oh-my-zsh fetch --depth=1 origin "$OH_MY_ZSH_REVISION" \
 && git -C /opt/adm/oh-my-zsh checkout --detach FETCH_HEAD
COPY image/zshrc /usr/local/share/adm/zshrc
COPY --from=go-build /out/adm-repositories /usr/local/bin/adm-repositories
COPY --from=go-build /go/bin/artifact-fs /usr/local/bin/artifact-fs
COPY --from=js-build /out/runner.mjs /opt/adm/runner.mjs
COPY --from=js-build /out/provider-auth.mjs /opt/adm/provider-auth.mjs
COPY --from=js-build /src/node_modules /opt/adm/node_modules
COPY packages/repositories/git /usr/local/lib/adm-repositories/git
COPY image/adm-dev-entrypoint /usr/local/bin/adm-dev-entrypoint
COPY image/adm-init-workspace /usr/local/bin/adm-init-workspace
COPY image/browser.mjs /opt/adm/browser.mjs
COPY --from=js-build /out/workspace-env.mjs /opt/adm/workspace-env.mjs
COPY --from=adm-build /src/target/release/adm /usr/local/bin/adm
COPY --from=kubectl-build /usr/local/bin/kubectl /usr/local/bin/kubectl
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
ENV NODE_PATH=/opt/adm/node_modules
WORKDIR /
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/adm-dev-entrypoint"]
