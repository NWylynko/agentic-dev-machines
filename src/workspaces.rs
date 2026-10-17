use crate::{Cli, runner};
use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::Stdio,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const MANAGED_BY: &str = "adm";

fn lifecycle_stage<T>(
    operation: &str,
    name: &str,
    stage: &str,
    action: impl FnOnce() -> Result<T>,
) -> Result<T> {
    eprintln!("adm: {operation} {name}: {stage} started");
    let started = Instant::now();
    let result = action();
    let outcome = if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    eprintln!(
        "adm: {operation} {name}: {stage} {outcome} in {:.3}s",
        started.elapsed().as_secs_f64()
    );
    result
}

fn lifecycle_complete(operation: &str, name: &str, outcome: &str, started: Instant) {
    eprintln!(
        "adm: {operation} {name}: {outcome} in {:.3}s",
        started.elapsed().as_secs_f64()
    );
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub role: String,
    pub namespace: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletion_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_status: Option<Value>,
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
    #[serde(default = "default_workspace_cwd")]
    pub cwd: String,
    pub model: Option<Value>,
    #[serde(default)]
    pub credential_env: Vec<CredentialEnvRef>,
    pub allowed_agents: Vec<String>,
    #[serde(default)]
    pub mcp_servers: Option<Value>,
    pub herdr_space: Option<String>,
    pub created_at: u64,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CredentialEnvRef {
    pub name: String,
    pub secret_name: String,
    pub key: String,
}

#[derive(Args)]
pub struct CreateOptions {
    pub name: String,
    /// Stable lifecycle operation UUID used to replay this create request.
    #[arg(long)]
    pub operation_id: Option<String>,
    /// Bot agents run in the management-host runner and have no workspace Pod.
    #[arg(long,default_value="coding",value_parser=["coding","bot"])]
    pub role: String,
    /// Workspace image; otherwise use the configured or matching release image.
    #[arg(
        long,
        default_value = "ghcr.io/nwylynko/agentic-dev-machines:latest",
        hide_default_value = true
    )]
    pub image: String,
    /// StorageClass; otherwise use the configured default or adm-replicated.
    #[arg(long, default_value = "adm-replicated", hide_default_value = true)]
    pub storage_class: String,
    #[arg(long, default_value = "4Gi")]
    pub storage_size: String,
    #[arg(long, default_value = "2")]
    pub cpu: String,
    #[arg(long, default_value = "2Gi")]
    pub memory: String,
    #[arg(long)]
    pub no_repositories: bool,
    #[arg(long)]
    pub catalog: Option<std::path::PathBuf>,
    /// Clone one public GitHub repository into this workspace.
    #[arg(long)]
    pub repo: Option<String>,
    /// Provider/model-id; overrides the model chosen in adm setup.
    #[arg(long)]
    pub model: Option<String>,
    /// Inject one key from a Secret created in this workspace's namespace: ENV=SECRET:KEY.
    #[arg(long = "credential-env", value_name = "ENV=SECRET:KEY")]
    pub credential_env: Vec<String>,
    #[arg(long)]
    pub allow_node_local_storage: bool,
    #[arg(long)]
    pub herdr_space: Option<String>,
    #[arg(long)]
    pub allow_agent: Vec<String>,
    /// JSON file containing host-configured stdio MCP servers and exact tool grants.
    #[arg(long)]
    pub mcp_config: Option<std::path::PathBuf>,
}

pub fn validate_name(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty() && name.len() <= 48,
        "workspace name must be 1-48 lowercase letters, digits or hyphens"
    );
    ensure!(
        name.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && name.ends_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit()),
        "invalid workspace name: {name}"
    );
    Ok(())
}

fn default_workspace_cwd() -> String {
    "/repos".into()
}

pub fn validate_repository_ref(repository: &str) -> Result<(&str, &str)> {
    let (owner, name) = repository
        .split_once('/')
        .context("repository must be OWNER/REPO")?;
    ensure!(
        valid_repository_component(owner),
        "invalid repository owner: {owner}"
    );
    ensure!(
        valid_repository_component(name),
        "invalid repository name: {name}"
    );
    Ok((owner, name))
}

fn valid_repository_component(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && component
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

fn parse_credential_env_ref(reference: &str) -> Result<CredentialEnvRef> {
    let (name, target) = reference
        .split_once('=')
        .context("credential reference must be ENV=SECRET:KEY")?;
    let (secret_name, key) = target
        .split_once(':')
        .context("credential reference must be ENV=SECRET:KEY")?;
    ensure!(
        !name.is_empty()
            && name.as_bytes()[0].is_ascii_uppercase()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
        "credential environment name must be a valid uppercase environment variable"
    );
    ensure!(
        !secret_name.is_empty()
            && secret_name.len() <= 63
            && secret_name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && secret_name.ends_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && secret_name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "credential Secret name must be a lowercase DNS name"
    );
    ensure!(
        !key.is_empty()
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)),
        "credential Secret key is invalid"
    );
    Ok(CredentialEnvRef {
        name: name.to_owned(),
        secret_name: secret_name.to_owned(),
        key: key.to_owned(),
    })
}

