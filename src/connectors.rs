//! `adm mcp`: installation-wide MCP connectors. The cluster authority holds
//! each connector's OAuth grant; this command registers servers and drives the
//! browser sign-in. The authorization redirect arrives on a loopback port, or
//! is pasted from a browser on another device. Only the one-time code (never a
//! token) passes through the client.
use crate::Cli;
use anyhow::{Context, Result, bail, ensure};
use clap::Subcommand;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, IsTerminal, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;

#[derive(Subcommand)]
pub enum McpAction {
    /// Add a remote MCP server for every agent, then sign in to it in the browser.
    Add { name: String, url: String },
    /// Sign in to an added connector again.
    Login { name: String },
    /// Sign out of a connector; every agent loses its tools.
    Logout { name: String },
    /// Remove a connector from every agent.
    Remove { name: String },
    /// List connectors and their sign-in state.
    List {
        /// Print the connector records as JSON.
        #[arg(long)]
        json: bool,
    },
}

pub fn run(cli: &Cli, action: &McpAction) -> Result<()> {
    match action {
        McpAction::Add { name, url } => {
            validate_connector_name(name)?;
            cli.request_lifecycle(
                "POST",
                "/v1/connectors",
                Some(&json!({"name":name,"url":url})),
            )?;
            sign_in(cli, name)
        }
        McpAction::Login { name } => {
            validate_connector_name(name)?;
            sign_in(cli, name)
        }
        McpAction::Logout { name } => {
            validate_connector_name(name)?;
            cli.request_lifecycle("POST", &format!("/v1/connectors/{name}/logout"), None)?;
            println!("Signed out of MCP connector {name}; no ADM agent can use its tools.");
            Ok(())
        }
        McpAction::Remove { name } => {
            validate_connector_name(name)?;
            cli.request_lifecycle("DELETE", &format!("/v1/connectors/{name}"), None)?;
            println!("Removed MCP connector {name} from every ADM agent.");
            Ok(())
        }
        McpAction::List { json } => {
            let connectors = cli.request_lifecycle("GET", "/v1/connectors", None)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&connectors)?);
                return Ok(());
            }
            let items = connectors.as_array().cloned().unwrap_or_default();
            if items.is_empty() {
                println!("No MCP connectors. Add one with `adm mcp add NAME URL`.");
                return Ok(());
            }
            println!("{:<20} {:<14} URL", "NAME", "STATE");
            for item in &items {
                let name = item["name"].as_str().unwrap_or("?");
                let state = if item["signedIn"] == true {
                    "signed in"
                } else {
                    "needs sign-in"
                };
                println!(
                    "{name:<20} {state:<14} {}",
                    item["url"].as_str().unwrap_or("")
                );
                if let Some(error) = item["error"].as_str() {
                    println!("  {name}: {error}; run `adm mcp login {name}`");
                }
            }
            Ok(())
        }
    }
}

fn validate_connector_name(name: &str) -> Result<()> {
    ensure!(
        name.len() <= 32
            && name.starts_with(|c: char| c.is_ascii_lowercase())
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "connector names use 1-32 lowercase letters, digits or hyphens and start with a letter"
    );
    Ok(())
}

fn sign_in(cli: &Cli, name: &str) -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").context("listen for the sign-in redirect")?;
    let redirect = format!(
        "http://127.0.0.1:{}/callback",
        listener.local_addr()?.port()
    );
    let started = cli.request_lifecycle(
        "POST",
        &format!("/v1/connectors/{name}/sign-in"),
        Some(&json!({"redirectUrl":redirect})),
    )?;
    let authorization_url = started["authorizationUrl"]
        .as_str()
        .context("sign-in returned no authorization URL")?;
    let state = started["state"]
        .as_str()
        .context("sign-in returned no state")?;
    println!("Open this URL in your browser to sign in to {name}:\n{authorization_url}");
    std::io::stdout().flush()?;
    if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
        open_browser(authorization_url);
    }
    let result = receive_sign_in(cli, name, listener, state);
    if result.is_err() {
        let _ = cli.request_lifecycle("DELETE", &format!("/v1/connectors/{name}/sign-in"), None);
    }
    let connector = result?;
    let tools = connector["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    println!(
        "Signed in to {name}. Every ADM agent can use its tools: {}",
        if tools.is_empty() {
            "none offered"
        } else {
            &tools
        }
    );
    Ok(())
}

const STALE_SIGN_IN: &str = "This sign-in link is stale. Use the newest one printed by adm.";

enum Arrival {
    Browser { stream: TcpStream, target: String },
    Failed(String),
    Pasted(String),
}

/// `state`, `error`, `code` and `iss` from a sign-in redirect. The loopback
/// listener and a pasted URL both use this, so a stale state or an error is
/// reported with the same message either way.
enum SignInRedirect {
    NotCallback,
    Stale,
    Failed(String),
    Ready { code: String, iss: Option<String> },
}

fn sign_in_redirect(url: &reqwest::Url, state: &str) -> SignInRedirect {
    if url.path() != "/callback" {
        return SignInRedirect::NotCallback;
    }
    let parameter = |key: &str| {
        url.query_pairs()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
    };
    if parameter("state").as_deref() != Some(state) {
        return SignInRedirect::Stale;
    }
    if let Some(error) = parameter("error") {
        let detail = parameter("error_description").unwrap_or_default();
        return SignInRedirect::Failed(format!("Sign-in failed: {error} {detail}"));
    }
    match parameter("code") {
        Some(code) => SignInRedirect::Ready {
            code,
            iss: parameter("iss"),
        },
        None => SignInRedirect::Failed("the sign-in redirect has no code".to_owned()),
    }
}

