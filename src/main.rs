mod diagnostics;
mod herdr;
mod lease;
mod lifecycle;
mod provider_auth;
mod runner;
mod runtime_access;
mod setup;
mod setup_connection;
mod setup_control_plane;
mod workspaces;

use anyhow::{Context, Result};
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand, ValueEnum, parser::ValueSource};
use serde_json::{Value, json};
use std::{
    io::IsTerminal,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
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
    #[arg(
        long,
        global = true,
        env = "ADM_LIFECYCLE_URL",
        default_value = "http://127.0.0.1:7433"
    )]
    pub lifecycle_url: String,
    #[arg(skip)]
    pub lifecycle_url_explicit: bool,
    #[arg(skip)]
    pub lifecycle_forward: bool,
    #[arg(
        long,
        global = true,
        env = "ADM_LIFECYCLE_NAMESPACE",
        default_value = "adm-system"
    )]
    pub lifecycle_namespace: String,
    /// File containing the lifecycle service bearer token.
    #[arg(long, global = true, env = "ADM_LIFECYCLE_TOKEN_FILE")]
    pub lifecycle_token_file: Option<PathBuf>,
    #[arg(skip)]
    pub lifecycle_token_secret: bool,
    #[arg(
        long,
        global = true,
        env = "ADM_RUNTIME_STATUS_PORT",
        default_value_t = 7432
    )]
    pub runtime_status_port: u16,
    #[arg(skip)]
    pub lifecycle_fence: Option<lease::LeaseFence>,
    #[arg(skip)]
    pub lifecycle_operation_id: Option<String>,
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
    /// List cluster-owned workspaces.
    List {
        #[arg(long)]
        all: bool,
        /// Print complete workspace records as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Show a concise workspace, runtime, and agent summary.
    Status {
        name: String,
        /// Print the complete local, cluster, and agent records as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Show detailed workspace, runtime, and agent diagnostics.
    Inspect {
        name: String,
        /// Print the complete local, cluster, and agent records as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Permanently stop a workspace and remove its owned resources.
    Destroy {
        name: String,
        /// Stable lifecycle operation UUID used to replay this deletion request.
        #[arg(long)]
        operation_id: Option<String>,
        /// Wait for the lifecycle owner to finish removing the workspace.
        #[arg(long)]
        wait: bool,
    },
    /// Rebind a Kubernetes coding workspace to the selected client kubeconfig without replacing it.
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
    /// Forward a development port to this client device.
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
    /// Explain workspace runtime startup (no host runner).
    Start,
    /// Explain workspace runtime ownership (no host runner).
    Serve,
    /// Run the in-cluster lifecycle owner.
    LifecycleServe {
        #[arg(long, default_value = "0.0.0.0")]
        host: String,
        #[arg(long, default_value_t = 7433)]
        port: u16,
    },
    /// Keep a foreground loopback connection to the lifecycle service.
    LifecycleForward,
    /// Explain workspace runtime shutdown (no host runner).
    Stop,
    /// Check prerequisites, cluster access, storage, and lifecycle health.
    Doctor {
        /// StorageClass to inspect; otherwise use the configured default.
        #[arg(long, default_value = "adm-replicated", hide_default_value = true)]
        storage_class: String,
        /// Print the complete diagnostic report as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Configure workspace defaults and optionally install the cluster controller.
    Setup,
    /// Connect this client to an already-installed cluster without changing it.
    Connect,
    /// Generate shell completion scripts.
    Completions { shell: CompletionShell },
    /// Authenticate a provider for every workspace in this ADM installation.
    Login { provider: Option<String> },
    /// Revoke the shared provider login.
    Logout { provider: String },
    /// Bridge explicit Herdr lifecycle events to workspace ownership.
    Herdr {
        #[command(subcommand)]
        command: Option<herdr::HerdrAction>,
    },
    /// Run Chromium automation inside a development workspace.
    Browser {
        name: String,
        url: String,
        #[arg(long)]
        screenshot: Option<String>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
pub enum CompletionShell {
    /// Z shell.
    Zsh,
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
    fn clone_for_lifecycle(&self) -> Self {
        Self {
            state_dir: self.state_dir.clone(),
            kubectl: self.kubectl.clone(),
            kubeconfig: self.kubeconfig.clone(),
            runner_url: self.runner_url.clone(),
            lifecycle_url: self.lifecycle_url.clone(),
            lifecycle_url_explicit: self.lifecycle_url_explicit,
            lifecycle_forward: self.lifecycle_forward,
            lifecycle_namespace: self.lifecycle_namespace.clone(),
            lifecycle_token_file: self.lifecycle_token_file.clone(),
            lifecycle_token_secret: self.lifecycle_token_secret,
            runtime_status_port: self.runtime_status_port,
            lifecycle_fence: self.lifecycle_fence.clone(),
            lifecycle_operation_id: self.lifecycle_operation_id.clone(),
            project_dir: self.project_dir.clone(),
            command: Action::LifecycleServe {
                host: "0.0.0.0".into(),
                port: 7433,
            },
        }
    }
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
            "manifest",
            "setup",
            "connect",
            "login",
            "logout",
            "start",
            "serve",
            "lifecycle-serve",
            "lifecycle-forward",
            "stop",
            "doctor",
            "herdr",
            "completions",
            "help",
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
        WorkspaceStore::open_fenced(
            &self.state_path(),
            self.lifecycle_fence
                .as_ref()
                .map_or(0, lease::LeaseFence::epoch),
        )
    }
    pub fn workspace(
        &self,
        name_or_id: &str,
        include_deleted: bool,
    ) -> Result<workspaces::Workspace> {
        let items: Vec<workspaces::Workspace> =
            serde_json::from_value(self.request_lifecycle("GET", "/v1/workspaces", None)?)?;
        if let Some(workspace) = items.iter().find(|workspace| {
            workspace.id == name_or_id && (include_deleted || workspace.phase != "deleted")
        }) {
            return Ok(workspace.clone());
        }
        if let Some(workspace) = items
            .iter()
            .find(|workspace| workspace.name == name_or_id && workspace.phase != "deleted")
        {
            return Ok(workspace.clone());
        }
        items
            .into_iter()
            .find(|workspace| include_deleted && workspace.name == name_or_id)
            .with_context(|| format!("workspace not found: {name_or_id}"))
    }
    pub fn active_workspace(&self, name_or_id: &str) -> Result<workspaces::Workspace> {
        let workspace = self.workspace(name_or_id, false)?;
        anyhow::ensure!(
            workspace.phase != "deleting",
            "workspace {} has been deleted",
            workspace.name
        );
        Ok(workspace)
    }
    pub fn workspaces(&self, include_deleted: bool) -> Result<Vec<workspaces::Workspace>> {
        let items: Vec<workspaces::Workspace> =
            serde_json::from_value(self.request_lifecycle("GET", "/v1/workspaces", None)?)?;
        Ok(items
            .into_iter()
            .filter(|workspace| include_deleted || workspace.phase != "deleted")
            .collect())
    }
    pub fn request_lifecycle(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        if self.lifecycle_token_secret && self.lifecycle_token_file.is_none() {
            let token = lifecycle::kubernetes_token(self)?;
            return lifecycle::request_with_token(
                &self.lifecycle_url,
                Some(&token),
                method,
                path,
                body,
            );
        }
        lifecycle::request(
            &self.lifecycle_url,
            self.lifecycle_token_file.as_deref(),
            method,
            path,
            body,
        )
    }
    pub fn request_lifecycle_wait(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        if self.lifecycle_token_secret && self.lifecycle_token_file.is_none() {
            let token = lifecycle::kubernetes_token(self)?;
            return lifecycle::request_with_token_wait(
                &self.lifecycle_url,
                Some(&token),
                method,
                path,
                body,
            );
        }
        lifecycle::request_wait(
            &self.lifecycle_url,
            self.lifecycle_token_file.as_deref(),
            method,
            path,
            body,
        )
    }
    pub fn wait_for_lifecycle_workspace(
        &self,
        operation_id: &str,
        workspace_id: &str,
        action: &str,
        name: &str,
    ) -> Result<workspaces::Workspace> {
        let deadline = Instant::now() + Duration::from_secs(210);
        let mut last_stage = String::new();
        loop {
            let receipt =
                self.request_lifecycle("GET", &format!("/v1/operations/{operation_id}"), None)?;
            let stage = receipt["stage"].as_str().unwrap_or("pending");
            if stage != last_stage {
                eprintln!("adm: {action} {name}: {stage}");
                last_stage = stage.to_owned();
            }
            if matches!(receipt["status"].as_str(), Some("completed" | "failed")) {
                if let Some(stages) = receipt["timings"]["stages"].as_object() {
                    for (stage, timing) in stages {
                        if let (Some(outcome), Some(elapsed)) =
                            (timing["status"].as_str(), timing["elapsedSeconds"].as_f64())
                        {
                            eprintln!("adm: {action} {name}: {stage} {outcome} in {elapsed:.3}s");
                        }
                    }
                }
                if let Some(elapsed) = receipt["timings"]["elapsedSeconds"].as_f64() {
                    eprintln!("adm: {action} {name}: {stage} in {elapsed:.3}s");
                }
            }
            match receipt["status"].as_str() {
                Some("completed") => {
                    let value = self.request_lifecycle(
                        "GET",
                        &format!("/v1/workspaces/{workspace_id}"),
                        None,
                    )?;
                    return serde_json::from_value(value)
                        .context("decode completed lifecycle workspace");
                }
                Some("failed") => anyhow::bail!(
                    "{}",
                    receipt["lastError"]
                        .as_str()
                        .unwrap_or("lifecycle operation failed")
                ),
                _ => {}
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                "{action} {name} is still pending; operation {operation_id} can be inspected or replayed"
            );
            thread::sleep(Duration::from_millis(100));
        }
    }
    pub fn check_lifecycle_fence(&self) -> Result<()> {
        if let Some(fence) = &self.lifecycle_fence {
            lease::verify(self, fence)?;
        }
        Ok(())
    }
    pub fn check_lifecycle_fence_bounded(&self) -> Result<()> {
        if let Some(fence) = &self.lifecycle_fence {
            lease::verify_bounded(self, fence)?;
        }
        Ok(())
    }
    pub fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let id = path
            .strip_prefix("/v1/workspaces/")
            .and_then(|path| path.split('/').next())
            .context("workspace runtime request must target an immutable workspace ID")?;
        let workspace = self.workspace(id, false)?;
        runtime_access::request(self, &workspace, method, path, body)
    }
}

pub fn print_json(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn workspace_activity(workspace: &workspaces::Workspace) -> Value {
    if workspace.phase == "deleted" {
        json!({"status":"deleted"})
    } else if !workspace.agent_enabled {
        json!({"status":"disabled"})
    } else {
        workspace
            .runtime_status
            .as_ref()
            .and_then(|status| status.get("activity"))
            .cloned()
            .unwrap_or_else(
                || json!({"status":"unavailable","error":"runtime status is unavailable"}),
            )
    }
}

fn workspace_list_value(workspace: &workspaces::Workspace) -> Result<Value> {
    let mut value = serde_json::to_value(workspace)?;
    value["activity"] = workspace_activity(workspace);
    Ok(value)
}

const WORKSPACE_SUMMARY_HEADERS: [&str; 8] = [
    "NAME",
    "ROLE",
    "PHASE",
    "AGENT CONFIG",
    "RUNTIME",
    "ACTIVITY",
    "NODE",
    "ID",
];

fn workspace_summary(workspace: &Value, activity: &Value) -> [String; 8] {
    let phase = workspace["phase"].as_str().unwrap_or("unknown");
    let runtime = workspace.get("runtime_status").unwrap_or(&Value::Null);
    let (runtime_readiness, node) = if phase == "deleted" {
        ("deleted".to_owned(), "—".to_owned())
    } else if runtime["error"].is_string() && runtime["podPhase"] != "Failed" {
        ("unavailable".to_owned(), "—".to_owned())
    } else {
        let pod_phase = runtime["podPhase"].as_str().unwrap_or("Unknown");
        let readiness = if runtime["podPhase"] == "Missing" {
            "missing".to_owned()
        } else if runtime["podPhase"] == "Failed" {
            "NotReady (Failed)".to_owned()
        } else if runtime["ready"] == true {
            "Ready".to_owned()
        } else if pod_phase == "Pending" {
            "Pending".to_owned()
        } else if pod_phase == "Unknown" {
            "unavailable".to_owned()
        } else {
            format!("NotReady ({pod_phase})")
        };
        let node = runtime["nodeName"]
            .as_str()
            .filter(|node| !node.is_empty())
            .unwrap_or("—");
        (readiness, node.to_owned())
    };
    [
        workspace["name"].as_str().unwrap_or("unknown").to_owned(),
        workspace["role"].as_str().unwrap_or("unknown").to_owned(),
        phase.to_owned(),
        if workspace["agent_enabled"] == true {
            "enabled".to_owned()
        } else {
            "disabled".to_owned()
        },
        runtime_readiness,
        activity["status"]
            .as_str()
            .unwrap_or("unavailable")
            .to_owned(),
        node,
        workspace["id"].as_str().unwrap_or("unknown").to_owned(),
    ]
}

fn print_workspace_summaries(summaries: &[[String; 8]]) {
    let widths = std::array::from_fn::<_, 8, _>(|column| {
        summaries
            .iter()
            .map(|row| row[column].len())
            .max()
            .unwrap_or(0)
            .max(WORKSPACE_SUMMARY_HEADERS[column].len())
    });
    for (index, header) in WORKSPACE_SUMMARY_HEADERS.iter().enumerate() {
        if index > 0 {
            print!("  ");
        }
        print!("{header:<width$}", width = widths[index]);
    }
    println!();
    for row in summaries {
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                print!("  ");
            }
            print!("{value:<width$}", width = widths[index]);
        }
        println!();
    }
}

fn print_workspace_list(items: &[Value]) {
    if items.is_empty() {
        println!("No workspaces");
        return;
    }
    let summaries = items
        .iter()
        .map(|workspace| workspace_summary(workspace, &workspace["activity"]))
        .collect::<Vec<_>>();
    print_workspace_summaries(&summaries);
    for workspace in items {
        print_summary_errors(workspace);
    }
}

fn workspace_list_report(items: &[workspaces::Workspace]) -> Result<Vec<Value>> {
    items
        .iter()
        .map(|workspace| {
            let mut report = serde_json::to_value(workspace)?;
            report["requested_model"] = report["model"].clone();
            report["activity"] = workspace_activity(workspace);
            let selected_model = workspace
                .runtime_status
                .as_ref()
                .and_then(|status| status.get("selectedModel"))
                .cloned()
                .unwrap_or(Value::Null);
            report["effective_model"] = selected_model.clone();
            report["model"] = selected_model;
            Ok(report)
        })
        .collect()
}

fn workspace_status(cli: &Cli, name: &str) -> Result<Value> {
    let workspace = cli.workspace(name, true)?;
    let cluster = if workspace.phase == "deleted" {
        Value::Null
    } else {
        match workspaces::cluster_status(cli, &workspace) {
            Ok(value) => value,
            Err(error) => json!({"status":"unavailable","error":format!("{error:#}")}),
        }
    };
    let activity = workspace_activity(&workspace);
    let agent = if workspace.phase == "deleted" {
        json!({"status":"deleted"})
    } else if workspace.agent_enabled {
        json!({
            "status": activity["status"],
            "error": activity["error"],
            "selectedModel": workspace.runtime_status.as_ref().and_then(|status| status.get("selectedModel")),
        })
    } else {
        json!({"status":"disabled"})
    };
    Ok(json!({"workspace":workspace,"cluster":cluster,"agent":agent,"activity":activity}))
}

fn pod_summary(status: &Value) -> (String, String) {
    let Some(pod) = status["cluster"]["pods"]
        .as_array()
        .and_then(|pods| pods.first())
    else {
        return ("missing".into(), "—".into());
    };
    let phase = pod["status"]["phase"].as_str().unwrap_or("Unknown");
    let ready = pod["status"]["conditions"]
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
    let readiness =
        if ready.is_some_and(|condition| condition["status"] == "True") && containers_ready {
            "Ready".to_owned()
        } else if ready.is_some_and(|condition| condition["status"] == "False")
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

fn print_status(status: &Value) {
    let row = workspace_summary(&status["workspace"], &status["activity"]);
    print_workspace_summaries(&[row]);
    print_summary_errors(status);
    if let Some(error) = status["cluster"]["error"].as_str() {
        println!("Cluster details unavailable: {error}");
    }
    if let Some(reason) = status["cluster"]["containerReason"].as_str() {
        println!("Pod runtime: {reason}");
    }
}

fn print_summary_errors(status: &Value) {
    let workspace = status.get("workspace").unwrap_or(status);
    let activity = status.get("activity").unwrap_or(&status["activity"]);
    let identity = format!(
        "{} ({})",
        workspace["name"].as_str().unwrap_or("unknown"),
        workspace["id"].as_str().unwrap_or("unknown")
    );
    if workspace["phase"] != "deleted" {
        if let Some(error) = workspace["runtime_status"]["error"].as_str() {
            if workspace["runtime_status"]["podPhase"] == "Failed" {
                println!("Runtime failure for {identity}: {error}");
            } else {
                println!("Runtime unavailable for {identity}: {error}");
            }
        } else if workspace["runtime_status"].is_null() {
            println!("Runtime unavailable for {identity}: runtime observation is missing");
        } else if workspace["runtime_status"]["podPhase"] == "Missing" {
            println!("Runtime unavailable for {identity}: workspace Pod is missing");
        }
    }
    if let Some(error) = activity["error"].as_str() {
        match activity["status"].as_str() {
            Some("unavailable") => println!("Agent unavailable for {identity}: {error}"),
            Some("error") => println!("Agent failure for {identity}: {error}"),
            _ => println!("Agent error for {identity}: {error}"),
        }
    } else if activity["status"] == "unavailable" {
        println!("Agent unavailable for {identity}: workspace runtime did not report a cause");
    }
    if let Some(error) = workspace["last_error"].as_str() {
        println!("Workspace failure for {identity}: {error}");
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
        if workspace["phase"] == "deleted" {
            println!("  Runtime: destroyed (workspace deleted)");
        } else {
            println!("  Pod: not queried");
        }
    } else if let Some(error) = cluster["error"].as_str() {
        println!("  Unavailable: {error}");
    } else {
        println!(
            "  Namespace: {}",
            workspace["namespace"].as_str().unwrap_or("unknown")
        );
        if let Some(pod) = cluster["pods"].as_array().and_then(|pods| pods.first()) {
            println!(
                "  Pod: {}",
                pod["metadata"]["name"].as_str().unwrap_or("unknown")
            );
            println!(
                "  Phase: {}",
                pod["status"]["phase"].as_str().unwrap_or("unknown")
            );
            let (runtime, node) = pod_summary(status);
            println!("  Ready: {runtime}");
            println!("  Node: {node}");
            if let Some(reason) =
                pod["status"]["containerStatuses"]
                    .as_array()
                    .and_then(|containers| {
                        containers
                            .iter()
                            .find_map(|container| container["state"]["waiting"]["reason"].as_str())
                    })
            {
                println!("  Container: {reason}");
            }
        } else {
            println!("  Pod: missing");
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
            let workspace = options.workspace()?;
            let operation_id = options
                .operation_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let receipt = cli.request_lifecycle(
                "POST",
                "/v1/operations",
                Some(&serde_json::to_value(
                    lifecycle::OperationRequest::Create {
                        operation_id,
                        spec: Box::new(lifecycle::CreateIntent::from_workspace(&workspace)),
                    },
                )?),
            )?;
            let operation_id = receipt["operationId"]
                .as_str()
                .context("lifecycle receipt omitted operationId")?;
            let workspace_id = receipt["workspaceId"]
                .as_str()
                .context("lifecycle receipt omitted workspaceId")?;
            let workspace = cli.wait_for_lifecycle_workspace(
                operation_id,
                workspace_id,
                "create",
                &workspace.name,
            )?;
            if options.herdr {
                eprintln!(
                    "adm: workspace {} is ready; opening a Herdr space and attaching there",
                    workspace.name
                );
                let opened = herdr::open_created_space(
                    cli,
                    &workspace.name,
                    &std::env::current_dir().context("read local client working directory")?,
                )
                .with_context(|| herdr_partial_success(&workspace, None))?;
                herdr::configure_bound_space(cli, &workspace, &opened.workspace_id).with_context(
                    || herdr_partial_success(&workspace, Some(&opened.workspace_id)),
                )?;
                herdr::queue_attach_in_created_pane(cli, &workspace, &opened).with_context(
                    || herdr_partial_success(&workspace, Some(&opened.workspace_id)),
                )?;
                let delivery = herdr::event_delivery_status(cli)
                    .unwrap_or_else(|error| format!("unavailable ({error:#})"));
                println!(
                    "Opened Herdr space {} (tab {}, pane {}). Close-event delivery: {}.",
                    opened.workspace_id, opened.tab_id, opened.pane_id, delivery
                );
                return Ok(());
            }
            let attach = !options.no_attach
                && std::io::stdin().is_terminal()
                && std::io::stdout().is_terminal();
            if !attach {
                return print_json(&workspace);
            }
            eprintln!(
                "adm: workspace {} is ready; attaching to its durable agent",
                workspace.name
            );
            runtime_access::attach(cli, &workspace, false).with_context(|| {
                format!(
                    "workspace {} was created with ID {}, but attach failed; recover with `adm attach {}`",
                    workspace.name, workspace.id, workspace.id
                )
            })
        }
        Action::Manifest(options) => print_json(&workspaces::manifest(&options.workspace()?)?),
        Action::List { all, json } => {
            let items = cli.workspaces(*all)?;
            let reports = items
                .iter()
                .map(workspace_list_value)
                .collect::<Result<Vec<_>>>()?;
            if *json {
                print_json(&workspace_list_report(&items)?)
            } else {
                print_workspace_list(&reports);
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
        Action::Destroy {
            name,
            operation_id,
            wait,
        } => {
            let workspace = cli.workspace(name, true)?;
            if workspace.phase == "deleted" && workspace.deletion_operation_id.is_none() {
                return print_json(&workspace);
            }
            if let Some(existing_operation) = workspace.deletion_operation_id.as_deref()
                && let Some(requested) = operation_id.as_deref()
                && requested != existing_operation
            {
                let admitted = cli.request_lifecycle(
                    "GET", &format!("/v1/operations/{requested}"), None,
                ).with_context(|| format!(
                    "workspace {} is already tracked by destroy operation {}; resume that operation",
                    workspace.name, existing_operation,
                ))?;
                anyhow::ensure!(
                    admitted["kind"] == "delete" && admitted["workspaceId"] == workspace.id,
                    "operation {requested} does not delete workspace {}",
                    workspace.id,
                );
            }
            let operation_id = operation_id
                .clone()
                .or_else(|| workspace.deletion_operation_id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let receipt = cli.request_lifecycle(
                "POST",
                "/v1/operations",
                Some(&serde_json::to_value(
                    lifecycle::OperationRequest::Delete {
                        operation_id,
                        workspace_id: workspace.id,
                    },
                )?),
            )?;
            let operation_id = receipt["operationId"]
                .as_str()
                .context("lifecycle receipt omitted operationId")?;
            let workspace_id = receipt["workspaceId"]
                .as_str()
                .context("lifecycle receipt omitted workspaceId")?;
            if *wait {
                let workspace = cli.wait_for_lifecycle_workspace(
                    operation_id,
                    workspace_id,
                    "destroy",
                    &workspace.name,
                )?;
                print_json(&workspace)
            } else {
                print_json(&receipt)
            }
        }
        Action::Reconnect { name } => {
            let workspace = cli.active_workspace(name)?;
            anyhow::ensure!(
                workspace.role == "coding",
                "only Kubernetes coding workspaces have a kubeconfig binding to reconnect"
            );
            workspaces::verify_ownership(cli, &workspace)
                .context("verify workspace namespace ownership using the selected kubeconfig")?;
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
            let workspace = cli.active_workspace(name)?;
            anyhow::ensure!(
                workspace.agent_enabled,
                "workspace has no agent; use adm shell"
            );
            runtime_access::attach(cli, &workspace, *diagnostics)
        }
        Action::Shell {
            name,
            manage,
            command,
        } => {
            let workspace = cli.active_workspace(name)?;
            anyhow::ensure!(
                workspace.role == "coding",
                "bots have no development shell or repository access"
            );
            workspaces::verify_ownership(cli, &workspace)?;
            if command.is_empty() {
                eprintln!("{}", workspaces::navigation_guidance(&workspace, true));
            }
            if *manage {
                return runtime_access::managed_shell(cli, &workspace, &workspace.cwd, command);
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
                    "env",
                    "ZDOTDIR=/workspace/.adm/zsh",
                    "zsh",
                    "-l",
                    "-c",
                    "cd -- \"$1\" && export PWD=\"$1\" && exec zsh -l",
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
            let workspace = cli.active_workspace(name)?;
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
                "port forwarding must bind to loopback on this client device"
            );
            let workspace = cli.active_workspace(name)?;
            anyhow::ensure!(workspace.role == "coding", "bots have no development ports");
            workspaces::verify_ownership(cli, &workspace)?;
            let local = local_port.unwrap_or(*port);
            eprintln!(
                "Preview: http://{bind}:{local} (available on this client while the port forward is running)"
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
            let workspace = cli.active_workspace(name)?;
            anyhow::ensure!(workspace.agent_enabled, "workspace has no agent");
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
            let workspace = cli.active_workspace(name)?;
            print_json(&cli.request(
                "POST",
                &format!("/v1/workspaces/{}/abort", workspace.id),
                Some(&json!({"background":background})),
            )?)
        }
        Action::History { name, after } => {
            let workspace = cli.workspace(name, true)?;
            print_json(&cli.request(
                "GET",
                &format!("/v1/workspaces/{}/history?after={after}", workspace.id),
                None,
            )?)
        }
        Action::Start => {
            anyhow::bail!(
                "agent runtimes start inside workspace Pods. Run `adm setup` to install and connect the lifecycle control plane, then `adm doctor`, `adm create NAME`, and `adm attach NAME`"
            )
        }
        Action::Serve => anyhow::bail!(
            "the host does not run agent harnesses; workspace Pods own runtime execution"
        ),
        Action::LifecycleServe { host, port } => {
            lifecycle::serve(cli.clone_for_lifecycle(), host, *port)
        }
        Action::LifecycleForward => setup_connection::serve(cli),
        Action::Stop => anyhow::bail!(
            "there is no host agent runner to stop; workspace Pods own agent execution"
        ),
        Action::Doctor {
            storage_class,
            json,
        } => diagnostics::doctor(cli, storage_class, *json),
        Action::Setup => setup::run(cli),
        Action::Connect => setup::connect(cli),
        Action::Completions { shell } => {
            let mut command = Cli::command();
            match shell {
                CompletionShell::Zsh => clap_complete::generate(
                    clap_complete::aot::Shell::Zsh,
                    &mut command,
                    "adm",
                    &mut std::io::stdout(),
                ),
            }
            Ok(())
        }
        Action::Login { provider } => provider_auth::login(cli, provider.as_deref()),
        Action::Logout { provider } => provider_auth::logout(cli, provider),
        Action::Herdr { command } => {
            herdr::run(cli, command.as_ref().unwrap_or(&herdr::HerdrAction::Hook))
        }
        Action::Browser {
            name,
            url,
            screenshot,
        } => {
            let workspace = cli.active_workspace(name)?;
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

fn herdr_partial_success(workspace: &workspaces::Workspace, herdr_space: Option<&str>) -> String {
    match herdr_space {
        Some(space_id) => format!(
            "workspace {} was created with ID {} and Herdr space {}; handoff failed; recover with `adm attach {}`",
            workspace.name, workspace.id, space_id, workspace.id
        ),
        None => format!(
            "workspace {} was created with ID {}, but Herdr space creation failed; recover with `adm attach {}`",
            workspace.name, workspace.id, workspace.id
        ),
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
    if let Err(error) = configure_defaults(&mut cli, &matches).and_then(|()| {
        if let Action::Create(options) = &cli.command {
            workspaces::validate_name(&options.name)?;
        }
        let _connection = if cli.lifecycle_forward
            && !matches!(
                cli.command,
                Action::Connect
                    | Action::Herdr {
                        command: Some(herdr::HerdrAction::RouteShell { .. }),
                    }
            ) {
            let connection = setup_connection::connect(&cli)?;
            cli.lifecycle_url = connection.url.clone();
            Some(connection)
        } else {
            None
        };
        run(&cli)
    }) {
        eprintln!("adm: {error:#}");
        std::process::exit(1);
    }
}

fn configure_defaults(cli: &mut Cli, matches: &clap::ArgMatches) -> Result<()> {
    cli.lifecycle_url_explicit =
        matches.value_source("lifecycle_url") != Some(ValueSource::DefaultValue);
    let route_shell = matches!(
        cli.command,
        Action::Herdr {
            command: Some(herdr::HerdrAction::RouteShell { .. }),
        }
    );
    let workspace_defaults = matches!(
        cli.command,
        Action::Create(_) | Action::Manifest(_) | Action::Doctor { .. }
    );
    let connection_defaults = route_shell
        || !matches!(
            cli.command,
            Action::Completions { .. }
                | Action::Setup
                | Action::LifecycleServe { .. }
                | Action::LifecycleForward
                | Action::Manifest(_)
                | Action::Start
                | Action::Serve
                | Action::Stop
                | Action::Herdr {
                    command: None
                        | Some(herdr::HerdrAction::Hook)
                        | Some(herdr::HerdrAction::Status { .. })
                        | Some(herdr::HerdrAction::Disable)
                        | Some(herdr::HerdrAction::RouteShell { .. })
                        | Some(herdr::HerdrAction::CreateSpace { .. })
                }
        );
    if connection_defaults && !route_shell && !cli.lifecycle_url_explicit {
        cli.lifecycle_forward = true;
        cli.lifecycle_token_secret = cli.lifecycle_token_file.is_none();
    }
    if !workspace_defaults && !connection_defaults {
        return Ok(());
    }
    let config = setup::read_config()?;
    if connection_defaults && let Some(connection) = &config.lifecycle {
        if !cli.lifecycle_url_explicit {
            cli.lifecycle_forward = connection.forward;
            if let Some(url) = &connection.url {
                cli.lifecycle_url = url.clone();
            }
        }
        if matches.value_source("lifecycle_namespace") == Some(ValueSource::DefaultValue) {
            cli.lifecycle_namespace = connection.namespace.clone();
        }
        if matches.value_source("kubectl") == Some(ValueSource::DefaultValue) {
            cli.kubectl = connection.kubectl.clone();
        }
        if matches.value_source("kubeconfig").is_none() {
            cli.kubeconfig = Some(connection.kubeconfig.clone());
        }
        if matches.value_source("lifecycle_token_file").is_none() {
            cli.lifecycle_token_file = connection.token_file.clone();
            cli.lifecycle_token_secret = connection.token_file.is_none();
        }
    }
    if !workspace_defaults {
        return Ok(());
    }
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
            if options.model.is_none() {
                options.model = config.model;
            }
            if let Some(model) = &options.model {
                setup::validate_model(model)?;
            }
        }
        Action::Doctor { storage_class, .. } => {
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
