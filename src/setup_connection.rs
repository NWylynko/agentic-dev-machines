use crate::Cli;
use anyhow::{Context, Result, bail};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader},
    process::{Child, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
    time::Duration,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Connection {
    pub url: String,
    _forward: ForwardProcess,
}

struct ForwardProcess {
    child: Child,
    readers: Vec<JoinHandle<()>>,
    diagnostics: Arc<Mutex<VecDeque<String>>>,
}

impl Drop for ForwardProcess {
    fn drop(&mut self) {
        self.stop_and_drain();
    }
}

impl ForwardProcess {
    fn stop_and_drain(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }

    fn error_output(&self) -> String {
        let lines = self.diagnostics.lock().expect("diagnostic lock");
        if lines.is_empty() {
            "kubectl reported no additional details".into()
        } else {
            lines.iter().cloned().collect::<Vec<_>>().join("\n")
        }
    }
}

pub fn preflight(cli: &Cli) -> Result<()> {
    cli.kubeconfig_reference()?;
    Ok(())
}

fn ready_port(line: &str) -> Option<u16> {
    let value = line.strip_prefix("Forwarding from 127.0.0.1:")?;
    let (port, target) = value.split_once(" -> ")?;
    if target != "7433" {
        return None;
    }
    port.parse().ok().filter(|port| *port != 0)
}

pub fn connect(cli: &Cli) -> Result<Connection> {
    let mut child = cli
        .kubectl_command()?
        .args([
            "-n",
            &cli.lifecycle_namespace,
            "port-forward",
            "service/adm-lifecycle",
            ":7433",
            "--address",
            "127.0.0.1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("start command-scoped lifecycle port-forward")?;
    let stdout = child.stdout.take().context("capture kubectl stdout")?;
    let stderr = child.stderr.take().context("capture kubectl stderr")?;
    let diagnostics = Arc::new(Mutex::new(VecDeque::new()));
    let (ready_sender, ready_receiver) = mpsc::channel();
    let stdout_sender = ready_sender.clone();
    let stdout_reader = thread::spawn(move || {
        let mut announced = false;
        for result in BufReader::new(stdout).lines() {
            match result {
                Ok(line) => {
                    if !announced && let Some(port) = ready_port(&line) {
                        announced = true;
                        let _ = stdout_sender.send(Ok(port));
                    }
                }
                Err(error) => {
                    if !announced {
                        let _ = stdout_sender.send(Err(format!("read kubectl stdout: {error}")));
                    }
                    return;
                }
            }
        }
        if !announced {
            let _ = stdout_sender.send(Err("kubectl stdout closed before readiness".into()));
        }
    });
    let stderr_diagnostics = diagnostics.clone();
    let stderr_reader = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut lines = stderr_diagnostics.lock().expect("diagnostic lock");
            if lines.len() == 32 {
                lines.pop_front();
            }
            lines.push_back(line);
        }
    });
    let mut forward = ForwardProcess {
        child,
        readers: vec![stdout_reader, stderr_reader],
        diagnostics,
    };
    let port = match ready_receiver.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(port)) => port,
        Ok(Err(cause)) => {
            let status = forward
                .child
                .try_wait()
                .context("check kubectl port-forward")?;
            forward.stop_and_drain();
            bail!(
                "kubectl port-forward failed before readiness{}: {cause}; {}",
                status
                    .map(|status| format!(" with {status}"))
                    .unwrap_or_default(),
                forward.error_output()
            )
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            forward.stop_and_drain();
            bail!(
                "kubectl port-forward did not become ready within {} seconds; {}",
                STARTUP_TIMEOUT.as_secs(),
                forward.error_output()
            )
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            forward.stop_and_drain();
            bail!(
                "kubectl port-forward readiness channel closed; {}",
                forward.error_output()
            )
        }
    };
    Ok(Connection {
        url: format!("http://127.0.0.1:{port}"),
        _forward: forward,
    })
}

pub fn serve(cli: &Cli) -> Result<()> {
    let mut connection = connect(cli)?;
    println!("Lifecycle forwarding is ready at {}", connection.url);
    let status = connection
        ._forward
        .child
        .wait()
        .context("wait for kubectl port-forward")?;
    bail!("kubectl port-forward exited with {status}")
}
