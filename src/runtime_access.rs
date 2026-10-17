use crate::{Cli, runner, workspaces::Workspace};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

struct Forward(Child);

impl Drop for Forward {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct IdentityDirectory(std::path::PathBuf);

impl Drop for IdentityDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn pod_identity(cli: &Cli, workspace: &Workspace) -> Result<(String, String, String)> {
    let status = workspace
        .runtime_status
        .as_ref()
        .context("workspace runtime status is unavailable; retry `adm status`")?;
    let name = status["podName"]
        .as_str()
        .context("workspace runtime has no ready Pod; inspect `adm status`")?;
    let output = cli
        .kubectl_command()?
        .args(["get", "pod", name, "-n", &workspace.namespace, "-o", "json"])
        .output()
        .context("verify canonical workspace Pod identity")?;
    ensure!(
        output.status.success(),
        "workspace Pod is unavailable; reattach after it becomes ready"
    );
    let pod: Value = serde_json::from_slice(&output.stdout)?;
    let uid = pod["metadata"]["uid"]
        .as_str()
        .context("workspace Pod has no Kubernetes UID")?;
    let ready = pod["status"]["conditions"]
        .as_array()
        .is_some_and(|conditions| {
            conditions
                .iter()
                .any(|condition| condition["type"] == "Ready" && condition["status"] == "True")
        });
    ensure!(
        pod["metadata"]["namespace"] == workspace.namespace
            && pod["metadata"]["name"] == name
            && pod["metadata"]["labels"]["adm.dev/workspace-id"] == workspace.id
            && pod["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "adm"
            && pod["spec"]["serviceAccountName"] == "adm-runtime"
            && pod["status"]["phase"] == "Running"
            && ready,
        "workspace Pod identity changed or is not ready; reattach after it becomes ready"
    );
    let container = if workspace.role == "bot" {
        "bot"
    } else {
        "dev"
    };
    Ok((name.to_owned(), uid.to_owned(), container.to_owned()))
}

fn projected_token(cli: &Cli, workspace: &Workspace, pod: &str, container: &str) -> Result<String> {
    let output = cli
        .kubectl_command()?
        .args([
            "exec",
            "-n",
            &workspace.namespace,
            pod,
            "-c",
            container,
            "--",
            "cat",
            "/var/run/secrets/kubernetes.io/serviceaccount/token",
        ])
        .output()
        .context("read current projected workspace identity")?;
    ensure!(
        output.status.success(),
        "could not read current projected workspace identity"
    );
    let token = String::from_utf8(output.stdout)?.trim().to_owned();
    ensure!(!token.is_empty(), "projected workspace identity is empty");
    Ok(token)
}

fn forward(cli: &Cli, workspace: &Workspace, pod: &str) -> Result<(Forward, String)> {
    let mut child = cli
        .kubectl_command()?
        .args([
            "port-forward",
            "-n",
            &workspace.namespace,
            &format!("pod/{pod}"),
            "--address",
            "127.0.0.1",
            ":7432",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("start authenticated workspace runtime forward")?;
    let stdout = child
        .stdout
        .take()
        .context("read runtime forward readiness")?;
    let stderr = child.stderr.take().context("read runtime forward errors")?;
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if line.starts_with("Forwarding from 127.0.0.1:") => {
                    let address = line
                        .strip_prefix("Forwarding from 127.0.0.1:")
                        .unwrap_or_default();
                    if let Some(port) = address.split_whitespace().next() {
                        let _ = ready_tx.send(Ok(port.to_owned()));
                        return;
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            }
        }
        let _ = ready_tx.send(Err(
            "kubectl closed stdout before reporting its forward".into()
        ));
    });
    let (stderr_tx, stderr_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bounded = Vec::new();
        let _ = stderr.take(8192).read_to_end(&mut bounded);
        let _ = stderr_tx.send(String::from_utf8_lossy(&bounded).trim().to_owned());
    });
    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(port)) => Ok((Forward(child), format!("http://127.0.0.1:{port}"))),
        result => {
            let _ = child.kill();
            let _ = child.wait();
            let error = match result {
                Ok(Err(error)) => error,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    "kubectl did not report port-forward readiness within 10 seconds".into()
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    "kubectl port-forward readiness channel closed".into()
                }
                Ok(Ok(_)) => unreachable!(),
            };
            let stderr = stderr_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap_or_default();
            if stderr.is_empty() {
                anyhow::bail!("workspace runtime forward failed: {error}");
            }
            anyhow::bail!("workspace runtime forward failed: {error}: {stderr}");
        }
    }
}

