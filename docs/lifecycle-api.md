# In-cluster lifecycle API

`adm lifecycle-serve` is the durable owner of workspace identity, provisioning, runtime authorization, and deletion. It runs in the control namespace, outside the workspace namespaces it manages. The management host is a client; workspace runners and bots use separate Pod-bound identities. The service stores its journal on its configured persistent volume. The volume does not by itself prove cross-node durability or single ownership.

## Authentication

`GET /health` is public and reports whether the service currently holds its Kubernetes Lease. Operator and CLI lifecycle routes use `Authorization: Bearer <client-token>`, read from a protected file supplied by `--lifecycle-token-file` or `ADM_LIFECYCLE_TOKEN_FILE`. Keep the Service private and the client token outside workspace Pods.

Runtime routes use a different credential: a projected ServiceAccount token with audience `adm-lifecycle`, bound to the calling Pod UID. The service verifies it with Kubernetes TokenReview and checks the `adm-runtime` account and canonical workspace namespace. Management authorization also matches the bound UID to exactly one current Pod with the immutable workspace label and checks its unexpired runtime lease. Initial lease acquisition establishes that lease. Runtime tokens do not grant control-plane bearer access. A bot may act across live coding workspaces; a coding runtime can act only on itself. The lifecycle service does not use per-agent grants.

## Durable lifecycle routes

- `POST /v1/operations` accepts `{operationId,kind:"create",spec:{name,role,image,storage_class,storage_size,cpu,memory,agent_enabled,allow_node_local_storage,repositories,catalog,repository,cwd,model,credential_env,mcp_servers,herdr_space}}` or `{operationId,kind:"delete",workspaceId}`. Create allocates the immutable workspace ID and namespace and persists `provisioning` state before returning HTTP 202. Unknown create fields are rejected. `credential_env` contains only `{name,secret_name,key}` Secret references, never secret values. A repeated ID with the identical request replays its receipt; using that ID for another request returns 409.
- `GET /v1/operations/{operationId}` returns the durable receipt. Unknown IDs return 404. Receipts contain operation kind/status, workspace ID, timestamps, current stage, error, timings, and lifecycle fencing token.
- `GET /v1/workspaces` returns the canonical directory. `GET /v1/workspaces/{workspaceId}` returns one canonical workspace record. The service joins owned Kubernetes Pods using namespace and immutable workspace ID, reports Pod/node/readiness and runtime activity/model, and marks missing, duplicate, or unavailable runtime data explicitly. Runtime status requests use short-lived TokenRequests bound to each exact target Pod UID, not the reusable control-plane token. Status collection is bounded and runs at most four Pod requests concurrently.
- `POST /v1/workspaces/{workspaceId}/herdr` binds or clears the Herdr association using the operator credential. Herdr close cleanup submits the ordinary durable delete operation.

Create and delete workers record stage, timing, and failure state. Deletion admission moves the workspace to `deleting` before cleanup so new runtime admissions are rejected immediately. Before deleting a namespace, the service verifies ADM ownership labels and immutable workspace ID. A missing namespace can be reconciled against the canonical record. Accepted, running, and failed operations are recoverable after service restart; replay uses the persisted operation identity.

The service is protected by a Kubernetes Lease with resourceVersion compare-and-swap and a monotonically increasing fencing token. Workspace runtimes also hold a durable 30-second lease. They acquire `/runtime/lease`, renew through `/runtime/lease/renew`, and check `/runtime/check` at work admission and Durable commit boundaries. These endpoints require the caller's Pod-bound token and `{holder:<pod-uid>}` or `{holder,fencingToken}` as appropriate. A deleting workspace rejects lease and runtime checks. The persistent journal is necessary for recovery but is not proof of storage failover behavior.

## Pod runtime and bot routes

These routes require a valid projected Pod token; they do not accept the operator bearer token.

- `POST /v1/workspaces/{workspaceId}/runtime/authorize` accepts `{action}` for `read`, `prompt`, `abort`, `resume`, `goal`, `loop`, `model`, `delete`, or `status`. The service verifies that the caller Pod is live and leased. A bot may authorize actions against coding workspaces; a coding Pod may authorize only its own workspace. Status is restricted to the caller's own workspace. The target runner independently calls this route for each incoming client request, so routing through a bot does not bypass target authorization.
- `GET /v1/runtime/workspaces` is the bot-only coding workspace directory, excluding deleting/deleted records. It returns immutable ID, name, role, lifecycle phase, namespace, and runtime readiness/activity. A listed workspace can have an unavailable or NotReady runtime; the response does not imply that its Pod is ready. It excludes credential references and private workspace configuration.
- `POST /v1/runtime/operations` is bot-only and admits a durable coding workspace create or delete. It accepts the same `{operationId,kind,spec}` or `{operationId,kind:"delete",workspaceId}` envelope as the operator route. Create is restricted to role `coding`; delete must target a coding workspace. The service durably admits the operation before returning its receipt.
- `GET /v1/runtime/operations/{operationId}` is bot-only and returns the stored receipt for a coding workspace operation, including after restart or workspace deletion. Unknown IDs return 404. Bots can replay only the same operation ID and immutable request; a reused name after deletion has a new ID.
- `GET /health` is the only route that needs no bearer token.

Bot runtime authorization is broad across coding workspaces, including calls made through Code Mode. The runtime API exposes monitoring, prompting, history, model, goal, loop, and lifecycle operations. It does not expose repository files, shell access, or general credentials for another workspace. Workspace network policies permit lifecycle and bot-to-coding runtime traffic; coding Pods also have external egress for their tools and provider requests.

## Client setup

The control-plane Deployment uses the ADM image containing the `adm` and pinned `kubectl` binaries. Create `adm-system`, a protected client-token file, and the Kubernetes Secret `adm-lifecycle-token` with key `token`; do not put the value in a manifest, shell history, normal ADM config, workspace spec, receipt, or log. Apply `deploy/lifecycle/control-plane.yaml`. The cluster must already provide the configured StorageClass.

For host CLI access, forward the private Service with `kubectl -n adm-system port-forward service/adm-lifecycle 7433:7433`, supervise the tunnel, set `ADM_LIFECYCLE_URL=http://127.0.0.1:7433`, and point `ADM_LIFECYCLE_TOKEN_FILE` to the protected client copy. Workspace Pods use the in-cluster Service address and projected Pod tokens instead. This installation recipe is not a live-cluster validation claim; see [validation](validation-2026-10-17.md) for current evidence and limits.
