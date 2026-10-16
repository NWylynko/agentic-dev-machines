use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
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

#[test]
fn all_top_level_help_entry_points_are_grouped_offline_and_preserve_command_help() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("config/adm")).unwrap();
    fs::write(root.path().join("config/adm/config.json"), "not json").unwrap();
    let state_dir = root.path().join("state");
    let state_dir = state_dir.to_str().unwrap();
    let run = |args: &[&str], isolated: bool| {
        Command::new(env!("CARGO_BIN_EXE_adm"))
            .env("XDG_CONFIG_HOME", root.path().join("config"))
            .env("XDG_DATA_HOME", root.path().join("data"))
            .args(if isolated {
                vec![
                    "--state-dir",
                    state_dir,
                    "--kubectl",
                    "/missing/kubectl",
                    "--runner-url",
                    "http://127.0.0.1:1",
                ]
            } else {
                vec![]
            })
            .args(args)
            .output()
            .unwrap()
    };
    let outputs = [
        run(&[], false),
        run(&["help"], true),
        run(&["--help"], true),
    ];
    for output in &outputs {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let help = String::from_utf8(outputs[0].stdout.clone()).unwrap();
    assert!(help.contains("Workspace use:"), "{help}");
    assert!(help.contains("ADM management:"), "{help}");
    for command in [
        "create",
        "list",
        "status",
        "inspect",
        "destroy",
        "reconnect",
        "attach",
        "shell",
        "exec",
        "port",
        "prompt",
        "abort",
        "history",
        "browser",
        "manifest",
        "setup",
        "login",
        "start",
        "serve",
        "stop",
        "doctor",
        "herdr",
        "help",
    ] {
        assert_eq!(help.matches(&format!("  {command} ")).count(), 1, "{help}");
    }
    assert_eq!(String::from_utf8(outputs[1].stdout.clone()).unwrap(), help);
    assert_eq!(String::from_utf8(outputs[2].stdout.clone()).unwrap(), help);
    assert!(!root.path().join("data/adm").exists());
    assert!(!root.path().join("state").exists());
    assert!(run(&["help", "create"], true).status.success());
    assert!(run(&["create", "--help"], true).status.success());
    assert!(run(&["herdr", "--help"], true).status.success());
    assert_eq!(run(&["missing-command"], true).status.code(), Some(2));
    assert_eq!(run(&["list", "--bad-flag"], true).status.code(), Some(2));
}

fn adm_with_runner(root: &Path, runner_url: &str, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"))
        .arg("--runner-url")
        .arg(runner_url)
        .args(arguments)
        .output()
        .expect("run public CLI with runner fixture")
}

fn adm_with_runner_env(
    root: &Path,
    runner_url: &str,
    arguments: &[&str],
    git_config: (&str, &str),
) -> Output {
    Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", git_config.0)
        .env("GIT_CONFIG_VALUE_0", git_config.1)
        .env("ADM_TEST_EXEC_ROOT", root.join("pv"))
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"))
        .arg("--runner-url")
        .arg(runner_url)
        .args(arguments)
        .output()
        .expect("run public CLI with Git and runner fixtures")
}

fn serve_runner_status_fixture(listener: TcpListener) {
    for _ in 0..3 {
        let (stream, _) = listener.accept().unwrap();
        let mut request = BufReader::new(stream);
        let mut line = String::new();
        request.read_line(&mut line).unwrap();
        let path = line.split_whitespace().nth(1).unwrap().to_owned();
        let mut content_length = 0;
        loop {
            line.clear();
            request.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some(value) = line.strip_prefix("content-length: ") {
                content_length = value.trim().parse::<usize>().unwrap();
            }
        }
        let mut body = vec![0; content_length];
        request.read_exact(&mut body).unwrap();
        let response = match path.as_str() {
            "/health" => r#"{"status":"ok"}"#,
            path if path.starts_with("/v1/workspaces/") => {
                if content_length > 0 {
                    "{}"
                } else {
                    r#"{"status":"error","error":"provider token expired"}"#
                }
            }
            _ => panic!("unexpected runner path: {path}"),
        };
        let mut stream = request.into_inner();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
            response.len()
        )
        .unwrap();
    }
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
import json, os, pathlib, subprocess, sys
path = pathlib.Path(__file__).parent / 'cluster.json'
state = json.loads(path.read_text()) if path.exists() else {}
args = sys.argv[1:]
def wait_for_release(stage):
    if not (pathlib.Path(__file__).parent / ('delay-'+stage)).exists(): return
    entered=pathlib.Path(__file__).parent / ('entered-'+stage)
    release=pathlib.Path(__file__).parent / ('release-'+stage)
    if release.exists(): return
    entered.write_text('waiting')
    while not release.exists():
        __import__('time').sleep(0.01)
if args[:2] == ['get', 'storageclass']:
    print(json.dumps({'provisioner':'driver.longhorn.io','metadata':{'name':args[2]}}))
elif args[0] == 'apply':
    doc=json.load(sys.stdin)
    (pathlib.Path(__file__).parent / 'last-manifest.json').write_text(json.dumps(doc))
    for item in doc['items']:
        if item['kind']=='Namespace': state[item['metadata']['name']]=item
    path.write_text(json.dumps(state)); print('applied')
elif args[:2] == ['get','namespace']:
    if (pathlib.Path(__file__).parent / 'fail-status').exists():
        print('Error from server: connection refused',file=sys.stderr);sys.exit(1)
    if args[2] in state: print(json.dumps(state[args[2]]))
    else: print('Error from server (NotFound): namespaces not found',file=sys.stderr);sys.exit(1)
elif args[:2] == ['delete','namespace']:
    wait_for_release('delete')
    state.pop(args[2],None);path.write_text(json.dumps(state)); print('deleted')
elif args[0] == 'wait':
    wait_for_release('readiness')
    failure = pathlib.Path(__file__).parent / 'fail-wait-once'
    if failure.exists():
        failure.unlink(); print('deployment did not become available',file=sys.stderr); sys.exit(1)
    print('condition met')
elif args[:2] == ['get','pods']:
    ready = (pathlib.Path(__file__).parent / 'ready-pod').exists()
    init_waiting = (pathlib.Path(__file__).parent / 'init-waiting').exists()
    condition = {'type':'Ready','status':'True' if ready else 'False','reason':'ContainersNotReady'}
    status = {'phase':'Running','conditions':[condition], 'containerStatuses':[{'name':'dev','ready':ready}]}
    if init_waiting:
        status['initContainerStatuses']=[{'name':'setup','ready':False,'state':{'waiting':{'reason':'ImagePullBackOff','message':'could not pull setup image'}}}]
    print(json.dumps({'items':[{'metadata':{'name':'workspace-123'},'spec':{'nodeName':'node-a'},'status':status}]}))
