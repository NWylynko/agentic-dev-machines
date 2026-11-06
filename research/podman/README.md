# Podman in workspaces — live probe, 2026-11-06

Question: can projects that use Docker for local dev run in an ADM coding workspace without letting the agent escape the workspace?

Probed on the homelab cluster (k3s v1.36.5, containerd 2.3.4, Debian 13 kernel 6.12) with the `adm-code` image, installing bookworm's Podman 4.3.1 at runtime. Test: `podman run alpine`, a two-service compose project (`app` reaches `db` by service name), and `-p 8080:80` nginx.

## Inside the current dev container: no

The dev container runs as uid 1000 with only CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID and AUDIT_WRITE, and RuntimeDefault seccomp, AppArmor `cri-containerd.apparmor.d` and host uids. Rootless Podman hits these, in order:

1. **seccomp** refuses `unshare(CLONE_NEWUSER)`. Unconfined seccomp fixes it; AppArmor plays no part here.
2. **setuid `newuidmap`** (Debian) gets EPERM writing `uid_map`: euid 0 is not the namespace owner and has no CAP_SYS_ADMIN. Fix: `chmod 0755` plus `setcap cap_setuid+ep` / `cap_setgid+ep`, as the upstream Podman images do. Adding SETFCAP alone did not help.
3. **AppArmor** refuses the mounts used to apply image layers (`remount /: permission denied`). Only Unconfined fixes it.
4. **No `/dev/net/tun`** for slirp4netns/pasta. A hostPath CharDevice works in a host-uid Pod.
5. **Masked `/proc`**: crun cannot mount a fresh `proc` (`mount proc: Operation not permitted`). The fix is `procMount: Unmasked`, which Kubernetes only allows with `hostUsers: false`.

So the dev container needs either `privileged` or a user-namespaced Pod. Privileged in a host-uid Pod gives the agent the node.

## User-namespaced workspace Pod (`hostUsers: false`): blocked by storage

User namespaces work on this cluster: a privileged container in a userns Pod starts, maps to an unprivileged host range (`0 2426077184 65536`), and sees `/dev/fuse` and `/dev/net/tun` as `nobody`. But every volume in a userns Pod is id-mapped, and the Longhorn RWX share behind `repository-bases` (NFS) refuses `MOUNT_ATTR_IDMAP`, so the Pod fails to start. hostPath devices fail the same way. Longhorn RWO (ext4) volumes map fine.

## Separate engine Pod: works

A second Pod with `hostUsers: false`, `privileged: true`, `procMount: Unmasked`, mounting only the workspace's RWO `work` volume (same node). It has no runtime token and no bases. Rootless Podman with:

- `~/.config/containers/storage.conf`: `driver="overlay"`, graphroot on the work volume (native overlay on ext4, no fuse-overlayfs)
- `containers.conf`: `network_backend="netavark"` (`netavark` + `aardvark-dns` packages; the CNI default has no service-name DNS)
- `newuidmap`/`newgidmap` with file caps, as in step 2

`podman run`, the compose project (service DNS, PONG) and a published port all passed. Bookworm's `podman-compose` 1.0.3 ignores `--abort-on-container-exit`.

Open design costs: published ports live in the engine Pod's network namespace, not the dev Pod's `localhost`; the dev container talks to Podman over a socket on the shared volume (`DOCKER_HOST`); the two Pods must be co-scheduled on one node for the RWO volume, which node failover then has to move together.
