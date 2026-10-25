//! Durable lifecycle operation receipts shared by CLI, bots, and Herdr.

use crate::workspaces::{Workspace, WorkspaceStore};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, TcpListener, TcpStream},
    sync::{Arc, Condvar, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

/// Bound on collecting every runtime's activity for one directory read. Healthy
/// reads take ~0.25 s live, so one hung runtime delays a list by at most this.
const RUNTIME_STATUS_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_RUNTIME_STATUS_BYTES: u64 = 64 * 1024;
const UPDATE_MAINTENANCE_SECONDS: u64 = 300;
const UPDATE_MAINTENANCE_ACK_TIMEOUT: Duration = Duration::from_secs(25);
static RUNTIME_MAINTENANCE_SIGNAL: (Mutex<u64>, Condvar) = (Mutex::new(0), Condvar::new());
pub const INSTALLATION_GUIDE: &str = "https://github.com/NWylynko/agentic-dev-machines/blob/main/docs/installation.md#in-cluster-lifecycle-owner";

pub fn setup_guidance(cli: &crate::Cli) -> String {
    format!(
        "Run `adm setup` to install the controller and configure its supervised connection. For manual installations, check the adm-lifecycle Deployment and Service in namespace {}. Manifest: {} (targets adm-system; adapt it for a custom namespace). For the default local endpoint, supervise `kubectl -n {} port-forward service/adm-lifecycle 7433:7433`. Manual authentication uses ADM_LIFECYCLE_URL and ADM_LIFECYCLE_TOKEN_FILE. Installation: {INSTALLATION_GUIDE}",
        cli.lifecycle_namespace,
        cli.project_dir
            .join("deploy/lifecycle/control-plane.yaml")
            .display(),
        cli.lifecycle_namespace,
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperationRequest {
    Create {
        #[serde(rename = "operationId")]
        operation_id: String,
        spec: Box<CreateIntent>,
    },
    Delete {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    Update {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        image: String,
    },
}

/// Caller-owned creation choices only. Identity, namespace, phase, timestamps,
/// and error state are always allocated by the lifecycle owner.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateIntent {
    pub name: String,
    pub role: String,
    pub image: String,
    pub storage_class: String,
    pub storage_size: String,
    pub cpu: String,
    pub memory: String,
    pub agent_enabled: bool,
    #[serde(default)]
    pub allow_node_local_storage: bool,
    pub repositories: bool,
    pub catalog: Value,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    pub model: Option<Value>,
    #[serde(default)]
    pub credential_env: Vec<crate::workspaces::CredentialEnvRef>,
    #[serde(default)]
    pub herdr_space: Option<String>,
}

fn default_cwd() -> String {
    "/repos".into()
}

impl CreateIntent {
    pub fn from_workspace(workspace: &Workspace) -> Self {
        Self {
            name: workspace.name.clone(),
            role: workspace.role.clone(),
            image: workspace.image.clone(),
            storage_class: workspace.storage_class.clone(),
            storage_size: workspace.storage_size.clone(),
            cpu: workspace.cpu.clone(),
            memory: workspace.memory.clone(),
            agent_enabled: workspace.agent_enabled,
            allow_node_local_storage: workspace.allow_node_local_storage,
            repositories: workspace.repositories,
            catalog: workspace.catalog.clone(),
            repository: workspace.repository.clone(),
            branch: workspace.branch.clone(),
            base: workspace.base.clone(),
            cwd: workspace.cwd.clone(),
            model: workspace.model.clone(),
            credential_env: workspace.credential_env.clone(),
            herdr_space: workspace.herdr_space.clone(),
        }
    }

    pub(crate) fn allocate(self, operation_id: &str) -> Result<Workspace> {
        crate::workspaces::validate_name(&self.name)?;
        ensure!(
            self.role == "coding" || self.role == "bot",
            "role must be coding or bot"
        );
        ensure!(
            self.role != "bot" || !self.repositories,
            "repositories are only supported for coding workspaces"
        );
        if let Some(repository) = &self.repository {
            ensure!(
                self.role == "coding",
                "repository is only supported for coding workspaces"
            );
            crate::workspaces::validate_repository_ref(repository)?;
        }
        crate::workspaces::validate_repository_selection(
            self.repository.as_deref(),
            self.branch.as_deref(),
            self.base.as_deref(),
        )?;
        let mut credential_names = std::collections::HashSet::new();
        for reference in &self.credential_env {
            ensure!(
                !reference.name.is_empty()
                    && reference.name.as_bytes()[0].is_ascii_uppercase()
                    && reference.name.bytes().all(|byte| byte.is_ascii_uppercase()
                        || byte.is_ascii_digit()
                        || byte == b'_'),
                "credential environment name must be a valid uppercase environment variable"
            );
            ensure!(
                !reference.secret_name.is_empty()
                    && reference.secret_name.len() <= 63
                    && reference
                        .secret_name
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || byte == b'-')
                    && reference.secret_name.as_bytes()[0].is_ascii_lowercase()
                    && reference.secret_name.as_bytes()[reference.secret_name.len() - 1]
                        .is_ascii_alphanumeric(),
                "credential Secret name must be a lowercase DNS name"
            );
            ensure!(
                !reference.key.is_empty()
                    && reference
                        .key
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)),
                "credential Secret key is invalid"
            );
            ensure!(
                credential_names.insert(&reference.name),
                "each credential environment name may be specified only once"
            );
        }
        ensure!(self.agent_enabled, "workspace agents are always enabled");
        let expected_cwd = self
            .repository
            .as_ref()
            .map_or("/repos".to_owned(), |repository| {
                format!("/repos/{repository}")
            });
        ensure!(
            self.cwd == expected_cwd,
            "cwd must match the selected repository or /repos"
        );
        ensure!(
            !self.repositories || (self.role == "coding" && self.repository.is_none()),
            "repository catalog is only supported for coding workspaces without --repo"
        );
        ensure!(
            !self.image.trim().is_empty()
                && !self.storage_size.trim().is_empty()
                && !self.cpu.trim().is_empty()
                && !self.memory.trim().is_empty(),
            "image and resource values must be non-empty"
        );
        ensure!(
            self.role != "coding" || !self.storage_class.is_empty(),
            "coding workspaces need a StorageClass"
        );
        ensure!(
            self.model.as_ref().is_none_or(|model| model["provider"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
                && model["id"].as_str().is_some_and(|s| !s.is_empty())),
            "model must contain provider and id"
        );
        ensure!(
            self.model.as_ref().is_none_or(|model| {
                model.as_object().is_some_and(|model| {
                    model.len() == 2 && model.contains_key("provider") && model.contains_key("id")
                })
            }),
            "model accepts only provider and id"
        );
        let id = uuid::Uuid::new_v4().simple().to_string();
        Ok(Workspace {
            id: id.clone(),
            name: self.name,
            role: self.role,
            namespace: format!("adm-{}", &id[..16]),
            phase: "provisioning".into(),
            creation_operation_id: Some(operation_id.to_owned()),
            deletion_operation_id: None,
            runtime_status: None,
            image: self.image,
            storage_class: self.storage_class,
            storage_size: self.storage_size,
            cpu: self.cpu,
            memory: self.memory,
            agent_enabled: true,
            allow_node_local_storage: self.allow_node_local_storage,
            repositories: self.repositories,
            catalog: self.catalog,
            repository: self.repository,
            branch: self.branch,
            base: self.base,
            cwd: self.cwd,
            model: self.model,
            credential_env: self.credential_env,
            herdr_space: self.herdr_space,
            created_at: crate::workspaces::now(),
            last_error: None,
        })
    }
}

impl OperationRequest {
    pub fn operation_id(&self) -> &str {
        match self {
            Self::Create { operation_id, .. }
            | Self::Delete { operation_id, .. }
            | Self::Update { operation_id, .. } => operation_id,
        }
    }

    pub fn workspace_id(&self) -> Option<&str> {
        match self {
            Self::Create { .. } => None,
            Self::Delete { workspace_id, .. } | Self::Update { workspace_id, .. } => {
                Some(workspace_id)
            }
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Create { .. } => "create",
            Self::Delete { .. } => "delete",
            Self::Update { .. } => "update",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationReceipt {
    pub operation_id: String,
    pub kind: String,
    pub status: String,
    pub workspace_id: String,
    pub accepted_at: u64,
    pub updated_at: u64,
    pub stage: Option<String>,
    pub last_error: Option<String>,
    pub timings: Value,
    pub fencing_token: u64,
}

const RUNTIME_LEASE_SECONDS: u64 = 30;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeLeaseRequest {
    holder: String,
    #[serde(rename = "fencingToken")]
    fencing_token: Option<u64>,
    #[serde(rename = "maintenanceId")]
    maintenance_id: Option<String>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeMaintenanceRequest {
    #[serde(rename = "maintenanceId")]
    maintenance_id: String,
    #[serde(
        rename = "durationSeconds",
        default = "default_update_maintenance_seconds"
    )]
    duration_seconds: u64,
}

fn default_update_maintenance_seconds() -> u64 {
    UPDATE_MAINTENANCE_SECONDS
}

fn notify_runtime_maintenance_changed() {
    let mut generation = RUNTIME_MAINTENANCE_SIGNAL
        .0
        .lock()
        .expect("runtime maintenance signal lock");
    *generation = generation.wrapping_add(1);
    RUNTIME_MAINTENANCE_SIGNAL.1.notify_all();
}

fn wait_for_runtime_maintenance(cli: &crate::Cli, maintenance_id: &str) -> Result<Vec<String>> {
    let deadline = Instant::now() + UPDATE_MAINTENANCE_ACK_TIMEOUT;
    loop {
        cli.check_lifecycle_fence()?;
        let generation = *RUNTIME_MAINTENANCE_SIGNAL
            .0
            .lock()
            .expect("runtime maintenance signal lock");
        let missing = cli
            .store()?
            .unacknowledged_runtime_maintenance(maintenance_id)?;
        if missing.is_empty() {
            return Ok(missing);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(missing);
        }
        let guard = RUNTIME_MAINTENANCE_SIGNAL
            .0
            .lock()
            .expect("runtime maintenance signal lock");
        if *guard != generation {
            continue;
        }
        let _ = RUNTIME_MAINTENANCE_SIGNAL
            .1
            .wait_timeout(guard, remaining)
            .expect("runtime maintenance signal wait");
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeAuthorizeRequest {
    action: String,
}

#[derive(Clone)]
struct RuntimeStatusTarget {
    index: usize,
    workspace_id: String,
    ip: IpAddr,
}

/// Durably admits or replays one lifecycle operation. The request body is
/// stored with the receipt so a reused key cannot point at another workspace.
pub fn admit(store: &mut WorkspaceStore, request: &OperationRequest) -> Result<OperationReceipt> {
    ensure!(
        uuid::Uuid::parse_str(request.operation_id()).is_ok(),
        "operationId must be a UUID"
    );
    match request {
        OperationRequest::Create { spec, .. } => {
            ensure!(!spec.name.is_empty(), "create request needs a name");
        }
        OperationRequest::Delete { workspace_id, .. } => {
            ensure!(
                uuid::Uuid::parse_str(workspace_id).is_ok(),
                "workspaceId must be an immutable workspace UUID"
            );
        }
        OperationRequest::Update {
            workspace_id,
            image,
            ..
        } => {
            ensure!(
                uuid::Uuid::parse_str(workspace_id).is_ok(),
                "workspaceId must be an immutable workspace UUID"
            );
            ensure!(!image.trim().is_empty(), "update request needs an image");
        }
    }
    store.admit_lifecycle_operation(request)
}

pub fn request_from_json(value: &Value) -> Result<OperationRequest> {
    serde_json::from_value(value.clone()).context("invalid lifecycle operation request")
}

pub fn serve(mut cli: crate::Cli, bind: &str, port: u16) -> Result<()> {
    cli.lifecycle_fence = Some(crate::lease::acquire(&cli)?);
    let token_file = cli
        .lifecycle_token_file
        .as_deref()
        .context("lifecycle service requires --lifecycle-token-file")?;
    let token = fs::read_to_string(token_file).context("read lifecycle bearer token")?;
    let token = token.trim().to_owned();
    ensure!(!token.is_empty(), "lifecycle bearer token file is empty");
    let listener = TcpListener::bind((bind, port)).context("bind lifecycle service")?;
    let (wake, work) = mpsc::channel::<String>();
    let work = Arc::new(Mutex::new(work));
    let active_operations = Arc::new(Mutex::new(HashSet::new()));
    for _ in 0..4 {
        let worker_cli = cli.clone_for_lifecycle();
        let worker_work = work.clone();
        let worker_active_operations = active_operations.clone();
        thread::spawn(move || lifecycle_worker(worker_cli, worker_work, worker_active_operations));
    }
    let failover_cli = cli.clone_for_lifecycle();
    thread::spawn(move || node_failover_loop(failover_cli));
    // Replay interrupted accepted/running work before accepting new requests.
    for (operation_id, _) in cli.store()?.pending_lifecycle_operations()? {
        let _ = wake.send(operation_id);
    }
    eprintln!("adm lifecycle ready on {bind}:{port}");
    for incoming in listener.incoming() {
        let mut stream = incoming?;
        let request_cli = cli.clone_for_lifecycle();
        let request_wake = wake.clone();
        let request_token = token.clone();
        thread::spawn(move || {
            if let Err(error) =
                handle_http(&request_cli, &request_wake, &request_token, &mut stream)
            {
                eprintln!("adm lifecycle request failed: {error:#}");
            }
        });
    }
    Ok(())
}

/// A workspace whose node has not been Ready for this long is moved: Nick's
/// TASK-82 decision accepts losing its in-flight turn for that.
const NODE_DOWN_MOVE_SECONDS: u64 = 180;
/// How often the lifecycle looks for workspaces stranded on down nodes.
const NODE_FAILOVER_SWEEP_INTERVAL: Duration = Duration::from_secs(10);

fn node_failover_loop(cli: crate::Cli) {
    loop {
        if let Err(error) = move_workspaces_off_down_nodes(&cli) {
            eprintln!("adm lifecycle node failover sweep failed: {error:#}");
        }
        thread::sleep(NODE_FAILOVER_SWEEP_INTERVAL);
    }
}

/// Kubernetes leaves a Pod on an unreachable node Terminating until the node
/// returns, so its Recreate Deployment never starts a replacement. Force
/// deleting the Pod lets the Deployment schedule it on a healthy node, where its
/// replicated volume reattaches once Kubernetes detaches it from the dead node.
/// Every kubectl call here checks this lifecycle's own fence, and the runtime
/// lease keeps a returning old Pod from owning the workspace again.
fn move_workspaces_off_down_nodes(cli: &crate::Cli) -> Result<()> {
    let nodes: Value = serde_json::from_slice(&crate::workspaces::kubectl(
        cli,
        &["get", "nodes", "-o", "json"],
        None,
    )?)
    .context("decode node list")?;
    let now = crate::workspaces::now();
    let down_nodes = nodes["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|node| {
            let ready = node["status"]["conditions"]
                .as_array()?
                .iter()
                .find(|condition| condition["type"] == "Ready")?;
            let since = kubernetes_time_unix(ready["lastTransitionTime"].as_str()?)?;
            let name = node["metadata"]["name"].as_str()?.to_owned();
            (ready["status"] != "True" && now.saturating_sub(since) >= NODE_DOWN_MOVE_SECONDS)
                .then_some((name, since))
        })
        .collect::<HashMap<_, _>>();
    if down_nodes.is_empty() {
        return Ok(());
    }
    let pods: Value = serde_json::from_slice(&crate::workspaces::kubectl(
        cli,
        &[
            "get",
            "pods",
            "--all-namespaces",
            "-l",
            "app.kubernetes.io/managed-by=adm",
            "-o",
            "json",
        ],
        None,
    )?)
    .context("decode workspace Pod list")?;
    for pod in pods["items"].as_array().into_iter().flatten() {
        let (Some(node), Some(namespace), Some(name), Some(workspace_id)) = (
            pod["spec"]["nodeName"].as_str(),
            pod["metadata"]["namespace"].as_str(),
            pod["metadata"]["name"].as_str(),
            pod["metadata"]["labels"]["adm.dev/workspace-id"].as_str(),
        ) else {
            continue;
        };
        let Some(since) = down_nodes.get(node) else {
            continue;
        };
        eprintln!(
            "adm lifecycle: node {node} has not been Ready for {}s; moving workspace {workspace_id} by force deleting Pod {namespace}/{name}",
            now.saturating_sub(*since)
        );
        if let Err(error) = crate::workspaces::kubectl(
            cli,
            &[
                "delete",
                "pod",
                name,
                "-n",
                namespace,
                "--grace-period=0",
                "--force",
                "--wait=false",
            ],
            None,
        ) {
            eprintln!(
                "adm lifecycle: moving workspace {workspace_id} off node {node} failed: {error:#}"
            );
        }
    }
    Ok(())
}

/// Parses a Kubernetes `metav1.Time` (`2026-10-22T15:35:17Z`) as Unix seconds.
fn kubernetes_time_unix(value: &str) -> Option<u64> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let mut date = date.splitn(3, '-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (date.next()??, date.next()??, date.next()??);
    let mut time = time.splitn(3, ':').map(|part| part.parse::<u64>().ok());
    let (hour, minute, second) = (time.next()??, time.next()??, time.next()??);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Days-from-civil (Howard Hinnant).
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days)
        .ok()
        .map(|days| days * 86_400 + hour * 3600 + minute * 60 + second)
}

fn lifecycle_worker(
    cli: crate::Cli,
    work: Arc<Mutex<mpsc::Receiver<String>>>,
    active_operations: Arc<Mutex<HashSet<String>>>,
) {
    loop {
        let operation_id = match work.lock() {
            Ok(receiver) => match receiver.recv() {
                Ok(operation_id) => operation_id,
                Err(_) => return,
            },
            Err(_) => return,
        };
        let Ok(mut active) = active_operations.lock() else {
            return;
        };
        if !active.insert(operation_id.clone()) {
            continue;
        }
        drop(active);
        let mut cli = cli.clone_for_lifecycle();
        cli.lifecycle_operation_id = Some(operation_id.clone());
        let outcome = (|| -> Result<()> {
            cli.check_lifecycle_fence()?;
            let store = cli.store()?;
            let receipt = store.lifecycle_operation(&operation_id)?;
            if receipt.status == "completed" {
                return Ok(());
            }
            store.update_lifecycle_operation(&operation_id, "running", "reconciling", None)?;
            let (_, encoded) = store
                .pending_lifecycle_operations()?
                .into_iter()
                .find(|(id, _)| id == &operation_id)
                .context("operation disappeared before worker admission")?;
            let request: OperationRequest = serde_json::from_str(&encoded)?;
            let workspace = match request {
                OperationRequest::Create { .. } => {
                    let existing = cli.store()?.find(&receipt.workspace_id);
                    match existing {
                        Ok(workspace) if workspace.phase == "ready" => workspace,
                        Ok(workspace) => crate::workspaces::create_persisted(&cli, workspace)?,
                        Err(_) => {
                            anyhow::bail!("admitted workspace {} is missing", receipt.workspace_id)
                        }
                    }
                }
                OperationRequest::Delete { workspace_id, .. } => {
                    let workspace = cli.store()?.find(&workspace_id)?;
                    if workspace.phase == "deleted" {
                        workspace
                    } else {
                        crate::workspaces::destroy(&cli, &workspace_id)?
                    }
                }
                OperationRequest::Update { workspace_id, .. } => {
                    crate::workspaces::upgrade_persisted(&cli, &workspace_id)?
                }
            };
            ensure!(
                workspace.id == receipt.workspace_id,
                "lifecycle operation workspace identity changed"
            );
            cli.check_lifecycle_fence()?;
            cli.store()?.update_lifecycle_operation(
                &operation_id,
                "completed",
                &workspace.phase,
                None,
            )?;
            Ok(())
        })();
        if let Err(error) = outcome {
            if cli.check_lifecycle_fence().is_ok()
                && let Ok(store) = cli.store()
            {
                if let Ok(receipt) = store.lifecycle_operation(&operation_id) {
                    let _ =
                        store.record_workspace_error(&receipt.workspace_id, &format!("{error:#}"));
                }
                let _ = store.update_lifecycle_operation(
                    &operation_id,
                    "failed",
                    "failed",
                    Some(&format!("{error:#}")),
                );
            }
            eprintln!("adm lifecycle operation {operation_id} failed: {error:#}");
        }
        if let Ok(mut active) = active_operations.lock() {
            active.remove(&operation_id);
        }
    }
}

fn handle_http(
    cli: &crate::Cli,
    wake: &mpsc::Sender<String>,
    token: &str,
    stream: &mut TcpStream,
) -> Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first_line = String::new();
    reader.read_line(&mut first_line)?;
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let mut content_length = 0usize;
    let mut authorization = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse()?;
        }
        if lower.starts_with("authorization:") {
            authorization = line
                .split_once(':')
                .map_or("", |(_, value)| value.trim())
                .to_owned();
        }
    }
    ensure!(content_length <= 1024 * 1024, "request body exceeds 1 MiB");
    let mut bytes = vec![0; content_length];
    reader.read_exact(&mut bytes)?;
    let public_health = method == "GET" && path == "/health";
    let runtime_route = is_runtime_auth_route(method, path) && authorization.starts_with("Bearer ");
    let response = if public_health || authorization == format!("Bearer {token}") || runtime_route {
        route(cli, wake, method, path, &bytes, &authorization)
    } else {
        Ok((
            401,
            serde_json::json!({"error":{"code":"UNAUTHORIZED","message":"valid lifecycle bearer token required"}}),
        ))
    };
    let (status, body) = match response {
        Ok((status, body)) => (status, body),
        Err(error) => {
            let message = format!("{error:#}");
            let (status, code) = runtime_http_error_status(&error, &message);
            (
                status,
                serde_json::json!({"error":{"code":code,"message":message}}),
            )
        }
    };
    let body = serde_json::to_vec(&body)?;
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        410 => "Gone",
        403 => "Forbidden",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(&body)?;
    Ok(())
}