elif args and args[0] == 'exec':
    (pathlib.Path(__file__).parent / 'exec-args.json').write_text(json.dumps(args))
    exec_root = os.environ.get('ADM_TEST_EXEC_ROOT')
    if exec_root:
        namespace = args[args.index('-n') + 1]
        block = os.environ.get('ADM_TEST_BLOCK_EXEC')
        if block and pathlib.Path(block).exists():
            pathlib.Path(block + '.entered').write_text('waiting')
            while not pathlib.Path(block + '.release').exists():
                __import__('time').sleep(0.01)
        state = json.loads(path.read_text()) if path.exists() else {}
        if namespace not in state:
            print('workspace namespace was deleted during exec', file=sys.stderr)
            sys.exit(1)
        repos = pathlib.Path(exec_root) / namespace / 'repos'
        repos.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(args[args.index('--') + 1:], cwd=repos)
        sys.exit(result.returncode)
else: print('unexpected kubectl arguments: '+repr(args),file=sys.stderr);sys.exit(2)
"##).unwrap();
    fs::set_permissions(kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    root
}

#[test]
fn lifecycle_progress_reports_delayed_readiness_and_removal_without_changing_json_or_cleanup() {
    use std::{
        io::{BufRead, BufReader},
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn launch(
        root: &Path,
        args: &[&str],
    ) -> (
        std::process::Child,
        mpsc::Receiver<String>,
        std::thread::JoinHandle<String>,
    ) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_adm"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .arg("--state-dir")
            .arg(root.join("state"))
            .arg("--kubectl")
            .arg(root.join("kubectl"))
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start public CLI");
        let stderr = child.stderr.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut text = String::new();
            for line in BufReader::new(stderr).lines() {
                let line = line.unwrap();
                let _ = sender.send(line.clone());
                text.push_str(&line);
                text.push('\n');
            }
            text
        });
        (child, receiver, reader)
    }

    fn wait_for_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            path.exists(),
            "fixture never reached delayed dependency: {}",
            path.display()
        );
    }

    fn wait_for_stage(receiver: &mpsc::Receiver<String>, stage: &str) -> Option<String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match receiver.recv_timeout(remaining) {
                Ok(line) if line.contains(stage) => return Some(line),
                Ok(_) => {}
                Err(_) => return None,
            }
        }
        None
    }

    let root = fixture();
    fs::write(root.path().join("delay-readiness"), "delay").unwrap();
    let readiness = root.path().join("release-readiness");
    let (create, create_progress, create_stderr) = launch(
        root.path(),
        &["create", "progress-demo", "--no-repositories"],
    );
    wait_for_file(&root.path().join("entered-readiness"));
    let active_create_stage =
        wait_for_stage(&create_progress, "waiting for deployment readiness started");
    let during_create = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(during_create[0]["phase"], "provisioning");
    fs::write(&readiness, "continue").unwrap();
    let created = create.wait_with_output().unwrap();
    let create_diagnostics = create_stderr.join().unwrap();
    assert!(
        active_create_stage
            .as_ref()
            .is_some_and(|line| line
                .contains("create progress-demo: waiting for deployment readiness started")),
        "no active readiness diagnostic arrived while kubectl was blocked: {active_create_stage:?}; remaining={create_diagnostics}"
    );
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let ready: Value =
        serde_json::from_slice(&created.stdout).expect("create JSON remains on stdout");
    assert_eq!(ready["phase"], "ready");
    assert!(
        create_diagnostics.contains("waiting for deployment readiness completed in"),
        "{create_diagnostics}"
    );
    assert!(
        create_diagnostics.contains("create progress-demo: ready in"),
        "{create_diagnostics}"
    );

    let removal = root.path().join("release-delete");
    fs::write(root.path().join("delay-delete"), "delay").unwrap();
    let (destroy, destroy_progress, destroy_stderr) =
        launch(root.path(), &["destroy", "progress-demo"]);
    wait_for_file(&root.path().join("entered-delete"));
    let active_destroy_stage =
        wait_for_stage(&destroy_progress, "waiting for namespace removal started");
    let during_destroy = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(during_destroy[0]["phase"], "deleting");
    assert_eq!(during_destroy[0]["activity"]["status"], "deleted");
    let cluster: Value =
        serde_json::from_slice(&fs::read(root.path().join("cluster.json")).unwrap()).unwrap();
    assert!(
        cluster.get(ready["namespace"].as_str().unwrap()).is_some(),
        "namespace must remain until confirmed removal"
    );
    fs::write(&removal, "continue").unwrap();
    let deleted = destroy.wait_with_output().unwrap();
    let destroy_diagnostics = destroy_stderr.join().unwrap();
    assert!(
        active_destroy_stage
            .as_ref()
            .is_some_and(|line| line
                .contains("destroy progress-demo: waiting for namespace removal started")),
        "no active removal diagnostic arrived while kubectl was blocked: {active_destroy_stage:?}; remaining={destroy_diagnostics}"
    );
    assert!(
        deleted.status.success(),
        "{}",
        String::from_utf8_lossy(&deleted.stderr)
    );
    let deleted: Value =
        serde_json::from_slice(&deleted.stdout).expect("destroy JSON remains on stdout");
    assert_eq!(deleted["phase"], "deleted");
    assert!(
        destroy_diagnostics.contains("waiting for namespace removal completed in"),
        "{destroy_diagnostics}"
    );
    let cluster: Value =
        serde_json::from_slice(&fs::read(root.path().join("cluster.json")).unwrap()).unwrap();
    assert!(
        cluster.get(ready["namespace"].as_str().unwrap()).is_none(),
        "successful destroy must remove the namespace"
    );
}

