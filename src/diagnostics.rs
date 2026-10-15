use crate::{Cli, print_json, workspaces};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::process::Command;

pub fn doctor(cli: &Cli, storage_class: &str) -> Result<()> {
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
    print_json(
        &json!({"tools":tools,"cluster":nodes,"clusterError":cluster_error,"storage":storage,"runner":runner,"state":cli.state_path()}),
    )
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