fn runtime_http_error_status(error: &anyhow::Error, message: &str) -> (u16, &'static str) {
    if error.is::<ProviderAuthUnavailable>() {
        (503, "PROVIDER_AUTH_UNAVAILABLE")
    } else if error.is::<KubernetesApiUnavailable>() {
        (503, "KUBERNETES_API_UNAVAILABLE")
    } else if message.contains("operationId was already used") {
        (409, "OPERATION_CONFLICT")
    } else if message.contains("not authorized for workspace")
        || message.contains("not authorized for lifecycle operations")
        || message.contains("not authorized to create this workspace role")
        || message.contains("not authorized to delete this workspace role")
        || message.contains("held by another pod")
        || message.contains("runtime lease fencing token is stale")
        || message.contains("runtime status is restricted to its own workspace")
        || message.contains("bash execution is restricted to the owning coding workspace")
        || message.contains("project resources are restricted to the owning coding workspace")
        || message.contains("wrong audience")
        || message.contains("not bound to a Pod")
    {
        (403, "RUNTIME_FORBIDDEN")
    } else if message.contains("deleting")
        || message.contains("lease expired")
        || message.contains("lease is not held")
    {
        (410, "WORKSPACE_UNAVAILABLE")
    } else {
        (400, "INVALID_REQUEST")
    }
}

