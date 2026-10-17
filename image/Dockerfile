# Development workspace image referenced by adm manifests as adm-dev:0.1.0.
# Model credentials stay on the management host; this image has no provider keys.

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
RUN npx esbuild packages/runner/src/remote-env-server.ts --bundle --platform=node --format=esm --outfile=/out/workspace-env.mjs

FROM node:24.18.0-bookworm
COPY LICENSE /usr/share/licenses/adm/LICENSE
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates git tini fuse3 chromium nano sudo wget \
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
COPY --from=go-build /out/adm-repositories /usr/local/bin/adm-repositories
COPY --from=go-build /go/bin/artifact-fs /usr/local/bin/artifact-fs
COPY packages/repositories/git /usr/local/lib/adm-repositories/git
COPY image/adm-dev-entrypoint /usr/local/bin/adm-dev-entrypoint
COPY image/adm-init-workspace /usr/local/bin/adm-init-workspace
COPY image/browser.mjs /opt/adm/browser.mjs
COPY --from=js-build /out/workspace-env.mjs /opt/adm/workspace-env.mjs
RUN chown root:root \
      /usr/local/bin/adm-repositories \
      /usr/local/bin/artifact-fs \
      /usr/local/bin/adm-dev-entrypoint \
      /usr/local/bin/adm-init-workspace \
      /usr/local/lib/adm-repositories/git \
 && chmod 755 \
      /usr/local/bin/adm-repositories \
      /usr/local/bin/artifact-fs \
      /usr/local/bin/adm-dev-entrypoint \
      /usr/local/bin/adm-init-workspace \
      /usr/local/lib/adm-repositories/git \
 && ln -sfn /workspace/.adm/catalog /repos
WORKDIR /
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/adm-dev-entrypoint"]
