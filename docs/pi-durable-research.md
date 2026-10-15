# Pi Durable integration research

Research date: 2026-10-14. Source snapshot: [earendil-works/pi at b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6][revision], whose Durable package identifies itself as version 1.2.0. The source package is **packages/durable**; its published name is **@earendil-works/pi-durable**. The API is explicitly experimental. Findings below distinguish source-verified behavior from integration proposals and unresolved questions. [Package manifest][package]; [upstream README][readme].

The pinned main-branch snapshot includes unreleased fixes after the 1.2.0 release; it is not identical to that published artifact. Source findings refer to this commit, while the local behavioral checks below exercised the published npm 1.2.0 package. [Changelog][changelog].

## Recommendation

**Proposal:** build the service around Pi Durable's harness, with one supervised owner of each Herdr-owned store and a reconnectable terminal client. Start by putting a coding runner beside its development runtime and persisting its repository work and SQLite store on portable storage. This avoids inventing a remote execution adapter before proving the core workflow. Give bots a different capability profile, no repository mount, and an explicit owning space. Bot placement and whether it shares a space with a coding agent remain product decisions.

**Verified:** Durable supplies persisted conversations, checkpointed tasks, transactional application documents, role-specific tool configuration, and subscriptions to committed state. Its execution-environment interface allows the harness and development tools to run separately later. It does not supply our Kubernetes lifecycle manager, repository filesystem, cross-node storage replication, or Herdr integration. [Public harness][harness]; [environment contract][env]; [per-conversation example][sandbox-example].

The main integration gate is the terminal: do not equate ordinary Pi's resumable sessions or RPC mode with a terminal client attached to a Durable owner. The pinned coding-agent entry point creates an AgentSession and selects its normal interactive or RPC runtime. Durable exposes a separate harness API. [Pi entry point][pi-main]; [Durable API][harness-types]. The launch article references experimental terminal demos, but the pinned tree contains only source-resolver.ts under that experimental directory, so those historical paths do not establish a currently shipped attachment client. [Launch article][launch]; [pinned experimental tree][pi-experimental].

## What recovery actually guarantees

| Source-verified behavior | Consequence for this project |
| --- | --- |
| Session commits atomically combine transcript entries, task records, and document changes; observable state follows the stored commit. | Keep a goal, its task reference, and its visible record in the same commit where appropriate. This transaction does not encompass repository files or external services. [Session implementation][session]; [normative specification][spec]. |
| Opening a harness reconciles surviving running tasks to pending while preserving checkpoints. Scheduling starts with resume(), or operations that request progress. Read-only observation does not start it. | The supervised owner must explicitly resume after restart; reconnecting a viewer cannot be the recovery trigger. [Harness][harness]; [scheduler][scheduler]; [public API][harness-types]. |
| A generation persists its request phase and retries from that phase after interruption. Committed partial model output is retained as an aborted assistant entry. | Recovery can repeat a model request. It does not resume a live provider stream or shell process. [Generation task][generation]. |
| Tool intent and final arguments are committed before execution. After interruption, replay requires both the stored policy and current implementation to declare replay safe. Other calls produce an interruption result describing possible partial execution. | Keep arbitrary shell commands and external writes unsafe unless their effect can be recovered or deduplicated. A safe flag is a promise made by our tool, not an inferred guarantee. [Tool task][tool]. |
| requestId deduplicates submissions within a conversation. Nested calls can reuse durable identities/results when a replay-safe parent repeats the same keys. | Use stable request IDs for client retries and bot prompts. This does not make arbitrary external effects exactly once. [Submission implementation][submissions]; [nested tool calls][tool]. |
| Missing task definitions or incompatible task versions block pending work; definitions can migrate older checkpoints. | Pin the runner's extension/task bundle, reinstall it before resuming, and exercise upgrades against old stores. [Scheduler][scheduler]; [task contract][types]. |

**Proposal:** treat external effects separately. A sendMessage or promptAgent tool should atomically record a stable operation identity and intended message, then deliver using that identity where the destination supports deduplication. After a crash between delivery and recording success, reconcile rather than blindly send again. Retrying an input submission and delivering an external message are different operations.

## Storage and ownership

