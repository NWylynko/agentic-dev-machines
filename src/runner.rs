use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::time::Duration;

pub fn request_authenticated(
    url: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    token: &str,
) -> Result<Value> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()?;
    let method = reqwest::Method::from_bytes(method.as_bytes())?;
    let mut request = client
        .request(method, format!("{}{path}", url.trim_end_matches('/')))
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().context("workspace runtime unavailable")?;
    let status = response.status();
    let text = response.text()?;
    let value: Value = if text.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text).context("workspace runtime returned invalid JSON")?
    };
    if !status.is_success() {
        anyhow::bail!(
            "workspace runtime {status}: {}",
            value["error"]["message"].as_str().unwrap_or(&text)
        );
    }
    Ok(value)
}