impl CreateOptions {
    pub fn workspace(&self) -> Result<Workspace> {
        validate_name(&self.name)?;
        if let Some(repository) = &self.repo {
            validate_repository_ref(repository)?;
        }
        ensure!(
            !(self.no_repositories && self.catalog.is_some()),
            "--catalog cannot be combined with --no-repositories"
        );
        ensure!(
            !(self.role == "bot" && self.catalog.is_some()),
            "--catalog is only supported for coding workspaces"
        );
        ensure!(
            self.role == "bot" || self.mcp_config.is_none(),
            "--mcp-config is only supported for bot workspaces"
        );
        ensure!(
            self.repo.is_none() || self.catalog.is_none(),
            "--repo cannot be combined with --catalog"
        );
        ensure!(
            self.repo.is_none() || !self.no_repositories,
            "--repo cannot be combined with --no-repositories"
        );
        ensure!(
            self.repo.is_none() || self.role != "bot",
            "--repo is only supported for coding workspaces"
        );
        let credential_env = self
            .credential_env
            .iter()
            .map(|reference| parse_credential_env_ref(reference))
            .collect::<Result<Vec<_>>>()?;
        let mut credential_names = std::collections::HashSet::new();
        ensure!(
            credential_env
                .iter()
                .all(|reference| credential_names.insert(&reference.name)),
            "each credential environment name may be specified only once"
        );
        let id = Uuid::new_v4().simple().to_string();
        let model = match &self.model {
            Some(model) => {
                let (provider, id) = model
                    .split_once('/')
                    .context("model must be provider/model-id")?;
                Some(json!({"provider":provider,"id":id}))
            }
            None => None,
        };
        let catalog = match &self.catalog {
            Some(path) => serde_json::from_slice(
                &fs::read(path).with_context(|| format!("read catalog {}", path.display()))?,
            )?,
            None => json!({"repositories":[]}),
        };
        let mcp_servers = match &self.mcp_config {
            Some(path) => {
                let value: Value = serde_json::from_slice(
                    &fs::read(path)
                        .with_context(|| format!("read MCP config {}", path.display()))?,
                )?;
                ensure!(
                    value.is_array(),
                    "MCP config file must contain a JSON array"
                );
                Some(value)
            }
            None => None,
        };
        let cwd = self.repo.as_ref().map_or_else(
            || "/repos".to_owned(),
            |repository| format!("/repos/{repository}"),
        );
        Ok(Workspace {
            id: id.clone(),
            name: self.name.clone(),
            role: self.role.clone(),
            namespace: format!("adm-{}", &id[..16]),
            phase: "provisioning".into(),
            creation_operation_id: None,
            deletion_operation_id: None,
            runtime_status: None,
            image: self.image.clone(),
            storage_class: self.storage_class.clone(),
            storage_size: self.storage_size.clone(),
            cpu: self.cpu.clone(),
            memory: self.memory.clone(),
            agent_enabled: true,
            allow_node_local_storage: self.allow_node_local_storage,
            repositories: self.catalog.is_some() && !self.no_repositories && self.role == "coding",
            catalog,
            repository: self.repo.clone(),
            cwd,
            model,
            credential_env,
            allowed_agents: self.allow_agent.clone(),
            mcp_servers,
            herdr_space: self.herdr_space.clone(),
            created_at: now(),
            last_error: None,
        })
    }
}

pub struct WorkspaceStore {
    connection: Connection,
    fencing_token: u64,
}

fn lifecycle_receipt(
    connection: &Connection,
    operation_id: &str,
) -> Result<crate::lifecycle::OperationReceipt> {
    let row = connection.query_row(
        "SELECT operation_id,kind,status,workspace_id,accepted_at,updated_at,stage,last_error,timings,fencing_token FROM lifecycle_operations WHERE operation_id=?1",
        [operation_id],
        |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?,row.get::<_, i64>(4)?,row.get::<_, i64>(5)?,row.get::<_, Option<String>>(6)?,row.get::<_, Option<String>>(7)?,row.get::<_, String>(8)?,row.get::<_, i64>(9)?)),
    )?;
    Ok(crate::lifecycle::OperationReceipt {
        operation_id: row.0,
        kind: row.1,
        status: row.2,
        workspace_id: row.3,
        accepted_at: row.4 as u64,
        updated_at: row.5 as u64,
        stage: row.6,
        last_error: row.7,
        timings: serde_json::from_str(&row.8)?,
        fencing_token: row.9 as u64,
    })
}

fn ensure_store_fence(connection: &Connection, fencing_token: u64) -> Result<()> {
    let latest: i64 = connection.query_row(
        "SELECT fencing_token FROM lifecycle_owner WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    ensure!(
        fencing_token as i64 >= latest,
        "lifecycle database fencing token is stale"
    );
    Ok(())
}

