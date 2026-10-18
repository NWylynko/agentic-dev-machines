use crate::Cli;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::process::{Command, Stdio};

pub fn login(cli: &Cli, requested_provider: Option<&str>) -> Result<()> {
    let providers: Vec<Value> = serde_json::from_value(cli.request_lifecycle(
        "GET",
        "/v1/provider-auth/providers",
        None,
    )?)?;
    let provider = match requested_provider {
        Some(id) => providers
            .iter()
            .find(|item| item["provider"] == id)
            .context("provider is not available in the pinned Pi catalog")?,
        None => {
            let choices = providers
                .iter()
                .filter(|item| {
                    item["authTypes"]
                        .as_array()
                        .is_some_and(|types| !types.is_empty())
                })
                .collect::<Vec<_>>();
            ensure!(
                !choices.is_empty(),
                "no providers offer an interactive login"
            );
            println!("Choose a provider:");
            for (index, item) in choices.iter().enumerate() {
                println!(
                    "  {}. {} ({})",
                    index + 1,
                    item["name"].as_str().unwrap_or("Provider"),
                    item["provider"].as_str().unwrap_or("unknown")
                );
            }
            let index = read_selection(choices.len())?;
            choices[index]
        }
    };
    let id = provider["provider"]
        .as_str()
        .context("provider metadata is incomplete")?;
    let auth_types = provider["authTypes"]
        .as_array()
        .context("provider has no interactive auth methods")?;
    ensure!(
        !auth_types.is_empty(),
        "provider has no interactive login method"
    );
    let auth_type = if auth_types.len() == 1 {
        auth_types[0]
            .as_str()
            .context("provider auth type is invalid")?
            .to_owned()
    } else {
        println!("Choose an authentication method:");
        for (index, kind) in auth_types.iter().enumerate() {
            println!(
                "  {}. {}",
                index + 1,
                auth_type_label(kind.as_str().unwrap_or(""))
            );
        }
        auth_types[read_selection(auth_types.len())?]
            .as_str()
            .context("provider auth type is invalid")?
            .to_owned()
    };
    let started = cli.request_lifecycle(
        "POST",
        "/v1/provider-auth/login",
        Some(&json!({"provider":id,"type":auth_type})),
    )?;
    let operation = started["operationId"]
        .as_str()
        .context("provider login returned no operation ID")?;
    let result = drive_login(cli, operation);
    if result.is_err() {
        let _ = cli.request_lifecycle(
            "DELETE",
            &format!("/v1/provider-auth/login/{operation}"),
            None,
        );
    }
    result?;
    println!(
        "Authenticated {} for all ADM workspaces.",
        provider["name"].as_str().unwrap_or(id)
    );
    Ok(())
}

pub fn logout(cli: &Cli, provider: &str) -> Result<()> {
    cli.request_lifecycle(
        "POST",
        "/v1/provider-auth/logout",
        Some(&json!({"provider":provider})),
    )?;
    println!("Logged out of {provider} for all ADM workspaces.");
    Ok(())
}

fn drive_login(cli: &Cli, operation: &str) -> Result<()> {
    loop {
        let path = format!("/v1/provider-auth/login/{operation}/events");
        let next = cli.request_lifecycle_wait("GET", &path, None)?;
        let event = &next["event"];
        match event["type"].as_str().unwrap_or("") {
            "prompt" => {
                let prompt = &event["prompt"];
                let value = read_prompt(prompt)?;
                let prompt_id = event["promptId"]
                    .as_str()
                    .context("provider login prompt has no ID")?;
                cli.request_lifecycle(
                    "POST",
                    &format!("/v1/provider-auth/login/{operation}/reply"),
                    Some(&json!({"promptId":prompt_id,"value":value})),
                )?;
            }
            "auth_url" => {
                if let Some(url) = event["url"].as_str() {
                    println!("Open this URL to continue sign-in:\n{url}");
                }
                if let Some(instructions) = event["instructions"].as_str() {
                    println!("{instructions}");
                }
            }
            "device_code" => {
                println!(
                    "Open {} and enter code {}",
                    event["verificationUri"]
                        .as_str()
                        .unwrap_or("the verification page"),
                    event["userCode"].as_str().unwrap_or("")
                );
            }
            "info" | "progress" => {
                if let Some(message) = event["message"].as_str() {
                    println!("{message}");
                }
                for link in event["links"].as_array().into_iter().flatten() {
                    if let Some(url) = link["url"].as_str() {
                        println!("{url}");
                    }
                }
            }
            "complete" => return Ok(()),
            "error" => anyhow::bail!("provider authentication failed"),
            other => anyhow::bail!("provider login returned an unknown event: {other}"),
        }
        if next["done"] == true {
            ensure!(
                event["type"] == "complete",
                "provider authentication did not complete"
            );
            return Ok(());
        }
    }
}

fn read_prompt(prompt: &Value) -> Result<String> {
    let message = prompt["message"].as_str().unwrap_or("Enter a value");
    println!("{message}");
    if let Some(options) = prompt["options"].as_array() {
        for (index, option) in options.iter().enumerate() {
            println!(
                "  {}. {}",
                index + 1,
                option["label"].as_str().unwrap_or("Option")
            );
            if let Some(description) = option["description"].as_str() {
                println!("     {description}");
            }
        }
        let index = read_selection(options.len())?;
        return Ok(options[index]["id"]
            .as_str()
            .context("provider option has no ID")?
            .to_owned());
    }
    let secret = prompt["type"] == "secret";
    let _echo = if secret {
        Some(SecretEcho::hide()?)
    } else {
        None
    };
    print!("> ");
    io::stdout().flush()?;
    let mut value = String::new();
    let read_result = io::stdin()
        .read_line(&mut value)
        .context("read provider authentication input");
    drop(_echo);
    if secret {
        println!();
    }
    let read = read_result?;
    ensure!(read > 0, "provider authentication input ended");
    Ok(value.trim_end_matches(['\r', '\n']).to_owned())
}

fn read_selection(count: usize) -> Result<usize> {
    let mut line = String::new();
    print!("Select 1-{count}: ");
    io::stdout().flush()?;
    io::stdin().read_line(&mut line)?;
    let selected: usize = line
        .trim()
        .parse()
        .context("enter a number from the list")?;
    ensure!(
        (1..=count).contains(&selected),
        "selection is outside the list"
    );
    Ok(selected - 1)
}

struct SecretEcho;

impl SecretEcho {
    fn hide() -> Result<Self> {
        set_echo(false)?;
        Ok(Self)
    }
}

impl Drop for SecretEcho {
    fn drop(&mut self) {
        let _ = set_echo(true);
    }
}

fn set_echo(enabled: bool) -> Result<()> {
    let mut command = Command::new("stty");
    command
        .arg(if enabled { "echo" } else { "-echo" })
        .stdin(Stdio::inherit())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    ensure!(
        command
            .status()
            .context("configure terminal input")?
            .success(),
        "provider login requires a terminal for secret input"
    );
    Ok(())
}

fn auth_type_label(value: &str) -> &str {
    match value {
        "oauth" => "OAuth",
        "api_key" => "API key",
        _ => "Other",
    }
}
