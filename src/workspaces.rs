use crate::{Cli, runner};
use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
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
    pub image: String,
    pub storage_class: String,
    pub storage_size: String,
    pub cpu: String,
    pub memory: String,
    pub agent_enabled: bool,
    pub repositories: bool,
    pub catalog: Value,
    pub model: Option<Value>,
    pub allowed_agents: Vec<String>,
    #[serde(default)]
    pub mcp_servers: Option<Value>,
    pub herdr_space: Option<String>,
    pub created_at: u64,
    pub last_error: Option<String>,
}

#[derive(Args)]
pub struct CreateOptions {
    pub name: String,
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
    pub no_agent: bool,
    #[arg(long)]
    pub no_repositories: bool,
    #[arg(long)]
    pub catalog: Option<std::path::PathBuf>,
    /// Provider/model-id; overrides the model chosen in adm setup.
    #[arg(long)]
    pub model: Option<String>,
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
impl CreateOptions {
    pub fn workspace(&self) -> Result<Workspace> {
        validate_name(&self.name)?;
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
        Ok(Workspace {
            id: id.clone(),
            name: self.name.clone(),
            role: self.role.clone(),
            namespace: format!("adm-{}", &id[..16]),
            phase: "provisioning".into(),
            image: self.image.clone(),
            storage_class: self.storage_class.clone(),
            storage_size: self.storage_size.clone(),
            cpu: self.cpu.clone(),
            memory: self.memory.clone(),
            agent_enabled: !self.no_agent,
            repositories: self.catalog.is_some() && !self.no_repositories && self.role == "coding",
            catalog,
            model,
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
}
impl WorkspaceStore {
    pub fn open(path: &Path) -> Result<Self> {
        fs::create_dir_all(path)?;
        let connection = Connection::open(path.join("workspaces.sqlite"))?;
        connection.busy_timeout(std::time::Duration::from_secs(10))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,phase TEXT NOT NULL,spec TEXT NOT NULL);CREATE UNIQUE INDEX IF NOT EXISTS active_workspace_names ON workspaces(name) WHERE phase!='deleted';")?;
        Ok(Self { connection })
    }
    pub fn insert(&self, w: &Workspace) -> Result<()> {
        self.connection
            .execute(
                "INSERT INTO workspaces(id,name,phase,spec) VALUES(?1,?2,?3,?4)",
                params![w.id, w.name, w.phase, serde_json::to_string(w)?],
            )
            .with_context(|| format!("workspace name {} already exists", w.name))?;
        Ok(())
    }
    pub fn save(&self, w: &Workspace) -> Result<()> {
        self.connection.execute(
            "UPDATE workspaces SET phase=?2,spec=?3 WHERE id=?1",
            params![w.id, w.phase, serde_json::to_string(w)?],
        )?;
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
    let mut command = Command::new(&cli.kubectl);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
    ensure!(
        output.status.success(),
        "kubectl {}: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
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
    let mut containers = vec![
        json!({"name":"dev","image":w.image,"imagePullPolicy":"IfNotPresent","workingDir":"/repos","securityContext":{"runAsUser":1000,"runAsGroup":1000,"runAsNonRoot":true,"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"seccompProfile":{"type":"RuntimeDefault"}},"resources":{"requests":{"cpu":"100m","memory":"128Mi"},"limits":{"cpu":w.cpu,"memory":w.memory}},"volumeMounts":mounts,"readinessProbe":{"exec":{"command":["test","-d","/repos"]},"initialDelaySeconds":1,"periodSeconds":2}}),
    ];
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

pub fn create(cli: &Cli, options: &CreateOptions) -> Result<Workspace> {
    let started = Instant::now();
    ensure!(
        options.no_agent || options.model.is_some(),
        "agent workspaces require an explicit --model PROVIDER/MODEL_ID; use --no-agent to create a workspace without an agent"
    );
    let requested = options.workspace()?;
    let store = cli.store()?;
    let existing = store
        .list(false)?
        .into_iter()
        .find(|existing| existing.name == requested.name);
    let resuming = existing.is_some();
    let mut w = match existing {
        Some(existing) if existing.phase == "failed" || existing.phase == "provisioning" => {
            ensure!(
                same_creation_spec(&existing, &requested),
                "workspace {} has an unfinished creation with different options; destroy it before changing its configuration",
                requested.name
            );
            existing
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
                options.allow_node_local_storage
                    || storage["provisioner"] != "rancher.io/local-path",
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
    if resuming {
        w.phase = "provisioning".into();
        w.last_error = None;
        store.save(&w)?;
    } else {
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
        if w.agent_enabled {
            lifecycle_stage("create", &w.name, "starting agent runner", || {
                runner::ensure_started(cli)
            })?;
            let mut registration = json!({"id":w.id,"name":w.name,"role":w.role,"environment":"kubernetes","allowedAgents":w.allowed_agents});
            if w.role == "coding" {
                registration["namespace"] = w.namespace.clone().into();
                registration["container"] = "dev".into();
                registration["cwd"] = "/repos".into();
                registration["kubectl"] = cli.kubectl.clone().into();
            }
            if let Some(model) = &w.model {
                registration["model"] = model.clone();
            }
            if let Some(mcp_servers) = &w.mcp_servers {
                registration["mcpServers"] = mcp_servers.clone();
            }
            lifecycle_stage("create", &w.name, "registering agent workspace", || {
                cli.request(
                    "PUT",
                    &format!("/v1/workspaces/{}", w.id),
                    Some(&registration),
                )?;
                Ok(())
            })?;
        }
        Ok(())
    })();
    if let Err(error) = provision {
        w.phase = "failed".into();
        w.last_error = Some(format!("{error:#}"));
        store.save(&w)?;
        return Err(error.context(format!(
            "workspace {} is recorded as failed; inspect status or destroy it",
            w.name
        )));
    }
    w.phase = "ready".into();
    store.save(&w)?;
    lifecycle_complete("create", &w.name, "ready", started);
    Ok(w)
}

fn same_creation_spec(existing: &Workspace, requested: &Workspace) -> bool {
    existing.role == requested.role
        && existing.image == requested.image
        && existing.storage_class == requested.storage_class
        && existing.storage_size == requested.storage_size
        && existing.cpu == requested.cpu
        && existing.memory == requested.memory
        && existing.agent_enabled == requested.agent_enabled
        && existing.repositories == requested.repositories
        && existing.catalog == requested.catalog
        && existing.model == requested.model
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
            cli.request("DELETE", &format!("/v1/workspaces/{}", w.id), None)?;
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
