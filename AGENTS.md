keep this file up to date

# Project notes

- This project is at the design stage. Read `README.md` for the intended product, proposed architecture, and open decisions.
- There is no implementation, package manifest, dev server, or test suite yet. README command examples are proposals, not working commands.
- The target is a homelab CLI/workspace service integrated with Herdr and Kubernetes. Workspace identity must be independent of the current runtime and physical node.
- Confirmed persistence scope: repository work and agent history; installed tools are ephemeral or supplied by the base image. Some recent work loss after rare unexpected node failure is acceptable; the exact window is unchosen.
- Every development workspace has private writable files and Git state, regardless of branch names. Share immutable upstream data only. Coding agents have no access to other workspaces; bots may use explicitly permitted monitoring/prompting interfaces without repository, shell, or general cross-workspace access.
- Agents must execute unattended independently of SSH, CLI, and terminal connections. Nick connects from MacBooks to Herdr on a long-running Debian management box.
- Manual Herdr space removal destroys its runtime and private files and cancels its owned agents, goals, loops, and pending work. Recovery must not recreate deliberately deleted workspaces. Conversation retention remains open; configurability is an acceptable proposal.
- User-facing coding and bot conversations belong in Herdr with a Pi-style terminal interface. Browser automation and access to development sites/ports from MacBooks are required.
- Bots are a separate non-coding role: no repository access or coding tools, including indirectly through Code Mode. They can monitor/prompt explicitly permitted coding agents and maintain durable goals/loops. Bot-to-space and bot-to-agent assignments remain open.
- Bot model output is hidden by default; only explicit `sendMessage` calls publish AI-authored messages in its terminal conversation. Keep inspectable diagnostics separate from chat delivery.
- Nick uses Codex via Plus currently and is considering Claude. Keep providers/auth configurable; subscription compatibility, numeric budgets, and migration are not settled. No silent provider/billing fallback.
- Lazy GitHub repository access and storage efficiency on 256 GB nodes remain goals. Storage technology, agent backend compatibility, terminal adapter, and runner placement remain open. Pi Durable is a candidate, distinct from ordinary Pi session files. Containers are the proposed development runtime.
- Read `docs/pi-durable-research.md` before choosing or integrating Pi Durable. It records version 1.2.0/pinned-source findings and credential-free local probes. Native Pi interactive/RPC attachment is not established; a terminal adapter remains work. Harness close and ordinary abort are not workspace destruction. SQLite WAL storage needs compatible filesystem semantics and external single-owner enforcement.
- Preserve the distinction between requirements and proposals. Do not turn candidate technologies or command syntax into settled decisions without evidence.
- Do not claim transparent process recovery or filesystem durability that has not been demonstrated end to end.
- Follow the home-level `AGENTS.md`. Use end-to-end tests and test-driven development when implementation begins.
