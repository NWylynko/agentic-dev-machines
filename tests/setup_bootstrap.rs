use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Output, Stdio},
};

fn invoke(root: &Path, arguments: &[&str], input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("HOME", root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env(
            "PATH",
            format!(
                "{}:{}",
                root.join("bin").display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .env_remove("ADM_LIFECYCLE_URL")
        .env_remove("ADM_LIFECYCLE_NAMESPACE")
        .env_remove("ADM_LIFECYCLE_TOKEN_FILE")
        .env_remove("KUBECONFIG")
        .env_remove("ADM_PROJECT_DIR")
        .env_remove("ADM_STATE_DIR")
        .current_dir(root)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
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
fn setup_installs_connects_and_reuses_the_controller_without_manual_credentials() {
    let root = tempfile::Builder::new()
        .prefix("adm $VALUE %q \"quoted\" \\slash ")
        .tempdir()
        .unwrap();
    fs::create_dir(root.path().join("bin")).unwrap();
    let manifest = json!({"apiVersion":"v1","kind":"List","items":[
        {"apiVersion":"v1","kind":"Namespace","metadata":{"name":"adm-system"}},
        {"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":{"name":"adm-lifecycle-state","namespace":"adm-system"},"spec":{"storageClassName":"adm-replicated"}},
        {"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"adm-lifecycle","namespace":"adm-system"},"spec":{"template":{"spec":{"initContainers":[{"name":"prepare-state","image":"old-image"}],"containers":[{"name":"lifecycle","image":"old-image"}]}}}},
        {"apiVersion":"v1","kind":"Service","metadata":{"name":"adm-lifecycle","namespace":"adm-system"}}
    ]});
    fs::write(root.path().join("manifest.json"), manifest.to_string()).unwrap();
    let kubectl = root.path().join("bin/kubectl");
    fs::write(&kubectl, r#"#!/usr/bin/python3
import json,pathlib,sys
root=pathlib.Path(__file__).parent.parent
args=sys.argv[1:]
with (root/'kubectl.log').open('a') as log: log.write(json.dumps(args)+'\n')
if args[:2]==['get','storageclass']:
 print(json.dumps({'metadata':{'name':args[2]},'provisioner':'driver.longhorn.io'}))
elif args[:2]==['create','--dry-run=client']:
 for item in json.loads((root/'manifest.json').read_text())['items']: print(json.dumps(item))
elif args[:3]==['apply','-f','-']:
 value=json.load(sys.stdin)
 if value['kind']=='List': (root/'applied.json').write_text(json.dumps(value))
 print('configured')
elif args[:5]==['-n','adm-system','get','secret','adm-lifecycle-token']:
 token=root/'controller-token'
 if '--ignore-not-found' in args:
  if token.exists(): print('secret/adm-lifecycle-token')
 elif token.exists(): print(token.read_text())
 else: print('missing controller token',file=sys.stderr);sys.exit(1)
elif args[:6]==['-n','adm-system','create','secret','generic','adm-lifecycle-token']:
 token=root/'controller-token'
 if token.exists(): print('refusing token rotation',file=sys.stderr);sys.exit(1)
 token.write_bytes(sys.stdin.buffer.read());token.chmod(0o600)
 print('secret/adm-lifecycle-token created')
elif args[:5]==['-n','adm-system','rollout','status','deployment/adm-lifecycle']:
 if (root/'fail-rollout').exists(): print('ImagePullBackOff: fixture registry denied',file=sys.stderr);sys.exit(1)
 print('successfully rolled out')
else: print('unexpected kubectl args: '+repr(args),file=sys.stderr);sys.exit(2)
"#).unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let token_path = root.path().join("controller-token");
    let server = std::thread::spawn(move || {
        for _ in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 8192];
            let count = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            let token = fs::read_to_string(&token_path).unwrap();
            let authorized = request.starts_with("GET /v1/workspaces ")
                && request
                    .to_ascii_lowercase()
                    .contains(&format!("authorization: bearer {}", token.trim()));
            let (status, body) = if authorized {
                ("200 OK", "[]")
            } else {
                (
                    "401 Unauthorized",
                    r#"{"error":{"message":"fixture authentication rejected"}}"#,
                )
            };
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    let arguments = ["--kubectl", "bin/kubectl", "--lifecycle-url", &url, "setup"];
    let output = assert_ok(invoke(
        root.path(),
        &arguments,
        "registry.example/adm:v2\nreplicated-work\n\n\n",
    ));
    let config_path = root.path().join("config/adm/config.json");
    let configured: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    assert_eq!(configured["lifecycle"]["url"], url);
    assert_eq!(configured["lifecycle"]["namespace"], "adm-system");
    assert_eq!(
        configured["lifecycle"]["kubectl"],
        kubectl.to_str().unwrap()
    );
    let token = fs::read_to_string(root.path().join("controller-token")).unwrap();
    assert!(token.trim().len() >= 32);
    assert!(!String::from_utf8_lossy(&output.stdout).contains(token.trim()));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(token.trim()));
    assert!(
        !fs::read_to_string(&config_path)
            .unwrap()
            .contains(token.trim())
    );
    assert!(
        !root.path().join("config/systemd/user").exists(),
        "ordinary setup must not install a per-device service"
    );
    let applied: Value =
        serde_json::from_slice(&fs::read(root.path().join("applied.json")).unwrap()).unwrap();
    let items = applied["items"].as_array().unwrap();
    let pod = &items
        .iter()
        .find(|item| item["kind"] == "Deployment")
        .unwrap()["spec"]["template"]["spec"];
    assert_eq!(pod["containers"][0]["image"], "registry.example/adm:v2");
    assert_eq!(pod["initContainers"][0]["image"], "registry.example/adm:v2");
    assert_eq!(
        items
            .iter()
            .find(|item| item["kind"] == "PersistentVolumeClaim")
            .unwrap()["spec"]["storageClassName"],
        "replicated-work"
    );
    let output = assert_ok(invoke(root.path(), &["list", "--json"], ""));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!([])
    );
    assert_ok(invoke(root.path(), &arguments, "\n\n\n\n"));
    fs::write(root.path().join("client-token"), &token).unwrap();
    let explicit_arguments = [
        "--kubectl",
        kubectl.to_str().unwrap(),
        "--lifecycle-url",
        &url,
        "--lifecycle-token-file",
        "client-token",
        "setup",
    ];
    assert_ok(invoke(root.path(), &explicit_arguments, "\n\n\n\n"));
    let configured: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    assert_eq!(
        configured["lifecycle"]["tokenFile"],
        root.path().join("client-token").to_str().unwrap()
    );
    server.join().unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("controller-token")).unwrap(),
        token
    );
    let calls = fs::read_to_string(root.path().join("kubectl.log")).unwrap();
    assert_eq!(calls.matches("--from-file=token=/dev/stdin").count(), 1);
    assert!(!calls.contains(token.trim()));
    let saved = fs::read(&config_path).unwrap();
    fs::write(root.path().join("fail-rollout"), "").unwrap();
    let output = invoke(root.path(), &arguments, "\n\n\n\n");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("ImagePullBackOff"));
    assert_eq!(fs::read(&config_path).unwrap(), saved);
    assert_eq!(
        fs::read_to_string(root.path().join("controller-token")).unwrap(),
        token
    );
    assert!(!root.path().join("systemctl.log").exists());
    fs::write(
        root.path().join("client-token"),
        "synthetic-mismatched-token",
    )
    .unwrap();
    let output = invoke(root.path(), &explicit_arguments, "\n\n\n\n");
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("does not match"), "{error}");
    assert!(!error.contains("synthetic-mismatched-token"), "{error}");
    assert_eq!(
        fs::read_to_string(root.path().join("controller-token")).unwrap(),
        token
    );
    assert_eq!(fs::read(&config_path).unwrap(), saved);
}
