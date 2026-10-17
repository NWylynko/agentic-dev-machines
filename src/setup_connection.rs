use crate::Cli;
use anyhow::{Context, Result, bail, ensure};
use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

const SERVICE: &str = "adm-lifecycle-forward.service";

fn local_port(cli: &Cli) -> Result<u16> {
    let url = reqwest::Url::parse(&cli.lifecycle_url).context("parse lifecycle URL")?;
    ensure!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "automatic lifecycle forwarding requires http://127.0.0.1:PORT"
    );
    let port = url
        .port_or_known_default()
        .context("lifecycle URL needs a port")?;
    ensure!(port != 0, "lifecycle forwarding port must be nonzero");
    Ok(port)
}

fn executable_path(program: &str) -> Result<PathBuf> {
    ensure!(
        !program.chars().any(char::is_control),
        "executable path must not contain control characters"
    );
    let program_path = Path::new(program);
    let candidates = if program_path.components().count() > 1 || program_path.is_absolute() {
        vec![program_path.to_path_buf()]
    } else {
        std::env::split_paths(&std::env::var_os("PATH").context("PATH must be set")?)
            .map(|directory| directory.join(program))
            .collect()
    };
    for candidate in candidates {
        if let Ok(metadata) = fs::metadata(&candidate)
            && metadata.is_file()
            && metadata.permissions().mode() & 0o111 != 0
        {
            // Preserve the executable's name: k3s dispatches its kubectl symlink by argv[0].
            return Ok(if candidate.is_absolute() {
                candidate
            } else {
                std::env::current_dir()?.join(candidate)
            });
        }
    }
    bail!("required executable is unavailable: {program}")
}

fn systemd_quote(value: &str, expand_environment: bool) -> Result<String> {
    ensure!(
        !value.chars().any(char::is_control),
        "systemd arguments must not contain control characters"
    );
    let mut quoted = String::from("\"");
    for character in value.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '%' => quoted.push_str("%%"),
            '$' if expand_environment => quoted.push_str("$$"),
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

fn path_text(path: &Path) -> Result<&str> {
    path.to_str().context("service paths must be valid UTF-8")
}

fn service_command(systemctl: &Path, arguments: &[&str]) -> Result<()> {
    let status = Command::new(systemctl)
        .arg("--user")
        .args(arguments)
        .stdin(Stdio::null())
        .status()
        .with_context(|| format!("run systemctl --user {}", arguments.join(" ")))?;
    ensure!(
        status.success(),
        "systemctl --user {} failed with {status}; inspect journalctl --user -u {SERVICE}",
        arguments.join(" ")
    );
    Ok(())
}

pub fn preflight(cli: &Cli) -> Result<()> {
    local_port(cli)?;
    let systemctl = executable_path("systemctl")?;
    let notify = executable_path("systemd-notify")?;
    let kubectl = executable_path(&cli.kubectl)?;
    let executable = std::env::current_exe().context("resolve ADM executable")?;
    for value in [
        path_text(&executable)?,
        path_text(&kubectl)?,
        path_text(&notify)?,
        &cli.kubeconfig_reference()?,
        &cli.lifecycle_namespace,
        &cli.lifecycle_url,
    ] {
        systemd_quote(value, true)?;
    }
    let output = Command::new(systemctl)
        .args(["--user", "show-environment"])
        .stdin(Stdio::null())
        .output()
        .context("connect to systemd user manager")?;
    ensure!(
        output.status.success(),
        "systemd user manager is unavailable: {}; establish a systemd user session before running adm setup",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

pub fn install(cli: &Cli) -> Result<()> {
    local_port(cli)?;
    let systemctl = executable_path("systemctl")?;
    let notify = executable_path("systemd-notify")?;
    let kubectl = executable_path(&cli.kubectl)?;
    let executable = std::env::current_exe().context("resolve ADM executable")?;
    let kubeconfig = cli.kubeconfig_reference()?;
    let arguments = [
        path_text(&executable)?,
        "--kubectl",
        path_text(&kubectl)?,
        "--kubeconfig",
        &kubeconfig,
        "--lifecycle-namespace",
        &cli.lifecycle_namespace,
        "--lifecycle-url",
        &cli.lifecycle_url,
        "lifecycle-forward",
    ]
    .into_iter()
    .map(|argument| systemd_quote(argument, true))
    .collect::<Result<Vec<_>>>()?
    .join(" ");
    let service_path = format!(
        "{}:/usr/local/bin:/usr/bin:/bin",
        path_text(
            notify
                .parent()
                .context("systemd-notify needs a parent directory")?
        )?
    );
    let service_environment = systemd_quote(&format!("PATH={service_path}"), false)?;
    let config = match std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => {
            PathBuf::from(std::env::var_os("HOME").context("HOME must be set")?).join(".config")
        }
    };
    ensure!(
        config.is_absolute(),
        "configuration home must be an absolute path"
    );
    let directory = config.join("systemd/user");
    fs::create_dir_all(&directory).context("create systemd user unit directory")?;
    let path = directory.join(SERVICE);
    let existing = path.exists();
    let unit = format!(
        "[Unit]\nDescription=ADM lifecycle connection\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=notify\nNotifyAccess=all\nEnvironment={service_environment}\nExecStart={arguments}\nRestart=on-failure\nRestartSec=3s\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n"
    );
    let temporary = directory.join(format!(".{SERVICE}.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, unit).context("write lifecycle connection unit")?;
    fs::rename(&temporary, &path).context("install lifecycle connection unit")?;
    service_command(&systemctl, &["daemon-reload"])?;
    service_command(&systemctl, &["enable", "--now", SERVICE])?;
    if existing {
        service_command(&systemctl, &["restart", SERVICE])?;
    }
    Ok(())
}

struct ForwardProcess(Child);

impl Drop for ForwardProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn serve(cli: &Cli) -> Result<()> {
    let port = local_port(cli)?;
    let notify = executable_path("systemd-notify")?;
    let mut command = cli.kubectl_command()?;
    let mut forwarding = ForwardProcess(
        command
            .args([
                "-n",
                &cli.lifecycle_namespace,
                "port-forward",
                "service/adm-lifecycle",
                &format!("{port}:7433"),
                "--address",
                "127.0.0.1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("start lifecycle port-forward")?,
    );
    let output = forwarding
        .0
        .stdout
        .take()
        .context("capture kubectl stdout")?;
    let readiness = format!("Forwarding from 127.0.0.1:{port} -> 7433");
    let mut ready = false;
    for line in BufReader::new(output).lines() {
        let line = line.context("read lifecycle port-forward output")?;
        println!("{line}");
        if !ready && line == readiness {
            let status = Command::new(&notify)
                .arg("--ready")
                .stdin(Stdio::null())
                .status()
                .context("notify systemd that lifecycle forwarding is ready")?;
            ensure!(
                status.success(),
                "systemd-notify --ready failed with {status}"
            );
            ready = true;
        }
    }
    let status = forwarding
        .0
        .wait()
        .context("wait for lifecycle port-forward")?;
    if !ready {
        bail!("lifecycle port-forward exited before readiness with {status}");
    }
    bail!("lifecycle port-forward exited with {status}")
}
