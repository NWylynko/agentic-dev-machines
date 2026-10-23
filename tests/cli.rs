use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::{PermissionsExt, symlink},
    os::unix::net::UnixListener,
    path::{Path, PathBuf},
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

fn interactive_cli(
    root: &Path,
    project: &Path,
    arguments: &[&str],
) -> (std::process::ExitStatus, String) {
    use std::os::fd::{FromRawFd, RawFd};

    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        },
        0,
        "open a PTY for the public CLI"
    );
    let master = unsafe { fs::File::from_raw_fd(master) };
    let slave = unsafe { fs::File::from_raw_fd(slave) };
    let node_path = root.join("node-bin");
    let path = format!(
        "{}:{}:{}",
        node_path.display(),
        root.join("herdr-bin").display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
    command
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("ADM_ATTACH_TEST_ROOT", root)
        .env("PATH", path)
        .arg("--project-dir")
        .arg(project)
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"))
        .args(["--runner-url"])
        .arg(fs::read_to_string(root.join("runner-url")).unwrap())
        .args(arguments)
        .stdin(Stdio::from(slave.try_clone().unwrap()))
        .stdout(Stdio::from(slave))
        .stderr(Stdio::piped());
    configure_lifecycle(&mut command, root);
    let mut child = command.spawn().expect("start interactive public CLI");
    let status = child.wait().unwrap();
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    drop(master);
    (status, stderr)
}