#[test]
fn list_shows_activity_and_keeps_full_records_with_json() {
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
        &["create", "coding-agent", "--no-repositories"],
    ));
    let shell = assert_ok(adm(
        root.path(),
        &["create", "shell-only", "--no-repositories"],
    ));
    let bot = assert_ok(adm(root.path(), &["create", "observer", "--role", "bot"]));

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
            && table.contains("AGENT CONFIG")
            && table.contains("ACTIVITY")
            && table.contains("ID"),
        "{table}"
    );
    for (name, role, agent, record) in [
        ("coding-agent", "coding", "needs_model", &coding),
        ("shell-only", "coding", "needs_model", &shell),
        ("observer", "bot", "needs_model", &bot),
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

    // A runner outage leaves stored records listable and never calls kubectl.
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
fn list_joins_activity_from_one_runner_directory_request() {
    let root = fixture();
    let needs_model = assert_ok(adm(
        root.path(),
        &["create", "disabled", "--no-repositories"],
    ));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let runner_url = format!("http://{}", listener.local_addr().unwrap());
    let creation_server = std::thread::spawn(move || {
        let mut ids = Vec::new();
        for _ in 0..8 {
            let (stream, _) = listener.accept().unwrap();
            let mut request = BufReader::new(stream);
            let mut line = String::new();
            request.read_line(&mut line).unwrap();
            let method = line.split_whitespace().next().unwrap().to_owned();
            let mut content_length = 0;
            loop {
                line.clear();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if line.to_ascii_lowercase().starts_with("content-length:") {
                    content_length = line.split(':').nth(1).unwrap().trim().parse().unwrap();
                }
            }
            let mut body = vec![0; content_length];
            request.read_exact(&mut body).unwrap();
            if method == "PUT" {
                ids.push(
                    serde_json::from_slice::<Value>(&body).unwrap()["id"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                );
            }
            let response = if method == "GET" {
                r#"{"status":"ok"}"#
            } else {
                "{}"
            };
            let mut stream = request.into_inner();
            write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
        ids
    });
    for name in ["idle", "running", "error", "missing"] {
        let created = adm_with_runner(
            root.path(),
            &runner_url,
            &["create", name, "--role", "bot", "--model", "faux/faux-1"],
        );
        assert!(
            created.status.success(),
            "{}",
            String::from_utf8_lossy(&created.stderr)
        );
    }
    let ids = creation_server.join().unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let runner_url = format!("http://{}", listener.local_addr().unwrap());
    let batch = serde_json::json!({"workspaces":[
        {"id":ids[0],"status":"idle"},
        {"id":ids[1],"status":"running"},
        {"id":ids[2],"status":"error","error":"provider token expired"}
    ]})
    .to_string();
    let request_server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut request = BufReader::new(stream);
        let mut line = String::new();
        request.read_line(&mut line).unwrap();
        let path = line.split_whitespace().nth(1).unwrap().to_owned();
        let mut stream = request.into_inner();
        write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{batch}", batch.len()).unwrap();
        path
    });
    let listed = adm_with_runner(root.path(), &runner_url, &["list", "--json"]);
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let listed: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(listed[0]["id"], needs_model["id"]);
    assert_eq!(listed[0]["activity"]["status"], "unavailable");
    for (name, activity) in [("idle", "idle"), ("running", "running"), ("error", "error")] {
        let row = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == name)
            .unwrap();
        assert_eq!(row["activity"]["status"], activity);
    }
    assert_eq!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == "error")
            .unwrap()["activity"]["error"],
        "provider token expired"
    );
    let missing = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "missing")
        .unwrap();
    assert_eq!(missing["activity"]["status"], "unavailable");
    assert!(
        missing["activity"]["error"]
            .as_str()
            .unwrap()
            .contains("directory omitted")
    );
    assert_eq!(request_server.join().unwrap(), "/v1/workspaces");

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let runner_url = format!("http://{}", listener.local_addr().unwrap());
    let running_id = ids[1].clone();
    let status_server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut request = BufReader::new(stream);
        let mut line = String::new();
        request.read_line(&mut line).unwrap();
        let path = line.split_whitespace().nth(1).unwrap().to_owned();
        let body = format!(r#"{{"id":"{running_id}","status":"running"}}"#);
        let mut stream = request.into_inner();
        write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
        path
    });
    let status = adm_with_runner(root.path(), &runner_url, &["status", "running", "--json"]);
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["activity"]["status"], "running");
    assert_eq!(status["agent"]["status"], "running");
    assert_eq!(
        status_server.join().unwrap(),
        format!("/v1/workspaces/{}", ids[1])
    );

    assert_ok(adm(root.path(), &["destroy", "disabled"]));
    let kubectl_contact = root.path().join("list-kubectl-contact");
    fs::write(
        root.path().join("kubectl"),
        format!("#!/bin/sh\ntouch '{}'\nexit 1\n", kubectl_contact.display()),
    )
    .unwrap();
    let all = adm_with_runner(
        root.path(),
        "http://127.0.0.1:1",
        &["list", "--all", "--json"],
    );
    assert!(all.status.success());
    let all: Value = serde_json::from_slice(&all.stdout).unwrap();
    let deleted = all
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "disabled")
        .unwrap();
    assert_eq!(deleted["phase"], "deleted");
    assert_eq!(deleted["activity"]["status"], "deleted");
    assert_eq!(
        all.as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == "running")
            .unwrap()["activity"]["status"],
        "unavailable"
    );
    assert!(!kubectl_contact.exists());
}

