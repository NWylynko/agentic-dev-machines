use crate::{Cli, lifecycle, setup, setup_connection, setup_control_plane, workspaces};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MANAGED_INSTALLER: &str = include_str!("../install.sh");
const MAINTENANCE_SECONDS: u64 = 300;
/// How long `adm update` waits for the replaced lifecycle's API after rollout.
const UPDATED_LIFECYCLE_WAIT: Duration = Duration::from_secs(60);
const UPDATED_LIFECYCLE_RETRY: Duration = Duration::from_secs(1);

struct WorkspaceImages {
    code: String,
    bot: String,
    workspace: String,
    repositories: String,
}

pub fn run(
    cli: &Cli,
    version: Option<&str>,
    base_url: Option<&str>,
    workspaces: &[String],
    operation_id: Option<&str>,
) -> Result<()> {
    validate_selection(workspaces, operation_id)?;
    let selected_ids = resolve_selected_workspaces(cli, workspaces)?;
    let operation_id = operation_id
        .map(str::to_owned)
        .or_else(|| (selected_ids.len() == 1).then(|| uuid::Uuid::new_v4().to_string()));
    let old_client = env!("CARGO_PKG_VERSION");
    let mut installer = Command::new("sh");
    installer.args(["-s", "--", "--no-setup"]);
    if let Some(version) = version {
        installer.args(["--version", version]);
    }
    if let Some(base_url) = base_url {
        installer.args(["--base-url", base_url]);
    }
    let mut child = installer
        .stdin(Stdio::piped())
        .spawn()
        .context("start the embedded managed ADM installer")?;
    child
        .stdin
        .take()
        .context("open managed installer input")?
        .write_all(MANAGED_INSTALLER.as_bytes())
        .context("send embedded installer to sh")?;
    let status = child.wait().context("wait for managed installer")?;
    ensure!(
        status.success(),
        "managed ADM client update failed before service updates; the current command remains available"
    );

    let managed_command = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME must be set to invoke the managed ADM command")?
        .join(".local/bin/adm");
    ensure!(
        managed_command.is_file(),
        "client archive installed, but managed command is missing at {}; install ADM with install.sh before retrying `adm update`",
        managed_command.display()
    );
    let target_version = installed_version(&managed_command)?;
    let mut command = Command::new(&managed_command);
    command.env_remove("ADM_PROJECT_DIR");
    if let Some(path) = &cli.state_dir {
        command.args(["--state-dir", &path.to_string_lossy()]);
    }
    command.args(["--kubectl", &cli.kubectl]);
    if let Some(kubeconfig) = &cli.kubeconfig {
        command.args(["--kubeconfig", kubeconfig]);
    }
    command.args(["--lifecycle-namespace", &cli.lifecycle_namespace]);
    if cli.lifecycle_url_explicit {
        command.args(["--lifecycle-url", &cli.lifecycle_url]);
    }
    if let Some(token_file) = &cli.lifecycle_token_file {
        command.args(["--lifecycle-token-file", &token_file.to_string_lossy()]);
    }
    command.arg("__update-services");
    for workspace_id in &selected_ids {
        command.args(["--workspace", workspace_id]);
    }
    if let Some(operation_id) = &operation_id {
        command.args(["--operation-id", operation_id]);
    }
    let status = command
        .status()
        .context("invoke the newly activated managed ADM release")?;
    let mut retry = String::from("adm update");
    retry.push_str(&format!(" --version {target_version}"));
    if let Some(base_url) = base_url {
        retry.push_str(&format!(" --base-url {base_url}"));
    }
    for workspace_id in &selected_ids {
        retry.push_str(&format!(" --workspace {workspace_id}"));
    }
    if let Some(operation_id) = &operation_id {
        retry.push_str(&format!(" --operation-id {operation_id}"));
    }
    ensure!(
        status.success(),
        "ADM client updated from {old_client}, but controller or selected workspace update failed; retry the same update with `{retry}`"
    );
    Ok(())
}

fn resolve_selected_workspaces(cli: &Cli, requested: &[String]) -> Result<Vec<String>> {
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    setup_connection::preflight(cli)?;
    let mut connected = cli.clone_for_lifecycle();
    let connection = if cli.lifecycle_forward {
        let connection = setup_connection::connect(cli)
            .context("connect to lifecycle service before resolving selected workspace IDs")?;
        connected.lifecycle_url = connection.url.clone();
        Some(connection)
    } else {
        None
    };
    let workspaces = connected.workspaces(false)?;
    let mut selected_ids = Vec::with_capacity(requested.len());
    for selector in requested {
        let workspace = workspaces
            .iter()
            .find(|workspace| workspace.id == *selector || workspace.name == *selector)
            .with_context(|| format!("workspace not found: {selector}"))?;
        ensure!(
            workspace.phase == "ready",
            "workspace {} ({}) is not ready for an image update",
            workspace.name,
            workspace.id
        );
        selected_ids.push(workspace.id.clone());
    }
    drop(connection);
    Ok(selected_ids)
}

