//! `adm repos`: the installation's repository-provider login (TASK-111) and
//! its repository registry (TASK-112). The cluster authority runs
//! `gh auth login --web` and keeps the token; this command only relays the
//! device code and URL and never sees the token. The lifecycle service stores
//! the registry that every coding workspace's `/repos` shows.
use crate::Cli;
use anyhow::{Context, Result, bail, ensure};
use clap::Subcommand;
use serde_json::json;

#[derive(Subcommand, Debug)]
pub enum ReposAction {
    /// Connect the cluster to GitHub for every coding workspace and repository.
    Login {
        /// Repository provider; only github is available.
        provider: Option<String>,
    },
    /// Disconnect the cluster from the repository provider.
    Logout {
        /// Repository provider; only github is available.
        provider: Option<String>,
    },
    /// Show which account the cluster is connected as.
    Status,
    /// Register a GitHub repository so every coding workspace shows it in /repos, stored once in a shared base. Run again to fetch new commits into the base.
    Clone {
        /// OWNER/REPO
        repository: String,
        /// Branch to open; defaults to the repository's default branch.
        #[arg(long = "ref", value_name = "BRANCH")]
        branch: Option<String>,
    },
    /// List registered repositories, the workspaces using each, and the GitHub login.
    List {
        /// Print the registry as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Unregister a repository; refused while a workspace uses it.
    Remove {
        /// OWNER/REPO
        repository: String,
    },
}

pub fn run(cli: &Cli, action: &ReposAction) -> Result<()> {
    match action {
        ReposAction::Login { provider } => login(cli, provider.as_deref()),
        ReposAction::Logout { provider } => logout(cli, provider.as_deref()),
        ReposAction::Clone { repository, branch } => {
            let registered = register_repository(cli, repository, branch.as_deref())?;
            let verb = if registered["registered"] == true {
                "Registered"
            } else {
                "Already registered:"
            };
            println!(
                "{verb} {} (branch {}); it appears in /repos of every coding workspace",
                registered["repo"].as_str().unwrap_or(repository),
                registered["branch"].as_str().unwrap_or("?")
            );
            Ok(())
        }
        ReposAction::List { json } => list_repositories(cli, *json),
        ReposAction::Remove { repository } => {
            let removed =
                cli.request_lifecycle("DELETE", &format!("/v1/repos/registry/{repository}"), None)?;
            println!(
                "Removed {} from the registry",
                removed["repo"].as_str().unwrap_or(repository)
            );
            Ok(())
        }
        ReposAction::Status => {
            let github = github_status(cli);
            println!("{}", status_text(&github));
            ensure!(
                github["status"] != "unavailable",
                "could not read the GitHub login status"
            );
            Ok(())
        }
    }
}

/// Registers OWNER/REPO in the cluster registry after the lifecycle service
/// checked the GitHub login can reach it. Used by `adm repos clone` and
/// `adm create --repo`.
pub fn register_repository(
    cli: &Cli,
    repository: &str,
    branch: Option<&str>,
) -> Result<serde_json::Value> {
    cli.request_lifecycle(
        "POST",
        "/v1/repos/registry",
        Some(&json!({"repo":repository,"ref":branch})),
    )
}

/// Creates OWNER/REPO on GitHub as an empty private repository with one
/// empty commit on main, then registers it (`adm create --new-repo`, TASK-117).
pub fn create_repository(cli: &Cli, repository: &str) -> Result<serde_json::Value> {
    cli.request_lifecycle(
        "POST",
        "/v1/repos/registry",
        Some(&json!({"repo":repository,"create":true})),
    )
}

fn list_repositories(cli: &Cli, as_json: bool) -> Result<()> {
    let registry = cli.request_lifecycle("GET", "/v1/repos/registry", None)?;
    let github = github_status(cli);
    if as_json {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"github":github,"repositories":registry["repositories"]})
            )?
        );
        return Ok(());
    }
    let repositories = registry["repositories"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if repositories.is_empty() {
        println!("No repositories registered; run adm repos clone OWNER/REPO");
    }
    for repository in repositories {
        let users = repository["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|workspace| workspace["name"].as_str())
            .collect::<Vec<_>>();
        println!(
            "{}  branch {}  used by: {}",
            repository["repo"].as_str().unwrap_or("?"),
            repository["branch"].as_str().unwrap_or("?"),
            if users.is_empty() {
                "-".to_owned()
            } else {
                users.join(", ")
            }
        );
    }
    println!("{}", status_text(&github));
    Ok(())
}

fn pick_provider(provider: Option<&str>) -> Result<&'static str> {
    match provider {
        None | Some("github") => Ok("github"),
        Some(other) => {
            bail!("repository provider {other} is not available; the only provider is github")
        }
    }
}