fn is_runtime_auth_route(method: &str, path: &str) -> bool {
    (method == "GET" && path == "/v1/runtime/workspaces")
        || (method == "POST" && path == "/v1/runtime/operations")
        || (method == "POST"
            && matches!(
                path,
                "/v1/provider-auth/resolve"
                    | "/v1/provider-auth/catalog"
                    | "/v1/runtime/connectors/catalog"
                    | "/v1/runtime/connectors/token"
            ))
        || (method == "POST"
            && path
                .strip_prefix("/v1/workspaces/")
                .and_then(|path| path.split_once("/runtime/"))
                .is_some_and(|(_, endpoint)| {
                    matches!(
                        endpoint,
                        "authorize" | "lease" | "lease/renew" | "lease/ack" | "check"
                    )
                }))
        || (method == "GET"
            && path
                .strip_prefix("/v1/runtime/operations/")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()))
}

pub fn request(
    url: &str,
    token_file: Option<&std::path::Path>,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let token = token_file
        .map(|path| fs::read_to_string(path).context("read lifecycle bearer token file"))
        .transpose()?;
    request_with_token(url, token.as_deref().map(str::trim), method, path, body)
}

pub fn request_wait(
    url: &str,
    token_file: Option<&std::path::Path>,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let token = token_file
        .map(|path| fs::read_to_string(path).context("read lifecycle bearer token file"))
        .transpose()?;
    request_with_token_wait(url, token.as_deref().map(str::trim), method, path, body)
}