impl WorkspaceStore {
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_fenced(path, 0)
    }
    pub fn open_fenced(path: &Path, fencing_token: u64) -> Result<Self> {
        fs::create_dir_all(path)?;
        let connection = Connection::open(path.join("workspaces.sqlite"))?;
        connection.busy_timeout(std::time::Duration::from_secs(10))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,phase TEXT NOT NULL,spec TEXT NOT NULL,fencing_token INTEGER NOT NULL DEFAULT 0);CREATE UNIQUE INDEX IF NOT EXISTS active_workspace_names ON workspaces(name) WHERE phase!='deleted'; CREATE TABLE IF NOT EXISTS lifecycle_operations(operation_id TEXT PRIMARY KEY,kind TEXT NOT NULL,request TEXT NOT NULL,workspace_id TEXT NOT NULL,status TEXT NOT NULL,accepted_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,stage TEXT,last_error TEXT,timings TEXT NOT NULL DEFAULT '{}',fencing_token INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS runtime_leases(workspace_id TEXT PRIMARY KEY,holder TEXT NOT NULL,fencing_token INTEGER NOT NULL,expires_at INTEGER NOT NULL,lifecycle_fencing_token INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS lifecycle_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),fencing_token INTEGER NOT NULL);")?;
        connection.execute(
            "INSERT INTO lifecycle_owner(singleton,fencing_token) VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET fencing_token=MAX(lifecycle_owner.fencing_token,excluded.fencing_token)",
            [fencing_token as i64],
        )?;
        Ok(Self {
            connection,
            fencing_token,
        })
    }
    pub fn admit_lifecycle_operation(
        &mut self,
        request: &crate::lifecycle::OperationRequest,
    ) -> Result<crate::lifecycle::OperationReceipt> {
        use crate::lifecycle::OperationRequest;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure_store_fence(&transaction, self.fencing_token)?;
        let operation_id = request.operation_id();
        let encoded = serde_json::to_string(request)?;
        let existing = transaction
            .query_row(
                "SELECT request FROM lifecycle_operations WHERE operation_id=?1",
                [operation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            ensure!(
                existing == encoded,
                "operationId was already used for a different request"
            );
            let receipt = lifecycle_receipt(&transaction, operation_id)?;
            if receipt.status == "failed" {
                transaction.execute(
                    "UPDATE lifecycle_operations SET status='accepted',stage='accepted',last_error=NULL,updated_at=?2,timings='{}',fencing_token=?3 WHERE operation_id=?1 AND fencing_token<=?3",
                    params![operation_id, now() as i64, self.fencing_token as i64],
                )?;
            }
            let receipt = lifecycle_receipt(&transaction, operation_id)?;
            transaction.commit()?;
            return Ok(receipt);
        }
        let created_workspace = match request {
            OperationRequest::Create { spec, .. } => Some(spec.clone().allocate(operation_id)?),
            OperationRequest::Delete { .. } => None,
        };
        let workspace_id = created_workspace
            .as_ref()
            .map(|workspace| workspace.id.as_str())
            .or_else(|| request.workspace_id())
            .context("lifecycle operation has no workspace id")?
            .to_owned();
        let now = now() as i64;
        match request {
            OperationRequest::Create { .. } => {
                let spec = created_workspace
                    .as_ref()
                    .expect("create workspace was allocated");
                let existing = transaction
                    .query_row(
                        "SELECT phase,spec FROM workspaces WHERE name=?1 AND phase!='deleted'",
                        [&spec.name],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .optional()?;
                if let Some((phase, encoded)) = existing {
                    let previous: Workspace = serde_json::from_str(&encoded)?;
                    if phase == "failed" || phase == "provisioning" {
                        let requested_repository = match spec.repository.as_deref() {
                            Some(repository) => format!("recreating with --repo {repository}"),
                            None => "recreating without --repo".to_owned(),
                        };
                        ensure!(
                            previous.repository == spec.repository,
                            "workspace {} has an unfinished creation for repository {}; inspect its status/error and deliberately destroy it before {} (failed workspace files are retained)",
                            spec.name,
                            previous.repository.as_deref().unwrap_or("none"),
                            requested_repository
                        );
                        anyhow::bail!(
                            "workspace {} has an unfinished creation; retry the same operation ID or inspect its status and deliberately destroy it",
                            spec.name
                        );
                    }
                    anyhow::bail!("workspace name {} already exists", spec.name);
                }
                transaction.execute(
                    "INSERT INTO workspaces(id,name,phase,spec,fencing_token) VALUES(?1,?2,?3,?4,?5)",
                    params![spec.id, spec.name, spec.phase, serde_json::to_string(spec)?, self.fencing_token as i64],
                )?;
            }
            OperationRequest::Delete { workspace_id, .. } => {
                let raw: String = transaction
                    .query_row(
                        "SELECT spec FROM workspaces WHERE id=?1",
                        [workspace_id],
                        |row| row.get(0),
                    )
                    .with_context(|| format!("workspace not found: {workspace_id}"))?;
                let mut workspace: Workspace = serde_json::from_str(&raw)?;
                ensure!(
                    workspace.phase != "deleted",
                    "workspace {} is already deleted",
                    workspace.name
                );
                workspace.phase = "deleting".into();
                workspace
                    .deletion_operation_id
                    .get_or_insert_with(|| operation_id.to_owned());
                workspace.last_error = None;
                let changed = transaction.execute(
                    "UPDATE workspaces SET phase='deleting',spec=?2,fencing_token=?3 WHERE id=?1 AND fencing_token<=?3",
                    params![workspace.id, serde_json::to_string(&workspace)?, self.fencing_token as i64],
                )?;
                ensure!(changed == 1, "workspace lifecycle fencing token is stale");
            }
        }
        transaction.execute(
            "INSERT INTO lifecycle_operations(operation_id,kind,request,workspace_id,status,accepted_at,updated_at,stage,last_error,timings,fencing_token) VALUES(?1,?2,?3,?4,'accepted',?5,?5,'accepted',NULL,'{}',?6)",
            params![operation_id, request.kind(), encoded, workspace_id, now, self.fencing_token as i64],
        )?;
        let receipt = lifecycle_receipt(&transaction, operation_id)?;
        transaction.commit()?;
        Ok(receipt)
    }
    pub fn lifecycle_operation(
        &self,
        operation_id: &str,
    ) -> Result<crate::lifecycle::OperationReceipt> {
        lifecycle_receipt(&self.connection, operation_id)
            .with_context(|| format!("lifecycle operation not found: {operation_id}"))
    }
    pub fn claim_runtime_lease(
        &mut self,
        workspace_id: &str,
        holder: &str,
        duration: u64,
    ) -> Result<(u64, u64)> {
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure_store_fence(&tx, self.fencing_token)?;
        let raw: String = tx
            .query_row(
                "SELECT spec FROM workspaces WHERE id=?1",
                [workspace_id],
                |row| row.get(0),
            )
            .with_context(|| format!("workspace not found: {workspace_id}"))?;
        let workspace: Workspace = serde_json::from_str(&raw)?;
        ensure!(
            workspace.phase != "deleting" && workspace.phase != "deleted",
            "workspace lifecycle is deleting"
        );
        let current = tx
            .query_row(
                "SELECT holder,fencing_token,expires_at FROM runtime_leases WHERE workspace_id=?1",
                [workspace_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)? as u64,
                        row.get::<_, i64>(2)? as u64,
                    ))
                },
            )
            .optional()?;
        let now = now();
        let (fencing_token, expires_at) = match current {
            Some((active_holder, token, expires_at))
                if expires_at > now && active_holder == holder =>
            {
                (token, now + duration)
            }
            Some((_, _, expires_at)) if expires_at > now => {
                anyhow::bail!("runtime lease is held by another pod")
            }
            Some((_, token, _)) => (token.saturating_add(1), now + duration),
            None => (1, now + duration),
        };
        tx.execute(
            "INSERT INTO runtime_leases(workspace_id,holder,fencing_token,expires_at,lifecycle_fencing_token) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(workspace_id) DO UPDATE SET holder=excluded.holder,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at,lifecycle_fencing_token=excluded.lifecycle_fencing_token WHERE runtime_leases.lifecycle_fencing_token<=excluded.lifecycle_fencing_token",
            params![workspace_id, holder, fencing_token as i64, expires_at as i64, self.fencing_token as i64],
        )?;
        let committed = tx.query_row(
            "SELECT holder,fencing_token,expires_at FROM runtime_leases WHERE workspace_id=?1",
            [workspace_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)? as u64,
                    row.get::<_, i64>(2)? as u64,
                ))
            },
        )?;
        ensure!(
            committed == (holder.to_owned(), fencing_token, expires_at),
            "runtime lease fencing token is stale"
        );
        tx.commit()?;
        Ok((fencing_token, expires_at))
    }
    pub fn renew_runtime_lease(
        &mut self,
        workspace_id: &str,
        holder: &str,
        fencing_token: u64,
        duration: u64,
    ) -> Result<u64> {
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure_store_fence(&tx, self.fencing_token)?;
        let raw: String = tx.query_row(
            "SELECT spec FROM workspaces WHERE id=?1",
            [workspace_id],
            |row| row.get(0),
        )?;
        let workspace: Workspace = serde_json::from_str(&raw)?;
        ensure!(
            workspace.phase != "deleting" && workspace.phase != "deleted",
            "workspace lifecycle is deleting"
        );
        let current = tx.query_row(
            "SELECT holder,fencing_token,expires_at,lifecycle_fencing_token FROM runtime_leases WHERE workspace_id=?1",
            [workspace_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)? as u64, row.get::<_, i64>(3)? as u64)),
        ).with_context(|| "runtime lease is not held")?;
        ensure!(
            current.0 == holder && current.1 == fencing_token && current.3 <= self.fencing_token,
            "runtime lease fencing token is stale"
        );
        ensure!(current.2 > now(), "runtime lease expired");
        let expires_at = now() + duration;
        let changed = tx.execute(
            "UPDATE runtime_leases SET expires_at=?4,lifecycle_fencing_token=?5 WHERE workspace_id=?1 AND holder=?2 AND fencing_token=?3 AND expires_at>?6 AND lifecycle_fencing_token<=?5",
            params![workspace_id, holder, fencing_token as i64, expires_at as i64, self.fencing_token as i64, now() as i64],
        )?;
        ensure!(changed == 1, "runtime lease fencing token is stale");
        tx.commit()?;
        Ok(expires_at)
    }
    pub fn check_runtime_lease(
        &mut self,
        workspace_id: &str,
        holder: &str,
        fencing_token: u64,
    ) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure_store_fence(&tx, self.fencing_token)?;
        let raw: String = tx.query_row(
            "SELECT spec FROM workspaces WHERE id=?1",
            [workspace_id],
            |row| row.get(0),
        )?;
        let workspace: Workspace = serde_json::from_str(&raw)?;
        ensure!(
            workspace.phase != "deleting" && workspace.phase != "deleted",
            "workspace lifecycle is deleting"
        );
        let row = tx.query_row(
            "SELECT holder,fencing_token,expires_at,lifecycle_fencing_token FROM runtime_leases WHERE workspace_id=?1",
            [workspace_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)? as u64, row.get::<_, i64>(3)? as u64)),
        ).with_context(|| "runtime lease is not held")?;
        ensure!(
            row.0 == holder && row.1 == fencing_token && row.3 <= self.fencing_token,
            "runtime lease fencing token is stale"
        );
        ensure!(row.2 > now(), "runtime lease expired");
        tx.commit()?;
        Ok(())
    }
    pub fn pending_lifecycle_operations(&self) -> Result<Vec<(String, String)>> {
        let mut statement = self.connection.prepare(
            "SELECT operation_id,request FROM lifecycle_operations WHERE status IN ('accepted','running','failed') ORDER BY accepted_at,operation_id",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.map(|row| Ok(row?)).collect()
    }
    pub fn update_lifecycle_operation(
        &self,
        operation_id: &str,
        status: &str,
        stage: &str,
        error: Option<&str>,
    ) -> Result<()> {
        let accepted_at: i64 = self.connection.query_row(
            "SELECT accepted_at FROM lifecycle_operations WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )?;
        let elapsed = (now() as i64 - accepted_at).max(0);
        let changed = self.connection.execute(
            "UPDATE lifecycle_operations SET status=?2,stage=?3,last_error=?4,updated_at=?5,timings=?6,fencing_token=?7 WHERE operation_id=?1 AND fencing_token<=?7 AND ?7>=(SELECT fencing_token FROM lifecycle_owner WHERE singleton=1)",
            params![operation_id, status, stage, error, now() as i64, serde_json::to_string(&json!({"elapsedSeconds":elapsed}))?, self.fencing_token as i64],
        )?;
        ensure!(changed == 1, "lifecycle operation fencing token is stale");
        Ok(())
    }
    pub fn record_workspace_error(&self, workspace_id: &str, error: &str) -> Result<()> {
        let changed = self.connection.execute(
            "UPDATE workspaces SET spec=json_set(spec,'$.last_error',?2),fencing_token=?3 WHERE id=?1 AND fencing_token<=?3 AND ?3>=(SELECT fencing_token FROM lifecycle_owner WHERE singleton=1)",
            params![workspace_id, error, self.fencing_token as i64],
        )?;
        ensure!(changed == 1, "workspace lifecycle fencing token is stale");
        Ok(())
    }
    pub fn bind_herdr_space(
        &mut self,
        workspace_id: &str,
        space_id: Option<&str>,
    ) -> Result<Workspace> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure_store_fence(&transaction, self.fencing_token)?;
        let raw: String = transaction
            .query_row(
                "SELECT spec FROM workspaces WHERE id=?1",
                [workspace_id],
                |row| row.get(0),
            )
            .with_context(|| format!("workspace not found: {workspace_id}"))?;
        let mut workspace: Workspace = serde_json::from_str(&raw)?;
        ensure!(
            workspace.phase != "deleting" && workspace.phase != "deleted",
            "workspace {} is being deleted",
            workspace.name
        );
        workspace.herdr_space = space_id.map(str::to_owned);
        let changed = transaction.execute(
            "UPDATE workspaces SET spec=?2,fencing_token=?3 WHERE id=?1 AND fencing_token<=?3",
            params![
                workspace.id,
                serde_json::to_string(&workspace)?,
                self.fencing_token as i64
            ],
        )?;
        ensure!(changed == 1, "workspace lifecycle fencing token is stale");
        transaction.commit()?;
        Ok(workspace)
    }
    pub fn insert(&self, w: &Workspace) -> Result<()> {
        let changed = self.connection.execute(
                "INSERT INTO workspaces(id,name,phase,spec,fencing_token) SELECT ?1,?2,?3,?4,?5 WHERE ?5>=(SELECT fencing_token FROM lifecycle_owner WHERE singleton=1)",
                params![
                    w.id,
                    w.name,
                    w.phase,
                    serde_json::to_string(w)?,
                    self.fencing_token as i64
                ],
            ).with_context(|| format!("workspace name {} already exists or lifecycle fence is stale", w.name))?;
        ensure!(changed == 1, "workspace lifecycle fencing token is stale");
        Ok(())
    }
    pub fn save(&self, w: &Workspace) -> Result<()> {
        let changed = self.connection.execute(
            "UPDATE workspaces SET phase=?2,spec=?3,fencing_token=?4 WHERE id=?1 AND fencing_token<=?4 AND ?4>=(SELECT fencing_token FROM lifecycle_owner WHERE singleton=1)",
            params![w.id, w.phase, serde_json::to_string(w)?, self.fencing_token as i64],
        )?;
        ensure!(changed == 1, "workspace lifecycle fencing token is stale");
        Ok(())
    }
    pub fn save_if_phase(&self, w: &Workspace, expected: &str) -> Result<bool> {
        let changed = self.connection.execute(
            "UPDATE workspaces SET phase=?2,spec=?3,fencing_token=?5 WHERE id=?1 AND phase=?4 AND fencing_token<=?5 AND ?5>=(SELECT fencing_token FROM lifecycle_owner WHERE singleton=1)",
            params![w.id, w.phase, serde_json::to_string(w)?, expected, self.fencing_token as i64],
        )? == 1;
        Ok(changed)
    }
    pub fn admit_if_provisioning(
        &mut self,
        w: &Workspace,
        admit: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure_store_fence(&transaction, self.fencing_token)?;
        let phase =
            transaction.query_row("SELECT phase FROM workspaces WHERE id=?1", [&w.id], |row| {
                row.get::<_, String>(0)
            })?;
        ensure!(
            phase == "provisioning",
            "workspace {} is no longer being provisioned (phase: {phase})",
            w.name
        );
        admit()?;
        let changed = transaction.execute(
            "UPDATE workspaces SET phase=?2,spec=?3,fencing_token=?4 WHERE id=?1 AND phase='provisioning' AND fencing_token<=?4",
            params![w.id, w.phase, serde_json::to_string(w)?, self.fencing_token as i64],
        )?;
        ensure!(
            changed == 1,
            "workspace {} changed during admission",
            w.name
        );
        transaction.commit()?;
        Ok(())
    }
    pub fn list(&self, all: bool) -> Result<Vec<Workspace>> {
        let mut s = self.connection.prepare(if all {
            "SELECT spec FROM workspaces ORDER BY rowid"
        } else {
            "SELECT spec FROM workspaces WHERE phase!='deleted' ORDER BY rowid"
        })?;
        let rows = s.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn find(&self, name: &str) -> Result<Workspace> {
        let mut s=self.connection.prepare("SELECT spec FROM workspaces WHERE id=?1 OR name=?1 ORDER BY CASE WHEN phase='deleted' THEN 1 ELSE 0 END,rowid DESC LIMIT 1")?;
        let spec: String = s
            .query_row([name], |row| row.get(0))
            .with_context(|| format!("workspace not found: {name}"))?;
        Ok(serde_json::from_str(&spec)?)
    }
    pub fn active(&self, name: &str) -> Result<Workspace> {
        let w = self.find(name)?;
        ensure!(
            w.phase != "deleted" && w.phase != "deleting",
            "workspace {} has been deleted",
            w.name
        );
        Ok(w)
    }
}

pub fn kubectl(cli: &Cli, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>> {
    kubectl_with_timeout(cli, args, input, false)
}

pub fn kubectl_bounded(cli: &Cli, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>> {
    kubectl_with_timeout(cli, args, input, true)
}

fn kubectl_with_timeout(
    cli: &Cli,
    args: &[&str],
    input: Option<&[u8]>,
    bounded: bool,
) -> Result<Vec<u8>> {
    if bounded {
        cli.check_lifecycle_fence_bounded()?;
    } else {
        cli.check_lifecycle_fence()?;
    }
    let mut command = cli.kubectl_command()?;
    command.args(args);
    if bounded && !args.iter().any(|arg| arg.starts_with("--request-timeout=")) {
        command.arg("--request-timeout=1s");
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command
        .spawn()
        .context("start kubectl; install it or select --kubectl")?;
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input)?;
    }
    let output = child.wait_with_output()?;
    let display_args = args
        .iter()
        .map(|argument| {
            if argument.contains('\n') {
                "<multiline argument omitted>"
            } else {
                argument
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    ensure!(
        output.status.success(),
        "kubectl {}: {}",
        display_args,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    if bounded {
        cli.check_lifecycle_fence_bounded()?;
    } else {
        cli.check_lifecycle_fence()?;
    }
    Ok(output.stdout)
}

fn labels(w: &Workspace) -> Value {
    json!({"app.kubernetes.io/managed-by":MANAGED_BY,"adm.dev/workspace-id":w.id})
}
fn metadata(w: &Workspace, name: &str) -> Value {
    json!({"name":name,"namespace":w.namespace,"labels":labels(w)})
}

pub fn manifest(w: &Workspace) -> Result<Value> {
    let labels = labels(w);
    let namespace = json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":w.namespace,"labels":labels}});
    let mut items = vec![namespace];
    if w.role == "bot" {
        return Ok(json!({"apiVersion":"v1","kind":"List","items":items}));
    }
    let claim = json!({"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":metadata(w,"work"),"spec":{"accessModes":["ReadWriteOnce"],"storageClassName":w.storage_class,"resources":{"requests":{"storage":w.storage_size}}}});
    let mounts = vec![
        json!({"name":"work","mountPath":"/workspace","mountPropagation":"HostToContainer"}),
        json!({"name":"shm","mountPath":"/dev/shm"}),
    ];
    let mut volumes = vec![
        json!({"name":"work","persistentVolumeClaim":{"claimName":"work"}}),
        json!({"name":"shm","emptyDir":{"medium":"Memory","sizeLimit":"256Mi"}}),
    ];
    let mut dev = json!({"name":"dev","image":w.image,"imagePullPolicy":"IfNotPresent","workingDir":"/repos","securityContext":workspace_security_context(),"resources":{"requests":{"cpu":"100m","memory":"128Mi"},"limits":{"cpu":w.cpu,"memory":w.memory}},"volumeMounts":mounts,"readinessProbe":{"exec":{"command":["test","-d","/repos"]},"initialDelaySeconds":1,"periodSeconds":2}});
    if !w.credential_env.is_empty() {
        dev["env"] = Value::Array(w.credential_env.iter().map(|reference| json!({"name":reference.name,"valueFrom":{"secretKeyRef":{"name":reference.secret_name,"key":reference.key}}})).collect());
    }
    let mut containers = vec![dev];
    if w.repositories {
        volumes.push(json!({"name":"catalog","configMap":{"name":"repositories"}}));
        containers.push(json!({"name":"repositories","image":w.image,"imagePullPolicy":"IfNotPresent","command":["/usr/local/bin/adm-repositories","serve","--catalog","/config/catalog.json","--state","/workspace/.adm/repositories","--git-root","/workspace/.adm/git","--views","/workspace/.adm/views","--mount","/workspace/.adm/catalog","--uid","1000","--gid","1000","--artifact-fs","/usr/local/bin/artifact-fs"],"securityContext":{"privileged":true,"runAsUser":1000,"runAsGroup":1000,"runAsNonRoot":true},"resources":{"requests":{"cpu":"50m","memory":"128Mi"},"limits":{"memory":"512Mi"}},"volumeMounts":[{"name":"work","mountPath":"/workspace","mountPropagation":"Bidirectional"},{"name":"catalog","mountPath":"/config","readOnly":true}]}));
        items.push(json!({"apiVersion":"v1","kind":"ConfigMap","metadata":metadata(w,"repositories"),"data":{"catalog.json":serde_json::to_string(&w.catalog)?}}));
    }
    let init = json!({"name":"initialize","image":w.image,"imagePullPolicy":"IfNotPresent","command":["/usr/local/bin/adm-init-workspace",if w.repositories{"repositories"}else{"plain"}],"securityContext":{"runAsUser":0},"volumeMounts":[{"name":"work","mountPath":"/workspace"}]});
    let deployment = json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":metadata(w,"workspace"),"spec":{"replicas":1,"strategy":{"type":"Recreate"},"selector":{"matchLabels":labels},"template":{"metadata":{"labels":labels},"spec":{"automountServiceAccountToken":false,"terminationGracePeriodSeconds":30,"initContainers":[init],"containers":containers,"volumes":volumes}}}});
    let network = json!({"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":metadata(w,"workspace-isolation"),"spec":{"podSelector":{},"policyTypes":["Ingress","Egress"],"ingress":[{"from":[{"podSelector":{}}]}],"egress":[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"kube-system"}}}],"ports":[{"protocol":"UDP","port":53},{"protocol":"TCP","port":53}]},{"to":[{"ipBlock":{"cidr":"0.0.0.0/0","except":["10.42.0.0/16","10.43.0.0/16","169.254.0.0/16"]}}]}]}});
    items.extend([claim, deployment, network]);
    Ok(json!({"apiVersion":"v1","kind":"List","items":items}))
}

pub fn workspace_security_context() -> Value {
    json!({
        "runAsUser": 1000,
        "runAsGroup": 1000,
        "runAsNonRoot": true,
        "allowPrivilegeEscalation": true,
        "capabilities": {
            "drop": ["ALL"],
            "add": ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]
        },
        "seccompProfile": {"type": "RuntimeDefault"}
    })
}

