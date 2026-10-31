# Workspace storage

`adm create` looks up a Kubernetes StorageClass before it records a coding workspace. The default name is `adm-replicated`. A class whose provisioner is `rancher.io/local-path` is refused unless you pass `--allow-node-local-storage`, because a volume stuck on one node cannot come back on another.

No storage backend is selected. Create a StorageClass with that name using a replicated provisioner you operate (Longhorn is one candidate, not a requirement). The class has to honor the filesystem the workspace actually uses: the repository catalog mounts FUSE, and the runner keeps agent history in SQLite with WAL enabled. Treat an arbitrary NFS mount as not ready for that WAL store. The loss window after a node dies has not been measured; do not describe the volume as crash-proof.

Example shape, with the provisioner filled in for your cluster:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: adm-replicated
provisioner: example.provisioner.invalid
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

Point `adm create --storage-class` at a different class when the default name is wrong. Destroying a workspace deletes its namespace and claim; it does not delete the StorageClass.

Run `adm doctor` to inspect `adm-replicated`, or `adm doctor --storage-class local-path` to inspect the existing class without creating a workspace. A reported class is not proof of replication; the diagnostic names its provisioner and flags the known node-local provisioner explicitly.

## Shared repository bases (ReadWriteMany)

Each registered repository (`adm repos clone`) is stored once, as a bare clone called its *base*. Bases live on one volume, the `adm-repository-bases` PersistentVolumeClaim in `adm-system` (20Gi, ReadWriteMany). It uses the same StorageClass as the lifecycle state. The lifecycle Pod mounts it read-write at `/var/lib/adm-repository-bases`. Every coding workspace with the repositories sidecar mounts it **read-only** at the same path, through its own PersistentVolume `<namespace>-repository-bases` that points at the same CSI volume handle, because a claim cannot be mounted from another namespace. The sidecar clones each repository against its base (`git clone --reference`), so a file read in many workspaces is stored once, while each workspace's edits, branches and commits stay on its own volume.

The StorageClass must support ReadWriteMany. If it does not, the bases claim never binds, the lifecycle Pod cannot start, and `adm setup`/`adm update` say so and quote the claim's last event.

Longhorn serves ReadWriteMany through NFSv4: a `share-manager-<pv>` Pod per volume, and the kubelet on each node mounts it with the host's NFS client. Every node needs an NFSv4 client (`nfs-common` on Debian). On the homelab cluster (Longhorn v1.13.0, Debian 13), `adm-replicated` already worked unchanged when checked on 2026-10-31: one RWX volume, written from debian-k3s-1, was mounted read-only from a second namespace on debian-k3s-2 and debian-k3s-3 (`nfs4 ro`), writes there failed with `Read-only file system`, and deleting a reader's PersistentVolume (`Retain`) left the data in place.

Removing a repository takes it out of `/repos` straight away. Its base is deleted once no live workspace that opened it remains, because those clones link to the base for good. Bases are never garbage-collected (`gc.auto=0`). Running `adm repos clone OWNER/REPO` again fetches new commits into the base. That only adds objects, so no workspace's checkout moves.