/// The cluster's GitHub login as JSON, for `adm status`; a failure to ask is
/// reported as `unavailable`, never as "not logged in".
pub fn github_status(cli: &Cli) -> serde_json::Value {
    match cli.request_lifecycle("GET", "/v1/repos/status", None) {
        Ok(status) => status["github"].clone(),
        Err(error) => json!({"status":"unavailable","error":format!("{error:#}")}),
    }
}

/// One line for `adm repos status` and `adm status`.
pub fn status_text(github: &serde_json::Value) -> String {
    match github["status"].as_str() {
        Some("connected") => format!(
            "GitHub: connected as {}",
            github["account"].as_str().unwrap_or("unknown")
        ),
        Some("not_logged_in") => "GitHub: not logged in; run adm repos login github".to_owned(),
        _ => format!(
            "GitHub: status unavailable: {}",
            github["error"].as_str().unwrap_or("unknown error")
        ),
    }
}

fn login(cli: &Cli, provider: Option<&str>) -> Result<()> {
    let provider = pick_provider(provider)?;
    let started = cli.request_lifecycle(
        "POST",
        "/v1/repos/login",
        Some(&json!({"provider": provider})),
    )?;
    let operation = started["operationId"]
        .as_str()
        .context("repository login returned no operation ID")?;
    let result = drive_login(cli, operation);
    if result.is_err() {
        let _ = cli.request_lifecycle("DELETE", &format!("/v1/repos/login/{operation}"), None);
    }
    result
}

fn drive_login(cli: &Cli, operation: &str) -> Result<()> {
    loop {
        let next = cli.request_lifecycle_wait(
            "GET",
            &format!("/v1/repos/login/{operation}/events"),
            None,
        )?;
        let event = &next["event"];
        match event["type"].as_str().unwrap_or("") {
            "device_code" => println!(
                "Open {} and enter {}",
                event["verificationUri"]
                    .as_str()
                    .unwrap_or("https://github.com/login/device"),
                event["userCode"].as_str().unwrap_or("")
            ),
            "complete" => {
                let account = event["account"].as_str().unwrap_or("unknown");
                match event["repositories"].as_u64() {
                    Some(count) => {
                        println!("✓ GitHub connected as {account}: {count} repositories available")
                    }
                    None => println!("✓ GitHub connected as {account}"),
                }
                return Ok(());
            }
            "error" => bail!(
                "{}",
                event["message"].as_str().unwrap_or("GitHub login failed")
            ),
            other => bail!("repository login returned an unknown event: {other}"),
        }
        ensure!(next["done"] != true, "GitHub login did not complete");
    }
}

fn logout(cli: &Cli, provider: Option<&str>) -> Result<()> {
    let provider = pick_provider(provider)?;
    cli.request_lifecycle(
        "POST",
        "/v1/repos/logout",
        Some(&json!({"provider": provider})),
    )?;
    println!(
        "Logged out of GitHub for all ADM workspaces. Run adm repos login github to reconnect."
    );
    Ok(())
}
