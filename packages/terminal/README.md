# Herdr terminal client

This client uses Pi TUI 1.2.0 and connects to the durable runner. `adm attach` launches it with inherited terminal input/output. It does not own the agent process.

From the repository root:

```sh
node --import tsx packages/terminal/src/main.ts --url http://127.0.0.1:7432 --workspace WORKSPACE_ID
```

The terminal loads persisted history, subscribes to server-sent events, and resumes from its last event cursor after `/reconnect` or Ctrl+R. A lost connection leaves the agent running. Reconnection is explicit; the client does not poll or silently restart the runner.

| Input                  | Effect                                                           |
| ---------------------- | ---------------------------------------------------------------- |
| Enter                  | Send input, steering a busy agent after its current tools        |
| `/followup TEXT`       | Queue input after the current run                                |
| `/resume`              | Retry the latest provider failure when no tool ran before it     |
| `/newgoal TEXT`        | Save a durable goal (`/goal` also works)                         |
| `/loop SECONDS TEXT`   | Save recurring work                                              |
| `/goals`               | List durable goal IDs, descriptions, and statuses                |
| `/loops`               | List recurring loop IDs, prompts, and statuses                   |
| `/complete-goal ID`    | Mark a goal completed                                            |
| `/cancel-goal ID`      | Cancel a goal                                                    |
| `/cancel-loop ID`      | Stop a recurring loop                                            |
| Esc or `/abort`        | Abort current foreground work                                    |
| `/abort all`           | Request cancellation including background agent work             |
| `/status`              | Show current state, provider error details, and goal/loop counts |
| `/help`                | Show available commands                                          |
| Ctrl+R or `/reconnect` | Reattach from the last received cursor                           |
| Ctrl+C or `/detach`    | Close this terminal attachment                                   |

Bot chat shows user input, explicit `sendMessage` deliveries, and system status. Ordinary model responses and tool output remain hidden even if the server accidentally includes them. Start with `--diagnostics` to inspect raw diagnostic events explicitly. Model-supplied terminal control sequences are stripped before display.

An input whose HTTP response is lost retains its request ID when retried unchanged in the same attachment. The runner can deduplicate the admission. If input fails, its text returns to the editor and the error is shown.

Provider authentication and rate-limit errors appear in the terminal status. `/resume` retries a provider failure only when no tool ran before it; after a tool may have changed the workspace, the runner refuses automatic retry and asks for an explicit follow-up to avoid repeating that action.

Goals and loops persist with runner state. Use `/goals` or `/loops` to see their IDs and current statuses, then complete or cancel them by ID. `/abort all` stops agent work; it does not cancel saved goals or recurring loops.

Run `npm run test:terminal` from the root. The integration suite exercises the public Pi component and real HTTP/SSE transport, plus a real subprocess inside an isolated PTY using the system `script` executable. No Herdr space or external model is used.