pub fn verify_ownership(cli: &Cli, w: &Workspace) -> Result<()> {
    let namespace: Value = serde_json::from_slice(&kubectl(
        cli,
        &["get", "namespace", &w.namespace, "-o", "json"],
        None,
    )?)?;
    ensure!(
        namespace["metadata"]["labels"]["app.kubernetes.io/managed-by"] == MANAGED_BY
            && namespace["metadata"]["labels"]["adm.dev/workspace-id"] == w.id,
        "namespace ownership mismatch; refusing to operate on {}",
        w.namespace
    );
    Ok(())
}

pub fn navigation_guidance(workspace: &Workspace, opening_shell: bool) -> String {
    let context = if opening_shell {
        "adm: opening shell at"
    } else {
        "adm: work in"
    };
    if let Some(repository) = &workspace.repository {
        let next = if opening_shell {
            String::new()
        } else {
            format!(" Next: `adm shell {}`.", workspace.name)
        };
        let agent = if workspace.agent_enabled {
            " The coding agent also starts there."
        } else {
            ""
        };
        format!(
            "{context} {} (the {repository} checkout is writable and private to this workspace).{next}{agent}",
            workspace.cwd,
        )
    } else if workspace.repositories {
        let next = if opening_shell {
            String::new()
        } else {
            format!(" Next: `adm shell {}`.", workspace.name)
        };
        format!(
            "{context} /repos. Lazy catalog: list entries with `ls /repos`, then enter one with `cd /repos/OWNER/REPO`.{next}"
        )
    } else {
        let description = if opening_shell {
            "writable work directory"
        } else {
            "starts empty, writable"
        };
        let next = if opening_shell {
            " Clone a repository here if needed.".to_owned()
        } else {
            format!(
                " Next: `adm shell {}`, then clone a repository there.",
                workspace.name
            )
        };
        format!("{context} /repos ({description}).{next}")
    }
}