#[test]
fn shell_uses_public_cwd_as_an_argument_and_preserves_explicit_command_argv() {
    let root = fixture();
    assert_ok(adm(
        root.path(),
        &["create", "shell-cwd", "--no-repositories"],
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
fn create_can_prepare_a_public_repository_in_the_selected_workspace() {
    let root = fixture();
    let upstreams = root.path().join("upstreams");
    let upstream = upstreams.join("owner/project.git");
    fs::create_dir_all(upstream.parent().unwrap()).unwrap();
    let seed = root.path().join("seed");
    fs::create_dir_all(&seed).unwrap();
    fs::write(seed.join("README.md"), "fixture upstream\n").unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git").args(args).output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&[
        "init",
        "--bare",
        "--initial-branch=main",
        upstream.to_str().unwrap(),
    ]);
    git(&["init", "--initial-branch=main", seed.to_str().unwrap()]);
    git(&[
        "-C",
        seed.to_str().unwrap(),
        "config",
        "user.name",
        "Fixture User",
    ]);
    git(&[
        "-C",
        seed.to_str().unwrap(),
        "config",
        "user.email",
        "fixture@example.invalid",
    ]);
    git(&["-C", seed.to_str().unwrap(), "add", "README.md"]);
    git(&["-C", seed.to_str().unwrap(), "commit", "-m", "fixture"]);
    git(&[
        "-C",
        seed.to_str().unwrap(),
        "remote",
        "add",
        "origin",
        upstream.to_str().unwrap(),
    ]);
    git(&["-C", seed.to_str().unwrap(), "push", "-u", "origin", "main"]);

    let git_bin = root.path().join("git-bin");
    fs::create_dir_all(&git_bin).unwrap();
    let fail_after_clone = root.path().join("fail-after-clone");
    fs::write(&fail_after_clone, "once").unwrap();
    let git_path = String::from_utf8(Command::new("which").arg("git").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_owned();
    let wrapper = git_bin.join("git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nif [ \"$1\" = clone ] && [ -e \"$ADM_TEST_FAIL_AFTER_CLONE\" ]; then\n  shift\n  {git_path} clone --no-checkout \"$@\"\n  result=$?\n  rm \"$ADM_TEST_FAIL_AFTER_CLONE\"\n  [ \"$result\" -eq 0 ] || exit \"$result\"\n  exit 1\nfi\nexec {git_path} \"$@\"\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let runner_url = format!("http://{}", listener.local_addr().unwrap());
    let registration_path = root.path().join("registration.json");
    let server_path = registration_path.clone();
    let server = std::thread::spawn(move || {
        for request_number in 0..4 {
            let (stream, _) = listener.accept().unwrap();
            let mut request = BufReader::new(stream);
            let mut line = String::new();
            request.read_line(&mut line).unwrap();
            let method = line.split_whitespace().next().unwrap().to_owned();
            let mut content_length = 0;
            loop {
                line.clear();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if line.to_ascii_lowercase().starts_with("content-length:") {
                    content_length = line.split(':').nth(1).unwrap().trim().parse().unwrap();
                }
            }
            let mut body = vec![0; content_length];
            request.read_exact(&mut body).unwrap();
            if method == "PUT" {
                fs::write(&server_path, &body).unwrap();
            }
            let status = if request_number == 1 {
                "500 Internal Server Error"
            } else {
                "200 OK"
            };
            let response = if method == "GET" {
                r#"{"status":"ok"}"#
            } else {
                "{}"
            };
            let mut stream = request.into_inner();
            write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
                response.len()
            )
            .unwrap();
        }
    });
    let options = [
        "create",
        "repo-demo",
        "--model",
        "faux/faux-1",
        "--repo",
        "owner/project",
    ];
    let rewrite = format!("url.file://{}/.insteadOf", upstreams.display());
    let command = |arguments: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_adm"))
            .env("XDG_CONFIG_HOME", root.path().join("config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", &rewrite)
            .env("GIT_CONFIG_VALUE_0", "https://github.com/")
            .env("ADM_TEST_EXEC_ROOT", root.path().join("pv"))
            .env("ADM_TEST_FAIL_AFTER_CLONE", &fail_after_clone)
            .env(
                "PATH",
                format!("{}:/usr/local/bin:/usr/bin:/bin", git_bin.display()),
            )
            .arg("--state-dir")
            .arg(root.path().join("state"))
            .arg("--kubectl")
            .arg(root.path().join("kubectl"))
            .arg("--runner-url")
            .arg(&runner_url)
            .args(arguments)
            .output()
            .unwrap()
    };
    let typo_options = [
        "create",
        "typo-demo",
        "--model",
        "faux/faux-1",
        "--repo",
        "owner/missing",
    ];
    let typo = command(&typo_options);
    assert!(!typo.status.success());
    let typo_stderr = String::from_utf8_lossy(&typo.stderr);
    assert!(typo_stderr.contains("owner/missing"), "{typo_stderr}");
    assert!(
        typo_stderr.contains("preparing repository"),
        "{typo_stderr}"
    );
    assert!(
        typo_stderr.contains("does not appear to be a git repository"),
        "{typo_stderr}"
    );
    assert!(typo_stderr.contains("inspect"), "{typo_stderr}");
    assert!(typo_stderr.contains("destroy"), "{typo_stderr}");
    assert!(!typo_stderr.contains("set -eu"), "{typo_stderr}");
    let failed = assert_ok(adm(root.path(), &["list", "--json"]))
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["name"] == "typo-demo")
        .unwrap()
        .clone();
    assert_eq!(failed["phase"], "failed");
    let persisted_error = failed["last_error"].as_str().unwrap();
    assert!(
        persisted_error.contains("owner/missing"),
        "{persisted_error}"
    );
    assert!(
        persisted_error.contains("does not appear to be a git repository"),
        "{persisted_error}"
    );
    assert!(!persisted_error.contains("set -eu"), "{persisted_error}");
    assert!(
        !registration_path.exists(),
        "failed clone must not admit the agent"
    );
    let changed_repo = command(&[
        "create",
        "typo-demo",
        "--model",
        "faux/faux-1",
        "--repo",
        "owner/project",
    ]);
    assert!(!changed_repo.status.success());
    let changed_repo_error = String::from_utf8_lossy(&changed_repo.stderr);
    assert!(
        changed_repo_error.contains("inspect"),
        "{changed_repo_error}"
    );
    assert!(
        changed_repo_error.contains("destroy"),
        "{changed_repo_error}"
    );
    assert!(
        changed_repo_error.contains("recreating"),
        "{changed_repo_error}"
    );
    let no_repository = command(&["create", "typo-demo", "--model", "faux/faux-1"]);
    assert!(!no_repository.status.success());
    let no_repository_error = String::from_utf8_lossy(&no_repository.stderr);
    assert!(
        no_repository_error.contains("recreating without --repo"),
        "{no_repository_error}"
    );
    assert!(
        !no_repository_error.contains("--repo none"),
        "{no_repository_error}"
    );
    fs::write(&fail_after_clone, "once").unwrap();

    let interrupted = command(&options);
    assert!(
        !interrupted.status.success(),
        "clone interruption must fail creation"
    );
    let workspace = assert_ok(adm(root.path(), &["list", "--json"]))
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["name"] == "repo-demo")
        .unwrap()
        .clone();
    assert_eq!(workspace["phase"], "failed");
    let repos = root
        .path()
        .join("pv")
        .join(workspace["namespace"].as_str().unwrap())
        .join("repos");
    let staging = repos
        .join("owner")
        .join(format!(".adm-clone-{}", workspace["id"].as_str().unwrap()));
    assert!(
        staging.join(".git").exists() && !staging.join("README.md").exists(),
        "interrupted clone should retain Git metadata without a checkout"
    );

    let failed_registration = command(&options);
    assert!(
        !failed_registration.status.success(),
        "runner failure must keep creation failed"
    );
    let checkout = repos.join("owner/project");
    assert_eq!(
        fs::read_to_string(checkout.join("README.md")).unwrap_or_else(|error| panic!(
            "{error}; workspace files={:?}, stdout={}, stderr={}",
            fs::read_dir(&repos)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>(),
            String::from_utf8_lossy(&failed_registration.stdout),
            String::from_utf8_lossy(&failed_registration.stderr)
        )),
        "fixture upstream\n",
        "workspace files={:?}, stdout={}, stderr={}",
        fs::read_dir(&repos)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>(),
        String::from_utf8_lossy(&failed_registration.stdout),
        String::from_utf8_lossy(&failed_registration.stderr)
    );
    fs::write(checkout.join("README.md"), "local workspace edit\n").unwrap();

    let ready = command(&options);
    assert!(
        ready.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&ready.stdout),
        String::from_utf8_lossy(&ready.stderr)
    );
    let create_guidance = String::from_utf8_lossy(&ready.stderr);
    assert!(
        create_guidance.contains("adm shell repo-demo"),
        "{create_guidance}"
    );
    let workspace = assert_ok(ready);
    assert_eq!(workspace["repository"], "owner/project");
    assert_eq!(workspace["cwd"], "/repos/owner/project");
    assert_eq!(workspace["phase"], "ready");
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.path().join("last-manifest.json")).unwrap()).unwrap();
    let deployment = manifest["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "Deployment")
        .unwrap();
    let pod = &deployment["spec"]["template"]["spec"];
    assert_eq!(pod["containers"][0]["workingDir"], "/repos");
    assert_eq!(
        pod["containers"].as_array().unwrap().len(),
        1,
        "normal checkout must not add the FUSE sidecar"
    );
    assert_eq!(
        fs::read_to_string(checkout.join("README.md")).unwrap(),
        "local workspace edit\n"
    );
    let branch = Command::new("git")
        .args(["-C", checkout.to_str().unwrap(), "branch", "--show-current"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&branch.stdout).trim(), "main");
    let registration: Value =
        serde_json::from_slice(&fs::read(registration_path).unwrap()).unwrap();
    assert_eq!(registration["cwd"], "/repos/owner/project");
    server.join().unwrap();

    let inspected = adm_with_runner(root.path(), &runner_url, &["inspect", "repo-demo"]);
    assert!(
        inspected.status.success(),
        "{}",
        String::from_utf8_lossy(&inspected.stderr)
    );
    let inspected = String::from_utf8_lossy(&inspected.stdout);
    assert!(
        inspected.contains("Repository: owner/project"),
        "{inspected}"
    );
    assert!(
        inspected.contains("Working directory: /repos/owner/project"),
        "{inspected}"
    );

    let other = adm_with_runner_env(
        root.path(),
        &runner_url,
        &["create", "repo-other", "--repo", "owner/project"],
        (&rewrite, "https://github.com/"),
    );
    let other_guidance = String::from_utf8_lossy(&other.stderr);
    assert!(
        other_guidance.contains("adm shell repo-other"),
        "{other_guidance}"
    );
    assert!(
        !other_guidance.contains("agent starts there"),
        "{other_guidance}"
    );
    let other = assert_ok(other);
    let other_readme = root
        .path()
        .join("pv")
        .join(other["namespace"].as_str().unwrap())
        .join("repos/owner/project/README.md");
    assert_eq!(
        fs::read_to_string(other_readme).unwrap(),
        "fixture upstream\n"
    );

    let shell = adm(root.path(), &["shell", "repo-demo"]);
    assert!(
        shell.status.success(),
        "{}",
        String::from_utf8_lossy(&shell.stderr)
    );
    let guidance = String::from_utf8_lossy(&shell.stderr);
    assert!(guidance.contains("/repos/owner/project"), "{guidance}");
    assert!(guidance.contains("private to this workspace"), "{guidance}");
    let args: Value =
        serde_json::from_slice(&fs::read(root.path().join("exec-args.json")).unwrap()).unwrap();
    assert_eq!(
        args.as_array().unwrap().last().unwrap(),
        "/repos/owner/project"
    );
}