pub fn kubernetes_token(cli: &crate::Cli) -> Result<String> {
    let bytes = crate::workspaces::kubectl(
        cli,
        &[
            "-n",
            &cli.lifecycle_namespace,
            "get",
            "secret",
            "adm-lifecycle-token",
            "-o",
            "go-template={{index .data \"token\" | base64decode}}",
        ],
        None,
    )
    .context("read lifecycle credential from Kubernetes using the selected host kubeconfig")?;
    let token = String::from_utf8(bytes).context("lifecycle credential must be UTF-8")?;
    let token = token.trim();
    ensure!(
        !token.is_empty(),
        "lifecycle credential in Kubernetes is empty"
    );
    Ok(token.to_owned())
}

pub fn request_with_token(
    url: &str,
    token: Option<&str>,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    request_with_token_timeout(
        url,
        token,
        method,
        path,
        body,
        Some(std::time::Duration::from_secs(30)),
    )
}

pub fn request_with_token_wait(
    url: &str,
    token: Option<&str>,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    request_with_token_timeout(url, token, method, path, body, None)
}

fn request_with_token_timeout(
    url: &str,
    token: Option<&str>,
    method: &str,
    path: &str,
    body: Option<&Value>,
    timeout: Option<std::time::Duration>,
) -> Result<Value> {
    let client =
        reqwest::blocking::Client::builder().connect_timeout(std::time::Duration::from_secs(5));
    let client = if let Some(timeout) = timeout {
        client.timeout(timeout).build()?
    } else {
        client.build()?
    };
    let method = reqwest::Method::from_bytes(method.as_bytes())?;
    let mut request = client.request(method, format!("{}{path}", url.trim_end_matches('/')));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().context(
        "lifecycle service unavailable; run `adm doctor` for control-plane installation and connection steps",
    )?;
    let status = response.status();
    let text = response.text()?;
    let value: Value = if text.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text)?
    };
    if !status.is_success() {
        let message = value["error"]["message"].as_str().unwrap_or(&text);
        if status == reqwest::StatusCode::UNAUTHORIZED {
            anyhow::bail!(
                "lifecycle service {status}: {message}. Run `adm setup` to configure the controller connection. Manual connections use ADM_LIFECYCLE_TOKEN_FILE (or --lifecycle-token-file), a protected file containing the same token as the controller's adm-lifecycle-token Secret. Installation: {INSTALLATION_GUIDE}"
            );
        }
        anyhow::bail!("lifecycle service {status}: {message}",);
    }
    Ok(value)
}

