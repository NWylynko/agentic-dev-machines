//! A coding agent reports to the bot that manages it (TASK-140).
//!
//! A coding workspace's `manager` is a bot's immutable ID: a bot's createAgent
//! names itself, `adm create --manager BOT` names a live bot. The agent's
//! `messageManager` tool posts to `POST /v1/workspaces/MANAGER/runtime/message`
//! with its Pod token. The lifecycle checks that MANAGER is the caller's own
//! manager and forwards the text to the bot runner's
//! `/v1/workspaces/MANAGER/agent-messages` (coding Pods cannot reach bot Pods).
//! The coding Pod's token never leaves the lifecycle: the bot runner gets a
//! one-delivery bearer instead, which it presents to `runtime/authorize` with
//! action `message` to learn which agent is speaking.

use crate::workspaces::WorkspaceStore;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, io::Read, net::IpAddr, sync::Mutex, time::Duration};

/// Prefix of the bearer a bot runner receives with one agent message.
const AGENT_MESSAGE_DELIVERY_BEARER_PREFIX: &str = "adm-agent-message-delivery.";
const AGENT_MESSAGE_FORWARD_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_AGENT_MESSAGE_RESPONSE_BYTES: u64 = 64 * 1024;

struct AgentMessageDelivery {
    manager_id: String,
    agent_id: String,
    agent_name: String,
}

/// Deliveries in flight, by bearer. An entry lives only while its forward to
/// the bot runner is open, and is consumed by the bot's first authorize.
static AGENT_MESSAGE_DELIVERIES: Mutex<BTreeMap<String, AgentMessageDelivery>> =
    Mutex::new(BTreeMap::new());

/// Removes a delivery's bearer however its forward ends.
struct AgentMessageDeliveryBearer(String);

impl Drop for AgentMessageDeliveryBearer {
    fn drop(&mut self) {
        AGENT_MESSAGE_DELIVERIES
            .lock()
            .expect("agent message deliveries lock")
            .remove(&self.0);
    }
}

pub(crate) fn is_agent_message_route(method: &str, path: &str) -> bool {
    method == "POST" && agent_message_manager_id(path).is_some()
}

fn agent_message_manager_id(path: &str) -> Option<&str> {
    path.strip_prefix("/v1/workspaces/")?
        .strip_suffix("/runtime/message")
        .filter(|id| !id.is_empty() && !id.contains('/'))
}

/// Operator creates name the manager by bot name or ID; admission stores the
/// live bot's immutable ID so a retry with either spelling replays.
pub(crate) fn resolve_create_manager(store: &WorkspaceStore, operation: &mut Value) -> Result<()> {
    if operation["kind"] != "create" {
        return Ok(());
    }
    let Some(requested) = operation["spec"]["manager"].as_str() else {
        return Ok(());
    };
    let bot = store.find(requested)?;
    ensure!(
        bot.role == "bot",
        "--manager must name a bot; {} is a coding workspace",
        bot.name
    );
    ensure!(
        bot.phase != "deleting" && bot.phase != "deleted",
        "manager bot {} has been deleted",
        bot.name
    );
    operation["spec"]["manager"] = json!(bot.id);
    Ok(())
}

