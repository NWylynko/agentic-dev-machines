use serde_json::Value;
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    os::unix::net::UnixListener,
    path::Path,
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

#[test]
fn fresh_runner_start_returns_and_daemon_survives_cli_exit() {
    let root = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    drop(listener);
    let invoke = |action: &str| {
        Command::new("timeout")
            .args(["15", env!("CARGO_BIN_EXE_adm"), "--state-dir"])
            .arg(root.path())
            .args(["--runner-url", &url, action])
            .output()
            .unwrap()
    };
    let started = invoke("start");
    let health = reqwest::blocking::get(format!("{url}/health"))
        .and_then(|response| response.json::<Value>());
    // Clean up even when the regression makes `start` time out before recording its PID.
    let owner = root.path().join("runner/owner.json");
    if let Ok(contents) = fs::read(&owner)
        && let Ok(value) = serde_json::from_slice::<Value>(&contents)
        && let Some(pid) = value["pid"].as_i64()
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    let response = assert_ok(started);
    assert_eq!(response["status"], "ready");
    assert_eq!(
        health.unwrap()["status"],
        "ok",
        "runner must outlive its launching CLI"
    );
}

#[test]
fn prompt_omits_absent_request_id_and_preserves_explicit_id_deduplication() {
    let output = Command::new("node")
        .arg("tests/bot-prompt.test.mjs")
        .arg(env!("CARGO_BIN_EXE_adm"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("run CLI-to-runner prompt scenario");
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn adm(root: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"))
        .args(arguments)
        .output()
        .expect("run public CLI")
}

fn adm_with_input(root: &Path, arguments: &[&str], input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"))
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run public CLI");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().expect("wait for public CLI")
}

fn assert_ok(output: Output) -> Value {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("JSON response")
}

fn fixture() -> TempDir {
    let root = tempfile::tempdir().unwrap();
    let kubectl = root.path().join("kubectl");
    fs::write(&kubectl, r##"#!/usr/bin/env python3
import json, pathlib, sys
path = pathlib.Path(__file__).parent / 'cluster.json'
state = json.loads(path.read_text()) if path.exists() else {}
args = sys.argv[1:]
if args[:2] == ['get', 'storageclass']:
    print(json.dumps({'provisioner':'driver.longhorn.io','metadata':{'name':args[2]}}))
elif args[0] == 'apply':
    doc=json.load(sys.stdin)
    for item in doc['items']:
        if item['kind']=='Namespace': state[item['metadata']['name']]=item
    path.write_text(json.dumps(state)); print('applied')
elif args[:2] == ['get','namespace']:
    if (pathlib.Path(__file__).parent / 'fail-status').exists():
        print('Error from server: connection refused',file=sys.stderr);sys.exit(1)
    if args[2] in state: print(json.dumps(state[args[2]]))
    else: print('Error from server (NotFound): namespaces not found',file=sys.stderr);sys.exit(1)
elif args[:2] == ['delete','namespace']:
    state.pop(args[2],None);path.write_text(json.dumps(state)); print('deleted')
elif args[0] == 'wait':
    failure = pathlib.Path(__file__).parent / 'fail-wait-once'
    if failure.exists():
        failure.unlink(); print('deployment did not become available',file=sys.stderr); sys.exit(1)
    print('condition met')
elif args[:2] == ['get','pods']:
    print(json.dumps({'items':[{'metadata':{'name':'workspace-123'},'spec':{'nodeName':'node-a'},'status':{'phase':'Running'}}]}))
elif args and args[0] == 'exec':
    (pathlib.Path(__file__).parent / 'exec-args.json').write_text(json.dumps(args))
else: print('unexpected kubectl arguments: '+repr(args),file=sys.stderr);sys.exit(2)
"##).unwrap();
    fs::set_permissions(kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    root
}

#[test]
fn list_defaults_to_local_summary_and_keeps_full_records_with_json() {
    let root = fixture();

    let empty = adm(root.path(), &["list"]);
    assert!(
        empty.status.success(),
        "{}",
        String::from_utf8_lossy(&empty.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&empty.stdout).trim(),
        "No workspaces"
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"])),
        serde_json::json!([])
    );

    let coding = assert_ok(adm(
        root.path(),
        &["create", "coding-agent", "--no-agent", "--no-repositories"],
    ));
    let shell = assert_ok(adm(
        root.path(),
        &["create", "shell-only", "--no-agent", "--no-repositories"],
    ));
    let bot = assert_ok(adm(
        root.path(),
        &["create", "observer", "--role", "bot", "--no-agent"],
    ));

    let table = adm(root.path(), &["list"]);
    assert!(
        table.status.success(),
        "{}",
        String::from_utf8_lossy(&table.stderr)
    );
    let table = String::from_utf8_lossy(&table.stdout);
    assert!(
        table.contains("NAME")
            && table.contains("ROLE")
            && table.contains("PHASE")
            && table.contains("AGENT")
            && table.contains("ID"),
        "{table}"
    );
    for (name, role, agent, record) in [
        ("coding-agent", "coding", "disabled", &coding),
        ("shell-only", "coding", "disabled", &shell),
        ("observer", "bot", "disabled", &bot),
    ] {
        assert!(table.contains(name), "{table}");
        assert!(table.contains(role), "{table}");
        assert!(table.contains(agent), "{table}");
        assert!(
            table.contains(record["id"].as_str().unwrap()),
            "full immutable ID missing from table: {table}"
        );
        assert!(table.contains(record["phase"].as_str().unwrap()), "{table}");
    }

    let listed = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(listed.as_array().unwrap().len(), 3);
    assert_eq!(listed[0]["id"], coding["id"]);
    assert_eq!(listed[1]["id"], shell["id"]);
    assert_eq!(listed[2]["id"], bot["id"]);
    assert!(
        listed[0].get("namespace").is_some(),
        "--json keeps the existing complete record shape"
    );

    assert_eq!(
        assert_ok(adm(root.path(), &["destroy", "shell-only"]))["phase"],
        "deleted"
    );
    let active = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(active.as_array().unwrap().len(), 2);
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json", "--all"]))
            .as_array()
            .unwrap()
            .len(),
        3
    );

    // Listing is local even when both external dependencies are unavailable.
    let marker = root.path().join("kubectl-contacted");
    let kubectl = root.path().join("kubectl");
    fs::write(
        &kubectl,
        format!(
            "#!/bin/sh\nprintf contacted >> '{}'\nexit 1\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    let offline = Command::new(env!("CARGO_BIN_EXE_adm"))
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(&kubectl)
        .args(["--runner-url", "http://127.0.0.1:1", "list", "--json"])
        .output()
        .unwrap();
    assert_eq!(assert_ok(offline).as_array().unwrap().len(), 2);
    assert!(!marker.exists(), "list must not contact kubectl");
}

#[test]
fn shell_uses_public_cwd_as_an_argument_and_preserves_explicit_command_argv() {
    let root = fixture();
    assert_ok(adm(
        root.path(),
        &["create", "shell-cwd", "--no-agent", "--no-repositories"],
    ));

    let shell = adm(root.path(), &["shell", "shell-cwd"]);
    assert!(shell.status.success(), "{shell:?}");
    let args: Value =
        serde_json::from_slice(&fs::read(root.path().join("exec-args.json")).unwrap()).unwrap();
    let kubectl_args = args.as_array().unwrap();
    let command_start = kubectl_args.iter().position(|arg| arg == "--").unwrap() + 1;
    let mut command: Vec<_> = kubectl_args[command_start..]
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(&command[..3], ["bash", "-l", "-c"]);
    assert_eq!(command.last().map(String::as_str), Some("/repos"));

    let backing = root.path().join("workspace/.adm/catalog");
    let public = root.path().join("public view with spaces");
    let home = root.path().join("home");
    fs::create_dir_all(&backing).unwrap();
    fs::create_dir_all(&home).unwrap();
    symlink(&backing, &public).unwrap();
    *command.last_mut().unwrap() = public.to_string_lossy().into_owned();
    let mut runtime = Command::new(&command[0])
        .args(&command[1..])
        .current_dir(&public)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", &home)
        .env("TERM", "dumb")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run the Bash argv emitted by adm shell");
    runtime
        .stdin
        .take()
        .unwrap()
        .write_all(
            b"printf 'PWD=%s\\n' \"$PWD\"; printf 'pwd=%s\\n' \"$(pwd)\"; printf 'physical=%s\\n' \"$(pwd -P)\"; PS1='\\w'; printf 'prompt=%s\\n' \"${PS1@P}\"\n",
        )
        .unwrap();
    let runtime = runtime.wait_with_output().unwrap();
    assert!(
        runtime.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&runtime.stdout),
        String::from_utf8_lossy(&runtime.stderr)
    );
    let output = String::from_utf8_lossy(&runtime.stdout);
    let public = public.to_string_lossy();
    let backing = backing.to_string_lossy();
    assert!(output.contains(&format!("PWD={public}\n")), "{output}");
    assert!(output.contains(&format!("pwd={public}\n")), "{output}");
    assert!(output.contains(&format!("prompt={public}\n")), "{output}");
    assert!(
        output.contains(&format!("physical={backing}\n")),
        "{output}"
    );

    let explicit = adm(
        root.path(),
        &[
            "shell",
            "shell-cwd",
            "--",
            "bash",
            "-lc",
            "printf '%s' \"$PWD\"",
        ],
    );
    assert!(explicit.status.success(), "{explicit:?}");
    let args: Value =
        serde_json::from_slice(&fs::read(root.path().join("exec-args.json")).unwrap()).unwrap();
    let actual: Vec<_> = args.as_array().unwrap()[args.as_array().unwrap().len() - 3..]
        .iter()
        .map(Value::as_str)
        .collect();
    assert_eq!(
        actual,
        [Some("bash"), Some("-lc"), Some("printf '%s' \"$PWD\""),]
    );
}

#[test]
fn public_cli_rejects_unsafe_names_before_touching_the_cluster() {
    let root = tempfile::tempdir().unwrap();
    for name in ["../escape", "UPPER", "a/b", "", "bad name"] {
        let output = adm(
            root.path(),
            &["create", name, "--no-agent", "--no-repositories"],
        );
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("name"));
    }
}

#[test]
fn agent_workspace_requires_an_explicit_model_before_provisioning() {
    let root = fixture();
    let output = adm(root.path(), &["create", "needs-model"]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("--model PROVIDER/MODEL_ID"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !root.path().join("state/workspaces.sqlite").exists(),
        "invalid agent configuration must fail before local or cluster provisioning"
    );
}

#[test]
fn workspace_lifecycle_retains_tombstones_and_reused_names_get_new_identities() {
    let root = fixture();
    let first = assert_ok(adm(
        root.path(),
        &["create", "demo", "--no-agent", "--no-repositories"],
    ));
    assert_eq!(first["name"], "demo");
    assert_eq!(first["phase"], "ready");
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"]))[0]["id"],
        first["id"]
    );
    let duplicate = adm(
        root.path(),
        &["create", "demo", "--no-agent", "--no-repositories"],
    );
    assert!(
        !duplicate.status.success(),
        "duplicate names must be explicit errors"
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["status", "demo"]))["workspace"]["id"],
        first["id"]
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["destroy", "demo"]))["phase"],
        "deleted"
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"])),
        serde_json::json!([])
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json", "--all"]))[0]["phase"],
        "deleted"
    );
    let second = assert_ok(adm(
        root.path(),
        &["create", "demo", "--no-agent", "--no-repositories"],
    ));
    assert_ne!(first["id"], second["id"]);
}

