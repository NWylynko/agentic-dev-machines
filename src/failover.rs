//! `adm failover-serve`: the node failover sweep (TASK-82, TASK-91), run by the
//! stateless `adm-failover` Deployment in the lifecycle namespace. It is not in
//! the lifecycle because recovery must not depend on the thing being recovered:
//! two replicas on different nodes, no PVC and no lock. Every action is
//! idempotent (`--ignore-not-found`), so both replicas sweeping at once converge.

use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    thread,
    time::Duration,
};

/// A node that has not been Ready for this long has its ADM Pods moved: Nick's
/// TASK-82 decision accepts losing an in-flight turn for that.
const NODE_DOWN_MOVE_SECONDS: u64 = 180;
/// How often each replica looks for ADM Pods stranded on down nodes.
const FAILOVER_SWEEP_INTERVAL: Duration = Duration::from_secs(10);

pub fn serve_failover(cli: &crate::Cli, once: bool) -> Result<()> {
    if once {
        return sweep_down_nodes(cli);
    }
    eprintln!(
        "adm failover: sweeping every {}s for nodes NotReady for {NODE_DOWN_MOVE_SECONDS}s",
        FAILOVER_SWEEP_INTERVAL.as_secs()
    );
    loop {
        if let Err(error) = sweep_down_nodes(cli) {
            eprintln!("adm failover: sweep failed: {error:#}");
        }
        thread::sleep(FAILOVER_SWEEP_INTERVAL);
    }
}

fn kubectl_json(cli: &crate::Cli, args: &[&str]) -> Result<Value> {
    serde_json::from_slice(&crate::workspaces::kubectl(cli, args, None)?)
        .with_context(|| format!("decode kubectl {}", args.join(" ")))
}

fn items(list: &Value) -> impl Iterator<Item = &Value> {
    list["items"].as_array().into_iter().flatten()
}

