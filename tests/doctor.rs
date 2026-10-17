use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    process::Command,
};

#[test]
fn disconnected_lifecycle_guides_the_operator_through_control_plane_setup() {
    let root = tempfile::tempdir().unwrap();
    let kubectl = root.path().join("kubectl");
    fs::write(
        &kubectl,
        r#"#!/usr/bin/python3
import json,sys
if sys.argv[1:3]==['get','nodes']:
 print(json.dumps({'items':[{'metadata':{'name':'node-a'},'status':{'conditions':[{'type':'Ready','status':'True'}]}}]}))
elif sys.argv[1:3]==['get','storageclass']:
 print(json.dumps({'metadata':{'name':'adm-replicated'},'provisioner':'driver.longhorn.io'}))
else: sys.exit(2)
"#,
    )
    .unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let invoke = |arguments: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_adm"))
            .env("XDG_CONFIG_HOME", root.path().join("config"))
            .env_remove("ADM_LIFECYCLE_TOKEN_FILE")
            .args(["--state-dir"])
            .arg(root.path().join("state"))
            .args(["--project-dir"])
            .arg(root.path().join("release"))
            .args(["--kubectl"])
            .arg(&kubectl)
            .args(["--lifecycle-url", &url, "--lifecycle-namespace", "adm-test"])
            .args(arguments)
            .output()
            .unwrap()
    };
    let output = invoke(&["list"]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("Connection refused"), "{error}");
    assert!(error.contains("adm doctor"), "{error}");

    let output = invoke(&["doctor", "--json"]);
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["cluster"][0]["ready"], true);
    assert_eq!(report["storage"]["status"], "available");
    assert_eq!(report["lifecycle"]["status"], "unavailable");
    assert_eq!(report["lifecycle"]["url"], url);
    let action = report["lifecycle"]["action"].as_str().unwrap();
    assert!(action.contains("adm-test"), "{action}");
    assert!(
        action.contains("deploy/lifecycle/control-plane.yaml"),
        "{action}"
    );
    assert!(action.contains("ADM_LIFECYCLE_TOKEN_FILE"), "{action}");
    assert!(
        action.contains("installation.md#in-cluster-lifecycle-owner"),
        "{action}"
    );

    let output = invoke(&["doctor"]);
    assert!(output.status.success());
    let report = String::from_utf8_lossy(&output.stdout);
    assert!(report.contains(action), "{report}");
    let output = invoke(&["start"]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("adm doctor"), "{error}");
    assert!(error.contains("lifecycle"), "{error}");
    assert!(!root.path().join("state/workspaces.sqlite").exists());
}

#[test]
fn lifecycle_authentication_failure_explains_the_required_client_token() {
    let root = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 4096];
        let received = stream.read(&mut request).unwrap();
        assert!(String::from_utf8_lossy(&request[..received]).starts_with("GET /v1/workspaces "));
        let body = r#"{"error":{"code":"UNAUTHORIZED","message":"valid lifecycle bearer token required"}}"#;
        write!(stream, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    let output = Command::new(env!("CARGO_BIN_EXE_adm"))
        .env("XDG_CONFIG_HOME", root.path().join("config"))
        .env_remove("ADM_LIFECYCLE_TOKEN_FILE")
        .args(["--state-dir"])
        .arg(root.path().join("state"))
        .args(["--lifecycle-url", &url, "list"])
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("401"), "{error}");
    assert!(
        error.contains("valid lifecycle bearer token required"),
        "{error}"
    );
    assert!(error.contains("ADM_LIFECYCLE_TOKEN_FILE"), "{error}");
    assert!(error.contains("same token"), "{error}");
}

