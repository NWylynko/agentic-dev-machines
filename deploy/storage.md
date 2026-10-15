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
