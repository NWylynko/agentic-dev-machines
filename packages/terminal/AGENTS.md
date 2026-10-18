keep this file up to date

- This package is the Pi TUI client for the runner's public HTTP/SSE API. It owns no agent execution or lifecycle state.
- Read the root AGENTS.md and docs/implementation-contract.md. Coordinate API changes with packages/runner and the Rust CLI.
- Ctrl+C and terminal disconnection detach only. Only explicit abort controls send cancellation requests.
- Bot chat must suppress ordinary assistant/tool events in both history and live updates unless --diagnostics was explicitly selected.
- Resume SSE from its durable sequence cursor and preserve request identity across ambiguous input responses. Reconnect is explicit and uses no polling timer.
- Provider login/logout are host CLI subprocesses that suspend the TUI; never send lifecycle admin credentials or provider secrets to the workspace Pod.
- Clipboard images travel only through the bounded Durable input API, preserving the request ID across retries. Never execute tools or create a Pi session in the client.
- `/import PATH.jsonl` may read a bounded native transcript locally, but persistence and selection must happen atomically in the owning Pod's Durable conversation API. Reject unsupported records visibly; never create a client Pi session.
- `/share PATH` is a user-requested local export. Public publication needs a separate explicit contract and confirmation.
- `/bash` must delegate through the host CLI to the owning coding Pod; bots must remain unable to enter development shells.
- Keep working toward the approved reproducible InteractiveMode remote-port patch. Component reuse and mapped commands do not establish full upstream parity.
- Keep `docs/pi-terminal-parity.md` accurate about mapped controls and missing workspace-owned contracts; unsupported settings must fail visibly.
- Tests use the public Pi component and real local HTTP server, plus an isolated PTY process. They do not control an operator's Herdr session or call models.