fn installed_version(managed_command: &std::path::Path) -> Result<String> {
    let executable = std::fs::canonicalize(managed_command)
        .context("resolve managed ADM executable after installation")?;
    let release = executable
        .parent()
        .and_then(std::path::Path::parent)
        .context("managed ADM executable is not inside a release directory")?;
    let version = std::fs::read_to_string(release.join("VERSION"))
        .context("read the newly installed release version")?;
    let version = version.trim();
    ensure!(
        !version.is_empty(),
        "newly installed release has no VERSION"
    );
    Ok(version.to_owned())
}

pub fn update_services(cli: &Cli, selected: &[String], operation_id: Option<&str>) -> Result<()> {
    validate_selection(selected, operation_id)?;
    let target_version = packaged_value(cli, "VERSION")?;
    let target_image = packaged_value(cli, "CONTROL_IMAGE")?;
    ensure!(
        cli.lifecycle_namespace == "adm-system",
        "automatic controller updates require lifecycle namespace adm-system; install a custom control plane manually"
    );
    let old = controller_images(cli)?;
    let old_image = old.join(", ");
    let storage_class = controller_storage_class(cli)?;
    eprintln!(
        "adm: update: controller image {old_image} -> {target_image} (release {target_version})"
    );
    setup_connection::preflight(cli)?;
    let mut connected = cli.clone_for_lifecycle();
    let maintenance_connection = if cli.lifecycle_forward {
        let connection = setup_connection::connect(cli)
            .context("connect to lifecycle service before controller maintenance")?;
        connected.lifecycle_url = connection.url.clone();
        Some(connection)
    } else {
        None
    };
    let maintenance_id = open_update_maintenance_id(cli)?;
    let extension = connected.request_lifecycle(
        "POST",
        "/v1/runtime/maintenance/extend",
        Some(&json!({
            "maintenanceId":maintenance_id,
            "durationSeconds":MAINTENANCE_SECONDS,
        })),
    )?;
    let maintenance_expires_at = extension["expiresAt"]
        .as_u64()
        .context("maintenance extension omitted its authoritative expiry")?;
    eprintln!(
        "adm: update: extended {} active workspace leases through {} (controller maintenance window {maintenance_id})",
        extension["workspaceIds"].as_array().map_or(0, Vec::len),
        maintenance_expires_at,
    );
    // From here on every failure releases the window before returning, so the
    // runtimes that acknowledged it are not left to restart when it expires.
    let updated = update_controller_during_maintenance(
        cli,
        connected,
        maintenance_connection,
        &maintenance_id,
        &target_image,
        &storage_class,
        &target_version,
    );
    let (connected, connection) = match updated {
        Ok(updated) => updated,
        Err(error) => {
            cancel_update_maintenance(cli, &maintenance_id, maintenance_expires_at);
            return Err(error);
        }
    };
    advance_saved_release_images(cli)?;
    if !selected.is_empty() {
        let images = WorkspaceImages {
            code: packaged_value(cli, "CODE_IMAGE")?,
            bot: packaged_value(cli, "BOT_IMAGE")?,
            workspace: packaged_value(cli, "WORKSPACE_IMAGE")?,
            repositories: packaged_value(cli, "REPOSITORIES_IMAGE")?,
        };
        upgrade_selected(&connected, selected, &images, &target_version, operation_id)?;
    }
    drop(connection);
    Ok(())
}

