use crate::Cli;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    process::{Command, Stdio},
    time::Duration,
};

pub fn request(url: &str, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()?;
    let method = reqwest::Method::from_bytes(method.as_bytes())?;
    let mut request = client.request(method, format!("{}{path}", url.trim_end_matches('/')));
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .context("durable runner unavailable; start it with adm start")?;
    let status = response.status();
    let text = response.text()?;
    let value: Value = if text.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text).context("runner returned invalid JSON")?
    };
    ensure!(
        status.is_success(),
        "runner {status}: {}",
        value["error"]["message"].as_str().unwrap_or(&text)
    );
    Ok(value)
}

fn command(cli: &Cli) -> Result<Command> {
    let url = reqwest::Url::parse(&cli.runner_url)?;
    let host = url.host_str().context("runner URL needs a host")?;
    ensure!(
        host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1",
        "runner must listen on loopback"
    );
    let port = url.port().unwrap_or(7432);
    let mut command = Command::new("node");
    command
        .current_dir(&cli.project_dir)
        .args(["--import", "tsx"])
        .arg(cli.checkout_file("packages/runner/src/main.ts")?)
        .args(["--host", host, "--port", &port.to_string(), "--state-dir"])
        .arg(cli.state_path().join("runner"));
    Ok(command)
}

pub fn serve(cli: &Cli) -> Result<()> {
    let status = command(cli)?.status().context("start Pi Durable runner")?;
    ensure!(status.success(), "runner exited with {status}");
    Ok(())
}

pub fn ensure_started(cli: &Cli) -> Result<()> {
    if let Ok(health) = request(&cli.runner_url, "GET", "/health", None) {
        ensure!(
            health["status"] == "ok",
            "unrecognized service at runner URL"
        );
        return Ok(());
    }
    fs::create_dir_all(cli.state_path())?;
    let log = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(cli.state_path().join("runner.log"))?;
    let mut command = command(cli)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(log.try_clone()?);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn().context("launch durable runner daemon")?;
    let pid = child.id();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    // Read the server's readiness event; no polling sleeps or race-prone fixed delay.
    loop {
        let count = stdout.read_line(&mut line)?;
        if count == 0 {
            let status = child.wait()?;
            bail!(
                "runner exited before readiness ({status}); inspect {}",
                cli.state_path().join("runner.log").display()
            );
        }
        if let Ok(event) = serde_json::from_str::<Value>(line.trim())
            && event["ready"] == true
        {
            break;
        }
        line.clear();
    }
    fs::write(cli.state_path().join("runner.pid"), pid.to_string())?;
    std::thread::spawn(move || {
        let mut log = log;
        let _ = std::io::copy(&mut stdout, &mut log);
        let _ = child.wait();
    });
    ensure!(
        request(&cli.runner_url, "GET", "/health", None)?["status"] == "ok",
        "runner failed readiness"
    );
    Ok(())
}

pub fn stop(cli: &Cli) -> Result<()> {
    let pid_path = cli.state_path().join("runner.pid");
    let pid: i32 = fs::read_to_string(&pid_path)
        .context("runner PID not recorded")?
        .trim()
        .parse()?;
    let mut command_line = Vec::new();
    fs::File::open(format!("/proc/{pid}/cmdline"))?.read_to_end(&mut command_line)?;
    ensure!(
        String::from_utf8_lossy(&command_line).contains("packages/runner/src/main.ts"),
        "refusing to stop unrelated PID {pid}"
    );
    ensure!(
        unsafe { libc::kill(pid, libc::SIGTERM) } == 0,
        "could not stop runner PID {pid}"
    );
    crate::print_json(&json!({"status":"stopping","pid":pid}))
}
