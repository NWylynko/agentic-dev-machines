# Repository test disk-use measurement

`TestRepositoryFilesystem` reports allocated filesystem use at three points by running `du -sk` over each workspace's private repository `state` and `git` directories. It excludes the mounted `repos` catalog and `views` paths so measurement cannot open a repository or hydrate catalog content. The test still asserts that the unopened `untouched` catalog entry has no acquisition state.

One passing run on 2026-10-15 measured:

| Stage | Workspace A | Workspace B | Total |
| --- | ---: | ---: | ---: |
| After catalog listing, before opening a repository | 0 KiB | 0 KiB | 0 KiB |
| After the first `README.md` read in A | 320 KiB | 0 KiB | 320 KiB |
| After opening B, private Git changes in A, and remounting A | 1,136 KiB | 320 KiB | 1,456 KiB |

The fixture creates a local Git upstream with `README.md` containing `upstream\n` and a 524,288-byte `large.bin` made by repeating `0123456789abcdef`. It advertises two catalog entries pointing at that same upstream (`project` and `parallel`) plus an unavailable `untouched` entry. Workspace A reads `project` and `parallel`, changes and commits `project`, adds an untracked file and branch, and remounts it. Workspace B reads `project` and remains isolated. The reported final value includes these private state and Git directories, not FUSE view mounts.

The test uses `file://` transport and does not configure a shared upstream Git cache (`sharedBase=false` in the service logs). The large file is highly compressible. These figures therefore describe this fixture's private metadata and downloaded content on this test filesystem; they do not measure production repository sizes, deduplication or shared-cache savings, physical-node storage consumption, or an upper bound.

The passing run used Go 1.26.5, Git 2.47.3, GNU `du` 9.7, the pinned `artifact-fs` binary in `packages/repositories/ARTIFACTFS`, and `/tmp` on tmpfs. `du -sk` reports allocated 1 KiB blocks; on tmpfs this is a filesystem allocation measurement, not persistent disk use. Rerun the focused test in the documented FUSE-capable environment to collect measurements for another filesystem:

```sh
go -C packages/repositories test -v -run '^TestRepositoryFilesystem$' ./...
```