/// `POST /v1/workspaces/MANAGER/runtime/message`, from a coding Pod.
pub(crate) fn deliver_agent_message(
    cli: &crate::Cli,
    path: &str,
    body: &[u8],
    authorization: &str,
) -> Result<(u16, Value)> {
    let manager_id = agent_message_manager_id(path).context("invalid agent message path")?;
    let request: Value = serde_json::from_slice(body).context("agent message must be JSON")?;
    let text = request["text"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .context("agent message needs text")?;
    let request_id = request["requestId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .context("agent message needs a requestId of 1-128 characters")?;
    let store = cli.store()?;
    let agent = crate::lifecycle::authorize_runtime_caller(cli, &store, authorization)?;
    ensure!(
        agent.role == "coding" && agent.manager.as_deref() == Some(manager_id),
        "runtime caller is not authorized for workspace {manager_id}: it is not this agent's manager"
    );
    let manager = store.find(manager_id)?;
    ensure!(
        manager.id == manager_id && manager.role == "bot",
        "runtime caller is not authorized for workspace {manager_id}: it is not a bot"
    );
    if manager.phase == "deleting" || manager.phase == "deleted" {
        anyhow::bail!(
            "manager bot {} ({}) is deleting or deleted",
            manager.name,
            manager.id
        );
    }
    drop(store);
    let ip = manager_pod_ip(cli, &manager)?;
    let bearer = format!(
        "{AGENT_MESSAGE_DELIVERY_BEARER_PREFIX}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    AGENT_MESSAGE_DELIVERIES
        .lock()
        .expect("agent message deliveries lock")
        .insert(
            bearer.clone(),
            AgentMessageDelivery {
                manager_id: manager.id.clone(),
                agent_id: agent.id.clone(),
                agent_name: agent.name.clone(),
            },
        );
    let _bearer = AgentMessageDeliveryBearer(bearer.clone());
    let host = match ip {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    let not_running = |cause: String| {
        anyhow::anyhow!(
            "manager bot {} ({}) is not running: {cause}",
            manager.name,
            manager.id
        )
    };
    let response = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(AGENT_MESSAGE_FORWARD_TIMEOUT)
        .build()?
        .post(format!(
            "http://{host}:{}/v1/workspaces/{}/agent-messages",
            cli.runtime_status_port, manager.id
        ))
        .bearer_auth(&bearer)
        .json(&json!({"text":text,"requestId":request_id}))
        .send()
        .map_err(|error| not_running(format!("{:#}", anyhow::Error::new(error))))?;
    let status = response.status().as_u16();
    let mut reply = Vec::new();
    response
        .take(MAX_AGENT_MESSAGE_RESPONSE_BYTES)
        .read_to_end(&mut reply)
        .map_err(|error| not_running(format!("read reply: {error}")))?;
    let reply: Value = serde_json::from_slice(&reply)
        .map_err(|_| not_running(format!("HTTP {status} with an invalid reply")))?;
    eprintln!(
        "adm lifecycle: agent {} ({}) message {request_id} to manager bot {} ({}): HTTP {status}",
        agent.name, agent.id, manager.name, manager.id
    );
    if status == 503 {
        return Err(not_running(
            reply["error"]["message"]
                .as_str()
                .unwrap_or("runner unavailable")
                .to_owned(),
        ));
    }
    Ok((status, reply))
}

fn manager_pod_ip(cli: &crate::Cli, manager: &crate::workspaces::Workspace) -> Result<IpAddr> {
    let pods: Value = serde_json::from_slice(&crate::workspaces::kubectl(
        cli,
        &[
            "get",
            "pods",
            "-n",
            &manager.namespace,
            "-l",
            "app.kubernetes.io/managed-by=adm",
            "-o",
            "json",
        ],
        None,
    )?)
    .context("decode manager bot Pod list")?;
    let ips = pods["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|pod| pod["metadata"]["labels"]["adm.dev/workspace-id"] == manager.id.as_str())
        .filter_map(|pod| pod["status"]["podIP"].as_str()?.parse::<IpAddr>().ok())
        .collect::<Vec<_>>();
    match ips.as_slice() {
        [ip] => Ok(*ip),
        [] => anyhow::bail!(
            "manager bot {} ({}) is not running: its workspace Pod is missing or has no IP",
            manager.name,
            manager.id
        ),
        _ => anyhow::bail!(
            "manager bot {} ({}) is not running: multiple Pods match its workspace ID",
            manager.name,
            manager.id
        ),
    }
}

/// `runtime/authorize` for action `message`: only a delivery bearer the
/// lifecycle handed this bot passes, once. Returns the speaking agent.
/// `None` when the bearer is not a delivery bearer.
pub(crate) fn authorize_agent_message_delivery(
    authorization: &str,
    target_id: &str,
    action: &str,
) -> Option<Result<Value>> {
    let bearer = authorization
        .strip_prefix("Bearer ")
        .filter(|bearer| bearer.starts_with(AGENT_MESSAGE_DELIVERY_BEARER_PREFIX))?;
    let delivery = AGENT_MESSAGE_DELIVERIES
        .lock()
        .expect("agent message deliveries lock")
        .remove(bearer);
    Some(match delivery {
        Some(delivery) if action == "message" && delivery.manager_id == target_id => {
            Ok(json!({"allowed":true,"agent":{"id":delivery.agent_id,"name":delivery.agent_name}}))
        }
        _ => Err(anyhow::anyhow!(
            "runtime caller is not authorized for workspace {target_id}: unknown or used agent message delivery"
        )),
    })
}
