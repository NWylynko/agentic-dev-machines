use crate::Cli;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

fn config_home() -> Result<PathBuf> {
    let path = match std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => home()?.join(".config"),
    };
    ensure!(
        path.is_absolute(),
        "XDG_CONFIG_HOME must be an absolute path"
    );
    Ok(path)
}

fn home() -> Result<PathBuf> {
    let path = PathBuf::from(std::env::var_os("HOME").context("HOME must be set")?);
    ensure!(path.is_absolute(), "HOME must be an absolute path");
    Ok(path)
}

fn validate_value(value: &str, field: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && !value.chars().any(char::is_whitespace),
        "{field} must be nonempty and contain no whitespace"
    );
    Ok(())
}

pub fn validate_model(model: &str) -> Result<()> {
    validate_value(model, "model")?;
    let (provider, id) = model
        .split_once('/')
        .context("model must be PROVIDER/MODEL_ID")?;
    ensure!(
        !provider.is_empty() && !id.is_empty(),
        "model must be PROVIDER/MODEL_ID"
    );
    Ok(())
}

impl Config {
    fn validate(&self) -> Result<()> {
        if let Some(image) = &self.image {
            validate_value(image, "image")?;
        }
        if let Some(storage_class) = &self.storage_class {
            validate_value(storage_class, "storageClass")?;
        }
        if let Some(model) = &self.model {
            validate_model(model)?;
        }
        Ok(())
    }
}

pub fn read_config() -> Result<Config> {
    let path = config_home()?.join("adm/config.json");
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let config: Config =
        serde_json::from_slice(&contents).with_context(|| format!("parse {}", path.display()))?;
    config
        .validate()
        .with_context(|| format!("invalid {}", path.display()))?;
    Ok(config)
}

pub fn default_image(cli: &Cli) -> Result<String> {
    let path = cli.project_dir.join("IMAGE");
    match fs::read_to_string(&path) {
        Ok(image) => {
            let image = image.trim();
            validate_value(image, "release IMAGE")?;
            Ok(image.to_owned())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok("ghcr.io/nwylynko/agentic-dev-machines:latest".into())
        }
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn prompt(label: &str, default: &str) -> Result<String> {
    print!("{label} [{default}]: ");
    io::stdout().flush()?;
    let mut answer = String::new();
    ensure!(
        io::stdin().read_line(&mut answer)? != 0,
        "setup input ended; rerun adm setup in a terminal"
    );
    let answer = answer.trim();
    Ok(if answer.is_empty() { default } else { answer }.to_owned())
}

fn confirm(label: &str) -> Result<bool> {
    let answer = prompt(label, "y/N")?;
    match answer.to_ascii_lowercase().as_str() {
        "y" | "yes" => Ok(true),
        "n" | "no" | "y/n" => Ok(false),
        _ => anyhow::bail!("answer yes or no; rerun adm setup"),
    }
}

fn save_config(config: &Config) -> Result<PathBuf> {
    let path = config_home()?.join("adm/config.json");
    fs::create_dir_all(path.parent().expect("config parent"))?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    serde_json::to_writer_pretty(&mut file, config)?;
    writeln!(file)?;
    file.sync_all()?;
    fs::rename(&temporary, &path).with_context(|| format!("save {}", path.display()))?;
    Ok(path)
}

pub fn run(cli: &Cli) -> Result<()> {
    let mut config = read_config()?;
    println!("ADM setup. Kubernetes access and storage must already be configured.");
    let image = match &config.image {
        Some(image) => image.clone(),
        None => default_image(cli)?,
    };
    config.image = Some(prompt("Workspace image", &image)?);
    config.storage_class = Some(prompt(
        "StorageClass",
        config.storage_class.as_deref().unwrap_or("adm-replicated"),
    )?);
    let model = prompt(
        "Default model PROVIDER/MODEL_ID (optional; '-' clears)",
        config.model.as_deref().unwrap_or(""),
    )?;
    config.model = if model.is_empty() || model == "-" {
        None
    } else {
        Some(model)
    };
    config.validate()?;
    let should_login = confirm("Open local Pi login now?")?;
    let should_install_service = confirm("Install and start the user runner service?")?;
    let path = save_config(&config)?;
    println!("Saved {}", path.display());
    if should_login {
        login(cli)?;
    }
    if should_install_service && install_service(cli)? {
        println!("Run adm doctor to check the host and cluster.");
    } else {
        println!("Run adm doctor to check the host and cluster, then adm start.");
    }
    Ok(())
}

fn find_node() -> Result<PathBuf> {
    let search = std::env::var_os("PATH").context("PATH must be set to find Node")?;
    for directory in std::env::split_paths(&search) {
        let candidate = directory.join("node");
        if candidate.is_file() && fs::metadata(&candidate)?.permissions().mode() & 0o111 != 0 {
            return fs::canonicalize(candidate).context("resolve Node executable");
        }
    }
    anyhow::bail!("Node 24 or newer must be on PATH before installing the runner service")
}

fn systemd_quote(value: &str, command: bool) -> Result<String> {
    ensure!(
        !value.contains(['\n', '\r']),
        "service paths must not contain newlines"
    );
    let value = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    Ok(format!(
        "\"{}\"",
        if command {
            value.replace('$', "$$")
        } else {
            value
        }
    ))
}

fn systemctl(arguments: &[&str]) -> Result<()> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(arguments)
        .status()
        .context("run systemctl --user; a running systemd user manager is required")?;
    ensure!(
        status.success(),
        "systemctl --user {} exited with {status}",
        arguments.join(" ")
    );
    Ok(())
}

fn install_service(cli: &Cli) -> Result<bool> {
    let executable = home()?.join(".local/bin/adm");
    ensure!(
        executable.is_file() && fs::metadata(&executable)?.permissions().mode() & 0o111 != 0,
        "install ADM at {} before installing the user service",
        executable.display()
    );
    let executable = executable
        .to_str()
        .context("ADM path must contain valid UTF-8")?;
    ensure!(
        !executable.contains(['$', '"', '\\']) && !executable.chars().any(char::is_control),
        "systemd user service installation requires an ADM executable path without dollar signs, quotes, backslashes or control characters"
    );
    let node = find_node()?;
    let inherited_path = std::env::var("PATH").context("PATH must contain valid UTF-8")?;
    let node_directory = node
        .parent()
        .expect("Node executable parent")
        .to_str()
        .context("Node path must contain valid UTF-8")?;
    let path = systemd_quote(&format!("PATH={node_directory}:{inherited_path}"), false)?;
    let executable = systemd_quote(executable, true)?;
    let state_directory = std::path::absolute(cli.state_path())?;
    let state = systemd_quote(
        state_directory
            .to_str()
            .context("state path must contain valid UTF-8")?,
        true,
    )?;
    let url = systemd_quote(&cli.runner_url, true)?;
    let kubectl = systemd_quote(&cli.kubectl, true)?;
    let unit = format!(
        "# Managed by adm setup.\n[Unit]\nDescription=ADM durable coding and bot runner\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment={path}\nExecStart={executable} --state-dir {state} --runner-url {url} --kubectl {kubectl} serve\nRestart=on-failure\nRestartSec=3\nKillMode=control-group\nTimeoutStopSec=60\nUMask=0077\n\n[Install]\nWantedBy=default.target\n"
    );
    let service_path = config_home()?.join("systemd/user/adm-runner.service");
    match fs::read_to_string(&service_path) {
        Ok(existing) if existing != unit => {
            if !confirm(&format!("Replace existing {}?", service_path.display()))? {
                println!("Kept existing user service.");
                return Ok(false);
            }
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("read {}", service_path.display()));
        }
    }
    ensure_no_standalone_runner(&state_directory)?;
    fs::create_dir_all(service_path.parent().expect("service parent"))?;
    fs::write(&service_path, unit).with_context(|| format!("write {}", service_path.display()))?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "adm-runner.service"])?;
    systemctl(&["restart", "adm-runner.service"])?;
    println!(
        "User runner service enabled. Staying up after logout requires operator-configured lingering."
    );
    println!(
        "The service does not inherit login-shell provider keys. Configure credentials for each workspace using Pi login or an operator-managed credential source."
    );
    Ok(true)
}

