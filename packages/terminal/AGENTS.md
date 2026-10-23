keep this file up to date

- This package is the Pi TUI client for the runner's public HTTP/SSE API. It owns no agent execution or lifecycle state.
- Read the root AGENTS.md and docs/implementation-contract.md. Coordinate API changes with packages/runner and the Rust CLI.
- Ctrl+C and terminal disconnection detach only. Only explicit abort controls send cancellation requests.
- Bot chat must suppress ordinary assistant/tool events in both history and live updates unless --diagnostics was explicitly selected.
- Bot published messages need both native custom `message_start` and `message_end`. The content-free `live/activity` boolean spans the Durable run; retain it before native listener attachment and replay working controls on subscription so reconnect during private tools displays Working.
- Resume SSE from its durable sequence cursor and preserve request identity across ambiguous input responses. A dropped event stream (end, error, or three silent runner-declared keepalive intervals) is logged to `$XDG_STATE_HOME/adm/terminal.log`, shown in Pi's footer, and reconnected through the same path as Ctrl+R, retrying every 2 s while it fails. Those are the only timers: the silence deadline and the retry pacing.
- Provider login/logout are host CLI subprocesses that suspend the TUI; never send lifecycle admin credentials or provider secrets to the workspace Pod.
- Clipboard images travel only through the bounded Durable input API, preserving the request ID across retries. Never execute tools or create a Pi session in the client.
- `/import PATH.jsonl` may read a bounded native transcript locally, but persistence and selection must happen atomically in the owning Pod's Durable conversation API. Reject unsupported records visibly; never create a client Pi session.
- `/share PATH` is a user-requested local export. Public publication needs a separate explicit contract and confirmation.
- `/bash` must delegate through the host CLI to the owning coding Pod; bots must remain unable to enter development shells.
- The CLI uses pinned InteractiveMode through the reproducible remote-port patch. Keep its actual keyboard and PTY coverage; do not replace it with the legacy component layout. Advanced extension API limits remain explicit in the parity audit.
- Keep `docs/pi-terminal-parity.md` accurate about mapped controls and missing workspace-owned contracts; unsupported settings must fail visibly.
- Tests use the public Pi component and real local HTTP server, plus an isolated PTY process. They do not control an operator's Herdr session or call models.
