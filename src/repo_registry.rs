//! The cluster's repository registry (TASK-112). `adm repos clone` registers
//! a GitHub repository once; the lifecycle service stores it beside the
//! workspaces, and every coding workspace's repositories sidecar reads the
//! registry from `GET /v1/runtime/repos/registry`, so `/repos` shows all
//! registered repositories and picks up new ones without a restart.
//!
//! A repository is "used" by a workspace created with `--repo OWNER/REPO`
//! (its checkout lives in that workspace); workspaces that only browse
//! `/repos` through the sidecar do not pin the registration.
//!
//! Each registered repository is stored once (TASK-113): the lifecycle keeps a
//! bare clone of its branch, the *base*, on one ReadWriteMany volume. Coding
//! workspaces mount that volume read-only at [`REPOSITORY_BASES_MOUNT`] and the
//! sidecar clones against the base, so a file read in many workspaces is
//! stored once while edits and commits stay in each workspace. A clone links to
//! its base for good, so a base is deleted only when its repository is no
//! longer registered and no live workspace has opened it.
use crate::workspaces::{WorkspaceStore, now, validate_repository_ref};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const REGISTRY_TABLES: &str = "CREATE TABLE IF NOT EXISTS registered_repositories(repo TEXT PRIMARY KEY COLLATE NOCASE,branch TEXT NOT NULL,added_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS registry_migrations(name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS repository_base_users(repo TEXT NOT NULL COLLATE NOCASE,workspace_id TEXT NOT NULL,PRIMARY KEY(repo,workspace_id));";