#[test]
fn doctor_reports_missing_storage_and_preserves_lifecycle_failure_causes() {
    let root = tempfile::tempdir().unwrap();
    let kubectl = root.path().join("kubectl");
    fs::write(&kubectl, r#"#!/usr/bin/python3
import json,os,sys
args=sys.argv[1:]
open(os.environ['ADM_DOCTOR_LOG'],'a').write(' '.join(args)+'\n')
if args[:2]==['get','nodes'] and os.environ.get('ADM_DOCTOR_FAIL_NODES'):
 print('Error from server: context unavailable',file=sys.stderr);sys.exit(1)
elif args[:2]==['get','nodes']:
 print(json.dumps({'items':[{'metadata':{'name':'node-a'},'status':{'conditions':[{'type':'Ready','status':'True'}]}}]}))
elif args[:2]==['get','storageclass']:
 name=args[2]
 if name=='adm-replicated':
  print('Error from server (NotFound): storageclasses.storage.k8s.io "adm-replicated" not found',file=sys.stderr);sys.exit(1)
 print(json.dumps({'metadata':{'name':name},'provisioner':'rancher.io/local-path' if name=='local-path' else 'driver.longhorn.io'}))
else: sys.exit(2)
"#).unwrap();
    fs::set_permissions(&kubectl, fs::Permissions::from_mode(0o755)).unwrap();
    let empty_path = root.path().join("empty-bin");
    fs::create_dir(&empty_path).unwrap();
    for (
        storage_class,
        expected_status,
        healthy_lifecycle,
        failed_cluster,
        configured_class,
        healthy_tools,
        missing_lifecycle_status,
    ) in [
        (None, "unavailable", false, false, None, false, false),
        (
            Some("local-path"),
            "node-local",
            false,
            false,
            None,
            false,
            false,
        ),
        (
            Some("replicated-test"),
            "available",
            false,
            false,
            None,
            false,
            false,
        ),
        (
            Some("replicated-test"),
            "available",
            true,
            false,
            None,
            false,
            false,
        ),
        (
            None,
            "available",
            true,
            true,
            Some("configured-test"),
            false,
            false,
        ),
        (
            Some("replicated-test"),
            "available",
            true,
            false,
            Some("configured-test"),
            false,
            false,
        ),
        (
            Some("replicated-test"),
            "available",
            true,
            false,
            None,
            true,
            false,
        ),
        (
            Some("replicated-test"),
            "available",
            true,
            false,
            None,
            false,
            true,
        ),
    ] {
        fs::create_dir_all(root.path().join("config/adm")).unwrap();
        let config_path = root.path().join("config/adm/config.json");
        if let Some(name) = configured_class {
            fs::write(&config_path, json!({"storageClass":name}).to_string()).unwrap();
        } else if config_path.exists() {
            fs::remove_file(&config_path).unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 4096];
                let received = stream.read(&mut request).unwrap();
                assert!(received > 0, "doctor must send a lifecycle health request");
                assert!(String::from_utf8_lossy(&request[..received]).starts_with("GET /health "));
                let (status, body) = if missing_lifecycle_status {
                    ("200 OK", json!({}).to_string())
                } else if healthy_lifecycle {
                    (
                        "200 OK",
                        json!({"status":"ok","service":"adm-lifecycle"}).to_string(),
                    )
                } else {
                    ("503 Service Unavailable", json!({"error":{"code":"STORE_UNAVAILABLE","message":"session storage is temporarily unavailable"}}).to_string())
                };
                write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
        });
        let invoke = |json_output: bool| {
            let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
            command
                .env("XDG_CONFIG_HOME", root.path().join("config"))
                .env("ADM_DOCTOR_LOG", root.path().join("kubectl.log"))
                .arg("--state-dir")
                .arg(root.path().join("state"))
                .arg("--kubectl")
                .arg(&kubectl)
                .args(["--lifecycle-url", &url, "doctor"]);
            if !healthy_tools {
                command.env("PATH", &empty_path);
            }
            if failed_cluster {
                command.env("ADM_DOCTOR_FAIL_NODES", "1");
            }
            if let Some(name) = storage_class {
                command.args(["--storage-class", name]);
            }
            if json_output {
                command.arg("--json");
            }
            command.output().unwrap()
        };
        let output = invoke(true);
        if !output.status.success() {
            panic!("doctor failed: {}", String::from_utf8_lossy(&output.stderr));
        }
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["storage"]["status"], expected_status);
        assert_eq!(
            report["storage"]["name"],
            storage_class
                .or(configured_class)
                .unwrap_or("adm-replicated")
        );
        if failed_cluster {
            assert_eq!(report["cluster"], Value::Null);
            assert!(
                report["clusterError"]
                    .as_str()
                    .unwrap()
                    .contains("context unavailable")
            );
        } else {
            assert_eq!(report["cluster"][0]["ready"], true);
        }
        if missing_lifecycle_status {
            assert_eq!(report["lifecycle"]["status"], Value::Null);
        } else if healthy_lifecycle {
            assert_eq!(report["lifecycle"]["status"], "ok");
        } else {
            assert_eq!(report["lifecycle"]["status"], "unavailable");
            assert!(
                report["lifecycle"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("session storage is temporarily unavailable")
            );
        }
        if healthy_tools {
            assert_eq!(report["tools"][0][1], true);
            assert_eq!(report["tools"][1][1], true);
        } else {
            assert!(
                report["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|tool| tool[1] == false)
            );
        }
        if expected_status == "unavailable" {
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
        let human = invoke(false);
        assert!(
            human.status.success(),
            "{}",
            String::from_utf8_lossy(&human.stderr)
        );
        let human = String::from_utf8(human.stdout).unwrap();
        for label in [
            "Tools:",
            "node:",
            "Cluster:",
            "Storage:",
            "Lifecycle service:",
            "State:",
        ] {
            assert!(human.contains(label), "missing {label:?}: {human}");
        }
        if healthy_tools {
            assert!(human.contains("node: available"), "{human}");
            assert!(human.contains("git: available"), "{human}");
        }
        if failed_cluster {
            assert!(human.contains("context unavailable"), "{human}");
            assert!(human.contains("Check kubectl access"), "{human}");
        } else {
            assert!(human.contains("node-a: ready"), "{human}");
        }
        if !healthy_lifecycle {
            assert!(
                human.contains("session storage is temporarily unavailable"),
                "{human}"
            );
        }
        if expected_status == "unavailable" {
            assert!(
                human.contains("Next:") && human.contains("adm-replicated"),
                "{human}"
            );
        } else if expected_status == "node-local" {
            assert!(
                human.contains("Warning:") && human.contains("cannot recover a volume"),
                "{human}"
            );
        } else {
            assert!(
                human.contains("Note:") && human.contains("does not prove replication"),
                "{human}"
            );
        }
        if healthy_lifecycle && !missing_lifecycle_status {
            assert!(human.contains("Lifecycle service:\n  ok"), "{human}");
        }
        if missing_lifecycle_status {
            assert!(human.contains("Lifecycle service:\n  unknown"), "{human}");
            assert!(
                !human.contains("Lifecycle service:\n  available"),
                "{human}"
            );
        }
        let kubectl_calls = fs::read_to_string(root.path().join("kubectl.log")).unwrap();
        assert!(kubectl_calls.lines().all(|call| call.starts_with("get ")));
        server.join().unwrap();
    }
}
