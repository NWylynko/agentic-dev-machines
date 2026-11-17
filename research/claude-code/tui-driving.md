# Driving the interactive Claude Code TUI from a bot — spike (TASK-141/142, 2026-11-17)

Question: can the coding runner start `claude` in tmux unattended, paste prompts into it, tell idle/busy/waiting apart, abort it, and read back a small history, all without a person attached?

Evidence: `research/claude-code/tui-driving.test.mjs` runs the real `claude` TUI in a private tmux server against `research/claude-code/tui-fake-api.mjs` (a fake Messages API that also collects hook calls, so hooks and model requests come in one ordered stream), with a scratch `HOME`/`CLAUDE_CONFIG_DIR`. All 16 tests pass on 2.1.326 (host). The image pins 2.1.316, which is not installed on this host. 2.1.314 gives the same results (`CLAUDE_BIN=~/.local/share/claude/versions/2.1.314`), except that a too-early paste fails even worse there (see 2).

```
node --test --test-concurrency=1 research/claude-code/tui-driving.test.mjs      # ~40 s
CLAUDE_BIN=/path/to/claude node --test ...                                      # another build
```

## 1. Unattended start: two config keys, no dialog

With an empty config dir, `claude --dangerously-skip-permissions` stops at a series of screens: the theme picker, "Detected a custom API key" (only because the test uses an API key), the security notes, the folder trust prompt ("❯ No, exit" is the default) and the Bypass Permissions warning ("❯ No, exit" again). `SessionStart` does not fire until they are all answered. Answering them by hand writes these keys:

- `$CLAUDE_CONFIG_DIR/.claude.json`: `hasCompletedOnboarding: true` (skips the theme picker and the security notes) and `projects["<dir>"].hasTrustDialogAccepted: true`. Trust on a parent directory covers every directory below it (test "trust accepted on a parent directory"), so trusting `/workspace` and `/repos` once covers every checkout.
- `skipDangerousModePermissionPrompt: true`: the dialog writes it to `$CLAUDE_CONFIG_DIR/settings.json`, and it works just as well inside `--settings '<json>'`. Without it, the "WARNING: Claude Code running in Bypass Permissions mode … ❯ No, exit / Yes, I accept" screen blocks (tested).

Minimal seed used by every passing test:

```json
// $CLAUDE_CONFIG_DIR/.claude.json (merge, the file also holds login/account state)
{ "hasCompletedOnboarding": true, "projects": { "/workspace": { "hasTrustDialogAccepted": true } } }
// claude --dangerously-skip-permissions --settings '{"skipDangerousModePermissionPrompt":true, ...}'
```

(`customApiKeyResponses.approved: ["<last 20 chars of key>"]` is needed only by this API-key test. Pods use an OAuth `.credentials.json`; not verified here, because that needs a real login.)

Stuck on a dialog = Claude never writes its session record (below). The runner can fail loudly when Claude is not `idle` N seconds after the start.

## 2. Delivering a prompt: bracketed paste + Enter, but only once Claude is ready

```
printf '%s' "$PROMPT" | tmux load-buffer -b prompt -          # set-buffer refused a 20 KB prompt: "command too long"
tmux paste-buffer -p -d -b prompt -t =claude: \; send-keys -t =claude: Enter
```

- Submitted exactly once, byte for byte: blank lines, leading spaces, `"`, `$HOME`, backticks and backslashes all survive (checked against `UserPromptSubmit.prompt` and the model request). The same holds for a 300-line, ~20 KB prompt, (a multi-line paste shows in the input box as a `[Pasted text #1 +3 lines]` placeholder). Ten prompts in a row, 10/10. Paste and Enter can go in one tmux call; no delay is needed.
- Note: use `=claude:` as the pane target; `=claude` alone is "can't find pane".
- **Race at startup:** tmux adds the paste brackets only after the app has enabled bracketed paste. `SessionStart` fires about 130–150 ms before the input box exists. Pasting at `SessionStart`: on 2.1.326 the Enter is swallowed, the text stays in the box, and the next prompt is glued onto it (`"early 0\nsecond line\nready 0"`, 3/3). Once, unbracketed, only `"hello"` was submitted. On 2.1.314 the input box hangs and nothing is ever submitted (3/3).
- **Readiness signal (no timer):** `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` gets `"status":"idle"`. It does not exist at `SessionStart`, and appears once the input box is live. Pasting right when it says idle worked in 5/5 fresh starts. Watch the directory with `fs.watch`.
- **Initial prompt:** `claude … --remote-control NAME "<prompt>"` (a positional argument) is submitted once at start, with newlines kept. There is no startup race at all, and NAME stays the Remote Control name. Use this for createAgent's first prompt (TASK-141 step 4).

## 3. Busy / idle / waiting

Hooks configured through `--settings` fire in interactive mode. Their input carries `session_id`, `transcript_path` and `prompt_id`:

