use crate::{Cli, print_json, workspaces};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::process::Command;

pub fn doctor(cli: &Cli, storage_class: &str, json_output: bool) -> Result<()> {
    let tools = ["node", "git", "gh"].map(|name| {
        (
            name,
            Command::new(name)
                .arg("--version")
                .output()
                .is_ok_and(|output| output.status.success()),
        )
    });
    let cluster = inspect_nodes(cli);
    let (nodes, cluster_error) = match cluster {
        Ok(nodes) => (nodes, None),
        Err(error) => (json!(null), Some(format!("{error:#}"))),
    };
    let storage = match inspect_storage(cli, storage_class) {
        Ok(storage) => storage,
        Err(error) => json!({
            "name": storage_class,
            "status": "unavailable",
            "error": format!("{error:#}"),
            "action": "Configure a replicated StorageClass as described in deploy/storage.md, or inspect an existing class with adm doctor --storage-class NAME.",
        }),
    };
    let connection = if cli.lifecycle_forward {
        "command-scoped-port-forward"
    } else {
        "explicit-url"
    };
    // A failed command-scoped port-forward is reported here rather than
    // ending the command, so the rest of the report still prints.
    let health = match &cli.lifecycle_connect_error {
        Some(error) => Err((error.clone(), true)),
        None => cli
            .request_lifecycle("GET", "/health", None)
            .map_err(|error| {
                let unreachable = is_lifecycle_transport_error(&error);
                (format!("{error:#}"), unreachable)
            }),
    };
    let lifecycle_reachable = cli.lifecycle_connect_error.is_none();
    let lifecycle = match health {
        Ok(mut health) => {
            health["url"] = json!(cli.lifecycle_url);
            health["connection"] = json!(connection);
            health
        }
        Err((error, unreachable)) => {
            let diagnosis = unreachable.then(|| diagnose_unreachable_lifecycle(cli));
            json!({
                "status":"unavailable",
                "url":lifecycle_reachable.then_some(&cli.lifecycle_url),
                "connection":connection,
                "error":error,
                "reason":diagnosis.as_ref().map(|diagnosis| &diagnosis.reason),
                "action":diagnosis
                    .and_then(|diagnosis| diagnosis.action)
                    .unwrap_or_else(|| crate::lifecycle::setup_guidance(cli)),
            })
        }
    };
    let providers = match if lifecycle_reachable {
        provider_logins(cli)
    } else {
        Err(anyhow::anyhow!("the lifecycle service is unreachable"))
    } {
        Ok(providers) => json!(providers),
        Err(error) => json!({
            "status": "unavailable",
            "error": format!("{error:#}"),
        }),
    };
    let report = json!({"tools":tools,"cluster":nodes,"clusterError":cluster_error,"storage":storage,"lifecycle":lifecycle,"providers":providers,"state":cli.state_path()});
    if json_output {
        print_json(&report)
    } else {
        print_doctor_report(&report);
        Ok(())
    }
}

fn print_doctor_report(report: &Value) {
    println!("Tools:");
    for tool in report["tools"].as_array().into_iter().flatten() {
        let name = tool[0].as_str().unwrap_or("unknown");
        let status = if tool[1].as_bool() == Some(true) {
            "available"
        } else {
            "unavailable"
        };
        println!("  {name}: {status}");
    }

    println!("Cluster:");
    if let Some(error) = report["clusterError"].as_str() {
        println!("  unavailable: {error}");
        println!("  Next: Check kubectl access and the selected Kubernetes context.");
    } else {
        for node in report["cluster"].as_array().into_iter().flatten() {
            println!(
                "  {}: {}",
                node["name"].as_str().unwrap_or("unknown"),
                if node["ready"] == true {
                    "ready"
                } else {
                    "not ready"
                }
            );
        }
    }

    println!("Storage:");
    let storage = &report["storage"];
    println!(
        "  {}: {}",
        storage["name"].as_str().unwrap_or("unknown"),
        storage["status"].as_str().unwrap_or("unknown")
    );
    for key in ["error", "warning", "note"] {
        if let Some(message) = storage[key].as_str() {
            println!(
                "  {}: {message}",
                if key == "error" {
                    "Error"
                } else if key == "warning" {
                    "Warning"
                } else {
                    "Note"
                }
            );
        }
    }
    if let Some(action) = storage["action"].as_str() {
        println!("  Next: {action}");
    }

    println!("Lifecycle service:");
    println!(
        "  {}",
        report["lifecycle"]["status"].as_str().unwrap_or("unknown")
    );
    if let Some(error) = report["lifecycle"]["error"].as_str() {
        println!("  Error: {error}");
    }
    if let Some(reason) = report["lifecycle"]["reason"].as_str() {
        println!("  Why: {reason}");
    }
    if let Some(action) = report["lifecycle"]["action"].as_str() {
        println!("  Next: {action}");
    }
    println!("Providers:");
    if let Some(providers) = report["providers"].as_array() {
        let lines = provider_login_lines(providers);
        if lines.is_empty() {
            println!("  no shared provider logins");
        }
        for line in lines {
            println!("  {line}");
        }
    } else if let Some(error) = report["providers"]["error"].as_str() {
        println!("  unavailable: {error}");
    } else {
        println!("  unavailable");
    }
    println!("State: {}", report["state"].as_str().unwrap_or("unknown"));
}

