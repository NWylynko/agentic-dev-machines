# agent-sandbox spike (TASK-89)

Question: should ADM run workspaces as kubernetes-sigs/agent-sandbox `Sandbox` resources instead of its own per-workspace Namespace + PVC + Recreate Deployment + SQLite lifecycle? This also answers the key question for TASK-118 (sub-200 ms `adm create`).

Run on 2026-11-01 against the homelab k3s cluster (v1.36.5+k3s1, Longhorn `adm-replicated`), with agent-sandbox **v1.0.9** (`sandbox-with-extensions.yaml`, API `agents.x-k8s.io/v1beta1` and `extensions.agents.x-k8s.io/v1beta1`). Everything ran in the disposable namespace `adm-spike-89`. Afterwards the namespace, its PVs and agent-sandbox itself (CRDs, `agent-sandbox-system`, ClusterRoles) were all removed. `adm-system` was only read.

## Verdict: no-go on migrating; the warm-pool idea is worth doing inside ADM

- **Cold create is no faster.** A Sandbox takes the same ~19.5 s as `adm create` (20 s). Most of that is still Longhorn attach, and agent-sandbox can't change it.
- **Node failure: nothing gets better.** agent-sandbox doesn't handle a dead node at all. TASK-91 is still needed in full (see below).
- **Warm pools technically work** (claim→Ready ≤ 0.3 s, with a PVC that is already attached). But to use them ADM would have to give up per-workspace namespaces, give up per-workspace env/Secret refs, keep one pool per workspace shape, and change the runner to learn its identity after it starts. That last change is what actually makes create fast, and ADM can do it with its own pre-provisioned workspaces. A second controller with its own ownership model isn't needed for that.
- Product effect of no-go: users get the same create time today. Sub-second create (TASK-118) is still reachable: ADM keeps a small pool of unassigned, already-attached workspaces and hands one out on `adm create`. Isolation stays as it is now (one namespace, ServiceAccount and NetworkPolicy per workspace). The cost of a pool is idle cluster resources (below).

## What was built

A hand-written `Sandbox` equivalent to one rendered ADM coding workspace (`manifest()` in `src/workspaces.rs`). It has:
- the `initialize` init container (`adm-workspace`);
- the `dev` container (`adm-code`) with ADM's security context, limits, `ADM_POD_UID`, and the `/run/adm/workspace.json` ConfigMap;
- the privileged `repositories` sidecar (`adm-repositories`) with Bidirectional mount propagation;
- ServiceAccount `adm-runtime` with `automountServiceAccountToken: false`, plus a projected token with audience `adm-lifecycle`;
- `volumeClaimTemplates` `work` (RWO, `adm-replicated`, 4Gi), `service: true` and `failedPodPolicy: Recreate`;
- ADM's NetworkPolicy as a separate object, because a bare `Sandbox` has no NetworkPolicy field (only `SandboxTemplate` has one). The YAML is in the appendix.

Images: `ghcr.io/nwylynko/agentic-dev-machines/{adm-workspace,adm-code,adm-repositories}:sha-69405b575918`, already cached on the node.

How far it got: all three containers ran, and the runner served HTTP. It was not registered with the real lifecycle. `ADM_LIFECYCLE_URL` pointed at a non-existent Service in the spike namespace on purpose, so nothing reached `adm-system`. The runner therefore sat at "Waiting for workspace lifecycle lease", and the readiness probe was switched from `/ready` (which needs a lease) to `/health`, which answers once the runner is serving. A real workspace would add one lease round trip on top of the times below. The shared repository-bases PV/PVC was left out so nothing pointed at the lifecycle's RWX volume. Gotcha found on the way: `workspace.json` `model` must be `{"provider","id"}`; a string crash-loops the runner with `INVALID_MODEL`.

## Measurements

Times are measured from `kubectl apply` to the watch event, so they include about 0.1–0.3 s of kubectl overhead.

