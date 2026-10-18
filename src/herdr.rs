use crate::{Cli, lifecycle, workspaces::Workspace};
use anyhow::{Context, Result, bail, ensure};
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    os::fd::AsRawFd,
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc,
    thread,
};
use toml_edit::{DocumentMut, value};

#[derive(Subcommand)]
pub enum HerdrAction {
    /// Print opt-in event-watcher instructions without implying it is running.
    Hook,
    /// Consume explicit lifecycle JSON events from stdin.
    Events,
    /// Associate an existing managed workspace with its owning Herdr space.
    Bind { name: String, space: String },
    /// Print integration configuration and live event-delivery state.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Restore Herdr's shell setting and stop routing new panes through ADM.
    Disable,
    /// Route a Herdr-created shell pane to its locally bound ADM workspace.
    #[command(hide = true)]
    RouteShell {
        #[arg(last = true)]
        command: Vec<String>,
    },
    /// Create a Herdr space through its stock local API and return actual IDs.
    #[command(hide = true)]
    CreateSpace { label: String, cwd: PathBuf },
    /// Watch this Herdr session and destroy bound workspaces when their spaces close.
    Watch {
        #[arg(long)]
        socket: PathBuf,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Binding {
    device_id: String,
    session_id: String,
    space_id: String,
    workspace_id: String,
    workspace_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct ScopedSpace {
    device_id: String,
    session_id: String,
    space_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CloseReceipt {
    workspace_id: String,
}

#[derive(Deserialize)]
struct WatcherCommand {
    command: String,
}

#[derive(Serialize, Deserialize)]
struct OriginalShell {
    value: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OpenedHerdrSpace {
    pub workspace_id: String,
    pub tab_id: String,
    pub pane_id: String,
}

pub fn run(cli: &Cli, action: &HerdrAction) -> Result<()> {
    match action {
        HerdrAction::Hook => {
            println!(
                "`adm herdr bind` renames the selected Herdr space and configures shell routing on this device."
            );
            println!(
                "Close-event cleanup is optional. Inside each Herdr session, supervise `adm herdr watch --socket \"$HERDR_SOCKET_PATH\"` if this device should delete bound ADM workspaces when their spaces close."
            );
            println!(
                "Run `adm herdr status` to verify pane routing and live event delivery. Herdr has no replay cursor; missed close events cannot be recovered."
            );
            Ok(())
        }
        HerdrAction::Bind { name, space } => {
            let workspace = cli.active_workspace(name)?;
            configure_bound_space(cli, &workspace, space)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "workspaceId":workspace.id,"herdrSpace":space,
                    "paneRouting":"configured",
                    "eventDelivery":"not checked; run `adm herdr status`"
                }))?
            );
            Ok(())
        }
        HerdrAction::Status { json } => status(cli, *json),
        HerdrAction::Disable => disable_shell_routing(cli),
        HerdrAction::RouteShell { command } => route_shell(cli, command),
        HerdrAction::CreateSpace { label, cwd } => {
            let opened = open_created_space(cli, label, cwd)?;
            println!("{}", serde_json::to_string(&opened)?);
            Ok(())
        }
        HerdrAction::Events => {
            let scope = current_session(cli)?;
            for line in io::stdin().lock().lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let event: Value = serde_json::from_str(&line)?;
                process_event(cli, &scope, &event, false)?;
            }
            Ok(())
        }
        HerdrAction::Watch { socket } => watch(cli, socket),
    }
}