/// Waits for every runtime to acknowledge window `maintenance_id`, replaces the
/// controller, waits for its authenticated API and completes the window.
/// Returns a client connected to the updated controller.
fn update_controller_during_maintenance(
    cli: &Cli,
    connected: Cli,
    maintenance_connection: Option<setup_connection::Connection>,
    maintenance_id: &str,
    target_image: &str,
    storage_class: &str,
    target_version: &str,
) -> Result<(Cli, Option<setup_connection::Connection>)> {
    connected.request_lifecycle(
        "POST",
        "/v1/runtime/maintenance/await",
        Some(&json!({"maintenanceId":maintenance_id})),
    )
    .context("cannot interrupt the controller until every active workspace runtime acknowledges the planned lease extension")?;
    drop(maintenance_connection);

    setup_control_plane::install(cli, target_image, storage_class)
        .context("apply the selected release controller and shared provider-auth service")?;
    let observed = controller_images(cli)?;
    ensure!(
        observed.iter().all(|image| image == target_image),
        "controller rollout reported ready, but observed images are {} (target {target_image})",
        observed.join(", ")
    );
    eprintln!(
        "adm: update: controller release {target_version} observed on all owned service containers"
    );
    let (connected, connection) = wait_for_updated_lifecycle_api(cli)?;
    connected
        .request_lifecycle(
            "POST",
            "/v1/runtime/maintenance/complete",
            Some(&json!({"maintenanceId":maintenance_id})),
        )
        .with_context(|| {
            format!(
                "controller is healthy, but completing maintenance window {maintenance_id} failed"
            )
        })?;
    forget_update_maintenance_id(cli);
    eprintln!("adm: update: completed controller maintenance window {maintenance_id}");
    Ok((connected, connection))
}

/// A rollout replaces the lifecycle Pod, which always breaks existing
/// port-forwards, including a separate `adm lifecycle-forward` behind an
/// explicit URL. Connection failures are retried until `UPDATED_LIFECYCLE_WAIT`
/// has passed; an answer from the lifecycle, even an error, is final.
fn wait_for_updated_lifecycle_api(
    cli: &Cli,
) -> Result<(Cli, Option<setup_connection::Connection>)> {
    let rolled_out = Instant::now();
    let mut attempt = 0;
    loop {
        attempt += 1;
        let mut connected = cli.clone_for_lifecycle();
        let connection = if cli.lifecycle_forward {
            match setup_connection::connect(cli) {
                Ok(connection) => {
                    connected.lifecycle_url = connection.url.clone();
                    Some(connection)
                }
                Err(error) => {
                    retry_updated_lifecycle_api(rolled_out, attempt, error, true)?;
                    continue;
                }
            }
        } else {
            None
        };
        match connected.request_lifecycle("GET", "/v1/workspaces", None) {
            Ok(_) => {
                eprintln!(
                    "adm: update: updated lifecycle API answered an authenticated request (attempt {attempt}, {:.1}s after rollout)",
                    rolled_out.elapsed().as_secs_f64()
                );
                return Ok((connected, connection));
            }
            Err(error) => {
                let unreachable = error
                    .chain()
                    .any(|cause| cause.downcast_ref::<reqwest::Error>().is_some());
                retry_updated_lifecycle_api(rolled_out, attempt, error, unreachable)?;
            }
        }
    }
}

/// Logs a failed verification attempt and pauses before the next one, or
/// returns the error once it is final or the wait is over.
fn retry_updated_lifecycle_api(
    rolled_out: Instant,
    attempt: u32,
    error: anyhow::Error,
    unreachable: bool,
) -> Result<()> {
    let elapsed = rolled_out.elapsed().as_secs_f64();
    if !unreachable || rolled_out.elapsed() >= UPDATED_LIFECYCLE_WAIT {
        return Err(error).with_context(|| {
            format!(
                "verify authenticated lifecycle API after controller update (attempt {attempt}, {elapsed:.1}s after rollout)"
            )
        });
    }
    eprintln!(
        "adm: update: updated lifecycle API not reachable yet (attempt {attempt}, {elapsed:.1}s after rollout): {error:#}"
    );
    std::thread::sleep(UPDATED_LIFECYCLE_RETRY);
    Ok(())
}

/// The client's record of the controller maintenance window its update opened,
/// kept until the window is completed or cancelled. A retry reuses the ID, so
/// `extend` resumes that window instead of being refused because another one is
/// active (TASK-92).
fn update_maintenance_state_path(cli: &Cli) -> PathBuf {
    cli.state_path().join("update-maintenance.json")
}

fn open_update_maintenance_id(cli: &Cli) -> Result<String> {
    let path = update_maintenance_state_path(cli);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let saved: Value = serde_json::from_slice(&bytes)
                .with_context(|| format!("decode {}", path.display()))?;
            let maintenance_id = saved["maintenanceId"]
                .as_str()
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .with_context(|| format!("{} has no valid maintenanceId", path.display()))?
                .to_owned();
            eprintln!(
                "adm: update: resuming controller maintenance window {maintenance_id} left open by an earlier update ({})",
                path.display()
            );
            Ok(maintenance_id)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let maintenance_id = uuid::Uuid::new_v4().to_string();
            std::fs::create_dir_all(cli.state_path())
                .with_context(|| format!("create {}", cli.state_path().display()))?;
            std::fs::write(&path, json!({"maintenanceId":maintenance_id}).to_string())
                .with_context(|| format!("record the maintenance window in {}", path.display()))?;
            Ok(maintenance_id)
        }
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn forget_update_maintenance_id(cli: &Cli) {
    let path = update_maintenance_state_path(cli);
    if let Err(error) = std::fs::remove_file(&path) {
        eprintln!(
            "adm: update: warning: could not remove {}: {error}; the next update resumes an ID whose window has ended, which opens a new window",
            path.display()
        );
    }
}