| Operation | Time | Notes |
|---|---|---|
| Sandbox create → Ready (cold) | 19.46 s, 19.65 s | Events: PVC provisioned at +2 s, attach finished at +13 s (~11 s attach), containers started at +16 s, Ready at +19.5 s. Matches the 20 s `adm create` baseline. |
| Running → Suspended | 1.38 s, 1.33 s, 1.25 s | Pod deleted, Sandbox and PVC kept. The VolumeAttachment went away ~1 s later. |
| Suspended → Running | 14.44 s (after full detach), 9.73 s (resumed immediately), 14.71 s (claimed warm sandbox) | `/workspace/marker` written before suspend was intact after resume every time. Pod came back on the same node. |
| Claim from warm pool → claim Ready | ≤ 0.30 s (twice) | The first watch event already showed `Ready=True`. The warm Pod, its PVC and the attachment were made beforehand. |
| Pool replenish after a claim | ~20 s | Same as a cold create. |
| Delete Sandbox → Pod, PVC and PV gone | Sandbox object gone in 0.3 s (background GC); Pod+PVC+PV gone within ~20 s | PVC is owned by the Sandbox, so GC removes it. With reclaim `Delete`, the Longhorn PV goes too. Deleting a SandboxClaim removed its PVC in 2 s (claim → Sandbox → PVC ownership chain). |
| Force-delete Sandbox Pod (live node) → Ready | 4.78 s | Same Pod name, same node, volume still attached. |
| Idle cost per warm sandbox | ~100 MiB RSS (`dev` ~97 MiB + sidecar ~5 MiB), ~5 m CPU, one 4Gi volume ×3 Longhorn replicas | Controller: 26 MiB. |

ADM has no suspend today. agent-sandbox's `operatingMode: Suspended` is the same as scaling ADM's Deployment to 0 and back to 1: the Pod goes away and the PVC stays. ADM could add that without agent-sandbox.

## Warm pools: can a warm Pod be bound to a workspace after it is claimed?

**Yes, but only if ADM binds identity after the Pod starts, and only within limits that clash with how ADM is built today.** What v1.0.9 actually does (`extensions/controllers/sandboxclaim_controller.go`):

- **PVC: yes, and it's already attached.** Each warm Sandbox makes its PVC from the template's `volumeClaimTemplates` when the pool fills, and the PVC goes with the Sandbox when it's claimed. Ownership moves pool → claim (`completeAdoption`). So a warm pool already is a pool of pre-attached volumes, which is why claim→Ready is ≤ 0.3 s. Each claimed workspace starts on a fresh, empty volume, which is exactly what a new workspace needs.
- **Identity, model, repo: not through agent-sandbox.** At claim time only labels and annotations reach the running Pod (`additionalPodMetadata`, and only keys in an allowlisted domain, default `sandbox.users.io`). This was verified live: the warm Pod gained `sandbox.users.io/workspace-id=ws-a` and `agents.x-k8s.io/claim-uid` without restarting. Anything that affects how the Pod is built forces a cold start: `claimForcesColdStart` returns true for any `spec.env` or `spec.volumeClaimTemplates` on the claim. ConfigMap contents, image, resources and Secret refs are fixed by the template. Every warm Pod mounted the same `workspace.json`. So the runner would have to start with no workspace and then get its ID, model and repo from the lifecycle. The Pod-bound SA token and the Pod UID are already enough for that: the lifecycle records "workspace X → Pod UID U" on create, and the runner's existing "waiting for lease" loop picks it up. After that, a repo checkout is a normal runtime step; `/repos` is already lazy.
- **Namespace: one per pool.** Claims only adopt Sandboxes from a pool in the claim's own namespace. ADM gives each workspace its own namespace, its own `adm-runtime` ServiceAccount (the token's namespace is part of the runtime identity), its own NetworkPolicy and namespace-ownership checks (`verify_ownership`). With warm pools all workspaces would share one namespace, one ServiceAccount, and NetworkPolicies selected by label.
- **One pool per shape.** Image, CPU and memory, storage size, `--no-repositories`, `--credential-env`, and coding vs bot are all template fields or forced cold starts. Each combination needs its own template and pool, or falls back to the 20 s path.

