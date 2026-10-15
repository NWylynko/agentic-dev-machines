keep this file up to date

- This package is the Pi TUI client for the runner's public HTTP/SSE API. It owns no agent execution or lifecycle state.
- Read the root AGENTS.md and docs/implementation-contract.md. Coordinate API changes with packages/runner and the Rust CLI.
- Ctrl+C and terminal disconnection detach only. Only explicit abort controls send cancellation requests.
- Bot chat must suppress ordinary assistant/tool events in both history and live updates unless --diagnostics was explicitly selected.
- Resume SSE from its durable sequence cursor and preserve request identity across ambiguous input responses. Reconnect is explicit and uses no polling timer.
- Tests use the public Pi component and real local HTTP server, plus an isolated PTY process. They do not control an operator's Herdr session or call models.