#[test]
fn destruction_during_repository_preparation_cannot_restore_a_deleted_workspace() {
    use std::time::{Duration, Instant};

    let root = fixture();
    let block = root.path().join("block-repository-exec");
    fs::write(&block, "wait").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let runner_url = format!("http://{}", listener.local_addr().unwrap());
    let runner = std::thread::spawn(move || {
        for _ in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            let mut request = BufReader::new(stream);
            let mut line = String::new();
            request.read_line(&mut line).unwrap();
            let method = line.split_whitespace().next().unwrap().to_owned();
            let mut content_length = 0;
            loop {
                line.clear();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if line.to_ascii_lowercase().starts_with("content-length:") {
                    content_length = line.split(':').nth(1).unwrap().trim().parse().unwrap();
                }
            }
            let mut body = vec![0; content_length];
            request.read_exact(&mut body).unwrap();
            let (status, response) = if method == "GET" {
                ("200 OK", r#"{"status":"ok"}"#)
            } else {
                (
                    "404 Not Found",
                    r#"{"error":{"code":"WORKSPACE_NOT_FOUND","message":"Unknown workspace"}}"#,
                )
            };
            let mut stream = request.into_inner();
            write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
                response.len()
            )
            .unwrap();
        }
    });
    let create = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("ADM_TEST_EXEC_ROOT", root.path().join("pv"))
        .env("ADM_TEST_BLOCK_EXEC", &block)
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .arg("--runner-url")
        .arg(&runner_url)
        .args([
            "create",
            "delete-during-repo",
            "--model",
            "faux/faux-1",
            "--repo",
            "owner/project",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let entered = root.path().join("block-repository-exec.entered");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !entered.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        entered.exists(),
        "create never reached repository preparation"
    );

    let deleted = adm_with_runner(root.path(), &runner_url, &["destroy", "delete-during-repo"]);
    assert!(
        deleted.status.success(),
        "{}",
        String::from_utf8_lossy(&deleted.stderr)
    );
    fs::write(format!("{}.release", block.display()), "continue").unwrap();
    let create = create.wait_with_output().unwrap();
    assert!(
        !create.status.success(),
        "creation must stop after its namespace is deleted"
    );
    let records = assert_ok(adm(root.path(), &["list", "--json", "--all"]));
    assert_eq!(records[0]["phase"], "deleted");
    runner.join().unwrap();
}