fn route(
    cli: &crate::Cli,
    wake: &mpsc::Sender<String>,
    method: &str,
    path: &str,
    body: &[u8],
    authorization: &str,
) -> Result<(u16, Value)> {
    if method == "GET" && path == "/health" {
        if let Err(error) = cli.check_lifecycle_fence() {
            return Ok((
                503,
                serde_json::json!({"status":"unavailable","service":"adm-lifecycle","error":format!("lifecycle Lease ownership lost: {error:#}")}),
            ));
        }
        return Ok((
            200,
            serde_json::json!({"status":"ok","service":"adm-lifecycle","ownerEpoch":cli.lifecycle_fence.as_ref().map(crate::lease::LeaseFence::epoch)}),
        ));
    }
    let mut store = cli.store()?;
    if method == "POST" && path == "/v1/runtime/maintenance/extend" {
        cli.check_lifecycle_fence()?;
        let request: RuntimeMaintenanceRequest = serde_json::from_slice(body)?;
        ensure!(
            request.duration_seconds <= UPDATE_MAINTENANCE_SECONDS,
            "controller update maintenance cannot exceed {UPDATE_MAINTENANCE_SECONDS} seconds"
        );
        let (expires_at, workspace_ids) =
            store.extend_runtime_leases(&request.maintenance_id, request.duration_seconds)?;
        notify_runtime_maintenance_changed();
        return Ok((
            200,
            serde_json::json!({"maintenanceId":request.maintenance_id,"expiresAt":expires_at,"workspaceIds":workspace_ids}),
        ));
    }
    if method == "POST" && path == "/v1/runtime/maintenance/await" {
        cli.check_lifecycle_fence()?;
        let request: RuntimeMaintenanceRequest = serde_json::from_slice(body)?;
        let missing = wait_for_runtime_maintenance(cli, &request.maintenance_id)?;
        ensure!(
            missing.is_empty(),
            "workspace runtimes did not acknowledge controller update maintenance: {}",
            missing.join(", ")
        );
        return Ok((
            200,
            serde_json::json!({"maintenanceId":request.maintenance_id,"ready":true}),
        ));
    }
    if method == "POST" && path == "/v1/runtime/maintenance/complete" {
        cli.check_lifecycle_fence()?;
        let request: RuntimeMaintenanceRequest = serde_json::from_slice(body)?;
        let expires_at = store.complete_runtime_maintenance(&request.maintenance_id)?;
        notify_runtime_maintenance_changed();
        return Ok((
            200,
            serde_json::json!({"maintenanceId":request.maintenance_id,"completed":true,"expiresAt":expires_at}),
        ));
    }
    if path.starts_with("/v1/provider-auth/")
        || path == "/v1/connectors"
        || path.starts_with("/v1/connectors/")
        || path.starts_with("/v1/runtime/connectors/")
    {
        cli.check_lifecycle_fence()?;
    }
    if method == "POST"
        && matches!(
            path,
            "/v1/provider-auth/resolve"
                | "/v1/provider-auth/catalog"
                | "/v1/runtime/connectors/catalog"
                | "/v1/runtime/connectors/token"
        )
    {
        let caller = authorize_runtime_caller(cli, &store, authorization)?;
        ensure!(
            matches!(caller.phase.as_str(), "provisioning" | "ready"),
            "workspace lifecycle is not active for provider requests"
        );
        return proxy_provider_auth(method, path, body);
    }
    if path.starts_with("/v1/provider-auth/")
        || path == "/v1/connectors"
        || path.starts_with("/v1/connectors/")
    {
        return proxy_provider_auth(method, path, body);
    }
    if method == "GET" && path == "/v1/runtime/workspaces" {
        cli.check_lifecycle_fence()?;
        let caller = authorize_runtime_caller(cli, &store, authorization)?;
        ensure!(
            caller.role == "bot",
            "runtime caller is not authorized for workspace directory"
        );
        let mut workspaces = store
            .list(true)?
            .into_iter()
            .filter(|workspace| {
                workspace.role == "coding"
                    && workspace.phase != "deleting"
                    && workspace.phase != "deleted"
            })
            .collect::<Vec<_>>();
        enrich_runtime_status(cli, &mut workspaces)?;
        let directory = workspaces
            .into_iter()
            .map(|workspace| {
                serde_json::json!({
                    "id": workspace.id,
                    "name": workspace.name,
                    "role": workspace.role,
                    "phase": workspace.phase,
                    "namespace": workspace.namespace,
                    "runtime_status": workspace.runtime_status,
                })
            })
            .collect::<Vec<_>>();
        return Ok((200, serde_json::Value::Array(directory)));
    }
    if method == "POST" && path == "/v1/runtime/operations" {
        cli.check_lifecycle_fence()?;
        let caller = authorize_runtime_caller(cli, &store, authorization)?;
        ensure!(
            caller.role == "bot",
            "runtime caller is not authorized for lifecycle operations"
        );
        let value: Value = serde_json::from_slice(body)?;
        let request = request_from_json(&value)?;
        match &request {
            OperationRequest::Create { spec, .. } => ensure!(
                spec.role == "coding",
                "runtime caller is not authorized to create this workspace role"
            ),
            OperationRequest::Delete { workspace_id, .. } => {
                let target = store.find(workspace_id)?;
                ensure!(
                    target.role == "coding",
                    "runtime caller is not authorized to delete this workspace role"
                );
            }
            OperationRequest::Update { .. } => anyhow::bail!(
                "runtime callers cannot update workspace images; use `adm update --workspace`"
            ),
        }
        let operation_id = request.operation_id().to_owned();
        let receipt = admit(&mut store, &request)?;
        if receipt.status != "completed" {
            let _ = wake.send(operation_id);
        }
        return Ok((202, serde_json::to_value(receipt)?));
    }
    if let Some(operation_id) = path.strip_prefix("/v1/runtime/operations/")
        && method == "GET"
    {
        cli.check_lifecycle_fence()?;
        let caller = authorize_runtime_caller(cli, &store, authorization)?;
        ensure!(
            caller.role == "bot",
            "runtime caller is not authorized for lifecycle operations"
        );
        return match store.lifecycle_operation(operation_id) {
            Ok(receipt) if store.find(&receipt.workspace_id)?.role == "coding" => {
                Ok((200, serde_json::to_value(receipt)?))
            }
            _ => Ok((
                404,
                serde_json::json!({"error":{"code":"OPERATION_NOT_FOUND"}}),
            )),
        };
    }
    if method == "POST" && path == "/v1/operations" {
        cli.check_lifecycle_fence()?;
        let value: Value = serde_json::from_slice(body)?;
        let request = request_from_json(&value)?;
        let operation_id = request.operation_id().to_owned();
        let receipt = admit(&mut store, &request)?;
        if receipt.status != "completed" {
            let _ = wake.send(operation_id);
        }
        return Ok((202, serde_json::to_value(receipt)?));
    }
    if let Some(operation_id) = path.strip_prefix("/v1/operations/")
        && method == "GET"
    {
        return match store.lifecycle_operation(operation_id) {
            Ok(receipt) => Ok((200, serde_json::to_value(receipt)?)),
            Err(_) => Ok((
                404,
                serde_json::json!({"error":{"code":"OPERATION_NOT_FOUND"}}),
            )),
        };
    }
    if method == "GET" && path == "/v1/workspaces" {
        let mut workspaces = store.list(true)?;
        enrich_runtime_status(cli, &mut workspaces)?;
        return Ok((200, serde_json::to_value(workspaces)?));
    }
    if let Some(id) = path.strip_prefix("/v1/workspaces/")
        && method == "GET"
    {
        return match store.find(id) {
            Ok(mut workspace) if workspace.id == id => {
                enrich_runtime_status(cli, std::slice::from_mut(&mut workspace))?;
                Ok((200, serde_json::to_value(workspace)?))
            }
            _ => Ok((
                404,
                serde_json::json!({"error":{"code":"WORKSPACE_NOT_FOUND"}}),
            )),
        };
    }
    if let Some(id) = path
        .strip_prefix("/v1/workspaces/")
        .and_then(|path| path.strip_suffix("/herdr"))
        && method == "PUT"
    {
        cli.check_lifecycle_fence()?;
        let value: Value = serde_json::from_slice(body)?;
        let space = value["spaceId"].as_str();
        return match store.bind_herdr_space(id, space) {
            Ok(workspace) => Ok((200, serde_json::to_value(workspace)?)),
            Err(error) => Ok((
                404,
                serde_json::json!({"error":{"code":"WORKSPACE_NOT_FOUND","message":format!("{error:#}")}}),
            )),
        };
    }
    if let Some((id, endpoint)) = path
        .strip_prefix("/v1/workspaces/")
        .and_then(|path| path.split_once("/runtime/"))
    {
        cli.check_lifecycle_fence()?;
        if method == "POST" && endpoint == "authorize" {
            let request: RuntimeAuthorizeRequest = serde_json::from_slice(body)?;
            authorize_workspace_action(cli, &store, id, &request.action, authorization)?;
            return Ok((200, serde_json::json!({"allowed":true})));
        }
        let request: RuntimeLeaseRequest = serde_json::from_slice(body)?;
        ensure!(
            uuid::Uuid::parse_str(&request.holder).is_ok(),
            "holder must be a Pod UID"
        );
        authorize_runtime(cli, id, &request.holder, authorization)?;
        let lease = match (method, endpoint) {
            ("POST", "lease") => {
                ensure!(
                    request.fencing_token.is_none(),
                    "lease acquisition must not include fencingToken"
                );
                let (fencing_token, expires_at) =
                    store.claim_runtime_lease(id, &request.holder, RUNTIME_LEASE_SECONDS)?;
                serde_json::json!({"workspaceId":id,"holder":request.holder,"fencingToken":fencing_token,"expiresAt":expires_at})
            }
            ("POST", "lease/renew") => {
                let fencing_token = request
                    .fencing_token
                    .context("lease renewal needs fencingToken")?;
                let expires_at = store.renew_runtime_lease(
                    id,
                    &request.holder,
                    fencing_token,
                    RUNTIME_LEASE_SECONDS,
                )?;
                let maintenance_id =
                    store.runtime_maintenance_for_lease(id, &request.holder, fencing_token)?;
                notify_runtime_maintenance_changed();
                serde_json::json!({"workspaceId":id,"holder":request.holder,"fencingToken":fencing_token,"expiresAt":expires_at,"maintenanceId":maintenance_id})
            }
            ("POST", "lease/ack") => {
                let fencing_token = request
                    .fencing_token
                    .context("maintenance acknowledgement needs fencingToken")?;
                store.acknowledge_runtime_maintenance(
                    id,
                    &request.holder,
                    fencing_token,
                    request
                        .maintenance_id
                        .as_deref()
                        .context("maintenance acknowledgement needs maintenanceId")?,
                    request
                        .expires_at
                        .context("maintenance acknowledgement needs expiresAt")?,
                )?;
                notify_runtime_maintenance_changed();
                serde_json::json!({"acknowledged":true})
            }
            ("POST", "check") => {
                let fencing_token = request
                    .fencing_token
                    .context("runtime check needs fencingToken")?;
                store.check_runtime_lease(id, &request.holder, fencing_token)?;
                serde_json::json!({"valid":true})
            }
            _ => return Ok((404, serde_json::json!({"error":{"code":"NOT_FOUND"}}))),
        };
        return Ok((200, lease));
    }
    Ok((404, serde_json::json!({"error":{"code":"NOT_FOUND"}})))
}

/// The lifecycle could not ask Kubernetes to review a runtime token. Runners treat
/// this 503 as lifecycle unavailability and wait, rather than as a fence rejection.
#[derive(Debug)]
struct KubernetesApiUnavailable(String);

impl std::fmt::Display for KubernetesApiUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for KubernetesApiUnavailable {}

#[derive(Debug)]
struct ProviderAuthUnavailable;

impl std::fmt::Display for ProviderAuthUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("provider authentication authority is unavailable")
    }
}

impl std::error::Error for ProviderAuthUnavailable {}

fn proxy_provider_auth(method: &str, path: &str, body: &[u8]) -> Result<(u16, Value)> {
    let login_route = path
        .strip_prefix("/v1/provider-auth/login/")
        .is_some_and(|tail| match tail.split_once('/') {
            Some((operation, suffix)) => {
                uuid::Uuid::parse_str(operation).is_ok() && matches!(suffix, "events" | "reply")
            }
            None => uuid::Uuid::parse_str(tail).is_ok(),
        });
    ensure!(
        matches!(
            path,
            "/v1/provider-auth/providers"
                | "/v1/provider-auth/login"
                | "/v1/provider-auth/logout"
                | "/v1/provider-auth/resolve"
                | "/v1/provider-auth/catalog"
        ) || path.starts_with("/v1/provider-auth/login/") && login_route
            || is_connector_route(method, path),
        "unknown provider auth route"
    );
    ensure!(
        matches!(method, "GET" | "POST" | "DELETE"),
        "unsupported provider auth method"
    );
    let client = reqwest::blocking::Client::new();
    let response = client
        .request(
            reqwest::Method::from_bytes(method.as_bytes())?,
            format!("http://127.0.0.1:7434{path}"),
        )
        .body(body.to_vec())
        .send()
        .map_err(|_| anyhow::Error::new(ProviderAuthUnavailable))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .map_err(|_| anyhow::Error::new(ProviderAuthUnavailable))?;
    if status >= 500 {
        return Err(anyhow::Error::new(ProviderAuthUnavailable));
    }
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).context("decode provider authentication response")?
    };
    Ok((status, value))
}

