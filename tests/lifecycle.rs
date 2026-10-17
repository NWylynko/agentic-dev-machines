use serde_json::{Value, json};
use std::{
    fs,
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

fn start_service(root: &Path, port: u16) -> Child {
    let status_port =
        fs::read_to_string(root.join("runtime-status-port")).unwrap_or_else(|_| "7432".into());
    let runner_url = fs::read_to_string(root.join("runner-url")).unwrap();
    Command::new(env!("CARGO_BIN_EXE_adm"))
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
        .expect("start lifecycle service")
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

fn start_runtime_status_server() -> (u16, thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
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
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer target-token:"),
                "{request}"
            );
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
        "cwd":"/repos","model":null,"allowed_agents":[],"mcp_servers":null,"herdr_space":null
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

#[test]
fn admitted_create_survives_service_crash_and_replay_keeps_immutable_identity() {
    let root = tempfile::tempdir().unwrap();
    let (runner_url, runner_port, runner_server) = start_runner_stub();
    fs::write(root.path().join("runner-url"), &runner_url).unwrap();
    fs::write(
        root.path().join("kubectl"),
        r##"#!/usr/bin/env python3
import fcntl, json, pathlib, sys, time
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
args=[arg for arg in args if not arg.startswith('--request-timeout=')]
state_path=root/'cluster.json'
state=json.loads(state_path.read_text()) if state_path.exists() else {}
lease_path=root/'lease.json'
if args[:2] == ['get','lease']:
    count_path=root/'lease-gets'
    with count_path.open('a+') as counter:
        fcntl.flock(counter, fcntl.LOCK_EX)
        counter.seek(0)
        count=int(counter.read() or '0')
        counter.seek(0); counter.truncate(); counter.write(str(count+1)); counter.flush()
    if not lease_path.exists():
        print('Error from server (NotFound): leases not found',file=sys.stderr); sys.exit(1)
    print(lease_path.read_text())
elif args[:3] == ['create','--raw','/apis/authentication.k8s.io/v1/tokenreviews']:
    request=json.load(sys.stdin)
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
        uid=(root/'expected-bot-pod-uid').read_text()
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
    request=json.load(sys.stdin)
    expected_uid=(root/'expected-pod-uid').read_text() if (root/'expected-pod-uid').exists() else '4b53eaa6-4e4d-42dd-9a02-4702a842155a'
    namespace=args[2].split('/')[4]
    assert args[2] == '/api/v1/namespaces/'+namespace+'/serviceaccounts/adm-runtime/token'
    assert request['spec']['audiences'] == ['adm-lifecycle']
    assert request['spec']['expirationSeconds'] == 600
    assert request['spec']['boundObjectRef'] == {'apiVersion':'v1','kind':'Pod','name':'workspace-pod','uid':expected_uid}
    print(json.dumps({'status':{'token':'target-token:'+namespace+':'+expected_uid}}))
elif args[:2] == ['get','storageclass']:
    entered=root/'storage-entered'; entered.write_text('yes')
    while not (root/'storage-release').exists(): time.sleep(.01)
    print(json.dumps({'provisioner':'test.csi','metadata':{'name':args[2]}}))
elif args[:2] == ['get','pods']:
    count_path=root/'pod-list-requests'
    count=int(count_path.read_text()) if count_path.exists() else 0
    count_path.write_text(str(count+1))
    items=[]
    runtime_ip=(root/'runtime-ip').read_text() if (root/'runtime-ip').exists() else None
    for namespace, resource in state.items():
        workspace_id=resource['metadata']['labels'].get('adm.dev/workspace-id')
        pod_uid=(root/'expected-pod-uid').read_text() if (root/'expected-pod-uid').exists() else '4b53eaa6-4e4d-42dd-9a02-4702a842155a'
        items.append({'kind':'Pod','metadata':{'name':'workspace-pod','namespace':namespace,'uid':pod_uid,'labels':{'app.kubernetes.io/managed-by':'adm','adm.dev/workspace-id':workspace_id}},'spec':{'nodeName':'test-node'},'status':{'phase':'Running','podIP':runtime_ip,'containerStatuses':[{'ready':True,'state':{'running':{}}}]}})
    print(json.dumps({'kind':'PodList','items':items}))
elif args[:2] == ['get','namespace']:
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
    (root/'applied').write_text(json.dumps(doc))
    for item in doc.get('items',[]):
        if item['kind']=='Namespace': state[item['metadata']['name']]=item
    state_path.write_text(json.dumps(state))
elif args[:2] == ['create','-f']:
    doc=json.load(sys.stdin)
    doc['metadata']['resourceVersion']='1'
    lease_path.write_text(json.dumps(doc))
    print(json.dumps(doc))
elif args[:2] == ['replace','-f']:
    doc=json.load(sys.stdin)
    current=json.loads(lease_path.read_text())
    if doc['metadata'].get('resourceVersion') != current['metadata']['resourceVersion']:
        print('Error from server (Conflict): resourceVersion conflict',file=sys.stderr); sys.exit(1)
    doc['metadata']['resourceVersion']=str(int(current['metadata']['resourceVersion'])+1)
    lease_path.write_text(json.dumps(doc))
    print(json.dumps(doc))
elif args[0] == 'wait': pass
elif args[:2] == ['delete','namespace']:
    if (root/'hold-delete').exists():
        (root/'deleting-entered').write_text('yes')
        (root/'delete-process').write_text(str(__import__('os').getpid()))
        while not (root/'delete-release').exists(): time.sleep(.01)
    state.pop(args[2],None); state_path.write_text(json.dumps(state))
else:
    print('unexpected kubectl command: '+repr(args), file=sys.stderr); sys.exit(1)
"##,
    )
    .unwrap();
    fs::write(root.path().join("token"), "synthetic-lifecycle-token\n").unwrap();
    let (status_port, status_server) = start_runtime_status_server();
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
    let mut service = start_service(root.path(), port);
    wait_for(|| request(&url, "GET", "/health", None).ok());
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
    let forged = json!({"operationId":"f199aa5e-a626-4d96-bcea-89092d725d83","kind":"create","spec":{
        "name":"forged","role":"coding","image":"test-image","storage_class":"test-storage",
        "storage_size":"1Gi","cpu":"1","memory":"1Gi","agent_enabled":false,
        "allow_sudo":false,"allow_node_local_storage":false,"repositories":false,"catalog":{"repositories":[]},
        "repository":null,"cwd":"/repos","model":null,"allowed_agents":[],"mcp_servers":null,
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
    assert_eq!(runtime_lease["fencingToken"], 1);
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
        Some(&check_body),
        Some("runtime-token"),
    )
    .unwrap()
    .json()
    .unwrap();
    assert!(renewed["expiresAt"].as_u64().unwrap() >= runtime_lease["expiresAt"].as_u64().unwrap());
    assert_eq!(
        request_with_token(
            &url,
            "POST",
            &check_path,
            Some(&check_body),
            Some("other-workspace-token")
        )
        .unwrap()
        .status(),
        403
    );
    let authorize_path = format!("/v1/workspaces/{runtime_id}/runtime/authorize");
    let prompt_action = json!({"action":"prompt"});
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
            Some("runtime-token")
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
            Some("runtime-token")
        )
        .unwrap()
        .status(),
        200
    );
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
    let bot_id = bot_receipt["workspaceId"].as_str().unwrap();
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
