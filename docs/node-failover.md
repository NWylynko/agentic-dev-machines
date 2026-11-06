# Node failover (TASK-82, TASK-91)

What happens when one node dies, and how to test it live.

## Design

- **Workspaces ride out a lifecycle outage.** A runtime holds a 300 s lease and only stops on a rejection (403, fence changed) or when the lease runs out. A lifecycle that is unreachable for under 5 min stops no workspace; new input waits for it.
- **`adm-failover`** (`src/failover.rs`, `adm failover-serve`, Deployment `adm-system/adm-failover`) does node failover outside the lifecycle, so recovery never depends on the thing being recovered. 2 replicas with required anti-affinity across nodes, no PVC, no lock. Every 10 s each replica:
  1. lists nodes; a node whose `Ready` condition has not been `True` for ≥180 s is down;
  2. force deletes (`--grace-period=0 --force --ignore-not-found`) every Pod on a down node that is an ADM workspace Pod (`app.kubernetes.io/managed-by=adm` with `adm.dev/workspace-id`) or the lifecycle Pod (`app.kubernetes.io/name=adm-lifecycle` in the lifecycle namespace). Deployments then schedule replacements on healthy nodes;
  3. deletes the down node's VolumeAttachments whose PV is claimed from the lifecycle namespace or an ADM workspace namespace, so the CSI driver attaches the RWO volume on the new node instead of waiting ~6 min (or forever, for the lifecycle). Non-ADM Pods and volumes are never touched.
  Both replicas sweeping at once converge on the same result. Every action is logged with the workspace ID or `adm-lifecycle`, node, PV and seconds since NotReady: `adm system-log --service failover`.
- **Lease revocation on move.** When a runtime claims a lease held by another Pod, the lifecycle lists the workspace's Pods; if the holder's Pod no longer exists (force deleted by adm-failover, evicted, `kubectl delete pod`) it revokes the old holder (`runtime_lease_revocations`) and grants the claim at once. The old holder, if it is still alive behind a partition, gets 403 on its next renewal and stops. While the old Pod still exists the claim stays 403.
- RBAC: `adm-failover` may get/list nodes, namespaces and PVs, get/list/delete Pods and VolumeAttachments. The lifecycle no longer reads nodes or deletes Pods.
- `adm setup` and `adm update` apply the Deployment with the controller image.

## Known costs

- A runner cut off from the lifecycle but still alive (network partition, not a dead node) keeps acting for up to 5 min after its workspace has been moved: pushing commits, calling providers. Its volume is detached, so it cannot corrupt the workspace's files, and the moved Pod owns the lease.
- If both adm-failover replicas and the lifecycle are on nodes that die at once (two nodes lost on a three-node cluster), nothing moves until a node returns.
- Detaching depends on the CSI driver honouring a deleted VolumeAttachment. Longhorn does; other drivers are untested.

## Live power-off test (Nick)

Not yet run. Needs a release with this change on the cluster (`adm update`).

1. Before: `kubectl -n adm-system get pods -o wide` — both `adm-failover` Pods Running on different nodes; note which node runs `adm-lifecycle`. Make sure at least one workspace is on that same node and at least one on another node (`kubectl get pods -A -l app.kubernetes.io/managed-by=adm -o wide`). In the workspace on the other node, start a long turn (e.g. a loop that prints for 15 min) and keep `adm attach` open on it.
2. Write a marker file and a message in a workspace on the doomed node, so you can check files and history after the move.
3. Note the time (T0) and power off the node running the lifecycle.
4. Watch, from the dev host:
   - `kubectl get nodes -w` — node goes NotReady (≈T0+40 s).
   - `adm system-log --service failover --follow` — at NotReady+180 s: `force deleting Pod adm-system/adm-lifecycle-… of adm-lifecycle`, `force deleting Pod … of workspace …`, `deleting VolumeAttachment … of PV …`.
   - `kubectl -n adm-system get pods -o wide -w` and `kubectl get volumeattachments -w`.
   - `adm list` / `adm doctor` while it is down: should explain the lifecycle is on a NotReady node and adm-failover is moving it.
5. Record:
   - time to lifecycle `Ready` (target: ≈5 min after T0);
   - time to each moved workspace `Ready`, and that the marker file and history survived (`adm attach`);
   - whether the workspace on the healthy node kept its turn running the whole time (target: uninterrupted); `adm system-log` should show no `held by another pod` crash loops and the lifecycle should log `revoked runtime lease of workspace … holder …` for each moved workspace;
   - anything left `Terminating` or attached to the dead node.
6. Power the node back on. Its old Pods must not take any workspace back (they were force deleted; any old runtime gets 403).
7. Write the numbers into this file and `docs/implementation-notes.md` under TASK-91.