fn install_terminal_fixture(root: &Path) -> PathBuf {
    fs::write(root.join("attach-fixture"), "enable runtime Pod identity").unwrap();
    let project = root.join("installed-adm");
    fs::create_dir_all(project.join("runtime")).unwrap();
    fs::write(project.join("runtime/terminal.mjs"), "").unwrap();
    let node = root.join("node-bin/node");
    fs::create_dir_all(node.parent().unwrap()).unwrap();
    fs::write(
        &node,
        "#!/usr/bin/env python3\nimport json, os, pathlib, sys\nroot=pathlib.Path(os.environ['ADM_ATTACH_TEST_ROOT'])\nwith (root/'attach-invocations.jsonl').open('a') as log: log.write(json.dumps(sys.argv[1:])+'\\n')\nidentity=pathlib.Path(sys.argv[sys.argv.index('--identity-file')+1])\n(root/'attach-identity.json').write_text(identity.read_text())\nsys.exit(7 if (root/'fail-terminal').exists() else 0)\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&node).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(node, permissions).unwrap();
    project
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

fn adm_in_herdr(root: &Path, arguments: &[&str], socket: &Path) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
    command
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", socket)
        .env("ADM_HERDR_INITIAL_PANE", "local")
        .env(
            "PATH",
            format!(
                "{}:{}",
                root.join("herdr-bin").display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"));
    configure_lifecycle(&mut command, root);
    command
        .args(arguments)
        .output()
        .expect("run CLI in fixture Herdr session")
}

fn adm_in_herdr_with_input(root: &Path, arguments: &[&str], input: &str, socket: &Path) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
    command
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", socket)
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--kubectl")
        .arg(root.join("kubectl"));
    configure_lifecycle(&mut command, root);
    command
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("run CLI in fixture Herdr session");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child
        .wait_with_output()
        .expect("wait for fixture Herdr CLI")
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
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/calls\"\nif [ \"$1 $2\" = 'server reload-config' ]; then\n  if [ -f \"$(dirname \"$0\")/fail-reload\" ]; then echo 'error: herdr server is not running' >&2; exit 1; fi\n  cp \"$XDG_CONFIG_HOME/herdr/config.toml\" \"$(dirname \"$0\")/live-config.toml\"\n  printf '{\"id\":\"cli:server:reload-config\",\"result\":{\"diagnostics\":[],\"status\":\"applied\",\"type\":\"config_reload\"}}\\n'\n  exit 0\nfi\nif [ \"$2\" = rename ] && [ -f \"$(dirname \"$0\")/fail-rename\" ]; then exit 1; fi\nprintf '{\"result\":{\"workspace\":{\"workspace_id\":\"%s\"}}}\\n' \"$3\"\n",
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
if args[:2] == ['get','pods']:
    with open(pathlib.Path(__file__).parent / 'kubectl-pod-calls', 'a') as calls: calls.write(json.dumps(args)+'\n')
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
    attach_fixture=pathlib.Path(__file__).parent.joinpath('attach-fixture').exists()
    for namespace, resource in state.items():
        workspace_id=resource['metadata'].get('labels',{}).get('adm.dev/workspace-id')
        failed = (pathlib.Path(__file__).parent / 'failed-pod').exists()
        metadata={'name':'workspace-pod','namespace':namespace,'labels':{'app.kubernetes.io/managed-by':'adm','adm.dev/workspace-id':workspace_id}}
        spec={'nodeName':'node-a'}
        status={'phase':'Failed' if failed else 'Running','message':'workspace process exited unexpectedly' if failed else None,'containerStatuses':[{'ready':not failed,'state':{'terminated':{'reason':'Error'}} if failed else {'running':{}}}]}
        if attach_fixture:
            metadata['uid']='8b7dcaa0-fb7b-4e43-a668-23a2ae131a0a'
            spec['serviceAccountName']='adm-runtime'
            status.update({'podIP':'127.0.0.1','conditions':[{'type':'Ready','status':'True'}],'containerStatuses':[{'name':'dev','ready':True,'state':{'running':{}}}]})
        items.append({'kind':'Pod','metadata':metadata,'spec':spec,'status':status})
    print(json.dumps({'kind':'PodList','items':items}))
elif args[:2] == ['get','pod']:
    namespace=args[args.index('-n')+1]
    workspace_id=state[namespace]['metadata']['labels']['adm.dev/workspace-id']
    print(json.dumps({'metadata':{'name':args[2],'namespace':namespace,'uid':'8b7dcaa0-fb7b-4e43-a668-23a2ae131a0a','labels':{'app.kubernetes.io/managed-by':'adm','adm.dev/workspace-id':workspace_id}},'spec':{'serviceAccountName':'adm-runtime'},'status':{'phase':'Running','conditions':[{'type':'Ready','status':'True'}]}}))
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
    if '--for=jsonpath=' in ' '.join(args) and pathlib.Path(__file__).parent.joinpath('real-kubectl-parser').exists():
        parser = pathlib.Path(__file__).parent.joinpath('real-kubectl-parser').read_text().strip()
        result = subprocess.run([parser, '--server=http://127.0.0.1:9', '--request-timeout=1s', *args], text=True, capture_output=True)
        pathlib.Path(__file__).parent.joinpath('real-kubectl-result').write_text(repr(args) + '\n' + result.stderr)
        if 'unexpected path string' in result.stderr.lower() or 'connection refused' not in result.stderr.lower():
            print(result.stderr, file=sys.stderr)
            sys.exit(result.returncode or 1)
    wait_for_release('readiness')
    failure = pathlib.Path(__file__).parent / 'fail-wait-once'
    if failure.exists():
        failure.unlink(); print('deployment did not become available',file=sys.stderr); sys.exit(1)
    ready_failure = pathlib.Path(__file__).parent / 'fail-ready-once'
    if ready_failure.exists() and '--for=condition=available' in args:
        ready_failure.unlink(); print('deployment did not become available',file=sys.stderr); sys.exit(1)
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
elif args and args[0] == 'port-forward':
    print('Forwarding from 127.0.0.1:43127 -> 7432', flush=True)
    __import__('time').sleep(60)
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

    let pod_calls = root.path().join("kubectl-pod-calls");
    if pod_calls.exists() {
        fs::remove_file(&pod_calls).unwrap();
    }
    let table = adm(root.path(), &["list"]);
    assert!(
        table.status.success(),
        "{}",
        String::from_utf8_lossy(&table.stderr)
    );
    let table = String::from_utf8_lossy(&table.stdout);
    assert_eq!(
        fs::read_to_string(pod_calls).unwrap().lines().count(),
        1,
        "list should collect one bounded Pod inventory for all workspaces"
    );
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
    let kubectl_parser = Command::new("which")
        .arg("kubectl")
        .output()
        .expect("find real kubectl parser");
    assert!(kubectl_parser.status.success(), "kubectl must be installed");
    fs::write(
        root.path().join("real-kubectl-parser"),
        String::from_utf8(kubectl_parser.stdout).unwrap(),
    )
    .unwrap();
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
    let parser_result = fs::read_to_string(root.path().join("real-kubectl-result"))
        .expect("the public create command must pass its Pod wait through real kubectl");
    assert!(
        parser_result.contains("connection refused")
            && !parser_result.contains("unexpected path string"),
        "kubectl must parse the wait expression before reaching the unreachable API: {parser_result}"
    );
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

fn repository_branch_fixture() -> TestFixture {
    let root = fixture();
    let upstreams = root.path().join("upstreams");
    let upstream = upstreams.join("owner/project.git");
    let seed = root.path().join("seed");
    fs::create_dir_all(upstream.parent().unwrap()).unwrap();
    fs::create_dir(&seed).unwrap();
    repository_git(
        root.path(),
        &[
            "init",
            "--bare",
            "--initial-branch=trunk",
            upstream.to_str().unwrap(),
        ],
    );
    repository_git(&seed, &["init", "--initial-branch=trunk"]);
    repository_git(&seed, &["config", "user.name", "Fixture User"]);
    repository_git(&seed, &["config", "user.email", "fixture@example.invalid"]);
    fs::write(seed.join("README.md"), "default branch\n").unwrap();
    repository_git(&seed, &["add", "README.md"]);
    repository_git(&seed, &["commit", "-m", "default"]);
    repository_git(
        &seed,
        &["remote", "add", "origin", upstream.to_str().unwrap()],
    );
    repository_git(&seed, &["push", "origin", "trunk"]);
    repository_git(&seed, &["switch", "-c", "existing-feature"]);
    fs::write(seed.join("README.md"), "existing feature\n").unwrap();
    repository_git(&seed, &["commit", "-am", "feature"]);
    repository_git(&seed, &["push", "origin", "existing-feature"]);
    fs::write(
        root.path().join("git-rewrite"),
        format!("url.file://{}/.insteadOf", upstreams.display()),
    )
    .unwrap();
    root
}

fn repository_git(checkout: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(checkout)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn repository_checkout(root: &Path, workspace: &Value) -> PathBuf {
    root.join("pv")
        .join(workspace["namespace"].as_str().unwrap())
        .join("repos/owner/project")
}

#[test]
fn create_checks_out_an_existing_remote_repository_branch() {
    let root = repository_branch_fixture();
    for (name, branch, readme) in [
        ("existing-branch", "existing-feature", "existing feature\n"),
        ("default-branch", "trunk", "default branch\n"),
    ] {
        let workspace = assert_ok(adm(
            root.path(),
            &[
                "create",
                name,
                "--repo",
                "owner/project",
                "--branch",
                branch,
            ],
        ));
        let checkout = repository_checkout(root.path(), &workspace);
        assert_eq!(workspace["branch"], branch);
        assert_eq!(workspace["cwd"], "/repos/owner/project");
        assert_eq!(
            repository_git(&checkout, &["branch", "--show-current"]),
            branch
        );
        assert_eq!(
            repository_git(&checkout, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            format!("origin/{branch}")
        );
        assert_eq!(
            fs::read_to_string(checkout.join("README.md")).unwrap(),
            readme
        );
    }
}

#[test]
fn create_starts_a_new_repository_branch_from_the_remote_default() {
    let root = repository_branch_fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &[
            "create",
            "new-branch",
            "--repo",
            "owner/project",
            "--branch",
            "feature/new-work",
        ],
    ));
    let checkout = repository_checkout(root.path(), &workspace);
    assert_eq!(
        repository_git(&checkout, &["branch", "--show-current"]),
        "feature/new-work"
    );
    assert_eq!(
        fs::read_to_string(checkout.join("README.md")).unwrap(),
        "default branch\n"
    );
    assert_eq!(
        repository_git(&checkout, &["rev-parse", "HEAD"]),
        repository_git(&root.path().join("seed"), &["rev-parse", "trunk"])
    );
    assert_eq!(
        repository_git(
            &checkout,
            &[
                "for-each-ref",
                "--format=%(upstream)",
                "refs/heads/feature/new-work"
            ]
        ),
        ""
    );
    assert_eq!(
        repository_git(
            &root.path().join("upstreams/owner/project.git"),
            &[
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads/feature/new-work"
            ]
        ),
        ""
    );
}

#[test]
fn create_starts_a_new_repository_branch_from_an_explicit_base() {
    let root = repository_branch_fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &[
            "create",
            "based-branch",
            "--repo",
            "owner/project",
            "--branch",
            "feature/based",
            "--base",
            "origin/existing-feature",
        ],
    ));
    let checkout = repository_checkout(root.path(), &workspace);
    assert_eq!(workspace["base"], "origin/existing-feature");
    assert_eq!(
        repository_git(&checkout, &["branch", "--show-current"]),
        "feature/based"
    );
    assert_eq!(
        fs::read_to_string(checkout.join("README.md")).unwrap(),
        "existing feature\n"
    );
    assert_eq!(
        repository_git(&checkout, &["rev-parse", "HEAD"]),
        repository_git(
            &root.path().join("seed"),
            &["rev-parse", "existing-feature"]
        )
    );
    assert_eq!(
        repository_git(
            &checkout,
            &[
                "for-each-ref",
                "--format=%(upstream)",
                "refs/heads/feature/based"
            ]
        ),
        ""
    );
}

#[test]
fn create_rejects_invalid_repository_branches_without_publishing_a_checkout() {
    let root = repository_branch_fixture();
    for (name, branch) in [("invalid-branch", "broken..branch"), ("empty-branch", "")] {
        let output = adm(
            root.path(),
            &[
                "create",
                name,
                "--repo",
                "owner/project",
                "--branch",
                branch,
            ],
        );
        assert!(
            !output.status.success(),
            "invalid branch {branch:?} was accepted"
        );
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains("branch"), "{error}");
    }
    for workspace in assert_ok(adm(root.path(), &["list", "--json"]))
        .as_array()
        .unwrap()
    {
        assert!(
            !repository_checkout(root.path(), workspace).exists(),
            "invalid branches must never publish a checkout"
        );
    }
}

