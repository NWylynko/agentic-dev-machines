use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
    process::{Child, Command, Output, Stdio},
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
fn setup_installs_a_user_service_and_does_not_replace_a_custom_unit() {
    let root = tempfile::Builder::new()
        .prefix("adm setup % ")
        .tempdir()
        .unwrap();
    let bin = root.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let systemctl = bin.join("systemctl");
    fs::write(
        &systemctl,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/systemctl.log\"\n",
    )
    .unwrap();
    fs::set_permissions(&systemctl, fs::Permissions::from_mode(0o755)).unwrap();
    fs::create_dir_all(root.path().join(".local/bin")).unwrap();
    symlink(
        env!("CARGO_BIN_EXE_adm"),
        root.path().join(".local/bin/adm"),
    )
    .unwrap();
    let run_setup = |arguments: &[&str], input: &str| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
        command
            .env("HOME", root.path())
            .env("XDG_CONFIG_HOME", root.path().join("config"))
            .env(
                "PATH",
                std::env::join_paths(
                    std::iter::once(bin.clone())
                        .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
                )
                .unwrap(),
            )
            .env("ADM_SETUP_TEST_KEY", "must-not-be-written")
            .env_remove("ADM_PROJECT_DIR")
            .env_remove("ADM_STATE_DIR")
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    };
    let state = root.path().join("private state % $\"");
    let kubectl = root.path().join("kubectl boundary");
    let arguments = [
        "--state-dir",
        state.to_str().unwrap(),
        "--runner-url",
        "http://127.0.0.1:8312",
        "--kubectl",
        kubectl.to_str().unwrap(),
        "setup",
    ];
    let output = assert_ok(run_setup(&arguments, "\n\n\nn\ny\n"));
    let service_path = root.path().join("config/systemd/user/adm-runner.service");
    let service = fs::read_to_string(&service_path).unwrap();
    let command = service
        .lines()
        .find(|line| line.starts_with("ExecStart="))
        .unwrap();
    assert!(command.starts_with("ExecStart=\"/"), "{command}");
    assert!(command.contains("adm setup %% "), "{command}");
    assert!(
        command.contains("/.local/bin/adm\" --state-dir \"/"),
        "{command}"
    );
    assert!(command.contains("private state %% $$\\\"\""), "{command}");
    assert!(
        command.contains(" --runner-url \"http://127.0.0.1:8312\" --kubectl \"/"),
        "{command}"
    );
    assert!(command.ends_with("/kubectl boundary\" serve"), "{command}");
    assert!(service.contains("Environment=\"PATH="));
    assert!(!service.contains("must-not-be-written"));
    assert!(!service.contains("project-dir"));
    assert!(!service.contains("ABSOLUTE"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("lingering"));
    let calls = fs::read_to_string(root.path().join("systemctl.log")).unwrap();
    assert_eq!(
        calls,
        "--user daemon-reload\n--user enable adm-runner.service\n--user restart adm-runner.service\n"
    );

    fs::write(&service_path, "# Custom ADM unit\n").unwrap();
    assert_ok(run_setup(&arguments, "\n\n\nn\ny\nn\n"));
    assert_eq!(
        fs::read_to_string(&service_path).unwrap(),
        "# Custom ADM unit\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("systemctl.log")).unwrap(),
        calls
    );
}