pub fn request(
    cli: &Cli,
    workspace: &Workspace,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let (pod, _, container) = pod_identity(cli, workspace)?;
    let token = projected_token(cli, workspace, &pod, &container)?;
    let (forward, url) = forward(cli, workspace, &pod)?;
    let result = runner::request_authenticated(&url, method, path, body, &token);
    drop(forward);
    result
}

pub fn attach(cli: &Cli, workspace: &Workspace, diagnostics: bool) -> Result<()> {
    let (pod_name, pod_uid, container) = pod_identity(cli, workspace)?;
    let (forward, url) = forward(cli, workspace, &pod_name)?;
    let directory =
        std::env::temp_dir().join(format!("adm-runtime-identity-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).context("create private runtime identity directory")?;
    let directory = IdentityDirectory(directory);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory.0, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = directory.0.join("identity.json");
    let identity = serde_json::json!({
        "workspaceId": workspace.id,
        "namespace": workspace.namespace,
        "podName": pod_name,
        "podUid": pod_uid,
        "container": container,
        "kubectl": cli.kubectl,
        "kubeconfig": cli.kubeconfig_reference()?,
    });
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        serde_json::to_writer(&mut file, &identity)?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, serde_json::to_vec(&identity)?)?;
    let mut command = cli.runtime_command("terminal")?;
    command
        .args([
            "--url",
            &url,
            "--workspace",
            &workspace.id,
            "--identity-file",
        ])
        .arg(path);
    if diagnostics {
        command.arg("--diagnostics");
    }
    let status = command.status().context("start terminal client")?;
    ensure!(status.success(), "terminal exited with {status}");
    drop(forward);
    Ok(())
}

pub fn managed_shell(
    cli: &Cli,
    workspace: &Workspace,
    cwd: &str,
    shell_command: &[String],
) -> Result<()> {
    let (pod_name, pod_uid, container) = pod_identity(cli, workspace)?;
    let (forward, url) = forward(cli, workspace, &pod_name)?;
    let directory =
        std::env::temp_dir().join(format!("adm-runtime-identity-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).context("create private runtime identity directory")?;
    let directory = IdentityDirectory(directory);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory.0, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = directory.0.join("identity.json");
    let identity = serde_json::json!({
        "workspaceId": workspace.id,
        "namespace": workspace.namespace,
        "podName": pod_name,
        "podUid": pod_uid,
        "container": container,
        "kubectl": cli.kubectl,
        "kubeconfig": cli.kubeconfig_reference()?,
    });
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        serde_json::to_writer(&mut file, &identity)?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, serde_json::to_vec(&identity)?)?;
    let mut command = cli.runtime_command("shell-management")?;
    command.env("KUBECONFIG", cli.kubeconfig_reference()?);
    command
        .args([
            "--kubectl",
            &cli.kubectl,
            "--namespace",
            &workspace.namespace,
            "--workspace-id",
            &workspace.id,
            "--cwd",
            cwd,
            "--runner-url",
            &url,
            "--identity-file",
        ])
        .arg(path);
    if !shell_command.is_empty() {
        command.arg("--").args(shell_command);
    }
    let status = command
        .status()
        .context("start current-workspace management shell")?;
    ensure!(status.success(), "managed shell exited with {status}");
    drop(forward);
    Ok(())
}

pub fn login(cli: &Cli, workspace: &Workspace) -> Result<()> {
    let (pod, _, container) = pod_identity(cli, workspace)?;
    let status = cli
        .kubectl_command()?
        .args([
            "exec",
            "-it",
            "-n",
            &workspace.namespace,
            &pod,
            "-c",
            &container,
            "--",
            "env",
            "PI_CODING_AGENT_DIR=/workspace/.adm/pi",
            "node",
            "/opt/adm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
        ])
        .status()
        .context("open provider login inside workspace Pod")?;
    ensure!(status.success(), "provider login exited with {status}");
    Ok(())
}