| Backend | Verified properties | Assessment |
| --- | --- | --- |
| Memory | State lives in process memory. [Memory backend][memory]. | Useful for tests, unsuitable for required recovery. |
| Node SQLite | Uses SQLite WAL, synchronous NORMAL, serialized transactions, and a checkpoint on clean close. [Node adapter][sqlite-node]. Upstream documents process-crash survival with possible loss of newest commits after host/power failure. [Storage documentation][readme]. | Best first candidate for long-running sessions; still needs portable storage and failure tests. |
| JSONL | A directory contains a main commit log and task/document sidecars. Optional fsync defaults to false; the implementation also reconstructs an in-memory store. [JSONL backend][jsonl]. | Not interchangeable with ordinary Pi's session JSONL; memory growth and log handling make it less attractive here. |
| Cloudflare Durable Object SQLite | An adapter uses storage.sql and storage.transaction through an asynchronous SQLite facade. [DO adapter][sqlite-cloudflare]. | Verifies a Cloudflare adapter exists; does not prove celld compatibility. |
| Custom | A backend must implement atomic writes, persistent ID allocation, scans, documents, and submission lookup; SQLite adapters must also serialize unrelated operations around transactions. [Storage contract][types]; [SQLite facade][sqlite-database]. | Possible, but not needed for the first proof. |

**Verified:** the upstream storage contract requires one owning process and explicitly provides no cross-process locking. SQLite's file locks are not ownership of the harness scheduler. [Storage documentation][readme].

**Proposal:** one active writer per store; clients attach to that writer. Replacement must establish that the previous writer cannot still execute tools or mutate the store. A single-replica Deployment is insufficient evidence by itself: test replacement and loss of node connectivity. Keep the development filesystem private to its workspace and recover repository state alongside the corresponding agent store.

**Verified storage constraint:** SQLite documents that WAL does not work over network filesystems, and that the WAL is part of the database's persistent state. Do not place the default adapter's live database on an arbitrary NFS mount or recover by copying only a live .sqlite file. The initial storage candidate should present a local filesystem to its single owner, with safe movement/replication supplied underneath, or use a separately validated backend. [SQLite WAL documentation][sqlite-wal]; [Node adapter][sqlite-node].

**Unknown:** the acceptable end-to-end loss window is not the model-output flush interval. It depends on the volume, SQLite/WAL behavior, repository persistence, and replication/checkpoint policy. Neither a copied database filename nor a functioning process-crash test proves recovery after losing its node. The actual storage backend and its consistency guarantees remain unselected.

## Goals, loops, and ownership

**Verified:** extensions can define checkpointed task state machines and typed application documents. Tasks expose durable commits and a sleep(until) operation. The sleep implementation waits in the current process; recovery reruns a task phase from its saved checkpoint. [Task/document contracts][types]; [document definitions][documents]; [scheduler sleep][scheduler].

**Proposal:** persist a loop's absolute next trigger, progress, and pending submission identity in a document/checkpoint before waiting. Use a background task owned by the bot's conversation for recurring work, rather than an untracked JavaScript timer. On restart, the same task reads the saved deadline and decides whether to run or skip an overdue invocation. Recurrence rules, events, and missed-trigger policy are ours to define; no ready-made goals/cron product was established by this review.

**Verified:** background tasks are outside ordinary conversation abort and idle waits. Passing background: true to conversation abort crosses those boundaries for the work reached when abort is admitted. Work created afterward is not included. Task/conversation ownership controls cancellation traversal; it is not an authorization boundary. [Abort options][harness-types]; [scheduler abort][scheduler]; [ownership specification][spec].

**Proposal:** use this distinction deliberately: Esc may stop current work without deleting tomorrow's loop, whereas removing the owning Herdr space must revoke admission and stop all owned activity. A bot's permitted control link to a coding agent should not automatically make the coding agent task-owned by a short-lived monitoring call.

## Destruction is different from shutdown

**Verified:** close stops invocations and closes storage without recording tasks as deliberately aborted. Pending work remains recoverable. Ordinary abort withdraws queued inputs but leaves queued writes, and does not itself permanently reject future input. The inspected public Durable Conversation and Storage interfaces do not expose conversation/history deletion. Reset and compaction change model context rather than removing stored transcript history. [Session close][session]; [abort API][harness-types]; [storage interface][types]; [reset/compaction implementation][compaction].

**Proposed removal sequence:**

1. Persist deletion against the immutable workspace identity in lifecycle state that older agent/repository snapshots cannot override. Immediately stop new client, bot, scheduling, and tool admissions.
2. Revoke that workspace's bot control links and runtime tool access; abort every owned conversation with background work included.
3. Wait for cooperative cleanup. If code ignores cancellation, terminate its isolated worker/process before allowing any replacement owner.
4. Remove its runtime, private repository state, and preview routes. Apply the chosen history retention policy separately; retained history must not schedule work.
5. Retry interrupted cleanup. Reusing the display name creates a new identity, so old messages and loops cannot attach to it.

The need to handle non-cooperative code is source-verified: closing joins active invocations, so ignored cancellation can hold close open; upstream directs hosts to process/worker isolation for forced termination. [Shutdown specification][spec]. The deletion protocol above is our design, not a built-in Durable delete API. History retention/defaults remain undecided.

## Repository isolation and the bot role