#[test]
fn login_runs_the_shipped_pi_with_inherited_environment_and_no_project_discovery() {
    let root = tempfile::tempdir().unwrap();
    let entry = root
        .path()
        .join("runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    fs::create_dir_all(entry.parent().unwrap()).unwrap();
    fs::write(&entry, "console.log(JSON.stringify({entry:__filename,args:process.argv.slice(2),home:process.env.HOME}));\n").unwrap();
    let output = assert_ok(adm(
        root.path(),
        &[
            "--project-dir",
            root.path().join("runtime").to_str().unwrap(),
            "login",
        ],
        "",
    ));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let invoked: Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(invoked["entry"], entry.display().to_string());
    assert_eq!(invoked["home"], root.path().display().to_string());
    assert_eq!(
        invoked["args"],
        serde_json::json!([
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates"
        ])
    );
    assert!(!root.path().join("config/adm/config.json").exists());
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

struct TestRunner(Child);

impl Drop for TestRunner {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn setup_requires_stopping_a_standalone_runner_before_installing_the_service() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("data/adm");
    let runtime = root.path().join("runtime");
    let bin = root.path().join("bin");
    fs::create_dir_all(&runtime).unwrap();
    fs::create_dir_all(&state).unwrap();
    fs::create_dir_all(&bin).unwrap();
    fs::write(
        runtime.join("runner.mjs"),
        "process.stdout.write('ready\\n');process.stdin.resume();\n",
    )
    .unwrap();
    fs::write(
        bin.join("systemctl"),
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/systemctl.log\"\n",
    )
    .unwrap();
    fs::set_permissions(bin.join("systemctl"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::create_dir_all(root.path().join(".local/bin")).unwrap();
    symlink(
        env!("CARGO_BIN_EXE_adm"),
        root.path().join(".local/bin/adm"),
    )
    .unwrap();
    let mut runner = TestRunner(
        Command::new("node")
            .arg(runtime.join("runner.mjs"))
            .arg("--state-dir")
            .arg(state.join("runner"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut ready = String::new();
    BufReader::new(runner.0.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready, "ready\n");
    fs::write(state.join("runner.pid"), runner.0.id().to_string()).unwrap();
    let mut setup = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("HOME", root.path())
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("XDG_DATA_HOME", root.path().join("data"))
        .env(
            "PATH",
            std::env::join_paths(
                std::iter::once(bin)
                    .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
            )
            .unwrap(),
        )
        .env_remove("ADM_PROJECT_DIR")
        .env_remove("ADM_STATE_DIR")
        .arg("setup")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    setup
        .stdin
        .take()
        .unwrap()
        .write_all(b"\n\n\nn\ny\n")
        .unwrap();
    let output = setup.wait_with_output().unwrap();
    assert!(
        !output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("adm stop"));
    assert!(
        !root
            .path()
            .join("config/systemd/user/adm-runner.service")
            .exists()
    );
    assert!(!root.path().join("systemctl.log").exists());
    assert!(
        runner.0.try_wait().unwrap().is_none(),
        "setup must not stop the user's standalone runner"
    );
}

#[test]
fn configured_model_is_used_and_explicit_model_wins() {
    let root = tempfile::tempdir().unwrap();
    assert_ok(adm(root.path(), &["setup"], "\n\nfaux/faux-1\nn\nn\n"));
    let kubectl = root.path().join("kubectl");
    fs::write(
        &kubectl,
        "#!/bin/sh\n[ \"$1\" = apply ] || exit 2\ncat >/dev/null\nprintf '%s\\n' applied\n",
    )
    .unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    let mut runner = TestRunner(
        Command::new("node")
            .args([
                "--import",
                "tsx",
                "packages/runner/src/main.ts",
                "--port",
                "0",
                "--state-dir",
            ])
            .arg(root.path().join("data/adm/runner"))
            .env("HOME", root.path())
            .env("XDG_CONFIG_HOME", root.path().join("config"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut stdout = BufReader::new(runner.0.stdout.take().unwrap());
    let mut ready = String::new();
    assert!(
        stdout.read_line(&mut ready).unwrap() > 0,
        "runner exited before readiness"
    );
    let ready: Value = serde_json::from_str(&ready).unwrap();
    assert_eq!(ready["ready"], true);
    let url = ready["url"].as_str().unwrap();
    let create = |name: &str, options: &[&str]| {
        let mut arguments = vec![
            "--runner-url",
            url,
            "--kubectl",
            kubectl.to_str().unwrap(),
            "create",
            name,
            "--role",
            "bot",
        ];
        arguments.extend_from_slice(options);
        serde_json::from_slice::<Value>(&assert_ok(adm(root.path(), &arguments, "")).stdout)
            .unwrap()
    };
    let configured = create("configured-agent", &[]);
    assert_eq!(
        configured["model"],
        serde_json::json!({"provider":"faux","id":"faux-1"})
    );
    assert_eq!(configured["agent_enabled"], true);

    assert_ok(adm(
        root.path(),
        &["setup"],
        "\n\nunconfigured-provider/unused-model\nn\nn\n",
    ));
    let overridden = create("explicit-agent", &["--model", "faux/faux-1"]);
    assert_eq!(
        overridden["model"],
        serde_json::json!({"provider":"faux","id":"faux-1"})
    );
    let owned: Value =
        serde_json::from_slice(&assert_ok(adm(root.path(), &["list", "--json"], "")).stdout)
            .unwrap();
    assert_eq!(owned.as_array().unwrap().len(), 2);
}