pub fn provider_logins(cli: &Cli) -> Result<Vec<Value>> {
    let value = cli.request_lifecycle("GET", "/v1/provider-auth/providers", None)?;
    serde_json::from_value(value).context("provider login health")
}

pub fn provider_login_lines(providers: &[Value]) -> Vec<String> {
    let mut lines = Vec::new();
    for provider in providers {
        let id = provider["provider"].as_str().unwrap_or("unknown");
        match provider["status"].as_str() {
            Some("login_expired") => {
                lines.push(format!("{id}: login expired"));
                lines.push(format!("Next: run adm login {id}"));
            }
            Some("authenticated") => lines.push(format!("{id}: authenticated")),
            _ => {}
        }
    }
    lines
}

/// Expired logins only, so `adm list` stays quiet when provider-auth is down.
pub fn print_expired_provider_logins(cli: &Cli) {
    let Ok(providers) = provider_logins(cli) else {
        return;
    };
    for line in provider_login_lines(&providers) {
        if line.contains("login expired") || line.contains("adm login ") {
            println!("{line}");
        }
    }
}

/// Why the lifecycle cannot be reached, read through the client kubeconfig
/// (TASK-91), with the operator's next step when the cause is known.
pub struct LifecycleUnreachable {
    pub reason: String,
    pub action: Option<String>,
}

/// Transport failures only: an HTTP error status means the lifecycle answered.
pub fn is_lifecycle_transport_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<reqwest::Error>().is_some())
}

/// Adds the diagnosed cause to an unreachable-lifecycle error.
pub fn explain_unreachable_lifecycle(cli: &Cli, error: anyhow::Error) -> anyhow::Error {
    let diagnosis = diagnose_unreachable_lifecycle(cli);
    match diagnosis.action {
        Some(action) => error.context(format!(
            "lifecycle unreachable: {}. Next: {action}",
            diagnosis.reason
        )),
        None => error.context(format!("lifecycle unreachable: {}", diagnosis.reason)),
    }
}