/// Kubernetes leaves a Pod on an unreachable node Terminating until the node
/// returns, so its Recreate Deployment never starts a replacement, and the
/// Pod's RWO volume stays attached to the dead node. Force deleting the Pod
/// lets the Deployment schedule it on a healthy node; deleting the dead node's
/// VolumeAttachment lets the CSI driver attach the volume there. The runtime
/// lease (revoked by the lifecycle once the old Pod is gone) keeps a returning
/// old runtime from owning the workspace again.
fn sweep_down_nodes(cli: &crate::Cli) -> Result<()> {
    let now = crate::workspaces::now();
    let nodes = kubectl_json(cli, &["get", "nodes", "-o", "json"])?;
    let down_seconds: HashMap<String, u64> = items(&nodes)
        .filter_map(|node| {
            let ready = node["status"]["conditions"]
                .as_array()?
                .iter()
                .find(|condition| condition["type"] == "Ready")?;
            let since = kubernetes_time_unix(ready["lastTransitionTime"].as_str()?)?;
            let down = now.saturating_sub(since);
            (ready["status"] != "True" && down >= NODE_DOWN_MOVE_SECONDS).then(|| {
                (
                    node["metadata"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    down,
                )
            })
        })
        .collect();
    if down_seconds.is_empty() {
        return Ok(());
    }
    for (node, seconds) in &down_seconds {
        eprintln!(
            "adm failover: node {node} NotReady for {seconds}s; moving its ADM Pods and volumes"
        );
    }
    let lifecycle_namespace = cli.lifecycle_namespace.as_str();
    let pods = kubectl_json(cli, &["get", "pods", "--all-namespaces", "-o", "json"])?;
    for pod in items(&pods) {
        let (Some(node), Some(namespace), Some(name)) = (
            pod["spec"]["nodeName"].as_str(),
            pod["metadata"]["namespace"].as_str(),
            pod["metadata"]["name"].as_str(),
        ) else {
            continue;
        };
        let Some(seconds) = down_seconds.get(node) else {
            continue;
        };
        let labels = &pod["metadata"]["labels"];
        let owner = if labels["app.kubernetes.io/managed-by"] == "adm" {
            match labels["adm.dev/workspace-id"].as_str() {
                Some(id) => format!("workspace {id}"),
                None => continue,
            }
        } else if namespace == lifecycle_namespace
            && labels["app.kubernetes.io/name"] == "adm-lifecycle"
        {
            "adm-lifecycle".to_owned()
        } else {
            continue;
        };
        eprintln!(
            "adm failover: node {node} NotReady for {seconds}s: force deleting Pod {namespace}/{name} of {owner}"
        );
        if let Err(error) = crate::workspaces::kubectl(
            cli,
            &[
                "delete",
                "pod",
                name,
                "-n",
                namespace,
                "--grace-period=0",
                "--force",
                "--wait=false",
                "--ignore-not-found",
            ],
            None,
        ) {
            eprintln!(
                "adm failover: node {node} NotReady for {seconds}s: force deleting Pod {namespace}/{name} of {owner} failed: {error:#}"
            );
        }
    }
    let attachments = kubectl_json(cli, &["get", "volumeattachments", "-o", "json"])?;
    let stranded: Vec<(&str, &str, &str)> = items(&attachments)
        .filter_map(|attachment| {
            let node = attachment["spec"]["nodeName"].as_str()?;
            down_seconds.contains_key(node).then_some((
                attachment["metadata"]["name"].as_str()?,
                attachment["spec"]["source"]["persistentVolumeName"].as_str()?,
                node,
            ))
        })
        .collect();
    if stranded.is_empty() {
        return Ok(());
    }
    // ADM volumes are those claimed from the lifecycle namespace or from a
    // workspace namespace (labelled managed-by=adm, naming its workspace ID).
    let namespaces = kubectl_json(
        cli,
        &[
            "get",
            "namespaces",
            "-l",
            "app.kubernetes.io/managed-by=adm",
            "-o",
            "json",
        ],
    )?;
    let mut owners: HashMap<&str, String> = items(&namespaces)
        .filter_map(|namespace| {
            Some((
                namespace["metadata"]["name"].as_str()?,
                format!(
                    "workspace {}",
                    namespace["metadata"]["labels"]["adm.dev/workspace-id"].as_str()?
                ),
            ))
        })
        .collect();
    owners.insert(lifecycle_namespace, "adm-lifecycle".to_owned());
    let volumes = kubectl_json(cli, &["get", "pv", "-o", "json"])?;
    let volume_owners: HashMap<&str, &String> = items(&volumes)
        .filter_map(|volume| {
            let owner = owners.get(volume["spec"]["claimRef"]["namespace"].as_str()?)?;
            Some((volume["metadata"]["name"].as_str()?, owner))
        })
        .collect();
    let mut seen = HashSet::new();
    for (name, volume, node) in stranded {
        let Some(owner) = volume_owners.get(volume) else {
            continue;
        };
        if !seen.insert(name) {
            continue;
        }
        let seconds = down_seconds[node];
        eprintln!(
            "adm failover: node {node} NotReady for {seconds}s: deleting VolumeAttachment {name} of PV {volume} ({owner})"
        );
        if let Err(error) = crate::workspaces::kubectl(
            cli,
            &[
                "delete",
                "volumeattachment",
                name,
                "--wait=false",
                "--ignore-not-found",
            ],
            None,
        ) {
            eprintln!(
                "adm failover: node {node} NotReady for {seconds}s: deleting VolumeAttachment {name} of PV {volume} ({owner}) failed: {error:#}"
            );
        }
    }
    Ok(())
}

/// Parses a Kubernetes `metav1.Time` (`2026-10-22T15:35:17Z`) as Unix seconds.
fn kubernetes_time_unix(value: &str) -> Option<u64> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let mut date = date.splitn(3, '-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (date.next()??, date.next()??, date.next()??);
    let mut time = time.splitn(3, ':').map(|part| part.parse::<u64>().ok());
    let (hour, minute, second) = (time.next()??, time.next()??, time.next()??);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Days-from-civil (Howard Hinnant).
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days)
        .ok()
        .map(|days| days * 86_400 + hour * 3600 + minute * 60 + second)
}
