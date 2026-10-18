//! Durable lifecycle operation receipts shared by CLI, bots, and Herdr.

use crate::workspaces::{Workspace, WorkspaceStore};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, TcpListener, TcpStream},
    sync::{Arc, Condvar, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

const RUNTIME_STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const RUNTIME_STATUS_PARALLELISM: usize = 4;
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
    #[serde(default = "default_cwd")]
    pub cwd: String,
    pub model: Option<Value>,
    #[serde(default)]
    pub credential_env: Vec<crate::workspaces::CredentialEnvRef>,
    #[serde(default)]
    pub mcp_servers: Option<Value>,
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
            cwd: workspace.cwd.clone(),
            model: workspace.model.clone(),
            credential_env: workspace.credential_env.clone(),
            mcp_servers: workspace.mcp_servers.clone(),
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
        ensure!(
            self.mcp_servers.as_ref().is_none_or(Value::is_array),
            "MCP config must be a JSON array"
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
            cwd: self.cwd,
            model: self.model,
            credential_env: self.credential_env,
            mcp_servers: self.mcp_servers,
            herdr_space: self.herdr_space,
            created_at: crate::workspaces::now(),
            last_error: None,
        })
    }
}

impl OperationRequest {
    pub fn operation_id(&self) -> &str {
        match self {
            Self::Create { operation_id, .. } | Self::Delete { operation_id, .. } => operation_id,
        }
    }

