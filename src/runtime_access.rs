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
    let mut stderr = child.stderr.take().context("read runtime forward errors")?;
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reported_ready = false;
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !reported_ready && line.starts_with("Forwarding from 127.0.0.1:") => {
                    let address = line
                        .strip_prefix("Forwarding from 127.0.0.1:")
                        .unwrap_or_default();
                    if let Some(port) = address.split_whitespace().next() {
                        let _ = ready_tx.send(Ok(port.to_owned()));
                        reported_ready = true;
                    }
                }
                Ok(_) => {}
                Err(error) if !reported_ready => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
                Err(_) => return,
            }
        }
        if !reported_ready {
            let _ = ready_tx.send(Err(
                "kubectl closed stdout before reporting its forward".into()
            ));
        }
    });
    let (stderr_tx, stderr_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bounded = Vec::new();
        let mut chunk = [0; 1024];
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    let remaining = 8192usize.saturating_sub(bounded.len());
                    bounded.extend_from_slice(&chunk[..length.min(remaining)]);
                }
            }
        }
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

#[cfg(test)]
mod forward_pipe_tests {
    use super::*;

    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, time::Instant};

    #[test]
    fn forward_drains_startup_pipes_after_reporting_readiness() {
        let directory = tempfile::tempdir().unwrap();
        let kubeconfig = directory.path().join("kubeconfig");
        fs::write(&kubeconfig, "fixture").unwrap();
        let marker = directory.path().join("drained");
        let kubectl = directory.path().join("kubectl");
        fs::write(
            &kubectl,
            format!(
                "#!/bin/sh\nprintf 'Forwarding from 127.0.0.1:39423 -> 7432\\n'\ni=0\nwhile [ \"$i\" -lt 10000 ]; do printf 'Handling connection for 7432\\n'; printf 'long-lived diagnostic\\n' >&2; i=$((i + 1)); done\ntouch '{}'\nsleep 5\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
        let cli = Cli {
            state_dir: Some(directory.path().join("state")),
            kubectl: kubectl.to_string_lossy().into_owned(),
            kubeconfig: Some(kubeconfig.to_string_lossy().into_owned()),
            runner_url: String::new(),
            lifecycle_url: String::new(),
            lifecycle_url_explicit: false,
            lifecycle_forward: false,
            lifecycle_namespace: String::new(),
            lifecycle_token_file: None,
            lifecycle_token_secret: false,
            runtime_status_port: 7432,
            lifecycle_fence: None,
            lifecycle_operation_id: None,
            project_dir: PathBuf::new(),
            command: crate::Action::LifecycleServe {
                host: "127.0.0.1".into(),
                port: 7433,
            },
        };
        let workspace: Workspace = serde_json::from_value(serde_json::json!({
            "id":"a1a1a1a1a1a14a1a8a1a1a1a1a1a1a1a",
            "name":"pipe-test", "role":"coding", "namespace":"adm-pipe-test",
            "phase":"ready", "image":"adm-dev:test", "storage_class":"test",
            "storage_size":"1Gi", "cpu":"1", "memory":"1Gi", "agent_enabled":true,
            "repositories":false, "catalog":{}, "model":null,
            "created_at":1
        }))
        .unwrap();
        let (mut forward, url) = forward(&cli, &workspace, "workspace-pod").unwrap();
        assert_eq!(url, "http://127.0.0.1:39423");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(marker.exists(), "kubectl stopped writing after readiness");
        assert!(forward.0.try_wait().unwrap().is_none());
        forward.0.kill().unwrap();
        forward.0.wait().unwrap();
    }
}