pub fn create_persisted(cli: &Cli, requested: Workspace) -> Result<Workspace> {
    let allow_node_local_storage = requested.allow_node_local_storage;
    let started = Instant::now();
    let mut store = cli.store()?;
    let existing = store
        .list(false)?
        .into_iter()
        .find(|existing| existing.name == requested.name);
    let resuming = existing.is_some();
    let mut w = match existing {
        Some(existing) if existing.phase == "failed" || existing.phase == "provisioning" => {
            if existing.repository != requested.repository {
                let requested_repository = match requested.repository.as_deref() {
                    Some(repository) => format!("recreating with --repo {repository}"),
                    None => "recreating without --repo".into(),
                };
                bail!(
                    "workspace {} has an unfinished creation for repository {}; inspect its status/error and deliberately destroy it before {} (failed workspace files are retained)",
                    existing.name,
                    existing.repository.as_deref().unwrap_or("none"),
                    requested_repository
                );
            }
            ensure!(
                same_creation_spec(&existing, &requested),
                "workspace {} has an unfinished creation with different options; destroy it before changing its configuration",
                requested.name
            );
            let previous_phase = existing.phase.clone();
            let mut resuming = existing;
            resuming.phase = "provisioning".into();
            resuming.last_error = None;
            ensure!(
                store.save_if_phase(&resuming, &previous_phase)?,
                "workspace {} changed while creation was being resumed",
                requested.name
            );
            resuming
        }
        Some(_) => bail!("workspace name {} already exists", requested.name),
        None => requested,
    };
    if w.role == "coding" {
        lifecycle_stage("create", &w.name, "checking storage class", || {
            let storage: Value = serde_json::from_slice(
                &kubectl(
                    cli,
                    &["get", "storageclass", &w.storage_class, "-o", "json"],
                    None,
                )
                .context("portable storage class unavailable; create StorageClass adm-replicated as described in deploy/storage.md, or pass --storage-class")?,
            )?;
            ensure!(
                allow_node_local_storage || storage["provisioner"] != "rancher.io/local-path",
                "node-local storage cannot recover on another node; select replicated storage or explicitly acknowledge --allow-node-local-storage"
            );
            Ok(())
        })?;
    }
    if resuming {
        lifecycle_stage("create", &w.name, "checking namespace ownership", || {
            if let Err(error) = verify_ownership(cli, &w) {
                ensure!(format!("{error:#}").contains("NotFound"), "{error:#}");
            }
            Ok(())
        })?;
    }
    if !resuming {
        store.insert(&w)?;
    }
    let provision = (|| -> Result<()> {
        let manifest = manifest(&w)?;
        lifecycle_stage("create", &w.name, "applying workspace resources", || {
            kubectl(
                cli,
                &["apply", "-f", "-"],
                Some(&serde_json::to_vec(&manifest)?),
            )?;
            Ok(())
        })?;
        if w.role == "coding" {
            lifecycle_stage(
                "create",
                &w.name,
                "waiting for deployment readiness",
                || {
                    kubectl(
                        cli,
                        &[
                            "wait",
                            "--for=condition=available",
                            "deployment/workspace",
                            "-n",
                            &w.namespace,
                            "--timeout=180s",
                        ],
                        None,
                    )?;
                    Ok(())
                },
            )?;
        }
        if let Some(repository) = &w.repository {
            prepare_repository(cli, &w, repository)?;
        }
        w.phase = "ready".into();
        if w.agent_enabled {
            lifecycle_stage("create", &w.name, "starting agent runner", || {
                runner::ensure_started(cli)
            })?;
            let mut registration = json!({"id":w.id,"name":w.name,"role":w.role,"environment":"kubernetes","allowedAgents":w.allowed_agents});
            if w.role == "coding" {
                registration["namespace"] = w.namespace.clone().into();
                registration["container"] = "dev".into();
                registration["cwd"] = w.cwd.clone().into();
                registration["kubectl"] = cli.kubectl.clone().into();
                registration["kubeconfig"] = cli.kubeconfig_reference()?.into();
            }
            if let Some(model) = &w.model {
                registration["model"] = model.clone();
            }
            if let Some(mcp_servers) = &w.mcp_servers {
                registration["mcpServers"] = mcp_servers.clone();
            }
            lifecycle_stage("create", &w.name, "registering agent workspace", || {
                store.admit_if_provisioning(&w, || {
                    cli.request(
                        "PUT",
                        &format!("/v1/workspaces/{}", w.id),
                        Some(&registration),
                    )?;
                    Ok(())
                })?;
                Ok(())
            })?;
        } else {
            store.admit_if_provisioning(&w, || Ok(()))?;
        }
        Ok(())
    })();
    if let Err(error) = provision {
        w.phase = "failed".into();
        w.last_error = Some(format!("{error:#}"));
        if !store.save_if_phase(&w, "provisioning")? {
            return Err(error.context(format!(
                "workspace {} changed or was deleted during creation",
                w.name
            )));
        }
        return Err(error.context(format!(
            "workspace {} is recorded as failed; inspect status or destroy it",
            w.name
        )));
    }
    lifecycle_complete("create", &w.name, "ready", started);
    Ok(w)
}