/// Releases window `maintenance_id` after a failed update. If that fails too,
/// the window lasts until `expires_at`, and a retry meanwhile resumes it.
fn cancel_update_maintenance(cli: &Cli, maintenance_id: &str, expires_at: u64) {
    let mut connected = cli.clone_for_lifecycle();
    let cancelled = (|| {
        let _connection = if cli.lifecycle_forward {
            let connection = setup_connection::connect(cli)
                .context("connect to lifecycle service to release the maintenance window")?;
            connected.lifecycle_url = connection.url.clone();
            Some(connection)
        } else {
            None
        };
        connected.request_lifecycle(
            "POST",
            "/v1/runtime/maintenance/cancel",
            Some(&json!({"maintenanceId":maintenance_id})),
        )
    })();
    match cancelled {
        Ok(_) => {
            forget_update_maintenance_id(cli);
            eprintln!(
                "adm: update: released controller maintenance window {maintenance_id} after the failed update"
            );
        }
        Err(error) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_secs());
            eprintln!(
                "adm: update: could not release controller maintenance window {maintenance_id}: {error:#}. It expires at {expires_at} (unix seconds, in {}s). Workspaces that acknowledged it restart then, unless `adm update` is retried first: a retry resumes this window",
                expires_at.saturating_sub(now)
            );
        }
    }
}

/// `adm setup` saves the release's own image as an explicit reference, so new
/// workspaces would keep the setup-time runner forever. A saved image from the
/// release's repository follows the update; an image from any other repository
/// is the user's own choice and is kept. Before TASK-110 every role ran one image
/// whose repository is the parent of the per-role ones, so it follows too.
fn advance_saved_release_images(cli: &Cli) -> Result<()> {
    let mut config = setup::read_config()?;
    for (saved, filename) in [
        (&mut config.image, "CODE_IMAGE"),
        (&mut config.bot_image, "BOT_IMAGE"),
    ] {
        let Some(saved_image) = saved.as_deref() else {
            continue;
        };
        let target_image = packaged_value(cli, filename)?;
        let saved_repository = image_repository(saved_image);
        let target_repository = image_repository(&target_image);
        let release_owned = saved_repository == target_repository
            || target_repository
                .strip_prefix(saved_repository)
                .is_some_and(|role| role.starts_with("/adm-"));
        if saved_image != target_image && release_owned {
            eprintln!("adm: update: new workspaces now use {target_image} (was {saved_image})");
            *saved = Some(target_image);
        }
    }
    setup::save_config(&config).context("save the updated workspace image default")?;
    Ok(())
}

fn image_repository(image: &str) -> &str {
    let image = image.split_once('@').map_or(image, |(name, _)| name);
    match (image.rfind(':'), image.rfind('/')) {
        (Some(tag), slash) if slash.is_none_or(|slash| tag > slash) => &image[..tag],
        _ => image,
    }
}

fn packaged_value(cli: &Cli, filename: &str) -> Result<String> {
    let value = std::fs::read_to_string(cli.project_dir.join(filename))
        .with_context(|| format!("read selected release {filename}"))?;
    let value = value.trim();
    ensure!(
        !value.is_empty() && !value.chars().any(char::is_whitespace),
        "invalid release {filename}"
    );
    Ok(value.to_owned())
}

fn validate_selection(workspaces: &[String], operation_id: Option<&str>) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    ensure!(
        workspaces.iter().all(|workspace| seen.insert(workspace)),
        "a workspace was selected more than once"
    );
    ensure!(
        operation_id.is_none() || workspaces.len() == 1,
        "--operation-id requires exactly one --workspace"
    );
    Ok(())
}

