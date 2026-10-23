//! `adm mcp`: installation-wide MCP connectors. The cluster authority holds
//! each connector's OAuth grant; this command registers servers and drives the
//! browser sign-in, receiving the authorization redirect on a loopback port so
//! only the one-time code (never a token) passes through the client.
use crate::Cli;
use anyhow::{Context, Result, bail, ensure};
use clap::Subcommand;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, IsTerminal, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};

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
    let result = receive_sign_in(cli, name, &listener, state);
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

/// Wait for the browser's redirect, complete sign-in in the authority, and
/// tell the browser how it went.
fn receive_sign_in(cli: &Cli, name: &str, listener: &TcpListener, state: &str) -> Result<Value> {
    for stream in listener.incoming() {
        let mut stream = stream.context("accept the sign-in redirect")?;
        let target = read_request_target(&stream)?;
        let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
            .context("parse the sign-in redirect")?;
        if url.path() != "/callback" {
            respond(&mut stream, 404, "Not found")?;
            continue;
        }
        let parameter = |key: &str| {
            url.query_pairs()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.into_owned())
        };
        if parameter("state").as_deref() != Some(state) {
            respond(
                &mut stream,
                400,
                "This sign-in link is stale. Use the newest one printed by adm.",
            )?;
            continue;
        }
        if let Some(error) = parameter("error") {
            let detail = parameter("error_description").unwrap_or_default();
            respond(
                &mut stream,
                400,
                &format!("Sign-in failed: {error} {detail}"),
            )?;
            bail!("sign-in to {name} failed: {error} {detail}");
        }
        let code = parameter("code").context("the sign-in redirect has no code")?;
        let mut body = json!({"state":state,"code":code});
        if let Some(iss) = parameter("iss") {
            body["iss"] = Value::String(iss);
        }
        return match cli.request_lifecycle(
            "POST",
            &format!("/v1/connectors/{name}/sign-in/complete"),
            Some(&body),
        ) {
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
    bail!("the sign-in listener closed")
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