fn prepare_repository(cli: &Cli, workspace: &Workspace, repository: &str) -> Result<()> {
    let (owner, name) = validate_repository_ref(repository)?;
    let script = r#"set -eu
owner="$1"
name="$2"
workspace_id="$3"
target="$owner/$name"
staging="$owner/.adm-clone-$workspace_id"
remote="https://github.com/$owner/$name.git"
if [ -e "$target" ]; then
  [ "$(git -C "$target" rev-parse --is-inside-work-tree 2>/dev/null || true)" = true ] || { echo "repository target exists but is not a Git checkout: $target" >&2; exit 1; }
  [ "$(git -C "$target" config --get remote.origin.url 2>/dev/null || true)" = "$remote" ] || { echo "repository checkout remote does not match $remote" >&2; exit 1; }
  git -C "$target" rev-parse --verify HEAD >/dev/null
  exit 0
fi
mkdir -p -- "$owner"
if [ -e "$staging" ]; then
  if [ "$(git -C "$staging" rev-parse --is-inside-work-tree 2>/dev/null || true)" = true ] && [ "$(git -C "$staging" config --get remote.origin.url 2>/dev/null || true)" = "$remote" ] && [ "$(git -C "$staging" config --get adm.preparedWorkspaceId 2>/dev/null || true)" = "$workspace_id" ] && git -C "$staging" rev-parse --verify HEAD >/dev/null 2>&1; then
    mv -- "$staging" "$target"
    exit 0
  fi
  rm -r -- "$staging"
fi
git clone -- "$remote" "$staging"
git -C "$staging" rev-parse --verify HEAD >/dev/null
test "$(git -C "$staging" config --get remote.origin.url)" = "$remote"
git -C "$staging" config --local adm.preparedWorkspaceId "$workspace_id"
mv -- "$staging" "$target"
"#;
    lifecycle_stage("create", &workspace.name, "preparing repository", || {
        kubectl(
            cli,
            &[
                "exec",
                "-n",
                &workspace.namespace,
                "deployment/workspace",
                "-c",
                "dev",
                "--",
                "sh",
                "-eu",
                "-c",
                script,
                "adm-repository",
                owner,
                name,
                &workspace.id,
            ],
            None,
        )
        .with_context(|| {
            format!(
                "preparing repository {repository} failed; verify the OWNER/REPO spelling and whether the repository is public or accessible from the workspace. Retry the same repository after transient failures. Correcting it requires inspecting and deliberately destroying this failed workspace, then recreating with --repo OWNER/REPO"
            )
        })?;
        Ok(())
    })
}

