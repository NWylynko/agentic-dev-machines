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
    /// Host kubeconfig file list used by coding agents; defaults to ~/.kube/config.
    #[arg(long, global = true, env = "KUBECONFIG")]
    pub kubeconfig: Option<String>,
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
        /// Print complete workspace records as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Show a concise local, cluster, and agent summary.
    Status {
        name: String,
        /// Print the complete local, cluster, and agent records as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Show detailed local, cluster, and agent diagnostics.
    Inspect {
        name: String,
        /// Print the complete local, cluster, and agent records as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Permanently stop a workspace and remove its owned resources.
    Destroy { name: String },
    /// Rebind a Kubernetes coding workspace to the selected host connection without replacing it.
    Reconnect { name: String },
    /// Open the reconnectable Pi-style terminal client.
    Attach {
        name: String,
        #[arg(long)]
        diagnostics: bool,
    },
    /// Open a development shell. Terminal exit does not destroy the space.
    Shell {
        name: String,
        /// Expose current-workspace status, history, prompt, and abort inside this shell.
        #[arg(long)]
        manage: bool,
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
    fn help_command() -> clap::Command {
        const WORKSPACE: &[&str] = &[
            "create",
            "list",
            "status",
            "inspect",
            "destroy",
            "reconnect",
            "attach",
            "shell",
            "exec",
            "port",
            "prompt",
            "abort",
            "history",
            "browser",
        ];
        const MANAGEMENT: &[&str] = &[
            "manifest", "setup", "login", "start", "serve", "stop", "doctor", "herdr", "help",
        ];
        let mut command = Self::command();
        command.build();
        let grouped = |names: &[&str], command: &clap::Command| {
            names
                .iter()
                .filter_map(|name| {
                    command.find_subcommand(name).map(|subcommand| {
                        format!(
                            "  {:<16} {}",
                            subcommand.get_name(),
                            subcommand.get_about().unwrap_or_default()
                        )
                    })
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let template = format!(
            "{{before-help}}{{name}} {{version}}\n{{about-with-newline}}{{usage-heading}} {{usage}}\n\nWorkspace use:\n{}\n\nADM management:\n{}\n\nOptions:\n{{options}}{{after-help}}",
            grouped(WORKSPACE, &command),
            grouped(MANAGEMENT, &command)
        );
        command = command.help_template(template);
        command
    }

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
        } else if component == "shell-management" {
            command
                .args(["--import", "tsx"])
                .arg(self.checkout_file("packages/runner/src/shell-management.ts")?);
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
    pub fn kubeconfig_reference(&self) -> Result<String> {
        let configured = self.kubeconfig.as_deref().filter(|value| !value.is_empty());
        let value = if let Some(configured) = configured {
            configured.to_owned()
        } else {
            let default = PathBuf::from(
                std::env::var_os("HOME").context("HOME must be set when KUBECONFIG is unset")?,
            )
            .join(".kube/config");
            let default = if default.is_absolute() {
                default
            } else {
                std::env::current_dir()?.join(default)
            };
            default
                .into_os_string()
                .into_string()
                .map_err(|_| anyhow::anyhow!("default kubeconfig path must be valid UTF-8"))?
        };
        let paths = value
            .split(':')
            .map(|entry| {
                anyhow::ensure!(
                    !entry.is_empty(),
                    "KUBECONFIG must not contain empty path entries"
                );
                let path = PathBuf::from(entry);
                let absolute = if path.is_absolute() {
                    path
                } else {
                    std::env::current_dir()?.join(path)
                };
                let text = absolute
                    .into_os_string()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("KUBECONFIG paths must be valid UTF-8"))?;
                anyhow::ensure!(
                    !text.contains('\0'),
                    "KUBECONFIG paths must not contain NUL bytes"
                );
                Ok(text)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(paths.join(":"))
    }
    pub fn kubectl_command(&self) -> Result<Command> {
        let mut command = Command::new(&self.kubectl);
        command.env("KUBECONFIG", self.kubeconfig_reference()?);
        Ok(command)
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

fn print_workspace_list(items: &[workspaces::Workspace]) {
    if items.is_empty() {
        println!("No workspaces");
        return;
    }

    let rows = items
        .iter()
        .map(|workspace| {
            [
                workspace.name.as_str(),
                workspace.role.as_str(),
                workspace.phase.as_str(),
                if workspace.agent_enabled {
                    "enabled"
                } else {
                    "disabled"
                },
                workspace.id.as_str(),
            ]
        })
        .collect::<Vec<_>>();
    let headers = ["NAME", "ROLE", "PHASE", "AGENT", "ID"];
    let widths = std::array::from_fn::<_, 5, _>(|column| {
        rows.iter()
            .map(|row| row[column].len())
            .max()
            .unwrap_or(0)
            .max(headers[column].len())
    });

    for row in std::iter::once(headers.as_slice()).chain(rows.iter().map(|row| row.as_slice())) {
        println!(
            "{:<name$}  {:<role$}  {:<phase$}  {:<agent$}  {}",
            row[0],
            row[1],
            row[2],
            row[3],
            row[4],
            name = widths[0],
            role = widths[1],
            phase = widths[2],
            agent = widths[3],
        );
    }
}

fn workspace_status(cli: &Cli, name: &str) -> Result<Value> {
    let workspace = cli.store()?.find(name)?;
    let cluster = if workspace.role == "coding" && workspace.phase != "deleted" {
        match workspaces::cluster_status(cli, &workspace) {
            Ok(value) => value,
            Err(error) => json!({"status":"unavailable","error":error.to_string()}),
        }
    } else {
        Value::Null
    };
    let agent = if workspace.agent_enabled && workspace.phase != "deleted" {
        match cli.request("GET", &format!("/v1/workspaces/{}", workspace.id), None) {
            Ok(value) => value,
            Err(error) => json!({"status":"unavailable","error":error.to_string()}),
        }
    } else {
        json!({"status":"disabled"})
    };
    Ok(json!({"workspace":workspace,"cluster":cluster,"agent":agent}))
}

fn pod_summary(status: &Value) -> (String, String) {
    let Some(pod) = status["cluster"]["pods"]
        .as_array()
        .and_then(|pods| pods.first())
    else {
        return ("missing".into(), "—".into());
    };
    let phase = pod["status"]["phase"].as_str().unwrap_or("Unknown");
    let ready_condition = pod["status"]["conditions"]
        .as_array()
        .and_then(|conditions| {
            conditions
                .iter()
                .find(|condition| condition["type"] == "Ready")
        });
    let containers = pod["status"]["containerStatuses"].as_array();
    let containers_ready = containers.is_none_or(|containers| {
        containers
            .iter()
            .all(|container| container["ready"] == true)
    });
    let readiness = if ready_condition.is_some_and(|condition| condition["status"] == "True")
        && containers_ready
    {
        "Ready".to_owned()
    } else if ready_condition.is_some_and(|condition| condition["status"] == "False")
        || containers.is_some_and(|_| !containers_ready)
    {
        format!("NotReady ({phase})")
    } else if phase == "Pending" {
        "Pending".to_owned()
    } else {
        format!("Unknown ({phase})")
    };
    let node = pod["spec"]["nodeName"]
        .as_str()
        .filter(|node| !node.is_empty())
        .unwrap_or("—");
    (readiness, node.to_owned())
}

fn status_row(status: &Value) -> [String; 6] {
    let workspace = &status["workspace"];
    let role = workspace["role"].as_str().unwrap_or("unknown");
    let phase = workspace["phase"].as_str().unwrap_or("unknown");
    let (pod, node) = if phase == "deleted" {
        ("deleted".into(), "—".into())
    } else if role == "bot" {
        ("n/a".into(), "management host".into())
    } else if status["cluster"]["status"] == "unavailable" {
        ("unavailable".into(), "—".into())
    } else if status["cluster"].is_null() {
        ("n/a".into(), "—".into())
    } else {
        pod_summary(status)
    };
    let agent = status["agent"]["status"].as_str().unwrap_or("unknown");
    [
        workspace["name"].as_str().unwrap_or("unknown").into(),
        role.into(),
        phase.into(),
        pod,
        agent.into(),
        node,
    ]
}

fn print_status(status: &Value) {
    let headers = ["NAME", "ROLE", "PHASE", "POD", "AGENT", "NODE"];
    let row = status_row(status);
    let widths =
        std::array::from_fn::<_, 6, _>(|column| row[column].len().max(headers[column].len()));
    println!(
        "{:<name$}  {:<role$}  {:<phase$}  {:<pod$}  {:<agent$}  {}",
        headers[0],
        headers[1],
        headers[2],
        headers[3],
        headers[4],
        headers[5],
        name = widths[0],
        role = widths[1],
        phase = widths[2],
        pod = widths[3],
        agent = widths[4]
    );
    println!(
        "{:<name$}  {:<role$}  {:<phase$}  {:<pod$}  {:<agent$}  {}",
        row[0],
        row[1],
        row[2],
        row[3],
        row[4],
        row[5],
        name = widths[0],
        role = widths[1],
        phase = widths[2],
        pod = widths[3],
        agent = widths[4]
    );
    if let Some(error) = status["cluster"]["error"].as_str() {
        println!("Cluster unavailable: {error}");
    }
    if let Some(error) = status["agent"]["error"].as_str() {
        match status["agent"]["status"].as_str() {
            Some("unavailable") => println!("Agent unavailable: {error}"),
            Some("error") => println!("Agent failure: {error}"),
            _ => println!("Agent error: {error}"),
        }
    }
    if let Some(error) = status["workspace"]["last_error"].as_str() {
        println!("Workspace failure: {error}");
    }
    if let Some(pod) = status["cluster"]["pods"]
        .as_array()
        .and_then(|pods| pods.first())
    {
        let readiness_reason = pod["status"]["conditions"]
            .as_array()
            .and_then(|conditions| {
                conditions
                    .iter()
                    .find(|condition| condition["type"] == "Ready")
            })
            .filter(|condition| condition["status"] != "True")
            .and_then(|condition| {
                condition["message"]
                    .as_str()
                    .or_else(|| condition["reason"].as_str())
            });
        if let Some(reason) = readiness_reason {
            println!("Pod readiness: {reason}");
        }
        for (kind, key) in [
            ("Container", "containerStatuses"),
            ("Init container", "initContainerStatuses"),
        ] {
            let Some(containers) = pod["status"][key].as_array() else {
                continue;
            };
            for container in containers
                .iter()
                .filter(|container| container["ready"] == false)
            {
                let Some((state, detail)) = container["state"]
                    .as_object()
                    .and_then(|states| states.iter().next())
                else {
                    continue;
                };
                let reason = detail["reason"].as_str();
                let message = detail["message"].as_str();
                let description = match (reason, message) {
                    (Some(reason), Some(message)) => format!("{reason}: {message}"),
                    (Some(reason), None) => reason.to_owned(),
                    (None, Some(message)) => message.to_owned(),
                    (None, None) => continue,
                };
                println!(
                    "{kind} {} {state}: {description}",
                    container["name"].as_str().unwrap_or("unknown")
                );
            }
        }
    }
}

fn print_inspect(status: &Value) -> Result<()> {
    let workspace = &status["workspace"];
    println!("Workspace");
    for (label, key) in [
        ("Name", "name"),
        ("ID", "id"),
        ("Role", "role"),
        ("Local phase", "phase"),
        ("Namespace", "namespace"),
        ("Repository", "repository"),
        ("Working directory", "cwd"),
        ("Image", "image"),
        ("Storage class", "storage_class"),
        ("Storage size", "storage_size"),
        ("CPU", "cpu"),
        ("Memory", "memory"),
        ("Agent enabled", "agent_enabled"),
        ("Repositories", "repositories"),
        ("Model", "model"),
        ("Herdr space", "herdr_space"),
        ("Created at", "created_at"),
        ("Last error", "last_error"),
    ] {
        let value = &workspace[key];
        let rendered = match value {
            Value::Null => "—".to_owned(),
            Value::String(text) => text.clone(),
            _ => serde_json::to_string(value)?,
        };
        println!("  {label}: {rendered}");
    }

    let cluster = &status["cluster"];
    println!("Cluster");
    if cluster.is_null() {
        if workspace["role"] == "bot" {
            println!("  Location: management host (no workspace Pod)");
        } else if workspace["phase"] == "deleted" {
            println!("  Runtime: destroyed (workspace deleted)");
        } else {
            println!("  Pod: not queried");
        }
    } else if let Some(error) = cluster["error"].as_str() {
        println!("  Unavailable: {error}");
    } else {
        println!(
            "  Namespace: {}",
            cluster["namespace"].as_str().unwrap_or("unknown")
        );
        if let Some(pods) = cluster["pods"].as_array() {
            if pods.is_empty() {
                println!("  Pods: none");
            }
            for pod in pods {
                let name = pod["metadata"]["name"].as_str().unwrap_or("unnamed");
                let phase = pod["status"]["phase"].as_str().unwrap_or("Unknown");
                let (readiness, node) = pod_summary(&json!({"cluster":{"pods":[pod]}}));
                println!("  Pod {name}: {readiness}; phase {phase}; node {node}");
                println!("    Details: {}", serde_json::to_string(&pod["status"])?);
            }
        }
    }
    println!("Agent");
    if let Some(object) = status["agent"].as_object() {
        for (key, value) in object {
            let rendered = match value {
                Value::Null => "—".to_owned(),
                Value::String(text) => text.clone(),
                _ => serde_json::to_string(value)?,
            };
            println!("  {key}: {rendered}");
        }
    } else {
        println!("  {}", status["agent"]);
    }
    Ok(())
}

fn run(cli: &Cli) -> Result<()> {
    match &cli.command {
        Action::Create(options) => {
            let workspace = workspaces::create(cli, options)?;
            if workspace.role == "bot" {
                if workspace.agent_enabled {
                    eprintln!(
                        "adm: bot {} runs in the management-host runner at {}. Its namespace has no workspace Pod.",
                        workspace.name, cli.runner_url
                    );
                    eprintln!(
                        "adm: use `adm attach {}` for chat or `adm inspect {}` for diagnostics on the management host.",
                        workspace.name, workspace.name
                    );
                } else {
                    eprintln!(
                        "adm: bot {} has no enabled agent. Its namespace has no workspace Pod.",
                        workspace.name
                    );
                }
            } else {
                eprintln!("{}", workspaces::navigation_guidance(&workspace, false));
            }
            print_json(&workspace)
        }
        Action::Manifest(options) => print_json(&workspaces::manifest(&options.workspace()?)?),
        Action::List { all, json } => {
            let items = cli.store()?.list(*all)?;
            if *json {
                print_json(&items)
            } else {
                print_workspace_list(&items);
                Ok(())
            }
        }
        Action::Status { name, json } => {
            let status = workspace_status(cli, name)?;
            if *json {
                print_json(&status)
            } else {
                print_status(&status);
                Ok(())
            }
        }
        Action::Inspect { name, json } => {
            let status = workspace_status(cli, name)?;
            if *json {
                print_json(&status)
            } else {
                print_inspect(&status)
            }
        }
        Action::Destroy { name } => print_json(&workspaces::destroy(cli, name)?),
        Action::Reconnect { name } => {
            let workspace = cli.store()?.active(name)?;
            anyhow::ensure!(
                workspace.role == "coding",
                "only Kubernetes coding workspaces have a host connection to reconnect"
            );
            workspaces::verify_ownership(cli, &workspace)
                .context("verify workspace namespace ownership using the selected kubeconfig")?;
            runner::ensure_started(cli)?;
            print_json(&cli.request(
                "PUT",
                &format!("/v1/workspaces/{}/kubernetes-connection", workspace.id),
                Some(&json!({
                    "kubectl": cli.kubectl,
                    "kubeconfig": cli.kubeconfig_reference()?
                })),
            )?)
        }
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
        Action::Shell {
            name,
            manage,
            command,
        } => {
            let workspace = cli.store()?.active(name)?;
            anyhow::ensure!(
                workspace.role == "coding",
                "bots have no development shell or repository access"
            );
            workspaces::verify_ownership(cli, &workspace)?;
            if command.is_empty() {
                eprintln!("{}", workspaces::navigation_guidance(&workspace, true));
            }
            if *manage {
                let mut management = cli.runtime_command("shell-management")?;
                management.env("KUBECONFIG", cli.kubeconfig_reference()?);
                management.args([
                    "--kubectl",
                    &cli.kubectl,
                    "--namespace",
                    &workspace.namespace,
                    "--workspace-id",
                    &workspace.id,
                    "--cwd",
                    &workspace.cwd,
                    "--runner-url",
                    &cli.runner_url,
                ]);
                if !command.is_empty() {
                    management.arg("--").args(command);
                }
                let status = management
                    .status()
                    .context("start current-workspace management shell")?;
                anyhow::ensure!(status.success(), "managed shell exited with {status}");
                return Ok(());
            }
            let mut child = cli.kubectl_command()?;
            child.args([
                "exec",
                "-n",
                &workspace.namespace,
                "deployment/workspace",
                "-c",
                "dev",
            ]);
            child.arg("-it");
            child.arg("--");
            if command.is_empty() {
                let working_directory = &workspace.cwd;
                child.args([
                    "bash",
                    "-l",
                    "-c",
                    "cd -- \"$1\" && export PWD=\"$1\" && exec bash -l",
                    "adm-shell",
                    working_directory,
                ]);
            } else {
                child.args(command);
            }
            let status = child.status().context("connect to development container")?;
            anyhow::ensure!(status.success(), "remote command exited with {status}");
            Ok(())
        }
        Action::Exec { name, command } => {
            let workspace = cli.store()?.active(name)?;
            anyhow::ensure!(
                workspace.role == "coding",
                "bots have no development shell or repository access"
            );
            workspaces::verify_ownership(cli, &workspace)?;
            let status = cli
                .kubectl_command()?
                .args([
                    "exec",
                    "-n",
                    &workspace.namespace,
                    "deployment/workspace",
                    "-c",
                    "dev",
                    "--",
                ])
                .args(command)
                .status()
                .context("run command in development container")?;
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
            let status = cli
                .kubectl_command()?
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
            let mut command = cli.kubectl_command()?;
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
    if std::env::args_os().len() == 1 {
        let mut command = Cli::help_command();
        command.print_help().expect("write CLI help");
        return;
    }
    let matches = Cli::help_command().get_matches();
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
