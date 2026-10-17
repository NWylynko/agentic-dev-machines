use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

fn adm(root: &Path, arguments: &[&str], input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("HOME", root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env_remove("ADM_PROJECT_DIR")
        .env_remove("ADM_STATE_DIR")
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(input.as_bytes());
    child.wait_with_output().unwrap()
}

fn assert_ok(output: Output) -> Output {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[test]
fn setup_saves_defaults_used_by_workspace_commands_and_keeps_them_on_rerun() {
    let root = tempfile::tempdir().unwrap();
    assert_ok(adm(
        root.path(),
        &["setup"],
        "registry.example/adm:v2\nreplicated-work\nopenai/example-model\nn\nn\n",
    ));
    let config_path = root.path().join("config/adm/config.json");
    let configured: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    assert_eq!(configured["image"], "registry.example/adm:v2");
    assert_eq!(configured["storageClass"], "replicated-work");
    assert_eq!(configured["model"], "openai/example-model");
    assert_eq!(configured.as_object().unwrap().len(), 3);

    let output = assert_ok(adm(root.path(), &["manifest", "configured"], ""));
    let manifest: Value = serde_json::from_slice(&output.stdout).unwrap();
    let items = manifest["items"].as_array().unwrap();
    let deployment = items
        .iter()
        .find(|item| item["kind"] == "Deployment")
        .unwrap();
    let claim = items
        .iter()
        .find(|item| item["kind"] == "PersistentVolumeClaim")
        .unwrap();
    assert_eq!(
        deployment["spec"]["template"]["spec"]["containers"][0]["image"],
        "registry.example/adm:v2"
    );
    assert_eq!(claim["spec"]["storageClassName"], "replicated-work");

    assert_ok(adm(root.path(), &["setup"], "\n\n\nn\nn\n"));
    let retained: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    assert_eq!(retained, configured);
    assert!(
        !root.path().join("data/adm").exists(),
        "setup must not provision a workspace or change runner state"
    );
    assert!(!root.path().join("config/systemd").exists());
}

#[test]
fn saved_setup_image_is_preserved_even_if_release_metadata_is_unavailable() {
    let root = tempfile::tempdir().unwrap();
    assert_ok(adm(
        root.path(),
        &["setup"],
        "registry.example/kept:v1\n\n\nn\nn\n",
    ));
    let runtime = root.path().join("runtime");
    fs::create_dir_all(&runtime).unwrap();
    fs::write(runtime.join("IMAGE"), "\n").unwrap();
    assert_ok(adm(
        root.path(),
        &["--project-dir", runtime.to_str().unwrap(), "setup"],
        "\n\n\nn\nn\n",
    ));
    let configured: Value =
        serde_json::from_slice(&fs::read(root.path().join("config/adm/config.json")).unwrap())
            .unwrap();
    assert_eq!(configured["image"], "registry.example/kept:v1");
}
