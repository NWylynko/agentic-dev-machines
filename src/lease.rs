use crate::Cli;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const NAME: &str = "adm-lifecycle-owner";
const DURATION_SECONDS: u64 = 15;

#[derive(Clone)]
pub struct LeaseFence {
    holder: String,
    epoch: u64,
    owned: Arc<AtomicBool>,
}

impl LeaseFence {
    pub fn is_owned(&self) -> bool {
        self.owned.load(Ordering::Acquire)
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn run(cli: &Cli, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut command = cli.kubectl_command()?;
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command
        .spawn()
        .context("start kubectl for lifecycle Lease")?;
    if let Some(input) = input {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(input)?;
    }
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "kubectl {}: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(output.stdout)
}

fn get(cli: &Cli) -> Result<Value> {
    Ok(serde_json::from_slice(&run(
        cli,
        &[
            "get",
            "lease",
            NAME,
            "-n",
            &cli.lifecycle_namespace,
            "-o",
            "json",
        ],
        None,
    )?)?)
}

fn get_bounded(cli: &Cli) -> Result<Value> {
    let mut args = vec![
        "get",
        "lease",
        NAME,
        "-n",
        &cli.lifecycle_namespace,
        "-o",
        "json",
    ];
    args.push("--request-timeout=1s");
    Ok(serde_json::from_slice(&run(cli, &args, None)?)?)
}

fn timestamp() -> String {
    let seconds = unix_now() as libc::time_t;
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    unsafe { libc::gmtime_r(&seconds, &mut tm) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

fn lease_document(namespace: &str, holder: &str, epoch: u64) -> Value {
    json!({
        "apiVersion":"coordination.k8s.io/v1","kind":"Lease",
        "metadata":{"name":NAME,"namespace":namespace,"annotations":{"adm.dev/fencing-token":epoch.to_string(),"adm.dev/renew-unix":unix_now().to_string()}},
        "spec":{"holderIdentity":holder,"leaseDurationSeconds":DURATION_SECONDS,"acquireTime":timestamp(),"renewTime":timestamp(),"leaseTransitions":epoch.saturating_sub(1)}
    })
}

fn replace(cli: &Cli, mut lease: Value, holder: &str, epoch: u64) -> Result<()> {
    lease["spec"]["holderIdentity"] = holder.into();
    lease["spec"]["leaseDurationSeconds"] = DURATION_SECONDS.into();
    lease["spec"]["renewTime"] = timestamp().into();
    lease["metadata"]["annotations"]["adm.dev/fencing-token"] = epoch.to_string().into();
    lease["metadata"]["annotations"]["adm.dev/renew-unix"] = unix_now().to_string().into();
    run(
        cli,
        &["replace", "-f", "-"],
        Some(&serde_json::to_vec(&lease)?),
    )?;
    Ok(())
}

fn lease_is_fresh(lease: &Value) -> bool {
    let renewed = lease["metadata"]["annotations"]["adm.dev/renew-unix"]
        .as_str()
        .unwrap_or("0")
        .parse::<u64>()
        .unwrap_or(0);
    let duration = lease["spec"]["leaseDurationSeconds"]
        .as_u64()
        .unwrap_or(DURATION_SECONDS);
    renewed.saturating_add(duration) > unix_now()
}

pub fn acquire(cli: &Cli) -> Result<LeaseFence> {
    let holder = uuid::Uuid::new_v4().to_string();
    let current = get(cli);
    let epoch = match current {
        Ok(mut lease) => {
            let prior_holder = lease["spec"]["holderIdentity"].as_str().unwrap_or("");
            let prior_epoch = lease["metadata"]["annotations"]["adm.dev/fencing-token"]
                .as_str()
                .unwrap_or("0")
                .parse::<u64>()
                .unwrap_or(0);
            ensure!(
                prior_holder.is_empty() || !lease_is_fresh(&lease),
                "lifecycle Lease is held by another active owner"
            );
            let epoch = prior_epoch.saturating_add(1);
            replace(cli, lease.take(), &holder, epoch)?;
            epoch
        }
        Err(error) if format!("{error:#}").contains("NotFound") => {
            let document = lease_document(&cli.lifecycle_namespace, &holder, 1);
            run(
                cli,
                &["create", "-f", "-"],
                Some(&serde_json::to_vec(&document)?),
            )?;
            1
        }
        Err(error) => return Err(error).context("read lifecycle Lease"),
    };
    let fence = LeaseFence {
        holder: holder.clone(),
        epoch,
        owned: Arc::new(AtomicBool::new(true)),
    };
    let renew_cli = cli.clone_for_lifecycle();
    let renew_fence = fence.clone();
    thread::spawn(move || {
        while renew_fence.is_owned() {
            thread::sleep(Duration::from_secs(DURATION_SECONDS / 3));
            if !renew_fence.is_owned() {
                break;
            }
            let result = get(&renew_cli).and_then(|lease| {
                ensure!(
                    lease["spec"]["holderIdentity"] == renew_fence.holder
                        && lease["metadata"]["annotations"]["adm.dev/fencing-token"]
                            .as_str()
                            .and_then(|token| token.parse::<u64>().ok())
                            == Some(renew_fence.epoch)
                        && lease_is_fresh(&lease),
                    "lifecycle Lease fencing token changed"
                );
                replace(&renew_cli, lease, &renew_fence.holder, renew_fence.epoch)
            });
            if let Err(error) = result {
                eprintln!("adm lifecycle lost Kubernetes Lease ownership: {error:#}");
                renew_fence.owned.store(false, Ordering::Release);
                break;
            }
        }
    });
    Ok(fence)
}

pub fn verify(cli: &Cli, fence: &LeaseFence) -> Result<()> {
    verify_with(cli, fence, get)
}

pub fn verify_bounded(cli: &Cli, fence: &LeaseFence) -> Result<()> {
    verify_with(cli, fence, get_bounded)
}

fn verify_with(
    cli: &Cli,
    fence: &LeaseFence,
    read_lease: impl FnOnce(&Cli) -> Result<Value>,
) -> Result<()> {
    ensure!(
        fence.is_owned(),
        "lifecycle service lost its Kubernetes Lease"
    );
    let result = read_lease(cli).and_then(|lease| {
        ensure!(
            lease["spec"]["holderIdentity"] == fence.holder
                && lease["metadata"]["annotations"]["adm.dev/fencing-token"]
                    .as_str()
                    .and_then(|token| token.parse::<u64>().ok())
                    == Some(fence.epoch)
                && lease_is_fresh(&lease),
            "lifecycle service lost or expired its Kubernetes Lease fencing token"
        );
        Ok(())
    });
    if let Err(error) = result {
        if fence.owned.swap(false, Ordering::AcqRel) {
            eprintln!("adm lifecycle lost Kubernetes Lease ownership: {error:#}");
        }
        return Err(error);
    }
    Ok(())
}
