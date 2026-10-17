use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::{PermissionsExt, symlink},
    os::unix::net::UnixListener,
    path::Path,
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

struct TestFixture {
    root: TempDir,
    lifecycle: std::process::Child,
    runner_port: u16,
    runner: Option<std::thread::JoinHandle<()>>,
}

impl TestFixture {
    fn path(&self) -> &Path {
        self.root.path()
    }
}

impl Drop for TestFixture {
    fn drop(&mut self) {
        let _ = self.lifecycle.kill();
        let _ = self.lifecycle.wait();
        let _ = reqwest::blocking::get(format!("http://127.0.0.1:{}/shutdown", self.runner_port));
        if let Some(runner) = self.runner.take() {
            let _ = runner.join();
        }
    }
}

#[test]
fn start_rejects_host_agent_execution() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .arg("--state-dir")
        .arg(root.path())
        .arg("--runner-url")
        .arg("http://127.0.0.1:9")
        .arg("start")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("workspace Pods"),
        "start must direct the operator to workspace-Pod execution"
    );
    assert!(!root.path().join("runner/owner.json").exists());
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
    let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
    let herdr_bin = root.join("herdr-bin");
    let fixture_path = format!(
        "{}:{}",
        herdr_bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    command
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("PATH", fixture_path)
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"))
        // Public CLI fixtures must not contact a host or shared runner.
        .args(["--runner-url"])
        .arg(
            fs::read_to_string(root.join("runner-url"))
                .unwrap_or_else(|_| "http://127.0.0.1:1".into()),
        );
    configure_lifecycle(&mut command, root);
    command.args(arguments);
    command.output().expect("run public CLI")
}

fn configure_lifecycle(command: &mut Command, root: &Path) {
    let url = root.join("lifecycle-url");
    if url.exists() {
        command
            .arg("--lifecycle-url")
            .arg(fs::read_to_string(url).unwrap())
            .arg("--lifecycle-token-file")
            .arg(root.join("lifecycle-token"));
    }
}

fn start_runner_stub() -> (String, u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            let header_end = loop {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break None;
                }
                request.extend_from_slice(&chunk[..count]);
                if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break Some(end + 4);
                }
            };
            let Some(header_end) = header_end else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            while request.len() < header_end + content_length {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
            }
            let first_line = headers.lines().next().unwrap_or("");
            if first_line.starts_with("GET /shutdown ") {
                break;
            }
            let body = if first_line.starts_with("GET /health ") {
                r#"{"status":"ok"}"#
            } else {
                r#"{"ok":true}"#
            };
            write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
    });
    (format!("http://127.0.0.1:{port}"), port, server)
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

#[test]
fn zsh_completions_are_generated_offline() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("ADM_STATE_DIR", root.path().join("state"))
        .args(["completions", "zsh"])
        .output()
        .expect("generate completions through the public CLI");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let script = String::from_utf8(output.stdout).unwrap();
    assert!(script.contains("_adm"));
    assert!(script.contains("lifecycle-serve"));
}

fn adm_with_runner(root: &Path, runner_url: &str, arguments: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
    command
        .env("XDG_CONFIG_HOME", root.join("config"))
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"))
        .arg("--runner-url")
        .arg(runner_url)
        .args(arguments);
    configure_lifecycle(&mut command, root);
    command
        .output()
        .expect("run public CLI with runner fixture")
}

fn adm_with_input(root: &Path, arguments: &[&str], input: &str) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
    command
        .env("XDG_CONFIG_HOME", root.join("config"))
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"))
        .args(arguments);
    configure_lifecycle(&mut command, root);
    let mut child = command
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

fn fixture() -> TestFixture {
    fixture_with_runner(None)
}