#[test]
fn retrying_a_partially_applied_creation_resumes_the_same_workspace() {
    let root = fixture();
    fs::write(root.path().join("fail-wait-once"), "fail").unwrap();

    let first = adm(
        root.path(),
        &["create", "retry-me", "--no-agent", "--no-repositories"],
    );
    assert!(
        !first.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    let failed = assert_ok(adm(root.path(), &["list", "--json"]));
    assert!(
        failed.as_array().is_some_and(|items| !items.is_empty()),
        "creation failed before being recorded: {}",
        String::from_utf8_lossy(&first.stderr)
    );
    let original_id = failed[0]["id"].as_str().unwrap();
    assert_eq!(failed[0]["phase"], "failed");

    let retried = assert_ok(adm(
        root.path(),
        &["create", "retry-me", "--no-agent", "--no-repositories"],
    ));
    assert_eq!(retried["phase"], "ready");
    assert_eq!(retried["id"], original_id);
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"]))[0]["id"],
        original_id
    );
}

#[test]
fn retrying_creation_refuses_to_overwrite_a_namespace_with_changed_ownership() {
    let root = fixture();
    fs::write(root.path().join("fail-wait-once"), "fail").unwrap();
    let first = adm(
        root.path(),
        &["create", "retry-safe", "--no-agent", "--no-repositories"],
    );
    assert!(!first.status.success());
    let failed = assert_ok(adm(root.path(), &["list", "--json"]));
    let namespace = failed[0]["namespace"].as_str().unwrap();
    let cluster_path = root.path().join("cluster.json");
    let mut cluster: Value = serde_json::from_slice(&fs::read(&cluster_path).unwrap()).unwrap();
    cluster[namespace]["metadata"]["labels"]["adm.dev/workspace-id"] = "someone-else".into();
    fs::write(&cluster_path, serde_json::to_vec(&cluster).unwrap()).unwrap();

    let retry = adm(
        root.path(),
        &["create", "retry-safe", "--no-agent", "--no-repositories"],
    );
    assert!(
        !retry.status.success(),
        "retry must refuse a namespace with changed ownership"
    );
    assert!(String::from_utf8_lossy(&retry.stderr).contains("ownership"));
    let cluster: Value = serde_json::from_slice(&fs::read(&cluster_path).unwrap()).unwrap();
    assert_eq!(
        cluster[namespace]["metadata"]["labels"]["adm.dev/workspace-id"],
        "someone-else"
    );
}