fn ensure_no_standalone_runner(state: &std::path::Path) -> Result<()> {
    let pid_path = state.join("runner.pid");
    let pid = match fs::read_to_string(&pid_path) {
        Ok(pid) => pid
            .trim()
            .parse::<u32>()
            .context("invalid runner.pid; inspect existing runner state")?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("read {}", pid_path.display())),
    };
    ensure!(pid > 0, "invalid runner.pid; inspect existing runner state");
    let command = match fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(command) => command,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("inspect existing runner process"),
    };
    let arguments: Vec<_> = command.split(|byte| *byte == 0).collect();
    if !arguments.iter().any(|argument| {
        argument.ends_with(b"/runtime/runner.mjs")
            || argument.ends_with(b"/packages/runner/src/main.ts")
    }) {
        return Ok(());
    }
    use std::os::unix::ffi::OsStrExt;
    let Some(directory) = arguments
        .windows(2)
        .find(|parts| parts[0] == b"--state-dir")
    else {
        return Ok(());
    };
    let directory = std::path::Path::new(std::ffi::OsStr::from_bytes(directory[1]));
    let directory = if directory.is_absolute() {
        directory.to_path_buf()
    } else {
        fs::read_link(format!("/proc/{pid}/cwd"))?.join(directory)
    };
    ensure!(
        directory != state.join("runner"),
        "a standalone runner is using this state; run adm stop with the same --state-dir, then rerun adm setup to install the user service"
    );
    Ok(())
}

pub fn login(cli: &Cli) -> Result<()> {
    let entry =
        cli.checkout_file("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")?;
    println!(
        "Use /login in Pi to authenticate. This configures Pi's local store; coding workspaces use their own credential store or explicitly configured credential references."
    );
    let status = Command::new("node")
        .arg(entry)
        .args([
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
        ])
        .status()
        .context("launch pinned Pi provider login")?;
    ensure!(status.success(), "Pi login exited with {status}");
    Ok(())
}