    pub fn workspace_id(&self) -> Option<&str> {
        match self {
            Self::Create { .. } => None,
            Self::Delete { workspace_id, .. } => Some(workspace_id),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Create { .. } => "create",
            Self::Delete { .. } => "delete",
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
    namespace: String,
    pod_name: String,
    pod_uid: String,
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
            let (status, code) = if message.contains("operationId was already used") {
                (409, "OPERATION_CONFLICT")
            } else if message.contains("not authorized for workspace")
                || message.contains("not authorized for lifecycle operations")
                || message.contains("not authorized to create this workspace role")
                || message.contains("not authorized to delete this workspace role")
                || message.contains("held by another pod")
                || message.contains("runtime lease fencing token is stale")
                || message.contains("runtime status is restricted to its own workspace")
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
            };
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

fn is_runtime_auth_route(method: &str, path: &str) -> bool {
    (method == "GET" && path == "/v1/runtime/workspaces")
        || (method == "POST" && path == "/v1/runtime/operations")
        || (method == "POST"
            && matches!(
                path,
                "/v1/provider-auth/resolve" | "/v1/provider-auth/catalog"
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
        if let Err(error) = cli.check_lifecycle_fence_bounded() {
            return Ok((
                503,
                serde_json::json!({"status":"unavailable","service":"adm-lifecycle","error":format!("lifecycle Lease ownership lost: {error:#}")}),
            ));
        }
        return Ok((
            200,
            serde_json::json!({"status":"ok","service":"adm-lifecycle"}),
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
    if path.starts_with("/v1/provider-auth/") {
        cli.check_lifecycle_fence()?;
    }
    if method == "POST"
        && matches!(
            path,
            "/v1/provider-auth/resolve" | "/v1/provider-auth/catalog"
        )
    {
        let caller = authorize_runtime_caller(cli, &store, authorization)?;
        ensure!(
            matches!(caller.phase.as_str(), "provisioning" | "ready"),
            "workspace lifecycle is not active for provider requests"
        );
        return proxy_provider_auth(method, path, body);
    }
    if path.starts_with("/v1/provider-auth/") {
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
        ) || path.starts_with("/v1/provider-auth/login/") && login_route,
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
        .context("connect to the provider authentication authority")?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .context("read provider authentication response")?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).context("decode provider authentication response")?
    };
    Ok((status, value))
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
                        Some(ip) => {
                            let pod_name = matches[0]["metadata"]["name"].as_str();
                            let pod_uid = matches[0]["metadata"]["uid"].as_str();
                            if let (Some(pod_name), Some(pod_uid)) = (pod_name, pod_uid) {
                                requests.push(RuntimeStatusTarget {
                                    index,
                                    workspace_id: workspace.id.clone(),
                                    namespace: workspace.namespace.clone(),
                                    pod_name: pod_name.to_owned(),
                                    pod_uid: pod_uid.to_owned(),
                                    ip,
                                });
                            } else {
                                status["activity"] = serde_json::json!({"status":"unavailable","error":"workspace Pod identity is incomplete"});
                            }
                        }
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
    for (batch_index, batch) in requests.chunks(RUNTIME_STATUS_PARALLELISM).enumerate() {
        if Instant::now() >= deadline {
            mark_runtime_status_unavailable(
                workspaces,
                &requests[batch_index * RUNTIME_STATUS_PARALLELISM..],
                "runtime status collection exceeded its 5-second deadline",
            );
            return;
        }
        let (sender, receiver) = mpsc::channel();
        thread::scope(|scope| {
            for target in batch.iter().cloned() {
                let sender = sender.clone();
                let client = client.clone();
                scope.spawn(move || {
                    let host = match target.ip {
                        IpAddr::V4(ip) => ip.to_string(),
                        IpAddr::V6(ip) => format!("[{ip}]"),
                    };
                    let token = match runtime_status_token(cli, &target) {
                        Ok(token) => token,
                        Err(error) => {
                            let _ = sender.send((
                                target.index,
                                Err(format!("mint target runtime token failed: {error:#}")),
                            ));
                            return;
                        }
                    };
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        let _ = sender.send((
                            target.index,
                            Err("runtime status collection exceeded its 5-second deadline"
                                .to_owned()),
                        ));
                        return;
                    }
                    let endpoint = format!(
                        "http://{host}:{}/v1/workspaces/{}/runtime-status",
                        cli.runtime_status_port, target.workspace_id
                    );
                    let result = client
                        .get(endpoint)
                        .bearer_auth(token)
                        .timeout(remaining)
                        .send()
                        .map_err(|error| format!("runtime status request failed: {error}"))
                        .and_then(|response| {
                            let status = response.status();
                            if !status.is_success() {
                                return Err(format!("runtime status returned HTTP {status}"));
                            }
                            let mut body = Vec::new();
                            response
                                .take(MAX_RUNTIME_STATUS_BYTES + 1)
                                .read_to_end(&mut body)
                                .map_err(|error| {
                                    format!("read runtime status response failed: {error}")
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
                                activity["error"] =
                                    Value::String(error.chars().take(2000).collect());
                            }
                            status["activity"] = activity;
                            status["selectedModel"] = report.get("selectedModel")
                                .filter(|model| !model.is_null())
                                .map(|model| serde_json::json!({"provider":model["provider"],"id":model["id"]}))
                                .unwrap_or(Value::Null);
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

fn runtime_status_token(cli: &crate::Cli, target: &RuntimeStatusTarget) -> Result<String> {
    ensure!(
        uuid::Uuid::parse_str(&target.pod_uid).is_ok(),
        "workspace Pod UID is invalid"
    );
    let path = format!(
        "/api/v1/namespaces/{}/serviceaccounts/adm-runtime/token",
        target.namespace
    );
    let request = serde_json::json!({
        "apiVersion":"authentication.k8s.io/v1",
        "kind":"TokenRequest",
        "spec":{
            "audiences":["adm-lifecycle"],
            "expirationSeconds":600,
            "boundObjectRef":{
                "apiVersion":"v1",
                "kind":"Pod",
                "name":target.pod_name,
                "uid":target.pod_uid
            }
        }
    });
    let response = crate::workspaces::kubectl_bounded(
        cli,
        &["create", "--raw", &path, "-f", "-"],
        Some(&serde_json::to_vec(&request)?),
    )?;
    let token = serde_json::from_slice::<Value>(&response)?["status"]["token"]
        .as_str()
        .context("Kubernetes TokenRequest omitted its token")?
        .to_owned();
    ensure!(
        !token.is_empty() && !token.contains('\n'),
        "Kubernetes TokenRequest returned an invalid token"
    );
    Ok(token)
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
    let (username, pod_uid) = review_runtime_token(cli, authorization)?;
    let workspace = cli.store()?.find(workspace_id)?;
    let expected_user = format!("system:serviceaccount:{}:adm-runtime", workspace.namespace);
    ensure!(
        username == expected_user && pod_uid == holder,
        "runtime caller is not authorized for workspace"
    );
    Ok(())
}

fn review_runtime_token(cli: &crate::Cli, authorization: &str) -> Result<(String, String)> {
    let token = authorization
        .strip_prefix("Bearer ")
        .context("runtime bearer token required")?;
    ensure!(
        !token.is_empty() && !token.contains('\n'),
        "invalid runtime bearer token"
    );
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
    )?;
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
    Ok((username, pod_uid))
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
        source.id == target.id || (source.role == "bot" && target.role == "coding"),
        "runtime caller is not authorized for workspace"
    );
    Ok(())
}

pub(crate) fn authorize_runtime_caller(
    cli: &crate::Cli,
    store: &WorkspaceStore,
    authorization: &str,
) -> Result<Workspace> {
    let (username, pod_uid) = review_runtime_token(cli, authorization)?;
    let (service_account, name) = username
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
    let pods = crate::workspaces::kubectl(
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
    )?;
    let pods: Value = serde_json::from_slice(&pods).context("decode runtime owner Pod list")?;
    let live_owner_pods = pods["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|pod| {
            pod["metadata"]["namespace"] == source.namespace
                && pod["metadata"]["uid"] == pod_uid
                && pod["metadata"]["labels"]["adm.dev/workspace-id"] == source.id
                && pod["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "adm"
        })
        .count();
    ensure!(
        live_owner_pods == 1,
        "runtime caller is not authorized for workspace"
    );
    store.check_runtime_owner(&source.id, &pod_uid)?;
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
