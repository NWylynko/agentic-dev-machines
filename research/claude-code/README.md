# Claude Code remote-control in workspace Pods — spike (TASK-90, 2026-11-01)

Question: which credential does `claude remote-control` accept — (A) the long-lived `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, or (B) only a full interactive login (`.credentials.json`, self-refreshing)? And can Claude Code use installation MCP connectors without holding their refresh tokens?

Sources: Claude Code 2.1.314 (native binary on this host) and 2.1.316 (npm), run with a scratch `HOME`; strings of the 2.1.314 binary; <https://code.claude.com/docs/en/remote-control> and <https://code.claude.com/docs/en/mcp>.

## Answer: B, full-scope login only

- Docs, troubleshooting "Remote Control requires a full-scope login token": "You're authenticated with a long-lived token from `claude setup-token` or the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. These tokens can only make model requests, so they can't establish Remote Control sessions. Run `claude auth login` …". Requirements: "API keys are not supported."
- Reproduced: `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-… claude remote-control` exits with exactly that error before any network call. No login at all: "You must be logged in to use Remote Control."
- `claude --remote-control [name]` starts an interactive session with Remote Control on; without an eligible login it still starts and shows a failure notification (docs). This is the one process ADM runs: a TUI to attach to plus the remote bridge.

## What the full login is, and why Pods must not refresh it

- Stored as `$CLAUDE_CONFIG_DIR/.credentials.json` → `{"claudeAiOauth":{"accessToken","refreshToken","expiresAt"(ms),"scopes":[…],"subscriptionType"}}`, plus account info (`oauthAccount.organizationUuid`, `accountUuid`, …) in `$CLAUDE_CONFIG_DIR/.claude.json`.
- Refresh tokens are single use: the binary's own message for `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` is "was used for this attempt and cannot be used again". Claude Code's guard against two processes refreshing at once is a file lock (`.oauth_refresh.lock`) in the config dir, so it only protects processes sharing one disk. Copying one login into several Pods means the first Pod to refresh logs every other Pod out.
- It is the same OAuth client and scopes Pi already uses for `adm login anthropic` (`pi-ai/dist/auth/oauth/anthropic.js`: same client ID, `user:profile user:inference user:sessions:claude_code user:mcp_servers …`, copy-code flow for headless login). The provider-auth authority already holds that kind of refresh token and refreshes it centrally.

## Route that avoids collisions (authority keeps the refresh token)

Verified offline, not yet with a real account:

- A `.credentials.json` with **no `refreshToken`**, a future `expiresAt` and the full scopes passes the full-scope check: `claude remote-control` moves on to the organization check ("Unable to determine your organization…", which needs `oauthAccount.organizationUuid` in `.claude.json`; the authority can read it from `GET https://api.anthropic.com/api/oauth/profile` with the access token, the endpoint Claude Code itself calls).
- A running Claude Code re-reads the file when its mtime changes (it stats `.credentials.json`, clears its token cache and emits a credentials-changed event), and its refresh path first re-reads the file under the lock and returns "not needed" when the token on disk is still >5 min from expiry.

So a Pod-side writer that replaces the file with a fresh access token (from a `/v1/runtime/...` route) before `expiresAt − 5 min` keeps Claude logged in without any Pod holding a refresh token. Still to verify live: a real login through Pi's flow, the bridge staying up across a file swap, and the failure Claude shows when the Pod writer is late (it has nothing to refresh with, so it should surface "login expired").

## MCP: `headersHelper`, no proxy needed

Claude Code's MCP config supports `"headersHelper": "<command>"` for `http` servers: run fresh on every connection and reconnect, output a JSON object of headers, 10 s limit, and on a 401/403 tool result it re-runs the helper, reconnects and retries once. `CLAUDE_CODE_MCP_SERVER_NAME`/`_URL` are set for it. A helper that POSTs `/v1/runtime/connectors/token {name}` with the projected SA token and prints `{"Authorization":"Bearer …"}` gives Claude the installation connectors with short-lived tokens only, the same contract as `packages/runner/src/connectors.ts`. Keeping them in sync means regenerating the config from `/v1/runtime/connectors/catalog`; Claude reads MCP config at start and on `/mcp` reconnect.

## Other findings

- `claude setup-token` would have needed no refresh at all, but it cannot run remote control, so it is not an option.
- `--bare` mode ignores OAuth entirely (API key only) — never use it here.
- First start in a directory asks to trust it; with no terminal attached, the session waits. ADM's first `adm claude` attaches, so the user answers once; it is saved in `.claude.json` on the volume.