**Answer for TASK-118:** a pool of pre-attached volumes does make create near-instant (≤ 0.3 s measured for the Kubernetes part). What makes it possible is late identity binding in the runner, not agent-sandbox. ADM can get the same result while keeping one namespace per workspace. It pre-creates N unassigned workspaces of the default shape: each with its own namespace, PVC, Deployment and a runner waiting for an identity. `adm create` then assigns one in SQLite and starts a replacement in the background. Non-default shapes use the cold path.

## Node failure and `failedPodPolicy`

Read from `controllers/sandbox_controller.go` and KEP 729 (`docs/keps/729-opt-in-pod-recreation-on-failure`):

- `failedPodPolicy: Recreate` only reacts to Pod **phase `Failed`**, for example a kubelet eviction under node pressure. The KEP lists that as the motivating case. It doesn't look at node readiness at all.
- A Pod on a node that goes NotReady stays `Running` with `Ready=False`. After the default 300 s `not-ready`/`unreachable` toleration (live Pods had it), taint eviction sets a `deletionTimestamp`. A dead kubelet never confirms, so the Pod stays `Terminating`. The Sandbox controller treats any existing Pod with its name as its Pod (`reconcileExistingPod`). The replacement Pod reuses the Sandbox's name, so it can't even be created until the old Pod object is gone. This is exactly the stuck state of today's Recreate Deployment.
- Once the old Pod is force-deleted, the Sandbox recreates it right away: 4.78 s measured on a live node. But on a different node, the RWO Longhorn volume stays held by the dead node's VolumeAttachment, giving `Multi-Attach` errors until the ~6 min force-detach.
- The agent-sandbox controller is a single replica. If it runs on the dead node, nothing reconciles until it is rescheduled. That's the same weakness ADM's lifecycle has.

### Relevance to TASK-91

agent-sandbox would replace **none** of TASK-91's `adm-failover` work. Someone still has to force-delete Pods on a dead node and get rid of the dead node's VolumeAttachments. Worth checking for TASK-91 itself, independent of agent-sandbox: Kubernetes non-graceful node shutdown (GA since 1.28) does both natively when a node gets the taint `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute`. PodGC force-deletes its terminating Pods, and the attach/detach controller force-detaches their volumes without the 6 min wait. `adm-failover` could just add that taint after the node has been NotReady for 180 s (and remove it when the node comes back) instead of deleting Pods and VolumeAttachments itself. This is not measured; the procedure below covers it.

## ADM code: deleted vs kept if ADM adopted agent-sandbox

Deleted or shrunk:
- `src/workspaces.rs` `manifest()`: the Deployment, `work` PVC and Service objects become one `Sandbox` (the pod spec moves into it unchanged).
- `src/workspaces.rs` rollout waiting in `create_persisted`/`upgrade_persisted` (`kubectl rollout status`) becomes waiting on the Sandbox `Ready` condition. That's about the same amount of code.
- `destroy`: deleting the namespace would become deleting the Sandbox (the PVC goes by GC), but only if namespaces are shared (warm-pool case).

Kept:
- The SQLite registry: immutable IDs, tombstones, same-spec retries, repos, connectors, agents file. agent-sandbox has no workspace identity or tombstone concept.
- Leases and fencing (`lease.rs`) and runtime auth (projected token, Pod-UID binding).
- NetworkPolicy rendering. A bare Sandbox has no field for it, and the template-level `networkPolicy` is one shared policy per template.
- The repository-bases static PV/PVC, the init container, the sidecar, and ServiceAccounts.
- `node_failover_loop` / TASK-91 in full.
- `adm update --workspace`: Sandbox pod-template changes don't touch a running Pod, so ADM would still have to delete the Pod (or suspend/resume) to roll images.

Added: a cluster-wide controller and four CRDs to install, upgrade and watch for each ADM install. Changes to them can break ADM; v1.0.9 alone has two "Action Required" notes. Net: less than ~20 lines of JSON deleted in exchange for a new dependency. Not worth it.

## Node power-off procedure (for Nick)

