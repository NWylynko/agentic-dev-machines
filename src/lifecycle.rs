//! Durable lifecycle operation receipts shared by CLI, bots, and Herdr.

use crate::workspaces::{Workspace, WorkspaceStore};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperationRequest {
    Create {
        #[serde(rename = "operationId")]
        operation_id: String,
        spec: CreateIntent,
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
    pub allowed_agents: Vec<String>,
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
            allowed_agents: workspace.allowed_agents.clone(),
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
        ensure!(
            !self.agent_enabled || self.model.is_some(),
            "agent workspaces require a selected model"
        );
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
            self.image.trim().len() > 0
                && self.storage_size.trim().len() > 0
                && self.cpu.trim().len() > 0
                && self.memory.trim().len() > 0,
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
            runtime_status: None,
            image: self.image,
            storage_class: self.storage_class,
            storage_size: self.storage_size,
            cpu: self.cpu,
            memory: self.memory,
            agent_enabled: self.agent_enabled,
            allow_node_local_storage: self.allow_node_local_storage,
            repositories: self.repositories,
            catalog: self.catalog,
            repository: self.repository,
            cwd: self.cwd,
            model: self.model,
            credential_env: self.credential_env,
            allowed_agents: self.allowed_agents,
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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeAuthorizeRequest {
    action: String,
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
    let worker_cli = cli.clone_for_lifecycle();
    thread::spawn(move || lifecycle_worker(worker_cli, work));
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

fn lifecycle_worker(cli: crate::Cli, work: mpsc::Receiver<String>) {
    for operation_id in work {
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
    let runtime_route = path.contains("/runtime/") && authorization.starts_with("Bearer ");
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
                || message.contains("held by another pod")
                || message.contains("runtime lease fencing token is stale")
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

pub fn request(
    url: &str,
    token_file: Option<&std::path::Path>,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let method = reqwest::Method::from_bytes(method.as_bytes())?;
    let mut request = client.request(method, format!("{}{path}", url.trim_end_matches('/')));
    if let Some(path) = token_file {
        let token = fs::read_to_string(path).context("read lifecycle bearer token file")?;
        request = request.bearer_auth(token.trim());
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().context("lifecycle service unavailable")?;
    let status = response.status();
    let text = response.text()?;
    let value: Value = if text.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text)?
    };
    if !status.is_success() {
        anyhow::bail!(
            "lifecycle service {status}: {}",
            value["error"]["message"].as_str().unwrap_or(&text)
        );
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
    let mut store = cli.store()?;
    if method == "GET" && path == "/health" {
        return Ok((
            200,
            serde_json::json!({"status":"ok","service":"adm-lifecycle"}),
        ));
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
        enrich_runtime_status(cli, &mut workspaces);
        return Ok((200, serde_json::to_value(workspaces)?));
    }
    if let Some(id) = path.strip_prefix("/v1/workspaces/")
        && method == "GET"
    {
        return match store.find(id) {
            Ok(mut workspace) if workspace.id == id => {
                enrich_runtime_status(cli, std::slice::from_mut(&mut workspace));
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
                serde_json::json!({"workspaceId":id,"holder":request.holder,"fencingToken":fencing_token,"expiresAt":expires_at})
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

fn enrich_runtime_status(cli: &crate::Cli, workspaces: &mut [Workspace]) {
    if !workspaces
        .iter()
        .any(|workspace| workspace.phase != "deleted")
    {
        return;
    }
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
    )
    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).context("decode workspace Pod list"));
    match pods {
        Ok(pods) => {
            for workspace in workspaces
                .iter_mut()
                .filter(|workspace| workspace.phase != "deleted")
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
                workspace.runtime_status = Some(if matches.len() == 1 {
                    pod_runtime_status(matches[0])
                } else if matches.is_empty() {
                    serde_json::json!({"podName":null,"nodeName":null,"podPhase":"Missing","ready":false})
                } else {
                    serde_json::json!({"error":"multiple Pods match the canonical workspace ID"})
                });
            }
        }
        Err(error) => {
            for workspace in workspaces
                .iter_mut()
                .filter(|workspace| workspace.phase != "deleted")
            {
                workspace.runtime_status = Some(
                    serde_json::json!({"error":format!("runtime status unavailable: {error:#}")}),
                );
            }
        }
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
            "read" | "prompt" | "abort" | "resume" | "goal" | "loop" | "model" | "delete"
        ),
        "unknown runtime action"
    );
    let target = store.find(target_id)?;
    let (username, _) = review_runtime_token(cli, authorization)?;
    if username
        == format!(
            "system:serviceaccount:{}:adm-lifecycle",
            cli.lifecycle_namespace
        )
    {
        ensure!(
            matches!(action, "delete" | "abort"),
            "lifecycle identity cannot perform this runtime action"
        );
        return Ok(());
    }
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
    if target.phase == "deleting" || target.phase == "deleted" {
        anyhow::bail!("workspace lifecycle is deleting");
    }
    ensure!(
        source.id == target.id || (source.role == "bot" && target.role == "coding"),
        "runtime caller is not authorized for workspace"
    );
    Ok(())
}
