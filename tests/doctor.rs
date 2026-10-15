use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::Command,
};

#[test]
fn doctor_reports_missing_storage_and_preserves_runner_failure_causes() {
    let root = tempfile::tempdir().unwrap();
    let kubectl = root.path().join("kubectl");
    fs::write(&kubectl, r#"#!/usr/bin/env python3
import json,sys
args=sys.argv[1:]
if args[:2]==['get','nodes']:
 print(json.dumps({'items':[{'metadata':{'name':'node-a'},'status':{'conditions':[{'type':'Ready','status':'True'}]}}]}))
elif args[:2]==['get','storageclass']:
 name=args[2]
 if name=='adm-replicated':
  print('Error from server (NotFound): storageclasses.storage.k8s.io "adm-replicated" not found',file=sys.stderr);sys.exit(1)
 print(json.dumps({'metadata':{'name':name},'provisioner':'rancher.io/local-path' if name=='local-path' else 'driver.longhorn.io'}))
else: sys.exit(2)
"#).unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    for (storage_class, expected_status) in [
        (None, "unavailable"),
        (Some("local-path"), "node-local"),
        (Some("replicated-test"), "available"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let received = stream.read(&mut request).unwrap();
            assert!(received > 0, "doctor must send a health request");
            let body = json!({"error":{"code":"STORE_UNAVAILABLE","message":"session storage is temporarily unavailable"}}).to_string();
            write!(stream,"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
        command
            .env("XDG_CONFIG_HOME", root.path().join("config"))
            .arg("--state-dir")
            .arg(root.path().join("state"))
            .arg("--kubectl")
            .arg(&kubectl)
            .args(["--runner-url", &url, "doctor"]);
        if let Some(name) = storage_class {
            command.args(["--storage-class", name]);
        }
        let output = command.output().unwrap();
        if !output.status.success() {
            panic!("doctor failed: {}", String::from_utf8_lossy(&output.stderr));
        }
        server.join().unwrap();
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["storage"]["status"], expected_status);
        assert_eq!(
            report["storage"]["name"],
            storage_class.unwrap_or("adm-replicated")
        );
        assert_eq!(report["cluster"][0]["ready"], true);
        assert_eq!(report["runner"]["status"], "unavailable");
        assert!(
            report["runner"]["error"]
                .as_str()
                .unwrap()
                .contains("session storage is temporarily unavailable")
        );
        if storage_class.is_none() {
            assert!(
                report["storage"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("adm-replicated")
            );
        }
        assert!(
            !root.path().join("state/workspaces.sqlite").exists(),
            "diagnostics must not allocate a workspace store"
        );
    }
}