#[test]
fn destruction_refuses_a_namespace_whose_immutable_ownership_changed() {
    let root = fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &["create", "safe", "--no-agent", "--no-repositories"],
    ));
    let cluster_path = root.path().join("cluster.json");
    let mut cluster: Value = serde_json::from_slice(&fs::read(&cluster_path).unwrap()).unwrap();
    cluster[workspace["namespace"].as_str().unwrap()]["metadata"]["labels"]["adm.dev/workspace-id"] =
        "someone-else".into();
    fs::write(cluster_path, serde_json::to_vec(&cluster).unwrap()).unwrap();
    let output = adm(root.path(), &["destroy", "safe"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("ownership"));
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"]))[0]["phase"],
        "ready"
    );
}

#[test]
fn herdr_watch_only_destroys_on_an_explicit_workspace_closed_event() {
    use std::io::BufRead;

    let root = fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &["create", "herdr-owned", "--no-agent", "--no-repositories"],
    ));
    let other_workspace = assert_ok(adm(
        root.path(),
        &["create", "herdr-other", "--no-agent", "--no-repositories"],
    ));
    let stale_workspace = assert_ok(adm(
        root.path(),
        &["create", "herdr-stale", "--no-agent", "--no-repositories"],
    ));
    assert_ok(adm(
        root.path(),
        &["herdr", "bind", "herdr-owned", "space-123"],
    ));
    assert_ok(adm(
        root.path(),
        &["herdr", "bind", "herdr-other", "space-456"],
    ));
    assert_ok(adm(
        root.path(),
        &["herdr", "bind", "herdr-stale", "space-missing"],
    ));
    let socket = root.path().join("herdr.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let expected_workspace = workspace["id"].as_str().unwrap().to_owned();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut writer = stream;
        let mut line = String::new();

        reader.read_line(&mut line).unwrap();
        let subscribe: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(subscribe["method"], "events.subscribe");
        assert_eq!(
            subscribe["params"]["subscriptions"][0]["type"],
            "workspace.closed"
        );
        // A notification can arrive before the subscribe response; subsequent closes
        // arrive as event envelopes on the same subscribed connection.
        let _ = writeln!(
            writer,
            "{}",
            serde_json::json!({
                "event":"workspace_closed",
                "data":{"type":"workspace_closed","workspace_id":"space-123"}
            })
        );
        let _ = writeln!(
            writer,
            "{}",
            serde_json::json!({
                "id":subscribe["id"],"result":{"type":"subscription_started"}
            })
        );
        let _ = writeln!(
            writer,
            "{}",
            serde_json::json!({
                "event":"workspace_closed",
                "data":{"type":"workspace_closed","workspace_id":"unbound-space"}
            })
        );
        let _ = writeln!(
            writer,
            "{}",
            serde_json::json!({
                "event":"workspace_closed",
                "data":{"type":"workspace_closed","workspace_id":"space-456"}
            })
        );
        reader
            .get_mut()
            .set_read_timeout(Some(std::time::Duration::from_millis(500)))
            .unwrap();
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {}
            Ok(_) => panic!("watcher sent an unexpected request: {line}"),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => panic!("failed while checking for unexpected requests: {error}"),
        }
        // Closing the subscribed connection makes watch exit after processing events.
        expected_workspace
    });

    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .args(["herdr", "watch", "--socket"])
        .arg(&socket)
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &socket)
        .output()
        .expect("run public Herdr watcher");
    let expected_workspace = server.join().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"status\":\"watching\""), "{stdout}");
    assert!(stdout.contains(&expected_workspace), "{stdout}");
    assert_eq!(
        stdout.matches("\"phase\":\"deleted\"").count(),
        2,
        "{stdout}"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("socket closed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let remaining = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(remaining.as_array().unwrap().len(), 1);
    assert_eq!(remaining[0]["id"], stale_workspace["id"]);
    assert_eq!(remaining[0]["phase"], "ready");
    assert_eq!(
        assert_ok(adm(root.path(), &["status", "herdr-other"]))["workspace"]["phase"],
        "deleted"
    );
    assert_ne!(workspace["id"], other_workspace["id"]);
}

#[test]
fn herdr_watch_replays_a_received_close_after_cleanup_failure() {
    use std::io::BufRead;

    fn fake_socket(path: &Path, close_space: Option<&'static str>) -> std::thread::JoinHandle<()> {
        let listener = UnixListener::bind(path).unwrap();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut writer = stream;
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let subscribe: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(subscribe["method"], "events.subscribe");
            let _ = writeln!(
                writer,
                "{}",
                serde_json::json!({"id":subscribe["id"],"result":{"type":"subscription_started"}})
            );
            if let Some(space) = close_space {
                let _ = writeln!(
                    writer,
                    "{}",
                    serde_json::json!({
                        "event":"workspace_closed",
                            "data":{"type":"workspace_closed","workspace_id":space}
                    })
                );
            }
        })
    }

    fn watch(root: &Path, socket: &Path) -> Output {
        Command::new(env!("CARGO_BIN_EXE_adm"))
            .arg("--state-dir")
            .arg(root.join("state"))
            .arg("--kubectl")
            .arg(root.join("kubectl"))
            .args(["herdr", "watch", "--socket"])
            .arg(socket)
            .env("HERDR_ENV", "1")
            .env("HERDR_SOCKET_PATH", socket)
            .output()
            .expect("run public Herdr watcher")
    }

    let root = fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &["create", "journaled", "--no-agent", "--no-repositories"],
    ));
    assert_ok(adm(
        root.path(),
        &["herdr", "bind", "journaled", "space-journal"],
    ));
    let cluster_path = root.path().join("cluster.json");
    let namespace = workspace["namespace"].as_str().unwrap();
    let workspace_id = workspace["id"].as_str().unwrap();
    let mut cluster: Value = serde_json::from_slice(&fs::read(&cluster_path).unwrap()).unwrap();
    cluster[namespace]["metadata"]["labels"]["adm.dev/workspace-id"] = "foreign-owner".into();
    fs::write(&cluster_path, serde_json::to_vec(&cluster).unwrap()).unwrap();

    let first_socket = root.path().join("herdr-first.sock");
    let first_server = fake_socket(&first_socket, Some("space-journal"));
    let failed_cleanup = watch(root.path(), &first_socket);
    first_server.join().unwrap();
    assert!(!failed_cleanup.status.success());
    assert!(String::from_utf8_lossy(&failed_cleanup.stderr).contains("ownership mismatch"));
    let journal = root.path().join("state/herdr-closed-events.jsonl");
    assert!(
        fs::read_to_string(&journal)
            .unwrap()
            .contains("space-journal")
    );

    let mut cluster: Value = serde_json::from_slice(&fs::read(&cluster_path).unwrap()).unwrap();
    cluster[namespace]["metadata"]["labels"]["adm.dev/workspace-id"] = workspace_id.into();
    fs::write(&cluster_path, serde_json::to_vec(&cluster).unwrap()).unwrap();
    let second_socket = root.path().join("herdr-second.sock");
    let second_server = fake_socket(&second_socket, None);
    let recovered_cleanup = watch(root.path(), &second_socket);
    second_server.join().unwrap();
    let stdout = String::from_utf8_lossy(&recovered_cleanup.stdout);
    assert!(stdout.contains("\"phase\":\"deleted\""), "{stdout}");
    assert!(!journal.exists() || fs::read(&journal).unwrap().is_empty());
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"])),
        serde_json::json!([])
    );
}

