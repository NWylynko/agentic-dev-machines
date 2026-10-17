use crate::{Cli, lifecycle};
use anyhow::{Context, Result, bail, ensure};
use clap::Subcommand;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Subcommand)]
pub enum HerdrAction {
    /// Consume explicit lifecycle JSON events from stdin.
    Events,
    /// Associate an existing managed workspace with its owning Herdr space.
    Bind { name: String, space: String },
    /// Print the command to run in a Herdr-managed pane.
    Hook,
    /// Watch this Herdr session and destroy bound workspaces when their spaces close.
    Watch {
        #[arg(long)]
        socket: PathBuf,
    },
}

pub fn run(cli: &Cli, action: &HerdrAction) -> Result<()> {
    match action {
        HerdrAction::Bind { name, space } => {
            ensure!(!space.is_empty(), "Herdr space ID must not be empty");
            validate_herdr_space(space)?;
            let workspace = cli.active_workspace(name)?;
            crate::print_json(&cli.request_lifecycle(
                "PUT",
                &format!("/v1/workspaces/{}/herdr", workspace.id),
                Some(&json!({"spaceId":space})),
            )?)
        }
        HerdrAction::Hook => {
            println!(
                "Run these commands on the management host, from the Herdr pane that should own the ADM workspace:"
            );
            println!("  herdr workspace get \"$HERDR_WORKSPACE_ID\"");
            println!("  adm create NAME");
            println!("  adm herdr bind NAME \"$HERDR_WORKSPACE_ID\"");
            println!(
                "  systemd-run --user --unit=adm-herdr-watch --property=Restart=on-failure --property=RestartSec=3s --setenv=HERDR_ENV=1 --setenv=\"HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH\" adm herdr watch --socket \"$HERDR_SOCKET_PATH\""
            );
            println!(
                "Check or restart the watcher with `systemctl --user status adm-herdr-watch` or `systemctl --user restart adm-herdr-watch`."
            );
            println!(
                "Herdr has no replay cursor; close events missed while the watcher is disconnected cannot be recovered."
            );
            Ok(())
        }
        HerdrAction::Events => {
            for line in io::stdin().lock().lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let event: Value = serde_json::from_str(&line)?;
                process_event(cli, &event, false)?;
            }
            Ok(())
        }
        HerdrAction::Watch { socket } => watch(cli, socket),
    }
}