#[test]
fn create_rejects_a_missing_repository_base_without_publishing_on_retry() {
    let root = repository_branch_fixture();
    let args = [
        "create",
        "missing-base",
        "--repo",
        "owner/project",
        "--branch",
        "feature/missing",
        "--base",
        "origin/does-not-exist",
    ];
    let mut original = None;
    for _ in 0..2 {
        let output = adm(root.path(), &args);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("base ref does not resolve to a commit"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let workspaces = assert_ok(adm(root.path(), &["list", "--json"]));
        assert_eq!(workspaces.as_array().unwrap().len(), 1);
        assert_eq!(workspaces[0]["phase"], "failed");
        assert_eq!(workspaces[0]["base"], "origin/does-not-exist");
        assert!(!repository_checkout(root.path(), &workspaces[0]).exists());
        if let Some(original) = &original {
            assert_eq!(&workspaces[0], original);
        } else {
            original = Some(workspaces[0].clone());
        }
    }
}

#[test]
fn repository_branch_retries_preserve_identity_edits_and_reject_changed_choices() {
    let root = repository_branch_fixture();
    fs::write(root.path().join("fail-ready-once"), "fail").unwrap();
    let args = [
        "create",
        "branch-retry",
        "--repo",
        "owner/project",
        "--branch",
        "feature/retry",
        "--base",
        "origin/existing-feature",
    ];
    assert!(!adm(root.path(), &args).status.success());
    let failed = assert_ok(adm(root.path(), &["list", "--json"]));
    let original = &failed[0];
    let checkout = repository_checkout(root.path(), original);
    assert_eq!(
        repository_git(&checkout, &["branch", "--show-current"]),
        "feature/retry"
    );
    fs::write(checkout.join("README.md"), "private local edits\n").unwrap();
    fs::write(checkout.join("untracked.txt"), "unfinished work\n").unwrap();
    repository_git(&checkout, &["switch", "-c", "user-progress"]);
    for (branch, base) in [
        ("feature/different", "origin/existing-feature"),
        ("feature/retry", "trunk"),
    ] {
        let output = adm(
            root.path(),
            &[
                "create",
                "branch-retry",
                "--repo",
                "owner/project",
                "--branch",
                branch,
                "--base",
                base,
            ],
        );
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("different options"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let retried = assert_ok(adm(root.path(), &args));
    assert_eq!(
        retried["creation_operation_id"],
        original["creation_operation_id"]
    );
    // Explicit replay still addresses the same durable identity after an ordinary retry.
    let mut replay = args.to_vec();
    replay.extend([
        "--operation-id",
        original["creation_operation_id"].as_str().unwrap(),
    ]);
    let replayed = assert_ok(adm(root.path(), &replay));
    assert_eq!(replayed["id"], original["id"]);
    assert_eq!(retried["id"], original["id"]);
    assert_eq!(retried["namespace"], original["namespace"]);
    assert_eq!(retried["phase"], "ready");
    assert_eq!(retried["branch"], "feature/retry");
    assert_eq!(retried["base"], "origin/existing-feature");
    assert_eq!(retried["cwd"], "/repos/owner/project");
    assert_eq!(
        repository_git(&checkout, &["branch", "--show-current"]),
        "user-progress"
    );
    assert_eq!(
        fs::read_to_string(checkout.join("README.md")).unwrap(),
        "private local edits\n"
    );
    assert_eq!(
        fs::read_to_string(checkout.join("untracked.txt")).unwrap(),
        "unfinished work\n"
    );
}

#[test]
fn repository_branch_and_base_flags_require_repository_and_branch() {
    let root = fixture();
    for (args, expected) in [
        (
            vec!["create", "branch-only", "--branch", "feature/work"],
            "--repo",
        ),
        (vec!["create", "base-only", "--base", "trunk"], "--repo"),
        (
            vec![
                "create",
                "base-no-branch",
                "--repo",
                "owner/project",
                "--base",
                "trunk",
            ],
            "--branch",
        ),
        (
            vec![
                "create",
                "empty-base",
                "--repo",
                "owner/project",
                "--branch",
                "feature/work",
                "--base",
                "",
            ],
            "base must be non-empty",
        ),
    ] {
        let output = adm(root.path(), &args);
        assert!(!output.status.success(), "{args:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(
        assert_ok(adm(root.path(), &["list", "--json"]))
            .as_array()
            .unwrap()
            .is_empty()
    );
    let help = adm(root.path(), &["create", "--help"]);
    assert!(help.status.success());
    for flag in ["--branch <BRANCH>", "--base <BASE>"] {
        assert!(String::from_utf8_lossy(&help.stdout).contains(flag));
    }
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
fn create_no_attach_keeps_the_ready_workspace_json_for_automation() {
    let root = fixture();
    let output = adm(
        root.path(),
        &["create", "create-only", "--no-repositories", "--no-attach"],
    );

    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let workspace: Value = serde_json::from_slice(&output.stdout)
        .expect("creation-only output stays machine-readable JSON");
    assert_eq!(workspace["name"], "create-only");
    assert_eq!(workspace["phase"], "ready");
    assert!(!root.path().join("exec-args.json").exists());
}

#[test]
fn interactive_create_attaches_once_to_the_created_workspace() {
    let root = fixture();
    let project = install_terminal_fixture(root.path());
    let (status, stderr) = interactive_cli(
        root.path(),
        &project,
        &["create", "interactive-create", "--no-repositories"],
    );

    assert!(
        status.success(),
        "CLI failed during interactive handoff: {stderr}"
    );
    let calls = fs::read_to_string(root.path().join("attach-invocations.jsonl")).unwrap();
    assert_eq!(
        calls.lines().count(),
        1,
        "one attach terminal must be launched"
    );
    let identity: Value =
        serde_json::from_slice(&fs::read(root.path().join("attach-identity.json")).unwrap())
            .unwrap();
    let cluster: Value =
        serde_json::from_slice(&fs::read(root.path().join("cluster.json")).unwrap()).unwrap();
    assert_eq!(
        cluster[identity["namespace"].as_str().unwrap()]["metadata"]["labels"]["adm.dev/workspace-id"],
        identity["workspaceId"],
        "terminal identity must be the workspace created by this command"
    );
}

#[test]
fn create_herdr_opens_and_attaches_by_explicit_ids_without_focusing_other_spaces() {
    use std::io::BufRead;

    let root = fixture();
    let socket = root.path().join("herdr-create-attach.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let root_path = root.path().to_owned();
    let local_cwd = std::env::current_dir().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let create: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(create["method"], "workspace.create");
        assert_eq!(create["params"]["focus"], false);
        assert_eq!(create["params"]["env"]["ADM_HERDR_INITIAL_PANE"], "local");
        assert_eq!(
            create["params"]["cwd"],
            local_cwd.to_string_lossy().as_ref()
        );
        // The Herdr space must only be created after the durable workspace is ready.
        let created = assert_ok(adm(&root_path, &["list", "--json"]));
        let workspace = created
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "herdr-project")
            .unwrap();
        let workspace_id = workspace["id"].as_str().unwrap().to_owned();
        writeln!(
            reader.get_mut(),
            "{}",
            serde_json::json!({
                "id":create["id"],
                "result":{"type":"workspace_created",
                    "workspace":{"workspace_id":"explicit-space-8","number":8,"label":"herdr-project","focused":false,"pane_count":1,"tab_count":1,"active_tab_id":"tab-8","agent_status":"idle"},
                    "tab":{"tab_id":"tab-8","workspace_id":"explicit-space-8","number":1,"label":"herdr-project","focused":false,"pane_count":1,"agent_status":"idle"},
                    "root_pane":{"pane_id":"pane-8","terminal_id":"terminal-8","workspace_id":"explicit-space-8","tab_id":"tab-8","focused":false,"agent_status":"idle","revision":1}}
            })
        )
        .unwrap();

        let (stream, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        line.clear();
        reader.read_line(&mut line).unwrap();
        let send: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(send["method"], "pane.send_input");
        assert_eq!(send["params"]["pane_id"], "pane-8");
        let text = send["params"]["text"].as_str().unwrap();
        assert_eq!(text.matches("'attach'").count(), 1, "{text}");
        assert!(
            text.contains(&workspace_id),
            "must attach by immutable ID: {text}"
        );
        assert!(!text.contains("attach herdr-project"), "{text}");
        assert!(
            text.contains("--kubectl"),
            "preserve connection selectors: {text}"
        );
        assert!(
            text.contains("--lifecycle-token-file"),
            "preserve token-file selection by path: {text}"
        );
        assert!(
            !text.contains("fixture-token"),
            "never serialize bearer values: {text}"
        );
        writeln!(
            reader.get_mut(),
            "{}",
            serde_json::json!({"id":send["id"],"result":{"sent":true}})
        )
        .unwrap();
        workspace_id
    });

    let output = adm_in_herdr(
        root.path(),
        &["create", "herdr-project", "--no-repositories", "--herdr"],
        &socket,
    );
    let workspace_id = server.join().unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let output_text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output_text.contains("Close-event delivery: unavailable"),
        "must show actual optional bridge health: {output_text}"
    );
    assert!(
        !output_text.contains("adm herdr watch"),
        "creation must not start or prescribe an unverified watcher: {output_text}"
    );
    let stored: Value =
        serde_json::from_slice(&fs::read(root.path().join("state/herdr-bindings.json")).unwrap())
            .unwrap();
    assert_eq!(stored[0]["workspace_id"], workspace_id);
    assert_eq!(stored[0]["space_id"], "explicit-space-8");
    let live_config = fs::read_to_string(root.path().join("herdr-bin/live-config.toml")).unwrap();
    assert!(
        live_config.contains(&format!(
            "default_shell = \"{}\"",
            root.path().join("state/herdr-shell-router").display()
        )),
        "the running Herdr server must route panes opened after create: {live_config}"
    );
    let herdr_calls = fs::read_to_string(root.path().join("herdr-bin/calls")).unwrap();
    assert!(
        herdr_calls
            .lines()
            .any(|call| call == "workspace get explicit-space-8"),
        "{herdr_calls}"
    );
    assert!(
        herdr_calls
            .lines()
            .any(|call| call == "workspace rename explicit-space-8 herdr-project"),
        "{herdr_calls}"
    );
}

#[test]
fn create_herdr_rejects_no_attach_and_explicit_space_selection() {
    let root = fixture();
    let output = adm(
        root.path(),
        &["create", "invalid-herdr", "--herdr", "--no-attach"],
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot be used with"));

    let output = adm(
        root.path(),
        &[
            "create",
            "invalid-herdr",
            "--herdr",
            "--herdr-space",
            "existing",
        ],
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot be used with"));
}

#[test]
fn create_herdr_rename_failure_reports_both_immutable_ids_and_workspace_recovery() {
    use std::io::BufRead;

    let root = fixture();
    fs::write(root.path().join("herdr-bin/fail-rename"), "fail").unwrap();
    let socket = root.path().join("herdr-rename-failure.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let root_path = root.path().to_owned();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "workspace.create");
        let created = assert_ok(adm(&root_path, &["list", "--json"]));
        assert!(
            created
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["name"] == "rename-fails")
        );
        writeln!(
            reader.get_mut(),
            "{}",
            serde_json::json!({
                "id":request["id"],"result":{"type":"workspace_created",
                    "workspace":{"workspace_id":"explicit-space-fail","label":"rename-fails"},
                    "tab":{"tab_id":"tab-fail"},"root_pane":{"pane_id":"pane-fail"}}
            })
        )
        .unwrap();
    });
    let output = adm_in_herdr(
        root.path(),
        &["create", "rename-fails", "--no-repositories", "--herdr"],
        &socket,
    );
    server.join().unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let workspaces = assert_ok(adm(root.path(), &["list", "--json"]));
    let workspace_id = workspaces[0]["id"].as_str().unwrap();
    assert!(stderr.contains(workspace_id), "{stderr}");
    assert!(stderr.contains("explicit-space-fail"), "{stderr}");
    assert!(
        stderr.contains(&format!("recover with `adm attach {workspace_id}`")),
        "{stderr}"
    );
    assert!(!stderr.contains("attach rename-fails"), "{stderr}");
    let calls = fs::read_to_string(root.path().join("herdr-bin/calls")).unwrap();
    assert!(
        calls
            .lines()
            .any(|call| call == "workspace rename explicit-space-fail rename-fails"),
        "{calls}"
    );
}

#[test]
fn attach_failure_reports_partial_success_and_direct_recovery_command() {
    let root = fixture();
    let project = install_terminal_fixture(root.path());
    fs::write(root.path().join("fail-terminal"), "fail attach").unwrap();

    let (status, stderr) = interactive_cli(
        root.path(),
        &project,
        &["create", "attach-fails", "--no-repositories"],
    );

    assert!(!status.success(), "terminal failure must remain visible");
    let identity: Value =
        serde_json::from_slice(&fs::read(root.path().join("attach-identity.json")).unwrap())
            .unwrap();
    let workspace_id = identity["workspaceId"].as_str().unwrap();
    assert!(
        stderr.contains(&format!(
            "workspace attach-fails was created with ID {workspace_id}"
        )),
        "partial success must identify the created workspace: {stderr}"
    );
    assert!(
        stderr.contains(&format!("recover with `adm attach {workspace_id}`")),
        "partial success must give the precise recovery command: {stderr}"
    );
    let cluster: Value =
        serde_json::from_slice(&fs::read(root.path().join("cluster.json")).unwrap()).unwrap();
    assert_eq!(
        cluster[identity["namespace"].as_str().unwrap()]["metadata"]["labels"]["adm.dev/workspace-id"],
        identity["workspaceId"],
        "the workspace remains registered after attach failure"
    );
}

#[test]
fn interactive_create_failure_does_not_launch_the_terminal() {
    let root = fixture();
    let project = install_terminal_fixture(root.path());
    fs::write(root.path().join("missing-storage"), "fail provision").unwrap();

    let (status, stderr) = interactive_cli(
        root.path(),
        &project,
        &["create", "create-fails", "--no-repositories", "--herdr"],
    );

    assert!(!status.success(), "storage validation must fail creation");
    assert!(
        stderr.contains("storageclass adm-replicated not found"),
        "the creation cause stays visible: {stderr}"
    );
    assert!(
        !root.path().join("attach-invocations.jsonl").exists(),
        "failed creation must not launch a terminal"
    );
    assert!(
        !root.path().join("herdr-bin/calls").exists(),
        "failed creation must not query or create a Herdr space"
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
fn list_and_status_render_the_same_core_workspace_observation() {
    let root = fixture();
    let workspace = assert_ok(adm(root.path(), &["create", "demo", "--no-repositories"]));

    let list = adm(root.path(), &["list"]);
    assert!(list.status.success(), "{list:?}");
    let list = String::from_utf8_lossy(&list.stdout);
    let status = adm(root.path(), &["status", "demo"]);
    assert!(status.status.success(), "{status:?}");
    let status = String::from_utf8_lossy(&status.stdout);

    let expected_headers = [
        "NAME",
        "ROLE",
        "PHASE",
        "AGENT CONFIG",
        "RUNTIME",
        "ACTIVITY",
        "NODE",
        "ID",
    ];
    let list_headers = list
        .lines()
        .next()
        .unwrap()
        .split("  ")
        .map(str::trim)
        .filter(|column| !column.is_empty())
        .collect::<Vec<_>>();
    let status_headers = status
        .lines()
        .next()
        .unwrap()
        .split("  ")
        .map(str::trim)
        .filter(|column| !column.is_empty())
        .collect::<Vec<_>>();
    assert_eq!(list_headers, expected_headers);
    assert_eq!(status_headers, expected_headers);

    let list_row = list
        .lines()
        .nth(1)
        .unwrap()
        .split_whitespace()
        .collect::<Vec<_>>();
    let status_row = status
        .lines()
        .nth(1)
        .unwrap()
        .split_whitespace()
        .collect::<Vec<_>>();
    assert_eq!(list_row, status_row);
    assert_eq!(list_row[0], "demo");
    assert_eq!(list_row[1], "coding");
    assert_eq!(list_row[2], workspace["phase"]);
    assert_eq!(list_row[3], "enabled");
    assert_eq!(list_row[4], "Ready");
    assert_eq!(list_row[5], "unavailable");
    assert_eq!(list_row[6], "node-a");
    assert_eq!(list_row[7], workspace["id"]);
    assert!(status.contains("workspace Pod has no valid IP address"));

    let details = assert_ok(adm(root.path(), &["status", "demo", "--json"]));
    assert_eq!(details["workspace"]["id"], workspace["id"]);
    assert_eq!(details["cluster"]["pods"][0]["status"]["phase"], "Running");
    assert_eq!(
        details["cluster"]["pods"][0]["status"]["conditions"][0]["status"], "False",
        "the shared summary must use the lifecycle directory observation"
    );
    assert_eq!(details["agent"]["status"], "unavailable");
}

#[test]
fn failed_pod_summary_keeps_observed_node_and_failure_cause() {
    let root = fixture();
    assert_ok(adm(
        root.path(),
        &["create", "crashed", "--no-repositories"],
    ));
    fs::write(root.path().join("failed-pod"), "failed").unwrap();

    let output = adm(root.path(), &["status", "crashed"]);
    assert!(output.status.success(), "{output:?}");
    let output = String::from_utf8_lossy(&output.stdout);
    let row = output.lines().nth(1).unwrap();
    assert!(row.contains("NotReady (Failed)"), "{output}");
    assert!(row.contains("node-a"), "{output}");
    assert!(
        output.contains("workspace process exited unexpectedly"),
        "the observed Pod failure cause must remain visible: {output}"
    );
    assert!(
        !output.contains("Runtime unavailable:"),
        "a reported Failed Pod is an observed runtime state: {output}"
    );
}

#[test]
fn list_runtime_diagnostics_identify_the_workspace_row() {
    let root = fixture();
    let coding = assert_ok(adm(root.path(), &["create", "editor", "--no-repositories"]));
    let bot = assert_ok(adm(root.path(), &["create", "supervisor", "--role", "bot"]));

    let output = adm(root.path(), &["list"]);
    assert!(output.status.success(), "{output:?}");
    let output = String::from_utf8_lossy(&output.stdout);
    for (name, workspace) in [("editor", &coding), ("supervisor", &bot)] {
        let identity = format!("{name} ({})", workspace["id"].as_str().unwrap());
        assert!(
            output
                .lines()
                .any(|line| line.contains("Agent unavailable") && line.contains(&identity)),
            "missing diagnostic for {identity}: {output}"
        );
    }
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
            && status.contains("AGENT CONFIG")
            && status.contains("RUNTIME")
            && status.contains("ACTIVITY")
            && status.contains("NODE")
            && status.contains("ID"),
        "{status}"
    );
    assert!(
        status.contains("demo")
            && status.contains("coding")
            && status.contains("Ready")
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
    let ready_details = assert_ok(adm(root.path(), &["status", "demo", "--json"]));
    assert_eq!(
        ready_details["cluster"]["pods"][0]["status"]["conditions"][0]["status"],
        "True"
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
    let failed_list = adm(root.path(), &["list"]);
    let failed_status = adm(root.path(), &["status", "retry-me"]);
    assert!(failed_list.status.success(), "{failed_list:?}");
    assert!(failed_status.status.success(), "{failed_status:?}");
    let failed_list_row = String::from_utf8_lossy(&failed_list.stdout)
        .lines()
        .nth(1)
        .unwrap()
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let failed_status_row = String::from_utf8_lossy(&failed_status.stdout)
        .lines()
        .nth(1)
        .unwrap()
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    assert_eq!(failed_list_row, failed_status_row);
    assert_eq!(failed_status_row[2], "failed");
    assert_eq!(failed_status_row[4], "Ready");

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
fn overlapping_create_retries_report_the_in_progress_operation() {
    let root = fixture();
    let args = ["create", "retry-overlap", "--no-repositories"];
    fs::write(root.path().join("fail-wait-once"), "fail").unwrap();
    assert!(!adm(root.path(), &args).status.success());
    let original = assert_ok(adm(root.path(), &["list", "--json"]))[0].clone();
    let mut spec = original.clone();
    for field in [
        "id",
        "namespace",
        "phase",
        "creation_operation_id",
        "deletion_operation_id",
        "created_at",
        "last_error",
        "runtime_status",
        "activity",
        "effective_model",
        "requested_model",
    ] {
        spec.as_object_mut().unwrap().remove(field);
    }
    let url = fs::read_to_string(root.path().join("lifecycle-url")).unwrap();
    fs::write(root.path().join("delay-readiness"), "hold").unwrap();
    let active_operation = "bc4626e1-b651-4272-9754-c2f8f9df1d5f";
    let responses = std::thread::scope(|scope| {
        let retry = scope.spawn(|| {
            let mut retry = args.to_vec();
            retry.extend(["--operation-id", active_operation]);
            adm(root.path(), &retry)
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !root.path().join("entered-readiness").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "retry never reached readiness"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let responses = [
            "8ef19bae-74ac-4d30-9c7b-d781d84486b7",
            original["creation_operation_id"].as_str().unwrap(),
        ]
        .map(|operation_id| {
            let response = reqwest::blocking::Client::new()
                .post(format!("{url}/v1/operations"))
                .bearer_auth("fixture-lifecycle-token")
                .json(&serde_json::json!({"operationId":operation_id,"kind":"create","spec":spec}))
                .send()
                .unwrap();
            (response.status(), response.text().unwrap())
        });
        fs::write(root.path().join("release-readiness"), "continue").unwrap();
        let ready = assert_ok(retry.join().unwrap());
        assert_eq!(ready["id"], original["id"]);
        responses
    });
    for (status, body) in responses {
        assert_eq!(status, 400, "{body}");
        assert!(body.contains("creation is already in progress"), "{body}");
        assert!(body.contains(active_operation), "{body}");
    }
    let workspaces = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(workspaces.as_array().unwrap().len(), 1);
    assert_eq!(workspaces[0]["id"], original["id"]);
    assert_eq!(workspaces[0]["phase"], "ready");
}

#[test]
fn stale_failed_create_replay_cannot_resume_a_replacement_with_the_same_name() {
    let root = fixture();
    let args = ["create", "retry-deleted", "--no-repositories"];
    fs::write(root.path().join("fail-wait-once"), "fail").unwrap();
    assert!(!adm(root.path(), &args).status.success());
    let original = assert_ok(adm(root.path(), &["list", "--json"]))[0].clone();
    assert_ok(adm(root.path(), &["destroy", "retry-deleted", "--wait"]));

    fs::write(root.path().join("fail-wait-once"), "fail").unwrap();
    assert!(!adm(root.path(), &args).status.success());
    let replacement = assert_ok(adm(root.path(), &["list", "--json"]))[0].clone();
    assert_ne!(replacement["id"], original["id"]);
    assert_eq!(replacement["phase"], "failed");

    let mut replay = args.to_vec();
    replay.extend([
        "--operation-id",
        original["creation_operation_id"].as_str().unwrap(),
    ]);
    let stale = adm(root.path(), &replay);
    assert!(!stale.status.success());
    let workspaces = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(workspaces.as_array().unwrap().len(), 1);
    assert_eq!(workspaces[0], replacement);
    assert!(String::from_utf8_lossy(&stale.stderr).contains("deleted"));
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
    let same_id_other_session = assert_ok(adm(
        root.path(),
        &["create", "herdr-other-session", "--no-repositories"],
    ));
    assert_ok(adm_in_herdr(
        root.path(),
        &["herdr", "bind", "herdr-owned", "space-123"],
        &root.path().join("herdr.sock"),
    ));
    assert_ok(adm_in_herdr(
        root.path(),
        &["herdr", "bind", "herdr-other", "space-456"],
        &root.path().join("herdr.sock"),
    ));
    assert_ok(adm_in_herdr(
        root.path(),
        &["herdr", "bind", "herdr-stale", "space-missing"],
        &root.path().join("herdr.sock"),
    ));
    assert_ok(adm_in_herdr(
        root.path(),
        &["herdr", "bind", "herdr-other-session", "space-123"],
        &root.path().join("different-session.sock"),
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
                "data":{"type":"workspace_closed","workspace_id":"space-123"}
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
    assert!(remaining.as_array().unwrap().iter().any(|workspace| {
        workspace["id"] == same_id_other_session["id"] && workspace["phase"] == "ready"
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

    fn receipt_path(root: &Path, workspace_id: &str) -> PathBuf {
        let hash = workspace_id
            .bytes()
            .fold(0xcbf29ce484222325u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
            });
        root.join("state")
            .join(format!("herdr-closed-{hash:016x}.json"))
    }

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
    let other_workspace = assert_ok(adm(
        root.path(),
        &["create", "journaled-other-session", "--no-repositories"],
    ));
    assert_ok(adm_in_herdr(
        root.path(),
        &["herdr", "bind", "journaled", "space-journal"],
        &root.path().join("herdr-first.sock"),
    ));
    let other_socket = root.path().join("herdr-second.sock");
    assert_ok(adm_in_herdr(
        root.path(),
        &[
            "herdr",
            "bind",
            "journaled-other-session",
            "space-other-session",
        ],
        &other_socket,
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
    let first_receipt = receipt_path(root.path(), workspace["id"].as_str().unwrap());
    assert!(first_receipt.exists());

    fs::write(&lifecycle_url_path, lifecycle_url).unwrap();
    let other_event = r#"{"event":"workspace_closed","data":{"type":"workspace_closed","workspace_id":"space-other-session"}}"#;
    let other_cleanup = adm_in_herdr_with_input(
        root.path(),
        &["herdr", "events"],
        &format!("{other_event}\n"),
        &other_socket,
    );
    assert!(
        other_cleanup.status.success(),
        "{}",
        String::from_utf8_lossy(&other_cleanup.stderr)
    );
    let other_receipt = receipt_path(root.path(), other_workspace["id"].as_str().unwrap());
    assert!(!other_receipt.exists());
    assert!(
        first_receipt.exists(),
        "another session cleared this pending close receipt"
    );

    let retry_socket = root.path().join("herdr-retry.sock");
    let retry_server = fake_socket(&retry_socket, None);
    let recovered_cleanup = watch(root.path(), &retry_socket);
    retry_server.join().unwrap();
    let stdout = String::from_utf8_lossy(&recovered_cleanup.stdout);
    assert!(stdout.contains("\"status\":\"accepted\""), "{stdout}");
    assert!(!first_receipt.exists());
    let remaining = assert_ok(adm(root.path(), &["list", "--json"]));
    for workspace in [&workspace, &other_workspace] {
        let entry = remaining
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == workspace["id"])
            .unwrap();
        assert!(matches!(
            entry["phase"].as_str().unwrap(),
            "deleting" | "deleted"
        ));
    }
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
    assert_ok(adm_in_herdr(
        root.path(),
        &["herdr", "bind", "herdr-owned", "space-123"],
        &root.path().join("events.sock"),
    ));

    let event = r#"{"event":"workspace_closed","data":{"type":"workspace_closed","workspace_id":"space-123"}}"#;
    let output = adm_in_herdr_with_input(
        root.path(),
        &["herdr", "events"],
        &format!("{event}\n"),
        &root.path().join("events.sock"),
    );
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
fn herdr_bind_renames_the_explicit_space_and_scopes_ownership_to_its_session() {
    let root = fixture();
    let lifecycle_url = fs::read_to_string(root.path().join("lifecycle-url")).unwrap();
    let workspace = assert_ok(adm(
        root.path(),
        &["create", "bound-project", "--no-repositories"],
    ));
    let prior_shell = root.path().join("prior-shell");
    let prior_args = root.path().join("prior-shell-args");
    let prior_marker = root.path().join("prior-shell-marker");
    fs::write(
        &prior_shell,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' \"${{ADM_HERDR_INITIAL_PANE-unset}}\" > '{}'\n",
            prior_args.display(),
            prior_marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&prior_shell, fs::Permissions::from_mode(0o755)).unwrap();
    fs::create_dir_all(root.path().join("config/herdr")).unwrap();
    fs::write(
        root.path().join("config/herdr/config.toml"),
        format!(
            "# user setting\n[terminal]\ndefault_shell = \"{}\"\nshell_mode = \"login\"\n",
            prior_shell.display()
        ),
    )
    .unwrap();
    let calls = root.path().join("herdr-calls");
    // The fixture models the running Herdr server: it only sees config.toml as
    // of its last `server reload-config`, like stock Herdr 0.9.
    let live_config = root.path().join("herdr-live-config.toml");
    let herdr = root.path().join("herdr-bin/herdr");
    fs::write(
        &herdr,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1 $2\" = 'workspace get' ]; then printf '{{\"result\":{{\"workspace\":{{\"workspace_id\":\"%s\"}}}}}}\\n' \"$3\"; fi\nif [ \"$1 $2\" = 'server reload-config' ]; then cp \"$XDG_CONFIG_HOME/herdr/config.toml\" '{}'; printf '{{\"result\":{{\"diagnostics\":[],\"status\":\"applied\",\"type\":\"config_reload\"}}}}\\n'; fi\n",
            calls.display(),
            live_config.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&herdr, fs::Permissions::from_mode(0o755)).unwrap();
    let socket = root.path().join("herdr-session-a.sock");
    let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
    command
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &socket)
        .env(
            "PATH",
            format!(
                "{}:{}",
                root.path().join("herdr-bin").display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"));
    configure_lifecycle(&mut command, root.path());
    command.args(["herdr", "bind", "bound-project", "w1"]);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let calls = fs::read_to_string(calls).unwrap();
    assert!(
        calls
            .lines()
            .any(|call| call == "workspace rename w1 bound-project"),
        "{calls}"
    );
    let stored = assert_ok(adm(root.path(), &["list", "--json"]));
    assert_eq!(stored[0]["id"], workspace["id"]);
    assert!(
        stored[0]["herdr_space"]
            .as_str()
            .unwrap()
            .contains("herdr-session-a.sock")
    );
    let config_path = root.path().join("config/herdr/config.toml");
    let enabled = fs::read_to_string(&config_path).unwrap();
    assert!(enabled.contains("herdr-shell-router"), "{enabled}");
    assert_eq!(
        fs::read_to_string(&live_config).unwrap(),
        enabled,
        "the running Herdr server must load the router before new panes open"
    );
    assert!(enabled.contains("shell_mode = \"login\""), "{enabled}");
    assert!(enabled.contains("# user setting"), "{enabled}");
    fs::create_dir_all(root.path().join("config/adm")).unwrap();
    fs::write(
        root.path().join("config/adm/config.json"),
        serde_json::to_vec(&serde_json::json!({
            "lifecycle": {
                "url": fs::read_to_string(root.path().join("lifecycle-url")).unwrap(),
                "forward": false,
                "namespace": "adm-system",
                "kubectl": root.path().join("kubectl"),
                "kubeconfig": "fixture-kubeconfig",
                "tokenFile": root.path().join("lifecycle-token")
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let initial_pane = adm_in_herdr(root.path(), &["herdr", "route-shell", "--"], &socket);
    assert!(
        initial_pane.status.success(),
        "{}",
        String::from_utf8_lossy(&initial_pane.stderr)
    );
    assert_eq!(fs::read_to_string(&prior_args).unwrap(), "\n");
    assert_eq!(fs::read_to_string(&prior_marker).unwrap(), "unset\n");
    let mut bound_pane = Command::new(env!("CARGO_BIN_EXE_adm"));
    bound_pane
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &socket)
        .env("HERDR_WORKSPACE_ID", "w1")
        .env(
            "PATH",
            format!(
                "{}:{}",
                root.path().join("herdr-bin").display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"));
    bound_pane.args(["herdr", "route-shell", "--"]);
    let bound_pane = bound_pane.output().unwrap();
    assert!(
        bound_pane.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&bound_pane.stdout),
        String::from_utf8_lossy(&bound_pane.stderr)
    );
    let exec: Value =
        serde_json::from_slice(&fs::read(root.path().join("exec-args.json")).unwrap()).unwrap();
    assert_eq!(
        exec[exec
            .as_array()
            .unwrap()
            .iter()
            .position(|arg| arg == "-n")
            .unwrap()
            + 1],
        workspace["namespace"]
    );
    assert!(exec.as_array().unwrap().iter().any(|arg| arg == "/repos"));
    fs::write(root.path().join("lifecycle-url"), "http://127.0.0.1:1").unwrap();
    let client_config_path = root.path().join("config/adm/config.json");
    let mut client_config: Value =
        serde_json::from_slice(&fs::read(&client_config_path).unwrap()).unwrap();
    client_config["lifecycle"]["forward"] = true.into();
    fs::write(
        &client_config_path,
        serde_json::to_vec(&client_config).unwrap(),
    )
    .unwrap();
    let unbound = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &socket)
        .env("HERDR_WORKSPACE_ID", "unbound-space")
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .args(["herdr", "route-shell", "--", "passed-argument"])
        .output()
        .unwrap();
    assert!(
        unbound.status.success(),
        "{}",
        String::from_utf8_lossy(&unbound.stderr)
    );
    fs::write(root.path().join("lifecycle-url"), lifecycle_url).unwrap();
    assert_eq!(
        fs::read_to_string(&prior_args).unwrap(),
        "passed-argument\n"
    );
    let disabled = adm(root.path(), &["herdr", "disable"]);
    assert!(
        disabled.status.success(),
        "{}",
        String::from_utf8_lossy(&disabled.stderr)
    );
    let restored = fs::read_to_string(&config_path).unwrap();
    assert!(restored.contains(&format!("default_shell = \"{}\"", prior_shell.display())));
    assert_eq!(
        fs::read_to_string(&live_config).unwrap(),
        restored,
        "disable must make the running Herdr server stop routing new panes"
    );
    assert!(restored.contains("shell_mode = \"login\""));
    let updated_shell = root.path().join("updated-shell");
    fs::write(
        &config_path,
        format!(
            "# updated by the user\n[terminal]\ndefault_shell = \"{}\"\nshell_mode = \"login\"\n",
            updated_shell.display()
        ),
    )
    .unwrap();
    let rebound = adm_in_herdr(
        root.path(),
        &["herdr", "bind", "bound-project", "w1"],
        &socket,
    );
    assert!(
        rebound.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&rebound.stdout),
        String::from_utf8_lossy(&rebound.stderr)
    );
    let disabled_again = adm(root.path(), &["herdr", "disable"]);
    assert!(
        disabled_again.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&disabled_again.stdout),
        String::from_utf8_lossy(&disabled_again.stderr)
    );
    let restored_again = fs::read_to_string(&config_path).unwrap();
    assert!(
        restored_again.contains(&format!("default_shell = \"{}\"", updated_shell.display())),
        "{restored_again}"
    );
    assert!(restored_again.contains("# updated by the user"));
    let second_device = root.path().join("second-device");
    let separate = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", second_device.join("config"))
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &socket)
        .arg("--state-dir")
        .arg(second_device.join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .args(["herdr", "status", "--json"])
        .output()
        .unwrap();
    assert!(
        separate.status.success(),
        "{}",
        String::from_utf8_lossy(&separate.stderr)
    );
    let separate: Value = serde_json::from_slice(&separate.stdout).unwrap();
    assert_eq!(separate["binding_count"], 0);
    assert_eq!(separate["pane_routing"], "disabled");
    assert_eq!(separate["event_delivery"], "unavailable");
}

#[test]
fn herdr_open_returns_ids_from_a_stock_protocol_workspace_create_response() {
    use std::io::BufRead;

    let root = fixture();
    let local_cwd = root.path().join("local-project");
    fs::create_dir_all(&local_cwd).unwrap();
    let expected_cwd = local_cwd.clone();
    let socket = root.path().join("herdr-create.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "workspace.create");
        assert_eq!(request["params"]["label"], "api-project");
        assert_eq!(
            request["params"]["cwd"],
            expected_cwd.to_string_lossy().as_ref()
        );
        assert_eq!(request["params"]["focus"], false);
        assert_eq!(
            request["params"]["env"],
            serde_json::json!({"ADM_HERDR_INITIAL_PANE":"local"})
        );
        let workspace = serde_json::json!({
            "workspace_id":"w22","number":2,"label":"api-project","focused":false,
            "pane_count":1,"tab_count":1,"active_tab_id":"w22:t3","agent_status":"idle"
        });
        let tab = serde_json::json!({
            "tab_id":"w22:t3","workspace_id":"w22","number":1,"label":"api-project",
            "focused":false,"pane_count":1,"agent_status":"idle"
        });
        let pane = serde_json::json!({
            "pane_id":"w22:p7","terminal_id":"term-7","workspace_id":"w22","tab_id":"w22:t3",
            "focused":false,"agent_status":"idle","revision":1
        });
        writeln!(
            reader.get_mut(),
            "{}",
            serde_json::json!({
                "id":request["id"],"result":{"type":"workspace_created","workspace":workspace,"tab":tab,"root_pane":pane}
            })
        )
        .unwrap();
    });
    let output = adm_in_herdr(
        root.path(),
        &[
            "herdr",
            "create-space",
            "api-project",
            local_cwd.to_str().unwrap(),
        ],
        &socket,
    );
    server.join().unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let opened: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(opened["workspace_id"], "w22");
    assert_eq!(opened["tab_id"], "w22:t3");
    assert_eq!(opened["pane_id"], "w22:p7");

    let workspace = assert_ok(adm(
        root.path(),
        &["create", "initial-pane-race", "--no-repositories"],
    ));
    let prior_shell = root.path().join("initial-pane-shell");
    let prior_args = root.path().join("initial-pane-args");
    let prior_marker = root.path().join("initial-pane-marker");
    fs::write(
        &prior_shell,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' \"${{ADM_HERDR_INITIAL_PANE-unset}}\" > '{}'\n",
            prior_args.display(),
            prior_marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&prior_shell, fs::Permissions::from_mode(0o755)).unwrap();
    fs::create_dir_all(root.path().join("config/herdr")).unwrap();
    fs::write(
        root.path().join("config/herdr/config.toml"),
        format!(
            "[terminal]\ndefault_shell = \"{}\"\n",
            prior_shell.display()
        ),
    )
    .unwrap();
    let bound = adm_in_herdr(
        root.path(),
        &["herdr", "bind", "initial-pane-race", "w22"],
        &socket,
    );
    assert!(
        bound.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&bound.stdout),
        String::from_utf8_lossy(&bound.stderr)
    );

    let route = |pane_id: &str| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
        command
            .env("XDG_CONFIG_HOME", root.path().join("config"))
            .env("HERDR_ENV", "1")
            .env("HERDR_SOCKET_PATH", &socket)
            .env("HERDR_WORKSPACE_ID", "w22")
            .env("HERDR_PANE_ID", pane_id)
            .env("ADM_HERDR_INITIAL_PANE", "local")
            .arg("--state-dir")
            .arg(root.path().join("state"))
            .arg("--kubectl")
            .arg(root.path().join("kubectl"));
        configure_lifecycle(&mut command, root.path());
        command
            .args(["herdr", "route-shell", "--"])
            .output()
            .unwrap()
    };
    // A sibling pane may enter the router before the root pane starts. It must
    // not consume the root pane's local-only marker.
    let sibling = route("w22:p8");
    assert!(
        sibling.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&sibling.stdout),
        String::from_utf8_lossy(&sibling.stderr)
    );
    let exec: Value =
        serde_json::from_slice(&fs::read(root.path().join("exec-args.json")).unwrap()).unwrap();
    assert!(exec.as_array().unwrap().iter().any(|arg| arg == "/repos"));

    let root_pane = route("w22:p7");
    assert!(
        root_pane.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&root_pane.stdout),
        String::from_utf8_lossy(&root_pane.stderr)
    );
    assert_eq!(fs::read_to_string(prior_args).unwrap(), "\n");
    assert_eq!(fs::read_to_string(prior_marker).unwrap(), "unset\n");
    assert_eq!(
        workspace["id"],
        assert_ok(adm(root.path(), &["list", "--json"]))[0]["id"]
    );
}

#[test]
fn herdr_status_only_reports_event_delivery_when_watcher_and_socket_are_live() {
    use std::io::BufRead;
    use std::sync::mpsc;

    let root = fixture();
    let socket = root.path().join("herdr-status.sock");
    let unavailable = adm_in_herdr(root.path(), &["herdr", "status", "--json"], &socket);
    assert!(unavailable.status.success());
    let unavailable: Value = serde_json::from_slice(&unavailable.stdout).unwrap();
    assert_eq!(unavailable["event_delivery"], "unavailable");
    assert_eq!(unavailable["pane_routing"], "disabled");
    assert!(
        unavailable["event_delivery_error"]
            .as_str()
            .unwrap()
            .contains("no live watcher control socket")
    );

    let listener = UnixListener::bind(&socket).unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (watch_stream, _) = listener.accept().unwrap();
        let mut watch_reader = std::io::BufReader::new(watch_stream.try_clone().unwrap());
        let mut line = String::new();
        watch_reader.read_line(&mut line).unwrap();
        let watch_request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(watch_request["method"], "events.subscribe");
        writeln!(
            watch_reader.get_mut(),
            "{}",
            serde_json::json!({
                "id":watch_request["id"],"result":{"type":"subscription_started"}
            })
        )
        .unwrap();
        ready_tx.send(()).unwrap();
        let mut line = String::new();
        let _ = watch_reader.read_line(&mut line);
        drop(watch_stream);
    });

    let mut watcher = Command::new(env!("CARGO_BIN_EXE_adm"));
    watcher
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &socket)
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--kubectl")
        .arg(root.path().join("kubectl"))
        .args(["herdr", "watch", "--socket"])
        .arg(&socket)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_lifecycle(&mut watcher, root.path());
    let mut watcher = watcher.spawn().unwrap();
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let mut watcher_stdout = std::io::BufReader::new(watcher.stdout.take().unwrap());
    let mut line = String::new();
    watcher_stdout.read_line(&mut line).unwrap();
    assert!(line.contains("\"status\":\"watching\""), "{line}");
    let healthy = adm_in_herdr(root.path(), &["herdr", "status", "--json"], &socket);
    assert!(
        healthy.status.success(),
        "{}",
        String::from_utf8_lossy(&healthy.stderr)
    );
    let healthy: Value = serde_json::from_slice(&healthy.stdout).unwrap();
    assert_eq!(healthy["event_delivery"], "watching");
    let disabled = adm(root.path(), &["herdr", "disable"]);
    if !disabled.status.success() {
        let exited = watcher.try_wait().unwrap();
        let watcher_error = if exited.is_some() {
            let mut error = String::new();
            watcher
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut error)
                .unwrap();
            error
        } else {
            "watcher process is still running".to_owned()
        };
        panic!(
            "stdout={} stderr={} watcher={watcher_error}",
            String::from_utf8_lossy(&disabled.stdout),
            String::from_utf8_lossy(&disabled.stderr)
        );
    }
    server.join().unwrap();
    let mut rest = String::new();
    watcher_stdout.read_to_string(&mut rest).unwrap();
    assert!(watcher.wait().unwrap().success(), "{rest}");
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
    assert!(String::from_utf8_lossy(&setup.stdout).contains("Close-event cleanup is optional"));
    assert_ok(adm(
        root.path(),
        &["create", "herdr-owned", "--no-repositories"],
    ));
    let hook = adm(root.path(), &["herdr", "hook"]);
    assert!(hook.status.success());
    let hook = String::from_utf8(hook.stdout).unwrap();
    assert!(hook.contains("herdr bind"), "{hook}");
    assert!(hook.contains("herdr status"), "{hook}");
    assert!(hook.contains("no replay cursor"), "{hook}");
    let fake_bin = root.path().join("fake-bin");
    fs::create_dir_all(&fake_bin).unwrap();
    let herdr = fake_bin.join("herdr");
    fs::write(
        &herdr,
        "#!/bin/sh\nif [ \"$1 $2\" = 'server reload-config' ]; then\n  if [ -f \"$(dirname \"$0\")/fail-reload\" ]; then echo 'error: herdr server is not running' >&2; exit 1; fi\n  printf '%s\\n' '{\"result\":{\"diagnostics\":[],\"status\":\"applied\",\"type\":\"config_reload\"}}'\n  exit 0\nfi\nif [ \"$1\" = workspace ] && [ \"$2\" = get ] && [ \"$3\" = live-space ]; then\n  printf '%s\\n' '{\"result\":{\"workspace\":{\"workspace_id\":\"live-space\"}}}'\n  exit 0\nfi\nif [ \"$1\" = workspace ] && [ \"$2\" = rename ] && [ \"$3\" = live-space ]; then exit 0; fi\nprintf '%s\\n' '{\"error\":{\"message\":\"workspace not found\"}}' >&2\nexit 1\n",
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
            .env("HERDR_ENV", "1")
            .env("HERDR_SOCKET_PATH", root.path().join("herdr-session.sock"))
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

    fs::write(fake_bin.join("fail-reload"), "fail").unwrap();
    let unreloaded = bind("live-space");
    assert!(!unreloaded.status.success());
    let stderr = String::from_utf8_lossy(&unreloaded.stderr);
    assert!(
        stderr.contains("herdr server reload-config")
            && stderr.contains("herdr server is not running"),
        "routing must fail loudly when the running Herdr cannot load it: {stderr}"
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
    assert!(script.contains("--branch"), "{script}");
    assert!(script.contains("--base"), "{script}");
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
for input in $'adm li\t' $'adm herdr b\t' $'adm list --j\t' $'adm --state-d\t' $'adm create complete --br\t' $'adm create complete --ba\t'; do
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
        "adm create complete --branch",
        "adm create complete --base",
    ] {
        assert!(
            candidates.contains(candidate),
            "missing {candidate:?}: {candidates}"
        );
    }
}

#[test]
fn herdr_bound_pane_failure_stays_visible_until_the_user_closes_it() {
    use std::io::BufRead;
    use std::os::fd::{FromRawFd, RawFd};

    let root = fixture();
    let workspace = assert_ok(adm(
        root.path(),
        &["create", "pane-failure", "--no-repositories"],
    ));
    let socket = root.path().join("herdr-pane-failure.sock");
    let bound = adm_in_herdr(
        root.path(),
        &["herdr", "bind", "pane-failure", "w31"],
        &socket,
    );
    assert!(
        bound.status.success(),
        "{}",
        String::from_utf8_lossy(&bound.stderr)
    );

    // Herdr closes a pane as soon as its shell exits, so an immediate exit
    // would hide the routing error. A real pane has a terminal on stdin.
    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        },
        0
    );
    let mut master = unsafe { fs::File::from_raw_fd(master) };
    let slave = unsafe { fs::File::from_raw_fd(slave) };
    let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
    command
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", &socket)
        .env("HERDR_WORKSPACE_ID", "w31")
        .env("HERDR_PANE_ID", "w31:p2")
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .args(["--kubectl", "/bin/false"]);
    configure_lifecycle(&mut command, root.path());
    let mut child = command
        .args(["herdr", "route-shell", "--"])
        .stdin(Stdio::from(slave.try_clone().unwrap()))
        .stdout(Stdio::from(slave))
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stderr = std::io::BufReader::new(child.stderr.take().unwrap());
    let mut shown = String::new();
    while !shown.contains("Press Enter") {
        let mut line = String::new();
        if stderr.read_line(&mut line).unwrap() == 0 {
            break;
        }
        shown.push_str(&line);
    }
    assert!(
        shown.contains("Press Enter to close this pane"),
        "routing failure must hold the pane open: {shown}"
    );
    assert!(
        shown.contains(workspace["id"].as_str().unwrap()),
        "failure must name the bound immutable workspace: {shown}"
    );
    master.write_all(b"\n").unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success());
}
