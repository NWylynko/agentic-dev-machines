# Implementation contract

This is the shared contract for the initial implementation. Public tests exercise the real CLI, the runner HTTP API/SQLite recovery, terminal attachment, and isolated Kubernetes resources.

## Components

- Rust `adm` CLI: lifecycle metadata, Kubernetes provisioning, shell/port connections, Herdr association, and launching/connecting to the local durable runner.
- TypeScript runner: Pi Durable 1.2.0, separate SQLite stores for immutable workspace IDs, coding and bot roles, unattended work, event subscriptions, goals/loops, explicit bot messages, and per-agent supervision permissions.
- TypeScript terminal: reconnectable Pi-style terminal client, launched in a Herdr pane by `adm attach`; uses the runner's public HTTP interface.
- Repository integration: lazy Git-backed repository catalog and independent per-workspace files/Git metadata, with explicit storage requirements.

Model/provider authentication is held on the management host, never passed to the dev container. The runner executes coding tools through `kubectl exec` into `/opt/adm/workspace-env.mjs` in the workspace's `dev` container. An explicitly selected `environment: "local"` exists for tests; it is never an automatic fallback when Kubernetes fails.

## Installation and configuration

`install.sh` installs or updates a complete Linux x86_64 release without a checkout. Versioned runtime directories sit under `$XDG_DATA_HOME/adm/install` (normally `$HOME/.local/share/adm/install`); `$HOME/.local/bin` commands point through its active `current` link. The CLI resolves compiled runner/terminal entry points beside its executable. `--project-dir` / `ADM_PROJECT_DIR` explicitly select a runtime or development checkout. Release archives include production Node dependencies with their worker/WASM assets and require host Node.js 24+.

First installation offers `adm setup`; updates preserve configuration and workspace state. `adm setup` writes nonsecret image, StorageClass, and optional model defaults to `$XDG_CONFIG_HOME/adm/config.json`, normally `$HOME/.config/adm/config.json`. Explicit command flags take precedence; `--no-agent` disables agents regardless of a configured default model. Without a model default, creation still requires `--model PROVIDER/MODEL_ID` or `--no-agent`. The release's matching image is used when no image is configured or supplied.

Setup can open pinned Pi provider authentication (`adm login`) and generate a systemd user service for `adm serve`. It never configures cluster storage, changes Kubernetes context, stores provider keys, or imports the login shell's keys into systemd. Persistent operation after logout also requires systemd lingering. Installer and setup tests run public shell/CLI entry points with isolated homes, release fixtures, and external service boundaries; package tests run the actual compiled CLI/runner and Code Mode from the release archive without source paths.

## Runner service API

Default bind: `127.0.0.1:7432`. CLI options can select another bind/port/state path. No public network exposure by default. The runner must reject non-loopback binds unless explicit authenticated configuration is supplied.

- `GET /health`: `{status:"ok",version:...}`.
- `PUT /v1/workspaces/:id`: register idempotently. Body `{id,name,role:"coding"|"bot",namespace?,container?:"dev",cwd?:"/repos",environment:"kubernetes"|"local",localRoot?,model?:{provider,id},allowedAgents?:string[],mcpServers?:[{id,command,args?,tools,secretEnv?}]}`. `mcpServers` is bot-only host configuration for stdio servers and exact tool names; `secretEnv` maps server env names to environment variable references injected into the runner. Stdio children inherit no other runner environment. Immutable role/environment identity cannot change on retry. Creates/opens the Durable store; resumes pending work without needing a client. Returns workspace status.
- `GET /v1/workspaces`: list registered sessions/status.
- `GET /v1/workspaces/:id`: `{id,name,role,status,model?,goals:[],loops:[],...}`.
- `POST /v1/workspaces/:id/input`: `{message,requestId?}` admits input, returns submission ID immediately; repeat request IDs deduplicate.
- `POST /v1/workspaces/:id/abort`: `{background?:boolean}` stops current work; space deletion is separate.
- `POST /v1/workspaces/:id/resume`: explicitly retries the latest unanswered provider failure, using a durable request identity to deduplicate repeated admissions. Returns 202. A turn with a tool call or result returns 409 `RESUME_AFTER_TOOL_EFFECT`; the caller must inspect any effects and send a deliberate follow-up. A workspace without a selected model returns 409 `MODEL_REQUIRED` for new input.
- `DELETE /v1/workspaces/:id`: persist tombstone, reject admissions, stop all owned work including background, close store; retained history is passive. Idempotent. No old input/loop may recreate it.
- `GET /v1/workspaces/:id/events?after=N`: SSE, each `data:` object `{seq,workspaceId,kind:"user"|"assistant"|"tool"|"message"|"status",data,timestamp}`. Durable/reconstructable event cursor. Client disconnect does not abort. Bot chat renders only `user`, explicit `message`, and concise system `status`, never ordinary model/tool output. Raw diagnostics can be explicitly inspected.
- `GET /v1/workspaces/:id/history?after=0&limit=200&diagnostics=false`: `after` is a nonnegative cursor (default 0). `limit` is an integer from 1 through 1000 (default 200). `diagnostics=true` includes the bot model and tool events that the chat hides. Deleted workspaces still return 200. The body is `{events, nextAfter, hasMore}`.
- `POST /v1/workspaces/:id/goals`: create with `{description}` or update with `{id, description?, status?}`. `status` is `active`, `completed`, or `cancelled`. Response is `{id, description, status, createdAt}`.
- `POST /v1/workspaces/:id/loops`: create with `{prompt, intervalMs, nextAt?}`. `intervalMs` is an integer from 1000 through 366 days. `nextAt` defaults to now plus that interval. Update with `{id, status?}` where `status` is `active` or `cancelled`. Response is `{id, prompt, intervalMs, nextAt, status}`. The runner saves the next trigger and the request id `loop:<id>:<scheduledAt>` before it delivers that occurrence. A missed beat runs once and schedules the following one at now plus the interval. Deleted workspaces do not resume loops.