/// Installation MCP connector routes served by the shared authority: the
/// token-free runtime catalog and access tokens for Pods, and administration
/// (add, remove, sign-in, logout) for lifecycle-credential callers.
fn is_connector_route(method: &str, path: &str) -> bool {
    if method == "POST"
        && matches!(
            path,
            "/v1/runtime/connectors/catalog" | "/v1/runtime/connectors/token"
        )
    {
        return true;
    }
    if path == "/v1/connectors" {
        return matches!(method, "GET" | "POST");
    }
    let Some(rest) = path.strip_prefix("/v1/connectors/") else {
        return false;
    };
    let (name, action) = rest.split_once('/').unwrap_or((rest, ""));
    let valid_name = name.len() <= 32
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    valid_name
        && matches!(
            (method, action),
            ("DELETE", "")
                | ("POST", "logout")
                | ("POST", "sign-in")
                | ("DELETE", "sign-in")
                | ("POST", "sign-in/complete")
        )
}

fn enrich_runtime_status(cli: &crate::Cli, workspaces: &mut [Workspace]) -> Result<()> {
    if !workspaces
        .iter()
        .any(|workspace| workspace.phase != "deleted")
    {
        return Ok(());
    }
    let deadline = Instant::now() + RUNTIME_STATUS_TIMEOUT;
    let pods = crate::workspaces::kubectl_bounded(
        cli,
        &[
            "get",
            "pods",
            "--all-namespaces",
            "-l",
            "app.kubernetes.io/managed-by=adm",
            "-o",
            "json",
        ],
        None,
    )
    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).context("decode workspace Pod list"));
    match pods {
        Ok(pods) => {
            let mut requests = Vec::new();
            for (index, workspace) in workspaces
                .iter_mut()
                .enumerate()
                .filter(|(_, workspace)| workspace.phase != "deleted")
            {
                let matches = pods["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|pod| {
                        pod["metadata"]["namespace"] == workspace.namespace
                            && pod["metadata"]["labels"]["adm.dev/workspace-id"] == workspace.id
                            && pod["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "adm"
                    })
                    .collect::<Vec<_>>();
                if matches.len() == 1 {
                    let mut status = pod_runtime_status(matches[0]);
                    status["activity"] = serde_json::json!({"status":"unavailable","error":"runtime status has not been queried"});
                    status["selectedModel"] = Value::Null;
                    match matches[0]["status"]["podIP"]
                        .as_str()
                        .and_then(|ip| ip.parse::<IpAddr>().ok())
                    {
                        Some(ip) => requests.push(RuntimeStatusTarget {
                            index,
                            workspace_id: workspace.id.clone(),
                            ip,
                        }),
                        None => {
                            status["activity"] = serde_json::json!({"status":"unavailable","error":"workspace Pod has no valid IP address"});
                        }
                    }
                    workspace.runtime_status = Some(status);
                } else if matches.is_empty() {
                    workspace.runtime_status = Some(
                        serde_json::json!({"podName":null,"nodeName":null,"podPhase":"Missing","ready":false,"activity":{"status":"unavailable","error":"workspace Pod is missing"},"selectedModel":null}),
                    );
                } else {
                    workspace.runtime_status = Some(
                        serde_json::json!({"error":"multiple Pods match the canonical workspace ID","activity":{"status":"unavailable","error":"multiple Pods match the canonical workspace ID"},"selectedModel":null}),
                    );
                }
            }
            collect_runtime_status(cli, workspaces, requests, deadline);
        }
        Err(error) => {
            for workspace in workspaces
                .iter_mut()
                .filter(|workspace| workspace.phase != "deleted")
            {
                workspace.runtime_status = Some(
                    serde_json::json!({"error":format!("runtime status unavailable: {error:#}"),"activity":{"status":"unavailable","error":format!("workspace Pod list unavailable: {error:#}").chars().take(2000).collect::<String>()},"selectedModel":null}),
                );
            }
        }
    }
    Ok(())
}

fn collect_runtime_status(
    cli: &crate::Cli,
    workspaces: &mut [Workspace],
    requests: Vec<RuntimeStatusTarget>,
    deadline: Instant,
) {
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            mark_runtime_status_unavailable(
                workspaces,
                &requests,
                "runtime status HTTP client is unavailable",
            );
            return;
        }
    };
    // Every runtime is read at once so a list costs one runtime round trip.
    let (sender, receiver) = mpsc::channel();
    thread::scope(|scope| {
        for target in requests.iter().cloned() {
            let sender = sender.clone();
            let client = client.clone();
            scope.spawn(move || {
                let host = match target.ip {
                    IpAddr::V4(ip) => ip.to_string(),
                    IpAddr::V6(ip) => format!("[{ip}]"),
                };
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    let _ = sender.send((
                        target.index,
                        Err("runtime status collection exceeded its 1-second deadline".to_owned()),
                    ));
                    return;
                }
                let endpoint = format!(
                    "http://{host}:{}/v1/workspaces/{}/runtime-status",
                    cli.runtime_status_port, target.workspace_id
                );
                let result = client
                    .get(endpoint)
                    .timeout(remaining)
                    .send()
                    // `{:#}` keeps the source chain (timeout, refused, DNS, ...);
                    // reqwest's own message only says "error sending request".
                    .map_err(|error| {
                        format!(
                            "runtime status request failed: {:#}",
                            anyhow::Error::new(error)
                        )
                    })
                    .and_then(|response| {
                        let status = response.status();
                        if !status.is_success() {
                            // A runner waiting for its lease says why in its error
                            // body; keep that cause instead of a bare status.
                            let mut body = Vec::new();
                            let _ = response
                                .take(MAX_RUNTIME_STATUS_BYTES)
                                .read_to_end(&mut body);
                            let reported = serde_json::from_slice::<Value>(&body)
                                .ok()
                                .and_then(|value| {
                                    let code = value["error"]["code"].as_str()?.to_owned();
                                    let message = value["error"]["message"].as_str()?.to_owned();
                                    Some(format!(": {code}: {message}"))
                                })
                                .unwrap_or_default();
                            return Err(format!("runtime status returned HTTP {status}{reported}"));
                        }
                        let mut body = Vec::new();
                        response
                            .take(MAX_RUNTIME_STATUS_BYTES + 1)
                            .read_to_end(&mut body)
                            .map_err(|error| {
                                format!(
                                    "read runtime status response failed: {:#}",
                                    anyhow::Error::new(error)
                                )
                            })?;
                        if body.len() as u64 > MAX_RUNTIME_STATUS_BYTES {
                            return Err("runtime status response exceeded 64 KiB".to_owned());
                        }
                        serde_json::from_slice::<Value>(&body)
                            .map_err(|_| "runtime status response is invalid JSON".to_owned())
                    });
                let _ = sender.send((target.index, result));
            });
        }
        drop(sender);
        for (index, result) in receiver {
            match result {
                Ok(report) if valid_runtime_status_report(&report) => {
                    if let Some(status) = workspaces[index].runtime_status.as_mut() {
                        let mut activity =
                            serde_json::json!({"status":report["activity"]["status"]});
                        if let Some(error) = report["activity"]["error"].as_str() {
                            activity["error"] = Value::String(error.chars().take(2000).collect());
                        }
                        status["activity"] = activity;
                        status["selectedModel"] = report.get("selectedModel")
                            .filter(|model| !model.is_null())
                            .map(|model| serde_json::json!({"provider":model["provider"],"id":model["id"]}))
                            .unwrap_or(Value::Null);
                        // Installation MCP connectors this runtime cannot use.
                        status["connectors"] = report
                            .get("connectors")
                            .cloned()
                            .unwrap_or_else(|| Value::Array(Vec::new()));
                    }
                }
                Ok(_) => set_runtime_activity_unavailable(
                    &mut workspaces[index],
                    "runtime returned an invalid status report",
                ),
                Err(error) => set_runtime_activity_unavailable(&mut workspaces[index], &error),
            }
        }
    });
}

