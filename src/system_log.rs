//! `adm system-log` (TASK-109): the logs of the cluster-owned ADM services,
//! read with the client's kubeconfig, merged in time order and prefixed with
//! their service. Add new cluster services (e.g. TASK-91's failover) to
//! `ADM_SYSTEM_LOG_SERVICES`.
use crate::Cli;
use anyhow::{Context, Result, bail};
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;

/// Service name, workload and container of every cluster-owned ADM service.
const ADM_SYSTEM_LOG_SERVICES: &[(&str, &str, &str)] = &[
    ("lifecycle", "deployment/adm-lifecycle", "lifecycle"),
    ("provider-auth", "deployment/adm-lifecycle", "provider-auth"),
];

pub fn run(cli: &Cli, service: Option<&str>, since: &str, follow: bool) -> Result<()> {
    let services = match service {
        None => ADM_SYSTEM_LOG_SERVICES.to_vec(),
        Some(name) => vec![
            *ADM_SYSTEM_LOG_SERVICES
                .iter()
                .find(|(known, _, _)| *known == name)
                .with_context(|| {
                    format!(
                        "unknown service {name}; known services: {}",
                        ADM_SYSTEM_LOG_SERVICES
                            .iter()
                            .map(|(known, _, _)| *known)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })?,
        ],
    };
    let width = services
        .iter()
        .map(|(name, _, _)| name.len())
        .max()
        .unwrap_or(0);
    let (lines, received) = mpsc::channel::<(&'static str, String)>();
    let mut readers = Vec::new();
    for (name, workload, container) in services {
        let mut command = cli.kubectl_command()?;
        command.args([
            "logs",
            "-n",
            &cli.lifecycle_namespace,
            workload,
            "-c",
            container,
            "--timestamps",
            &format!("--since={since}"),
        ]);
        if follow {
            command.arg("--follow");
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("run {} logs for {name}", cli.kubectl))?;
        let stdout = child.stdout.take().expect("piped kubectl stdout");
        let lines = lines.clone();
        readers.push(thread::spawn(move || -> Result<()> {
            for line in BufReader::new(stdout).lines() {
                let line = line.with_context(|| format!("read {name} logs"))?;
                if lines.send((name, line)).is_err() {
                    break;
                }
            }
            let status = child.wait()?;
            anyhow::ensure!(
                status.success(),
                "kubectl logs for {name} failed ({status})"
            );
            Ok(())
        }));
    }
    drop(lines);
    let mut stdout = std::io::stdout().lock();
    if follow {
        // A live stream can only be merged in arrival order.
        for (name, line) in received {
            writeln!(stdout, "{name:<width$} {line}")?;
            stdout.flush()?;
        }
    } else {
        let mut all = received.into_iter().collect::<Vec<_>>();
        all.sort_by_cached_key(|(_, line)| system_log_time_key(line));
        for (name, line) in all {
            writeln!(stdout, "{name:<width$} {line}")?;
        }
    }
    let failures = readers
        .into_iter()
        .filter_map(|reader| match reader.join() {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(format!("{error:#}")),
            Err(_) => Some("log reader panicked".to_owned()),
        })
        .collect::<Vec<_>>();
    if !failures.is_empty() {
        bail!("{}", failures.join("; "));
    }
    Ok(())
}

/// Sort key for a `kubectl logs --timestamps` line. kubectl prints RFC 3339
/// in UTC with trailing fraction zeros trimmed (`…:01Z`, `…:01.25Z`), so the
/// fraction is padded to nanoseconds before comparing.
fn system_log_time_key(line: &str) -> (String, String) {
    let timestamp = line.split_whitespace().next().unwrap_or("");
    let seconds_end = timestamp.find(['.', 'Z', '+']).unwrap_or(timestamp.len());
    let fraction = timestamp[seconds_end..]
        .strip_prefix('.')
        .map(|rest| {
            rest.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .unwrap_or_default();
    (
        timestamp[..seconds_end].to_owned(),
        format!("{fraction:0<9}"),
    )
}