/// Wait until the browser hits the loopback callback or the user pastes that
/// same URL. The first one to arrive completes sign-in.
fn receive_sign_in(cli: &Cli, name: &str, listener: TcpListener, state: &str) -> Result<Value> {
    let (tx, rx) = mpsc::channel();
    let browser = tx.clone();
    thread::spawn(move || listen_for_browser_redirect(listener, browser));
    if stdin_accepts_pasted_redirect() {
        println!("Or paste the URL your browser ended up on:");
        std::io::stdout().flush()?;
        thread::spawn(move || read_pasted_redirect(tx));
    } else {
        drop(tx);
    }
    loop {
        match rx.recv().context("the sign-in listener closed")? {
            Arrival::Failed(message) => bail!("{message}"),
            Arrival::Browser { mut stream, target } => {
                let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
                    .context("parse the sign-in redirect")?;
                match sign_in_redirect(&url, state) {
                    SignInRedirect::NotCallback => respond(&mut stream, 404, "Not found")?,
                    SignInRedirect::Stale => respond(&mut stream, 400, STALE_SIGN_IN)?,
                    SignInRedirect::Failed(message) => {
                        respond(&mut stream, 400, &message)?;
                        bail!("{message}");
                    }
                    SignInRedirect::Ready { code, iss } => {
                        return match complete_sign_in(cli, name, state, &code, iss) {
                            Ok(connector) => {
                                respond(
                                    &mut stream,
                                    200,
                                    &format!("Signed in to {name}. You can close this tab."),
                                )?;
                                Ok(connector)
                            }
                            Err(error) => {
                                respond(&mut stream, 500, &format!("Sign-in failed: {error:#}"))?;
                                Err(error)
                            }
                        };
                    }
                }
            }
            Arrival::Pasted(line) => {
                let url = reqwest::Url::parse(line.trim()).context(
                    "could not parse the pasted sign-in URL; paste the full URL from the browser's address bar",
                )?;
                match sign_in_redirect(&url, state) {
                    SignInRedirect::NotCallback => {
                        bail!("the pasted URL is not the sign-in callback")
                    }
                    SignInRedirect::Stale => bail!("{STALE_SIGN_IN}"),
                    SignInRedirect::Failed(message) => bail!("{message}"),
                    SignInRedirect::Ready { code, iss } => {
                        return complete_sign_in(cli, name, state, &code, iss);
                    }
                }
            }
        }
    }
}

fn listen_for_browser_redirect(listener: TcpListener, tx: mpsc::Sender<Arrival>) {
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                let _ = tx.send(Arrival::Failed(format!(
                    "accept the sign-in redirect: {error}"
                )));
                break;
            }
        };
        let target = match read_request_target(&stream) {
            Ok(target) => target,
            Err(error) => {
                let _ = tx.send(Arrival::Failed(format!("{error:#}")));
                break;
            }
        };
        if tx.send(Arrival::Browser { stream, target }).is_err() {
            break;
        }
    }
}

fn read_pasted_redirect(tx: mpsc::Sender<Arrival>) {
    let mut line = String::new();
    match std::io::stdin().read_line(&mut line) {
        Ok(0) => {}
        Ok(_) => {
            let _ = tx.send(Arrival::Pasted(line));
        }
        Err(error) => {
            let _ = tx.send(Arrival::Failed(format!(
                "read the pasted sign-in URL: {error}"
            )));
        }
    }
}

/// A terminal or a pipe can paste the redirect. Closed stdin (`/dev/null`)
/// stays on the loopback listener alone.
fn stdin_accepts_pasted_redirect() -> bool {
    if std::io::stdin().is_terminal() {
        return true;
    }
    let fd = std::io::stdin().as_raw_fd();
    // SAFETY: fstat only reads the kernel's stat for this already-open fd.
    unsafe {
        let mut stat = std::mem::zeroed::<libc::stat>();
        if libc::fstat(fd, &mut stat) != 0 {
            return false;
        }
        let kind = stat.st_mode & libc::S_IFMT;
        // A shell pipe is a FIFO. Node's stdio "pipe" (and the connector
        // test) is a socketpair. `/dev/null` is a character device.
        kind == libc::S_IFIFO || kind == libc::S_IFSOCK
    }
}

fn complete_sign_in(
    cli: &Cli,
    name: &str,
    state: &str,
    code: &str,
    iss: Option<String>,
) -> Result<Value> {
    let mut body = json!({"state": state, "code": code});
    if let Some(iss) = iss {
        body["iss"] = Value::String(iss);
    }
    cli.request_lifecycle(
        "POST",
        &format!("/v1/connectors/{name}/sign-in/complete"),
        Some(&body),
    )
}

fn read_request_target(stream: &TcpStream) -> Result<String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" || header == "\n" {
            break;
        }
    }
    let mut parts = line.split_whitespace();
    ensure!(
        parts.next() == Some("GET"),
        "unexpected sign-in redirect request"
    );
    Ok(parts.next().unwrap_or("/").to_owned())
}

fn respond(stream: &mut TcpStream, status: u16, text: &str) -> Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        if status == 200 { "OK" } else { "Error" },
        text.len()
    )?;
    Ok(())
}

fn open_browser(url: &str) {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = Command::new(opener)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
