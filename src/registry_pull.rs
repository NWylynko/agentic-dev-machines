//! Private container images pull with the cluster GitHub login (`adm repos
//! login github`, which asks GitHub for `read:packages`). Each workspace
//! namespace gets a ghcr.io pull Secret written from that login when the
//! workspace is created or its image updated, and logging out deletes them.
//! The token is never logged.

use crate::workspaces::{Workspace, kubectl, labels};
use anyhow::{Context, Result, bail};
use base64::Engine;
use serde_json::{Value, json};

pub const REGISTRY_PULL_SECRET: &str = "adm-registry";

/// The cluster GitHub login as (account, token), or None when logged out.
fn cluster_github_login() -> Result<Option<(String, String)>> {
    let (status, login) =
        crate::lifecycle::proxy_provider_auth("GET", "/v1/runtime/repos/token", b"")?;
    match status {
        200 => Ok(Some((
            login["account"]
                .as_str()
                .context("GitHub login has no account")?
                .to_owned(),
            login["token"]
                .as_str()
                .context("GitHub login has no token")?
                .to_owned(),
        ))),
        409 => Ok(None),
        _ => bail!(
            "cannot read the cluster GitHub login for image pulls ({status}): {}",
            login["error"]["message"].as_str().unwrap_or("no message")
        ),
    }
}

/// The ghcr.io pull Secret for this workspace, or None when GitHub is logged
/// out. Bots get none: the GitHub login is for coding workspaces only.
pub fn registry_pull_secret(w: &Workspace) -> Result<Option<Value>> {
    if w.role != "coding" {
        return Ok(None);
    }
    let Some((account, token)) = cluster_github_login()? else {
        return Ok(None);
    };
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let config = json!({"auths":{"ghcr.io":{
        "username":account,
        "password":token,
        "auth":encode(format!("{account}:{token}").as_bytes()),
    }}});
    Ok(Some(json!({
        "apiVersion":"v1","kind":"Secret","type":"kubernetes.io/dockerconfigjson",
        "metadata":{"name":REGISTRY_PULL_SECRET,"namespace":w.namespace,"labels":labels(w)},
        "data":{".dockerconfigjson":encode(&serde_json::to_vec(&config)?)},
    })))
}

/// Points a workspace Deployment at the pull Secret.
pub fn use_registry_pull_secret(deployment: &mut Value) {
    deployment["spec"]["template"]["spec"]["imagePullSecrets"] =
        json!([{"name":REGISTRY_PULL_SECRET}]);
}

/// Adds the pull Secret to a workspace manifest (before its Deployment) when
/// GitHub is logged in.
pub fn add_registry_pull_secret(w: &Workspace, resources: &mut Value) -> Result<()> {
    let Some(secret) = registry_pull_secret(w)? else {
        return Ok(());
    };
    let items = resources["items"]
        .as_array_mut()
        .context("workspace manifest is not a Kubernetes List")?;
    for item in items.iter_mut() {
        if item["kind"] == "Deployment" && item["metadata"]["name"] == "workspace" {
            use_registry_pull_secret(item);
        }
    }
    let after_namespace = items
        .iter()
        .position(|item| item["kind"] == "Namespace")
        .map_or(0, |index| index + 1);
    items.insert(after_namespace, secret);
    Ok(())
}

/// After `adm repos logout github`: no workspace keeps pulling with the login.
pub fn remove_registry_pull_secrets(cli: &crate::Cli) -> Result<()> {
    for workspace in cli.store()?.list(false)? {
        kubectl(
            cli,
            &[
                "delete",
                "secret",
                REGISTRY_PULL_SECRET,
                "-n",
                &workspace.namespace,
                "--ignore-not-found",
            ],
            None,
        )
        .with_context(|| {
            format!(
                "GitHub is logged out, but the image pull Secret of workspace {} remains",
                workspace.name
            )
        })?;
    }
    Ok(())
}
