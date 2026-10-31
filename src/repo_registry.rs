//! The cluster's repository registry (TASK-112). `adm repos clone` registers
//! a GitHub repository once; the lifecycle service stores it beside the
//! workspaces, and every coding workspace's repositories sidecar reads the
//! registry from `GET /v1/runtime/repos/registry`, so `/repos` shows all
//! registered repositories and picks up new ones without a restart.
//!
//! A repository is "used" by a workspace created with `--repo OWNER/REPO`
//! (its checkout lives in that workspace); workspaces that only browse
//! `/repos` through the sidecar do not pin anything.
use crate::workspaces::{WorkspaceStore, now, validate_repository_ref};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};

pub const REGISTRY_TABLES: &str = "CREATE TABLE IF NOT EXISTS registered_repositories(repo TEXT PRIMARY KEY COLLATE NOCASE,branch TEXT NOT NULL,added_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS registry_migrations(name TEXT PRIMARY KEY);";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RegisteredRepository {
    pub repo: String,
    pub branch: String,
    pub added_at: u64,
}

/// A branch name safe to turn into `refs/heads/<branch>` for the sidecar.
pub fn validate_registry_branch(branch: &str) -> Result<()> {
    ensure!(
        !branch.is_empty()
            && !branch.starts_with(['-', '/'])
            && !branch.ends_with(['/', '.'])
            && !branch.ends_with(".lock")
            && !branch.contains("..")
            && !branch.contains("//")
            && !branch.contains("@{")
            && !branch
                .chars()
                .any(|c| c.is_control() || " ~^:?*[\\".contains(c)),
        "invalid branch name: {branch:?}"
    );
    Ok(())
}

