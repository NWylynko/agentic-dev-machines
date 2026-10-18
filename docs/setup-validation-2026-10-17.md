# Automatic setup validation — 2026-10-17

Automatic controller setup, authenticated CLI access, and one disposable
workspace lifecycle passed on the homelab cluster. This records the tested
image and manifest combination; the earlier [validation snapshot](validation-2026-10-17.md)
contains the preceding fixture/container evidence.

## Tested configuration

| Component                  | Verified version or state                                                 |
| -------------------------- | ------------------------------------------------------------------------- |
| Installed CLI and manifest | Published release `sha-c66dfb369efd`                                      |
| Final controller image     | `ghcr.io/nwylynko/agentic-dev-machines:sha-c66dfb369efd`                  |
| Workspace acceptance image | `ghcr.io/nwylynko/agentic-dev-machines:sha-401109007eb8`                  |
| Runtime image digest       | `sha256:aca9001f401866daff6f35d4b9d4f77ce81e731f00c3f9b3a8264407d4c6267a` |
| Controller                 | `adm-system/adm-lifecycle`, 1/1 Ready on `debian-k3s-2`                   |
| Host connection            | `adm-lifecycle-forward.service` active in the systemd user manager        |

The [final release](https://github.com/NWylynko/agentic-dev-machines/releases/tag/sha-c66dfb369efd)
passed CI and was installed on the management host. Both image tags above
resolve to the same digest: the final change corrected deployment manifests
and their container check, leaving runtime image contents unchanged.

The downloaded release archive's checksum was verified, along with its
correct kubeconfig path, release-pinned controller images, and token mode
`0440`. Setup, listing, and doctor were then run successfully from `/tmp`
using the installed CLI. The connection unit's executable points into the
checksum-addressed installation instead of the checkout.

The previous unmanaged CLI was preserved at
`~/.local/bin/adm.before-setup-fix-20261017` before installing the managed release.

## Live checks

- `adm setup` completed controller rollout and authenticated API verification,
  then saved nonsecret connection settings using the selected host kubeconfig.
  The internal credential remained in Kubernetes; no default client-token file
  was needed.
- `adm list` returned an empty directory and `adm doctor` reported lifecycle
  status `ok` through the supervised host connection.
- Created `adm-setup-check-c66dfb3` with a 1 GiB claim, 500m CPU, and 1 GiB
  memory. Workspace ID `90e7796169e8490899678d33f8be0e57` owned namespace
  `adm-90e7796169e84908`.
- Creation completed in approximately 21 seconds. Its Pod was Ready on
  `debian-k3s-2`; runtime readiness was healthy and agent state was `needs_model`.
- A real `adm exec` Python process confirmed UID 1000 and wrote a file under
  the workspace's private `/repos` directory.
- `adm destroy --wait` completed in approximately 20 seconds. The workspace
  namespace was absent, the directory was empty again, and the controller
  remained 1/1 Ready.

No credential values, kubeconfig contents, or private file contents are
included in this record.

## Regression and fixture checks

Two startup failures discovered during installation are fixed:

- Kubernetes Lease `acquireTime` and `renewTime` require six fractional digits.
  The lifecycle process test first failed with a matching BadRequest, then
  passed with `.000000Z` timestamps. It exercises periodic renewal, expiration,
  competing ownership, and restart recovery. Actual Kubernetes server dry runs
  rejected the previous timestamp format and accepted the corrected one.
- The kubeconfig ConfigMap projects its `config` key at `/etc/adm/config`.
  The manifest now selects that path. An offline container test mounts the
  manifest's real projection and uses the image's actual kubectl to read its
  selected API server; it failed before the path correction and passed after it.

The complete Rust suite passed 50 tests; Clippy with warnings denied and the
TypeScript checks passed. Installer tests passed 9 checks, publication tests
passed 10, and the real release archive test passed. The archive check includes
the pinned deployment images and preservation of Kubernetes token-file mode
`0440`.

The full Docker smoke also passed against the existing local
`adm-dev:verify-0f5a372` image, including the new kubeconfig projection check.
That image is older than the published image used for the live checks above.

## Limits

The live workspace had no selected model and made no provider request. This run
does not establish provider login/refresh behavior, live Herdr event delivery,
workspace Pod replacement, unattended work during management-host loss,
cross-node recovery, or sudden-node-loss durability. Both tested Pods ran on
one node. The storage loss window remains unchosen.
