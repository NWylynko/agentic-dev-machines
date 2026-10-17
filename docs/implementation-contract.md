# Implementation contract

ADM keeps agent execution in workspace Pods. The management host is an access plane: it runs the CLI and Kubernetes client, connects terminal and shell clients, and submits lifecycle requests. The lifecycle service is the durable owner of workspace identity, provisioning, and deletion. Coding and bot Pods own their runner, model requests, tools, MCP processes, conversations, profiles, goals, loops, schedules, and private files. Closing a client does not stop the Pod or its work.

This describes the fresh-workspace design. Old host sessions and old workspace records are not imported; no legacy migration or automatic local-runtime fallback is provided.

## Components and ownership

- The Rust `adm` CLI provisions through the lifecycle service, attaches to the selected Pod, and runs host-side access helpers. It does not register or supervise agent harnesses on the host.
- `adm lifecycle-serve` runs in the in-cluster control namespace, outside workspace namespaces. It owns the canonical directory, lifecycle operation receipts, Kubernetes provisioning/deletion, and Pod identity/lease checks. Its state is stored on the configured persistent volume; that volume alone does not prove cross-node durability or single ownership.
- Each workspace Pod runs the pinned Pi Durable runner and all of that workspace's agent execution. The workspace's private persistent volume stores files, Git state, runner history and schedule state, bot profile, and Pi authentication state. Pod replacement retains the volume-backed state; installed OS packages and other container filesystem changes are ephemeral.
- The terminal is a reconnectable Pi-style client to a selected Pod runner. It supports the model selector, conversation/history controls, branches, settings, and live events. A terminal disconnect does not abort work.

Coding Pods have a private writable `/repos`, coding tools, Git, browser, and unattended passwordless sudo/root inside their own container. This is container-local authority; it grants no host or cluster authority and no access to another workspace's files. A bot Pod has its own private volume; its agent tool registry exposes no repository or shell tools, including through Code Mode. Bots can use the lifecycle and runtime APIs to manage every live coding workspace by immutable ID; there are no per-workspace bot grants.

## Authentication and credential scope

Operator/CLI lifecycle requests use the control-plane bearer token from a protected token file. Workspace Pods never receive that token. A Pod receives a projected ServiceAccount token with the dedicated `adm-lifecycle` audience, bound to that Pod UID. The lifecycle service verifies the audience, `adm-runtime` ServiceAccount, current workspace namespace/labels, live Pod UID, workspace runtime lease, and bot/coding role policy. Each Pod runner asks the lifecycle service to authorize incoming requests; a stale or replaced Pod cannot retain authority. Pod runners renew a durable runtime lease and check its fence at new-work admission and Durable commit boundaries. Losing the lease stops work.

The host retains the Kubernetes credentials needed by the CLI and lifecycle controller. Kubeconfig contents are not copied into Pods or runner configuration. `adm login NAME` opens Pi's standalone provider-authentication UI inside the selected workspace Pod, without a coding-tool registry or extra conversation. The saved Pi auth store is private to that workspace. API keys may instead be injected by a workspace-scoped Kubernetes Secret reference such as `--credential-env OPENAI_API_KEY=provider-auth:openai`; ADM stores the reference, not the value. Full root in a workspace can read credentials delivered to that same workspace, so Secret scope matters. No provider or credential fallback is performed.

## Workspace and client behavior

Every new workspace creates its durable agent. With no default or explicit model, it remains in `needs_model`; no provider request runs until a model is selected. Selection through the attached terminal updates the existing Durable conversation and survives runner restart without replacing its history. Provider errors remain visible and require an explicit retry or follow-up.

The runner exposes its HTTP/SSE API on the workspace Pod. The CLI validates the selected Pod identity, opens a port-forward for client commands, and presents a private projected Pod identity to terminal/shell helpers. Workspace runner requests carry that identity and are authorized against the lifecycle service. Bot-to-coding requests use the bot's projected identity and the target coding Pod's private Pod IP; the target runner performs the same lifecycle authorization. Workspace network policies permit lifecycle and bot-to-coding runtime traffic; coding Pods also have external egress for their tools and provider requests.

Important runner endpoints include:

- `GET /health` reports runner health and lease-loss errors.
- `GET /v1/workspaces/:id` returns workspace status, model, goals, and loops. `GET /v1/workspaces` returns the runner's local directory; it is not the global workspace directory.
- `GET /v1/workspaces/:id/models` returns model and authentication metadata without credential values. `PUT /v1/workspaces/:id/model` changes the selected model on the existing conversation.
- `POST /v1/workspaces/:id/input`, `/abort`, `/resume`, and `/retry` admit or stop work. Input request IDs deduplicate submissions. Resume is explicit and rejects retries after tool effects until the caller inspects and follows up.
- `GET /v1/workspaces/:id/events` streams durable history and live updates. `GET /history` and `/tree` provide paginated conversation history; bot chat hides model/tool output unless diagnostics are explicitly requested. `POST /new` creates another Durable conversation in the same workspace; branch endpoints select or fork conversations. Terminal operations also include context compaction/reset and `GET/PUT /settings` for the Durable agent's thinking level.
- `POST /v1/workspaces/:id/goals` creates or updates durable goals. `POST /loops` creates or updates durable scheduled work. A loop stores its next trigger and stable request receipt before delivering the prompt; a missed occurrence runs once. Deletion prevents future work from being admitted.

The API uses non-2xx JSON errors. Deleted workspaces reject new admissions; unknown IDs return 404. Bot-created lifecycle workspaces use the lifecycle API below rather than mutating another Pod's local registration.

## Bot management API

`GET /v1/runtime/workspaces` returns live coding workspaces with immutable ID, name, lifecycle phase, and runtime readiness/activity; it excludes credentials and private configuration. A live bot can inspect target status/history, prompt or steer/follow up, resume/abort work, manage goals/loops, and change a coding agent's model. The lifecycle service authorizes each action; target Pods independently reauthorize requests. These tools are also exposed through Code Mode, under the same authorization checks. Bots have no repository, shell, or general cross-workspace credential access.

Bots create and destroy coding workspaces through durable lifecycle operations. `POST /v1/runtime/operations` accepts a stable `operationId` plus a create spec or an immutable target ID for delete. `GET /v1/runtime/operations/:operationId` returns that operation's persisted status and failure details. Repeating the identical request replays its receipt; reusing the ID with a different request is rejected. Names may be reused only after deletion, and a reused name receives a new immutable ID.

New bot conversations durably admit one onboarding turn after model selection. The profile stores confirmed identity and purpose; bots publish user-facing text only through `sendMessage`. Bot runtime and schedule state live on the bot's private persistent volume and continue without a connected terminal or management-host process.

## Release, persistence, and verification limits

`install.sh` installs the Linux x86_64 CLI and its compiled terminal/runtime dependencies without a checkout. `adm setup` stores nonsecret defaults. The matching workspace image contains the Pod runner and coding tools. Installation/package and image smoke tests use isolated fixtures and synthetic credentials.

Runner SQLite ownership uses a process lock and fencing; actual storage must provide compatible SQLite locking. A persistent volume is not proof of cross-node correctness. Recent-node failure loss windows, sudden-node-loss guarantees, actual cluster Pod replacement with the new runtime image, and unattended work during a real management-host outage require separate live evidence. See [validation](validation-2026-10-17.md) for the verified checks and remaining rollout prerequisites.