impl WorkspaceStore {
    pub fn registered_repositories(&self) -> Result<Vec<RegisteredRepository>> {
        let mut statement = self.connection.prepare(
            "SELECT repo,branch,added_at FROM registered_repositories ORDER BY repo COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(RegisteredRepository {
                repo: row.get(0)?,
                branch: row.get(1)?,
                added_at: row.get::<_, i64>(2)? as u64,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn registered_repository(&self, repo: &str) -> Result<Option<RegisteredRepository>> {
        Ok(self
            .registered_repositories()?
            .into_iter()
            .find(|registered| registered.repo.eq_ignore_ascii_case(repo)))
    }

    /// Workspaces (name, id) created with `--repo` for this repository that
    /// have not been deleted.
    pub fn repository_users(&self, repo: &str) -> Result<Vec<(String, String)>> {
        Ok(self
            .list(false)?
            .into_iter()
            .filter(|workspace| {
                workspace
                    .repository
                    .as_deref()
                    .is_some_and(|used| used.eq_ignore_ascii_case(repo))
            })
            .map(|workspace| (workspace.name, workspace.id))
            .collect())
    }

    /// Adds the repository; returns false when it was already registered.
    pub fn register_repository(&mut self, repo: &str, branch: &str) -> Result<bool> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::workspaces::ensure_store_fence(&transaction, self.fencing_token)?;
        let added = transaction.execute(
            "INSERT OR IGNORE INTO registered_repositories(repo,branch,added_at) VALUES(?1,?2,?3)",
            params![repo, branch, now() as i64],
        )? > 0;
        transaction.commit()?;
        Ok(added)
    }

    pub fn unregister_repository(&mut self, repo: &str) -> Result<()> {
        let users = self.repository_users(repo)?;
        ensure!(
            users.is_empty(),
            "{repo} is used by workspaces {}; destroy them or remove the repo from them first",
            users
                .iter()
                .map(|(name, id)| format!("{name} ({id})"))
                .collect::<Vec<_>>()
                .join(" and ")
        );
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::workspaces::ensure_store_fence(&transaction, self.fencing_token)?;
        let removed =
            transaction.execute("DELETE FROM registered_repositories WHERE repo=?1", [repo])?;
        ensure!(removed == 1, "{repo} is not registered");
        transaction.commit()?;
        Ok(())
    }

    /// Workspaces created with `--catalog FILE` before the registry kept their
    /// GitHub repositories in their own spec. Register those once so they do
    /// not disappear from `/repos` when the workspace is updated.
    pub(crate) fn import_workspace_catalogs(&mut self) -> Result<()> {
        let done: Option<String> = self
            .connection
            .query_row(
                "SELECT name FROM registry_migrations WHERE name='workspace-catalogs'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }
        let mut repositories = Vec::new();
        for spec in self.list_specs()? {
            for entry in spec["catalog"]["repositories"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let (Some(owner), Some(name), Some(remote), Some(reference)) = (
                    entry["owner"].as_str(),
                    entry["name"].as_str(),
                    entry["remote"].as_str(),
                    entry["ref"].as_str(),
                ) else {
                    continue;
                };
                let github = remote
                    .strip_prefix("https://github.com/")
                    .is_some_and(|path| path.trim_end_matches(".git") == format!("{owner}/{name}"));
                if let (true, Some(branch)) = (github, reference.strip_prefix("refs/heads/")) {
                    repositories.push((format!("{owner}/{name}"), branch.to_owned()));
                }
            }
        }
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        for (repo, branch) in &repositories {
            transaction.execute(
                "INSERT OR IGNORE INTO registered_repositories(repo,branch,added_at) VALUES(?1,?2,?3)",
                params![repo, branch, now() as i64],
            )?;
        }
        transaction.execute(
            "INSERT INTO registry_migrations(name) VALUES('workspace-catalogs')",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn list_specs(&self) -> Result<Vec<Value>> {
        let mut statement = self
            .connection
            .prepare("SELECT spec FROM workspaces WHERE phase!='deleted' ORDER BY rowid")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
}

fn repo_body(body: &[u8]) -> Result<(String, Option<String>)> {
    let request: Value = serde_json::from_slice(body).context("registry request must be JSON")?;
    let repo = request["repo"].as_str().context("repo is required")?;
    validate_repository_ref(repo)?;
    let branch = request["ref"].as_str().map(str::to_owned);
    if let Some(branch) = &branch {
        validate_registry_branch(branch)?;
    }
    Ok((repo.to_owned(), branch))
}

/// Operator routes `/v1/repos/registry...` and the Pod route
/// `/v1/runtime/repos/registry`'s data. Returns None for other paths.
pub fn operator_route(
    store: &mut WorkspaceStore,
    method: &str,
    path: &str,
    body: &[u8],
) -> Option<Result<(u16, Value)>> {
    match (method, path) {
        ("GET", "/v1/repos/registry") => Some(list(store)),
        ("POST", "/v1/repos/registry") => Some(register(store, body)),
        ("DELETE", _) => path
            .strip_prefix("/v1/repos/registry/")
            .map(|repo| remove(store, repo)),
        _ => None,
    }
}

fn list(store: &WorkspaceStore) -> Result<(u16, Value)> {
    let repositories = store
        .registered_repositories()?
        .into_iter()
        .map(|registered| {
            let workspaces = store
                .repository_users(&registered.repo)?
                .into_iter()
                .map(|(name, id)| json!({"name":name,"id":id}))
                .collect::<Vec<_>>();
            Ok(json!({"repo":registered.repo,"branch":registered.branch,"addedAt":registered.added_at,"workspaces":workspaces}))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((200, json!({"repositories":repositories})))
}

fn register(store: &mut WorkspaceStore, body: &[u8]) -> Result<(u16, Value)> {
    let (repo, requested) = repo_body(body)?;
    if let Some(existing) = store.registered_repository(&repo)? {
        ensure!(
            requested
                .as_ref()
                .is_none_or(|branch| *branch == existing.branch),
            "{} is already registered at branch {}; run adm repos remove {} first to change it",
            existing.repo,
            existing.branch,
            existing.repo
        );
        return Ok((
            200,
            json!({"repo":existing.repo,"branch":existing.branch,"registered":false}),
        ));
    }
    let (status, checked) = crate::lifecycle::proxy_provider_auth(
        "POST",
        "/v1/repos/check",
        &serde_json::to_vec(&json!({"repo":repo,"ref":requested}))?,
    )?;
    if status != 200 {
        bail!(
            "{}",
            checked["error"]["message"]
                .as_str()
                .unwrap_or("the GitHub reachability check failed")
        );
    }
    let canonical = checked["repo"].as_str().context("check returned no repo")?;
    let branch = checked["ref"]
        .as_str()
        .context("check returned no branch")?;
    validate_repository_ref(canonical)?;
    validate_registry_branch(branch)?;
    let registered = store.register_repository(canonical, branch)?;
    Ok((
        200,
        json!({"repo":canonical,"branch":branch,"registered":registered}),
    ))
}

fn remove(store: &mut WorkspaceStore, repo: &str) -> Result<(u16, Value)> {
    validate_repository_ref(repo)?;
    let registered = store
        .registered_repository(repo)?
        .with_context(|| format!("{repo} is not registered"))?;
    store.unregister_repository(&registered.repo)?;
    Ok((200, json!({"repo":registered.repo,"removed":true})))
}

/// The registry in the shape the repositories sidecar mounts.
pub fn sidecar_catalog(store: &WorkspaceStore) -> Result<Value> {
    let repositories = store
        .registered_repositories()?
        .into_iter()
        .filter_map(|registered| {
            let (owner, name) = registered.repo.split_once('/')?;
            Some(json!({
                "owner":owner,"name":name,
                "remote":format!("https://github.com/{}.git", registered.repo),
                "ref":format!("refs/heads/{}", registered.branch),
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({"repositories":repositories}))
}
