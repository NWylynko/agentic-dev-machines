//! `adm infisical`: the installation's Infisical machine identity (TASK-138).
//! `login` sends a Universal Auth client ID and secret to the cluster
//! authority, which checks them with one real Infisical login before storing
//! them; every coding workspace's shells then get a short-lived access token
//! in `INFISICAL_TOKEN`. The secret is read from a hidden prompt or stdin,
//! never argv, and never printed.
use crate::Cli;
use anyhow::{Context, Result, ensure};
use clap::Subcommand;
use serde_json::{Value, json};
use std::io::{self, BufRead, IsTerminal, Write};

#[derive(Subcommand, Debug)]
pub enum InfisicalAction {
    /// Store a Universal Auth machine identity so every coding workspace gets INFISICAL_TOKEN. Reads the client secret from a hidden prompt, or from stdin when it is not a terminal.
    Login {
        /// Infisical instance.
        #[arg(long, default_value = "https://app.infisical.com")]
        domain: String,
        /// Universal Auth client ID; prompted for (or read from stdin's first line) when omitted.
        #[arg(long)]
        client_id: Option<String>,
    },
    /// Forget the machine identity; workspaces stop getting INFISICAL_TOKEN.
    Logout,
    /// Show the machine identity's client ID, domain and last token result.
    Status,
}

pub fn run(cli: &Cli, action: &InfisicalAction) -> Result<()> {
    match action {
        InfisicalAction::Login { domain, client_id } => login(cli, domain, client_id.as_deref()),
        InfisicalAction::Logout => {
            cli.request_lifecycle("POST", "/v1/infisical/logout", Some(&json!({})))?;
            println!(
                "Logged out of Infisical: new shells in coding workspaces get no INFISICAL_TOKEN. Run adm infisical login to reconnect."
            );
            Ok(())
        }
        InfisicalAction::Status => {
            let infisical = infisical_status(cli);
            for line in infisical_status_lines(&infisical) {
                println!("{line}");
            }
            ensure!(
                infisical["status"] != "unavailable",
                "could not read the Infisical login status"
            );
            Ok(())
        }
    }
}

fn login(cli: &Cli, domain: &str, client_id: Option<&str>) -> Result<()> {
    let terminal = io::stdin().is_terminal();
    let mut stdin = io::stdin().lock();
    let mut read_line = |prompt: &str, secret: bool| -> Result<String> {
        if terminal {
            print!("{prompt}: ");
            io::stdout().flush()?;
        }
        let echo = if secret && terminal {
            Some(crate::provider_auth::SecretEcho::hide()?)
        } else {
            None
        };
        let mut line = String::new();
        let read = stdin.read_line(&mut line);
        drop(echo);
        if secret && terminal {
            println!();
        }
        ensure!(
            read.context("read Infisical login input")? > 0,
            "Infisical login input ended before the {prompt}"
        );
        Ok(line.trim_end_matches(['\r', '\n']).to_owned())
    };
    let client_id = match client_id {
        Some(client_id) => client_id.to_owned(),
        None => read_line("Universal Auth client ID", false)?,
    };
    ensure!(!client_id.trim().is_empty(), "the client ID is empty");
    let client_secret = read_line("Universal Auth client secret", true)?;
    ensure!(!client_secret.is_empty(), "the client secret is empty");
    let stored = cli.request_lifecycle(
        "POST",
        "/v1/infisical/login",
        Some(&json!({"clientId":client_id,"clientSecret":client_secret,"domain":domain})),
    )?;
    println!(
        "✓ Infisical connected as machine identity {} at {}: new shells in every coding workspace get INFISICAL_TOKEN",
        stored["clientId"].as_str().unwrap_or(&client_id),
        stored["domain"].as_str().unwrap_or(domain)
    );
    Ok(())
}

/// The installation's Infisical login as JSON; a failure to ask is
/// `unavailable`, never "not logged in".
pub fn infisical_status(cli: &Cli) -> Value {
    match cli.request_lifecycle("GET", "/v1/infisical/status", None) {
        Ok(status) => status["infisical"].clone(),
        Err(error) => json!({"status":"unavailable","error":format!("{error:#}")}),
    }
}

/// Lines for `adm infisical status` and `adm doctor`: client ID, domain and
/// the last mint result, never the secret or a token.
pub fn infisical_status_lines(infisical: &Value) -> Vec<String> {
    let text = |key: &str| infisical[key].as_str().unwrap_or("unknown").to_owned();
    match infisical["status"].as_str() {
        Some("not_configured") => vec!["Infisical: not logged in; run adm infisical login".into()],
        Some("connected" | "login_expired") => {
            let mut lines = vec![format!(
                "Infisical: connected as machine identity {} at {}",
                text("clientId"),
                text("domain")
            )];
            let last = &infisical["lastMint"];
            lines.push(match last["result"].as_str() {
                Some("ok") => format!(
                    "last token minted {}, valid until {}",
                    last["at"].as_str().unwrap_or("?"),
                    last["expiresAt"].as_str().unwrap_or("?")
                ),
                Some("login_expired") => format!(
                    "login expired at {}: {}",
                    last["at"].as_str().unwrap_or("?"),
                    last["error"].as_str().unwrap_or(
                        "Infisical refused the machine identity; run adm infisical login"
                    )
                ),
                Some(_) => format!(
                    "last token request failed at {}: {}",
                    last["at"].as_str().unwrap_or("?"),
                    last["error"].as_str().unwrap_or("unknown error")
                ),
                None => "no token minted since the authority started".into(),
            });
            lines
        }
        _ => vec![format!(
            "Infisical: status unavailable: {}",
            infisical["error"].as_str().unwrap_or("unknown error")
        )],
    }
}
