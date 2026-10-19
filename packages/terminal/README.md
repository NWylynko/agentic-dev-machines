# ADM terminal

`adm attach WORKSPACE` opens upstream Pi InteractiveMode on the workspace's existing Durable agent. The terminal is an HTTP/SSE client; the workspace Pod owns execution, history, settings and provider access.

Ctrl+C detaches while work continues. Ctrl+R or `/reconnect` reconnects. Cancellation is explicit through `/abort` or the relevant Pi interrupt control. Pi's startup help and `/hotkeys` describe its editor and selectors.

Useful controls include `/model`, `/settings`, `/resume` for session selection, `/tree`, `/fork`, `/new`, `/compact`, `/copy`, and `/export PATH.html` or `PATH.jsonl`. `/share PATH` creates a local export. Coding `!command` runs in the workspace; `!!command` keeps its output out of model context. `/goal`, `/loop`, `/status` and `/retry` retain ADM's durable controls.

`/login` and `/logout` delegate to the host ADM CLI and cluster authentication authority. The client receives provider classification and model metadata, never provider credentials. Bots display explicit published messages and keep model/tool diagnostics separate.

The pinned dependency patch is part of installation and release assembly. Run `npm run check`, `npm run test:terminal` and `npm run test:pi-patch` from the repository root. Actual PTY tests require Linux `script`.

See [the parity audit](../../docs/pi-terminal-parity.md) for verified behavior and remaining extension/live acceptance limits. Arbitrary Pi extension component functions are not executed on the client.