| Hook | When it fires (observed) |
|---|---|
| `SessionStart` (`source:"startup"`) | after the dialogs, but **before** the input box is ready |
| `UserPromptSubmit` (`prompt`) | at submit time, **including text queued mid-turn**, so it fires before the running turn's `Stop` |
| `Stop` (`last_assistant_message`) | once per turn end, including a turn that took in a mid-turn message |
| `Notification` | `{"message":"Claude needs your permission","notification_type":"permission_prompt"}` when Claude calls AskUserQuestion, even with permissions bypassed |
| — | **nothing** on Escape (interrupt) or when AskUserQuestion is cancelled: no `Stop`, no other hook |

So a hook-only state file stays stuck on `working` after anyone presses Escape, including Nick attached through `adm claude` or the app. Claude's own session record does not have that gap:

```
$CLAUDE_CONFIG_DIR/sessions/<pid>.json
{"pid":…,"sessionId":"…","cwd":"…","status":"idle"|"busy"|"waiting","waitingFor":"input needed","statusUpdatedAt":…,"messagingSocketPath":"/run/user/…/cc-socks/<pid>.sock",…}
```

It is rewritten on every change: `busy` while a turn runs, `waiting` + `waitingFor:"input needed"` on AskUserQuestion, `idle` again after Escape. It is undocumented, but it is the record Claude's own peer-messaging feature reads; the image pins the Claude version, and the image test would catch a change. (`messagingSocketPath` is a private peer protocol; not explored, don't build on it.)

## 4. Text sent while a turn runs: queued, then delivered at the next safe point; Escape aborts

- **During a text-only stream:** the screen shows `Queued · ctrl+x ctrl+s to send now`. `UserPromptSubmit` fires immediately, the transcript records `queue-operation/enqueue`, and the text goes out as the **next turn** after `Stop`.
- **When the turn uses tools** (queued before the tool starts, or while it runs): the text is **injected into the same turn**, sent with the next tool result as `"The user sent a new message while you were working:\n<text>\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn…"`. The transcript records it as `attachment` `{type:"queued_command", prompt}`. Only one `Stop` fires, for the whole turn. So TASK-142's `steer` and `followUp` both just type the text in; Claude decides when it lands.
- `ctrl+x ctrl+s` ("send now") interrupts the current turn and sends the queued text at once (manual check).
- **Escape** (`tmux send-keys -t =claude: Escape`) closes the stream to the API (the fake sees the connection drop). The screen shows `Interrupted · What should Claude do instead?`, and the transcript gets a user entry `"[Request interrupted by user]"` (or `"…for tool use]"` while a tool or question is open). No hook fires; the session record goes `idle`, and the next paste works. The next model request starts with the interrupt marker.
- While AskUserQuestion is open, a paste would go into the question UI, so `/input` must refuse or abort first when the status is `waiting`.

## 5. Transcript

- The path is `$CLAUDE_CONFIG_DIR/projects/<cwd with / → ->/<session_id>.jsonl`, also given as `transcript_path` in every hook. It stays the same for the whole session.
- **Lag:** the final assistant line can land just *after* the `Stop` hook. Re-read the file when it changes (`fs.watch`) instead of reading once on `Stop`. Alternatively, `Stop.last_assistant_message` carries the final reply directly.
- 2.1.326 adds new line types (`api-request`, `api-request-blob`, `queue-operation`, `atis-latch`, `mode`, …); skip anything that is not `user`/`assistant`/`attachment`.
- Extraction is `transcriptHistory()` in the test file:
  - `user` entries that are not `isMeta` and carry no `tool_result` → the prompt (a string, or text blocks). Text starting with `[Request interrupted by user` → `interrupted`.
  - `attachment.type === "queued_command"` → a prompt delivered mid-turn.
  - `assistant` text blocks, keeping only the last text before the next prompt → the final reply. Skip `isSidechain` (subagents).
  - Typed prompts also carry `origin.kind:"human"`, `promptSource:"typed"`.

## 6. `--remote-control NAME` without a login

There was no dialog, and nothing on the screen blocked. Readiness, paste, hooks and the session record behaved the same. The positional prompt after `--remote-control NAME` still works.

## Recommended driving approach

1. Seed `.claude.json` (`hasCompletedOnboarding`, `hasTrustDialogAccepted` on `/workspace` and `/repos`), and add `skipDangerousModePermissionPrompt:true` to the `--settings` JSON `adm-claude run` already passes. Start with `--dangerously-skip-permissions --remote-control NAME "<initial prompt>"`.
2. Status comes from `sessions/<pid>.json` (`idle`/`busy`/`waiting`), watched with `fs.watch`. Fail loudly if it never appears after a start (Claude is stuck on a dialog). Hooks are optional extras: `Stop.last_assistant_message`, and `Notification` for "needs input".
3. `/input`: refuse while `waiting`; for `whenBusy: reject`, refuse while `busy`; otherwise `load-buffer -` + `paste-buffer -p -d` + `send-keys Enter`, and confirm with `UserPromptSubmit` (matching `prompt`) or `queue-operation`.
4. `/abort`: `send-keys Escape`; done when the status is `idle`.
5. `/history`: `transcriptHistory()` over the transcript jsonl. Prompts typed by Nick (attached or through the app) show up there too.
6. Re-run this suite (or the image test) against the pinned version whenever `CLAUDE_CODE_VERSION` changes. The image pins 2.1.316, and this spike checked 2.1.314 and 2.1.326.