fn same_creation_spec(existing: &Workspace, requested: &Workspace) -> bool {
    existing.role == requested.role
        && existing.image == requested.image
        && existing.storage_class == requested.storage_class
        && existing.storage_size == requested.storage_size
        && existing.cpu == requested.cpu
        && existing.memory == requested.memory
        && existing.agent_enabled == requested.agent_enabled
        && existing.allow_node_local_storage == requested.allow_node_local_storage
        && existing.repositories == requested.repositories
        && existing.catalog == requested.catalog
        && existing.repository == requested.repository
        && existing.cwd == requested.cwd
        && existing.model == requested.model
        && existing.credential_env == requested.credential_env
        && existing.allowed_agents == requested.allowed_agents
        && existing.mcp_servers == requested.mcp_servers
        && existing.herdr_space == requested.herdr_space
}

pub fn destroy(cli: &Cli, name: &str) -> Result<Workspace> {
    let started = Instant::now();
    let store = cli.store()?;
    let mut w = store.find(name)?;
    if w.phase == "deleted" {
        lifecycle_complete("destroy", &w.name, "already deleted", started);
        return Ok(w);
    }
    lifecycle_stage("destroy", &w.name, "checking namespace ownership", || {
        match verify_ownership(cli, &w) {
            Ok(()) => {}
            Err(error) => {
                if !format!("{error:#}").contains("NotFound") {
                    return Err(error);
                }
            }
        }
        Ok(())
    })?;
    w.phase = "deleting".into();
    store.save(&w)?;
    let directory = cli.state_path().join("runner/tombstones");
    fs::create_dir_all(&directory)?;
    let tombstone = directory.join(format!("{}.json", w.id));
    if !tombstone.exists() {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tombstone)?;
        file.write_all(&serde_json::to_vec(&json!({"id":w.id,"deletedAt":now()}))?)?;
        file.sync_all()?;
        fs::File::open(&directory)?.sync_all()?;
    }
    if w.agent_enabled {
        lifecycle_stage("destroy", &w.name, "cancelling agent activity", || {
            runner::ensure_started(cli)?;
            if let Err(error) = cli.request("DELETE", &format!("/v1/workspaces/{}", w.id), None) {
                let missing = error
                    .downcast_ref::<runner::HttpError>()
                    .is_some_and(|error| {
                        error.status == reqwest::StatusCode::NOT_FOUND
                            && error.code.as_deref() == Some("WORKSPACE_NOT_FOUND")
                    });
                let deleted = error
                    .downcast_ref::<runner::HttpError>()
                    .is_some_and(|error| {
                        error.status == reqwest::StatusCode::GONE
                            && error.code.as_deref() == Some("WORKSPACE_DELETED")
                    });
                ensure!(missing || deleted, "{error:#}");
            }
            Ok(())
        })?;
    }
    lifecycle_stage("destroy", &w.name, "waiting for namespace removal", || {
        kubectl(
            cli,
            &[
                "delete",
                "namespace",
                &w.namespace,
                "--ignore-not-found=true",
                "--wait=true",
                "--timeout=180s",
            ],
            None,
        )?;
        Ok(())
    })?;
    w.phase = "deleted".into();
    w.last_error = None;
    store.save(&w)?;
    lifecycle_complete("destroy", &w.name, "deleted", started);
    Ok(w)
}