This tests whether the conclusion above holds on real hardware. It reinstalls agent-sandbox for the duration. Run it from this host with `export KUBECONFIG=~/.cluster.yaml`. Target worker `debian-k3s-3` (VM on physical host `jerry-3`). Make sure `adm-lifecycle` isn't on that node (`kubectl -n adm-system get pod -o wide`). The spike Pods aren't labelled `app.kubernetes.io/managed-by=adm`, so ADM's own `node_failover_loop` leaves them alone.

1. Install:
   `kubectl apply --server-side -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.9/sandbox-with-extensions.yaml && kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller`
   Check the controller isn't on `debian-k3s-3`. If it is, `kubectl -n agent-sandbox-system delete pod -l app=agent-sandbox-controller` until it lands elsewhere.
2. Create the namespace, ServiceAccount, ConfigMap and NetworkPolicy from the appendix, then the Sandbox from the appendix with `nodeSelector: {kubernetes.io/hostname: debian-k3s-3}` added under `podTemplate.spec`. Wait until it's Ready:
   `kubectl -n adm-spike-89 wait sandbox/node-test --for=condition=Ready --timeout=300s`
3. Write a marker: `kubectl -n adm-spike-89 exec node-test -c dev -- sh -c 'date > /workspace/marker && sync'`
4. Start recording in a second terminal:
   `kubectl -n adm-spike-89 get sandbox,pod -o wide -w --output-watch-events | ts` and, in a third, `kubectl get volumeattachment -w | ts`
5. Note the time and **hard power off the `debian-k3s-3` VM on jerry-3** (pull power, not a shutdown).
6. Expect, and note the times:
   - node `NotReady` at ~40 s;
   - Sandbox `Ready=False` at about the same time;
   - Pod `Terminating` at ~5 min 40 s (taint eviction);
   - **no replacement Pod, indefinitely**. `kubectl -n adm-spike-89 get events -w` should show no `SandboxPodCreated`.
7. Simulate today's ADM/TASK-91 action: remove the selector with `kubectl -n adm-spike-89 patch sandbox node-test --type=json -p '[{"op":"remove","path":"/spec/podTemplate/spec/nodeSelector"}]'`, then `kubectl -n adm-spike-89 delete pod node-test --force --grace-period=0`. Expect a new Pod on another node, stuck in `ContainerCreating` with `Multi-Attach error`, until the VolumeAttachment for the dead node is force-detached (~6 min).
8. Optional, the TASK-91 alternative: repeat steps 2–6, and in step 7 run `kubectl taint node debian-k3s-3 node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` instead of force-deleting. Record how long until the old Pod is gone, the VolumeAttachment is gone, and the new Pod is Ready.
9. Check the data survived: `kubectl -n adm-spike-89 exec node-test -c dev -- cat /workspace/marker`.
10. Power `debian-k3s-3` back on. Remove the taint if set (`kubectl taint node debian-k3s-3 node.kubernetes.io/out-of-service-`). Clean up:
    `kubectl delete ns adm-spike-89 --wait` (then wait until `kubectl get pv | grep adm-spike-89` is empty), and
    `kubectl delete -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.9/sandbox-with-extensions.yaml`.

## Appendix: the hand-written Sandbox

The namespace objects (apply first):

```yaml
apiVersion: v1
kind: Namespace
metadata: {name: adm-spike-89}
---
apiVersion: v1
kind: ServiceAccount
metadata: {name: adm-runtime, namespace: adm-spike-89}
automountServiceAccountToken: false
---
apiVersion: v1
kind: ConfigMap
metadata: {name: workspace-runtime, namespace: adm-spike-89}
data:
  workspace.json: '{"id":"spike89000000000","name":"spike","role":"coding","environment":"pod","model":{"provider":"anthropic","id":"claude-sonnet-4-5"},"localRoot":"/workspace","cwd":"/workspace"}'
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: workspace-isolation, namespace: adm-spike-89}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress:
  - from:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: adm-system}}
      podSelector: {matchLabels: {app.kubernetes.io/name: adm-lifecycle}}
    ports: [{protocol: TCP, port: 7432}]
  egress:
  - to: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}}]
    ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]
  - to: [{ipBlock: {cidr: 0.0.0.0/0, except: [10.42.0.0/16, 10.43.0.0/16, 169.254.0.0/16]}}]
```

