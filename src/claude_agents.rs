//! Claude Code agents (TASK-141): a coding workspace whose `harness` is
//! `claude` runs Claude Code in tmux instead of taking Pi turns.
//!
//! A bot's createAgent picks the harness and, for Claude, the task `prompt`.
//! Admission refuses a Claude agent while the installation has no working
//! `adm login claude`, before anything is created. Once the workspace is ready
//! (and its checkout prepared) the lifecycle runs `adm-claude start --task` in
//! the Pod with the task on stdin, prefixed with how to report back to the
//! managing bot. The task is never written to the Pod's config, so it reaches
//! Claude once; after a Pod restart `adm-claude boot` resumes the conversation
//! (image/adm-claude). The runner drives the session from then on
//! (packages/runner/src/claude-agent.ts).

use crate::Cli;
use crate::workspaces::Workspace;
use anyhow::{Result, bail, ensure};

pub const CLAUDE_HARNESS: &str = "claude";
const MAX_CLAUDE_TASK_CHARS: usize = 100_000;

/// Validates a create's harness and task, and returns the harness to store:
/// `None` for Pi (the default), `Some("claude")` for Claude Code.
pub(crate) fn admit_harness(
    role: &str,
    harness: Option<String>,
    prompt: &Option<String>,
) -> Result<Option<String>> {
    match harness.as_deref() {
        None | Some("pi") => {
            ensure!(
                prompt.is_none(),
                "prompt is the initial task of a Claude Code agent (harness claude); Pi agents take theirs with promptAgent"
            );
            Ok(None)
        }
        Some(CLAUDE_HARNESS) => {
            ensure!(role == "coding", "only coding workspaces run Claude Code");
            ensure!(
                prompt
                    .as_deref()
                    .is_some_and(|prompt| !prompt.trim().is_empty()
                        && prompt.chars().count() <= MAX_CLAUDE_TASK_CHARS),
                "a Claude Code agent (harness claude) needs its task as prompt (1-{MAX_CLAUDE_TASK_CHARS} characters)"
            );
            Ok(harness)
        }
        Some(other) => bail!("harness must be pi or claude, not {other}"),
    }
}

/// Refuses a Claude Code agent while the installation's `adm login claude`
/// is missing or expired, so the create fails before any Pod exists.
pub(crate) fn require_claude_login(harness: Option<&str>) -> Result<()> {
    if harness != Some(CLAUDE_HARNESS) {
        return Ok(());
    }
    let (status, providers) =
        crate::lifecycle::proxy_provider_auth("GET", "/v1/provider-auth/providers", b"")?;
    ensure!(
        status == 200,
        "cannot read the installation's Claude Code login (provider auth answered {status}): {providers}"
    );
    let claude = providers
        .as_array()
        .and_then(|providers| providers.iter().find(|p| p["provider"] == CLAUDE_HARNESS));
    match claude.and_then(|claude| claude["status"].as_str()) {
        Some("authenticated") => Ok(()),
        Some("login_expired") => bail!(
            "the installation's Claude Code login expired ({}): run adm login claude",
            claude
                .and_then(|c| c["cause"].as_str())
                .unwrap_or("refresh refused")
        ),
        _ => bail!("Claude Code is not logged in to this installation: run adm login claude"),
    }
}

/// The first prompt Claude gets: how to report back, then the bot's task.
pub(crate) fn initial_claude_prompt(workspace: &Workspace) -> Option<String> {
    let task = workspace.prompt.as_deref()?;
    Some(match &workspace.manager {
        Some(manager) => format!(
            "You are a coding agent started by the ADM bot that manages you (bot workspace {manager}). \
The bot does not watch this conversation: when you finish the task, get blocked, or need a decision, \
tell it with the mcp__manager__messageManager tool, in a short message with the result (a PR link, say), \
the blocker or the question.\n\nYour task:\n\n{task}"
        ),
        None => task.to_owned(),
    })
}

/// Starts Claude Code in a ready Claude workspace with its task on stdin.
/// `adm-claude start` keeps the task on the volume only until Claude has a
/// conversation, and is a no-op while Claude already runs, so a retried create
/// never sends the task twice.
pub(crate) fn start_claude_agent(cli: &Cli, workspace: &Workspace) -> Result<()> {
    if workspace.harness.as_deref() != Some(CLAUDE_HARNESS) {
        return Ok(());
    }
    let Some(task) = initial_claude_prompt(workspace) else {
        bail!(
            "Claude Code workspace {} has no task to start with",
            workspace.name
        );
    };
    crate::workspaces::kubectl(
        cli,
        &[
            "exec",
            "-i",
            "-n",
            &workspace.namespace,
            "deployment/workspace",
            "-c",
            "dev",
            "--",
            "adm-claude",
            "start",
            "--task",
        ],
        Some(task.as_bytes()),
    )
    .map(|_| ())
}
