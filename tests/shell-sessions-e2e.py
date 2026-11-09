#!/usr/bin/env python3
"""End-to-end test of `adm shell` sessions (TASK-106): the real adm binary in a PTY,
the real image/adm-shell-session and real dtach and zsh.

Only the Kubernetes transport is faked. Like the container runtime, the fake
`kubectl exec -it` runs the command on a PTY held by a separate process, so killing
kubectl leaves the remote client alive on a PTY nobody reads. That stale client is
what the live cluster showed (TASK-106 triage), and a plain subprocess would not
reproduce it.

usage: shell-sessions-e2e.py ADM ROOT WORKSPACE   (ROOT is a tests/cli.rs fixture)
"""
import fcntl, json, os, pathlib, pty, re, select, shutil, signal, socket, struct
import subprocess, sys, termios, time, tty, uuid

HERE = pathlib.Path(__file__).resolve().parent
TOOL = HERE.parent / "image" / "adm-shell-session"
NOISE = 'E1029 14:35:49.747379 v2.go:151] "Copying stdout failed" err="websocket: close 1006 (abnormal closure)"'


# --- the fake transport ------------------------------------------------------------


def hold_pty(sock, command, env, status_file):
    """The container runtime's side of an exec: outlives the client that started it."""
    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, env)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    while True:
        readable, _, _ = select.select([master] + ([sock] if sock else []), [], [])
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            if sock:
                try:
                    sock.sendall(data)
                except OSError:
                    sock = None
        if sock and sock in readable:
            data = sock.recv(65536)
            if data:
                os.write(master, data)
            else:
                sock = None
    _, wait_status = os.waitpid(pid, 0)
    status_file.write_text(str(os.waitstatus_to_exitcode(wait_status)))
    if sock:
        sock.close()


def interactive_exec(root, command, env, session):
    ours, theirs = socket.socketpair()
    status_file = root / f"exec-status-{uuid.uuid4().hex}"
    holder = os.fork()
    if holder == 0:
        ours.close()
        os.setsid()
        if os.fork() != 0:
            os._exit(0)
        for fd in (0, 1, 2):
            os.dup2(os.open(os.devnull, os.O_RDWR), fd)
        hold_pty(theirs, command, env, status_file)
        os._exit(0)
    theirs.close()
    os.waitpid(holder, 0)
    # Per session too: a later shell would overwrite the shared file.
    (root / "kubectl.pid").write_text(str(os.getpid()))
    (root / f"kubectl-{session}.pid").write_text(str(os.getpid()))
    saved = termios.tcgetattr(0)
    tty.setraw(0)

    def lose_connection(*_):
        termios.tcsetattr(0, termios.TCSANOW, saved)
        print(NOISE, file=sys.stderr, flush=True)
        print("error: error reading from error stream: websocket: close 1006", file=sys.stderr, flush=True)
        os._exit(1)

    signal.signal(signal.SIGTERM, lose_connection)
    while True:
        readable, _, _ = select.select([0, ours], [], [])
        if 0 in readable:
            data = os.read(0, 65536)
            if data:
                ours.sendall(data)
        if ours in readable:
            data = ours.recv(65536)
            if not data:
                break
            os.write(1, data)
    termios.tcsetattr(0, termios.TCSANOW, saved)
    for _ in range(50):
        if status_file.exists():
            code = int(status_file.read_text())
            if code:
                print(f"command terminated with exit code {code}", file=sys.stderr)
            os._exit(code)
        time.sleep(0.02)
    lose_connection()


def fake_kubectl(root, args):
    separator = args.index("--") if "--" in args else None
    if args[0] != "exec" or separator is None or args[separator + 1] != "adm-shell-session":
        os.execv(str(root / "kubectl"), [str(root / "kubectl"), *args])
    with (root / "transport.log").open("a") as log:
        log.write(json.dumps(args) + "\n")
    if (root / "outage").exists():
        print("error: unable to upgrade connection: container not found", file=sys.stderr)
        sys.exit(1)
    if (root / "no-tool").exists():
        print('error: exec: "adm-shell-session": executable file not found in $PATH', file=sys.stderr)
        sys.exit(127)
    command = ["/bin/sh", str(TOOL), *args[separator + 2 :]]
    # The launch argv names Pod paths; point them at this fixture.
    home, cwd = root / "e2e-home", root / "e2e-cwd"
    command = [
        item.replace("/workspace/.adm/zsh", str(home)) if item.startswith("ZDOTDIR=") else (str(cwd) if item == "/repos" else item)
        for item in command
    ]
    env = {
        **os.environ,
        "ADM_SHELL_SESSION_DIR": str(root / "sessions"),
        "ADM_SHELL_SESSION_STALE_SECONDS": "5",
        "HOME": str(home),
        "TERM": "xterm",
    }
    if "-it" in args:
        interactive_exec(root, command, env, args[separator + 3])
    os.execvpe(command[0], command, env)


# --- the harness --------------------------------------------------------------------