**Verified:** per-conversation environments are looked up from conversation state, and the built-in coding tools perform operations through that environment. A NodeExecutionEnv working directory is not a filesystem jail: path resolution accepts absolute paths and parent traversal. The example that assigns different directories illustrates routing, not hostile-workload isolation. [Environment resolver][harness]; [Node filesystem implementation][node-env]; [example][sandbox-example].

**Proposal:** put coding execution behind its own container filesystem, mounts, and credentials. A conversation ID or cwd must not grant access to neighboring workspaces. Sharing immutable upstream Git objects does not mean sharing mutable refs, indexes, unpushed work, or agent history. Durable does not implement our lazy repository catalog or Git overlay; those remain separate work.

**Verified:** tools selects enabled capabilities, while modelTools only controls which are offered directly to the model. Nested tools/Code Mode resolve against enabled callable tools. Newly created task-owned conversations can inherit the parent's configuration. [Agent resolver][agent]; [conversation creation][harness]; [nested call resolution][tool].

**Proposal:** bots receive an explicit permitted tool/extension list, no repository mount and no coding environment. Permit only their selected supervision, messaging, goal, and loop operations. Enforce target-agent authorization inside control tools. Do not rely on hiding tools, a system prompt, or a bot creating its own child conversation to preserve this boundary.

**Verified:** Durable includes Code Mode, using replay-safe nested tool calls and a deterministic sandbox journal. Its model-helper tools are included by default unless models: false is selected. The underlying sandbox exposes no intrinsic I/O or timers; available host tools remain the capability boundary. [Durable Code Mode][codemode]; [sandbox contract][codemode-readme].

**Proposal:** start bot Code Mode with models: false and a small explicit tool list. This avoids adding auxiliary model operations before they are wanted. A repository-free bot can compute and compose tools without a development filesystem; do not give it coding access merely to support scripts.

## Terminal attachment, messages, and authentication

**Verified:** Durable offers viewState/watch and coding-agent-style watchEvents with an initial snapshot and subsequent committed updates. These are integration surfaces, not a transport or Herdr client. Pi publicly exports terminal message/tool components, while its pinned CLI runs the ordinary coding-agent runtime. [Conversation view][view]; [event adapter][events]; [Pi CLI][pi-main]; [exported UI components][pi-index].

**Proposal:** build the smallest reconnectable Pi-style adapter first, reusing UI components where they fit. Closing that adapter must only detach. The bot conversation renderer should publish only explicit application message entries committed by sendMessage, while model responses, thinking, tool output, and diagnostics remain available in a separate inspection view. Reattachment reconstructs published messages from committed records; it must not replay them as new notifications.

**Verified caveat:** ConversationView includes the active transcript, whose head changes with reset/compaction; entries can also carry an application-specific kind without model content. [View implementation][view]; [entry definitions][entries]. **Proposal:** maintain the bot's published timeline from all of its published entries or a durable projection, rather than rendering the raw active view. A model handoff must not erase earlier delivered messages from the user-facing conversation.

**Verified:** the current Pi providers implement subscription OAuth paths for ChatGPT/Codex and Claude; the model layer accepts a credential store. This is implementation support, not a live verification of Nick's accounts or provider terms. [OpenAI provider][openai]; [legacy Codex provider][openai-codex]; [Anthropic provider][anthropic]; [model runtime][model-runtime].

**Proposal:** reuse that account/provider plumbing where compatible, expose authentication/allowance failures clearly, and preserve pending work. Do not silently substitute an API key, billing method, or provider. Account compatibility, unattended refresh, provider choice, and numeric limits still require validation and user decisions.

Credential placement is also unresolved. A colocated runner is the minimum recovery proof, not proof that model credentials are isolated from a coding tool with filesystem/process access. Determine that boundary before using real accounts; remote tool execution or a separate worker may be appropriate, but neither topology is selected here.

## Local behavioral checks

The research team ran credential-free checks against the published @earendil-works/pi-durable 1.2.0 package on Node v24.18.0: **6 passed, 0 failed across two suites**. The scripts remain temporary research artifacts, not a repository test suite.

The process/task suite ran with node behavior.test.mjs in /tmp/adm-pi-durable-probe: **2 passed, 0 failed**. Sources: [local test](/tmp/adm-pi-durable-probe/behavior.test.mjs) and [child process](/tmp/adm-pi-durable-probe/checkpoint-child.mjs).

- A real SIGKILL during a task effect followed by a fresh SQLite open preserved the checkpoint and memo, changed running to pending, and did no work before resume. Recovery repeated the unfinished effect; the earlier phase ran once. A third open observed the terminal receipt without rerunning it. This matches the source's checkpoint/effect boundary and demonstrates why external effects need reconciliation or idempotency. [Task scheduler][scheduler]; [effect contract][spec].
- Ordinary conversation abort stopped foreground work while preserving its background task. Close/reopen preserved that task for resume. Abort with background: true stopped it durably; another reopen did not run it. [Abort options][harness-types]; [scheduler abort][scheduler].

