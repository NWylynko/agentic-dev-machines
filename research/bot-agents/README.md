# Always-on bot agents — talk notes

Source: [YouTube — L1OBRtfPS34](https://youtu.be/L1OBRtfPS34). Lecture by Lee, who has worked on Cursor and now builds Grokbot at SpaceX/xAI. It's week two of a course; week one built a basic "model calls tools in a loop" harness.

These are summary notes, not a transcript. The captions were pulled from inside an `adm` workspace on the homelab cluster, because YouTube blocks cloud IPs.

## The thesis

A terminal harness stops when you close the laptop. An **always-on agent** ("bot") runs on a server and has its own Linux computer, its own memory and its own skills. It wakes up on events, not just prompts. It decides when to stay quiet, like a colleague would, rather than replying to every input. The target is work that runs for weeks or months, and that needs a different architecture.

He describes four eras: copy-pasting from ChatGPT → terminal coding agents → dedicated apps running many agents in parallel with a human approving every command → ambient bots. In the last era, people steer the agent mid-turn instead of queuing commands, and a second model ("auto review") approves commands. His claim is that auto review beats a fatigued human.

The model improvements behind this:

- instruction following that holds up over long runs (with compaction)
- sub-agents for fresh context
- reliable tool calling
- computer use
- file-based memory that the model can grep
- learning skills or routines from being shown how to do something

## Architecture

- **Triggers → router → server → computer.** Triggers include the user, Slack, email, meetings and finished background routines. A router dedupes them, merges them into the conversation, and decides whether to bother the user.
- **Sleep/wake.** Both the server-side agent and the VM sleep when idle. State (conversation, memories, routines) lives in a DB, so a turn can boot it back up. The VM only starts if the turn needs it.
- **Firecracker VM per agent.** It's cheap to snapshot, stop and restart. You can get a live view or take over yourself. Several bots each get their own virtual desktop and browser on shared infrastructure.
- **Agent loop on the server, not the VM.** This keeps a thin client and a thick server. You can ship agent updates without an app release and rebuild the VM (e.g. for a zero-day patch) without killing the loop or causing downtime.
- **Durable workflows, not job queues.** After a crash, a queued job replays steps 1–3. A durable workflow resumes at step 3. They use Temporal. Each sub-agent ("helper") is its own durable workflow.
- **Inbound priority.** The owner's direct message interrupts the current loop. Group chat, Slack and routine traffic go to the back of the queue, and bursts get batched into a single turn.
- **Client/server sync.** The server acks immediately, persists each turn, and pushes change signals to subscribed clients. Clients refetch and dedupe retries.

## Harness design

- **One client-facing tool: `send_to_user`.** Every client (mobile, desktop, email, Slack) speaks only this one tool. Each client renders it richly: sign-in forms, payment flows, draft-and-approve for irreversible sends, or just an emoji reaction. All the heavy tools stay on the server.
- **Dynamic tool discovery ("tool search").** Only tool names go into the context, and schemas load on demand. Connector tool definitions would otherwise eat the context window.
- **Escalation ladder, cheapest first:** conversation context → plugin/MCP/API → web search → browser on the VM → full desktop/scripts → ask the user last.
- **Getting info off the VM screen:** accessibility tree, then HTML, then screenshot, with pixel clicks for modals. Ask the user for 2FA or CAPTCHAs.
- **Orchestrator + helpers.** Keep the main agent's conversation sparse and push expensive work to sub-agents that only return the result. That's how it "feels like infinite context". The main agent manages helpers like a to-do list: check on them, message them, stop them.
- **Practical tips:**
  - don't add or remove tools mid-turn (it breaks the cache)
  - keep tool descriptions and schemas short
  - a single shell tool works, but give the dominant 90% use case its own dedicated tool
  - write descriptive, actionable error messages, because they help agents too
- **Security:**
  - auto review on every shell command
  - treat email and webhook input as untrusted, never as user instructions (prompt injection)
  - confirm irreversible actions with the user
  - keep passwords out of the model's conversation

## Context engineering

- **Prompt caching is the main cost lever.** Keep the system prompt and tool definitions byte-stable so you only pay uncached rates on the newest message. Treat a cache miss as a bug.
- Keep prompt sections in a **fixed order (hash each section)** so an A/B test or new tool doesn't bust everyone's cache.
- **Warm the cache early** by preparing the prompt as soon as the user starts typing.
- **Spill long outputs to files**, send screenshots and other expensive work to helpers, and keep trimming the context.
- **Compact while the cache is still warm.** If the user goes idle on a 100k+ token conversation, summarize now while it's cheap. When they come back, they continue from the summary.
- **Memory has three layers:**
  - core facts about the user that go in every prompt (e.g. "always lowercase")
  - dated logs of past work
  - ephemeral scratchpad notes for the next hour or so
  - everything else is retrieved from files with grep or other shell commands

## Where it's going

- **Training flywheel.** The inner loop is: bug → eval → fix the harness, prompt or inference → verify → ship. The outer loop is new models trained on those failures, which also opens up new behaviours (e.g. bots in group chats and multi-agent settings).
- **Serving:** the main agent is tuned for low latency, and helpers are tuned for throughput.
- **"Delete the product":** assume today's models are the worst they'll ever be. Expect to rebuild the UI every ~6 months, and build as little as possible for the next model generation.
- **6–12 month bets:**
  - agents that run for weeks or months
  - better recall
  - giving the agent every tool you'd give a new hire
  - voice interfaces
  - learning skills on the job
  - companies writing down their processes so agents can read them
  - far more tokens flowing, so efficiency matters
- **Open problems:**
  - how to evaluate a month-long agent when models ship monthly
  - memory algorithms
  - harness and infrastructure security
  - when to stay silent versus when to be proactive
- **The new primitives** (each with many startups): durable workflows, sandboxes, cloud computers, memory, skills, connectors, voice, payments, identity, evals, observability.

## Relevance to adm

The talk's architecture maps closely onto what adm already does:

| Talk | adm |
|------|-----|
| Agent's own Linux computer, snapshot and restart | per-workspace Kubernetes Pod with replicated PVC |
| Durable workflow that resumes, not replays | lifecycle owner with operation IDs (`--operation-id` replay) |
| Event-triggered wake | `adm prompt`, scheduled/background work, bot role (`--role bot`) |
| Thin client, thick server | `adm attach`/`shell` clients; runtime lives in-cluster |
| Rebuild the VM without losing the loop | `adm update` with maintenance windows and resume |

Worth considering:

- a single `send_to_user`-style egress for bot-role agents
- a priority inbound queue where the owner preempts other traffic
- cache-warm compaction when a session goes idle
- running the agent loop separately from the sandbox, so the sandbox can be rebuilt independently
