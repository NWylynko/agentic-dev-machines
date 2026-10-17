use std::{
    ffi::CString,
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Stdio},
};

fn executable(path: &Path, script: &str) {
    fs::write(path, script).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn forwarding_command(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_adm"));
    command
        .env("HOME", root)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("PATH", root.join("bin"))
        .env_remove("ADM_LIFECYCLE_TOKEN_FILE")
        .env_remove("ADM_PROJECT_DIR")
        .env_remove("ADM_STATE_DIR")
        .args(["--kubectl"])
        .arg(root.join("bin/kubectl"))
        .args(["--kubeconfig"])
        .arg(root.join("selected kubeconfig"))
        .args([
            "--lifecycle-namespace",
            "adm-testing",
            "--lifecycle-url",
            "http://127.0.0.1:17433",
            "lifecycle-forward",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[test]
fn lifecycle_forward_notifies_after_kubectl_binds_and_reports_connection_exit() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("bin")).unwrap();
    let gate = root.path().join("forward-ready");
    let gate_name = CString::new(gate.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(gate_name.as_ptr(), 0o600) }, 0);
    executable(
        &root.path().join("bin/kubectl"),
        r#"#!/usr/bin/python3
import json,os,pathlib,sys
root=pathlib.Path(os.environ['HOME'])
(root/'kubectl-arguments').write_text(json.dumps(sys.argv[1:]))
(root/'kubectl-kubeconfig').write_text(os.environ['KUBECONFIG'])
print('Preparing port forward',flush=True)
with (root/'forward-ready').open() as gate: gate.read()
print('Forwarding from 127.0.0.1:17433 -> 7433',flush=True)
print('after readiness '*20000,flush=True)
sys.exit(23)
"#,
    );
    executable(
        &root.path().join("bin/systemd-notify"),
        r#"#!/usr/bin/python3
import os,pathlib,sys
pathlib.Path(os.environ['HOME'],'notified').write_text(' '.join(sys.argv[1:]))
"#,
    );
    let mut child = forwarding_command(root.path()).spawn().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut first = String::new();
    stdout.read_line(&mut first).unwrap();
    let notified_early = root.path().join("notified").exists();
    let mut remaining = String::new();
    if !first.is_empty() {
        fs::write(&gate, "ready").unwrap();
        stdout.read_to_string(&mut remaining).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    let error = String::from_utf8_lossy(&output.stderr);
    assert_eq!(first, "Preparing port forward\n", "{error}");
    assert!(
        !notified_early,
        "forwarding must bind before notifying systemd"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("notified")).unwrap(),
        "--ready"
    );
    assert!(remaining.contains("after readiness"));
    assert!(!output.status.success());
    assert!(error.contains("23"), "{error}");
    let arguments: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("kubectl-arguments")).unwrap()).unwrap();
    assert_eq!(
        arguments,
        serde_json::json!([
            "-n",
            "adm-testing",
            "port-forward",
            "service/adm-lifecycle",
            "17433:7433",
            "--address",
            "127.0.0.1"
        ])
    );
    assert_eq!(
        fs::read_to_string(root.path().join("kubectl-kubeconfig")).unwrap(),
        root.path().join("selected kubeconfig").to_str().unwrap()
    );
}

#[test]
fn lifecycle_forward_reports_a_failure_before_readiness_without_notifying_systemd() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("bin")).unwrap();
    executable(
        &root.path().join("bin/kubectl"),
        "#!/bin/sh\nprintf 'fixture forbidden to forward\\n' >&2\nexit 17\n",
    );
    executable(
        &root.path().join("bin/systemd-notify"),
        "#!/bin/sh\n: > \"$HOME/notified\"\n",
    );
    let output = forwarding_command(root.path()).output().unwrap();
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success());
    assert!(error.contains("fixture forbidden to forward"), "{error}");
    assert!(error.contains("before readiness"), "{error}");
    assert!(error.contains("17"), "{error}");
    assert!(!root.path().join("notified").exists());
}

#[test]
fn lifecycle_forward_reaps_kubectl_when_readiness_notification_fails() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("bin")).unwrap();
    executable(
        &root.path().join("bin/kubectl"),
        r#"#!/usr/bin/python3
import os,pathlib,signal
pathlib.Path(os.environ['HOME'],'kubectl.pid').write_text(str(os.getpid()))
print('Forwarding from 127.0.0.1:17433 -> 7433',flush=True)
signal.pause()
"#,
    );
    executable(
        &root.path().join("bin/systemd-notify"),
        "#!/bin/sh\nprintf 'fixture manager rejected readiness\\n' >&2\nexit 19\n",
    );
    let output = forwarding_command(root.path()).output().unwrap();
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success());
    assert!(error.contains("systemd-notify --ready failed"), "{error}");
    assert!(error.contains("19"), "{error}");
    assert!(
        error.contains("fixture manager rejected readiness"),
        "{error}"
    );
    let pid = fs::read_to_string(root.path().join("kubectl.pid")).unwrap();
    assert!(
        !Path::new("/proc").join(pid).exists(),
        "kubectl must be killed and reaped before the forward supervisor exits"
    );
}