#[test]
fn destroy_does_not_treat_a_runner_error_mentioning_410_as_cancellation() {
    let root = fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &["create", "runner-error", "--no-repositories"],
    ));
    let database = rusqlite::Connection::open(root.path().join("state/workspaces.sqlite")).unwrap();
    let mut spec: Value = serde_json::from_str(
        &database
            .query_row(
                "SELECT spec FROM workspaces WHERE name='runner-error'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    spec["agent_enabled"] = Value::Bool(true);
    database
        .execute(
            "UPDATE workspaces SET spec=?1 WHERE name='runner-error'",
            [spec.to_string()],
        )
        .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let runner_url = format!("http://{}", listener.local_addr().unwrap());
    let runner = std::thread::spawn(move || {
        for request_number in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            let mut request = BufReader::new(stream);
            let mut line = String::new();
            request.read_line(&mut line).unwrap();
            let method = line.split_whitespace().next().unwrap().to_owned();
            loop {
                line.clear();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let (status, response) = if request_number == 0 && method == "GET" {
                ("200 OK", r#"{"status":"ok"}"#)
            } else {
                (
                    "500 Internal Server Error",
                    r#"{"error":{"code":"INTERNAL","message":"upstream mentioned 410 while failing"}}"#,
                )
            };
            let mut stream = request.into_inner();
            write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
                response.len()
            )
            .unwrap();
        }
    });
    let deleted = adm_with_runner(root.path(), &runner_url, &["destroy", "runner-error"]);
    runner.join().unwrap();
    assert!(
        !deleted.status.success(),
        "a 500 mentioning 410 must not authorize runtime deletion"
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json", "--all"]))[0]["phase"],
        "deleting"
    );
    let cluster: Value =
        serde_json::from_slice(&fs::read(root.path().join("cluster.json")).unwrap()).unwrap();
    assert!(
        cluster
            .get(workspace["namespace"].as_str().unwrap())
            .is_some(),
        "the namespace must remain while runner cancellation is unconfirmed"
    );
}

#[test]
fn workspace_navigation_guidance_keeps_json_and_explicit_shell_argv_intact() {
    let root = fixture();
    let created = adm(root.path(), &["create", "navigation", "--no-repositories"]);
    assert!(created.status.success(), "{created:?}");
    let workspace: Value =
        serde_json::from_slice(&created.stdout).expect("create keeps its workspace JSON on stdout");
    assert_eq!(workspace["name"], "navigation");
    let guidance = String::from_utf8_lossy(&created.stderr);
    assert!(guidance.contains("/repos"), "{guidance}");
    assert!(guidance.contains("clone"), "{guidance}");
    assert!(guidance.contains("adm shell navigation"), "{guidance}");

    let exec_root = root.path().join("workspace-fixture");
    let populate = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("ADM_TEST_EXEC_ROOT", &exec_root)
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .args(["exec", "navigation", "--", "touch", "existing-work"])
        .output()
        .unwrap();
    assert!(populate.status.success(), "{populate:?}");
    assert!(
        exec_root
            .join(workspace["namespace"].as_str().unwrap())
            .join("repos/existing-work")
            .exists()
    );
    let shell = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .args(["shell", "navigation"])
        .output()
        .unwrap();
    assert!(shell.status.success(), "{shell:?}");
    let shell_guidance = String::from_utf8_lossy(&shell.stderr);
    assert!(
        shell_guidance.contains("opening shell at /repos"),
        "{shell_guidance}"
    );
    assert!(
        !shell_guidance.contains("empty writable"),
        "{shell_guidance}"
    );

    let catalog = root.path().join("catalog.json");
    fs::write(&catalog, r#"{"repositories":[]}"#).unwrap();
    let catalog = adm(
        root.path(),
        &[
            "create",
            "catalog-navigation",
            "--catalog",
            catalog.to_str().unwrap(),
        ],
    );
    assert!(catalog.status.success(), "{catalog:?}");
    let catalog_guidance = String::from_utf8_lossy(&catalog.stderr);
    assert!(
        catalog_guidance.contains("Lazy catalog"),
        "{catalog_guidance}"
    );
    assert!(
        catalog_guidance.contains("cd /repos/OWNER/REPO"),
        "{catalog_guidance}"
    );

    let command = [
        "shell",
        "navigation",
        "--",
        "printf",
        "%s",
        "argument with spaces",
    ];
    let opened = adm(root.path(), &command);
    assert!(opened.status.success(), "{opened:?}");
    let args: Value =
        serde_json::from_slice(&fs::read(root.path().join("exec-args.json")).unwrap()).unwrap();
    let actual = args.as_array().unwrap();
    let command_start = actual.iter().position(|arg| arg == "--").unwrap() + 1;
    assert_eq!(
        &actual[command_start..],
        ["printf", "%s", "argument with spaces"]
    );
}

#[test]
fn managed_shell_client_is_scoped_and_closes_without_aborting_the_agent() {
    let output = Command::new("node")
        .arg("tests/shell-management.test.mjs")
        .arg(env!("CARGO_BIN_EXE_adm"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("run managed shell public CLI scenario");
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn public_cli_rejects_unsafe_names_before_touching_the_cluster() {
    let root = tempfile::tempdir().unwrap();
    for name in ["../escape", "UPPER", "a/b", "", "bad name"] {
        let output = adm(root.path(), &["create", name, "--no-repositories"]);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("name"));
    }
}

#[test]
fn agent_workspace_can_be_created_before_a_model_is_selected() {
    let root = fixture();
    let output = adm(root.path(), &["create", "needs-model"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let workspace: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(workspace["agent_enabled"], true);
    assert!(workspace["model"].is_null());
    assert_eq!(workspace["phase"], "ready");
}

#[test]
fn workspace_lifecycle_retains_tombstones_and_reused_names_get_new_identities() {
    let root = fixture();
    let first = assert_ok(adm(root.path(), &["create", "demo", "--no-repositories"]));
    assert_eq!(first["name"], "demo");
    assert_eq!(first["phase"], "ready");
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"]))[0]["id"],
        first["id"]
    );
    let duplicate = adm(root.path(), &["create", "demo", "--no-repositories"]);
    assert!(
        !duplicate.status.success(),
        "duplicate names must be explicit errors"
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["status", "demo", "--json"]))["workspace"]["id"],
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
    let second = assert_ok(adm(root.path(), &["create", "demo", "--no-repositories"]));
    assert_ne!(first["id"], second["id"]);
}

#[test]
fn status_is_concise_and_inspect_and_json_preserve_the_full_record() {
    let root = fixture();
    let coding = assert_ok(adm(root.path(), &["create", "demo", "--no-repositories"]));
    let bot = assert_ok(adm(root.path(), &["create", "supervisor", "--role", "bot"]));

    let status = adm(root.path(), &["status", "demo"]);
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(
        status.contains("NAME")
            && status.contains("ROLE")
            && status.contains("PHASE")
            && status.contains("RUNTIME")
            && status.contains("ACTIVITY")
            && status.contains("NODE"),
        "{status}"
    );
    assert!(
        status.contains("demo")
            && status.contains("coding")
            && status.contains("NotReady (Running)")
            && status.contains("Runtime readiness: NotReady (Running)")
            && status.contains("needs_model")
            && status.contains("node-a")
            && status.contains(&format!("ID: {}", coding["id"].as_str().unwrap()))
            && status.contains("Namespace:")
            && status.contains("Resources: CPU 2, memory 2Gi, storage 4Gi")
            && status.contains("ContainersNotReady"),
        "{status}"
    );
    assert!(
        !status.contains("\"workspace\""),
        "status should be a concise human summary: {status}"
    );

    fs::write(root.path().join("ready-pod"), "ready").unwrap();
    let ready = adm(root.path(), &["status", "demo"]);
    assert!(
        ready.status.success(),
        "{}",
        String::from_utf8_lossy(&ready.stderr)
    );
    let ready = String::from_utf8_lossy(&ready.stdout);
    let pod_row = ready.lines().nth(1).unwrap_or("");
    assert!(
        pod_row.contains("Ready") && !pod_row.contains("NotReady"),
        "{ready}"
    );

    fs::remove_file(root.path().join("ready-pod")).unwrap();
    fs::write(root.path().join("init-waiting"), "waiting").unwrap();
    let init_waiting = adm(root.path(), &["status", "demo"]);
    assert!(
        init_waiting.status.success(),
        "{}",
        String::from_utf8_lossy(&init_waiting.stderr)
    );
    let init_waiting = String::from_utf8_lossy(&init_waiting.stdout);
    assert!(
        init_waiting.contains("ImagePullBackOff")
            && init_waiting.contains("could not pull setup image"),
        "{init_waiting}"
    );

    let full = assert_ok(adm(root.path(), &["status", "demo", "--json"]));
    assert_eq!(full["workspace"]["id"], coding["id"]);
    assert_eq!(full["cluster"]["pods"][0]["status"]["phase"], "Running");
    assert_eq!(full["agent"]["status"], "needs_model");
    assert_eq!(full["activity"]["status"], "needs_model");
    assert_eq!(
        assert_ok(adm(root.path(), &["inspect", "demo", "--json"])),
        full
    );

    let inspect = adm(root.path(), &["inspect", "demo"]);
    assert!(
        inspect.status.success(),
        "{}",
        String::from_utf8_lossy(&inspect.stderr)
    );
    let inspect = String::from_utf8_lossy(&inspect.stdout);
    assert!(
        inspect.contains("Workspace")
            && inspect.contains("Namespace")
            && inspect.contains("Pod")
            && inspect.contains("workspace-123")
            && inspect.contains("Agent"),
        "{inspect}"
    );
    assert!(
        !inspect.contains("\"workspace\""),
        "inspect should label details for people: {inspect}"
    );

    let bot_status = adm(root.path(), &["status", "supervisor"]);
    assert!(
        bot_status.status.success(),
        "{}",
        String::from_utf8_lossy(&bot_status.stderr)
    );
    let bot_status = String::from_utf8_lossy(&bot_status.stdout);
    assert!(
        bot_status.contains("bot")
            && bot_status.contains("n/a")
            && bot_status.contains("management host")
            && bot_status.contains("needs_model"),
        "{bot_status}"
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["status", "supervisor", "--json"]))["workspace"]["id"],
        bot["id"]
    );
    let bot_inspect = adm(root.path(), &["inspect", "supervisor"]);
    assert!(
        bot_inspect.status.success(),
        "{}",
        String::from_utf8_lossy(&bot_inspect.stderr)
    );
    let bot_inspect = String::from_utf8_lossy(&bot_inspect.stdout);
    assert!(
        bot_inspect.contains("Location: management host (no workspace Pod)"),
        "{bot_inspect}"
    );

    assert_ok(adm(root.path(), &["destroy", "supervisor"]));
    let deleted_bot = adm(root.path(), &["status", "supervisor"]);
    assert!(deleted_bot.status.success());
    let deleted_bot = String::from_utf8_lossy(&deleted_bot.stdout);
    assert!(
        deleted_bot.contains("Runtime readiness: deleted"),
        "{deleted_bot}"
    );
    assert!(
        deleted_bot.contains("Agent activity: deleted"),
        "{deleted_bot}"
    );

    assert_eq!(
        assert_ok(adm(root.path(), &["destroy", "demo"]))["phase"],
        "deleted"
    );
    let deleted = adm(root.path(), &["status", "demo"]);
    assert!(
        deleted.status.success(),
        "{}",
        String::from_utf8_lossy(&deleted.stderr)
    );
    assert!(String::from_utf8_lossy(&deleted.stdout).contains("deleted"));
    let deleted_inspect = adm(root.path(), &["inspect", "demo"]);
    assert!(
        deleted_inspect.status.success(),
        "{}",
        String::from_utf8_lossy(&deleted_inspect.stderr)
    );
    let deleted_inspect = String::from_utf8_lossy(&deleted_inspect.stdout);
    assert!(
        deleted_inspect.contains("Runtime: destroyed")
            && !deleted_inspect.contains("Location: management host"),
        "{deleted_inspect}"
    );
    let missing = adm(root.path(), &["status", "never-created"]);
    assert!(
        !missing.status.success(),
        "missing resources must remain distinguishable from tombstones"
    );
}

#[test]
fn status_distinguishes_agent_provider_errors_from_unavailable_runner() {
    let root = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let runner_url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || serve_runner_status_fixture(listener));

    let created = adm_with_runner(
        root.path(),
        &runner_url,
        &[
            "create",
            "supervisor",
            "--role",
            "bot",
            "--model",
            "faux/faux-1",
        ],
    );
    assert!(
        created.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&created.stdout),
        String::from_utf8_lossy(&created.stderr)
    );
    let status = adm_with_runner(root.path(), &runner_url, &["status", "supervisor"]);
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(
        status.contains("ACTIVITY")
            && status.contains("error")
            && status.contains("Agent failure: provider token expired"),
        "{status}"
    );
    assert!(!status.contains("Agent unavailable"), "{status}");
    server.join().unwrap();

    let unavailable = adm_with_runner(
        root.path(),
        "http://127.0.0.1:1",
        &["status", "supervisor", "--json"],
    );
    assert!(unavailable.status.success());
    let unavailable: Value = serde_json::from_slice(&unavailable.stdout).unwrap();
    assert_eq!(unavailable["activity"]["status"], "unavailable");
    assert_eq!(
        unavailable["activity"]["error"], unavailable["agent"]["error"],
        "normalized activity keeps the actual runner failure cause"
    );
    assert!(
        unavailable["activity"]["error"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("connection refused"),
        "{unavailable}"
    );
}

#[test]
fn retrying_a_partially_applied_creation_resumes_the_same_workspace() {
    let root = fixture();
    fs::write(root.path().join("fail-wait-once"), "fail").unwrap();

    let first = adm(root.path(), &["create", "retry-me", "--no-repositories"]);
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
    assert_eq!(failed[0]["activity"]["status"], "unavailable");
    assert!(failed[0]["last_error"].as_str().is_some());
    let failure_status = adm(root.path(), &["status", "retry-me"]);
    assert!(failure_status.status.success());
    let failure_status = String::from_utf8_lossy(&failure_status.stdout);
    assert!(
        failure_status.contains("Workspace failure:"),
        "{failure_status}"
    );
    assert!(
        failure_status.contains("deployment did not become available"),
        "{failure_status}"
    );

    let retried = assert_ok(adm(
        root.path(),
        &["create", "retry-me", "--no-repositories"],
    ));
    assert_eq!(retried["phase"], "ready");
    assert_eq!(retried["id"], original_id);
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"]))[0]["id"],
        original_id
    );
}