class Terminal:
    """adm running on a PTY of its own, as a person would run it."""

    def __init__(self, base, *arguments):
        self.output, self.mark = "", 0
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvp(base[0], [*base, *arguments])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    def _pump(self, timeout):
        readable, _, _ = select.select([self.fd], [], [], timeout)
        if not readable:
            return True
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            data = b""
        self.output += data.decode(errors="replace")
        return bool(data)

    def expect(self, pattern, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            found = re.search(pattern, self.output[self.mark :])
            if found:
                self.mark += found.end()
                return found
            if not self._pump(0.1) and not re.search(pattern, self.output[self.mark :]):
                raise AssertionError(f"terminal closed before {pattern!r}:\n{self.output}")
        raise AssertionError(f"timed out waiting for {pattern!r}:\n{self.output}")

    def send(self, text):
        os.write(self.fd, text.encode())

    def prompt(self, pattern, timeout=20):
        """Press Enter until the prompt shows. Input typed before the transport puts the
        terminal in raw mode is flushed (TCSAFLUSH), as a real terminal's would be."""
        deadline = time.time() + timeout
        while True:
            self.send("\n")
            try:
                return self.expect(pattern, timeout=1)
            except AssertionError:
                if time.time() > deadline:
                    raise

    def run(self, command, marker):
        self.send(command + "\n")
        self.expect(marker)

    def finish(self, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self._pump(0.05)
            done, status = os.waitpid(self.pid, os.WNOHANG)
            if done:
                while self._pump(0.05) and select.select([self.fd], [], [], 0)[0]:
                    pass
                return os.waitstatus_to_exitcode(status)
        raise AssertionError(f"adm did not exit:\n{self.output}")

    def kill(self):
        os.kill(self.pid, signal.SIGKILL)
        os.waitpid(self.pid, 0)


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main(adm, root, workspace):
    root = pathlib.Path(root)
    home, cwd = root / "e2e-home", root / "e2e-cwd"
    home.mkdir()
    cwd.mkdir()
    (home / ".zshrc").write_text("unsetopt zle prompt_sp\nPROMPT='e2e> '\n")
    kubectl = root / "session-kubectl"
    kubectl.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{__file__}" --fake-kubectl "{root}" "$@"\n')
    kubectl.chmod(0o755)
    base = [
        adm,
        "--state-dir", str(root / "state"),
        "--kubectl", str(kubectl),
        "--runner-url", "http://127.0.0.1:1",
        "--lifecycle-url", (root / "lifecycle-url").read_text(),
        "--lifecycle-token-file", str(root / "lifecycle-token"),
    ]
    os.environ.update(XDG_CONFIG_HOME=str(root / "config"), ADM_SHELL_HEARTBEAT_SECONDS="1")

    def shell(*arguments):
        return Terminal(base, "shell", workspace, *arguments)

    def shells():
        result = subprocess.run([*base, "shells", workspace], capture_output=True, text=True, timeout=30)
        check(result.returncode == 0, f"adm shells failed: {result}")
        return result.stdout

    def row(session):
        return next((line for line in shells().splitlines() if line.startswith(session + " ")), "")

    def drop(signum=signal.SIGKILL):
        os.kill(int((root / "kubectl.pid").read_text()), signum)

    def opened(terminal):
        session = terminal.expect(r"shell session ([a-z0-9]+)").group(1)
        terminal.expect("e2e> ")
        return session

    def eventually(condition, message, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if condition():
                return
            time.sleep(0.2)
        raise AssertionError(message)

    def counts_past(terminal, seen):
        while True:
            value = int(terminal.expect(r"tick-(\d+)\r?\n").group(1))
            if value > seen:
                return value

    counter = "i=0; while :; do i=$((i+1)); echo tick-$i; sleep 0.2; done"

    # A plain shell behaves like one: the tool has to leave Ctrl-Z to the shell.
    first = shell()
    session = opened(first)
    first.send("sleep 100\n")
    time.sleep(0.5)
    first.send("\x1a")
    first.expect("suspended")
    first.run("kill %1; echo killed-$((6*7))", "killed-42")

    # A drop reconnects by itself: one line, no kubectl errors, same running job.
    first.send(counter + "\n")
    seen = int(first.expect(r"tick-(\d+)\r?\n").group(1))
    mark = len(first.output)
    drop(signal.SIGTERM)
    first.expect("reconnecting")
    first.expect("reconnected")
    seen = counts_past(first, seen)
    check("close 1006" not in first.output[mark:], f"kubectl errors reached the terminal:\n{first.output[mark:]}")
    check("reconnecting" in first.output[mark:], "the drop was not announced")
    # The same again when kubectl dies without restoring the terminal.
    drop(signal.SIGKILL)
    first.expect("reconnected")
    seen = counts_past(first, seen)
    first.send("\x03")
    first.run("echo typed-$((6*7))", "typed-42")

    # A connected session stays attached across its heartbeats, and is listed by name.
    time.sleep(5)
    listed = row(session)
    check(" attached " in listed, f"connected session not attached: {shells()}")
    # At the prompt the terminal's foreground process is the shell itself.
    check(listed.rstrip().endswith(" zsh -l"), f"current command not shown: {listed!r}")

    # Detaching on purpose ends adm, leaves the session running and is shown at once.
    first.run("sleep 300 &; echo started-$((6*7))", "started-42")
    first.send("\x1c")
    check(first.finish() == 0, f"detach should exit 0:\n{first.output}")
    check(" detached " in row(session), f"detached session: {shells()}")

    # Reattach by name; the job from before is still there.
    second = shell(session)
    second.prompt("e2e> ")
    second.run("jobs; echo seen-$((6*7))", r"sleep 300[\s\S]*seen-42")

    # Killing the whole client strands a remote client that keeps the socket marked
    # attached. It has to be listed as detached anyway, and cleaned up.
    second.send(counter + "\n")
    seen = int(second.expect(r"tick-(\d+)\r?\n").group(1))
    transport = int((root / "kubectl.pid").read_text())
    second.kill()
    os.kill(transport, signal.SIGKILL)
    eventually(lambda: " detached " in row(session), f"killed client still attached: {shells()}")
    third = shell(session)
    seen = counts_past(third, seen)

    # An unknown session fails and names the live ones.
    unknown = shell("nosuch")
    code = unknown.finish()
    check(code != 0, "an unknown session must fail")
    check(session in unknown.output, f"the failure must name live sessions:\n{unknown.output}")

    # A session taken from another terminal: the first one stops, without fighting back.
    fourth = shell(session)
    seen = counts_past(fourth, seen)
    third.expect("another terminal")
    check(third.finish() == 0, f"a taken-over client should exit cleanly:\n{third.output}")
    fourth.send("\x03")
    time.sleep(2)
    fourth.run("echo kept-$((6*7))", "kept-42")

    # Plain `adm shell` opens a new session rather than joining an existing one.
    other = shell()
    other_session = opened(other)
    check(other_session != session, "plain adm shell must create a new session")
    check(" attached " in row(other_session), f"second session: {shells()}")
    other.run("exit", "dtach terminating")
    check(other.finish() == 0, f"exit should end adm cleanly:\n{other.output}")
    eventually(lambda: not row(other_session), f"ended session still listed: {shells()}")

    # An outage is waited out, and a session that ended during it is reported.
    pid = (root / "sessions" / session / "shell.pid").read_text().strip()
    (root / "outage").touch()
    transport = int((root / f"kubectl-{session}.pid").read_text())
    os.kill(transport, signal.SIGKILL)
    fourth.expect("reconnecting")
    time.sleep(2)
    check(os.waitpid(fourth.pid, os.WNOHANG)[0] == 0, "adm gave up during an outage")
    os.kill(int(pid), signal.SIGKILL)
    time.sleep(0.5)
    (root / "outage").unlink()
    fourth.expect("ended while disconnected")
    check(fourth.finish() != 0, "a session lost while disconnected must not look like a clean exit")
    eventually(lambda: "No live shell sessions" in shells(), f"sessions remain: {shells()}")
    leftovers = [p for p in pathlib.Path("/proc").glob("[0-9]*") if _cmdline_has(p, f"{root}/sessions")]
    eventually(
        lambda: not [p for p in pathlib.Path("/proc").glob("[0-9]*") if _cmdline_has(p, f"{root}/sessions")],
        f"session processes left behind: {[_cmdline(p) for p in leftovers]}",
    )

    # A workspace still on an older image says what to do.
    (root / "no-tool").touch()
    old = shell()
    code = old.finish()
    check(code != 0, "a missing tool must fail")
    check(f"adm update --workspace {workspace}" in old.output, f"no recovery command:\n{old.output}")
    (root / "no-tool").unlink()

    # Sessions need a terminal; a script asking for one fails instead of hanging.
    piped = subprocess.run([*base, "shell", workspace, "anything"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    check(piped.returncode != 0 and "terminal" in piped.stderr, f"no-terminal attach: {piped}")


def _cmdline(path):
    try:
        return path.joinpath("cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        return ""


def _cmdline_has(path, text):
    return text in _cmdline(path)


def cleanup(root):
    for path in pathlib.Path("/proc").glob("[0-9]*"):
        if path.name != str(os.getpid()) and _cmdline_has(path, str(root)):
            try:
                os.kill(int(path.name), signal.SIGKILL)
            except OSError:
                pass


if __name__ == "__main__":
    if sys.argv[1] == "--fake-kubectl":
        fake_kubectl(pathlib.Path(sys.argv[2]), sys.argv[3:])
    else:
        for tool in ("dtach", "zsh"):
            check(shutil.which(tool), f"{tool} is required on PATH")
        try:
            main(*sys.argv[1:4])
        finally:
            cleanup(sys.argv[2])
        print("shell sessions e2e passed")
