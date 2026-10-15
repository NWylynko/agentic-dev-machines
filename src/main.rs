mod diagnostics;
mod herdr;
mod runner;
mod setup;
mod workspaces;

use anyhow::{Context, Result};
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand, parser::ValueSource};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};
use workspaces::{CreateOptions, WorkspaceStore};

#[derive(Parser)]
#[command(
    name = "adm",
    version,
    about = "Isolated Kubernetes workspaces and durable unattended agents"
)]
pub struct Cli {
    #[arg(long, global = true, env = "ADM_STATE_DIR")]
    pub state_dir: Option<PathBuf>,
    #[arg(long, global = true, default_value = "kubectl")]
    pub kubectl: String,
    #[arg(long, global = true, default_value = "http://127.0.0.1:7432")]
    pub runner_url: String,
    /// Runtime installation or development checkout containing the runner and terminal.
    #[arg(long, global = true, env = "ADM_PROJECT_DIR", default_value_os_t = default_project_dir())]
    pub project_dir: PathBuf,
    #[command(subcommand)]
    pub command: Action,
}

#[derive(Subcommand)]
pub enum Action {
    /// Create an isolated workspace or a repository-free bot.
    Create(CreateOptions),
    /// Print provisioning resources without mutating the cluster.
    Manifest(CreateOptions),
    /// List locally owned workspaces.
    List {
        #[arg(long)]
        all: bool,
    },
    /// Inspect a workspace's local, cluster, and agent state.
    Status { name: String },
    /// Permanently stop a workspace and remove its owned resources.
    Destroy { name: String },
    /// Open the reconnectable Pi-style terminal client.
    Attach {
        name: String,
        #[arg(long)]
        diagnostics: bool,
    },
    /// Open a development shell. Terminal exit does not destroy the space.
    Shell {
        name: String,
        #[arg(last = true)]
        command: Vec<String>,
    },
    /// Run a command inside the development container.
    Exec {
        name: String,
        #[arg(last = true, required = true)]
        command: Vec<String>,
    },
    /// Forward a development port to the management host.
    Port {
        name: String,
        port: u16,
        #[arg(long)]
        local_port: Option<u16>,
        #[arg(long, default_value = "127.0.0.1")]
        bind: String,
    },
    /// Send work without keeping a terminal attached.
    Prompt {
        name: String,
        message: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    /// Stop current work; optionally include background loops.
    Abort {
        name: String,
        #[arg(long)]
        background: bool,
    },
    /// Inspect a session's persisted history.
    History {
        name: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Manage the supervised durable runner.
    Start,
    /// Run the durable runner in the foreground.
    Serve,
    /// Stop only the runner process, preserving recoverable work.
    Stop,
    /// Check prerequisites, cluster access, storage, and runner health.
    Doctor {
        /// StorageClass to inspect; otherwise use the configured default.
        #[arg(long, default_value = "adm-replicated", hide_default_value = true)]
        storage_class: String,
    },
    /// Configure workspace defaults, provider login, and the background service.
    Setup,
    /// Open the installed Pi provider login interface; use /login there.
    Login,
    /// Bridge explicit Herdr lifecycle events to workspace ownership.
    Herdr {
        #[command(subcommand)]
        command: herdr::HerdrAction,
    },
    /// Run Chromium automation inside a development workspace.
    Browser {
        name: String,
        url: String,
        #[arg(long)]
        screenshot: Option<String>,
    },
}

fn default_project_dir() -> PathBuf {
    if let Ok(executable) = std::env::current_exe()
        && let Some(root) = executable.parent().and_then(|bin| bin.parent())
        && (root.join("runtime").is_dir() || root.join("VERSION").is_file())
    {
        return root.to_path_buf();
    }
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if compiled.join("packages/runner/src/main.ts").is_file() {
        return compiled;
    }
    if let Ok(mut current) = std::env::current_dir() {
        loop {
            if current.join("packages/runner/src/main.ts").is_file() {
                return current;
            }
            if !current.pop() {
                break;
            }
        }
    }
    compiled
}

impl Cli {
    pub fn checkout_file(&self, relative: &str) -> Result<PathBuf> {
        let path = self.project_dir.join(relative);
        anyhow::ensure!(
            path.is_file(),
            "missing {relative} under {}; reinstall with install.sh, or pass --project-dir pointing at an ADM checkout",
            self.project_dir.display()
        );
        Ok(path)
    }

    pub fn runtime_command(&self, component: &str) -> Result<Command> {
        let mut command = Command::new("node");
        command.current_dir(&self.project_dir);
        if self.project_dir.join("runtime").is_dir() {
            command.arg(self.checkout_file(&format!("runtime/{component}.mjs"))?);
        } else {
            command
                .args(["--import", "tsx"])
                .arg(self.checkout_file(&format!("packages/{component}/src/main.ts"))?);
        }
        Ok(command)
    }

    pub fn state_path(&self) -> PathBuf {
        self.state_dir.clone().unwrap_or_else(|| {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(std::env::var_os("HOME").expect("HOME must be set"))
                        .join(".local/share")
                })
                .join("adm")
        })
    }
    pub fn store(&self) -> Result<WorkspaceStore> {
        WorkspaceStore::open(&self.state_path())
    }
    pub fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        runner::request(&self.runner_url, method, path, body)
    }
}