#[test]
fn failed_creation_retry_keeps_the_standard_workspace_security_policy() {
    let root = fixture();
    fs::write(root.path().join("fail-wait-once"), "fail").unwrap();

    let first = adm(root.path(), &["create", "sudo-choice", "--no-repositories"]);
    assert!(!first.status.success());
    let saved = assert_ok(adm(root.path(), &["list", "--json"]));
    let original_id = saved[0]["id"].clone();

    let retry = assert_ok(adm(
        root.path(),
        &["create", "sudo-choice", "--no-repositories"],
    ));
    assert_eq!(retry["id"], original_id);
    assert_eq!(retry["phase"], "ready");
}

#[test]
fn retrying_creation_refuses_to_overwrite_a_namespace_with_changed_ownership() {
    let root = fixture();
    fs::write(root.path().join("fail-wait-once"), "fail").unwrap();
    let first = adm(root.path(), &["create", "retry-safe", "--no-repositories"]);
    assert!(!first.status.success());
    let failed = assert_ok(adm(root.path(), &["list", "--json"]));
    let namespace = failed[0]["namespace"].as_str().unwrap();
    let cluster_path = root.path().join("cluster.json");
    let mut cluster: Value = serde_json::from_slice(&fs::read(&cluster_path).unwrap()).unwrap();
    cluster[namespace]["metadata"]["labels"]["adm.dev/workspace-id"] = "someone-else".into();
    fs::write(&cluster_path, serde_json::to_vec(&cluster).unwrap()).unwrap();

    let retry = adm(root.path(), &["create", "retry-safe", "--no-repositories"]);
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
    let workspace = assert_ok(adm(root.path(), &["create", "safe", "--no-repositories"]));
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
        &["create", "herdr-owned", "--no-repositories"],
    ));
    let other_workspace = assert_ok(adm(
        root.path(),
        &["create", "herdr-other", "--no-repositories"],
    ));
    let stale_workspace = assert_ok(adm(
        root.path(),
        &["create", "herdr-stale", "--no-repositories"],
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
        assert_ok(adm(root.path(), &["status", "herdr-other", "--json"]))["workspace"]["phase"],
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
        &["create", "journaled", "--no-repositories"],
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
        &["create", "browser-safe", "--no-repositories"],
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
        &["create", "herdr-owned", "--no-repositories"],
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
        assert_ok(adm(root.path(), &["status", "herdr-owned", "--json"]))["workspace"]["phase"],
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
        &["create", "offline-status", "--no-repositories"],
    ));
    fs::write(root.path().join("fail-status"), "offline").unwrap();

    let human = adm(root.path(), &["status", "offline-status"]);
    assert!(
        human.status.success(),
        "{}",
        String::from_utf8_lossy(&human.stderr)
    );
    let human = String::from_utf8_lossy(&human.stdout);
    assert!(
        human.contains("offline-status")
            && human.contains("unavailable")
            && human.contains("connection refused"),
        "{human}"
    );

    let status = assert_ok(adm(root.path(), &["status", "offline-status", "--json"]));
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
fn manifest_gives_the_workspace_unattended_container_administration() {
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
    assert_eq!(
        dev.get("command"),
        None,
        "Kubernetes must preserve the workspace image's tini entrypoint so it forwards termination signals"
    );
    assert_eq!(dev["securityContext"]["runAsUser"], 1000);
    assert_eq!(dev["securityContext"]["runAsGroup"], 1000);
    assert_eq!(dev["securityContext"]["runAsNonRoot"], true);
    assert_eq!(dev["securityContext"]["allowPrivilegeEscalation"], true);
    assert_eq!(dev["securityContext"]["capabilities"]["drop"][0], "ALL");
    assert_eq!(
        dev["securityContext"]["capabilities"]["add"],
        serde_json::json!(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"])
    );
    assert_eq!(
        dev["securityContext"]["seccompProfile"]["type"],
        "RuntimeDefault"
    );
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
fn sudo_is_the_standard_workspace_policy_and_has_no_opt_in_flag() {
    let root = tempfile::tempdir().unwrap();
    let manifest = assert_ok(adm(root.path(), &["manifest", "normal"]));
    let forbidden = adm(root.path(), &["manifest", "normal", "--allow-sudo"]);
    assert!(
        !forbidden.status.success(),
        "the obsolete opt-in flag must be removed"
    );
    assert!(String::from_utf8_lossy(&forbidden.stderr).contains("unexpected argument"));
    let dev = &manifest["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "Deployment")
        .unwrap()["spec"]["template"]["spec"]["containers"][0];
    assert_eq!(dev["securityContext"]["allowPrivilegeEscalation"], true);
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

    let fixture = fixture();
    for (args, error) in [
        (
            vec!["create", "bad-repo", "--repo", "owner//project"],
            "repository name",
        ),
        (
            vec![
                "create",
                "no-repos",
                "--no-repositories",
                "--repo",
                "owner/project",
            ],
            "--no-repositories",
        ),
        (
            vec![
                "create",
                "bot-repo",
                "--role",
                "bot",
                "--repo",
                "owner/project",
            ],
            "coding workspaces",
        ),
        (
            vec![
                "create",
                "catalog-repo",
                "--catalog",
                catalog.to_str().unwrap(),
                "--repo",
                "owner/project",
            ],
            "--catalog",
        ),
    ] {
        let output = adm(fixture.path(), &args);
        assert!(!output.status.success(), "args={args:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(error),
            "args={args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(
        assert_ok(adm(fixture.path(), &["list", "--json"]))
            .as_array()
            .unwrap()
            .len(),
        0,
        "invalid repository requests must fail before provisioning"
    );
    assert_ok(adm(
        fixture.path(),
        &["manifest", "punctuation", "--repo", "_owner/project."],
    ));
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
    let output = adm(root.path(), &["create", "demo"]);
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

#[test]
fn manifest_delivers_only_referenced_workspace_credentials_to_the_dev_pod() {
    let root = tempfile::tempdir().unwrap();
    let manifest = assert_ok(adm(
        root.path(),
        &[
            "manifest",
            "example",
            "--credential-env",
            "OPENAI_API_KEY=provider-auth:openai",
        ],
    ));
    let items = manifest["items"].as_array().unwrap();
    let deployment = items
        .iter()
        .find(|item| item["kind"] == "Deployment")
        .unwrap();
    let dev = &deployment["spec"]["template"]["spec"]["containers"][0];
    assert_eq!(dev["env"][0]["name"], "OPENAI_API_KEY");
    assert_eq!(
        dev["env"][0]["valueFrom"]["secretKeyRef"]["name"],
        "provider-auth"
    );
    assert_eq!(dev["env"][0]["valueFrom"]["secretKeyRef"]["key"], "openai");
    let serialized = serde_json::to_string(&manifest).unwrap();
    assert!(!serialized.contains("synthetic"));
    assert!(!serialized.contains("OPENAI_API_KEY="));
}