#[test]
fn browser_refuses_to_enter_a_namespace_whose_immutable_ownership_changed() {
    let root = fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &["create", "browser-safe", "--no-agent", "--no-repositories"],
    ));
    let cluster_path = root.path().join("cluster.json");
    let mut cluster: Value = serde_json::from_slice(&fs::read(&cluster_path).unwrap()).unwrap();
    cluster[workspace["namespace"].as_str().unwrap()]["metadata"]["labels"]["adm.dev/workspace-id"] =
        "someone-else".into();
    fs::write(cluster_path, serde_json::to_vec(&cluster).unwrap()).unwrap();

    let output = adm(
        root.path(),
        &["browser", "browser-safe", "http://127.0.0.1:3000"],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("ownership"));
}

#[test]
fn herdr_schema_workspace_closed_event_destroys_only_its_bound_workspace() {
    let root = fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &["create", "herdr-owned", "--no-agent", "--no-repositories"],
    ));
    assert_ok(adm(
        root.path(),
        &["herdr", "bind", "herdr-owned", "space-123"],
    ));

    let event = r#"{"event":"workspace_closed","data":{"type":"workspace_closed","workspace_id":"space-123"}}"#;
    let output = adm_with_input(root.path(), &["herdr", "events"], &format!("{event}\n"));
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["status", "herdr-owned"]))["workspace"]["phase"],
        "deleted"
    );
    let cluster: Value =
        serde_json::from_slice(&fs::read(root.path().join("cluster.json")).unwrap()).unwrap();
    assert!(
        cluster
            .get(workspace["namespace"].as_str().unwrap())
            .is_none()
    );
}