pub fn diagnose_unreachable_lifecycle(cli: &Cli) -> LifecycleUnreachable {
    let namespace = &cli.lifecycle_namespace;
    let pods = workspaces::kubectl(
        cli,
        &[
            "-n",
            namespace,
            "get",
            "pods",
            "-l",
            "app.kubernetes.io/name=adm-lifecycle",
            "-o",
            "json",
            "--request-timeout=10s",
        ],
        None,
    )
    .and_then(|output| {
        serde_json::from_slice::<Value>(&output).context("kubectl returned invalid Pod JSON")
    });
    let pods = match pods {
        Ok(pods) => pods["items"].as_array().cloned().unwrap_or_default(),
        Err(error) => {
            return LifecycleUnreachable {
                reason: format!(
                    "the lifecycle Pod could not be inspected through the kubeconfig: {error:#}"
                ),
                action: None,
            };
        }
    };
    if pods.is_empty() {
        return LifecycleUnreachable {
            reason: format!("no lifecycle Pod exists in namespace {namespace}"),
            action: None,
        };
    }
    // Node name -> (Ready status, lastTransitionTime). Missing when nodes
    // cannot be listed; Pods are then described from their own status.
    let nodes = workspaces::kubectl(
        cli,
        &["get", "nodes", "-o", "json", "--request-timeout=10s"],
        None,
    )
    .ok()
    .and_then(|output| serde_json::from_slice::<Value>(&output).ok())
    .map(|nodes| {
        nodes["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|node| {
                let ready = node["status"]["conditions"]
                    .as_array()?
                    .iter()
                    .find(|condition| condition["type"] == "Ready")?;
                Some((
                    node["metadata"]["name"].as_str()?.to_owned(),
                    (
                        ready["status"].as_str().unwrap_or("Unknown").to_owned(),
                        ready["lastTransitionTime"]
                            .as_str()
                            .unwrap_or("an unknown time")
                            .to_owned(),
                    ),
                ))
            })
            .collect::<std::collections::HashMap<_, _>>()
    });
    let mut reasons = Vec::new();
    let mut actions = Vec::new();
    for pod in &pods {
        let name = pod["metadata"]["name"].as_str().unwrap_or("unknown");
        let node = pod["spec"]["nodeName"].as_str();
        if let Some(node) = node
            && let Some((status, since)) = nodes.as_ref().and_then(|nodes| nodes.get(node))
            && status != "True"
        {
            reasons.push(format!(
                "lifecycle Pod {name} is on NotReady node {node} since {since}"
            ));
            actions.push(format!(
                "bring node {node} back to Ready. ADM does not move the lifecycle off a NotReady node automatically yet, so it stays unreachable until then. Workspaces on other nodes keep running turns for up to 5 min after the lifecycle became unreachable; new input waits for it"
            ));
            continue;
        }
        if pod["metadata"]["deletionTimestamp"].is_string() {
            reasons.push(format!(
                "lifecycle Pod {name} is terminating since {}",
                pod["metadata"]["deletionTimestamp"].as_str().unwrap_or("")
            ));
            continue;
        }
        let Some(node) = node else {
            let scheduling = pod["status"]["conditions"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|condition| condition["type"] == "PodScheduled")
                .and_then(|condition| condition["message"].as_str())
                .unwrap_or("no scheduling message");
            reasons.push(format!(
                "lifecycle Pod {name} is not scheduled on any node: {scheduling}"
            ));
            continue;
        };
        let ready = pod["status"]["conditions"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|condition| condition["type"] == "Ready" && condition["status"] == "True");
        if ready {
            reasons.push(format!(
                "lifecycle Pod {name} is Ready on node {node}, so the failure is in the connection from this client to it"
            ));
            continue;
        }
        let containers = ["initContainerStatuses", "containerStatuses"]
            .iter()
            .flat_map(|key| pod["status"][*key].as_array().cloned().unwrap_or_default())
            .filter(|container| container["ready"] != true)
            .map(|container| {
                let state = container["state"]
                    .as_object()
                    .and_then(|state| state.values().next())
                    .cloned()
                    .unwrap_or_default();
                let detail = [state["reason"].as_str(), state["message"].as_str()]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(": ");
                format!(
                    "container {} {}",
                    container["name"].as_str().unwrap_or("unknown"),
                    if detail.is_empty() {
                        "is not ready"
                    } else {
                        &detail
                    }
                )
            })
            .collect::<Vec<_>>();
        reasons.push(format!(
            "lifecycle Pod {name} on node {node} is not ready: {}",
            if containers.is_empty() {
                format!(
                    "phase {}",
                    pod["status"]["phase"].as_str().unwrap_or("unknown")
                )
            } else {
                containers.join("; ")
            }
        ));
        actions.push(format!(
            "read its logs with `adm system-log`, or run `kubectl -n {namespace} describe pod {name}`"
        ));
    }
    LifecycleUnreachable {
        reason: reasons.join("; "),
        action: (!actions.is_empty()).then(|| actions.join("; ")),
    }
}

fn inspect_nodes(cli: &Cli) -> Result<Value> {
    let output = workspaces::kubectl(cli, &["get", "nodes", "-o", "json"], None)?;
    let cluster: Value =
        serde_json::from_slice(&output).context("kubectl returned invalid node JSON")?;
    let nodes = cluster["items"]
        .as_array()
        .context("kubectl node response has no items array")?;
    Ok(json!(nodes.iter().map(|node| json!({
        "name":node["metadata"]["name"],
        "ready":node["status"]["conditions"].as_array().is_some_and(|conditions| conditions.iter().any(|condition| condition["type"]=="Ready" && condition["status"]=="True")),
    })).collect::<Vec<_>>()))
}

fn inspect_storage(cli: &Cli, storage_class: &str) -> Result<Value> {
    let output = workspaces::kubectl(
        cli,
        &["get", "storageclass", storage_class, "-o", "json"],
        None,
    )?;
    let storage: Value =
        serde_json::from_slice(&output).context("kubectl returned invalid StorageClass JSON")?;
    let provisioner = storage["provisioner"]
        .as_str()
        .context("StorageClass has no provisioner")?;
    if provisioner == "rancher.io/local-path" {
        Ok(
            json!({"name":storage_class,"status":"node-local","provisioner":provisioner,"warning":"This class cannot recover a volume on another node. Creating a workspace requires --allow-node-local-storage."}),
        )
    } else {
        Ok(
            json!({"name":storage_class,"status":"available","provisioner":provisioner,"note":"Availability does not prove replication or a node-failure loss window; validate the provisioner's guarantees."}),
        )
    }
}
