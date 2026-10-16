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
    let runner = match cli.request("GET", "/health", None) {
        Ok(health) => health,
        Err(error) => json!({"status":"unavailable", "error":format!("{error:#}")}),
    };
    let report = json!({"tools":tools,"cluster":nodes,"clusterError":cluster_error,"storage":storage,"runner":runner,"state":cli.state_path()});
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

    println!("Runner:");
    println!(
        "  {}",
        report["runner"]["status"].as_str().unwrap_or("unknown")
    );
    if let Some(error) = report["runner"]["error"].as_str() {
        println!("  Error: {error}");
        println!("  Next: Check the runner process and its logs.");
    }
    println!("State: {}", report["state"].as_str().unwrap_or("unknown"));
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