#[test]
fn status_reports_cluster_connection_errors_with_local_workspace_state() {
    let root = fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &[
            "create",
            "offline-status",
            "--no-agent",
            "--no-repositories",
        ],
    ));
    fs::write(root.path().join("fail-status"), "offline").unwrap();

    let status = assert_ok(adm(root.path(), &["status", "offline-status"]));
    assert_eq!(status["workspace"]["id"], workspace["id"]);
    assert!(status["cluster"]["status"] == "unavailable");
    assert!(
        status["cluster"]["error"]
            .as_str()
            .unwrap()
            .contains("connection refused")
    );
}

#[test]
fn manifest_exposes_only_a_deprivileged_development_container_and_isolated_storage() {
    let root = tempfile::tempdir().unwrap();
    let manifest = assert_ok(adm(root.path(), &["manifest", "example"]));
    let items = manifest["items"].as_array().unwrap();
    let deployment = items
        .iter()
        .find(|item| item["kind"] == "Deployment")
        .unwrap();
    let pod = &deployment["spec"]["template"]["spec"];
    assert_eq!(pod["automountServiceAccountToken"], false);
    let dev = &pod["containers"][0];
    assert_eq!(dev["name"], "dev");
    assert_eq!(dev["securityContext"]["allowPrivilegeEscalation"], false);
    assert_eq!(dev["securityContext"]["capabilities"]["drop"][0], "ALL");
    assert!(
        items
            .iter()
            .any(|item| item["kind"] == "PersistentVolumeClaim")
    );
    assert!(items.iter().any(|item| item["kind"] == "NetworkPolicy"));
    assert_eq!(deployment["spec"]["strategy"]["type"], "Recreate");
    assert!(pod["containers"].as_array().unwrap().len() == 1);
    assert_eq!(pod["initContainers"][0]["command"][1], "plain");
}