pub fn cluster_status(cli: &Cli, w: &Workspace) -> Result<Value> {
    verify_ownership(cli, w)?;
    let pods: Value = serde_json::from_slice(&kubectl(
        cli,
        &[
            "get",
            "pods",
            "-n",
            &w.namespace,
            "-l",
            &format!("adm.dev/workspace-id={}", w.id),
            "-o",
            "json",
        ],
        None,
    )?)?;
    Ok(json!({"namespace":w.namespace,"pods":pods["items"]}))
}

#[cfg(test)]
mod lifecycle_fence_tests {
    use super::*;

    #[test]
    fn stale_lifecycle_fence_cannot_insert_a_new_operation() {
        let directory = tempfile::tempdir().unwrap();
        let mut stale = WorkspaceStore::open_fenced(directory.path(), 1).unwrap();
        let _current = WorkspaceStore::open_fenced(directory.path(), 2).unwrap();
        let request: crate::lifecycle::OperationRequest = serde_json::from_value(json!({
            "kind":"create",
            "operationId":"c0a0ad14-a514-4c27-9e4c-acb1a05b272c",
            "spec": {
                "name":"fenced-insert", "role":"coding", "image":"adm-dev:test",
                "storage_class":"adm-replicated", "storage_size":"1Gi", "cpu":"1",
                "memory":"1Gi", "agent_enabled":false, "repositories":false,
                "catalog":{}, "model":null
            }
        }))
        .unwrap();
        assert!(stale.admit_lifecycle_operation(&request).is_err());
        assert!(
            stale
                .lifecycle_operation("c0a0ad14-a514-4c27-9e4c-acb1a05b272c")
                .is_err()
        );
    }

    #[test]
    fn recording_a_provisioning_error_cannot_reopen_an_admitted_deletion() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = WorkspaceStore::open_fenced(directory.path(), 4).unwrap();
        let mut workspace: Workspace = serde_json::from_value(json!({
            "id":"e39f7d2667d64ca8a75c9c926611991d", "name":"deletion-race",
            "role":"coding", "namespace":"adm-e39f7d2667d64ca8",
            "phase":"provisioning", "image":"adm-dev:test", "storage_class":"adm-replicated",
            "storage_size":"1Gi", "cpu":"1", "memory":"1Gi", "agent_enabled":true,
            "repositories":false, "catalog":{}, "model":{"provider":"test","id":"model"},
            "allowed_agents":[], "created_at":1, "last_error":null
        }))
        .unwrap();
        store.insert(&workspace).unwrap();
        workspace.phase = "deleting".into();
        store.save(&workspace).unwrap();
        store
            .record_workspace_error(&workspace.id, "provisioning failed")
            .unwrap();
        let persisted = store.find(&workspace.id).unwrap();
        assert_eq!(persisted.phase, "deleting");
        assert_eq!(persisted.last_error.as_deref(), Some("provisioning failed"));
        assert!(
            store
                .claim_runtime_lease(&workspace.id, "pod-uid", 30)
                .is_err()
        );
    }
}
