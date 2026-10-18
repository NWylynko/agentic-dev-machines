use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::Command,
};

fn executable(path: &std::path::Path, script: &str) {
    fs::write(path, script).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn port_forward_is_killed_if_stdout_closes_before_readiness() {
    let root = tempfile::tempdir().unwrap();
    let kubectl = root.path().join("kubectl");
    executable(
        &kubectl,
        r#"#!/usr/bin/python3
import os, pathlib, signal
pathlib.Path(os.environ['HOME'], 'forward.pid').write_text(str(os.getpid()))
os.close(1)
signal.pause()
"#,
    );
    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("HOME", root.path())
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("PATH", "/usr/bin:/bin")
        .env_remove("ADM_LIFECYCLE_URL")
        .env_remove("ADM_LIFECYCLE_TOKEN_FILE")
        .args(["--kubectl"])
        .arg(&kubectl)
        .args(["doctor", "--json"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("stdout closed before readiness"));
    let pid = fs::read_to_string(root.path().join("forward.pid")).unwrap();
    #[cfg(target_os = "linux")]
    assert!(
        !std::path::Path::new("/proc").join(pid).exists(),
        "kubectl with a closed stdout must be killed and reaped"
    );
}

#[test]
fn port_forward_reports_kubectl_startup_diagnostics() {
    let root = tempfile::tempdir().unwrap();
    let kubectl = root.path().join("kubectl");
    executable(
        &kubectl,
        r#"#!/usr/bin/python3
import sys
sys.stderr.write('service/adm-lifecycle was not found\n')
"#,
    );
    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("HOME", root.path())
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("PATH", "/usr/bin:/bin")
        .env_remove("ADM_LIFECYCLE_URL")
        .env_remove("ADM_LIFECYCLE_TOKEN_FILE")
        .args(["--kubectl"])
        .arg(&kubectl)
        .args(["doctor", "--json"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("service/adm-lifecycle was not found"),
        "{stderr}"
    );
    assert!(stderr.contains("failed before readiness"), "{stderr}");
}

#[test]
fn doctor_uses_one_ephemeral_authenticated_forward_and_reaps_it_on_exit() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("config/adm")).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 8192];
        let count = stream.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..count]).to_ascii_lowercase();
        assert!(request.starts_with("get /health "));
        assert!(request.contains("authorization: bearer cluster-token"));
        let body = r#"{"status":"ok"}"#;
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    let pid_path = root.path().join("forward.pid");
    let args_path = root.path().join("forward.args");
    let kubectl = root.path().join("kubectl");
    executable(
        &kubectl,
        &format!(
            r#"#!/usr/bin/python3
import json,os,pathlib,signal,sys
root=pathlib.Path(os.environ['ADM_FIXTURE_HOME'])
args=sys.argv[1:]
if args[:2]==['get','nodes']:
 print(json.dumps({{'items':[]}}))
elif args[:2]==['get','storageclass']:
 print(json.dumps({{'metadata':{{'name':'adm-replicated'}},'provisioner':'example'}}))
elif args[2:5]==['get','secret','adm-lifecycle-token']:
 sys.stdout.write('cluster-token')
elif args[2:4]==['port-forward','service/adm-lifecycle']:
 pathlib.Path(root/'forward.pid').write_text(str(os.getpid()))
 pathlib.Path(root/'forward.args').write_text(json.dumps(args))
 sys.stdout.write('Forwarding from 127.0.0.1:{port} -> 7433\n');sys.stdout.flush()
 signal.pause()
else:
 print('unexpected kubectl args: '+repr(args),file=sys.stderr);sys.exit(2)
"#
        ),
    );
    let kubeconfig = root.path().join("kubeconfig");
    fs::write(&kubeconfig, "fixture").unwrap();
    fs::write(
        root.path().join("config/adm/config.json"),
        serde_json::to_vec(&json!({
            "lifecycle": {
                "url":"http://127.0.0.1:7433",
                "forward":true,
                "namespace":"adm-system",
                "kubectl":kubectl,
                "kubeconfig":kubeconfig,
                "tokenFile":null
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("HOME", root.path())
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("ADM_FIXTURE_HOME", root.path())
        .env("PATH", "/usr/bin:/bin")
        .env_remove("ADM_LIFECYCLE_URL")
        .env_remove("ADM_LIFECYCLE_TOKEN_FILE")
        .args(["doctor", "--json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["lifecycle"]["status"], "ok");
    assert_eq!(
        report["lifecycle"]["url"],
        format!("http://127.0.0.1:{port}")
    );
    let args: Value = serde_json::from_slice(&fs::read(args_path).unwrap()).unwrap();
    assert_eq!(args[4], format!(":7433"));
    assert!(
        args.as_array()
            .unwrap()
            .iter()
            .any(|arg| arg == "--address")
    );
    let pid = fs::read_to_string(pid_path).unwrap();
    #[cfg(target_os = "linux")]
    assert!(
        !std::path::Path::new("/proc").join(pid).exists(),
        "owned kubectl must be reaped at command exit"
    );
    server.join().unwrap();
}

#[test]
fn connect_saves_only_client_selectors_without_installing_cluster_resources() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("bin")).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 8192];
        let count = stream.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..count]).to_ascii_lowercase();
        assert!(request.starts_with("get /v1/workspaces "));
        assert!(request.contains("authorization: bearer cluster-token"));
        let body = "[]";
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    let pid_path = root.path().join("forward.pid");
    let kubectl = root.path().join("bin/kubectl");
    executable(
        &kubectl,
        &format!(
            r#"#!/usr/bin/python3
import json,os,pathlib,signal,sys
root=pathlib.Path(os.environ['HOME'])
args=sys.argv[1:]
with (root/'kubectl.log').open('a') as log: log.write(json.dumps(args)+'\n')
if args[2:5]==['get','secret','adm-lifecycle-token']:
 sys.stdout.write('cluster-token')
elif args[2:4]==['port-forward','service/adm-lifecycle']:
 pathlib.Path(root/'forward.pid').write_text(str(os.getpid()))
 sys.stdout.write('Forwarding from 127.0.0.1:{port} -> 7433\n');sys.stdout.flush()
 signal.pause()
else:
 print('unexpected kubectl args: '+repr(args),file=sys.stderr);sys.exit(2)
"#
        ),
    );
    let kubeconfig = root.path().join("kubeconfig");
    fs::write(&kubeconfig, "fixture").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("HOME", root.path())
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env("PATH", root.path().join("bin"))
        .env_remove("ADM_LIFECYCLE_URL")
        .env_remove("ADM_LIFECYCLE_TOKEN_FILE")
        .args(["--kubectl"])
        .arg(&kubectl)
        .args(["--kubeconfig"])
        .arg(&kubeconfig)
        .arg("connect")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let config: Value =
        serde_json::from_slice(&fs::read(root.path().join("config/adm/config.json")).unwrap())
            .unwrap();
    assert_eq!(config["lifecycle"]["forward"], true);
    assert!(
        config["lifecycle"]["url"].is_null(),
        "ephemeral port must not be saved"
    );
    assert_eq!(config["lifecycle"]["namespace"], "adm-system");
    assert_eq!(
        config["lifecycle"]["kubeconfig"],
        kubeconfig.to_str().unwrap()
    );
    let calls = fs::read_to_string(root.path().join("kubectl.log")).unwrap();
    assert!(calls.contains("port-forward"));
    assert!(!calls.contains("apply"));
    assert!(!calls.contains("create"));
    let pid = fs::read_to_string(pid_path).unwrap();
    #[cfg(target_os = "linux")]
    assert!(!std::path::Path::new("/proc").join(pid).exists());
    server.join().unwrap();
}
