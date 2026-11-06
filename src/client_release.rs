//! Client and cluster must run the same ADM release. The client picks a new
//! workspace's images from its own release, so a client on another release
//! than the lifecycle quietly creates workspaces from that release's images.
//! Every operator request names the client's release (`x-adm-release`); a
//! lifecycle installed from a release (`ADM_RELEASE`) turns away any other one
//! with 426 and `run adm update`. `adm update` marks its own requests
//! (`x-adm-release-update`) because it is how a client and cluster on different
//! releases converge. Workspace runtimes authenticate with Pod tokens and are
//! never checked.

use anyhow::{Context, Result};
use std::{io, path::Path, sync::OnceLock};

pub const RELEASE_HEADER: &str = "x-adm-release";
pub const RELEASE_UPDATE_HEADER: &str = "x-adm-release-update";

struct ClientRelease {
    /// `VERSION` of the release directory; `None` for an unreleased build.
    release: Option<String>,
    updating: bool,
}

static CLIENT_RELEASE: OnceLock<ClientRelease> = OnceLock::new();

/// `VERSION` of the release directory `project_dir`; `None` for an unreleased
/// build run from a checkout.
fn installed_release(project_dir: &Path) -> Result<Option<String>> {
    let path = project_dir.join("VERSION");
    match std::fs::read_to_string(&path) {
        Ok(version) => Ok(Some(version.trim().to_owned()).filter(|version| !version.is_empty())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

/// Records which release this process's lifecycle requests come from.
pub fn identify_client_release(project_dir: &Path, updating: bool) -> Result<()> {
    let release = installed_release(project_dir)?;
    let _ = CLIENT_RELEASE.set(ClientRelease { release, updating });
    Ok(())
}

pub fn with_client_release_headers(
    mut request: reqwest::blocking::RequestBuilder,
) -> reqwest::blocking::RequestBuilder {
    let Some(client) = CLIENT_RELEASE.get() else {
        return request;
    };
    if let Some(release) = &client.release {
        request = request.header(RELEASE_HEADER, release);
    }
    if client.updating {
        request = request.header(RELEASE_UPDATE_HEADER, "1");
    }
    request
}

/// The release the lifecycle was installed from, if any.
pub fn lifecycle_release_from_env() -> Option<String> {
    let release = std::env::var("ADM_RELEASE")
        .ok()
        .filter(|release| !release.is_empty());
    match &release {
        Some(release) => eprintln!(
            "adm lifecycle release {release}: operator clients from any other release are turned away"
        ),
        None => eprintln!(
            "adm lifecycle has no ADM_RELEASE: operator clients are not checked for their release"
        ),
    }
    release
}

/// The 426 message for an operator client that is not on `lifecycle_release`,
/// or `None` when the client may proceed.
pub fn reject_other_client_release(
    lifecycle_release: Option<&str>,
    client_release: Option<&str>,
    updating: bool,
) -> Option<String> {
    let lifecycle_release = lifecycle_release?;
    if updating || client_release == Some(lifecycle_release) {
        return None;
    }
    let client = client_release.map_or_else(
        || "adm (an older or unreleased build)".to_owned(),
        |release| format!("adm {release}"),
    );
    eprintln!("adm lifecycle turned away {client}: the cluster runs {lifecycle_release}");
    Some(format!(
        "this is {client}, but the cluster runs {lifecycle_release}; run `adm update` to install the cluster's release"
    ))
}

/// Points the lifecycle container of the control-plane manifest at the
/// installing client's release, or removes it for an unreleased build.
pub fn set_lifecycle_release(container: &mut serde_json::Value, project_dir: &Path) -> Result<()> {
    let release = installed_release(project_dir)?;
    if container["env"].is_null() {
        container["env"] = serde_json::json!([]);
    }
    let env = container["env"]
        .as_array_mut()
        .context("lifecycle container env is not a list")?;
    env.retain(|variable| variable["name"] != "ADM_RELEASE");
    if let Some(release) = release {
        env.push(serde_json::json!({"name":"ADM_RELEASE","value":release}));
    }
    Ok(())
}