#[test]
fn repository_sidecar_runs_as_the_development_user_and_catalog_is_the_repos_view() {
    let root = tempfile::tempdir().unwrap();
    let catalog = root.path().join("catalog.json");
    fs::write(
        &catalog,
        r#"{"repositories":[{"name":"demo","url":"https://example.invalid/demo.git"}]}"#,
    )
    .unwrap();
    let manifest = assert_ok(adm(
        root.path(),
        &["manifest", "repos", "--catalog", catalog.to_str().unwrap()],
    ));
    let items = manifest["items"].as_array().unwrap();
    let deployment = items
        .iter()
        .find(|item| item["kind"] == "Deployment")
        .unwrap();
    let pod = &deployment["spec"]["template"]["spec"];
    let dev = &pod["containers"][0];
    assert_eq!(dev["workingDir"], "/repos");
    assert_eq!(dev["readinessProbe"]["exec"]["command"][2], "/repos");
    let sidecar = pod["containers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|container| container["name"] == "repositories")
        .expect("repository sidecar");
    assert_eq!(sidecar["securityContext"]["runAsUser"], 1000);
    assert_eq!(sidecar["securityContext"]["runAsGroup"], 1000);
    assert_eq!(sidecar["securityContext"]["runAsNonRoot"], true);
    assert_eq!(sidecar["securityContext"]["privileged"], true);
    let command = sidecar["command"].as_array().unwrap();
    assert!(
        command
            .iter()
            .any(|part| part == "/usr/local/bin/adm-repositories")
    );
    assert!(command.iter().any(|part| part == "--mount"));
    assert!(command.iter().any(|part| part == "/workspace/.adm/catalog"));
    assert!(command.iter().any(|part| part == "--uid"));
    assert!(command.iter().any(|part| part == "1000"));
    let init = &pod["initContainers"][0];
    assert_eq!(init["command"][0], "/usr/local/bin/adm-init-workspace");
    assert_eq!(init["command"][1], "repositories");
    assert_eq!(init["securityContext"]["runAsUser"], 0);
}

#[test]
fn repository_catalog_options_must_match_the_workspace_role() {
    let root = tempfile::tempdir().unwrap();
    let catalog = root.path().join("catalog.json");
    fs::write(&catalog, r#"{"repositories":[]}"#).unwrap();
    for args in [
        vec![
            "manifest",
            "coding",
            "--catalog",
            catalog.to_str().unwrap(),
            "--no-repositories",
        ],
        vec![
            "manifest",
            "bot",
            "--role",
            "bot",
            "--catalog",
            catalog.to_str().unwrap(),
        ],
    ] {
        let output = adm(root.path(), &args);
        assert!(!output.status.success(), "args={args:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("catalog"));
    }
}

#[test]
fn start_rejects_a_checkout_without_the_runner() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .arg("--state-dir")
        .arg(root.path())
        .arg("--project-dir")
        .arg(root.path())
        .arg("--runner-url")
        .arg("http://127.0.0.1:9")
        .arg("start")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("--project-dir"),
        "a published binary must say how to point at the checkout: {stderr}"
    );
}

#[test]
fn missing_replicated_storage_points_at_the_deploy_note() {
    let root = tempfile::tempdir().unwrap();
    let kubectl = root.path().join("kubectl");
    fs::write(&kubectl, "#!/bin/sh\necho 'Error from server (NotFound): storageclasses.storage.k8s.io \"adm-replicated\" not found' >&2\nexit 1\n").unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    let output = adm(root.path(), &["create", "demo", "--no-agent"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("deploy/storage.md"), "{stderr}");
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"]))
            .as_array()
            .unwrap()
            .len(),
        0
    );
}