fn valid_runtime_status_report(report: &Value) -> bool {
    let activity = &report["activity"];
    let status = activity["status"].as_str();
    if !activity.as_object().is_some_and(|object| {
        object
            .keys()
            .all(|key| ["status", "error"].contains(&key.as_str()))
    }) || !status.is_some_and(|status| {
        ["needs_model", "running", "error", "idle", "unavailable"].contains(&status)
    }) {
        return false;
    }
    if activity["error"]
        .as_str()
        .is_some_and(|error| error.len() > 2000)
    {
        return false;
    }
    if let Some(connectors) = report.get("connectors")
        && !connectors.as_array().is_some_and(|connectors| {
            connectors.len() <= 64
                && connectors.iter().all(|connector| {
                    connector.as_object().is_some_and(|object| {
                        object
                            .keys()
                            .all(|key| ["name", "status", "error"].contains(&key.as_str()))
                    }) && connector["name"]
                        .as_str()
                        .is_some_and(|name| !name.is_empty() && name.len() <= 32)
                        && connector["status"].as_str().is_some_and(|status| {
                            ["connected", "sign_in_required", "error"].contains(&status)
                        })
                        && connector.get("error").is_none_or(|error| {
                            error.as_str().is_some_and(|error| error.len() <= 2000)
                        })
                })
        })
    {
        return false;
    }
    if let Some(model) = report.get("selectedModel").filter(|model| !model.is_null())
        && (!model.is_object()
            || model["provider"].as_str().is_none_or(str::is_empty)
            || model["id"].as_str().is_none_or(str::is_empty)
            || !model.as_object().is_some_and(|object| {
                object
                    .keys()
                    .all(|key| ["provider", "id"].contains(&key.as_str()))
            }))
    {
        return false;
    }
    true
}

fn mark_runtime_status_unavailable(
    workspaces: &mut [Workspace],
    requests: &[RuntimeStatusTarget],
    cause: &str,
) {
    for target in requests {
        set_runtime_activity_unavailable(&mut workspaces[target.index], cause);
    }
}

fn set_runtime_activity_unavailable(workspace: &mut Workspace, cause: &str) {
    if let Some(status) = workspace.runtime_status.as_mut() {
        status["activity"] = serde_json::json!({"status":"unavailable","error":cause});
        status["selectedModel"] = Value::Null;
    }
}

fn pod_runtime_status(pod: &Value) -> Value {
    let statuses = pod["status"]["containerStatuses"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ready = pod["status"]["phase"] == "Running"
        && !statuses.is_empty()
        && statuses.iter().all(|status| status["ready"] == true);
    let container_reason = statuses.iter().find_map(|status| {
        status["state"]["waiting"]["reason"]
            .as_str()
            .or_else(|| status["state"]["terminated"]["reason"].as_str())
    });
    let failed = pod["status"]["phase"] == "Failed";
    serde_json::json!({
        "podName":pod["metadata"]["name"],
        "podIP":pod["status"]["podIP"],
        "nodeName":pod["spec"]["nodeName"],
        "podPhase":pod["status"]["phase"],
        "ready":ready,
        "containerReason":container_reason,
        "error":if failed { pod["status"]["message"].as_str().or(pod["status"]["reason"].as_str()) } else { None },
    })
}

fn authorize_runtime(
    cli: &crate::Cli,
    workspace_id: &str,
    holder: &str,
    authorization: &str,
) -> Result<()> {
    let identity = review_runtime_token(cli, authorization)?;
    let workspace = cli.store()?.find(workspace_id)?;
    let expected_user = format!("system:serviceaccount:{}:adm-runtime", workspace.namespace);
    ensure!(
        identity.username == expected_user && identity.pod_uid == holder,
        "runtime caller is not authorized for workspace"
    );
    Ok(())
}

/// How long a successful runtime TokenReview is reused, at most; never past the
/// token's own `exp` (TASK-96). Before this every authenticated runtime request
/// started a `kubectl create --raw` TokenReview.
const RUNTIME_IDENTITY_CACHE_SECONDS: u64 = 60;

/// A runtime caller's reviewed identity. `owner_pod_confirmed` records that the
/// Pod named by the token was found in its workspace namespace with the ADM
/// labels; a Pod-bound token stops reviewing once that Pod is deleted.
#[derive(Clone)]
struct RuntimeIdentity {
    token_digest: [u8; 32],
    username: String,
    pod_uid: String,
    owner_pod_confirmed: bool,
}

/// Reviewed runtime identities by token SHA-256, each with its expiry.
static RUNTIME_IDENTITY_CACHE: Mutex<BTreeMap<[u8; 32], (RuntimeIdentity, Instant)>> =
    Mutex::new(BTreeMap::new());

fn runtime_token_digest(token: &str) -> [u8; 32] {
    ring::digest::digest(&ring::digest::SHA256, token.as_bytes())
        .as_ref()
        .try_into()
        .expect("SHA-256 digest is 32 bytes")
}

/// The `exp` claim of a ServiceAccount JWT. TokenReview has already verified its
/// signature by the time this is read.
fn runtime_token_expiry_unix(token: &str) -> Option<u64> {
    use base64::Engine;
    let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.split('.').nth(1)?)
        .ok()?;
    serde_json::from_slice::<Value>(&claims).ok()?["exp"].as_u64()
}

fn cached_runtime_identity(token_digest: &[u8; 32]) -> Option<RuntimeIdentity> {
    let cache = RUNTIME_IDENTITY_CACHE
        .lock()
        .expect("runtime identity cache lock");
    let (identity, expires_at) = cache.get(token_digest)?;
    (Instant::now() < *expires_at).then(|| identity.clone())
}

fn cache_runtime_identity(token: &str, identity: &RuntimeIdentity) {
    let now_unix = crate::workspaces::now();
    let lifetime =
        runtime_token_expiry_unix(token).map_or(RUNTIME_IDENTITY_CACHE_SECONDS, |expiry| {
            expiry
                .saturating_sub(now_unix)
                .min(RUNTIME_IDENTITY_CACHE_SECONDS)
        });
    let now = Instant::now();
    let mut cache = RUNTIME_IDENTITY_CACHE
        .lock()
        .expect("runtime identity cache lock");
    cache.retain(|_, (_, expires_at)| now < *expires_at);
    if lifetime > 0 {
        cache.insert(
            identity.token_digest,
            (identity.clone(), now + Duration::from_secs(lifetime)),
        );
    }
}

fn confirm_runtime_owner_pod(token_digest: &[u8; 32]) {
    if let Some((identity, _)) = RUNTIME_IDENTITY_CACHE
        .lock()
        .expect("runtime identity cache lock")
        .get_mut(token_digest)
    {
        identity.owner_pod_confirmed = true;
    }
}