Errors: non-2xx JSON `{error:{code,message}}`. Deleted IDs return 410 for admissions. Unknown IDs return 404. Invalid names/paths/roles return 400. No silent provider/environment fallback. Health/status failures are visible.

Status includes `needs_model` when no model is selected and `error` with a persisted provider failure message when the latest generation failed. CLI creation requires a configured default model, explicit `--model PROVIDER/MODEL_ID`, or `--no-agent` before provisioning. Provider errors survive runner restart; no automatic provider switch or retry timer is used.

## Ownership and isolation

Each Kubernetes coding workspace gets a unique `adm-<id-prefix>` namespace and single-replica Recreate Deployment named `workspace`, with a `dev` container. Namespace label `app.kubernetes.io/managed-by=adm`, workspace annotation/label holding the immutable ID. Service-account token automount disabled. Dev containers have no cluster-admin/model credentials. Never delete resources without validating ownership and immutable ID. Deletion tombstones outlive destroyed resources. A bot has no repo mount or coding environment/tools; it may observe/prompt only explicitly permitted agent IDs. A label reused after deletion receives a fresh ID.

Bot supervision tools include `listAgents`, which returns `{agents:[{id,name,status}],unavailable:[id],message}` for the bot's explicit grants. The directory includes only live coding agents; empty grants have an explanatory message, while deleted or missing grants are reported as unavailable. `monitorAgent` and `promptAgent` continue to require the immutable ID, with authorization checked on every call, including calls made through Code Mode.

New bot conversations durably admit one `onboarding:<workspace-id>` input. Their profile document stores setup state, identity, purpose, and host-approved MCP grant identifiers; a prompt section reads the committed profile into subsequent requests. Existing conversations without a profile are not auto-onboarded during upgrade. `sendMessage` publishes the initial setup question and confirmations. Bots can request more access through a published message, but only host configuration can grant it. MCP tools are wrapped as Durable tools and remain subject to workspace deletion checks. Only tools marked read-only by the stdio server are replay-safe; other MCP calls are abandoned after an interrupted execution.

The CLI stores metadata under its selected state directory. The service stores its session state in a separate child directory. Runner directories are mode 0700, and its SQLite databases and owner metadata are mode 0600. A held exclusive transaction in `owner.sqlite` enforces one runner process independently of the diagnostic PID/start-identity record in `owner.json`. Replacing or restoring that metadata cannot displace a live owner. This still requires a filesystem with reliable SQLite locking, not a cross-node ownership claim. The daemon's bind address/state path are configurable. No real secrets in files committed to this repository.

The lazy catalog is opt-in with `--catalog`; otherwise `/repos` is an ordinary writable workspace directory. The repository service rejects unfiltered upstreams on every acquisition attempt and reports backend death instead of remaining healthy. Kernel mount identity distinguishes a replacement ArtifactFS mount from a previous one at the same path.

The remote environment helper cancels active requests and cleans up detached command process groups on stdin EOF, SIGTERM, or stdout disconnection. A lost management transport must not leave an old shell running concurrently with replacement work. This cancellation does not undo file or external side effects that already occurred.

`adm herdr watch --socket "$HERDR_SOCKET_PATH"` runs inside the owning Herdr session (`HERDR_ENV=1`) against that session's socket. It subscribes through `events.subscribe`, accepts the `subscription_started` acknowledgement, and consumes pushed event envelopes from that connection. It acts only on explicit `workspace_closed` events. Received removal IDs are fsynced before destruction and replayed after an interrupted cleanup. Herdr currently supplies no replay cursor for events missed during a disconnected watcher; startup/list absence is never interpreted as deletion. Supervise the watcher and inspect connection failures. `adm herdr events` remains the newline-delimited JSON adapter for externally delivered explicit events.

## Validation

Use faux models to exercise real Durable work without needing credentials. Run actual subprocess-kill/restart tests, streaming disconnection/reconnect, bot tool exclusion including Code Mode, explicit messaging, durable goals/loops and deletion. Cluster tests create only uniquely owned test namespaces and remove only their own resources. Browser/port tests use those resources. Do not drain the user's physical nodes; move only our test workload through node selectors when testing placement changes.
