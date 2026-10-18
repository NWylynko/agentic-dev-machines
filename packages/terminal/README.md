# Herdr terminal client

This client uses Pi TUI 1.2.0 and connects to the durable runner. `adm attach` uses Pi's multiline editor, Markdown and structured message components, model/thinking/settings selectors, and keybinding manager. The workspace Pod's Durable harness remains the only agent and transcript owner across detach and reconnect. See [the parity audit](../../docs/pi-terminal-parity.md) for mapped controls and outstanding runtime/API work.

From the repository root:

```sh
node --import tsx packages/terminal/src/main.ts --url http://127.0.0.1:7432 --workspace WORKSPACE_ID
```

The CLI may also pass a host-side ADM command for provider authentication without passing a lifecycle credential to the workspace terminal:

```sh
adm terminal --url URL --workspace ID --admin-executable /path/to/adm --admin-args-json '["--lifecycle-url","http://127.0.0.1:7433"]'
```

`/login [PROVIDER]` and `/logout PROVIDER` suspend the TUI and invoke that host command. If no admin command was configured, these controls report that clearly.

The terminal loads persisted history, subscribes to server-sent events, and resumes from its last event cursor after `/reconnect` or Ctrl+R. A lost connection leaves the agent running. Reconnection is explicit; the client does not poll or silently restart the runner.

| Input                                | Effect                                                              |
| ------------------------------------ | ------------------------------------------------------------------- |
| Enter                                | Send input, steering a busy agent after its current tools           |
| `/followup TEXT`                     | Queue input after the current run                                   |
| `/resume`                            | Retry the latest provider failure when no tool ran before it        |
| `/model`                             | Open the Pi model selector backed by the selected workspace         |
| `/thinking`                          | Open the Pi thinking-level selector                                 |
| `/settings`                          | Open workspace-backed Pi settings; unsupported settings fail        |
| `/session`, `/tree`, `/fork`, `/new` | Inspect and navigate Durable conversations in this workspace        |
| `/compact`, `/reset`                 | Compact or reset the selected Durable conversation                  |
| `/import PATH.jsonl`                 | Import supported native Pi messages into a new Durable conversation |
| `/share PATH`                        | Save a local Markdown copy of the selected transcript               |
| `/bash`                              | Open bash inside this coding workspace's Pod                        |
| `/login`, `/logout`                  | Run the host CLI's shared provider-auth flow                        |
| Ctrl+G                               | Open `$VISUAL`/`$EDITOR` and return text to the prompt              |
| Ctrl+V / Alt+V                       | Attach a clipboard PNG/JPEG/WebP image to the next prompt           |
| `/newgoal TEXT`                      | Save a durable goal (`/goal` also works)                            |
| `/loop SECONDS TEXT`                 | Save recurring work                                                 |
| `/goals`                             | List durable goal IDs, descriptions, and statuses                   |
| `/loops`                             | List recurring loop IDs, prompts, and statuses                      |
| `/complete-goal ID`                  | Mark a goal completed                                               |
| `/cancel-goal ID`                    | Cancel a goal                                                       |
| `/cancel-loop ID`                    | Stop a recurring loop                                               |
| Esc or `/abort`                      | Abort current foreground work                                       |
| `/abort all`                         | Request cancellation including background agent work                |
| `/status`                            | Show current state, provider error details, and goal/loop counts    |
| `/help`                              | Show available commands                                             |
| Ctrl+R or `/reconnect`               | Reattach from the last received cursor                              |
| Ctrl+C or `/detach`                  | Close this terminal attachment                                      |
| Ctrl+J or Shift+Enter                | Insert a newline in the prompt editor                               |
| Up / Down                            | Browse submitted prompt history                                     |

Bot chat shows user input, explicit `sendMessage` deliveries, and system status. Ordinary model responses and tool output remain hidden even if the server accidentally includes them. Start with `--diagnostics` to inspect raw diagnostic events explicitly. Model-supplied terminal control sequences are stripped before display.

Assistant, user, thinking, and tool records render through Pi TUI components. `/resume` retries a safe failed provider turn; `/import` imports supported user/assistant/tool-result messages into and selects a new Durable conversation. Unsupported message shapes fail visibly instead of being dropped. `/share PATH` writes a user-requested local Markdown copy and does not publish a link. `/bash` uses the host CLI to open an interactive shell inside the owning coding Pod; bots cannot use it. Project trust, extension management, reload, and extension UI still need Pod-owned contracts. The client does not run local coding tools or create a second Pi session.

An input whose HTTP response is lost retains its request ID when retried unchanged in the same attachment. The runner can deduplicate the admission. If input fails, its text returns to the editor and the error is shown.

Provider authentication and rate-limit errors appear in the terminal status. `/resume` retries a provider failure only when no tool ran before it; after a tool may have changed the workspace, the runner refuses automatic retry and asks for an explicit follow-up to avoid repeating that action.

Goals and loops persist with runner state. Use `/goals` or `/loops` to see their IDs and current statuses, then complete or cancel them by ID. `/abort all` stops agent work; it does not cancel saved goals or recurring loops.

Run `npm run test:terminal` from the root. The integration suite exercises the public Pi component and real HTTP/SSE transport, plus a real subprocess inside an isolated PTY using the system `script` executable. No Herdr space or external model is used.