fn validate_herdr_space(space_id: &str) -> Result<()> {
    let output = Command::new("herdr")
        .args(["workspace", "get", space_id])
        .output()
        .context("could not run `herdr workspace get`; install Herdr and run bind from its management host")?;
    ensure!(
        output.status.success(),
        "Herdr workspace {space_id} could not be verified: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    let response: Value = serde_json::from_slice(&output.stdout)
        .context("`herdr workspace get` returned invalid JSON")?;
    let returned_id = response["result"]["workspace"]["workspace_id"]
        .as_str()
        .context("`herdr workspace get` did not return a workspace ID")?;
    ensure!(
        returned_id == space_id,
        "Herdr returned workspace {returned_id} while verifying {space_id}"
    );
    Ok(())
}

fn closed_space_id(event: &Value) -> Result<Option<&str>> {
    let data = &event["data"];
    let kind = event["event"]
        .as_str()
        .or_else(|| data["type"].as_str())
        .or_else(|| event["type"].as_str())
        .unwrap_or("");
    if kind != "workspace_closed" && kind != "workspace.closed" {
        return Ok(None);
    }
    let space = event["workspace_id"]
        .as_str()
        .or_else(|| data["workspace_id"].as_str())
        .or_else(|| event["workspace"]["workspace_id"].as_str())
        .or_else(|| data["workspace"]["workspace_id"].as_str())
        .or_else(|| event["payload"]["workspace_id"].as_str())
        .unwrap_or("");
    ensure!(
        !space.is_empty(),
        "workspace_closed event missing workspace_id"
    );
    Ok(Some(space))
}

fn process_event(cli: &Cli, event: &Value, compact: bool) -> Result<()> {
    let Some(space) = closed_space_id(event)? else {
        return Ok(());
    };
    record_close(cli, space)?;
    destroy_bound_space(cli, space, compact)?;
    clear_close_journal(cli)
}

fn close_journal(cli: &Cli) -> std::path::PathBuf {
    cli.state_path().join("herdr-closed-events.jsonl")
}

fn record_close(cli: &Cli, space: &str) -> Result<()> {
    let path = close_journal(cli);
    fs::create_dir_all(cli.state_path())?;
    let mut journal = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(journal, "{}", serde_json::to_string(space)?)?;
    journal.sync_all()?;
    Ok(())
}

fn destroy_bound_space(cli: &Cli, space: &str, compact: bool) -> Result<()> {
    for workspace in cli
        .workspaces(false)?
        .into_iter()
        .filter(|workspace| workspace.herdr_space.as_deref() == Some(space))
    {
        // The immutable workspace UUID is a stable, unique key for its one
        // destruction operation across Herdr journal replay.
        let operation_id = workspace.id.clone();
        let destroyed = cli.request_lifecycle(
            "POST",
            "/v1/operations",
            Some(&serde_json::to_value(
                lifecycle::OperationRequest::Delete {
                    operation_id,
                    workspace_id: workspace.id,
                },
            )?),
        )?;
        if compact {
            println!("{}", serde_json::to_string(&destroyed)?);
        } else {
            crate::print_json(&destroyed)?;
        }
    }
    Ok(())
}

fn clear_close_journal(cli: &Cli) -> Result<()> {
    let path = close_journal(cli);
    if path.exists() {
        let journal = OpenOptions::new().write(true).truncate(true).open(path)?;
        journal.sync_all()?;
    }
    Ok(())
}

fn replay_close_journal(cli: &Cli) -> Result<()> {
    let path = close_journal(cli);
    if !path.exists() {
        return Ok(());
    }
    for line in io::BufReader::new(fs::File::open(&path)?).lines() {
        let space: String = serde_json::from_str(&line?)?;
        ensure!(
            !space.is_empty(),
            "Herdr close journal contains an empty workspace ID"
        );
        destroy_bound_space(cli, &space, true)?;
    }
    clear_close_journal(cli)
}

struct HerdrApi {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: u64,
    queued_events: VecDeque<Value>,
}

impl HerdrApi {
    fn connect(path: &Path) -> Result<Self> {
        let stream = UnixStream::connect(path)
            .with_context(|| format!("connect to Herdr API socket {}", path.display()))?;
        Ok(Self {
            reader: BufReader::new(stream.try_clone()?),
            writer: stream,
            next_id: 1,
            queued_events: VecDeque::new(),
        })
    }

    fn next_message(&mut self) -> Result<Value> {
        let mut line = String::new();
        let count = self.reader.read_line(&mut line)?;
        ensure!(
            count > 0,
            "Herdr API socket closed; restart adm herdr watch to replay locally journaled close events"
        );
        serde_json::from_str(&line).context("Herdr API returned invalid JSON")
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = format!("adm-herdr-watch-{}", self.next_id);
        self.next_id += 1;
        let request = json!({"id":id,"method":method,"params":params});
        writeln!(self.writer, "{}", serde_json::to_string(&request)?)
            .and_then(|_| self.writer.flush())
            .context("Herdr API socket closed; restart adm herdr watch")?;

        loop {
            let response = self.next_message()?;
            if response["id"] == id {
                ensure!(
                    response.get("error").is_none(),
                    "Herdr {method} failed: {}",
                    response["error"]["message"]
                        .as_str()
                        .unwrap_or("unknown error")
                );
                return Ok(response["result"].clone());
            }
            if is_event(&response) {
                self.queued_events.push_back(response);
            } else {
                bail!("unexpected Herdr response while waiting for {method}: {response}");
            }
        }
    }

    fn next_event(&mut self) -> Result<Value> {
        if let Some(event) = self.queued_events.pop_front() {
            return Ok(event);
        }
        let result = self.next_message()?;
        ensure!(
            is_event(&result),
            "unexpected Herdr message while waiting for a subscribed event: {result}"
        );
        Ok(result)
    }
}

fn is_event(value: &Value) -> bool {
    value["event"].is_string() && value["data"].is_object()
}

fn watch(cli: &Cli, socket: &Path) -> Result<()> {
    ensure!(
        std::env::var("HERDR_ENV").as_deref() == Ok("1"),
        "adm herdr watch must run inside a Herdr-managed pane (HERDR_ENV=1)"
    );
    let session_socket = std::env::var("HERDR_SOCKET_PATH")
        .context("HERDR_SOCKET_PATH is unavailable; run watch inside the intended Herdr pane")?;
    ensure!(
        Path::new(&session_socket) == socket,
        "--socket must match this Herdr pane's HERDR_SOCKET_PATH"
    );

    let mut api = HerdrApi::connect(socket)?;
    let subscription = api.request(
        "events.subscribe",
        json!({"subscriptions":[{"type":"workspace.closed"}]}),
    )?;
    ensure!(
        subscription["type"] == "subscription_started",
        "Herdr did not confirm the workspace.closed subscription: {subscription}"
    );

    replay_close_journal(cli)?;

    println!(
        "{}",
        serde_json::to_string(&json!({
            "status":"watching",
            "event":"workspace.closed",
            "socket":socket,
            "recovery":"replays locally journaled close events; Herdr API exposes no replay cursor, so close events missed while disconnected cannot be recovered"
        }))?
    );
    while let Some(event) = api.queued_events.pop_front() {
        process_event(cli, &event, true)?;
    }
    loop {
        process_event(cli, &api.next_event()?, true)?;
    }
}