fn controller_images(cli: &Cli) -> Result<Vec<String>> {
    let namespace: Value = serde_json::from_slice(&workspaces::kubectl(
        cli,
        &["get", "namespace", "adm-system", "-o", "json"],
        None,
    )?)
    .context("decode lifecycle namespace ownership")?;
    ensure!(
        namespace["metadata"]["labels"]["app.kubernetes.io/part-of"] == "adm",
        "namespace adm-system is not labeled as an ADM-owned control plane; refusing automatic update"
    );
    let bytes = workspaces::kubectl(
        cli,
        &[
            "get",
            "deployment",
            "adm-lifecycle",
            "-n",
            &cli.lifecycle_namespace,
            "-o",
            "json",
        ],
        None,
    )
    .context("read the currently installed lifecycle controller before updating")?;
    let deployment: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        deployment["metadata"]["name"] == "adm-lifecycle"
            && deployment["metadata"]["namespace"] == "adm-system"
            && deployment["spec"]["selector"]["matchLabels"]["app.kubernetes.io/name"]
                == "adm-lifecycle"
            && deployment["spec"]["template"]["spec"]["serviceAccountName"] == "adm-lifecycle"
            && deployment["spec"]["template"]["spec"]["volumes"]
                .as_array()
                .is_some_and(|volumes| {
                    volumes.iter().any(|volume| {
                        volume["name"] == "state"
                            && volume["persistentVolumeClaim"]["claimName"] == "adm-lifecycle-state"
                    })
                }),
        "deployment adm-system/adm-lifecycle does not match the owned ADM lifecycle control plane; refusing automatic update"
    );
    let pod_spec = &deployment["spec"]["template"]["spec"];
    let containers = pod_spec["containers"]
        .as_array()
        .context("lifecycle deployment has no containers")?;
    let images = containers
        .iter()
        .filter_map(|container| container["image"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let images = pod_spec["initContainers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|container| container["image"].as_str().map(str::to_owned))
        .chain(images)
        .collect::<Vec<_>>();
    ensure!(
        !images.is_empty(),
        "lifecycle deployment has no container images"
    );
    Ok(images)
}

fn controller_storage_class(cli: &Cli) -> Result<String> {
    let bytes = workspaces::kubectl(
        cli,
        &[
            "get",
            "pvc",
            "adm-lifecycle-state",
            "-n",
            "adm-system",
            "-o",
            "json",
        ],
        None,
    )
    .context("read the existing lifecycle PVC before updating the controller")?;
    let claim: Value = serde_json::from_slice(&bytes).context("decode lifecycle PVC")?;
    ensure!(
        claim["metadata"]["name"] == "adm-lifecycle-state"
            && claim["metadata"]["namespace"] == "adm-system",
        "PVC adm-system/adm-lifecycle-state does not match the owned lifecycle state claim"
    );
    claim["spec"]["storageClassName"]
        .as_str()
        .filter(|storage_class| !storage_class.is_empty())
        .map(str::to_owned)
        .context(
            "existing lifecycle PVC has no storageClassName; refusing to change its storage policy",
        )
}

fn upgrade_selected(
    cli: &Cli,
    names: &[String],
    images: &WorkspaceImages,
    version: &str,
    operation_id: Option<&str>,
) -> Result<()> {
    for (index, name) in names.iter().enumerate() {
        let workspace = cli.active_workspace(name)?;
        ensure!(
            workspace.phase == "ready",
            "workspace {} is not ready for an image update",
            workspace.name
        );
        eprintln!(
            "adm: update: selected workspace {} ({}) will be interrupted while its role image is applied; identity, repository files, and agent history remain on its existing workspace volume",
            workspace.name, workspace.id
        );
        let operation_id = operation_id
            .filter(|_| index == 0)
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        eprintln!(
            "adm: update: workspace operation {operation_id} targets immutable ID {}",
            workspace.id
        );
        let receipt = cli.request_lifecycle(
            "POST",
            "/v1/operations",
            Some(&serde_json::to_value(
                lifecycle::OperationRequest::Update {
                    operation_id,
                    workspace_id: workspace.id.clone(),
                    image: if workspace.role == "bot" {
                        &images.bot
                    } else {
                        &images.code
                    }
                    .to_owned(),
                    workspace_image: Some(images.workspace.clone()),
                    repositories_image: Some(images.repositories.clone()),
                },
            )?),
        )?;
        let accepted_id = receipt["operationId"]
            .as_str()
            .context("update receipt omitted operationId")?;
        let workspace_id = receipt["workspaceId"]
            .as_str()
            .context("update receipt omitted workspaceId")?;
        let updated = cli
            .wait_for_lifecycle_workspace(accepted_id, workspace_id, "update", &workspace.name)
            .with_context(|| {
                format!(
                    "workspace update operation {accepted_id} failed; resume it against immutable workspace ID {} with `adm update --version {version} --workspace {} --operation-id {accepted_id}`",
                    workspace.id,
                    workspace.id,
                )
            })?;
        println!(
            "Updated workspace {} ({}) to {}",
            updated.name, updated.id, updated.image
        );
    }
    Ok(())
}
