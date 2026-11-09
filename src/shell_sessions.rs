//! Interactive `adm shell` sessions that outlive their connection (TASK-106). The
//! session lives in the Pod (`image/adm-shell-session`, one dtach per session); this
//! side connects to it and reconnects when the connection drops.
//!
//! `kubectl exec` exits 1 both for a dropped stream and for a remote exit 1, so a
//! failed connection never says what happened. Only asking the Pod does.

use crate::{Cli, workspaces::Workspace};
use anyhow::{Context, Result, bail};
use std::{
    fs,
    io::{Read, Write},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TOOL: &str = "adm-shell-session";
const NO_SUCH_SESSION: i32 = 64;
const OWNED_BY_ANOTHER_CLIENT: i32 = 75;
/// The Pod lists a session as detached 90 s after its last heartbeat.
const HEARTBEAT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(15);

/// The connection to one workspace's `dev` container.
struct Connection<'a> {
    cli: &'a Cli,
    workspace: &'a Workspace,
}

struct ToolResult {
    code: Option<i32>,
    stderr: String,
}

impl Connection<'_> {
    fn exec(&self, flags: &[&str], arguments: &[&str]) -> Result<Command> {
        let mut command = self.cli.kubectl_command()?;
        command
            .args(["exec", "-n", &self.workspace.namespace])
            .args(["deployment/workspace", "-c", "dev"])
            .args(flags)
            .args(["--", TOOL])
            .args(arguments);
        Ok(command)
    }

    /// One bounded request. `None` for the code means it timed out or was stopped,
    /// which says nothing about the session.
    fn request(&self, arguments: &[&str], stop: Option<&AtomicBool>) -> Result<ToolResult> {
        let mut child = self
            .exec(&[], arguments)?
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .context("connect to development container")?;
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break Some(status);
            }
            if started.elapsed() > REQUEST_TIMEOUT
                || stop.is_some_and(|stop| stop.load(Ordering::Relaxed))
            {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            thread::sleep(Duration::from_millis(50));
        };
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        Ok(ToolResult {
            code: status.and_then(|status| status.code()),
            stderr,
        })
    }

    /// A workspace keeps its image until `adm update --workspace`, so it can predate
    /// sessions. Falling back to a plain shell would quietly lose what this promises.
    fn ensure_tool(&self, code: Option<i32>, stderr: &str) -> Result<()> {
        if matches!(code, Some(126 | 127)) || stderr.contains("executable file not found") {
            let name = &self.workspace.name;
            bail!(
                "workspace {name} runs an image without shell sessions. Run `adm update --workspace {name}` (this replaces its Pod and ends what is running in it), or open a shell that does not survive a disconnect with `adm shell {name} -- zsh -l`"
            );
        }
        Ok(())
    }

    /// Claim the session before opening a terminal, so an unreachable Pod or an unknown
    /// session fails at once instead of looking like a dropped connection.
    fn prepare(&self, action: &str, session: &str, token: &str) -> Result<()> {
        let result = self.request(&[action, session, token], None)?;
        self.ensure_tool(result.code, &result.stderr)?;
        if result.code == Some(0) {
            return Ok(());
        }
        let detail = result.stderr.trim();
        if result.code == Some(NO_SUCH_SESSION) {
            // The tool's own message; kubectl adds a line about its exit code.
            let detail = detail
                .lines()
                .filter(|line| !line.starts_with("command terminated"))
                .collect::<Vec<_>>()
                .join("\n");
            bail!("{detail}");
        }
        bail!("could not open a shell session in the workspace: {detail}");
    }
}

/// The client's terminal settings. A kubectl killed while it has the terminal in raw
/// mode never restores them, and later messages would stair-step.
struct TerminalSettings(libc::termios);

impl TerminalSettings {
    fn capture() -> Result<Self> {
        let mut settings = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: tcgetattr fills the struct when it returns 0, checked before use.
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, settings.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error()).context("read terminal settings");
        }
        // SAFETY: initialised by the successful tcgetattr above.
        Ok(Self(unsafe { settings.assume_init() }))
    }

    fn restore(&self) {
        // SAFETY: self.0 came from tcgetattr. Failure leaves the terminal as it was.
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0) };
    }
}