fn fixture_with_runner(runner_override: Option<&str>) -> TestFixture {
    let root = tempfile::tempdir().unwrap();
    let herdr_bin = root.path().join("herdr-bin");
    fs::create_dir_all(&herdr_bin).unwrap();
    let herdr = herdr_bin.join("herdr");
    fs::write(
        &herdr,
        "#!/bin/sh\nprintf '{\"result\":{\"workspace\":{\"workspace_id\":\"%s\"}}}\\n' \"$3\"\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&herdr).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&herdr, permissions).unwrap();
    let (default_runner_url, runner_port, runner) = start_runner_stub();
    let runner_url = runner_override.unwrap_or(&default_runner_url);
    fs::write(root.path().join("runner-url"), runner_url).unwrap();
    let kubectl = root.path().join("kubectl");
    fs::write(root.path().join("offline-token"), "fixture-token\n").unwrap();
    fs::write(&kubectl, r##"#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
path = pathlib.Path(__file__).parent / 'cluster.json'
state = json.loads(path.read_text()) if path.exists() else {}
args = sys.argv[1:]
args = [arg for arg in args if not arg.startswith('--request-timeout=')]
def wait_for_release(stage):
    if not (pathlib.Path(__file__).parent / ('delay-'+stage)).exists(): return
    entered=pathlib.Path(__file__).parent / ('entered-'+stage)
    release=pathlib.Path(__file__).parent / ('release-'+stage)
    if release.exists(): return
    entered.write_text('waiting')
    while not release.exists():
        __import__('time').sleep(0.01)
if args[:2] == ['get','lease']:
    lease=pathlib.Path(__file__).parent / 'lease.json'
    if not lease.exists(): print('Error from server (NotFound): leases not found',file=sys.stderr);sys.exit(1)
    print(lease.read_text())
elif args[:2] == ['create','-f']:
    lease=json.load(sys.stdin); lease['metadata']['resourceVersion']='1'
    (pathlib.Path(__file__).parent / 'lease.json').write_text(json.dumps(lease));print(json.dumps(lease))
elif args[:2] == ['replace','-f']:
    lease=json.load(sys.stdin); leasepath=pathlib.Path(__file__).parent / 'lease.json'
    current=json.loads(leasepath.read_text())
    if lease['metadata'].get('resourceVersion') != current['metadata']['resourceVersion']:
        print('Error from server (Conflict): resourceVersion conflict',file=sys.stderr);sys.exit(1)
    lease['metadata']['resourceVersion']=str(int(current['metadata']['resourceVersion'])+1)
    leasepath.write_text(json.dumps(lease));print(json.dumps(lease))
elif args[:2] == ['get','pods'] and '-n' in args:
    ready = (pathlib.Path(__file__).parent / 'ready-pod').exists()
    init_waiting = (pathlib.Path(__file__).parent / 'init-waiting').exists()
    condition = {'type':'Ready','status':'True' if ready else 'False','reason':'ContainersNotReady'}
    status = {'phase':'Running','conditions':[condition], 'containerStatuses':[{'name':'dev','ready':ready}]}
    if init_waiting:
        status['initContainerStatuses']=[{'name':'setup','ready':False,'state':{'waiting':{'reason':'ImagePullBackOff','message':'could not pull setup image'}}}]
    print(json.dumps({'items':[{'metadata':{'name':'workspace-123'},'spec':{'nodeName':'node-a'},'status':status}]}))
elif args[:2] == ['get','pods']:
    items=[]
    for namespace, resource in state.items():
        workspace_id=resource['metadata'].get('labels',{}).get('adm.dev/workspace-id')
        items.append({'kind':'Pod','metadata':{'name':'workspace-pod','namespace':namespace,'labels':{'app.kubernetes.io/managed-by':'adm','adm.dev/workspace-id':workspace_id}},'spec':{'nodeName':'node-a'},'status':{'phase':'Running','containerStatuses':[{'ready':True,'state':{'running':{}}}]}})
    print(json.dumps({'kind':'PodList','items':items}))
elif args[:2] == ['get', 'storageclass']:
    if (pathlib.Path(__file__).parent / 'missing-storage').exists():
        print('Error from server (NotFound): storageclass adm-replicated not found',file=sys.stderr);sys.exit(1)
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
elif args and args[0] == 'exec':
    (pathlib.Path(__file__).parent / 'exec-args.json').write_text(json.dumps(args))
    exec_root = os.environ.get('ADM_TEST_EXEC_ROOT') or str(pathlib.Path(__file__).parent / 'pv')
    if exec_root:
        namespace = args[args.index('-n') + 1]
        block = os.environ.get('ADM_TEST_BLOCK_EXEC') or str(pathlib.Path(__file__).parent / 'block-repository-exec')
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
        command = args[args.index('--') + 1:]
        command = [item.replace('/repos', str(repos)) for item in command]
        env=os.environ.copy()
        test_env = pathlib.Path(__file__).parent / 'exec-env.json'
        if test_env.exists(): env.update(json.loads(test_env.read_text()))
        rewrite=pathlib.Path(__file__).parent/'git-rewrite'
        if rewrite.exists():
            env.update({'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':rewrite.read_text(),'GIT_CONFIG_VALUE_0':'https://github.com/'})
        git_bin=pathlib.Path(__file__).parent/'git-bin'
        if git_bin.exists(): env['PATH']=str(git_bin)+':'+env['PATH']
        fail_after_clone=pathlib.Path(__file__).parent/'fail-after-clone'
        if fail_after_clone.exists(): env['ADM_TEST_FAIL_AFTER_CLONE']=str(fail_after_clone)
        result = subprocess.run(command, cwd=repos, env=env)
        sys.exit(result.returncode)
else: print('unexpected kubectl arguments: '+repr(args),file=sys.stderr);sys.exit(2)
"##).unwrap();
    fs::set_permissions(kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        root.path().join("lifecycle-token"),
        "fixture-lifecycle-token\n",
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    fs::write(
        root.path().join("lifecycle-url"),
        format!("http://127.0.0.1:{port}"),
    )
    .unwrap();
    let lifecycle = Command::new(env!("CARGO_BIN_EXE_adm"))
        .args(["--state-dir"])
        .arg(root.path().join("lifecycle-state"))
        .args(["--kubectl"])
        .arg(root.path().join("kubectl"))
        .args(["--runner-url", runner_url])
        .args(["--lifecycle-token-file"])
        .arg(root.path().join("lifecycle-token"))
        .args(["lifecycle-serve", "--host", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start lifecycle service fixture");
    let url = format!("http://127.0.0.1:{port}/health");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while reqwest::blocking::get(&url).is_err() {
        assert!(
            std::time::Instant::now() < deadline,
            "lifecycle fixture failed to start"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    TestFixture {
        root,
        lifecycle,
        runner_port,
        runner: Some(runner),
    }
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
        let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
        command
            .env("XDG_CONFIG_HOME", root.join("config"))
            .arg("--state-dir")
            .arg(root.join("state"))
            .arg("--kubectl")
            .arg(root.join("kubectl"))
            .args(args);
        configure_lifecycle(&mut command, root);
        let mut child = command
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
    let receipt = |operation_id: &str| -> Value {
        let url = fs::read_to_string(root.path().join("lifecycle-url")).unwrap();
        let token = fs::read_to_string(root.path().join("lifecycle-token")).unwrap();
        reqwest::blocking::Client::new()
            .get(format!("{url}/v1/operations/{operation_id}"))
            .bearer_auth(token.trim())
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    };
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
    let creation = receipt(ready["creation_operation_id"].as_str().unwrap());
    assert_eq!(
        creation["timings"]["stages"]["waiting for deployment readiness"]["status"],
        "completed"
    );
    assert!(
        creation["timings"]["stages"]["waiting for deployment readiness"]["elapsedSeconds"]
            .as_f64()
            .is_some()
    );
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
        launch(root.path(), &["destroy", "progress-demo", "--wait"]);
    wait_for_file(&root.path().join("entered-delete"));
    let active_destroy_stage =
        wait_for_stage(&destroy_progress, "waiting for namespace removal started");
    let during_destroy = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(during_destroy[0]["phase"], "deleting");
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
    let deletion = receipt(deleted["deletion_operation_id"].as_str().unwrap());
    assert_eq!(
        deletion["timings"]["stages"]["waiting for namespace removal"]["status"],
        "completed"
    );
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
fn list_uses_the_directory_and_keeps_full_records_with_json() {
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
            && table.contains("AGENT")
            && table.contains("ACTIVITY")
            && table.contains("ID"),
        "{table}"
    );
    for (name, role, agent, record) in [
        ("coding-agent", "coding", "unavailable", &coding),
        ("shell-only", "coding", "unavailable", &shell),
        ("observer", "bot", "unavailable", &bot),
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
        assert_ok(adm(root.path(), &["destroy", "shell-only", "--wait"]))["phase"],
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

    // The access CLI reads the lifecycle directory without invoking its own kubectl.
    let marker = root.path().join("kubectl-contacted");
    let kubectl = root.path().join("access-kubectl");
    fs::write(
        &kubectl,
        format!(
            "#!/bin/sh\nprintf contacted >> '{}'\nexit 1\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    let mut offline = Command::new(env!("CARGO_BIN_EXE_adm"));
    offline
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(&kubectl)
        .args(["--runner-url", "http://127.0.0.1:1", "list", "--json"]);
    configure_lifecycle(&mut offline, root.path());
    assert_eq!(
        assert_ok(offline.output().unwrap())
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(!marker.exists(), "list must not contact kubectl");
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
    assert_eq!(
        &command[..5],
        ["env", "ZDOTDIR=/workspace/.adm/zsh", "zsh", "-l", "-c"]
    );
    assert_eq!(command.last().map(String::as_str), Some("/repos"));

    let backing = root.path().join("workspace/.adm/catalog");
    let public = root.path().join("public view with spaces");
    let home = root.path().join("home");
    fs::create_dir_all(&backing).unwrap();
    fs::create_dir_all(&home).unwrap();
    symlink(&backing, &public).unwrap();
    command[1] = format!("ZDOTDIR={}", home.display());
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
        .expect("run the zsh argv emitted by adm shell");
    runtime
        .stdin
        .take()
        .unwrap()
        .write_all(
            b"printf 'PWD=%s\\n' \"$PWD\"; printf 'pwd=%s\\n' \"$(pwd)\"; printf 'physical=%s\\n' \"$(pwd -P)\"; PS1='%~'; printf 'prompt=%s\\n' \"${(%)PS1}\"\n",
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

    let executed = adm(
        root.path(),
        &[
            "exec",
            "shell-cwd",
            "--",
            "printf",
            "%s",
            "argument with spaces",
        ],
    );
    assert!(executed.status.success(), "{executed:?}");
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
fn create_prepares_a_private_public_repository_inside_each_workspace_pod() {
    let root = fixture();
    let upstreams = root.path().join("upstreams");
    let upstream = upstreams.join("owner/project.git");
    let rewrite = format!("url.file://{}/.insteadOf", upstreams.display());
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
    for (key, value) in [
        ("user.name", "Fixture User"),
        ("user.email", "fixture@example.invalid"),
    ] {
        git(&["-C", seed.to_str().unwrap(), "config", key, value]);
    }
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
    let git_path = String::from_utf8(Command::new("which").arg("git").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_owned();
    let wrapper = git_bin.join("git");
    fs::write(&wrapper, format!("#!/bin/sh\nexec {git_path} \"$@\"\n")).unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        root.path().join("exec-env.json"),
        serde_json::json!({
            "PATH": format!("{}:/usr/local/bin:/usr/bin:/bin", git_bin.display()),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": rewrite,
            "GIT_CONFIG_VALUE_0": "https://github.com/"
        })
        .to_string(),
    )
    .unwrap();

    let host_runner = TcpListener::bind("127.0.0.1:0").unwrap();
    host_runner.set_nonblocking(true).unwrap();
    fs::write(
        root.path().join("runner-url"),
        format!("http://{}", host_runner.local_addr().unwrap()),
    )
    .unwrap();
    let created = assert_ok(adm(
        root.path(),
        &[
            "create",
            "repo-demo",
            "--model",
            "faux/faux-1",
            "--repo",
            "owner/project",
        ],
    ));
    assert_eq!(created["repository"], "owner/project");
    assert_eq!(created["cwd"], "/repos/owner/project");
    assert_eq!(created["phase"], "ready");
    let first_checkout = root
        .path()
        .join("pv")
        .join(created["namespace"].as_str().unwrap())
        .join("repos/owner/project");
    assert_eq!(
        fs::read_to_string(first_checkout.join("README.md")).unwrap(),
        "fixture upstream\n"
    );
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.path().join("last-manifest.json")).unwrap()).unwrap();
    let deployment = manifest["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "Deployment")
        .unwrap();
    assert_eq!(
        deployment["spec"]["template"]["spec"]["containers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let second = assert_ok(adm(
        root.path(),
        &["create", "repo-other", "--repo", "owner/project"],
    ));
    let second_checkout = root
        .path()
        .join("pv")
        .join(second["namespace"].as_str().unwrap())
        .join("repos/owner/project");
    assert_eq!(
        fs::read_to_string(second_checkout.join("README.md")).unwrap(),
        "fixture upstream\n"
    );
    assert_ne!(
        first_checkout, second_checkout,
        "each workspace keeps a private checkout"
    );
    assert!(
        matches!(host_runner.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "repository preparation and agent registration must not contact a host runner"
    );
}

#[test]
fn destruction_during_repository_preparation_cannot_restore_a_deleted_workspace() {
    use std::time::{Duration, Instant};

    let root = fixture();
    let block = root.path().join("block-repository-exec");
    fs::write(&block, "wait").unwrap();
    let mut create = Command::new(env!("CARGO_BIN_EXE_adm"));
    create
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("ADM_TEST_BLOCK_EXEC", &block)
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .args([
            "create",
            "delete-during-repo",
            "--model",
            "faux/faux-1",
            "--repo",
            "owner/project",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_lifecycle(&mut create, root.path());
    let create = create.spawn().unwrap();
    let entered = root.path().join("block-repository-exec.entered");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !entered.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        entered.exists(),
        "create never reached repository preparation"
    );

    let deleted = adm(root.path(), &["destroy", "delete-during-repo", "--wait"]);
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
}

#[test]
fn destroy_does_not_call_a_host_runner_for_agent_cancellation() {
    let root = fixture();
    assert_ok(adm(
        root.path(),
        &["create", "runner-error", "--no-repositories"],
    ));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let runner_url = format!("http://{}", listener.local_addr().unwrap());

    let deleted = adm_with_runner(
        root.path(),
        &runner_url,
        &["destroy", "runner-error", "--wait"],
    );
    assert!(
        deleted.status.success(),
        "{}",
        String::from_utf8_lossy(&deleted.stderr)
    );
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json", "--all"]))[0]["phase"],
        "deleted"
    );
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "destroy must not call a management-host agent runner"
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
    assert_eq!(workspace["phase"], "ready");

    let exec_root = root.path().join("workspace-fixture");
    let mut populate = Command::new(env!("CARGO_BIN_EXE_adm"));
    populate
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("ADM_TEST_EXEC_ROOT", &exec_root)
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"));
    configure_lifecycle(&mut populate, root.path());
    populate.args(["exec", "navigation", "--", "touch", "existing-work"]);
    let populate = populate.output().unwrap();
    assert!(populate.status.success(), "{populate:?}");
    assert!(
        exec_root
            .join(workspace["namespace"].as_str().unwrap())
            .join("repos/existing-work")
            .exists()
    );
    let mut shell = Command::new(env!("CARGO_BIN_EXE_adm"));
    shell
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("ADM_TEST_EXEC_ROOT", &exec_root)
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .args(["shell", "navigation"]);
    configure_lifecycle(&mut shell, root.path());
    let shell = shell.output().unwrap();
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
    assert_eq!(workspace["phase"], "ready");
    assert_eq!(workspace["agent_enabled"], true);
    assert!(workspace["model"].is_null());
    assert!(
        !root.path().join("state/workspaces.sqlite").exists(),
        "the lifecycle service, not the management host, owns workspace state"
    );
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
        assert_ok(adm(root.path(), &["destroy", "demo", "--wait"]))["phase"],
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
            && status.contains("unavailable")
            && status.contains("workspace Pod has no valid IP address")
            && status.contains("node-a")
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
    assert_eq!(full["agent"]["status"], "unavailable");
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
            && bot_status.contains("unavailable")
            && bot_status.contains("workspace Pod has no valid IP address"),
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
    assert!(bot_inspect.contains("Pod"), "{bot_inspect}");

    assert_eq!(
        assert_ok(adm(root.path(), &["destroy", "demo", "--wait"]))["phase"],
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
fn status_uses_workspace_pod_data_instead_of_a_host_runner() {
    let root = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let runner_url = format!("http://{}", listener.local_addr().unwrap());

    let created = adm(
        root.path(),
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
    assert!(status.contains("Agent unavailable"), "{status}");
    assert!(
        status.contains("workspace Pod has no valid IP address"),
        "{status}"
    );
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "status must not query a management-host agent runner"
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

    let retried = assert_ok(adm(
        root.path(),
        &[
            "create",
            "retry-me",
            "--no-repositories",
            "--operation-id",
            failed[0]["creation_operation_id"].as_str().unwrap(),
        ],
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
    let first = adm(root.path(), &["create", "retry-safe", "--no-repositories"]);
    assert!(!first.status.success());
    let failed = assert_ok(adm(root.path(), &["list", "--json"]));
    let namespace = failed[0]["namespace"].as_str().unwrap();
    let cluster_path = root.path().join("cluster.json");
    let mut cluster: Value = serde_json::from_slice(&fs::read(&cluster_path).unwrap()).unwrap();
    cluster[namespace]["metadata"]["labels"]["adm.dev/workspace-id"] = "someone-else".into();
    fs::write(&cluster_path, serde_json::to_vec(&cluster).unwrap()).unwrap();

    let retry = adm(
        root.path(),
        &[
            "create",
            "retry-safe",
            "--no-repositories",
            "--operation-id",
            failed[0]["creation_operation_id"].as_str().unwrap(),
        ],
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
    let workspace = assert_ok(adm(root.path(), &["create", "safe", "--no-repositories"]));
    let cluster_path = root.path().join("cluster.json");
    let mut cluster: Value = serde_json::from_slice(&fs::read(&cluster_path).unwrap()).unwrap();
    cluster[workspace["namespace"].as_str().unwrap()]["metadata"]["labels"]["adm.dev/workspace-id"] =
        "someone-else".into();
    fs::write(cluster_path, serde_json::to_vec(&cluster).unwrap()).unwrap();
    let output = adm(root.path(), &["destroy", "safe", "--wait"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("ownership"));
    assert_eq!(
        assert_ok(adm(root.path(), &["list", "--json"]))[0]["phase"],
        "deleting"
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
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::ConnectionReset
                ) => {}
            Err(error) => panic!("failed while checking for unexpected requests: {error}"),
        }
        // Closing the subscribed connection makes watch exit after processing events.
        expected_workspace
    });

    let mut watcher = Command::new(env!("CARGO_BIN_EXE_adm"));
    watcher
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .args(["herdr", "watch", "--socket"])
        .arg(&socket)
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &socket);
    configure_lifecycle(&mut watcher, root.path());
    let output = watcher.output().expect("run public Herdr watcher");
    let expected_workspace = server.join().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"status\":\"watching\""), "{stdout}");
    assert!(
        stdout.contains(&expected_workspace),
        "stdout={stdout}\nstderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        stdout.matches("\"status\":\"accepted\"").count(),
        2,
        "{stdout}"
    );
    assert!(
        stdout.contains(workspace["id"].as_str().unwrap()),
        "{stdout}"
    );
    assert!(
        stdout.contains(other_workspace["id"].as_str().unwrap()),
        "{stdout}"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("socket closed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let remaining = assert_ok(adm(root.path(), &["list", "--json"]));
    assert!(remaining.as_array().unwrap().iter().any(|workspace| {
        workspace["id"] == stale_workspace["id"] && workspace["phase"] == "ready"
    }));
    for name in ["herdr-owned", "herdr-other"] {
        let phase = assert_ok(adm(root.path(), &["status", name, "--json"]))["workspace"]["phase"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(matches!(phase.as_str(), "deleting" | "deleted"));
    }
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
        let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
        command
            .arg("--state-dir")
            .arg(root.join("state"))
            .arg("--kubectl")
            .arg(root.join("kubectl"))
            .args(["herdr", "watch", "--socket"])
            .arg(socket)
            .env("HERDR_ENV", "1")
            .env("HERDR_SOCKET_PATH", socket);
        configure_lifecycle(&mut command, root);
        command.output().expect("run public Herdr watcher")
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
    let lifecycle_url_path = root.path().join("lifecycle-url");
    let lifecycle_url = fs::read_to_string(&lifecycle_url_path).unwrap();
    fs::write(&lifecycle_url_path, "http://127.0.0.1:1").unwrap();

    let first_socket = root.path().join("herdr-first.sock");
    let first_server = fake_socket(&first_socket, Some("space-journal"));
    let failed_cleanup = watch(root.path(), &first_socket);
    first_server.join().unwrap();
    assert!(!failed_cleanup.status.success());
    assert!(
        String::from_utf8_lossy(&failed_cleanup.stderr).contains("lifecycle service unavailable")
    );
    let journal = root.path().join("state/herdr-closed-events.jsonl");
    assert!(
        fs::read_to_string(&journal)
            .unwrap()
            .contains("space-journal")
    );

    fs::write(&lifecycle_url_path, lifecycle_url).unwrap();
    let second_socket = root.path().join("herdr-second.sock");
    let second_server = fake_socket(&second_socket, None);
    let recovered_cleanup = watch(root.path(), &second_socket);
    second_server.join().unwrap();
    let stdout = String::from_utf8_lossy(&recovered_cleanup.stdout);
    assert!(stdout.contains("\"status\":\"accepted\""), "{stdout}");
    assert!(!journal.exists() || fs::read(&journal).unwrap().is_empty());
    let remaining = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(remaining.as_array().unwrap().len(), 1);
    assert_eq!(remaining[0]["id"], workspace["id"]);
    assert!(matches!(
        remaining[0]["phase"].as_str().unwrap(),
        "deleting" | "deleted"
    ));
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
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(matches!(
        receipt["status"].as_str().unwrap(),
        "accepted" | "completed"
    ));
    let phase =
        assert_ok(adm(root.path(), &["status", "herdr-owned", "--json"]))["workspace"]["phase"]
            .as_str()
            .unwrap()
            .to_owned();
    assert!(matches!(phase.as_str(), "deleting" | "deleted"));
    let cluster: Value =
        serde_json::from_slice(&fs::read(root.path().join("cluster.json")).unwrap()).unwrap();
    if phase == "deleted" {
        assert!(
            cluster
                .get(workspace["namespace"].as_str().unwrap())
                .is_none()
        );
    }
}

#[test]
fn herdr_bind_requires_a_live_herdr_workspace_id() {
    let root = fixture();
    let setup = adm(root.path(), &["herdr"]);
    assert!(
        setup.status.success(),
        "{}",
        String::from_utf8_lossy(&setup.stderr)
    );
    assert!(String::from_utf8_lossy(&setup.stdout).contains("HERDR_WORKSPACE_ID"));
    assert_ok(adm(
        root.path(),
        &["create", "herdr-owned", "--no-repositories"],
    ));
    let hook = adm(root.path(), &["herdr", "hook"]);
    assert!(hook.status.success());
    let hook = String::from_utf8(hook.stdout).unwrap();
    assert!(hook.contains("HERDR_WORKSPACE_ID"), "{hook}");
    assert!(
        hook.contains("systemctl --user status adm-herdr-watch"),
        "{hook}"
    );
    assert!(hook.contains("no replay cursor"), "{hook}");
    let fake_bin = root.path().join("fake-bin");
    fs::create_dir_all(&fake_bin).unwrap();
    let herdr = fake_bin.join("herdr");
    fs::write(
        &herdr,
        "#!/bin/sh\nif [ \"$1\" = workspace ] && [ \"$2\" = get ] && [ \"$3\" = live-space ]; then\n  printf '%s\\n' '{\"result\":{\"workspace\":{\"workspace_id\":\"live-space\"}}}'\n  exit 0\nfi\nprintf '%s\\n' '{\"error\":{\"message\":\"workspace not found\"}}' >&2\nexit 1\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&herdr).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&herdr, permissions).unwrap();
    let path = format!("{}:/usr/bin:/bin", fake_bin.display());
    let bind = |space: &str| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
        command
            .env("PATH", &path)
            .env("XDG_CONFIG_HOME", root.path().join("config"))
            .arg("--state-dir")
            .arg(root.path().join("state"))
            .arg("--kubectl")
            .arg(root.path().join("kubectl"))
            .args(["--runner-url", "http://127.0.0.1:1"]);
        configure_lifecycle(&mut command, root.path());
        command
            .args(["herdr", "bind", "herdr-owned", space])
            .output()
            .unwrap()
    };

    let missing = bind("missing-space");
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("workspace not found"));

    let valid = bind("live-space");
    assert!(
        valid.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&valid.stdout),
        String::from_utf8_lossy(&valid.stderr)
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
fn manifest_exposes_the_workspace_security_profile_and_isolated_storage() {
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
    assert_eq!(dev["securityContext"]["allowPrivilegeEscalation"], true);
    assert_eq!(dev["securityContext"]["capabilities"]["drop"][0], "ALL");
    assert_eq!(
        dev["securityContext"]["capabilities"]["add"],
        serde_json::json!(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"])
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
    assert_eq!(pod["initContainers"][0]["securityContext"]["runAsUser"], 0);
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
    assert_eq!(dev["readinessProbe"]["httpGet"]["path"], "/health");
    assert_eq!(dev["readinessProbe"]["httpGet"]["port"], 7432);
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
    assert!(String::from_utf8_lossy(&output.stderr).contains("workspace Pods"));
}

#[test]
fn missing_replicated_storage_points_at_the_deploy_note() {
    let root = fixture();
    fs::write(root.path().join("missing-storage"), "missing").unwrap();
    let output = adm(root.path(), &["create", "demo"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("deploy/storage.md"), "{stderr}");
    let failed = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(failed.as_array().unwrap().len(), 1);
    assert_eq!(failed[0]["phase"], "failed");
    assert!(
        failed[0]["last_error"]
            .as_str()
            .unwrap()
            .contains("deploy/storage.md")
    );
}

#[test]
fn credential_environment_flags_emit_only_workspace_scoped_secret_references() {
    let root = tempfile::tempdir().unwrap();
    let output = adm(
        root.path(),
        &[
            "manifest",
            "credentials",
            "--credential-env",
            "API_KEY=provider-secret:token",
        ],
    );
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let manifest: Value = serde_json::from_slice(&output.stdout).unwrap();
    let dev = manifest["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "Deployment")
        .unwrap()["spec"]["template"]["spec"]["containers"][0]
        .clone();
    let api_key = dev["env"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "API_KEY")
        .unwrap();
    assert_eq!(
        api_key["valueFrom"]["secretKeyRef"],
        serde_json::json!({"name":"provider-secret","key":"token"})
    );
    assert!(api_key.get("value").is_none());
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
    let credential = dev["env"]
        .as_array()
        .unwrap()
        .iter()
        .find(|env| env["name"] == "OPENAI_API_KEY")
        .unwrap();
    assert_eq!(
        credential["valueFrom"]["secretKeyRef"]["name"],
        "provider-auth"
    );
    assert_eq!(credential["valueFrom"]["secretKeyRef"]["key"], "openai");
    let serialized = serde_json::to_string(&manifest).unwrap();
    assert!(!serialized.contains("synthetic"));
    assert!(!serialized.contains("OPENAI_API_KEY="));
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
fn zsh_completions_load_and_complete_cli_commands_and_flags_offline() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("config/adm")).unwrap();
    fs::write(root.path().join("config/adm/config.json"), "not json").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("XDG_DATA_HOME", root.path().join("data"))
        .env("ADM_STATE_DIR", root.path().join("state"))
        .env("KUBECONFIG", root.path().join("missing-kubeconfig"))
        .args([
            "--runner-url",
            "http://127.0.0.1:1",
            "--kubectl",
            "/missing/kubectl",
            "completions",
            "zsh",
        ])
        .output()
        .expect("run completion generation through the public CLI");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let script = String::from_utf8(output.stdout).unwrap();
    assert!(script.contains("_adm"), "{script}");
    assert!(script.contains("herdr"), "{script}");
    assert!(!root.path().join("data/adm").exists());
    assert!(!root.path().join("state").exists());

    let script_path = root.path().join("_adm");
    fs::write(&script_path, script).unwrap();
    if Command::new("zsh").arg("--version").output().is_err() {
        eprintln!("skipping interactive completion assertions because zsh is unavailable");
        return;
    }
    // Insecure ambient completion paths must not consume the PTY's test input.
    let insecure_completions = root.path().join("insecure-completions");
    fs::create_dir(&insecure_completions).unwrap();
    fs::set_permissions(&insecure_completions, fs::Permissions::from_mode(0o777)).unwrap();
    let driver = root.path().join("completion-test.zsh");
    fs::write(
        &driver,
        r#"zmodload zsh/zpty
zpty adm-completion zsh -f -i
zpty -w adm-completion $'stty -echo\nfpath=("$ADM_TEST_INSECURE_COMPLETIONS" $fpath)\nautoload -Uz compinit\ncompinit -D -i\nsource "$ADM_TEST_COMPLETION_SCRIPT"\ncompdef _adm adm\nfunction adm() { print -r -- "__ADM_RESULT__:$*"; }\nprint __ADM_READY__\n'
zpty -r -m adm-completion output '*__ADM_READY__*'
print -r -- "$output"
for input in $'adm li\t' $'adm herdr b\t' $'adm list --j\t' $'adm --state-d\t'; do
  zpty -w adm-completion "$input"
  zpty -r -m adm-completion output '*__ADM_RESULT__*'
  print -r -- "$output"
done
zpty -d adm-completion
"#,
    )
    .unwrap();
    let zsh = Command::new("zsh")
        .env("ZDOTDIR", root.path())
        .env("ADM_TEST_COMPLETION_SCRIPT", &script_path)
        .env("ADM_TEST_INSECURE_COMPLETIONS", &insecure_completions)
        .arg("-f")
        .arg(&driver)
        .output()
        .expect("load completion script in zsh");
    assert!(
        zsh.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&zsh.stdout),
        String::from_utf8_lossy(&zsh.stderr)
    );
    let candidates = String::from_utf8_lossy(&zsh.stdout);
    for candidate in [
        "adm list",
        "adm herdr bind",
        "adm list --json",
        "adm --state-dir",
    ] {
        assert!(
            candidates.contains(candidate),
            "missing {candidate:?}: {candidates}"
        );
    }
}
