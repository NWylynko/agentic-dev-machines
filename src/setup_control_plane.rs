use crate::{Cli, lifecycle, workspaces};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::fs;

pub fn install(cli: &Cli, image: &str, storage_class: &str) -> Result<()> {
    ensure!(
        cli.lifecycle_namespace == "adm-system",
        "automatic setup requires lifecycle namespace adm-system; select --lifecycle-namespace adm-system or install a custom control plane manually"
    );
    let explicit_token = cli
        .lifecycle_token_file
        .as_deref()
        .map(|path| {
            let token = fs::read_to_string(path).context("read lifecycle bearer token file")?;
            let token = token.trim().to_owned();
            ensure!(!token.is_empty(), "lifecycle bearer token file is empty");
            Ok(token)
        })
        .transpose()?;

    eprintln!("adm: setup: checking StorageClass {storage_class}");
    let storage: Value = serde_json::from_slice(&workspaces::kubectl(
        cli,
        &["get", "storageclass", storage_class, "-o", "json"],
        None,
    )?)
    .context("decode lifecycle StorageClass")?;
    let provisioner = storage["provisioner"]
        .as_str()
        .context("lifecycle StorageClass has no provisioner")?;
    ensure!(
        provisioner != "rancher.io/local-path",
        "automatic setup requires portable lifecycle storage; StorageClass {storage_class} uses node-local rancher.io/local-path"
    );

    let path = cli.project_dir.join("deploy/lifecycle/control-plane.yaml");
    let manifest_bytes = workspaces::kubectl(
        cli,
        &[
            "create",
            "--dry-run=client",
            "--validate=false",
            "-f",
            path.to_str()
                .context("lifecycle manifest path must be UTF-8")?,
            "-o",
            "json",
        ],
        None,
    )
    .context("load packaged lifecycle control-plane manifest")?;
    let mut resources = serde_json::Deserializer::from_slice(&manifest_bytes)
        .into_iter::<Value>()
        .collect::<serde_json::Result<Vec<_>>>()
        .context("decode lifecycle control-plane manifest")?;
    let namespace = resources
        .iter()
        .find(|resource| {
            resource["kind"] == "Namespace" && resource["metadata"]["name"] == "adm-system"
        })
        .context("lifecycle manifest has no adm-system Namespace")?
        .clone();
    let claim = resources
        .iter_mut()
        .find(|resource| {
            resource["kind"] == "PersistentVolumeClaim"
                && resource["metadata"]["name"] == "adm-lifecycle-state"
        })
        .context("lifecycle manifest has no adm-lifecycle-state PersistentVolumeClaim")?;
    claim["spec"]["storageClassName"] = json!(storage_class);
    let deployment = resources
        .iter_mut()
        .find(|resource| {
            resource["kind"] == "Deployment" && resource["metadata"]["name"] == "adm-lifecycle"
        })
        .context("lifecycle manifest has no adm-lifecycle Deployment")?;
    let pod = &mut deployment["spec"]["template"]["spec"];
    for kind in ["initContainers", "containers"] {
        let containers = pod[kind]
            .as_array_mut()
            .with_context(|| format!("lifecycle manifest has no {kind}"))?;
        ensure!(
            !containers.is_empty(),
            "lifecycle manifest has empty {kind}"
        );
        for container in containers {
            container["image"] = json!(image);
        }
    }

    eprintln!("adm: setup: provisioning lifecycle control plane");
    workspaces::kubectl(
        cli,
        &["apply", "-f", "-"],
        Some(&serde_json::to_vec(&namespace)?),
    )?;
    install_token(cli, explicit_token.as_deref())?;
    let manifest = json!({"apiVersion":"v1","kind":"List","items":resources});
    workspaces::kubectl(
        cli,
        &["apply", "-f", "-"],
        Some(&serde_json::to_vec(&manifest)?),
    )?;
    eprintln!("adm: setup: waiting for lifecycle control plane");
    workspaces::kubectl(
        cli,
        &[
            "-n",
            "adm-system",
            "rollout",
            "status",
            "deployment/adm-lifecycle",
            "--timeout=180s",
        ],
        None,
    )?;
    Ok(())
}

fn install_token(cli: &Cli, explicit_token: Option<&str>) -> Result<()> {
    let existing = workspaces::kubectl(
        cli,
        &[
            "-n",
            "adm-system",
            "get",
            "secret",
            "adm-lifecycle-token",
            "--ignore-not-found",
            "-o",
            "name",
        ],
        None,
    )?;
    if !existing.is_empty() {
        if let Some(explicit_token) = explicit_token {
            ensure!(
                lifecycle::kubernetes_token(cli)? == explicit_token,
                "the lifecycle token file does not match the existing adm-system/adm-lifecycle-token Secret; select the matching credential; setup will not rotate an existing token"
            );
        }
        return Ok(());
    }
    let token = explicit_token.map(str::to_owned).unwrap_or_else(|| {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    });
    workspaces::kubectl(
        cli,
        &[
            "-n",
            "adm-system",
            "create",
            "secret",
            "generic",
            "adm-lifecycle-token",
            "--from-file=token=/dev/stdin",
        ],
        Some(token.as_bytes()),
    )?;
    Ok(())
}