pub fn print_json(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn run(cli: &Cli) -> Result<()> {
    match &cli.command {
        Action::Create(options) => print_json(&workspaces::create(cli, options)?),
        Action::Manifest(options) => print_json(&workspaces::manifest(&options.workspace()?)?),
        Action::List { all } => print_json(&cli.store()?.list(*all)?),
        Action::Status { name } => {
            let workspace = cli.store()?.find(name)?;
            let cluster = if workspace.role == "coding" && workspace.phase != "deleted" {
                match workspaces::cluster_status(cli, &workspace) {
                    Ok(value) => value,
                    Err(error) => json!({"status":"unavailable","error":error.to_string()}),
                }
            } else {
                json!(null)
            };
            let agent = if workspace.agent_enabled && workspace.phase != "deleted" {
                match cli.request("GET", &format!("/v1/workspaces/{}", workspace.id), None) {
                    Ok(value) => value,
                    Err(error) => json!({"status":"unavailable","error":error.to_string()}),
                }
            } else {
                json!({"status":"disabled"})
            };
            print_json(&json!({"workspace":workspace,"cluster":cluster,"agent":agent}))
        }
        Action::Destroy { name } => print_json(&workspaces::destroy(cli, name)?),
        Action::Attach { name, diagnostics } => {
            let workspace = cli.store()?.active(name)?;
            anyhow::ensure!(
                workspace.agent_enabled,
                "workspace has no agent; use adm shell"
            );
            runner::ensure_started(cli)?;
            let mut command = cli.runtime_command("terminal")?;
            command.args(["--url", &cli.runner_url, "--workspace", &workspace.id]);
            if *diagnostics {
                command.arg("--diagnostics");
            }
            let status = command.status().context("start terminal client")?;
            anyhow::ensure!(status.success(), "terminal exited with {status}");
            Ok(())
        }
        Action::Shell { name, command } | Action::Exec { name, command } => {
            let workspace = cli.store()?.active(name)?;
            anyhow::ensure!(
                workspace.role == "coding",
                "bots have no development shell or repository access"
            );
            workspaces::verify_ownership(cli, &workspace)?;
            let mut child = Command::new(&cli.kubectl);
            child.args([
                "exec",
                "-n",
                &workspace.namespace,
                "deployment/workspace",
                "-c",
                "dev",
            ]);
            if matches!(&cli.command, Action::Shell { .. }) {
                child.arg("-it");
            }
            child.arg("--");
            if command.is_empty() {
                child.args(["bash", "-l"]);
            } else {
                child.args(command);
            }
            let status = child.status().context("connect to development container")?;
            anyhow::ensure!(status.success(), "remote command exited with {status}");
            Ok(())
        }
        Action::Port {
            name,
            port,
            local_port,
            bind,
        } => {
            anyhow::ensure!(
                bind == "127.0.0.1" || bind == "::1",
                "port forwarding must bind to loopback; use SSH forwarding from your MacBook"
            );
            let workspace = cli.store()?.active(name)?;
            anyhow::ensure!(workspace.role == "coding", "bots have no development ports");
            workspaces::verify_ownership(cli, &workspace)?;
            let local = local_port.unwrap_or(*port);
            eprintln!(
                "Preview: http://{bind}:{local}  (forward this management-host port over SSH from your MacBook)"
            );
            let status = Command::new(&cli.kubectl)
                .args([
                    "port-forward",
                    "-n",
                    &workspace.namespace,
                    "deployment/workspace",
                    "--address",
                    bind,
                    &format!("{local}:{port}"),
                ])
                .status()?;
            anyhow::ensure!(
                status.success(),
                "port connection interrupted; rerun adm port against the same workspace identity"
            );
            Ok(())
        }
        Action::Prompt {
            name,
            message,
            request_id,
        } => {
            let workspace = cli.store()?.active(name)?;
            anyhow::ensure!(workspace.agent_enabled, "workspace has no agent");
            runner::ensure_started(cli)?;
            let body = match request_id {
                Some(request_id) => json!({"message":message,"requestId":request_id}),
                None => json!({"message":message}),
            };
            print_json(&cli.request(
                "POST",
                &format!("/v1/workspaces/{}/input", workspace.id),
                Some(&body),
            )?)
        }
        Action::Abort { name, background } => {
            let workspace = cli.store()?.active(name)?;
            print_json(&cli.request(
                "POST",
                &format!("/v1/workspaces/{}/abort", workspace.id),
                Some(&json!({"background":background})),
            )?)
        }
        Action::History { name, after } => {
            let workspace = cli.store()?.find(name)?;
            print_json(&cli.request(
                "GET",
                &format!("/v1/workspaces/{}/history?after={after}", workspace.id),
                None,
            )?)
        }
        Action::Start => {
            runner::ensure_started(cli)?;
            print_json(&json!({"status":"ready","url":cli.runner_url}))
        }
        Action::Serve => runner::serve(cli),
        Action::Stop => runner::stop(cli),
        Action::Doctor { storage_class } => diagnostics::doctor(cli, storage_class),
        Action::Setup => setup::run(cli),
        Action::Login => setup::login(cli),
        Action::Herdr { command } => herdr::run(cli, command),
        Action::Browser {
            name,
            url,
            screenshot,
        } => {
            let workspace = cli.store()?.active(name)?;
            anyhow::ensure!(
                workspace.role == "coding",
                "bots have no coding browser environment"
            );
            workspaces::verify_ownership(cli, &workspace)?;
            let mut command = Command::new(&cli.kubectl);
            command.args([
                "exec",
                "-n",
                &workspace.namespace,
                "deployment/workspace",
                "-c",
                "dev",
                "--",
                "node",
                "/opt/adm/browser.mjs",
                url,
            ]);
            if let Some(path) = screenshot {
                command.args(["--screenshot", path]);
            }
            command.stdin(Stdio::null());
            let status = command.status()?;
            anyhow::ensure!(status.success(), "browser automation failed");
            Ok(())
        }
    }
}

fn main() {
    let matches = Cli::command().get_matches();
    let mut cli = Cli::from_arg_matches(&matches).expect("validated CLI arguments");
    if let Err(error) = configure_defaults(&mut cli, &matches).and_then(|()| run(&cli)) {
        eprintln!("adm: {error:#}");
        std::process::exit(1);
    }
}

fn configure_defaults(cli: &mut Cli, matches: &clap::ArgMatches) -> Result<()> {
    match &cli.command {
        Action::Create(_) | Action::Manifest(_) | Action::Doctor { .. } => {}
        _ => return Ok(()),
    }
    let config = setup::read_config()?;
    let (_, arguments) = matches.subcommand().expect("required CLI command");
    let image = if matches!(&cli.command, Action::Create(_) | Action::Manifest(_))
        && arguments.value_source("image") == Some(ValueSource::DefaultValue)
    {
        Some(match config.image {
            Some(image) => image,
            None => setup::default_image(cli)?,
        })
    } else {
        None
    };
    match &mut cli.command {
        Action::Create(options) | Action::Manifest(options) => {
            if let Some(image) = image {
                options.image = image;
            }
            if arguments.value_source("storage_class") == Some(ValueSource::DefaultValue)
                && let Some(storage_class) = config.storage_class
            {
                options.storage_class = storage_class;
            }
            if options.model.is_none() && !options.no_agent {
                options.model = config.model;
            }
            if let Some(model) = &options.model {
                setup::validate_model(model)?;
            }
        }
        Action::Doctor { storage_class } => {
            if arguments.value_source("storage_class") == Some(ValueSource::DefaultValue)
                && let Some(configured) = config.storage_class
            {
                *storage_class = configured;
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}