/// Where workspace Pods see the shared bases volume, read-only. The sidecar
/// records `<this>/OWNER/REPO.git` in each clone, so the dev container mounts
/// it at the same path.
pub const REPOSITORY_BASES_MOUNT: &str = "/var/lib/adm-repository-bases";

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

    /// Records that a workspace's sidecar cloned against this repository's base.
    pub fn record_repository_base_user(&mut self, repo: &str, workspace_id: &str) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::workspaces::ensure_store_fence(&transaction, self.fencing_token)?;
        transaction.execute(
            "INSERT OR IGNORE INTO repository_base_users(repo,workspace_id) VALUES(?1,?2)",
            params![repo, workspace_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Live workspaces whose clones link to this repository's base.
    fn repository_base_users(&self, repo: &str) -> Result<Vec<String>> {
        let users: Vec<String> = {
            let mut statement = self
                .connection
                .prepare("SELECT workspace_id FROM repository_base_users WHERE repo=?1")?;
            let rows = statement.query_map([repo], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let live = self.list(false)?;
        Ok(users
            .into_iter()
            .filter(|id| live.iter().any(|workspace| &workspace.id == id))
            .collect())
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

fn repo_body(body: &[u8]) -> Result<(String, Option<String>, bool)> {
    let request: Value = serde_json::from_slice(body).context("registry request must be JSON")?;
    let repo = request["repo"].as_str().context("repo is required")?;
    validate_repository_ref(repo)?;
    let branch = request["ref"].as_str().map(str::to_owned);
    if let Some(branch) = &branch {
        validate_registry_branch(branch)?;
    }
    let create = request["create"].as_bool().unwrap_or(false);
    ensure!(
        !(create && branch.is_some()),
        "a new repository starts on main; it takes no branch"
    );
    Ok((repo.to_owned(), branch, create))
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
    let (mut repo, mut requested, create) = repo_body(body)?;
    // A retried `adm create --new-repo` finds it registered and carries on.
    if create && store.registered_repository(&repo)?.is_none() {
        repo = create_github_repository(&repo)?;
        requested = Some("main".to_owned());
    }
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
        // Registering again brings the base up to date with GitHub.
        prepare_repository_base(&existing.repo, &existing.branch)?;
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
    prepare_repository_base(canonical, branch)?;
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
    collect_repository_bases(store)?;
    Ok((200, json!({"repo":registered.repo,"removed":true})))
}

/// The registry in the shape the repositories sidecar mounts. A workspace
/// that mounts the bases volume is told where each prepared base is.
pub fn sidecar_catalog(store: &WorkspaceStore, mounts_bases: bool) -> Result<Value> {
    let bases = if mounts_bases {
        Some(repository_bases_dir()?)
    } else {
        None
    };
    let repositories = store
        .registered_repositories()?
        .into_iter()
        .filter_map(|registered| {
            let (owner, name) = registered.repo.split_once('/')?;
            let mut entry = json!({
                "owner":owner,"name":name,
                "remote":format!("https://github.com/{}.git", registered.repo),
                "ref":format!("refs/heads/{}", registered.branch),
            });
            if bases
                .as_ref()
                .is_some_and(|bases| base_path(bases, &registered.repo).exists())
            {
                entry["upstreamGitDir"] = json!(base_path(
                    Path::new(REPOSITORY_BASES_MOUNT),
                    &registered.repo
                ));
            }
            Some(entry)
        })
        .collect::<Vec<_>>();
    Ok(json!({"repositories":repositories}))
}

/// `POST /v1/runtime/repos/opened/OWNER/REPO`: the caller's sidecar is about
/// to clone against this repository's base.
pub fn record_opened(store: &mut WorkspaceStore, workspace_id: &str, path: &str) -> Result<Value> {
    let repo = path
        .strip_prefix("/v1/runtime/repos/opened/")
        .context("not an opened route")?;
    validate_repository_ref(repo)?;
    let registered = store
        .registered_repository(repo)?
        .with_context(|| format!("{repo} is not registered"))?;
    store.record_repository_base_user(&registered.repo, workspace_id)?;
    Ok(json!({"repo":registered.repo,"workspaceId":workspace_id}))
}

/// Creates the repository on GitHub with the cluster login and pushes one
/// empty commit to main, so it has a branch to register and check out while
/// the checkout holds only `.git` (TASK-117). Returns the canonical name.
fn create_github_repository(repo: &str) -> Result<String> {
    let (status, created) = crate::lifecycle::proxy_provider_auth(
        "POST",
        "/v1/repos/create",
        &serde_json::to_vec(&json!({"repo":repo}))?,
    )?;
    if status != 200 {
        bail!(
            "{}",
            created["error"]["message"]
                .as_str()
                .unwrap_or("GitHub did not create the repository")
        );
    }
    let canonical = created["repo"]
        .as_str()
        .context("create returned no repo")?;
    validate_repository_ref(canonical)?;
    let account = created["account"]
        .as_str()
        .context("create returned no account")?;
    let token = github_token()?;
    let scratch = std::env::temp_dir().join(format!("adm-new-repo-{}", uuid::Uuid::new_v4()));
    let scratch_path = scratch.to_str().context("temp path is not UTF-8")?;
    let author = format!("user.email={account}@users.noreply.github.com");
    let name = format!("user.name={account}");
    let pushed = github_git(
        &token,
        &["init", "--quiet", "--initial-branch=main", scratch_path],
    )
    .and_then(|()| {
        github_git(
            &token,
            &[
                "-C",
                scratch_path,
                "-c",
                &name,
                "-c",
                &author,
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "Initial commit",
            ],
        )
    })
    .and_then(|()| {
        github_git(
            &token,
            &[
                "-C",
                scratch_path,
                "push",
                "--quiet",
                &format!("https://github.com/{canonical}.git"),
                "main",
            ],
        )
    });
    if scratch.exists() {
        std::fs::remove_dir_all(&scratch)?;
    }
    pushed.with_context(|| format!("{canonical} was created on GitHub but its first commit was not pushed; run adm create with --repo {canonical} after pushing a commit"))?;
    eprintln!("adm repository created {canonical} on GitHub for {account}");
    Ok(canonical.to_owned())
}

/// The cluster GitHub token, or None when not logged in (public repos only).
fn github_token() -> Result<Option<String>> {
    let (status, login) =
        crate::lifecycle::proxy_provider_auth("GET", "/v1/runtime/repos/token", b"")?;
    match status {
        200 => Ok(Some(
            login["token"]
                .as_str()
                .context("GitHub login has no token")?
                .to_owned(),
        )),
        409 => Ok(None),
        _ => bail!("cannot read the cluster GitHub login ({status}): {login}"),
    }
}

/// Runs git with the cluster GitHub token offered to github.com only. `-c`
/// rather than `GIT_CONFIG_*`, so an operator's or test's git env still applies.
fn github_git(token: &Option<String>, args: &[&str]) -> Result<()> {
    let mut command = Command::new("git");
    command.env("GIT_TERMINAL_PROMPT", "0").args([
        "-c",
        "credential.helper=",
        "-c",
        "credential.https://github.com.helper=!f() { test \"$1\" = get && echo username=x-access-token && echo \"password=$ADM_GITHUB_TOKEN\"; }; f",
    ]);
    if let Some(token) = token {
        command.env("ADM_GITHUB_TOKEN", token);
    }
    let output = command.args(args).output().context("run git")?;
    ensure!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

/// The lifecycle's writable view of the bases volume.
fn repository_bases_dir() -> Result<PathBuf> {
    let dir = std::env::var_os("ADM_REPOSITORY_BASES")
        .context("this lifecycle has no repository bases volume (ADM_REPOSITORY_BASES); run adm update to apply the current control plane")?;
    Ok(PathBuf::from(dir))
}

fn base_path(bases: &Path, repo: &str) -> PathBuf {
    bases.join(format!("{repo}.git"))
}

/// Clones the base for a registered repository, or fetches its branch into an
/// existing one. A fetch only adds objects, so no workspace's work moves, and
/// objects are never pruned (`gc.auto=0`) because clones depend on them.
pub fn prepare_repository_base(repo: &str, branch: &str) -> Result<()> {
    let bases = repository_bases_dir()?;
    let destination = base_path(&bases, repo);
    let remote = format!("https://github.com/{repo}.git");
    let reference = format!("refs/heads/{branch}");
    // Private repositories need the cluster GitHub login; public ones do not.
    let token = github_token()?;
    let git =
        |args: &[&str]| github_git(&token, args).with_context(|| format!("shared base of {repo}"));
    if destination.exists() {
        let path = destination.to_str().context("base path is not UTF-8")?;
        git(&[
            "--git-dir",
            path,
            "fetch",
            "--no-tags",
            "--",
            &remote,
            &format!("+{reference}:{reference}"),
        ])?;
        eprintln!("adm repository base refreshed {repo} ({branch})");
        return Ok(());
    }
    let parent = destination.parent().context("base has no parent")?;
    std::fs::create_dir_all(parent)?;
    // Clone beside the destination and rename, so a failed clone never leaves
    // a partial base that workspaces would trust.
    let staging = parent.join(format!(".prepare-{}", uuid::Uuid::new_v4()));
    let staging_path = staging.to_str().context("base path is not UTF-8")?;
    let prepared = git(&[
        "clone",
        "--bare",
        "--single-branch",
        "--no-tags",
        "--branch",
        branch,
        "--",
        &remote,
        staging_path,
    ])
    .and_then(|()| git(&["--git-dir", staging_path, "config", "gc.auto", "0"]))
    .and_then(|()| {
        std::fs::rename(&staging, &destination)
            .with_context(|| format!("publish the shared base of {repo}"))
    });
    if prepared.is_err() && staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    prepared?;
    eprintln!("adm repository base prepared {repo} ({branch})");
    Ok(())
}

/// Deletes the base of every repository that is no longer registered and that
/// no live workspace has opened. Runs after a removal and after a destroy.
pub fn collect_repository_bases(store: &WorkspaceStore) -> Result<()> {
    let bases = repository_bases_dir()?;
    let Ok(owners) = std::fs::read_dir(&bases) else {
        return Ok(());
    };
    for owner in owners {
        let owner = owner?;
        if !owner.file_type()?.is_dir() || owner.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        for base in std::fs::read_dir(owner.path())? {
            let base = base?;
            let file_name = base.file_name();
            let Some(name) = file_name
                .to_str()
                .and_then(|name| name.strip_suffix(".git"))
            else {
                continue;
            };
            let repo = format!("{}/{name}", owner.file_name().to_string_lossy());
            if store.registered_repository(&repo)?.is_some() {
                continue;
            }
            let users = store.repository_base_users(&repo)?;
            if users.is_empty() {
                std::fs::remove_dir_all(base.path())
                    .with_context(|| format!("delete the shared base of {repo}"))?;
                eprintln!("adm repository base deleted {repo}");
            } else {
                eprintln!(
                    "adm repository base kept {repo}: still opened by workspaces {}",
                    users.join(", ")
                );
            }
        }
    }
    Ok(())
}

/// Bases for repositories registered before bases existed (TASK-113). Runs
/// once when the lifecycle starts; a failure is logged and the repository
/// still works, each workspace just stores its own copy.
pub fn prepare_missing_repository_bases(store: &WorkspaceStore) -> Result<()> {
    let bases = repository_bases_dir()?;
    for registered in store.registered_repositories()? {
        if base_path(&bases, &registered.repo).exists() {
            continue;
        }
        if let Err(error) = prepare_repository_base(&registered.repo, &registered.branch) {
            eprintln!(
                "adm repository base for {} failed: {error:#}",
                registered.repo
            );
        }
    }
    Ok(())
}
