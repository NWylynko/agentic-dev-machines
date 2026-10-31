//! `adm agents-file`: the installation-wide AGENTS.md for every coding agent.
//! The cluster authority stores the document. This command edits it through
//! `$EDITOR` (nano when EDITOR is unset) and publishes a change only when the
//! editor exits 0 and the text changed.
use crate::Cli;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("adm-agents-file-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).context("create a temporary agents file")?;
        Ok(Self(path))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn run(cli: &Cli, show: bool) -> Result<()> {
    let current = cli.request_lifecycle("GET", "/v1/agents-file", None)?;
    let revision = current["revision"]
        .as_u64()
        .context("shared agents file has no revision")?;
    let content = current["content"].as_str().unwrap_or("").to_owned();
    if show {
        print_document(&current, revision, &content);
        return Ok(());
    }
    let directory = TempDir::new()?;
    let path = directory.0.join("AGENTS.md");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .context("write the temporary agents file")?;
    file.write_all(content.as_bytes())?;
    drop(file);
    run_editor(&path)?;
    let edited = fs::read_to_string(&path).context("read the edited agents file")?;
    if edited == content {
        println!("Shared agents file is unchanged (revision {revision}).");
        return Ok(());
    }
    let saved = cli.request_lifecycle(
        "PUT",
        "/v1/agents-file",
        Some(&json!({"content": edited, "baseRevision": revision})),
    )?;
    let saved_revision = saved["revision"]
        .as_u64()
        .context("saved agents file has no revision")?;
    println!(
        "Saved the shared agents file for every coding agent (revision {saved_revision}). It applies on each agent's next turn."
    );
    Ok(())
}

fn print_document(document: &Value, revision: u64, content: &str) {
    println!(
        "source: {}",
        document["source"].as_str().unwrap_or("installation")
    );
    println!("revision: {revision}");
    match document["updatedAt"].as_str() {
        Some(updated) => println!("updated: {updated}"),
        None => println!("updated: never"),
    }
    println!();
    print!("{content}");
    if !content.is_empty() && !content.ends_with('\n') {
        println!();
    }
}

fn editor_program() -> String {
    match std::env::var("EDITOR") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => "nano".to_owned(),
    }
}

fn run_editor(path: &Path) -> Result<()> {
    let editor = editor_program();
    let mut parts = editor.split_whitespace();
    let program = parts
        .next()
        .context("EDITOR is empty; the shared agents file was not changed")?;
    let status = Command::new(program)
        .args(parts)
        .arg(path)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| {
            format!("could not run editor {program}; the shared agents file was not changed")
        })?;
    ensure!(
        status.success(),
        "editor exited {status}; the shared agents file was not changed"
    );
    Ok(())
}
