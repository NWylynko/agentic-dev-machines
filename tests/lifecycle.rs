use serde_json::{Value, json};
use std::{
    fs,
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

struct ServiceProcess(Child);

impl std::ops::Deref for ServiceProcess {
    type Target = Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for ServiceProcess {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for ServiceProcess {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
            let _ = self.0.wait();
        }
    }
}

fn start_service(root: &Path, port: u16) -> ServiceProcess {
    use std::os::unix::process::CommandExt;
    let status_port =
        fs::read_to_string(root.join("runtime-status-port")).unwrap_or_else(|_| "7432".into());
    let runner_url = fs::read_to_string(root.join("runner-url")).unwrap();
    ServiceProcess(
        Command::new(env!("CARGO_BIN_EXE_adm"))
            .process_group(0)
            .args(["--state-dir"])
            .arg(root.join("state"))
            .args(["--kubectl"])
            .arg(root.join("kubectl"))
            // The service fixture must never fall through to a shared host runner.
            .args(["--runner-url", runner_url.trim()])
            .args(["--runtime-status-port", status_port.trim()])
            .args(["--lifecycle-token-file"])
            .arg(root.join("token"))
            .args(["lifecycle-serve", "--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start lifecycle service"),
    )
}

fn start_runner_stub() -> (String, u16, thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
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
            let (status, body) = if first_line.starts_with("GET /health ") {
                ("200 OK", r#"{"status":"ok"}"#)
            } else if first_line.starts_with("PUT /v1/workspaces/")
                || first_line.starts_with("DELETE /v1/workspaces/")
            {
                ("200 OK", r#"{"ok":true}"#)
            } else {
                ("404 Not Found", r#"{"error":{"code":"NOT_FOUND"}}"#)
            };
            write!(stream, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
    });
    (format!("http://127.0.0.1:{port}"), port, server)
}

fn stop_http_stub(port: u16, server: thread::JoinHandle<()>) {
    let _ = reqwest::blocking::get(format!("http://127.0.0.1:{port}/shutdown"));
    server.join().unwrap();
}

/// While `root/runtime-status-hold` exists, the stub never answers: it reads until the
/// lifecycle gives up on the request, like a runtime whose status read is too slow.
/// While `root/runtime-status-starting` exists, it answers like a runner still
/// waiting for its lifecycle lease.
fn start_runtime_status_server(root: &Path) -> (u16, thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let hold_path = root.join("runtime-status-hold");
    let starting_path = root.join("runtime-status-starting");
    let server = thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request);
            if request.starts_with("GET /shutdown ") {
                break;
            }
            assert!(request.starts_with("GET /v1/workspaces/"), "{request}");
            assert!(request.contains("/runtime-status HTTP/1.1"), "{request}");
            // Runtime status is unauthenticated (TASK-67): the workspace NetworkPolicy
            // admits only the lifecycle (and bots), and the report is activity + model.
            assert!(
                !request.to_ascii_lowercase().contains("authorization:"),
                "{request}"
            );
            if hold_path.exists() {
                while stream.read(&mut chunk).is_ok_and(|count| count > 0) {}
                continue;
            }
            if starting_path.exists() {
                let body = r#"{"error":{"code":"RUNTIME_STARTING","message":"Workspace runtime is waiting for its lifecycle lease: Workspace lifecycle lease request failed: The operation was aborted due to timeout"}}"#;
                write!(stream, "HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body).unwrap();
                continue;
            }
            let body = r#"{"activity":{"status":"running"},"selectedModel":{"provider":"openai","id":"gpt-test"}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
    });
    (port, server)
}

fn stop_runtime_status_server(port: u16, server: thread::JoinHandle<()>) {
    let _ = reqwest::blocking::get(format!("http://127.0.0.1:{port}/shutdown"));
    server.join().unwrap();
}

fn lifecycle_url() -> (String, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    (format!("http://127.0.0.1:{port}"), port)
}

fn request(
    url: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> reqwest::Result<reqwest::blocking::Response> {
    request_with_token(url, method, path, body, None)
}

fn request_with_token(
    url: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    token: Option<&str>,
) -> reqwest::Result<reqwest::blocking::Response> {
    let client = reqwest::blocking::Client::new();
    let mut request = client.request(method.parse().unwrap(), format!("{url}{path}"));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    match body {
        Some(body) => request.json(body).send(),
        None => request.send(),
    }
}

fn workspace_spec(name: &str) -> Value {
    json!({
        "name":name,"role":"coding","image":"test-image","storage_class":"test-storage",
        "storage_size":"1Gi","cpu":"1","memory":"1Gi","agent_enabled":true,
        "repositories":false,"catalog":{"repositories":[]},"repository":null,
        "cwd":"/repos","model":null,"mcp_servers":null,"herdr_space":null
    })
}

#[track_caller]
fn wait_for<T>(mut read: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = read() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for lifecycle state"
        );
        thread::sleep(Duration::from_millis(25));
    }
}

const FAKE_KUBECTL: &str = r##"#!/usr/bin/env python3
import contextlib, datetime, fcntl, json, os, pathlib, re, sys, time, urllib.request, uuid
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
args=[arg for arg in args if not arg.startswith('--request-timeout=')]
state_path=root/'cluster.json'
lease_path=root/'lease.json'
# Every fixture file shared between concurrent kubectl processes (and the Rust test) is replaced by atomic rename,
# and each read-modify-write holds this exclusive lock for its whole duration so updates are never lost.
@contextlib.contextmanager
def locked():
    with (root/'fixture.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield
def put(path, text):
    scratch=path.with_name(path.name+'.'+str(os.getpid())+'.tmp')
    scratch.write_text(text)
    os.replace(scratch, path)
def load_state():
    return json.loads(state_path.read_text()) if state_path.exists() else {}
def validate_lease_microtime(doc):
    for field in ['acquireTime','renewTime']:
        value=doc['spec'].get(field,'')
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z',value):
            print('Error from server (BadRequest): Lease '+field+' requires Kubernetes MicroTime with six fractional digits',file=sys.stderr); sys.exit(1)
        datetime.datetime.strptime(value,'%Y-%m-%dT%H:%M:%S.%fZ')
if args[:2] == ['get','lease']:
    count_path=root/'lease-gets'
    with count_path.open('a+') as counter:
        fcntl.flock(counter, fcntl.LOCK_EX)
        counter.seek(0)
        count=int(counter.read() or '0')
        counter.seek(0); counter.truncate(); counter.write(str(count+1)); counter.flush()
    with locked():
        if not lease_path.exists():
            print('Error from server (NotFound): leases not found',file=sys.stderr); sys.exit(1)
        print(lease_path.read_text())
elif args[:3] == ['create','--raw','/apis/authentication.k8s.io/v1/tokenreviews']:
    request=json.load(sys.stdin)
    if (root/'tokenreview-unavailable').exists():
        print('Unable to connect to the server: net/http: TLS handshake timeout',file=sys.stderr); sys.exit(1)
    expected_namespace=(root/'expected-namespace').read_text()
    pod_uid=(root/'expected-pod-uid').read_text()
    if request['spec']['token']=='runtime-token':
        user={'username':'system:serviceaccount:'+expected_namespace+':adm-runtime','extra':{'authentication.kubernetes.io/pod-uid':[pod_uid]}}
        print(json.dumps({'status':{'authenticated':True,'audiences':['adm-lifecycle'],'user':user}}))
    elif request['spec']['token'].startswith('target-token:'):
        _,namespace,uid=request['spec']['token'].split(':')
        user={'username':'system:serviceaccount:'+namespace+':adm-runtime','extra':{'authentication.kubernetes.io/pod-uid':[uid]}}
        print(json.dumps({'status':{'authenticated':True,'audiences':['adm-lifecycle'],'user':user}}))
    elif request['spec']['token']=='bot-token':
        namespace=(root/'expected-bot-namespace').read_text()
        uid=(root/'expected-bot-token-uid').read_text()
        user={'username':'system:serviceaccount:'+namespace+':adm-runtime','extra':{'authentication.kubernetes.io/pod-uid':[uid]}}
        print(json.dumps({'status':{'authenticated':True,'audiences':['adm-lifecycle'],'user':user}}))
    elif request['spec']['token']=='lifecycle-token':
        user={'username':'system:serviceaccount:adm-system:adm-lifecycle','extra':{'authentication.kubernetes.io/pod-uid':['6d01f582-ea22-433e-86b9-862ee33a3649']}}
        print(json.dumps({'status':{'authenticated':True,'audiences':['adm-lifecycle'],'user':user}}))
    elif request['spec']['token']=='other-pod-token':
        user={'username':'system:serviceaccount:'+expected_namespace+':adm-runtime','extra':{'authentication.kubernetes.io/pod-uid':['f8a58e8d-91e7-4a5e-9da8-2591dfbb9fde']}}
        print(json.dumps({'status':{'authenticated':True,'audiences':['adm-lifecycle'],'user':user}}))
    elif request['spec']['token']=='other-workspace-token':
        user={'username':'system:serviceaccount:adm-foreign:adm-runtime','extra':{'authentication.kubernetes.io/pod-uid':['f8a58e8d-91e7-4a5e-9da8-2591dfbb9fde']}}
        print(json.dumps({'status':{'authenticated':True,'audiences':['adm-lifecycle'],'user':user}}))
    else:
        print(json.dumps({'status':{'authenticated':False,'audiences':['adm-lifecycle']}}))
elif args[:2] == ['create','--raw'] and args[2].endswith('/serviceaccounts/adm-runtime/token'):
    sys.exit('runtime status collection must not mint a Pod token per workspace')
elif args[:2] == ['get','storageclass']:
    entered=root/'storage-entered'; entered.write_text('yes')
    while not (root/'storage-release').exists(): time.sleep(.01)
    print(json.dumps({'provisioner':'test.csi','metadata':{'name':args[2]}}))
elif args[:2] == ['get','pods']:
    count_path=root/'pod-list-requests'
    with locked():
        count=int(count_path.read_text()) if count_path.exists() else 0
        put(count_path, str(count+1))
        state=load_state()
    items=[]
    selected_workspace=None
    if '-l' in args:
        selector=args[args.index('-l')+1]
        if selector.startswith('adm.dev/workspace-id='): selected_workspace=selector.split('=',1)[1]
    runtime_ip=(root/'runtime-ip').read_text() if (root/'runtime-ip').exists() else None
    for namespace, resource in state.items():
        workspace_id=resource['metadata']['labels'].get('adm.dev/workspace-id')
        if selected_workspace and workspace_id != selected_workspace: continue
        pod_uid=(root/'expected-pod-uid').read_text() if (root/'expected-pod-uid').exists() else '4b53eaa6-4e4d-42dd-9a02-4702a842155a'
        if (root/'expected-bot-namespace').exists() and namespace == (root/'expected-bot-namespace').read_text():
            pod_uid=(root/'expected-bot-pod-uid').read_text()
        image='ghcr.io/example/adm-dev:fixture'
        if (root/'pod-image').exists(): image=(root/'pod-image').read_text()
        items.append({'kind':'Pod','metadata':{'name':'workspace-pod','namespace':namespace,'uid':pod_uid,'labels':{'app.kubernetes.io/managed-by':'adm','adm.dev/workspace-id':workspace_id}},'spec':{'nodeName':'test-node','containers':[{'name':'dev','image':image}]},'status':{'phase':'Running','podIP':runtime_ip,'conditions':[{'type':'Ready','status':'True'}],'containerStatuses':[{'name':'dev','ready':True,'state':{'running':{}}}]}})
    print(json.dumps({'kind':'PodList','items':items}))
elif args[:3] == ['get','deployment','workspace']:
    namespace=args[args.index('-n')+1]
    workspace_id=(root/'expected-workspace-id').read_text()
    labels={'app.kubernetes.io/managed-by':'adm','adm.dev/workspace-id':workspace_id,'adm.dev/role':'coding'}
    print(json.dumps({'kind':'Deployment','metadata':{'name':'workspace','namespace':namespace,'labels':labels},'spec':{'selector':{'matchLabels':labels},'template':{'metadata':{'labels':labels},'spec':{'serviceAccountName':'adm-runtime','volumes':[{'name':'work','persistentVolumeClaim':{'claimName':'work'}}]}}}}))
elif args[:2] == ['get','pvc'] and args[2] == 'work':
    namespace=args[args.index('-n')+1]
    workspace_id=(root/'expected-workspace-id').read_text()
    labels={'app.kubernetes.io/managed-by':'adm','adm.dev/workspace-id':workspace_id,'adm.dev/role':'coding'}
    print(json.dumps({'kind':'PersistentVolumeClaim','metadata':{'name':'work','namespace':namespace,'labels':labels}}))
elif args[:2] == ['get','namespace']:
    with locked(): state=load_state()
    if args[2] not in state:
        print('Error from server (NotFound): namespaces not found',file=sys.stderr); sys.exit(1)
    doc=json.loads(json.dumps(state[args[2]]))
    if (root/'wrong-owner').exists(): doc['metadata']['labels']['adm.dev/workspace-id']='not-the-owner'
    print(json.dumps(doc))
elif args[0] == 'apply':
    if (root/'hold-apply').exists():
        (root/'applying-entered').write_text('yes')
        while not (root/'apply-release').exists(): time.sleep(.01)
        if (root/'fail-apply').exists():
            print('injected deployment admission failure',file=sys.stderr); sys.exit(1)
    doc=json.load(sys.stdin)
    with locked():
        state=load_state()
        put(root/'applied', json.dumps(doc))
        if doc.get('kind') == 'Deployment' and doc['metadata'].get('name') == 'workspace':
            put(root/'current-deployment.json', json.dumps(doc))
        for item in doc.get('items',[]):
            if item['kind']=='Namespace': state[item['metadata']['name']]=item
            if item['kind']=='Deployment' and item['metadata'].get('name') == 'workspace':
                put(root/'current-deployment.json', json.dumps(item))
        put(state_path, json.dumps(state))
elif args[:2] == ['create','-f']:
    doc=json.load(sys.stdin)
    validate_lease_microtime(doc)
    doc['metadata']['resourceVersion']='1'
    with locked():
        put(lease_path, json.dumps(doc))
        put(root/'lease-initial.json', json.dumps(doc))
    print(json.dumps(doc))
elif args[:2] == ['replace','-f']:
    doc=json.load(sys.stdin)
    validate_lease_microtime(doc)
    with locked():
        current=json.loads(lease_path.read_text())
        if doc['metadata'].get('resourceVersion') != current['metadata']['resourceVersion']:
            print('Error from server (Conflict): resourceVersion conflict',file=sys.stderr); sys.exit(1)
        doc['metadata']['resourceVersion']=str(int(current['metadata']['resourceVersion'])+1)
        put(lease_path, json.dumps(doc))
    if doc['spec']['holderIdentity']==current['spec']['holderIdentity']:
        (root/'lease-renewed').write_text('yes')
    print(json.dumps(doc))
elif args[:3] == ['rollout','status','deployment/workspace']:
    if (root/'fail-wait').exists() and 'deployment/workspace' in args:
        print('injected workspace rollout readiness failure',file=sys.stderr); sys.exit(1)
    with locked(): deployment=json.loads((root/'current-deployment.json').read_text())
    namespace=args[args.index('-n')+1]
    workspace_id=deployment['metadata']['labels']['adm.dev/workspace-id']
    put(root/'pod-image', next(container['image'] for container in deployment['spec']['template']['spec']['containers'] if container['name']=='dev'))
    pod_uid=str(uuid.uuid4())
    put(root/'expected-pod-uid', pod_uid)
    payload=json.dumps({'holder':pod_uid}).encode()
    target_token='target-token:'+namespace+':'+pod_uid
    request=urllib.request.Request((root/'lifecycle-url').read_text().strip()+'/v1/workspaces/'+workspace_id+'/runtime/lease',data=payload,headers={'Authorization':'Bearer '+target_token,'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(request) as response:
        lease=json.loads(response.read())
    if lease.get('maintenanceId'):
        payload=json.dumps({'holder':pod_uid,'fencingToken':lease['fencingToken'],'maintenanceId':lease['maintenanceId'],'expiresAt':lease['expiresAt']}).encode()
        request=urllib.request.Request((root/'lifecycle-url').read_text().strip()+'/v1/workspaces/'+workspace_id+'/runtime/lease/ack',data=payload,headers={'Authorization':'Bearer '+target_token,'Content-Type':'application/json'},method='POST')
        with urllib.request.urlopen(request) as response: response.read()
elif args[0] == 'wait':
    if (root/'fail-wait').exists() and 'deployment/workspace' in args:
        print('injected workspace rollout readiness failure',file=sys.stderr); sys.exit(1)
elif args[:2] == ['delete','namespace']:
    if (root/'hold-delete').exists():
        (root/'deleting-entered').write_text('yes')
        put(root/'delete-process', str(os.getpid()))
        while not (root/'delete-release').exists(): time.sleep(.01)
    with locked():
        state=load_state(); state.pop(args[2],None); put(state_path, json.dumps(state))
else:
    print('unexpected kubectl command: '+repr(args), file=sys.stderr); sys.exit(1)
"##;

fn run_fake_kubectl(root: &Path, args: &[&str], stdin: Option<&str>) -> std::process::Output {
    use std::io::Write;
    let mut child = Command::new(root.join("kubectl"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut pipe = child.stdin.take().unwrap();
    if let Some(input) = stdin {
        pipe.write_all(input.as_bytes()).unwrap();
    }
    drop(pipe);
    child.wait_with_output().unwrap()
}

#[test]
fn fake_kubectl_concurrent_processes_never_tear_or_lose_shared_state() {
    use std::os::unix::fs::PermissionsExt;
    const WRITERS: usize = 6;
    const READERS: usize = 4;
    const ROUNDS: usize = 60;
    let root = tempfile::tempdir().unwrap();
    let kubectl = root.path().join("kubectl");
    fs::write(&kubectl, FAKE_KUBECTL).unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    let lease = |version: &str| {
        json!({
            "metadata": {"resourceVersion": version},
            "spec": {
                "holderIdentity": "stress",
                "acquireTime": "2026-01-01T00:00:00.000000Z",
                "renewTime": "2026-01-01T00:00:00.000000Z"
            }
        })
        .to_string()
    };
    let created = run_fake_kubectl(root.path(), &["create", "-f", "-"], Some(&lease("0")));
    assert!(created.status.success());
    let failures = std::sync::Mutex::new(Vec::<String>::new());
    let record = |what: &str, output: &std::process::Output| {
        if !output.status.success() {
            failures.lock().unwrap().push(format!(
                "{what}: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    };
    thread::scope(|scope| {
        for writer in 0..WRITERS {
            let (root, record) = (root.path(), &record);
            scope.spawn(move || {
                for round in 0..ROUNDS {
                    let name = format!("stress-{writer}-{round}");
                    let doc = json!({"kind": "List", "items": [{
                        "kind": "Namespace",
                        "metadata": {"name": name, "labels": {"adm.dev/workspace-id": name}}
                    }]})
                    .to_string();
                    record(
                        "apply",
                        &run_fake_kubectl(root, &["apply", "-f", "-"], Some(&doc)),
                    );
                }
            });
        }
        for _ in 0..READERS {
            let (root, record) = (root.path(), &record);
            scope.spawn(move || {
                for _ in 0..ROUNDS {
                    record("get pods", &run_fake_kubectl(root, &["get", "pods"], None));
                    let lease = run_fake_kubectl(root, &["get", "lease"], None);
                    record("get lease", &lease);
                    if lease.status.success() {
                        serde_json::from_slice::<Value>(&lease.stdout)
                            .expect("lease read must be a whole document");
                    }
                }
            });
        }
        let (root, record) = (root.path(), &record);
        scope.spawn(move || {
            for round in 1..=ROUNDS {
                let replaced = run_fake_kubectl(
                    root,
                    &["replace", "-f", "-"],
                    Some(&lease(&round.to_string())),
                );
                record("replace lease", &replaced);
            }
        });
    });
    assert_eq!(*failures.lock().unwrap(), Vec::<String>::new());
    let cluster: Value =
        serde_json::from_slice(&fs::read(root.path().join("cluster.json")).unwrap()).unwrap();
    assert_eq!(
        cluster.as_object().unwrap().len(),
        WRITERS * ROUNDS,
        "concurrent applies must not overwrite each other's namespaces"
    );
    let lease: Value =
        serde_json::from_slice(&fs::read(root.path().join("lease.json")).unwrap()).unwrap();
    assert_eq!(
        lease["metadata"]["resourceVersion"],
        (ROUNDS + 1).to_string()
    );
    assert_eq!(
        fs::read_to_string(root.path().join("pod-list-requests")).unwrap(),
        (READERS * ROUNDS).to_string(),
        "concurrent request counting must not lose increments"
    );
}

#[test]
fn create_retries_recover_only_the_latest_failed_attempt_after_restart() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let (runner_url, runner_port, runner_server) = start_runner_stub();
    fs::write(root.path().join("runner-url"), &runner_url).unwrap();
    fs::write(root.path().join("kubectl"), FAKE_KUBECTL).unwrap();
    fs::set_permissions(
        root.path().join("kubectl"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(root.path().join("token"), "synthetic-lifecycle-token\n").unwrap();
    fs::write(root.path().join("fail-wait"), "fail").unwrap();
    fs::write(root.path().join("storage-release"), "continue").unwrap();
    let (url, port) = lifecycle_url();
    fs::write(root.path().join("lifecycle-url"), &url).unwrap();
    let mut service = start_service(root.path(), port);
    wait_for(|| request(&url, "GET", "/health", None).ok());
    let attempts = [
        "67b5d167-9ffa-4831-90c2-b333e4384548",
        "33c1e40a-9210-4523-b704-850dcfc571f5",
    ];
    let mut workspace_id = None;
    for operation_id in attempts {
        let body = json!({"operationId":operation_id,"kind":"create","spec":workspace_spec("restart-retry")});
        let receipt: Value = request_with_token(
            &url,
            "POST",
            "/v1/operations",
            Some(&body),
            Some("synthetic-lifecycle-token"),
        )
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
        if let Some(workspace_id) = &workspace_id {
            assert_eq!(&receipt["workspaceId"], workspace_id);
        } else {
            workspace_id = Some(receipt["workspaceId"].clone());
        }
        wait_for(|| {
            request_with_token(
                &url,
                "GET",
                &format!("/v1/operations/{operation_id}"),
                None,
                Some("synthetic-lifecycle-token"),
            )
            .ok()?
            .json::<Value>()
            .ok()
            .filter(|receipt| receipt["status"] == "failed")
        });
    }
    let earlier_failure: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/operations/{}", attempts[0]),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    service.kill().unwrap();
    service.wait().unwrap();
    fs::remove_file(root.path().join("fail-wait")).unwrap();
    let lease_path = root.path().join("lease.json");
    let mut lease: Value = serde_json::from_slice(&fs::read(&lease_path).unwrap()).unwrap();
    lease["metadata"]["annotations"]["adm.dev/renew-unix"] = "0".into();
    fs::write(&lease_path, serde_json::to_vec(&lease).unwrap()).unwrap();
    let mut restarted = start_service(root.path(), port);
    wait_for(|| request(&url, "GET", "/health", None).ok());
    let recovered: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{}", attempts[1]),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()?
        .json::<Value>()
        .ok()
        .filter(|receipt| receipt["status"] == "completed")
    });
    assert_eq!(&recovered["workspaceId"], workspace_id.as_ref().unwrap());
    let earlier: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/operations/{}", attempts[0]),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(
        earlier, earlier_failure,
        "restart must not run superseded create attempts"
    );
    restarted.kill().unwrap();
    restarted.wait().unwrap();
    stop_http_stub(runner_port, runner_server);
}

#[test]
fn admitted_create_survives_service_crash_and_replay_keeps_immutable_identity() {
    let root = tempfile::tempdir().unwrap();
    let (runner_url, runner_port, runner_server) = start_runner_stub();
    fs::write(root.path().join("runner-url"), &runner_url).unwrap();
    fs::write(root.path().join("kubectl"), FAKE_KUBECTL).unwrap();
    fs::write(root.path().join("token"), "synthetic-lifecycle-token\n").unwrap();
    let (status_port, status_server) = start_runtime_status_server(root.path());
    fs::write(
        root.path().join("runtime-status-port"),
        status_port.to_string(),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        root.path().join("kubectl"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let (url, port) = lifecycle_url();
    fs::write(root.path().join("lifecycle-url"), &url).unwrap();
    let mut service = start_service(root.path(), port);
    let initial_health = wait_for(|| request(&url, "GET", "/health", None).ok());
    assert_eq!(initial_health.status(), 200);
    assert_eq!(initial_health.json::<Value>().unwrap()["ownerEpoch"], 1);
    let (_, competing_port) = lifecycle_url();
    let mut competing_owner = start_service(root.path(), competing_port);
    let competing_result = wait_for(|| competing_owner.try_wait().ok().flatten());
    assert!(
        !competing_result.success(),
        "a second service must not own the Lease"
    );
    assert_eq!(
        request(&url, "GET", "/v1/workspaces", None)
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        request_with_token(&url, "GET", "/v1/workspaces", None, Some("wrong-token"))
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        request_with_token(
            &url,
            "GET",
            "/v1/workspaces",
            None,
            Some("synthetic-lifecycle-token")
        )
        .unwrap()
        .status(),
        200
    );
    let initial_lease: Value =
        serde_json::from_slice(&fs::read(root.path().join("lease-initial.json")).unwrap()).unwrap();
    wait_for(|| root.path().join("lease-renewed").exists().then_some(()));
    let renewed_lease: Value =
        serde_json::from_slice(&fs::read(root.path().join("lease.json")).unwrap()).unwrap();
    assert_eq!(
        renewed_lease["spec"]["acquireTime"], initial_lease["spec"]["acquireTime"],
        "renewing the owner must preserve the acquisition time"
    );
    assert_ne!(
        renewed_lease["spec"]["renewTime"], initial_lease["spec"]["renewTime"],
        "the running lifecycle owner must renew its Kubernetes Lease"
    );
    let forged = json!({"operationId":"f199aa5e-a626-4d96-bcea-89092d725d83","kind":"create","spec":{
        "name":"forged","role":"coding","image":"test-image","storage_class":"test-storage",
        "storage_size":"1Gi","cpu":"1","memory":"1Gi","agent_enabled":false,
        "allow_sudo":false,"allow_node_local_storage":false,"repositories":false,"catalog":{"repositories":[]},
        "repository":null,"cwd":"/repos","model":null,"mcp_servers":null,
        "herdr_space":null,"id":"foreign-id","namespace":"somebody-elses-namespace","phase":"ready"
    }});
    let forged_response = request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&forged),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    assert_eq!(
        forged_response.status(),
        400,
        "clients must not assign identity, phase or namespace"
    );
    assert!(
        !root.path().join("applied").exists(),
        "forged request must not reach Kubernetes"
    );
    let mut secret_in_reference = workspace_spec("secret-in-reference");
    secret_in_reference["credential_env"] = json!([{
        "name":"API_KEY","secret_name":"provider-secret","key":"token","value":"never-store-this"
    }]);
    let secret_body = json!({
        "operationId":"f3f706b2-0425-4d61-8b3d-f8b8a8adf9e5",
        "kind":"create","spec":secret_in_reference
    });
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            "/v1/operations",
            Some(&secret_body),
            Some("synthetic-lifecycle-token")
        )
        .unwrap()
        .status(),
        400,
        "Secret refs reject inline values"
    );
    let mut secret_in_model = workspace_spec("secret-in-model");
    secret_in_model["model"] = json!({"provider":"test","id":"model","apiKey":"never-store-this"});
    let secret_model_body = json!({
        "operationId":"56a21d6d-3d04-40b6-871b-4be937b1bc51",
        "kind":"create","spec":secret_in_model
    });
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            "/v1/operations",
            Some(&secret_model_body),
            Some("synthetic-lifecycle-token")
        )
        .unwrap()
        .status(),
        400,
        "model metadata cannot carry arbitrary secret fields"
    );
    assert!(
        !root.path().join("applied").exists(),
        "rejected credentials must never reach Kubernetes"
    );
    let operation_id = "7e437aca-98b6-4bdd-8d00-596be5df1968";
    let body =
        json!({"operationId":operation_id,"kind":"create","spec":workspace_spec("durable-test")});
    let accepted: Value = request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&body),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(accepted["status"], "accepted");
    let workspace_id = accepted["workspaceId"].as_str().unwrap().to_owned();
    assert!(
        uuid::Uuid::parse_str(&workspace_id).is_ok(),
        "service allocates immutable UUID"
    );
    let workspace: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/workspaces/{workspace_id}"),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(workspace["phase"], "provisioning");
    assert_eq!(workspace["agent_enabled"], true);
    assert!(
        workspace["model"].is_null(),
        "model selection is optional at admission"
    );
    assert_eq!(
        workspace["namespace"],
        format!("adm-{}", &workspace_id[..16])
    );
    wait_for(|| root.path().join("storage-entered").exists().then_some(()));
    let replay_requests = (0..4)
        .map(|_| {
            let url = url.clone();
            let body = body.clone();
            thread::spawn(move || {
                request_with_token(
                    &url,
                    "POST",
                    "/v1/operations",
                    Some(&body),
                    Some("synthetic-lifecycle-token"),
                )
                .unwrap()
                .json::<Value>()
                .unwrap()
            })
        })
        .collect::<Vec<_>>();
    for replay in replay_requests
        .into_iter()
        .map(|request| request.join().unwrap())
    {
        assert_eq!(
            replay["operationId"], accepted["operationId"],
            "replay body: {replay}"
        );
        assert_eq!(replay["workspaceId"], accepted["workspaceId"]);
    }

    let lease_path = root.path().join("lease.json");
    let mut stale_lease: Value = serde_json::from_slice(&fs::read(&lease_path).unwrap()).unwrap();
    stale_lease["metadata"]["annotations"]["adm.dev/renew-unix"] = "0".into();
    fs::write(&lease_path, serde_json::to_vec(&stale_lease).unwrap()).unwrap();
    let expired_request = json!({"operationId":"64f88d94-b96e-4fbb-a752-83dc912cecee","kind":"create","spec":workspace_spec("expired-owner-must-not-admit")});
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            "/v1/operations",
            Some(&expired_request),
            Some("synthetic-lifecycle-token")
        )
        .unwrap()
        .status(),
        400,
        "an expired same-holder lease cannot authorize another mutation"
    );
    assert_eq!(
        request_with_token(
            &url,
            "GET",
            "/v1/operations/64f88d94-b96e-4fbb-a752-83dc912cecee",
            None,
            Some("synthetic-lifecycle-token")
        )
        .unwrap()
        .status(),
        404,
        "expired owner must not insert operation receipts"
    );
    stale_lease = serde_json::from_slice(&fs::read(&lease_path).unwrap()).unwrap();
    let epoch = stale_lease["metadata"]["annotations"]["adm.dev/fencing-token"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    stale_lease["spec"]["holderIdentity"] = "replacement-owner".into();
    stale_lease["metadata"]["annotations"]["adm.dev/fencing-token"] =
        (epoch + 1).to_string().into();
    stale_lease["metadata"]["annotations"]["adm.dev/renew-unix"] = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string()
        .into();
    stale_lease["metadata"]["resourceVersion"] = (stale_lease["metadata"]["resourceVersion"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap()
        + 1)
    .to_string()
    .into();
    fs::write(&lease_path, serde_json::to_vec(&stale_lease).unwrap()).unwrap();
    let blocked = json!({"operationId":"d52ac954-2c15-4412-97f2-10311aace66b","kind":"create","spec":workspace_spec("blocked-create")});
    let stale_response = request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&blocked),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    assert_eq!(
        stale_response.status(),
        400,
        "stale owner must not admit more work"
    );
    assert_eq!(
        request(&url, "GET", "/health", None).unwrap().status(),
        503,
        "liveness must fail immediately when the Kubernetes Lease changes owners"
    );
    fs::write(root.path().join("storage-release"), "go").unwrap();
    wait_for(|| {
        fs::read_to_string(root.path().join("lease-gets"))
            .ok()
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|n| *n >= 3)
    });
    assert!(
        !root.path().join("applied").exists(),
        "stale owner must stop before its next Kubernetes mutation"
    );

    service.kill().unwrap();
    service.wait().unwrap();
    let lease_path = root.path().join("lease.json");
    let mut lease: Value = serde_json::from_slice(&fs::read(&lease_path).unwrap()).unwrap();
    lease["metadata"]["annotations"]["adm.dev/renew-unix"] = "0".into();
    fs::write(&lease_path, serde_json::to_vec(&lease).unwrap()).unwrap();
    let mut restarted = start_service(root.path(), port);
    wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{operation_id}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    let delete_id = "55feb2af-708f-4f4e-a90b-7c2253f20465";
    let delete_body = json!({"operationId":delete_id,"kind":"delete","workspaceId":workspace_id});
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&delete_body),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{delete_id}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    let replacement_operation = "e532b85b-4cdc-4963-80a6-7a4aabcf6e8a";
    let replacement_body = json!({"operationId":replacement_operation,"kind":"create","spec":workspace_spec("durable-test")});
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&replacement_body),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    let replacement_receipt: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{replacement_operation}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    let replacement_id = replacement_receipt["workspaceId"].as_str().unwrap();
    assert_ne!(
        replacement_id, workspace_id,
        "name reuse creates a fresh immutable identity"
    );
    let cli = std::process::Command::new(env!("CARGO_BIN_EXE_adm"))
        .args(["--state-dir"])
        .arg(root.path().join("state"))
        .args(["--kubectl"])
        .arg(root.path().join("kubectl"))
        .args(["--runner-url", &runner_url])
        .args(["--lifecycle-url", &url, "--lifecycle-token-file"])
        .arg(root.path().join("token"))
        .args(["create", "cli-created", "--no-repositories"])
        .output()
        .expect("run public CLI against lifecycle service");
    assert!(
        cli.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&cli.stdout),
        String::from_utf8_lossy(&cli.stderr)
    );
    let cli_receipt: Value = serde_json::from_slice(&cli.stdout).unwrap();
    assert_eq!(cli_receipt["phase"], "ready");
    assert_eq!(cli_receipt["name"], "cli-created");
    assert!(cli_receipt["creation_operation_id"].is_string());

    let destroy_operation = "e006ec7b-2520-45cb-81db-452930f37732";
    fs::write(root.path().join("hold-delete"), "yes").unwrap();
    let mut destroy = Command::new(env!("CARGO_BIN_EXE_adm"))
        .args(["--state-dir"])
        .arg(root.path().join("state"))
        .args(["--kubectl"])
        .arg(root.path().join("kubectl"))
        .args(["--runner-url", &runner_url, "--lifecycle-url", &url])
        .args(["--lifecycle-token-file"])
        .arg(root.path().join("token"))
        .args([
            "destroy",
            "cli-created",
            "--operation-id",
            destroy_operation,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start asynchronous destroy");
    wait_for(|| root.path().join("deleting-entered").exists().then_some(()));
    let deadline = Instant::now() + Duration::from_secs(3);
    while destroy.try_wait().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let default_finished = destroy.try_wait().unwrap().is_some();
    if !default_finished {
        fs::write(root.path().join("delete-release"), "go").unwrap();
    }
    let destroy_output = destroy.wait_with_output().unwrap();
    assert!(
        default_finished,
        "default destroy waited for namespace finalization"
    );
    assert!(
        destroy_output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&destroy_output.stdout),
        String::from_utf8_lossy(&destroy_output.stderr)
    );
    let destroy_receipt: Value = serde_json::from_slice(&destroy_output.stdout).unwrap();
    assert_eq!(destroy_receipt["operationId"], destroy_operation);
    assert_eq!(destroy_receipt["workspaceId"], cli_receipt["id"]);
    assert!(matches!(
        destroy_receipt["status"].as_str(),
        Some("accepted" | "running" | "completed")
    ));
    let deletion_id = destroy_receipt["workspaceId"].as_str().unwrap();
    let deleting: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/workspaces/{deletion_id}"),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(deleting["phase"], "deleting");
    assert_eq!(deleting["deletion_operation_id"], destroy_operation);

    // Another entry point may admit its own durable request while cleanup is held.
    // It must not replace the operation the original CLI caller resumes by name.
    let concurrent_delete = json!({
        "operationId":"9bd0ee01-f814-4475-b1b7-02326bd9a1ff",
        "kind":"delete",
        "workspaceId":deletion_id,
    });
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&concurrent_delete),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .error_for_status()
    .unwrap();
    let same_deletion: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/workspaces/{deletion_id}"),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(
        same_deletion["deletion_operation_id"], destroy_operation,
        "concurrent deletion entry points must retain the original resumable operation"
    );

    let repeated = Command::new(env!("CARGO_BIN_EXE_adm"))
        .args(["--state-dir"])
        .arg(root.path().join("state"))
        .args(["--kubectl"])
        .arg(root.path().join("kubectl"))
        .args(["--runner-url", &runner_url, "--lifecycle-url", &url])
        .args(["--lifecycle-token-file"])
        .arg(root.path().join("token"))
        .args(["destroy", "cli-created"])
        .output()
        .expect("repeat destroy by workspace name");
    assert!(repeated.status.success());
    let repeated_receipt: Value = serde_json::from_slice(&repeated.stdout).unwrap();
    assert_eq!(repeated_receipt["operationId"], destroy_operation);
    assert_eq!(repeated_receipt["workspaceId"], cli_receipt["id"]);
    let conflicting_retry = Command::new(env!("CARGO_BIN_EXE_adm"))
        .args(["--state-dir"])
        .arg(root.path().join("state"))
        .args(["--kubectl"])
        .arg(root.path().join("kubectl"))
        .args(["--runner-url", &runner_url, "--lifecycle-url", &url])
        .args(["--lifecycle-token-file"])
        .arg(root.path().join("token"))
        .args([
            "destroy",
            "cli-created",
            "--operation-id",
            "cd5044e2-362f-40b9-ac7a-6eb540a2d287",
        ])
        .output()
        .expect("reject a second destroy identity");
    assert!(!conflicting_retry.status.success());
    assert!(String::from_utf8_lossy(&conflicting_retry.stderr).contains(destroy_operation));

    restarted.kill().unwrap();
    restarted.wait().unwrap();
    let delete_process = fs::read_to_string(root.path().join("delete-process"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    unsafe {
        libc::kill(delete_process, libc::SIGKILL);
    }
    let lease_path = root.path().join("lease.json");
    let mut lease: Value = serde_json::from_slice(&fs::read(&lease_path).unwrap()).unwrap();
    lease["metadata"]["annotations"]["adm.dev/renew-unix"] = "0".into();
    fs::write(&lease_path, serde_json::to_vec(&lease).unwrap()).unwrap();
    fs::remove_file(root.path().join("deleting-entered")).unwrap();
    restarted = start_service(root.path(), port);
    wait_for(|| request(&url, "GET", "/health", None).ok());

    let mut waiter = Command::new(env!("CARGO_BIN_EXE_adm"))
        .args(["--state-dir"])
        .arg(root.path().join("state"))
        .args(["--kubectl"])
        .arg(root.path().join("kubectl"))
        .args(["--runner-url", &runner_url, "--lifecycle-url", &url])
        .args(["--lifecycle-token-file"])
        .arg(root.path().join("token"))
        .args(["destroy", "cli-created", "--wait"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start destroy waiter");
    thread::sleep(Duration::from_millis(150));
    let waiter_blocked = waiter.try_wait().unwrap().is_none();
    fs::write(root.path().join("delete-release"), "go").unwrap();
    let waited = waiter.wait_with_output().unwrap();
    assert!(
        waiter_blocked,
        "--wait returned before namespace finalization"
    );
    assert!(
        waited.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&waited.stdout),
        String::from_utf8_lossy(&waited.stderr)
    );
    let deleted: Value = serde_json::from_slice(&waited.stdout).unwrap();
    assert_eq!(deleted["id"], cli_receipt["id"]);
    assert_eq!(deleted["phase"], "deleted");

    let concurrent_wait = Command::new(env!("CARGO_BIN_EXE_adm"))
        .args(["--state-dir"])
        .arg(root.path().join("state"))
        .args(["--kubectl"])
        .arg(root.path().join("kubectl"))
        .args(["--runner-url", &runner_url, "--lifecycle-url", &url])
        .args(["--lifecycle-token-file"])
        .arg(root.path().join("token"))
        .args([
            "destroy",
            deletion_id,
            "--operation-id",
            "9bd0ee01-f814-4475-b1b7-02326bd9a1ff",
            "--wait",
        ])
        .output()
        .expect("resume an already-admitted concurrent delete receipt");
    assert!(
        concurrent_wait.status.success(),
        "{}",
        String::from_utf8_lossy(&concurrent_wait.stderr)
    );
    let concurrently_deleted: Value = serde_json::from_slice(&concurrent_wait.stdout).unwrap();
    assert_eq!(concurrently_deleted["id"], cli_receipt["id"]);
    assert_eq!(concurrently_deleted["phase"], "deleted");

    let cli_directory: Vec<Value> = request_with_token(
        &url,
        "GET",
        "/v1/workspaces",
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert!(cli_directory.iter().any(|workspace| {
        workspace["id"] == cli_receipt["id"] && workspace["name"] == "cli-created"
    }));
    let stale_replay: Value = request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&delete_body),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(stale_replay["workspaceId"], workspace_id);
    fs::write(root.path().join("runtime-ip"), "127.0.0.1").unwrap();
    let pod_list_before = fs::read_to_string(root.path().join("pod-list-requests"))
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let directory: Vec<Value> = request_with_token(
        &url,
        "GET",
        "/v1/workspaces",
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    let pod_list_after = fs::read_to_string(root.path().join("pod-list-requests"))
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert_eq!(
        pod_list_after - pod_list_before,
        1,
        "one API directory request performs one Pod list"
    );
    assert_eq!(directory.len(), 3);
    assert!(
        directory
            .iter()
            .any(|item| item["id"] == workspace_id && item["phase"] == "deleted")
    );
    assert!(
        directory
            .iter()
            .any(|item| item["id"] == replacement_id && item["phase"] == "ready")
    );
    assert!(directory.iter().any(|item| item["name"] == "cli-created"));
    let replacement_entry = directory
        .iter()
        .find(|item| item["id"] == replacement_id)
        .unwrap();
    assert_eq!(replacement_entry["runtime_status"]["ready"], true);
    assert_eq!(replacement_entry["runtime_status"]["nodeName"], "test-node");
    assert_eq!(
        replacement_entry["runtime_status"]["activity"]["status"], "running",
        "{replacement_entry}"
    );
    assert_eq!(
        replacement_entry["runtime_status"]["selectedModel"]["provider"],
        "openai"
    );
    assert_eq!(
        replacement_entry["runtime_status"]["selectedModel"]["id"],
        "gpt-test"
    );
    fs::write(root.path().join("runtime-status-hold"), "").unwrap();
    let held_started = Instant::now();
    let held_directory: Vec<Value> = request_with_token(
        &url,
        "GET",
        "/v1/workspaces",
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    let held_elapsed = held_started.elapsed();
    fs::remove_file(root.path().join("runtime-status-hold")).unwrap();
    assert!(
        held_elapsed < Duration::from_millis(1800),
        "one hung runtime holds the directory only for the 1 s collection bound, took {held_elapsed:?}"
    );
    let held_activity = &held_directory
        .iter()
        .find(|item| item["id"] == replacement_id)
        .unwrap()["runtime_status"]["activity"];
    assert_eq!(held_activity["status"], "unavailable", "{held_activity}");
    assert!(
        held_activity["error"]
            .as_str()
            .is_some_and(|error| error.contains("timed out")),
        "an unavailable cause names the underlying timeout, not only reqwest's top-level message: {held_activity}"
    );
    fs::write(root.path().join("runtime-status-starting"), "").unwrap();
    let starting_directory: Vec<Value> = request_with_token(
        &url,
        "GET",
        "/v1/workspaces",
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    fs::remove_file(root.path().join("runtime-status-starting")).unwrap();
    let starting_activity = &starting_directory
        .iter()
        .find(|item| item["id"] == replacement_id)
        .unwrap()["runtime_status"]["activity"];
    assert_eq!(starting_activity["status"], "unavailable");
    assert_eq!(
        starting_activity["error"],
        "runtime status returned HTTP 503 Service Unavailable: RUNTIME_STARTING: Workspace runtime is waiting for its lifecycle lease: Workspace lifecycle lease request failed: The operation was aborted due to timeout",
        "the runner's reported cause distinguishes a lifecycle it cannot reach from an unavailable agent"
    );
    let failed_delete_id = "30af635c-32af-4b26-a35d-738aa991f90a";
    let failed_delete =
        json!({"operationId":failed_delete_id,"kind":"delete","workspaceId":replacement_id});
    fs::write(root.path().join("wrong-owner"), "yes").unwrap();
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&failed_delete),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    let failed: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{failed_delete_id}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "failed")
    });
    assert!(
        failed["lastError"]
            .as_str()
            .unwrap()
            .contains("ownership mismatch")
    );
    let cli_failed_delete = Command::new(env!("CARGO_BIN_EXE_adm"))
        .args(["--state-dir"])
        .arg(root.path().join("state"))
        .args(["--kubectl"])
        .arg(root.path().join("kubectl"))
        .args(["--runner-url", &runner_url, "--lifecycle-url", &url])
        .args(["--lifecycle-token-file"])
        .arg(root.path().join("token"))
        .args([
            "destroy",
            "durable-test",
            "--operation-id",
            failed_delete_id,
            "--wait",
        ])
        .output()
        .expect("wait for failed destroy from CLI");
    assert!(!cli_failed_delete.status.success());
    assert!(
        String::from_utf8_lossy(&cli_failed_delete.stderr).contains("ownership mismatch"),
        "{}",
        String::from_utf8_lossy(&cli_failed_delete.stderr)
    );
    let directory: Vec<Value> = request_with_token(
        &url,
        "GET",
        "/v1/workspaces",
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert!(directory.iter().any(|item| {
        item["id"] == replacement_id
            && item["phase"] == "deleting"
            && item["last_error"]
                .as_str()
                .unwrap()
                .contains("ownership mismatch")
    }));
    fs::remove_file(root.path().join("wrong-owner")).unwrap();
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&failed_delete),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{failed_delete_id}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    assert!(root.path().join("applied").exists());
    let runtime_operation = "1f3fa05a-b409-45df-b161-0b33d854dd83";
    let runtime_create = json!({"operationId":runtime_operation,"kind":"create","spec":workspace_spec("runtime-test")});
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&runtime_create),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    let runtime_receipt: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{runtime_operation}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    let runtime_id = runtime_receipt["workspaceId"].as_str().unwrap();
    let runtime_workspace: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/workspaces/{runtime_id}"),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    fs::write(root.path().join("expected-workspace-id"), runtime_id).unwrap();
    let runtime_pod_uid = "9d297900-1295-44ed-8fb8-9f3c210cf9fd";
    fs::write(
        root.path().join("expected-namespace"),
        runtime_workspace["namespace"].as_str().unwrap(),
    )
    .unwrap();
    fs::write(root.path().join("expected-pod-uid"), runtime_pod_uid).unwrap();
    let lease_path = format!("/v1/workspaces/{runtime_id}/runtime/lease");
    let lease_body = json!({"holder":runtime_pod_uid});
    let runtime_lease: Value = request_with_token(
        &url,
        "POST",
        &lease_path,
        Some(&lease_body),
        Some("runtime-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(runtime_lease["fencingToken"], 1, "{runtime_lease}");
    // A newly booting Pod can start a bot's initial provider turn before its
    // Deployment becomes Ready. Its current Pod-bound lease is authoritative.
    {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let authority = TcpListener::bind("127.0.0.1:7434").unwrap();
        let authority_thread = thread::spawn(move || {
            let mut received = Vec::new();
            for mut stream in authority.incoming().flatten() {
                let mut bytes = [0; 4096];
                let mut request = Vec::new();
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = stream.read(&mut bytes).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&bytes[..count]);
                }
                let headers = String::from_utf8_lossy(&request).into_owned();
                if headers.starts_with("GET /stop ") {
                    break;
                }
                let body = if headers.starts_with("POST /v1/provider-auth/catalog ") {
                    r#"{"synthetic":{"auth":{"source":"OAuth","type":"oauth"},"models":["allowed"],"allModels":["allowed"]}}"#
                } else {
                    r#"{"auth":{"apiKey":"synthetic-shared-access"},"source":"OAuth"}"#
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                received.push(headers);
            }
            received
        });
        let database =
            rusqlite::Connection::open(root.path().join("state/workspaces.sqlite")).unwrap();
        database.execute("UPDATE workspaces SET phase='provisioning',spec=json_set(spec,'$.phase','provisioning') WHERE id=?1", [runtime_id]).unwrap();
        let responses: Vec<_> = ["catalog", "resolve"]
            .into_iter()
            .map(|endpoint| {
                request_with_token(
                    &url,
                    "POST",
                    &format!("/v1/provider-auth/{endpoint}"),
                    Some(&json!({"provider":"synthetic"})),
                    Some("runtime-token"),
                )
                .unwrap()
            })
            .collect();
        let foreign_responses: Vec<_> = ["catalog", "resolve"]
            .into_iter()
            .map(|endpoint| {
                request_with_token(
                    &url,
                    "POST",
                    &format!("/v1/provider-auth/{endpoint}"),
                    Some(&json!({"provider":"synthetic"})),
                    Some("other-pod-token"),
                )
                .unwrap()
            })
            .collect();
        database.execute("UPDATE workspaces SET phase='ready',spec=json_set(spec,'$.phase','ready') WHERE id=?1", [runtime_id]).unwrap();
        let mut stop = TcpStream::connect("127.0.0.1:7434").unwrap();
        stop.write_all(b"GET /stop HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let received = authority_thread.join().unwrap();
        for response in responses {
            assert_eq!(
                response.status(),
                200,
                "a current provisioning Pod must use shared provider auth: {}",
                response.text().unwrap()
            );
        }
        for response in foreign_responses {
            assert_eq!(
                response.status(),
                403,
                "a foreign Pod cannot reach the shared authority"
            );
        }
        assert_eq!(received.len(), 2);
        let unavailable = request_with_token(
            &url,
            "POST",
            "/v1/provider-auth/resolve",
            Some(&json!({"provider":"synthetic"})),
            Some("runtime-token"),
        )
        .unwrap();
        assert_eq!(unavailable.status(), 503);
        assert_eq!(
            unavailable.json::<Value>().unwrap()["error"]["code"],
            "PROVIDER_AUTH_UNAVAILABLE"
        );
        for request in received {
            assert!(!request.contains("runtime-token"));
            assert!(!request.contains("synthetic-lifecycle-token"));
        }
    }
    let maintenance_id = "c3d48a23-23e6-44ba-98e7-1cd0c1d94d2f";
    let maintenance: Value = request_with_token(
        &url,
        "POST",
        "/v1/runtime/maintenance/extend",
        Some(&json!({"maintenanceId":maintenance_id,"durationSeconds":300})),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(maintenance["maintenanceId"], maintenance_id);
    assert!(
        maintenance["workspaceIds"]
            .as_array()
            .unwrap()
            .contains(&json!(runtime_id))
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            "/v1/runtime/maintenance/extend",
            Some(&json!({
                "maintenanceId":"62e0d7b1-54b6-4fbb-8fa7-96aa4fe4ecb0",
                "durationSeconds":300
            })),
            Some("synthetic-lifecycle-token"),
        )
        .unwrap()
        .status(),
        400,
        "a concurrent update must not replace the first update's required acknowledgement set"
    );
    assert_ne!(
        request_with_token(
            &url,
            "POST",
            "/v1/runtime/maintenance/await",
            Some(&json!({"maintenanceId":"62e0d7b1-54b6-4fbb-8fa7-96aa4fe4ecb0"})),
            Some("synthetic-lifecycle-token"),
        )
        .unwrap()
        .status(),
        200,
        "a stale maintenance ID must not succeed with an empty acknowledgement set"
    );
    let extended_renewal: Value = request_with_token(
        &url,
        "POST",
        &format!("/v1/workspaces/{runtime_id}/runtime/lease/renew"),
        Some(&json!({"holder":runtime_pod_uid,"fencingToken":runtime_lease["fencingToken"]})),
        Some("runtime-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(extended_renewal["maintenanceId"], maintenance_id);
    assert!(
        extended_renewal["expiresAt"].as_u64().unwrap()
            >= maintenance["expiresAt"].as_u64().unwrap()
    );
    let acknowledgement = json!({
        "holder": runtime_pod_uid,
        "fencingToken": runtime_lease["fencingToken"],
        "maintenanceId": maintenance_id,
        "expiresAt": extended_renewal["expiresAt"],
    });
    assert_ne!(
        request_with_token(
            &url,
            "POST",
            "/v1/runtime/maintenance/complete",
            Some(&json!({"maintenanceId":maintenance_id})),
            Some("synthetic-lifecycle-token"),
        )
        .unwrap()
        .status(),
        200,
        "the controller cannot close a maintenance window before all runtime ACKs"
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &format!("/v1/workspaces/{runtime_id}/runtime/lease/ack"),
            Some(&acknowledgement),
            Some("runtime-token"),
        )
        .unwrap()
        .status(),
        200
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            "/v1/runtime/maintenance/await",
            Some(&json!({"maintenanceId":maintenance_id})),
            Some("synthetic-lifecycle-token"),
        )
        .unwrap()
        .status(),
        200
    );
    let wrong_maintenance_await = request_with_token(
        &url,
        "POST",
        "/v1/runtime/maintenance/await",
        Some(&json!({"maintenanceId":"62e0d7b1-54b6-4fbb-8fa7-96aa4fe4ecb0"})),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    assert_ne!(wrong_maintenance_await.status(), 200);
    let completed_maintenance: Value = request_with_token(
        &url,
        "POST",
        "/v1/runtime/maintenance/complete",
        Some(&json!({"maintenanceId":maintenance_id})),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(completed_maintenance["completed"], true);
    let next_maintenance_id = "62e0d7b1-54b6-4fbb-8fa7-96aa4fe4ecb0";
    let next_maintenance = request_with_token(
        &url,
        "POST",
        "/v1/runtime/maintenance/extend",
        Some(&json!({"maintenanceId":next_maintenance_id,"durationSeconds":300})),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .error_for_status()
    .unwrap()
    .json::<Value>()
    .unwrap();
    assert!(
        next_maintenance["workspaceIds"]
            .as_array()
            .unwrap()
            .contains(&json!(runtime_id))
    );
    let renewed_for_next_maintenance: Value = request_with_token(
        &url,
        "POST",
        &format!("/v1/workspaces/{runtime_id}/runtime/lease/renew"),
        Some(&json!({"holder":runtime_pod_uid,"fencingToken":runtime_lease["fencingToken"]})),
        Some("runtime-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(
        renewed_for_next_maintenance["maintenanceId"],
        next_maintenance_id
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &format!("/v1/workspaces/{runtime_id}/runtime/lease/ack"),
            Some(&json!({
                "holder":runtime_pod_uid,
                "fencingToken":runtime_lease["fencingToken"],
                "maintenanceId":next_maintenance_id,
                "expiresAt":renewed_for_next_maintenance["expiresAt"],
            })),
            Some("runtime-token"),
        )
        .unwrap()
        .status(),
        200
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            "/v1/runtime/maintenance/await",
            Some(&json!({"maintenanceId":next_maintenance_id})),
            Some("synthetic-lifecycle-token"),
        )
        .unwrap()
        .status(),
        200
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            "/v1/runtime/maintenance/complete",
            Some(&json!({"maintenanceId":next_maintenance_id})),
            Some("synthetic-lifecycle-token"),
        )
        .unwrap()
        .status(),
        200
    );
    let check_path = format!("/v1/workspaces/{runtime_id}/runtime/check");
    let check_body = json!({"holder":runtime_pod_uid,"fencingToken":runtime_lease["fencingToken"]});
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &check_path,
            Some(&check_body),
            Some("runtime-token")
        )
        .unwrap()
        .status(),
        200
    );
    // A Kubernetes API outage during TokenReview is lifecycle unavailability,
    // which runners wait out, not a rejection that fences them.
    fs::write(root.path().join("tokenreview-unavailable"), "").unwrap();
    let unavailable_check = request_with_token(
        &url,
        "POST",
        &check_path,
        Some(&check_body),
        Some("runtime-token"),
    )
    .unwrap();
    assert_eq!(unavailable_check.status(), 503);
    let unavailable_check: Value = unavailable_check.json().unwrap();
    assert_eq!(
        unavailable_check["error"]["code"], "KUBERNETES_API_UNAVAILABLE",
        "{unavailable_check}"
    );
    assert!(
        unavailable_check["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("TLS handshake timeout")),
        "{unavailable_check}"
    );
    fs::remove_file(root.path().join("tokenreview-unavailable")).unwrap();
    let update_operation = "35a7bb46-d770-4cb1-b1cc-5ebdb5fdf734";
    fs::write(
        root.path().join("private-file.marker"),
        "kept workspace files\n",
    )
    .unwrap();
    fs::write(root.path().join("history.marker"), "kept durable history\n").unwrap();
    let update_request = json!({
        "operationId":update_operation,
        "kind":"update",
        "workspaceId":runtime_id,
        "image":"ghcr.io/example/adm-dev:explicit-update"
    });
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&update_request),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .error_for_status()
    .unwrap();
    let update_receipt: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{update_operation}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    assert_eq!(update_receipt["kind"], "update");
    assert_eq!(update_receipt["workspaceId"], runtime_id);
    let updated_workspace: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/workspaces/{runtime_id}"),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(
        updated_workspace["image"],
        "ghcr.io/example/adm-dev:explicit-update"
    );
    assert_eq!(updated_workspace["id"], runtime_workspace["id"]);
    assert_eq!(
        updated_workspace["namespace"],
        runtime_workspace["namespace"]
    );
    assert_eq!(updated_workspace["cwd"], runtime_workspace["cwd"]);
    let replacement_pod_uid = fs::read_to_string(root.path().join("expected-pod-uid"))
        .unwrap()
        .trim()
        .to_owned();
    let replacement_token = format!(
        "target-token:{}:{replacement_pod_uid}",
        updated_workspace["namespace"].as_str().unwrap()
    );
    let original_pod_token = format!(
        "target-token:{}:{runtime_pod_uid}",
        updated_workspace["namespace"].as_str().unwrap()
    );
    let replacement_response = request_with_token(
        &url,
        "POST",
        &lease_path,
        Some(&json!({"holder":replacement_pod_uid})),
        Some(&replacement_token),
    )
    .unwrap();
    let replacement_status = replacement_response.status();
    let replacement_body = replacement_response.text().unwrap();
    assert_eq!(replacement_status, 200, "{replacement_body}");
    let replacement_lease: Value = serde_json::from_str(&replacement_body).unwrap();
    assert_eq!(replacement_lease["fencingToken"], 2);
    fs::write(root.path().join("expected-pod-uid"), &replacement_pod_uid).unwrap();
    assert_ne!(
        request_with_token(
            &url,
            "POST",
            &check_path,
            Some(&check_body),
            Some(&original_pod_token),
        )
        .unwrap()
        .status(),
        200,
        "the old Pod lease must stay fenced after its planned extension"
    );
    let applied_update: Value =
        serde_json::from_slice(&fs::read(root.path().join("applied")).unwrap()).unwrap();
    assert_eq!(applied_update["kind"], "Deployment");
    assert_eq!(
        applied_update["spec"]["template"]["spec"]["volumes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|volume| volume["name"] == "work")
            .unwrap()["persistentVolumeClaim"]["claimName"],
        "work"
    );
    assert_eq!(
        applied_update["spec"]["template"]["spec"]["containers"][0]["image"],
        "ghcr.io/example/adm-dev:explicit-update"
    );
    let first_update_attempt =
        applied_update["spec"]["template"]["metadata"]["annotations"]["adm.dev/update-attempt"]
            .as_str()
            .unwrap()
            .to_owned();
    fs::write(root.path().join("hold-apply"), "yes").unwrap();
    fs::write(root.path().join("apply-release"), "yes").unwrap();
    fs::write(root.path().join("fail-apply"), "yes").unwrap();
    let retry_operation = "5f81b5e2-1db5-4f77-91e7-2c1fbeebf429";
    let retry_request = json!({
        "operationId":retry_operation,
        "kind":"update",
        "workspaceId":runtime_id,
        "image":"ghcr.io/example/adm-dev:retry-update"
    });
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&retry_request),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .error_for_status()
    .unwrap();
    let failed_retry: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{retry_operation}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "failed")
    });
    assert!(
        failed_retry["lastError"]
            .as_str()
            .unwrap()
            .contains("injected deployment admission failure")
    );
    fs::remove_file(root.path().join("fail-apply")).unwrap();
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&retry_request),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .error_for_status()
    .unwrap();
    let retried: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{retry_operation}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    assert_eq!(retried["workspaceId"], runtime_id);
    let final_workspace: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/workspaces/{runtime_id}"),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(
        final_workspace["image"],
        "ghcr.io/example/adm-dev:retry-update"
    );
    assert_eq!(final_workspace["id"], runtime_workspace["id"]);
    assert_eq!(final_workspace["cwd"], runtime_workspace["cwd"]);
    let replay_operation = "0149f752-b4b1-4d4d-a37e-83ee93ed29ac";
    let replay_request = json!({
        "operationId":replay_operation,
        "kind":"update",
        "workspaceId":runtime_id,
        "image":"ghcr.io/example/adm-dev:retry-update"
    });
    fs::write(root.path().join("fail-wait"), "yes").unwrap();
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&replay_request),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .error_for_status()
    .unwrap();
    let failed_after_apply: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{replay_operation}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "failed")
    });
    assert!(
        failed_after_apply["lastError"]
            .as_str()
            .unwrap()
            .contains("injected workspace rollout readiness failure")
    );
    let first_attempt_after_apply: Value =
        serde_json::from_slice(&fs::read(root.path().join("applied")).unwrap()).unwrap();
    let first_attempt_after_apply = first_attempt_after_apply["spec"]["template"]["metadata"]
        ["annotations"]["adm.dev/update-attempt"]
        .as_str()
        .unwrap()
        .to_owned();
    fs::remove_file(root.path().join("fail-wait")).unwrap();
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&replay_request),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .error_for_status()
    .unwrap();
    let replayed_after_apply: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{replay_operation}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    assert_eq!(replayed_after_apply["workspaceId"], runtime_id);
    let second_attempt_after_apply: Value =
        serde_json::from_slice(&fs::read(root.path().join("applied")).unwrap()).unwrap();
    assert_ne!(
        first_attempt_after_apply,
        second_attempt_after_apply["spec"]["template"]["metadata"]["annotations"]["adm.dev/update-attempt"]
    );
    assert_ne!(
        first_update_attempt,
        second_attempt_after_apply["spec"]["template"]["metadata"]["annotations"]["adm.dev/update-attempt"]
    );
    assert_eq!(
        fs::read_to_string(root.path().join("private-file.marker")).unwrap(),
        "kept workspace files\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("history.marker")).unwrap(),
        "kept durable history\n"
    );
    let final_pod_uid = fs::read_to_string(root.path().join("expected-pod-uid"))
        .unwrap()
        .trim()
        .to_owned();
    let final_pod_token = format!(
        "target-token:{}:{final_pod_uid}",
        final_workspace["namespace"].as_str().unwrap()
    );
    let final_lease: Value = request_with_token(
        &url,
        "POST",
        &lease_path,
        Some(&json!({"holder":final_pod_uid})),
        Some(&final_pod_token),
    )
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .unwrap();
    assert!(final_lease["fencingToken"].as_u64().unwrap() >= 3);
    let final_lease_body =
        json!({"holder":final_pod_uid,"fencingToken":final_lease["fencingToken"]});
    let other_pod_lease = json!({"holder":"f8a58e8d-91e7-4a5e-9da8-2591dfbb9fde"});
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &lease_path,
            Some(&other_pod_lease),
            Some("other-pod-token")
        )
        .unwrap()
        .status(),
        403
    );
    let renew_path = format!("/v1/workspaces/{runtime_id}/runtime/lease/renew");
    let stale_lease_body = json!({"holder":runtime_pod_uid,"fencingToken":2});
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &renew_path,
            Some(&stale_lease_body),
            Some("runtime-token")
        )
        .unwrap()
        .status(),
        403
    );
    let renewed: Value = request_with_token(
        &url,
        "POST",
        &renew_path,
        Some(&final_lease_body),
        Some(&final_pod_token),
    )
    .unwrap()
    .json()
    .unwrap();
    assert!(renewed["expiresAt"].as_u64().unwrap() >= final_lease["expiresAt"].as_u64().unwrap());
    let state =
        rusqlite::Connection::open(root.path().join("state").join("workspaces.sqlite")).unwrap();
    state
        .execute(
            "UPDATE runtime_leases SET expires_at=0 WHERE workspace_id=?1",
            [runtime_id],
        )
        .unwrap();
    drop(state);
    let resumed_after_expiry: Value = request_with_token(
        &url,
        "POST",
        &lease_path,
        Some(&json!({"holder":final_pod_uid})),
        Some(&final_pod_token),
    )
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(
        resumed_after_expiry["fencingToken"].as_u64().unwrap(),
        final_lease["fencingToken"].as_u64().unwrap() + 1
    );
    assert_ne!(
        request_with_token(
            &url,
            "POST",
            &check_path,
            Some(&final_lease_body),
            Some(&final_pod_token),
        )
        .unwrap()
        .status(),
        200,
        "natural expiry lets the same Pod reacquire with a new token while rejecting stale work"
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &check_path,
            Some(&final_lease_body),
            Some("other-workspace-token")
        )
        .unwrap()
        .status(),
        403
    );
    let authorize_path = format!("/v1/workspaces/{runtime_id}/runtime/authorize");
    let prompt_action = json!({"action":"prompt"});
    for action in ["resources", "bash"] {
        assert_eq!(
            request_with_token(
                &url,
                "POST",
                &authorize_path,
                Some(&json!({"action":action})),
                Some(&final_pod_token)
            )
            .unwrap()
            .status(),
            200,
            "a coding runtime owner can manage its project resources and user bash commands"
        );
    }
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&json!({"action":"status"})),
            Some("lifecycle-token")
        )
        .unwrap()
        .status(),
        403,
        "a reusable lifecycle identity cannot be sent to a workspace runtime"
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&json!({"action":"status"})),
            Some(&final_pod_token)
        )
        .unwrap()
        .status(),
        200,
        "the target-bound runtime identity can read its own status"
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&prompt_action),
            Some(&final_pod_token)
        )
        .unwrap()
        .status(),
        200
    );
    fs::write(root.path().join("expected-pod-uid"), runtime_pod_uid).unwrap();
    let bot_operation = "e915a262-bae8-44f7-9da7-fad40d671f52";
    let mut bot_spec = workspace_spec("lifecycle-bot");
    bot_spec["role"] = "bot".into();
    let bot_create = json!({"operationId":bot_operation,"kind":"create","spec":bot_spec});
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&bot_create),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    let bot_receipt: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{bot_operation}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    let bot_workspace: Value = request_with_token(
        &url,
        "GET",
        &format!(
            "/v1/workspaces/{}",
            bot_receipt["workspaceId"].as_str().unwrap()
        ),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    fs::write(
        root.path().join("expected-bot-namespace"),
        bot_workspace["namespace"].as_str().unwrap(),
    )
    .unwrap();
    fs::write(
        root.path().join("expected-bot-pod-uid"),
        "dca2c1a7-ed5f-44a8-a53e-9e64197fdb05",
    )
    .unwrap();
    fs::write(
        root.path().join("expected-bot-token-uid"),
        "dca2c1a7-ed5f-44a8-a53e-9e64197fdb05",
    )
    .unwrap();
    let bot_id = bot_receipt["workspaceId"].as_str().unwrap();
    let bot_uid = fs::read_to_string(root.path().join("expected-bot-pod-uid")).unwrap();
    let bot_lease_path = format!("/v1/workspaces/{bot_id}/runtime/lease");
    let bot_lease_body = json!({"holder":bot_uid.trim()});
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &bot_lease_path,
            Some(&bot_lease_body),
            Some("bot-token")
        )
        .unwrap()
        .status(),
        200
    );
    let runtime_directory = request_with_token(
        &url,
        "GET",
        "/v1/runtime/workspaces",
        None,
        Some("bot-token"),
    )
    .unwrap();
    assert_eq!(runtime_directory.status(), 200);
    let runtime_directory: Value = runtime_directory.json().unwrap();
    assert!(runtime_directory.as_array().is_some());
    assert!(runtime_directory.as_array().unwrap().iter().any(|entry| {
        entry["id"] == runtime_id
            && entry["name"] == "runtime-test"
            && entry["role"] == "coding"
            && entry["namespace"].as_str().is_some()
            && entry["runtime_status"]["podIP"].as_str().is_some()
    }));
    assert!(
        runtime_directory
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["role"] == "coding")
    );
    for private_field in ["credential_env", "mcp_servers", "kubeconfig"] {
        assert!(
            runtime_directory
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| !entry.as_object().unwrap().contains_key(private_field))
        );
    }
    let bot_create_id = "35fbadcf-82a1-49e1-8e8a-10cf8d5ae831";
    let bot_create_spec = workspace_spec("bot-created");
    let bot_create = json!({"operationId":bot_create_id,"kind":"create","spec":bot_create_spec});
    let bot_create_receipt: Value = request_with_token(
        &url,
        "POST",
        "/v1/runtime/operations",
        Some(&bot_create),
        Some("bot-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(bot_create_receipt["operationId"], bot_create_id);
    let bot_operation_path = format!("/v1/runtime/operations/{bot_create_id}");
    let observed =
        request_with_token(&url, "GET", &bot_operation_path, None, Some("bot-token")).unwrap();
    assert_eq!(observed.status(), 200);
    let observed: Value = observed.json().unwrap();
    assert_eq!(observed["workspaceId"], bot_create_receipt["workspaceId"]);
    assert_eq!(observed["operationId"], bot_create_id);
    assert_eq!(
        request_with_token(
            &url,
            "GET",
            &bot_operation_path,
            None,
            Some("runtime-token"),
        )
        .unwrap()
        .status(),
        403,
        "a coding Pod cannot read global lifecycle receipts"
    );
    let replay_create: Value = request_with_token(
        &url,
        "POST",
        "/v1/runtime/operations",
        Some(&bot_create),
        Some("bot-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(
        replay_create["operationId"],
        bot_create_receipt["operationId"]
    );
    assert_eq!(
        replay_create["workspaceId"],
        bot_create_receipt["workspaceId"]
    );
    let mut invalid_bot_create = bot_create.clone();
    invalid_bot_create["operationId"] = json!("4f39074a-609b-485e-8aec-b4d416b15f5c");
    invalid_bot_create["spec"]["role"] = json!("bot");
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            "/v1/runtime/operations",
            Some(&invalid_bot_create),
            Some("bot-token"),
        )
        .unwrap()
        .status(),
        403,
        "the runtime endpoint rejects bot creation"
    );
    assert_eq!(
        request_with_token(
            &url,
            "GET",
            "/v1/runtime/workspaces",
            None,
            Some("runtime-token"),
        )
        .unwrap()
        .status(),
        403,
        "coding agents cannot discover the global runtime directory"
    );
    assert_eq!(
        request_with_token(
            &url,
            "GET",
            "/v1/runtime/workspaces",
            None,
            Some("synthetic-lifecycle-token"),
        )
        .unwrap()
        .status(),
        403,
        "the lifecycle bearer token is not a bot runtime identity"
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            "/v1/runtime/operations",
            Some(&bot_create),
            Some("runtime-token"),
        )
        .unwrap()
        .status(),
        403,
        "coding agents cannot admit global lifecycle operations"
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&prompt_action),
            Some("bot-token")
        )
        .unwrap()
        .status(),
        200,
        "a live bot runtime owner can authorize lifecycle actions"
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&json!({"action":"status"})),
            Some("bot-token")
        )
        .unwrap()
        .status(),
        403,
        "a valid token bound to a different workspace cannot read this runtime status"
    );
    let cross_authorize = format!("/v1/workspaces/{bot_id}/runtime/authorize");
    for action in ["resources", "bash"] {
        for target in [&authorize_path, &cross_authorize] {
            assert_eq!(
                request_with_token(
                    &url,
                    "POST",
                    target,
                    Some(&json!({"action":action})),
                    Some("bot-token")
                )
                .unwrap()
                .status(),
                403,
                "bots cannot inspect project files, change trust, or execute user bash"
            );
        }
    }
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &cross_authorize,
            Some(&prompt_action),
            Some("runtime-token")
        )
        .unwrap()
        .status(),
        403
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&prompt_action),
            Some("bot-token")
        )
        .unwrap()
        .status(),
        200
    );
    {
        let connection =
            rusqlite::Connection::open(root.path().join("state/workspaces.sqlite")).unwrap();
        connection
            .execute(
                "UPDATE runtime_leases SET expires_at=0 WHERE workspace_id=?1",
                [bot_id],
            )
            .unwrap();
    }
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&prompt_action),
            Some("bot-token")
        )
        .unwrap()
        .status(),
        403,
        "an expired source runtime lease cannot retain bot lifecycle authority"
    );
    let replacement_uid = "f57d0d45-e3d1-4fd8-9db5-84a32e9720be";
    fs::write(root.path().join("expected-bot-pod-uid"), replacement_uid).unwrap();
    let replacement_lease_body = json!({"holder":replacement_uid});
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &bot_lease_path,
            Some(&replacement_lease_body),
            Some(&format!(
                "target-token:{}:{replacement_uid}",
                bot_workspace["namespace"].as_str().unwrap()
            ))
        )
        .unwrap()
        .status(),
        200
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&prompt_action),
            Some("bot-token")
        )
        .unwrap()
        .status(),
        403,
        "a replaced bot Pod token cannot retain lifecycle authority"
    );
    let fresh_bot_token = format!(
        "target-token:{}:{replacement_uid}",
        bot_workspace["namespace"].as_str().unwrap()
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&prompt_action),
            Some(&fresh_bot_token)
        )
        .unwrap()
        .status(),
        200
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &authorize_path,
            Some(&json!({"action":"delete"})),
            Some("lifecycle-token")
        )
        .unwrap()
        .status(),
        403,
        "lifecycle service credentials are not workspace runtime credentials"
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &check_path,
            Some(&check_body),
            Some("other-pod-token")
        )
        .unwrap()
        .status(),
        403
    );
    let cross_workspace_path = format!("/v1/workspaces/{bot_id}/runtime/check");
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &cross_workspace_path,
            Some(&check_body),
            Some("runtime-token")
        )
        .unwrap()
        .status(),
        403
    );

    let busy_operation = "fc598b47-b37f-458f-9fe0-ac1ed8481191";
    let busy_create =
        json!({"operationId":busy_operation,"kind":"create","spec":workspace_spec("busy-delete")});
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&busy_create),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    let busy_receipt: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{busy_operation}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    let busy_delete_id = "2c7edb0b-cf82-4563-8faa-7756ff8b4f61";
    let busy_delete = json!({"operationId":busy_delete_id,"kind":"delete","workspaceId":busy_receipt["workspaceId"]});
    fs::remove_file(root.path().join("delete-release")).unwrap();
    fs::remove_file(root.path().join("deleting-entered")).unwrap();
    fs::write(root.path().join("hold-delete"), "yes").unwrap();
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&busy_delete),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    wait_for(|| root.path().join("deleting-entered").exists().then_some(()));
    let queued_delete_id = "62ff76e6-20c5-4b73-a932-d918364d8f8f";
    let queued_delete =
        json!({"operationId":queued_delete_id,"kind":"delete","workspaceId":runtime_id});
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&queued_delete),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap();
    let in_flight_bot_replay: Value = request_with_token(
        &url,
        "POST",
        "/v1/runtime/operations",
        Some(&queued_delete),
        Some(&fresh_bot_token),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(in_flight_bot_replay["operationId"], queued_delete_id);
    let unavailable: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/workspaces/{runtime_id}"),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(
        unavailable["phase"], "deleting",
        "deletion admission fences runtime immediately"
    );
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &check_path,
            Some(&check_body),
            Some("runtime-token")
        )
        .unwrap()
        .status(),
        410
    );
    fs::write(root.path().join("delete-release"), "go").unwrap();
    for id in [busy_delete_id, queued_delete_id] {
        wait_for(|| {
            request_with_token(
                &url,
                "GET",
                &format!("/v1/operations/{id}"),
                None,
                Some("synthetic-lifecycle-token"),
            )
            .ok()
            .and_then(|response| response.json::<Value>().ok())
            .filter(|receipt| receipt["status"] == "completed")
        });
    }
    let completed_bot_replay: Value = request_with_token(
        &url,
        "POST",
        "/v1/runtime/operations",
        Some(&queued_delete),
        Some(&fresh_bot_token),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(completed_bot_replay["operationId"], queued_delete_id);
    assert_eq!(completed_bot_replay["status"], "completed");
    let completed_status = request_with_token(
        &url,
        "GET",
        &format!("/v1/runtime/operations/{queued_delete_id}"),
        None,
        Some(&fresh_bot_token),
    )
    .unwrap();
    assert_eq!(completed_status.status(), 200);
    let completed_status: Value = completed_status.json().unwrap();
    assert_eq!(completed_status["status"], "completed");
    assert_eq!(completed_status["workspaceId"], runtime_id);
    fs::remove_file(root.path().join("hold-delete")).unwrap();
    fs::remove_file(root.path().join("delete-release")).unwrap();
    fs::write(root.path().join("hold-apply"), "yes").unwrap();
    fs::write(root.path().join("fail-apply"), "yes").unwrap();
    let failing_create_id = "eb58a800-45f0-4a26-b36e-a89d7451e6db";
    let failing_create = json!({
        "operationId":failing_create_id,
        "kind":"create",
        "spec":workspace_spec("create-delete-error-race")
    });
    let accepted: Value = request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&failing_create),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    let failing_workspace_id = accepted["workspaceId"].as_str().unwrap();
    wait_for(|| root.path().join("applying-entered").exists().then_some(()));
    let detail: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/workspaces/{failing_workspace_id}"),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    fs::write(
        root.path().join("expected-namespace"),
        detail["namespace"].as_str().unwrap(),
    )
    .unwrap();
    let pod_uid = "4b53eaa6-4e4d-42dd-9a02-4702a842155a";
    fs::write(root.path().join("expected-pod-uid"), pod_uid).unwrap();
    let runtime_path = format!("/v1/workspaces/{failing_workspace_id}/runtime/lease");
    request_with_token(
        &url,
        "POST",
        &runtime_path,
        Some(&json!({"holder":pod_uid})),
        Some("runtime-token"),
    )
    .unwrap()
    .error_for_status()
    .unwrap();
    let failing_delete_id = "33cc226f-1f4f-4375-aa8e-3ea1fbc8e075";
    let failing_delete = json!({
        "operationId":failing_delete_id,
        "kind":"delete",
        "workspaceId":failing_workspace_id
    });
    fs::write(root.path().join("hold-delete"), "yes").unwrap();
    request_with_token(
        &url,
        "POST",
        "/v1/operations",
        Some(&failing_delete),
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .error_for_status()
    .unwrap();
    let runtime_check = format!("/v1/workspaces/{failing_workspace_id}/runtime/check");
    let check_body = json!({"holder":pod_uid,"fencingToken":1});
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &runtime_check,
            Some(&check_body),
            Some("runtime-token")
        )
        .unwrap()
        .status(),
        410,
        "deletion admission fences a runtime while create provisioning is still blocked"
    );
    fs::write(root.path().join("apply-release"), "go").unwrap();
    wait_for(|| root.path().join("deleting-entered").exists().then_some(()));
    let failed_create_receipt: Value = wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{failing_create_id}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "failed")
    });
    assert_eq!(failed_create_receipt["workspaceId"], failing_workspace_id);
    let still_deleting: Value = request_with_token(
        &url,
        "GET",
        &format!("/v1/workspaces/{failing_workspace_id}"),
        None,
        Some("synthetic-lifecycle-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert_eq!(still_deleting["phase"], "deleting");
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &runtime_check,
            Some(&check_body),
            Some("runtime-token")
        )
        .unwrap()
        .status(),
        410,
        "a create failure after delete admission cannot re-enable runtime access"
    );
    fs::write(root.path().join("delete-release"), "go").unwrap();
    wait_for(|| {
        request_with_token(
            &url,
            "GET",
            &format!("/v1/operations/{failing_delete_id}"),
            None,
            Some("synthetic-lifecycle-token"),
        )
        .ok()
        .and_then(|response| response.json::<Value>().ok())
        .filter(|receipt| receipt["status"] == "completed")
    });
    restarted.kill().unwrap();
    restarted.wait().unwrap();
    stop_runtime_status_server(status_port, status_server);
    stop_http_stub(runner_port, runner_server);
}