/// Rename and bind one explicit space in the current device/session, then make
/// new Herdr panes route into its ADM workspace.
pub fn configure_bound_space(
    cli: &Cli,
    workspace: &Workspace,
    explicit_space_id: &str,
) -> Result<()> {
    ensure!(
        !explicit_space_id.is_empty(),
        "Herdr space ID must not be empty"
    );
    let scope = current_scope(cli, Some(explicit_space_id))?;
    let _lock = binding_lock(cli)?;
    validate_herdr_space(explicit_space_id)?;
    rename_herdr_space(explicit_space_id, &workspace.name)?;
    let encoded = serde_json::to_string(&scope)?;
    cli.request_lifecycle(
        "PUT",
        &format!("/v1/workspaces/{}/herdr", workspace.id),
        Some(&json!({"spaceId":encoded})),
    )?;
    let mut bindings = read_bindings(cli)?;
    bindings.retain(|binding| {
        binding.workspace_id != workspace.id
            && !(binding.device_id == scope.device_id
                && binding.session_id == scope.session_id
                && binding.space_id == scope.space_id)
    });
    bindings.push(Binding {
        device_id: scope.device_id,
        session_id: scope.session_id,
        space_id: scope.space_id,
        workspace_id: workspace.id.clone(),
        workspace_name: workspace.name.clone(),
    });
    write_json(cli, &bindings_path(cli), &bindings)?;
    enable_shell_routing(cli)?;
    Ok(())
}

/// Open a stock Herdr workspace and its initial tab/pane using the public API.
pub fn open_created_space(cli: &Cli, label: &str, client_cwd: &Path) -> Result<OpenedHerdrSpace> {
    ensure!(
        !label.trim().is_empty(),
        "Herdr space label must not be empty"
    );
    ensure!(
        client_cwd.is_absolute(),
        "Herdr client cwd must be an absolute local path"
    );
    let socket = session_socket()?;
    let mut api = HerdrApi::connect(&socket)?;
    let result = api.request(
        "workspace.create",
        json!({"label":label,"cwd":client_cwd,"focus":false,"env":{"ADM_HERDR_INITIAL_PANE":"local"}}),
    )?;
    let opened = OpenedHerdrSpace {
        workspace_id: result["workspace"]["workspace_id"]
            .as_str()
            .context("Herdr workspace.create omitted the created workspace ID")?
            .to_owned(),
        tab_id: result["tab"]["tab_id"]
            .as_str()
            .context("Herdr workspace.create omitted the created tab ID")?
            .to_owned(),
        pane_id: result["root_pane"]["pane_id"]
            .as_str()
            .context("Herdr workspace.create omitted the created pane ID")?
            .to_owned(),
    };
    let mut scope = current_session(cli)?;
    scope.space_id = opened.workspace_id.clone();
    write_text_atomic(&initial_pane_path(cli, &scope), &opened.pane_id)?;
    Ok(opened)
}

fn session_socket() -> Result<PathBuf> {
    std::env::var_os("HERDR_SOCKET_PATH")
        .map(PathBuf::from)
        .context(
            "HERDR_SOCKET_PATH is unavailable; run this command inside the intended Herdr session",
        )
}

fn current_scope(cli: &Cli, space_id: Option<&str>) -> Result<ScopedSpace> {
    let mut scope = current_session(cli)?;
    scope.space_id = space_id
        .map(str::to_owned)
        .or_else(|| std::env::var("HERDR_WORKSPACE_ID").ok())
        .unwrap_or_default();
    Ok(scope)
}

fn current_session(cli: &Cli) -> Result<ScopedSpace> {
    ensure!(
        std::env::var("HERDR_ENV").as_deref() == Ok("1"),
        "this operation must run inside the owning Herdr session (HERDR_ENV=1)"
    );
    let session = session_socket()?;
    let session_id = session
        .canonicalize()
        .unwrap_or(session)
        .to_string_lossy()
        .into_owned();
    let path = cli.state_path().join("herdr-device-id");
    let device_id = if path.exists() {
        fs::read_to_string(&path)?.trim().to_owned()
    } else {
        fs::create_dir_all(cli.state_path())?;
        let id = uuid::Uuid::new_v4().to_string();
        write_text_atomic(&path, &id)?;
        id
    };
    ensure!(!device_id.is_empty(), "ADM Herdr device identity is empty");
    Ok(ScopedSpace {
        device_id,
        session_id,
        space_id: String::new(),
    })
}

