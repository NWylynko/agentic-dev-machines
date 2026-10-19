# Portable client validation — 2026-10-18

The Linux CLI was tested against the existing `sha-c66dfb369efd` controller and workspace image. The controller, installed services, and existing workspaces were left unchanged. These checks do not validate a rollout of the new shared-auth or update implementations.

Two clients used separate `XDG_CONFIG_HOME` directories. Each saved Kubernetes connection selectors with command-scoped forwarding enabled; neither saved a lifecycle bearer value or an ephemeral forwarding URL. Direct lifecycle URL/token-file environment overrides were removed for the tests. The CLI opened and closed its own connection for each command.

The first disposable workspace check passed creation, immutable-ID lookup from both clients, private-file writing and reading, status, independent reconnection, and `destroy --wait`. The workspace was `adm-client-proof-ec90f3d6`, ID `ae568dcdf19148e7a669ba230c1a83b4`.

A second check used the CLI from the October 18 batch after the create/Herdr and lifecycle foundation changes. It created two disposable workspaces using the synthetic `faux/faux-1` model:

| Purpose            | Workspace ID                       |
| ------------------ | ---------------------------------- |
| Agent turn         | `85680bb1d7a2413bb616b8dcff13417a` |
| Lifecycle deletion | `b6729174746b4484be8531c8b5c0ad9d` |

The first workspace's Pod-owned bash tool signaled that it had started, then waited on a FIFO. A client admitted deletion of the second workspace and exited. Both ADM clients and their command-owned forwards were closed while the tool remained active and namespace deletion completed. An independent Kubernetes observer then released the FIFO.

The second client reconnected and verified the private result file and the completed assistant answer in persisted history. The first client independently reconnected and observed the same ready/deleted workspace IDs. Both final `destroy --wait` calls passed, and both namespaces were confirmed absent. No commercial provider credentials were used.

The first attempt at this second check expected the receipt status `accepted`; the installed runtime returns `admitted`. That assertion was corrected after both first-attempt disposable workspaces were cleaned up.

Raw command records and scripts were stored under `/tmp/adm-batches-20261018/live-clients/` during the run. The October 19 environment restart removed that temporary directory; those raw files are no longer available. The observations and workspace IDs above are the retained record.

Native macOS/arm64 execution, live Herdr delivery and keyboard interactions, real shared-provider authentication, controller updates, Pod replacement, cross-node recovery, and node-loss durability remain outside these checks. The release matrix and fixture tests cover additional behavior but do not establish those live outcomes.