The tool-policy suite ran with node tool-replay.test.mjs in the same directory: **4 passed, 0 failed**. It used the built-in synthetic fauxProvider and graceful harness close/reopen around an interrupted tool. Default/default policy executed once and returned an interruption result retaining partial output/details; safe/safe executed twice and succeeded; safe-to-unsafe and unsafe-to-safe changes each executed once and returned interruption. These cases verify that both stored and current policies must permit replay. Source: [local tool test](/tmp/adm-pi-durable-probe/tool-replay.test.mjs); [upstream replay implementation][tool].

Only the custom-task case used a real SIGKILL. These checks used one host and local SQLite/database-WAL state. They did not test SIGKILL during model generation or tool execution, Kubernetes, TUI attachment, real providers, node loss, power failure, storage replication, or competing owners.

## Validation gates before choosing the integration

These are the remaining integration gates. The local checks above establish task restart/cancellation and tool replay policy, but do not complete these platform experiments:

| Gate | Evidence required |
| --- | --- |
| Terminal attachment | A Herdr terminal attaches to the Durable owner, submits and steers input, disconnects, and reconnects to the same ongoing run without restarting it. |
| Real restart | Extend the verified custom-task SIGKILL and graceful tool-replay checks to kill the owner during generation and tool execution; reopen without a client and verify automatic recovery. |
| External effects | Crash after an effect but before its result commit; demonstrate that messages and bot prompts reconcile or deduplicate rather than being blindly repeated. |
| Ownership/fencing | Attempt replacement while the old owner remains alive or isolated from control; prove only one can execute and write. |
| Scheduled work | Create a bot goal/loop, restart before its deadline, then restart after a missed deadline; verify the selected catch-up rule and cancellation. |
| Destruction | Remove a space during a running tool and sleeping loop, interrupt cleanup, and recover. Nothing may resume; reusing the label must not capture old work. |
| Isolation | Two coding workspaces edit main independently; attempts at another workspace's files fail. A bot cannot invoke coding tools directly, through Code Mode, tool discovery, or child conversations. |
| Silent bot | Ordinary responses, thinking, and tools never appear in its chat. sendMessage appears once, including disconnect/restart around delivery. |
| Storage loss | Test planned drain separately from abrupt node loss; measure repository/history divergence, interruption, and recent loss on the chosen storage. |
| Browser and ports | Browser automation uses the intended workspace, MacBooks open its site/port, replacement resolves the current runtime, and destruction removes access. |
| Authentication | Use the actual selected account flow, refresh after restart, and expose expired/exhausted authentication without losing queued work or changing billing. |

## Remaining decisions and limits

Source inspection supports a focused Durable integration, but does not settle terminal compatibility, storage topology, node-independent persistence, celld compatibility, bot-space ownership, loop catch-up rules, history retention, provider terms, or account behavior. Browser tools, preview transport, lazy Git storage, and Kubernetes reconciliation remain application responsibilities. A local harness restart probe is useful evidence for task recovery; it cannot establish those platform guarantees.

[revision]: https://github.com/earendil-works/pi/tree/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6
[launch]: https://earendil.com/posts/pi-durable/
[pi-experimental]: https://github.com/earendil-works/pi/tree/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/coding-agent/src/experimental
[package]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/package.json
[changelog]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/CHANGELOG.md
[readme]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/README.md
[harness]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/harness.ts
[harness-types]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/types.ts
[types]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/types.ts
[spec]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/docs/spec.md
[session]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/session/session.ts
[scheduler]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/scheduler.ts
[generation]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/generation.ts
[tool]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/tool.ts
[submissions]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/submissions.ts
[compaction]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/compaction.ts
[documents]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/documents.ts
[memory]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/storage/memory.ts
[sqlite-node]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/storage/sqlite/node.ts
[sqlite-wal]: https://sqlite.org/wal.html
[sqlite-cloudflare]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/storage/sqlite/cloudflare.ts
[sqlite-database]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/storage/sqlite/database.ts
[jsonl]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/storage/jsonl/storage.ts
[env]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/env/index.ts
[node-env]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/env/node.ts
[sandbox-example]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/test/examples/29-sandbox-per-conversation.ts
[agent]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/agent.ts
[codemode]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/codemode/codemode.ts
[codemode-readme]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/codemode/README.md
[view]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/view.ts
[entries]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/entries.ts
[events]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/durable/src/harness/events.ts
[pi-main]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/coding-agent/src/main.ts
[pi-index]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/coding-agent/src/index.ts
[openai]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/ai/src/providers/openai.ts
[openai-codex]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/ai/src/providers/openai-codex.ts
[anthropic]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/ai/src/providers/anthropic.ts
[model-runtime]: https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/coding-agent/src/core/model-runtime.ts