fn validate_herdr_space(space_id: &str) -> Result<()> {
    let output = Command::new("herdr")
        .args(["workspace", "get", space_id])
        .output()
        .context("could not run `herdr workspace get`; install Herdr on this device")?;
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

fn rename_herdr_space(space_id: &str, name: &str) -> Result<()> {
    let output = Command::new("herdr")
        .args(["workspace", "rename", space_id, name])
        .output()
        .context("could not run `herdr workspace rename`")?;
    ensure!(
        output.status.success(),
        "could not rename Herdr workspace {space_id}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

fn bindings_path(cli: &Cli) -> PathBuf {
    cli.state_path().join("herdr-bindings.json")
}

fn read_bindings(cli: &Cli) -> Result<Vec<Binding>> {
    let path = bindings_path(cli);
    if !path.exists() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json<T: Serialize>(cli: &Cli, path: &Path, value: &T) -> Result<()> {
    fs::create_dir_all(cli.state_path())?;
    write_text_atomic(path, &serde_json::to_string_pretty(value)?)
}

fn write_text_atomic(path: &Path, value: &str) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, value)?;
    fs::rename(temp, path)?;
    Ok(())
}

fn herdr_config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("HERDR_CONFIG_PATH") {
        return PathBuf::from(path);
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
        })
        .join("herdr/config.toml")
}