The Sandbox. For the warm-pool test, the same `podTemplate`, `volumeClaimTemplates`, `service` and `failedPodPolicy` went into a `SandboxTemplate` with `networkPolicyManagement: Unmanaged`, a `SandboxWarmPool` with `replicas: 2`, and `SandboxClaim`s carrying only `additionalPodMetadata.labels`.

```yaml
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata: {name: node-test, namespace: adm-spike-89}
spec:
  service: true
  failedPodPolicy: Recreate
  volumeClaimTemplates:
  - metadata: {name: work}
    spec: {accessModes: [ReadWriteOnce], storageClassName: adm-replicated, resources: {requests: {storage: 4Gi}}}
  podTemplate:
    metadata:
      labels: {adm.dev/workspace-id: spike89000000000, adm.dev/role: coding}
    spec:
      serviceAccountName: adm-runtime
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 30
      initContainers:
      - name: initialize
        image: ghcr.io/nwylynko/agentic-dev-machines/adm-workspace:sha-69405b575918
        command: [/usr/local/bin/adm-init-workspace, repositories]
        securityContext: {runAsUser: 0}
        volumeMounts: [{name: work, mountPath: /workspace}]
      containers:
      - name: dev
        image: ghcr.io/nwylynko/agentic-dev-machines/adm-code:sha-69405b575918
        workingDir: /workspace
        ports: [{name: http, containerPort: 7432}]
        securityContext:
          runAsUser: 1000
          runAsGroup: 1000
          runAsNonRoot: true
          allowPrivilegeEscalation: true
          capabilities: {drop: [ALL], add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, AUDIT_WRITE]}
          seccompProfile: {type: RuntimeDefault}
        resources: {requests: {cpu: 100m, memory: 128Mi}, limits: {cpu: "2", memory: 2Gi}}
        env:
        - {name: ADM_LIFECYCLE_URL, value: "http://adm-lifecycle.adm-spike-89.svc.cluster.local:7433"}  # unreachable on purpose
        - name: ADM_POD_UID
          valueFrom: {fieldRef: {fieldPath: metadata.uid}}
        volumeMounts:
        - {name: work, mountPath: /workspace, mountPropagation: HostToContainer}
        - {name: shm, mountPath: /dev/shm}
        - {name: runtime-config, mountPath: /run/adm, readOnly: true}
        - {name: runtime-token, mountPath: /var/run/secrets/kubernetes.io/serviceaccount, readOnly: true}
        readinessProbe: {httpGet: {path: /health, port: 7432}, initialDelaySeconds: 1, periodSeconds: 2}  # ADM uses /ready (needs a lease)
      - name: repositories
        image: ghcr.io/nwylynko/agentic-dev-machines/adm-repositories:sha-69405b575918
        command: [/usr/local/bin/adm-repositories, serve, --state, /workspace/.adm/repositories, --git-root, /workspace/.adm/git, --views, /workspace/.adm/views, --mount, /workspace/.adm/catalog, --uid, "1000", --gid, "1000", --artifact-fs, /usr/local/bin/artifact-fs]
        securityContext: {privileged: true, runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true}
        env: [{name: ADM_LIFECYCLE_URL, value: "http://adm-lifecycle.adm-spike-89.svc.cluster.local:7433"}]
        resources: {requests: {cpu: 50m, memory: 128Mi}, limits: {memory: 512Mi}}
        volumeMounts:
        - {name: work, mountPath: /workspace, mountPropagation: Bidirectional}
        - {name: runtime-token, mountPath: /var/run/secrets/kubernetes.io/serviceaccount, readOnly: true}
      volumes:  # "work" is injected by the controller from volumeClaimTemplates (PVC work-<sandbox>)
      - {name: shm, emptyDir: {medium: Memory, sizeLimit: 256Mi}}
      - name: runtime-config
        configMap: {name: workspace-runtime, items: [{key: workspace.json, path: workspace.json}]}
      - name: runtime-token
        projected: {sources: [{serviceAccountToken: {audience: adm-lifecycle, expirationSeconds: 3600, path: token}}]}
```