/// Connect this terminal to a new session, or to an existing one by name.
pub fn open(
    cli: &Cli,
    workspace: &Workspace,
    existing: Option<&str>,
    launch: &[String],
) -> Result<()> {
    let connection = Connection { cli, workspace };
    let token = uuid::Uuid::new_v4().simple().to_string();
    let session = match existing {
        Some(session) => session.to_owned(),
        None => token[..6].to_owned(),
    };
    connection.prepare(
        if existing.is_some() {
            "take"
        } else {
            "reserve"
        },
        &session,
        &token,
    )?;
    let terminal = TerminalSettings::capture()?;
    eprintln!(
        "adm: shell session {session}. Ctrl-\\ detaches and leaves it running; `adm shell {name} {session}` comes back, `adm shells {name}` lists them.",
        name = workspace.name
    );
    let stop = AtomicBool::new(false);
    thread::scope(|scope| {
        let heartbeat = scope.spawn(|| send_heartbeats(&connection, &session, &token, &stop));
        let result = stay_connected(&connection, &terminal, &session, &token, launch);
        stop.store(true, Ordering::Relaxed);
        heartbeat.thread().unpark();
        result
    })
}

/// Lets the Pod tell this client from the stale one a dropped connection leaves there.
fn send_heartbeats(connection: &Connection, session: &str, token: &str, stop: &AtomicBool) {
    let interval = std::env::var("ADM_SHELL_HEARTBEAT_SECONDS")
        .ok()
        .and_then(|seconds| seconds.parse().ok())
        .map_or(HEARTBEAT, Duration::from_secs);
    loop {
        thread::park_timeout(interval);
        if stop.load(Ordering::Relaxed) {
            return;
        }
        // A missed heartbeat only affects what `adm shells` shows.
        let _ = connection.request(&["beat", session, token], Some(stop));
    }
}

fn stay_connected(
    connection: &Connection,
    terminal: &TerminalSettings,
    session: &str,
    token: &str,
    launch: &[String],
) -> Result<()> {
    let mut arguments = vec!["attach", session, token];
    if !launch.is_empty() {
        arguments.push("--");
        arguments.extend(launch.iter().map(String::as_str));
    }
    loop {
        // kubectl's stream errors are a wall of text about something this loop handles,
        // so they go to the log. Output from the shell comes through stdout on the TTY.
        let mut child = connection
            .exec(&["-it"], &arguments)?
            .stderr(Stdio::piped())
            .spawn()
            .context("connect to development container")?;
        let mut errors = child.stderr.take().context("kubectl stderr")?;
        let reader = thread::spawn(move || {
            let mut text = String::new();
            let _ = errors.read_to_string(&mut text);
            text
        });
        let status = child.wait().context("wait for development container")?;
        let stderr = reader.join().unwrap_or_default();
        terminal.restore();
        // dtach exits 0 both when the shell ends and when you detach.
        if status.success() {
            return Ok(());
        }
        connection.ensure_tool(status.code(), &stderr)?;
        log_drop(connection.cli, session, status.code(), &stderr);
        eprint!(
            "\r\nadm: connection to shell session {session} lost; reconnecting (Ctrl-C to stop)\r\n"
        );
        if !wait_until_reconnectable(connection, session, token)? {
            return Ok(());
        }
        eprint!("adm: reconnected to shell session {session}\r\n");
    }
}

/// `Ok(true)` once the session can be reattached, `Ok(false)` if another terminal has
/// it. Keeps trying through an outage: only you or the session can end this.
fn wait_until_reconnectable(connection: &Connection, session: &str, token: &str) -> Result<bool> {
    let mut delay = Duration::from_secs(1);
    loop {
        let result = connection.request(&["status", session, token], None)?;
        connection.ensure_tool(result.code, &result.stderr)?;
        match result.code {
            Some(0) => return Ok(true),
            Some(OWNED_BY_ANOTHER_CLIENT) => {
                eprint!("adm: shell session {session} is now attached from another terminal\r\n");
                return Ok(false);
            }
            Some(NO_SUCH_SESSION) => bail!(
                "shell session {session} ended while disconnected: its shell exited or the workspace Pod was replaced"
            ),
            _ => {}
        }
        thread::sleep(delay);
        delay = (delay * 2).min(MAX_BACKOFF);
    }
}

/// Why connections drop is still an open question (TASK-106), so keep the evidence.
fn log_drop(cli: &Cli, session: &str, code: Option<i32>, stderr: &str) {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let path = cli.state_path().join("shell-sessions.log");
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut log| {
            writeln!(
                log,
                "{seconds} session={session} exit={code:?} {}",
                stderr.trim().replace('\n', " | ")
            )
        });
}

/// `adm shells NAME`.
pub fn list(cli: &Cli, workspace: &Workspace) -> Result<()> {
    let connection = Connection { cli, workspace };
    let output = connection
        .exec(&[], &["list"])?
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::inherit())
        .output()
        .context("connect to development container")?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    connection.ensure_tool(output.status.code(), &stderr)?;
    anyhow::ensure!(
        output.status.success(),
        "could not list shell sessions: {}",
        stderr.trim()
    );
    Ok(())
}