fn enable_shell_routing(cli: &Cli) -> Result<()> {
    let config_path = herdr_config_path();
    let original = if config_path.exists() {
        fs::read_to_string(&config_path)
            .with_context(|| format!("read Herdr config {}", config_path.display()))?
    } else {
        String::new()
    };
    let mut document: DocumentMut = if original.trim().is_empty() {
        "".parse().context("initialize Herdr TOML config")?
    } else {
        original.parse().with_context(|| {
            format!(
                "parse Herdr TOML config {}; fix it before binding",
                config_path.display()
            )
        })?
    };
    if !document
        .get("terminal")
        .is_some_and(toml_edit::Item::is_table)
    {
        document["terminal"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let terminal = document["terminal"]
        .as_table_mut()
        .context("Herdr terminal config is not a TOML table")?;
    let router = cli.state_path().join("herdr-shell-router");
    let original_path = cli.state_path().join("herdr-original-shell.json");
    let current_shell = terminal
        .get("default_shell")
        .and_then(toml_edit::Item::as_str)
        .map(str::to_owned);
    if current_shell.as_deref() != Some(router.to_string_lossy().as_ref()) {
        let value = current_shell;
        write_json(cli, &original_path, &OriginalShell { value })?;
    } else {
        ensure!(
            original_path.exists(),
            "Herdr is already configured with the ADM router but its original shell record is missing"
        );
    }
    let router_text = format!(
        "#!/bin/sh\nexec adm --state-dir {} herdr route-shell -- \"$@\"\n",
        shell_quote(&cli.state_path().to_string_lossy())
    );
    fs::create_dir_all(cli.state_path())?;
    fs::write(&router, router_text)?;
    fs::set_permissions(&router, fs::Permissions::from_mode(0o755))?;
    terminal["default_shell"] = value(router.to_string_lossy().into_owned());
    fs::create_dir_all(
        config_path
            .parent()
            .context("Herdr config has no parent directory")?,
    )?;
    write_text_atomic(&config_path, &document.to_string())?;
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn disable_shell_routing(cli: &Cli) -> Result<()> {
    stop_owned_watchers(cli)?;
    let config_path = herdr_config_path();
    if !config_path.exists() {
        println!("ADM Herdr event watcher is stopped; no shell routing configuration was present.");
        return Ok(());
    }
    let text = fs::read_to_string(&config_path)?;
    let mut document: DocumentMut = text.parse().with_context(|| {
        format!(
            "parse Herdr TOML config {}; no changes made",
            config_path.display()
        )
    })?;
    let router = cli.state_path().join("herdr-shell-router");
    let terminal = document["terminal"]
        .as_table_mut()
        .context("Herdr config has no [terminal] table; no changes made")?;
    ensure!(
        terminal
            .get("default_shell")
            .and_then(toml_edit::Item::as_str)
            == Some(router.to_string_lossy().as_ref()),
        "Herdr default_shell is not the ADM router; refusing to overwrite the current setting"
    );
    let original: OriginalShell = serde_json::from_slice(&fs::read(
        cli.state_path().join("herdr-original-shell.json"),
    )?)
    .context("ADM original Herdr shell record is invalid; refusing to guess a replacement")?;
    if let Some(value) = original.value {
        terminal["default_shell"] = toml_edit::value(value);
    } else {
        terminal.remove("default_shell");
    }
    write_text_atomic(&config_path, &document.to_string())?;
    println!(
        "ADM pane routing is disabled; Herdr's default shell is restored to its normal fallback."
    );
    Ok(())
}

fn route_shell(cli: &Cli, original_args: &[String]) -> Result<()> {
    if std::env::var("HERDR_ENV").as_deref() != Ok("1") {
        bail!(
            "ADM Herdr shell router requires Herdr pane context; disable it with `adm herdr disable`"
        );
    }
    let scope = current_scope(cli, None)?;
    let initial_local = std::env::var("ADM_HERDR_INITIAL_PANE").as_deref() == Ok("local")
        && claim_initial_pane(cli, &scope)?;
    let target_workspace = (!initial_local)
        .then(|| read_bindings(cli))
        .transpose()?
        .unwrap_or_default()
        .into_iter()
        .find(|binding| {
            binding.device_id == scope.device_id
                && binding.session_id == scope.session_id
                && binding.space_id == scope.space_id
        })
        .map(|binding| binding.workspace_id);
    if let Some(target_workspace) = target_workspace {
        let mut command = Command::new(std::env::current_exe()?);
        command
            .env_remove("ADM_HERDR_INITIAL_PANE")
            .args(["--state-dir"])
            .arg(cli.state_path())
            .args(["--kubectl", &cli.kubectl, "--runner-url", &cli.runner_url])
            .args(["--lifecycle-namespace", &cli.lifecycle_namespace])
            .args(["--project-dir"])
            .arg(&cli.project_dir);
        if let Some(token_file) = &cli.lifecycle_token_file {
            command.args(["--lifecycle-token-file"]).arg(token_file);
        }
        if cli.lifecycle_url_explicit {
            command.args(["--lifecycle-url", &cli.lifecycle_url]);
        }
        if let Some(kubeconfig) = &cli.kubeconfig {
            command.args(["--kubeconfig", kubeconfig]);
        }
        command.args(["shell", &target_workspace]);
        let status = command
            .status()
            .context("start the bound ADM workspace shell")?;
        ensure!(
            status.success(),
            "bound ADM workspace shell exited with {status}"
        );
        return Ok(());
    }
    let (configured, saved_args) = configured_original_shell(cli)?;
    let mut command = Command::new(configured);
    command.env_remove("ADM_HERDR_INITIAL_PANE");
    command.args(saved_args);
    command.args(original_args);
    let status = command
        .status()
        .context("start Herdr's previously configured shell")?;
    ensure!(
        status.success(),
        "Herdr's configured shell exited with {status}"
    );
    Ok(())
}

fn initial_pane_path(cli: &Cli, scope: &ScopedSpace) -> PathBuf {
    let encoded = format!(
        "{}\0{}\0{}",
        scope.device_id, scope.session_id, scope.space_id
    );
    let hash = encoded.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    cli.state_path()
        .join(format!("herdr-initial-pane-{hash:016x}"))
}

fn claim_initial_pane(cli: &Cli, scope: &ScopedSpace) -> Result<bool> {
    let path = initial_pane_path(cli, scope);
    let expected_pane = match fs::read_to_string(&path) {
        Ok(expected_pane) => expected_pane,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if std::env::var("HERDR_PANE_ID").as_deref() != Ok(expected_pane.trim()) {
        return Ok(false);
    }
    let claimed = path.with_extension("claimed");
    match fs::rename(&path, &claimed) {
        Ok(()) => {
            fs::remove_file(claimed)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn configured_original_shell(cli: &Cli) -> Result<(PathBuf, Vec<String>)> {
    let saved: OriginalShell = serde_json::from_slice(&fs::read(
        cli.state_path().join("herdr-original-shell.json"),
    )?)
    .context("ADM original Herdr shell record is invalid; disable routing to restore Herdr")?;
    let default = saved.value.unwrap_or_default();
    let default = default.trim();
    let (shell, args) = if default.is_empty() {
        (
            std::env::var_os("SHELL")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/bin/sh")),
            Vec::new(),
        )
    } else {
        (PathBuf::from(default), Vec::new())
    };
    Ok((shell, args))
}

fn status(cli: &Cli, as_json: bool) -> Result<()> {
    let routing_configured = fs::read_to_string(herdr_config_path())
        .ok()
        .and_then(|text| text.parse::<DocumentMut>().ok())
        .and_then(|doc| {
            doc.get("terminal")
                .and_then(|item| item.get("default_shell"))
                .and_then(toml_edit::Item::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|value| {
            value
                == cli
                    .state_path()
                    .join("herdr-shell-router")
                    .to_string_lossy()
        });
    let device_id = fs::read_to_string(cli.state_path().join("herdr-device-id"))
        .ok()
        .map(|value| value.trim().to_owned());
    let bindings: Vec<Value> = read_bindings(cli)?
        .into_iter()
        .filter(|binding| device_id.as_deref() == Some(binding.device_id.as_str()))
        .map(|binding| {
            json!({
                "workspace_id":binding.workspace_id,
                "workspace_name":binding.workspace_name,
                "space_id":binding.space_id,
                "session_id":binding.session_id
            })
        })
        .collect();
    let binding_count = bindings.len();
    let socket = if std::env::var("HERDR_ENV").as_deref() == Ok("1") {
        session_socket().ok()
    } else {
        None
    };
    let (live, watcher_error) = match socket.as_deref() {
        Some(socket) => match live_watcher(cli, socket) {
            Ok(healthy) => (Some(healthy), None),
            Err(error) => (Some(false), Some(format!("{error:#}"))),
        },
        None => (
            None,
            Some("run status inside the intended Herdr session".to_owned()),
        ),
    };
    let value = json!({
        "binding_count":binding_count,
        "bindings":bindings,
        "pane_routing":if routing_configured {"configured"} else {"disabled"},
        "event_delivery":match live {Some(true)=>"watching",Some(false)=>"unavailable",None=>"session_unavailable"},
        "event_delivery_error":watcher_error,
        "socket":socket,
        "replay":"Herdr has no replay cursor; closes missed while disconnected cannot be recovered"
    });
    if as_json {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!("Herdr bindings: {}", value["binding_count"]);
        for binding in value["bindings"].as_array().into_iter().flatten() {
            println!(
                "  ADM {} ({}) -> Herdr {} in {}",
                binding["workspace_name"],
                binding["workspace_id"],
                binding["space_id"],
                binding["session_id"]
            );
        }
        println!("New pane routing: {}", value["pane_routing"]);
        match value["event_delivery"].as_str().unwrap_or("unavailable") {
            "watching" => {
                println!("Close-event delivery: active watcher and socket subscription verified.")
            }
            "unavailable" => {
                println!(
                    "Close-event delivery: unavailable ({})",
                    value["event_delivery_error"]
                        .as_str()
                        .unwrap_or("watcher not running")
                );
                println!(
                    "Start `adm herdr watch --socket \"$HERDR_SOCKET_PATH\"` under a supervisor in this session. Missed close events cannot be replayed."
                );
            }
            _ => println!(
                "Close-event delivery: this command is outside Herdr; session status is unavailable."
            ),
        }
    }
    Ok(())
}

fn watcher_state_path(cli: &Cli, socket: &Path) -> PathBuf {
    let hash = socket
        .to_string_lossy()
        .bytes()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    cli.state_path()
        .join(format!("herdr-watcher-{hash:016x}.sock"))
}

fn live_watcher(cli: &Cli, socket: &Path) -> Result<bool> {
    let state_path = watcher_state_path(cli, socket);
    control_watcher(&state_path, "status").map(|response| {
        response["status"] == "watching"
            && response["subscription"] == "workspace.closed"
            && response["socket"] == socket.to_string_lossy().as_ref()
    })
}

fn control_watcher(path: &Path, command: &str) -> Result<Value> {
    let mut stream = UnixStream::connect(path)
        .with_context(|| format!("no live watcher control socket at {}", path.display()))?;
    writeln!(stream, "{}", json!({"command":command}))?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    ensure!(
        reader.read_line(&mut line)? > 0,
        "watcher control socket closed without a response"
    );
    let response: Value =
        serde_json::from_str(&line).context("watcher returned invalid control response")?;
    ensure!(
        response["error"].is_null(),
        "watcher control failed: {}",
        response["error"]
    );
    Ok(response)
}

fn stop_owned_watchers(cli: &Cli) -> Result<()> {
    let state = cli.state_path();
    if !state.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&state)? {
        let path = entry?.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("herdr-watcher-") && name.ends_with(".sock"))
        {
            let response = control_watcher(&path, "disable")?;
            ensure!(
                response["status"] == "stopping",
                "watcher at {} did not accept disable",
                path.display()
            );
        }
    }
    Ok(())
}

struct WatcherRegistration(PathBuf);
impl Drop for WatcherRegistration {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
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

fn process_event(cli: &Cli, scope: &ScopedSpace, event: &Value, compact: bool) -> Result<()> {
    let Some(space) = closed_space_id(event)? else {
        return Ok(());
    };
    let _lock = binding_lock(cli)?;
    let mut bindings = read_bindings(cli)?;
    let matching: Vec<Binding> = bindings
        .iter()
        .filter(|binding| {
            binding.device_id == scope.device_id
                && binding.session_id == scope.session_id
                && binding.space_id == space
        })
        .cloned()
        .collect();
    for binding in matching {
        record_close(cli, &binding.workspace_id)?;
        destroy_workspace_id(cli, &binding.workspace_id, compact)?;
        bindings.retain(|item| item.workspace_id != binding.workspace_id);
        write_json(cli, &bindings_path(cli), &bindings)?;
        remove_close_receipt(cli, &binding.workspace_id)?;
    }
    Ok(())
}

struct BindingLock(fs::File);
impl Drop for BindingLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn binding_lock(cli: &Cli) -> Result<BindingLock> {
    fs::create_dir_all(cli.state_path())?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(cli.state_path().join("herdr-bindings.lock"))?;
    ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0,
        "lock ADM Herdr bindings: {}",
        io::Error::last_os_error()
    );
    Ok(BindingLock(file))
}

fn close_receipt_path(cli: &Cli, workspace_id: &str) -> PathBuf {
    let hash = workspace_id
        .bytes()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    cli.state_path()
        .join(format!("herdr-closed-{hash:016x}.json"))
}

fn record_close(cli: &Cli, workspace_id: &str) -> Result<()> {
    fs::create_dir_all(cli.state_path())?;
    let path = close_receipt_path(cli, workspace_id);
    let receipt = serde_json::to_vec(&CloseReceipt {
        workspace_id: workspace_id.to_owned(),
    })?;
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(&receipt)?;
            file.sync_all()?;
            sync_directory(&cli.state_path())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let existing: CloseReceipt = serde_json::from_slice(&fs::read(path)?)?;
            ensure!(
                existing.workspace_id == workspace_id,
                "Herdr close receipt hash collision for workspace {workspace_id}"
            );
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn destroy_workspace_id(cli: &Cli, workspace_id: &str, compact: bool) -> Result<()> {
    let workspace = match cli.workspace(workspace_id, true) {
        Ok(workspace) if workspace.phase != "deleted" => workspace,
        Ok(_) => return Ok(()),
        Err(error) if format!("{error:#}").contains("workspace not found") => return Ok(()),
        Err(error) => return Err(error),
    };
    let result = cli.request_lifecycle(
        "POST",
        "/v1/operations",
        Some(&serde_json::to_value(
            lifecycle::OperationRequest::Delete {
                operation_id: workspace.id.clone(),
                workspace_id: workspace.id,
            },
        )?),
    )?;
    if compact {
        println!("{}", serde_json::to_string(&result)?);
    } else {
        crate::print_json(&result)?;
    }
    Ok(())
}

fn remove_close_receipt(cli: &Cli, workspace_id: &str) -> Result<()> {
    let path = close_receipt_path(cli, workspace_id);
    match fs::remove_file(path) {
        Ok(()) => sync_directory(&cli.state_path()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn replay_close_journal(cli: &Cli) -> Result<()> {
    if !cli.state_path().exists() {
        return Ok(());
    }
    let mut receipts = Vec::new();
    for entry in fs::read_dir(cli.state_path())? {
        let path = entry?.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("herdr-closed-") && name.ends_with(".json"))
        {
            receipts.push(path);
        }
    }
    receipts.sort();
    for path in receipts {
        let receipt: CloseReceipt = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| format!("invalid Herdr close receipt {}", path.display()))?;
        ensure!(
            !receipt.workspace_id.is_empty(),
            "Herdr close journal contains an empty ADM workspace ID"
        );
        destroy_workspace_id(cli, &receipt.workspace_id, true)?;
        remove_close_receipt(cli, &receipt.workspace_id)?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
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
    let session_socket = session_socket()?;
    ensure!(
        session_socket == socket,
        "--socket must match this Herdr pane's HERDR_SOCKET_PATH"
    );
    let scope = current_session(cli)?;
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
    let control_path = watcher_state_path(cli, socket);
    let (stop_tx, stop_rx) = mpsc::channel();
    let (stopped_tx, stopped_rx) = mpsc::channel();
    let (control_done_tx, control_done_rx) = mpsc::channel();
    let session_socket_for_control = socket.to_path_buf();
    let listener = match UnixListener::bind(&control_path) {
        Ok(listener) => listener,
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            ensure!(
                UnixStream::connect(&control_path).is_err(),
                "an ADM watcher is already running for this Herdr session"
            );
            fs::remove_file(&control_path)?;
            UnixListener::bind(&control_path)?
        }
        Err(error) => return Err(error.into()),
    };
    fs::set_permissions(&control_path, fs::Permissions::from_mode(0o600))?;
    let control_socket = control_path.clone();
    let herdr_shutdown = api.writer.try_clone()?;
    thread::spawn(move || {
        for incoming in listener.incoming() {
            let Ok(stream) = incoming else { break };
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            let response = match reader.read_line(&mut line) {
                Ok(0) => continue,
                Ok(_) => match serde_json::from_str::<WatcherCommand>(&line) {
                    Ok(WatcherCommand { command }) if command == "status" => json!({
                        "status":"watching","subscription":"workspace.closed","socket":session_socket_for_control.to_string_lossy(),"pid":std::process::id()
                    }),
                    Ok(WatcherCommand { command }) if command == "disable" => {
                        let _ = stop_tx.send(());
                        let _ = herdr_shutdown.shutdown(std::net::Shutdown::Both);
                        let _ = stopped_rx.recv();
                        json!({"status":"stopping"})
                    }
                    Ok(_) => json!({"error":"unknown watcher control command"}),
                    Err(error) => json!({"error":error.to_string()}),
                },
                Err(error) => json!({"error":error.to_string()}),
            };
            let mut stream = reader.into_inner();
            let _ = writeln!(stream, "{response}");
            let _ = stream.flush();
            if response["status"] == "stopping" {
                let _ = control_done_tx.send(());
                break;
            }
        }
        let _ = fs::remove_file(control_socket);
    });
    let _registration = WatcherRegistration(control_path);
    println!(
        "{}",
        serde_json::to_string(&json!({
            "status":"watching","event":"workspace.closed","socket":socket,
            "recovery":"replays locally journaled ADM workspace IDs; Herdr has no replay cursor, so disconnected close events cannot be recovered"
        }))?
    );
    while let Some(event) = api.queued_events.pop_front() {
        process_event(cli, &scope, &event, true)?;
    }
    loop {
        match api.next_event() {
            Ok(event) => process_event(cli, &scope, &event, true)?,
            Err(_) if stop_rx.try_recv().is_ok() => {
                let _ = stopped_tx.send(());
                let _ = control_done_rx.recv();
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    }
}
