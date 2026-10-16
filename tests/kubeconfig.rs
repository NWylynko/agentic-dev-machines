use serde_json::{Value, json};
use std::{
    fs,
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
    thread,
    time::{Duration, Instant},
};

struct RunnerCleanup {
    root: PathBuf,
    url: String,
}

impl Drop for RunnerCleanup {
    fn drop(&mut self) {
        let _ = Command::new(env!("CARGO_BIN_EXE_adm"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .arg("--state-dir")
            .arg(self.root.join("state"))
            .arg("--runner-url")
            .arg(&self.url)
            .arg("stop")
            .output();
    }
}

fn invoke(root: &Path, url: &str, kubeconfig: &str, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_adm"))
        .current_dir(root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env(
            "ADM_TEST_REMOTE_ENV",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("packages/runner/src/remote-env-server.ts"),
        )
        .env("ADM_TEST_PROXY", root.join("remote-proxy.mjs"))
        .env("ADM_TEST_TARGET", root.join("intended-workspace"))
        .env("KUBECONFIG", kubeconfig)
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--runner-url")
        .arg(url)
        .arg("--kubectl")
        .arg(root.join("kubectl"))
        .args(args)
        .output()
        .expect("run public adm CLI")
}

fn assert_success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("CLI JSON response")
}

fn request(url: &str, method: &str, path: &str, body: Option<&Value>) -> Value {
    let client = reqwest::blocking::Client::new();
    let mut request = client.request(method.parse().unwrap(), format!("{url}{path}"));
    if let Some(body) = body {
        request = request.json(body);
    }
    request.send().unwrap().json().unwrap()
}

fn wait_for_answer(url: &str, id: &str, after: u64, expected: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let history = request(
            url,
            "GET",
            &format!("/v1/workspaces/{id}/history?after={after}"),
            None,
        );
        if let Some(event) = history["events"].as_array().and_then(|events| {
            events.iter().find(|event| {
                event["kind"] == "assistant"
                    && event["data"]["text"]
                        .as_str()
                        .is_some_and(|text| text.contains(expected))
            })
        }) {
            return event.clone();
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("runner did not finish workspace tools");
}

fn wait_for_runner_stop(url: &str) {
    let client = reqwest::blocking::Client::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if client.get(format!("{url}/health")).send().is_err() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("runner did not stop after adm stop");
}

#[test]
fn coding_tools_keep_the_cli_kubernetes_context_after_runner_restart() {
    let root = tempfile::tempdir().unwrap();
    let intended = root.path().join("intended-workspace");
    let wrong = root.path().join("wrong-context-workspace");
    let host = root.path().join("management-host");
    fs::create_dir_all(&intended).unwrap();
    fs::create_dir_all(&wrong).unwrap();
    fs::create_dir_all(&host).unwrap();
    fs::write(
        root.path().join("remote-proxy.mjs"),
        r#"import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const target = process.env.ADM_TEST_TARGET;
const args = process.argv.slice(2);
args[args.indexOf('--cwd') + 1] = target;
const child = spawn(process.execPath, args, { stdio: ['pipe', 'inherit', 'inherit'] });
createInterface({ input: process.stdin }).on('line', (line) => {
  const replace = (value) => {
    if (value === '/repos') return target;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  const message = replace(JSON.parse(line));
  child.stdin.write(`${JSON.stringify(message)}\n`);
});
child.on('exit', (code) => process.exit(code ?? 1));
"#,
    )
    .unwrap();
    let good_config = root.path().join("good-kubeconfig");
    let extra_config = root.path().join("extra-kubeconfig");
    let wrong_config = root.path().join("wrong-kubeconfig");
    fs::write(&good_config, format!("target={}\n", intended.display())).unwrap();
    fs::write(&extra_config, "additional context\n").unwrap();
    fs::write(&wrong_config, format!("target={}\n", wrong.display())).unwrap();
    let good_list = "good-kubeconfig:extra-kubeconfig".to_owned();
    let expected_good_list = format!("{}:{}", good_config.display(), extra_config.display());

    let kubectl = root.path().join("kubectl");
    fs::write(
        &kubectl,
        r##"#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
path = pathlib.Path(__file__).parent
with open(path / 'kubeconfig.log', 'a') as log:
    log.write(os.environ.get('KUBECONFIG', '<unset>') + '\n')
if args[:2] == ['get', 'storageclass']:
    print(json.dumps({'metadata':{'name':args[2]},'provisioner':'driver.longhorn.io'}))
elif args[:2] == ['get', 'namespace']:
    print((path / 'namespace.json').read_text())
elif args[0] == 'apply':
    manifest = json.load(sys.stdin)
    namespace = next(item for item in manifest['items'] if item['kind'] == 'Namespace')
    (path / 'namespace.json').write_text(json.dumps(namespace))
    print('applied')
elif args[0] == 'wait':
    print('condition met')
elif args[0] == 'exec':
    with open(path / 'exec-contexts.log', 'a') as log:
        log.write(os.environ.get('KUBECONFIG', '<unset>') + '\n')
    config = pathlib.Path(os.environ['KUBECONFIG'].split(':')[0]).read_text()
    target = next(line[7:] for line in config.splitlines() if line.startswith('target='))
    os.environ['ADM_TEST_TARGET'] = target
    command = args[args.index('--') + 1:]
    command[command.index('--cwd') + 1] = target
    command[1] = os.environ['ADM_TEST_REMOTE_ENV']
    command.insert(2, command[1])
    command[0] = 'node'
    command[1] = os.environ['ADM_TEST_PROXY']
    os.chdir(target)
    os.execvp(command[0], command)
else:
    print('unexpected kubectl arguments: '+repr(args), file=sys.stderr); sys.exit(2)
"##,
    )
    .unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let start = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env(
            "ADM_TEST_REMOTE_ENV",
            Path::new(env!("CARGO_MANIFEST_DIR")).join("packages/runner/src/remote-env-server.ts"),
        )
        .env("ADM_TEST_PROXY", root.path().join("remote-proxy.mjs"))
        .env("ADM_TEST_TARGET", &intended)
        .env("KUBECONFIG", &wrong_config)
        .arg("--state-dir")
        .arg(root.path().join("state"))
        .arg("--runner-url")
        .arg(&url)
        .arg("--kubectl")
        .arg(&kubectl)
        .arg("start")
        .output()
        .unwrap();
    assert_success(start);
    let _cleanup = RunnerCleanup {
        root: root.path().to_path_buf(),
        url: url.clone(),
    };

    let created = assert_success(invoke(
        root.path(),
        &url,
        &good_list,
        &[
            "--kubeconfig",
            &good_list,
            "create",
            "context-test",
            "--model",
            "faux/faux-1",
            "--storage-class",
            "replicated-test",
        ],
    ));
    let id = created["id"].as_str().unwrap();
    let goal = request(
        &url,
        "POST",
        &format!("/v1/workspaces/{id}/goals"),
        Some(&json!({"description":"Keep this workspace's recovery goal"})),
    );
    assert_eq!(goal["description"], "Keep this workspace's recovery goal");
    let next_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 600_000;
    let loop_record = request(
        &url,
        "POST",
        &format!("/v1/workspaces/{id}/loops"),
        Some(&json!({
            "prompt":"Wait for a later explicit recovery check",
            "intervalMs":60000,
            "nextAt":next_at
        })),
    );
    assert_eq!(loop_record["status"], "active");
    let plan = json!({
        "calls":[
            {"tool":"bash","args":{"command":"printf private > noted.txt"}},
            {"tool":"write","args":{"path":"created.txt","content":"intended workspace"}},
            {"tool":"read","args":{"path":"created.txt"}}
        ],
        "answer":"Workspace tools completed"
    });
    let submitted = request(
        &url,
        "POST",
        &format!("/v1/workspaces/{id}/input"),
        Some(&json!({"message":format!("/faux {plan}"),"requestId":"context-check"})),
    );
    assert_eq!(submitted["status"], "admitted");
    let answer = wait_for_answer(&url, id, 0, "Workspace tools completed");
    assert!(
        answer["data"]["text"]
            .as_str()
            .unwrap()
            .contains("Workspace tools completed")
    );

    let registry_path = root.path().join("state/runner/workspaces.json");
    let mut registry: Vec<Value> =
        serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
    registry[0].as_object_mut().unwrap().remove("kubeconfig");
    fs::write(&registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();
    assert_success(invoke(
        root.path(),
        &url,
        wrong_config.to_str().unwrap(),
        &["stop"],
    ));
    wait_for_runner_stop(&url);
    assert_success(invoke(
        root.path(),
        &url,
        wrong_config.to_str().unwrap(),
        &["start"],
    ));

    let failed_input = request(
        &url,
        "POST",
        &format!("/v1/workspaces/{id}/input"),
        Some(
            &json!({"message":"/faux {\"calls\":[{\"tool\":\"read\",\"args\":{\"path\":\"created.txt\"}}],\"answer\":\"unexpected\"}","requestId":"legacy-failure"}),
        ),
    );
    assert_eq!(failed_input["status"], "admitted");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut legacy_history = Value::Null;
    while Instant::now() < deadline {
        legacy_history = request(
            &url,
            "GET",
            &format!("/v1/workspaces/{id}/history?after=0"),
            None,
        );
        if legacy_history["events"].as_array().is_some_and(|events| {
            events.iter().any(|event| {
                event["kind"] == "tool"
                    && event["data"]["isError"] == true
                    && event["data"]["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("no pinned Kubernetes connection"))
            })
        }) {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        legacy_history["events"].as_array().is_some_and(|events| {
            events.iter().any(|event| {
                event["kind"] == "tool"
                    && event["data"]["isError"] == true
                    && event["data"]["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("no pinned Kubernetes connection"))
            })
        }),
        "legacy tool should fail loudly: {legacy_history}"
    );

    let reconnected = assert_success(invoke(
        root.path(),
        &url,
        wrong_config.to_str().unwrap(),
        &["reconnect", "context-test", "--kubeconfig", &good_list],
    ));
    assert_eq!(reconnected["id"], id);
    assert_eq!(reconnected["status"], "idle");
    assert!(
        reconnected["goals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["id"] == goal["id"]
                    && entry["description"] == "Keep this workspace's recovery goal"
            })
    );
    assert!(
        reconnected["loops"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["id"] == loop_record["id"]
                    && entry["prompt"] == "Wait for a later explicit recovery check"
            })
    );
    let history = request(
        &url,
        "GET",
        &format!("/v1/workspaces/{id}/history?after=0"),
        None,
    );
    assert!(
        history["events"].as_array().unwrap().len() >= 6,
        "history should remain on the original session: {history}"
    );

    let active_plan = json!({
        "calls":[{"tool":"bash","args":{"command":"sleep 2"}}],
        "answer":"Active work completed"
    });
    assert_eq!(
        request(
            &url,
            "POST",
            &format!("/v1/workspaces/{id}/input"),
            Some(&json!({"message":format!("/faux {active_plan}"),"requestId":"busy-check"})),
        )["status"],
        "admitted"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if request(&url, "GET", &format!("/v1/workspaces/{id}"), None)["status"] == "running" {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let busy = request(
        &url,
        "PUT",
        &format!("/v1/workspaces/{id}/kubernetes-connection"),
        Some(&json!({"kubectl":kubectl,"kubeconfig":wrong_config})),
    );
    assert_eq!(
        busy["error"]["code"], "WORKSPACE_BUSY",
        "active work must block rebinding: {busy}"
    );
    wait_for_answer(
        &url,
        id,
        history["nextAfter"].as_u64().unwrap(),
        "Active work completed",
    );
    assert_success(invoke(
        root.path(),
        &url,
        wrong_config.to_str().unwrap(),
        &["stop"],
    ));
    wait_for_runner_stop(&url);
    assert_success(invoke(
        root.path(),
        &url,
        wrong_config.to_str().unwrap(),
        &["start"],
    ));
    let after_restart = request(&url, "GET", &format!("/v1/workspaces/{id}"), None);
    assert_eq!(after_restart["id"], id);
    assert!(
        after_restart["goals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| { entry["id"] == goal["id"] })
    );
    assert!(
        after_restart["loops"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| { entry["id"] == loop_record["id"] })
    );

    let follow_up = json!({
        "calls":[
            {"tool":"bash","args":{"command":"ls -la && test -f noted.txt"}},
            {"tool":"read","args":{"path":"created.txt"}}
        ],
        "answer":"Existing workspace recovered"
    });
    assert_eq!(
        request(
            &url,
            "POST",
            &format!("/v1/workspaces/{id}/input"),
            Some(&json!({"message":format!("/faux {follow_up}"),"requestId":"after-reconnect"})),
        )["status"],
        "admitted"
    );
    assert!(
        wait_for_answer(
            &url,
            id,
            history["nextAfter"].as_u64().unwrap(),
            "Existing workspace recovered",
        )["data"]["text"]
            .as_str()
            .unwrap()
            .contains("Existing workspace recovered")
    );
    let contexts = fs::read_to_string(root.path().join("exec-contexts.log")).unwrap();
    assert!(
        contexts
            .lines()
            .all(|context| context == expected_good_list),
        "tools received contexts: {contexts:?}"
    );
    let cli_contexts = fs::read_to_string(root.path().join("kubeconfig.log")).unwrap();
    assert!(
        cli_contexts
            .lines()
            .all(|context| context == expected_good_list)
    );
    assert_eq!(
        fs::read_to_string(intended.join("noted.txt")).unwrap_or_default(),
        "private"
    );
    assert_eq!(
        fs::read_to_string(intended.join("created.txt")).unwrap(),
        "intended workspace"
    );
    assert!(
        !wrong.join("noted.txt").exists(),
        "tools must not use the runner's inherited context"
    );
    assert!(
        !host.join("noted.txt").exists(),
        "tools must not write on the management host"
    );
    let registry = fs::read_to_string(registry_path).unwrap();
    assert!(registry.contains(&expected_good_list));
    assert!(
        !registry.contains("target="),
        "kubeconfig contents must not enter runner state"
    );
    assert_success(invoke(
        root.path(),
        &url,
        wrong_config.to_str().unwrap(),
        &["stop"],
    ));
}