fn review_runtime_token(cli: &crate::Cli, authorization: &str) -> Result<RuntimeIdentity> {
    let token = authorization
        .strip_prefix("Bearer ")
        .context("runtime bearer token required")?;
    ensure!(
        !token.is_empty() && !token.contains('\n'),
        "invalid runtime bearer token"
    );
    let token_digest = runtime_token_digest(token);
    if let Some(identity) = cached_runtime_identity(&token_digest) {
        return Ok(identity);
    }
    let review_request = serde_json::json!({
        "apiVersion":"authentication.k8s.io/v1",
        "kind":"TokenReview",
        "spec":{"token":token,"audiences":["adm-lifecycle"]}
    });
    let response = crate::workspaces::kubectl(
        cli,
        &[
            "create",
            "--raw",
            "/apis/authentication.k8s.io/v1/tokenreviews",
            "-f",
            "-",
        ],
        Some(&serde_json::to_vec(&review_request)?),
    )
    .map_err(|error| {
        anyhow::Error::new(KubernetesApiUnavailable(format!(
            "TokenReview failed: {error:#}"
        )))
    })?;
    let review: Value = serde_json::from_slice(&response)?;
    ensure!(
        review["status"]["authenticated"] == true,
        "runtime caller is not authorized for workspace"
    );
    ensure!(
        review["status"]["audiences"]
            .as_array()
            .is_some_and(|audiences| audiences.iter().any(|audience| audience == "adm-lifecycle")),
        "runtime token has the wrong audience"
    );
    let username = review["status"]["user"]["username"]
        .as_str()
        .context("runtime identity is missing")?
        .to_owned();
    let pod_uid = review["status"]["user"]["extra"]["authentication.kubernetes.io/pod-uid"][0]
        .as_str()
        .context("runtime ServiceAccount token is not bound to a Pod")?
        .to_owned();
    ensure!(
        uuid::Uuid::parse_str(&pod_uid).is_ok(),
        "runtime ServiceAccount token is not bound to a Pod"
    );
    let identity = RuntimeIdentity {
        token_digest,
        username,
        pod_uid,
        owner_pod_confirmed: false,
    };
    cache_runtime_identity(token, &identity);
    Ok(identity)
}

fn authorize_workspace_action(
    cli: &crate::Cli,
    store: &WorkspaceStore,
    target_id: &str,
    action: &str,
    authorization: &str,
) -> Result<()> {
    ensure!(
        matches!(
            action,
            "read"
                | "prompt"
                | "abort"
                | "resume"
                | "goal"
                | "loop"
                | "model"
                | "delete"
                | "status"
                | "resources"
                | "bash"
        ),
        "unknown runtime action"
    );
    let target = store.find(target_id)?;
    let source = authorize_runtime_caller(cli, store, authorization)?;
    if target.phase == "deleting" || target.phase == "deleted" {
        anyhow::bail!("workspace lifecycle is deleting");
    }
    ensure!(
        action != "status" || source.id == target.id,
        "runtime status is restricted to its own workspace"
    );
    ensure!(
        action != "resources" || (source.id == target.id && target.role == "coding"),
        "project resources are restricted to the owning coding workspace"
    );
    ensure!(
        action != "bash" || bash_action_allowed(&source.id, &source.role, &target.id, &target.role),
        "bash execution is restricted to the owning coding workspace"
    );
    ensure!(
        source.id == target.id || (source.role == "bot" && target.role == "coding"),
        "runtime caller is not authorized for workspace"
    );
    Ok(())
}

fn bash_action_allowed(
    source_id: &str,
    source_role: &str,
    target_id: &str,
    target_role: &str,
) -> bool {
    source_id == target_id && source_role == "coding" && target_role == "coding"
}

pub(crate) fn authorize_runtime_caller(
    cli: &crate::Cli,
    store: &WorkspaceStore,
    authorization: &str,
) -> Result<Workspace> {
    let identity = review_runtime_token(cli, authorization)?;
    let pod_uid = &identity.pod_uid;
    let (service_account, name) = identity
        .username
        .rsplit_once(':')
        .context("runtime identity is invalid")?;
    ensure!(
        service_account.starts_with("system:serviceaccount:"),
        "runtime identity is invalid"
    );
    ensure!(
        name == "adm-runtime",
        "runtime ServiceAccount is not authorized for workspace"
    );
    let namespace = service_account
        .strip_prefix("system:serviceaccount:")
        .context("runtime identity is invalid")?;
    let source = store
        .list(true)?
        .into_iter()
        .find(|workspace| workspace.namespace == namespace)
        .context("runtime caller is not authorized for workspace")?;
    ensure!(
        source.phase != "deleting" && source.phase != "deleted",
        "runtime caller is not authorized for workspace"
    );
    // A token's Pod and the workspace owning its namespace never change, so one
    // lookup per reviewed token is enough (TASK-96).
    if !identity.owner_pod_confirmed {
        let pods = crate::workspaces::kubectl(
            cli,
            &[
                "get",
                "pods",
                "-n",
                &source.namespace,
                "-l",
                "app.kubernetes.io/managed-by=adm",
                "-o",
                "json",
            ],
            None,
        )?;
        let pods: Value = serde_json::from_slice(&pods).context("decode runtime owner Pod list")?;
        let live_owner_pods = pods["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|pod| {
                pod["metadata"]["namespace"] == source.namespace
                    && pod["metadata"]["uid"] == pod_uid.as_str()
                    && pod["metadata"]["labels"]["adm.dev/workspace-id"] == source.id
                    && pod["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "adm"
            })
            .count();
        ensure!(
            live_owner_pods == 1,
            "runtime caller is not authorized for workspace"
        );
        confirm_runtime_owner_pod(&identity.token_digest);
    }
    store.check_runtime_owner(&source.id, pod_uid)?;
    Ok(source)
}

#[cfg(test)]
mod provider_auth_wait_tests {
    use super::*;
    use clap::Parser;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    #[test]
    fn bash_action_is_limited_to_the_owning_coding_workspace() {
        assert!(bash_action_allowed("code", "coding", "code", "coding"));
        assert!(!bash_action_allowed("bot", "bot", "bot", "bot"));
        assert!(!bash_action_allowed("bot", "bot", "code", "coding"));
        assert!(!bash_action_allowed("code", "coding", "other", "coding"));
        let error = anyhow::anyhow!("bash execution is restricted to the owning coding workspace");
        assert_eq!(
            runtime_http_error_status(&error, &error.to_string()),
            (403, "RUNTIME_FORBIDDEN")
        );
    }

    #[test]
    fn projected_identity_bypass_is_limited_to_exact_runtime_routes() {
        assert!(is_runtime_auth_route("POST", "/v1/provider-auth/resolve"));
        assert!(is_runtime_auth_route("POST", "/v1/provider-auth/catalog"));
        assert!(!is_runtime_auth_route("GET", "/v1/provider-auth/catalog"));
        assert!(is_runtime_auth_route("GET", "/v1/runtime/workspaces"));
        assert!(is_runtime_auth_route("POST", "/v1/runtime/operations"));
        assert!(is_runtime_auth_route(
            "GET",
            "/v1/runtime/operations/00000000-0000-4000-8000-000000000001"
        ));
        assert!(!is_runtime_auth_route("POST", "/v1/provider-auth/logout"));
        assert!(!is_runtime_auth_route(
            "GET",
            "/v1/runtime/operations/../../provider-auth/logout"
        ));
        assert!(!is_runtime_auth_route(
            "POST",
            "/v1/runtime/operations/00000000-0000-4000-8000-000000000001"
        ));
    }

    #[test]
    fn arbitrary_pod_bearers_cannot_reach_provider_admin_routes_over_lifecycle_http() {
        let cli = crate::Cli::try_parse_from(["adm", "login"]).unwrap();
        let (wake, _receiver) = mpsc::channel();
        for path in [
            "/v1/provider-auth/logout",
            "/v1/runtime/operations/00000000-0000-4000-8000-000000000001/../provider-auth/logout",
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let client = thread::spawn(move || {
                let mut socket = TcpStream::connect(address).unwrap();
                write!(socket, "POST {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer arbitrary-pod-token\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
                let mut response = String::new();
                socket.read_to_string(&mut response).unwrap();
                response
            });
            let (mut stream, _) = listener.accept().unwrap();
            handle_http(&cli, &wake, "lifecycle-admin-secret", &mut stream).unwrap();
            drop(stream);
            assert!(
                client
                    .join()
                    .unwrap()
                    .starts_with("HTTP/1.1 401 Unauthorized")
            );
        }
    }

    #[test]
    fn provider_login_event_waits_for_browser_completion_without_standard_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (received_tx, received_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let _ = socket.read(&mut request).unwrap();
            received_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            let body = br#"{"event":{"type":"complete"},"done":true}"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
        });
        let url = format!("http://{address}");
        let client = thread::spawn(move || {
            request_with_token_wait(
                &url,
                Some("synthetic-lifecycle-token"),
                "GET",
                "/v1/provider-auth/login/op/events",
                None,
            )
        });
        received_rx.recv().unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(client.join().unwrap().unwrap()["event"]["type"], "complete");
        server.join().unwrap();
    }
}
