package main

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

// TASK-125: under memory pressure the kernel forgets a repository's folders and
// then its root, and go-fuse handles those FORGETs on different goroutines. When
// the root's FORGET landed first, the next lookup built a new repository root,
// folders were matched to their old nodes by inode number, and those still
// pointed at the old root: every folder answered ENOENT ("d?????????") while
// files at the top still opened. The kernel controls FORGET order, so the test
// drives the catalog through go-fuse's raw bridge and replays that order.
func TestRepositoryFoldersSurviveTheRootBeingForgottenFirst(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("FUSE integration requires /dev/fuse")
	}
	artifact, err := exec.LookPath("artifact-fs")
	if err != nil {
		t.Fatal("FUSE tests require the pinned artifact-fs binary: ", err)
	}
	logs := captureLogs(t)
	dir := t.TempDir()
	upstream := filepath.Join(dir, "upstream")
	if err := os.Mkdir(upstream, 0755); err != nil {
		t.Fatal(err)
	}
	git(t, upstream, "init", "--initial-branch=main")
	git(t, upstream, "config", "user.name", "Repository test")
	git(t, upstream, "config", "user.email", "repositories@example.invalid")
	git(t, upstream, "config", "uploadpack.allowFilter", "true")
	git(t, upstream, "config", "uploadpack.allowAnySHA1InWant", "true")
	if err := os.MkdirAll(filepath.Join(upstream, "box", "inner"), 0755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(upstream, "box", "inner", "box.go"), "package inner\n")
	write(t, filepath.Join(upstream, "go.mod"), "module example\n")
	git(t, upstream, "add", ".")
	git(t, upstream, "commit", "-m", "upstream")
	root := filepath.Join(dir, "workspace")
	config := Config{State: filepath.Join(root, "state"), GitRoot: filepath.Join(root, "git"), Views: filepath.Join(root, "views"), Mount: filepath.Join(root, "repos"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Artifact: artifact}
	host, err := mountCatalog(context.Background(), config, Catalog{Repositories: []Repository{{Owner: "example", Name: "project", Remote: "file://" + upstream, Ref: "refs/heads/main"}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { host.Close() })

	// A second node tree over the same catalog server and mount options,
	// driven without the kernel so the FORGET order is the test's.
	raw := fs.NewNodeFS(&catalogDirectory{server: host}, catalogFilesystemOptions(config))
	lookup := func(parent uint64, name string) uint64 {
		t.Helper()
		var out fuse.EntryOut
		if status := raw.Lookup(nil, &fuse.InHeader{NodeId: parent}, name, &out); status != fuse.OK {
			t.Fatalf("lookup %q: %v", name, status)
		}
		return out.NodeId
	}
	getattr := func(node uint64) fuse.Status {
		var out fuse.AttrOut
		return raw.GetAttr(nil, &fuse.GetAttrIn{InHeader: fuse.InHeader{NodeId: node}}, &out)
	}
	opendir := func(node uint64) fuse.Status {
		var out fuse.OpenOut
		status := raw.OpenDir(nil, &fuse.OpenIn{InHeader: fuse.InHeader{NodeId: node}}, &out)
		if status == fuse.OK {
			raw.ReleaseDir(&fuse.ReleaseIn{InHeader: fuse.InHeader{NodeId: node}, Fh: out.Fh})
		}
		return status
	}

	owner := lookup(fuse.FUSE_ROOT_ID, "example")
	project := lookup(owner, "project")
	box := lookup(project, "box")
	inner := lookup(box, "inner")
	if status := getattr(inner); status != fuse.OK {
		t.Fatalf("folder before any FORGET: %v", status)
	}

	// The kernel evicted box/inner, box, then the root. The root's FORGET is
	// handled first; a new path walk looks the root and the folders up again
	// before the folders' FORGETs are handled.
	raw.Forget(project, 1)
	project = lookup(owner, "project")
	box2 := lookup(project, "box")
	inner2 := lookup(box2, "inner")
	raw.Forget(inner, 1)
	raw.Forget(box, 1)

	for name, node := range map[string]uint64{"box": box2, "box/inner": inner2} {
		if status := getattr(node); status != fuse.OK {
			t.Errorf("getattr %s after the root was forgotten first: %v", name, status)
		}
		if status := opendir(node); status != fuse.OK {
			t.Errorf("opendir %s after the root was forgotten first: %v", name, status)
		}
	}
	if status := getattr(lookup(inner2, "box.go")); status != fuse.OK {
		t.Errorf("file inside the folder: %v", status)
	}
	if strings.Contains(logs.String(), "orphaned") {
		t.Errorf("a repository node lost its path:\n%s", logs)
	}

	// A node removed while the kernel holds it answers ESTALE (the kernel walks
	// the path again) and never reaches go-fuse's orphan path.
	file := lookup(inner2, "box.go")
	if status := raw.Unlink(nil, &fuse.InHeader{NodeId: inner2}, "box.go"); status != fuse.OK {
		t.Fatalf("unlink: %v", status)
	}
	if status := getattr(file); status != fuse.Status(syscall.ESTALE) {
		t.Fatalf("getattr on an unlinked node: %v, want ESTALE", status)
	}
	if strings.Contains(logs.String(), "orphaned") {
		t.Errorf("an unlinked node reached go-fuse's orphan path:\n%s", logs)
	}

	// go-fuse's warnings reach the sidecar log, except the per-getattr notice
	// that it replaced the backing inode number.
	logger := catalogFilesystemOptions(config).Logger
	logger.Printf("warning: Inode.Path: n%d is orphaned, replacing segment with %q", 7, ".go-fuse.1/deleted")
	logger.Printf("warning: rawBridge.getattr: overriding ino %d with %d", 1, 2)
	if !strings.Contains(logs.String(), "n7 is orphaned") {
		t.Errorf("go-fuse warning missing from the log:\n%s", logs)
	}
	if strings.Contains(logs.String(), "overriding ino") {
		t.Errorf("routine inode-number warnings flood the log:\n%s", logs)
	}
}

// capturedLogs is written by the sidecar's goroutines while the test reads it.
type capturedLogs struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (logs *capturedLogs) Write(p []byte) (int, error) {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return logs.buffer.Write(p)
}

func (logs *capturedLogs) String() string {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return logs.buffer.String()
}

// captureLogs sends slog output to a buffer for the rest of the test.
func captureLogs(t *testing.T) *capturedLogs {
	buffer := &capturedLogs{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buffer, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return buffer
}

// A file, folder or symlink created through /repos must be the same node when
// it is looked up again. go-fuse's loopback numbered created entries from the
// backing inode number while lookups used the catalog's path identity, so each
// new file got a second node on its next lookup; and ArtifactFS reuses small
// inode numbers, so a new file could be handed another file's node, orphaning
// it ("Directory nonexistent" for whoever still held it, TASK-125).
func TestCreatedEntriesKeepTheirNodeWhenLookedUpAgain(t *testing.T) {
	host, _ := mountGeneratedRepository(t, 1, 1, 1)
	raw := fs.NewNodeFS(&catalogDirectory{server: host}, catalogFilesystemOptions(host.config))
	lookup := func(parent uint64, name string) uint64 {
		t.Helper()
		var out fuse.EntryOut
		if status := raw.Lookup(nil, &fuse.InHeader{NodeId: parent}, name, &out); status != fuse.OK {
			t.Fatalf("lookup %q: %v", name, status)
		}
		return out.NodeId
	}
	folder := lookup(lookup(lookup(fuse.FUSE_ROOT_ID, "example"), "project"), "d00")

	var created fuse.CreateOut
	if status := raw.Create(nil, &fuse.CreateIn{InHeader: fuse.InHeader{NodeId: folder}, Flags: syscall.O_WRONLY, Mode: 0644}, "new.go", &created); status != fuse.OK {
		t.Fatalf("create: %v", status)
	}
	raw.Release(nil, &fuse.ReleaseIn{InHeader: fuse.InHeader{NodeId: created.NodeId}, Fh: created.Fh})
	if again := lookup(folder, "new.go"); again != created.NodeId {
		t.Errorf("created file is n%d, looked up again it is n%d", created.NodeId, again)
	}
	var made fuse.EntryOut
	if status := raw.Mkdir(nil, &fuse.MkdirIn{InHeader: fuse.InHeader{NodeId: folder}, Mode: 0755}, "made", &made); status != fuse.OK {
		t.Fatalf("mkdir: %v", status)
	}
	if again := lookup(folder, "made"); again != made.NodeId {
		t.Errorf("created folder is n%d, looked up again it is n%d", made.NodeId, again)
	}
	var linked fuse.EntryOut
	if status := raw.Symlink(nil, &fuse.InHeader{NodeId: folder}, "new.go", "link", &linked); status != fuse.OK {
		t.Fatalf("symlink: %v", status)
	}
	if again := lookup(folder, "link"); again != linked.NodeId {
		t.Errorf("created symlink is n%d, looked up again it is n%d", linked.NodeId, again)
	}
}

// A file renamed over (an editor's or agent's atomic save) leaves the old node
// without a path, and an open, truncate or stat already on its way to that node
// still arrives. Answering ENOENT failed "printf > f" with "Directory
// nonexistent" while another process saved f (TASK-125). ESTALE makes the
// kernel walk the path again and reach the new file, as it does for NFS.
func TestReplacedFileAnswersStaleSoTheKernelRetries(t *testing.T) {
	logs := captureLogs(t)
	host, _ := mountGeneratedRepository(t, 1, 1, 1)
	raw := fs.NewNodeFS(&catalogDirectory{server: host}, catalogFilesystemOptions(host.config))
	lookup := func(parent uint64, name string) uint64 {
		t.Helper()
		var out fuse.EntryOut
		if status := raw.Lookup(nil, &fuse.InHeader{NodeId: parent}, name, &out); status != fuse.OK {
			t.Fatalf("lookup %q: %v", name, status)
		}
		return out.NodeId
	}
	folder := lookup(lookup(lookup(lookup(fuse.FUSE_ROOT_ID, "example"), "project"), "d00"), "s0")
	old := lookup(folder, "f0.go")
	var created fuse.CreateOut
	if status := raw.Create(nil, &fuse.CreateIn{InHeader: fuse.InHeader{NodeId: folder}, Flags: syscall.O_WRONLY, Mode: 0644}, "f0.go.tmp", &created); status != fuse.OK {
		t.Fatalf("create: %v", status)
	}
	raw.Release(nil, &fuse.ReleaseIn{InHeader: fuse.InHeader{NodeId: created.NodeId}, Fh: created.Fh})
	if status := raw.Rename(nil, &fuse.RenameIn{InHeader: fuse.InHeader{NodeId: folder}, Newdir: folder}, "f0.go.tmp", "f0.go"); status != fuse.OK {
		t.Fatalf("rename over: %v", status)
	}

	stale := fuse.Status(syscall.ESTALE)
	var open fuse.OpenOut
	if status := raw.Open(nil, &fuse.OpenIn{InHeader: fuse.InHeader{NodeId: old}, Flags: syscall.O_RDONLY}, &open); status != stale {
		t.Errorf("open of the replaced file: %v, want ESTALE", status)
	}
	var attr fuse.AttrOut
	if status := raw.GetAttr(nil, &fuse.GetAttrIn{InHeader: fuse.InHeader{NodeId: old}}, &attr); status != stale {
		t.Errorf("getattr of the replaced file: %v, want ESTALE", status)
	}
	if status := raw.SetAttr(nil, &fuse.SetAttrIn{SetAttrInCommon: fuse.SetAttrInCommon{InHeader: fuse.InHeader{NodeId: old}, Valid: fuse.FATTR_SIZE}}, &attr); status != stale {
		t.Errorf("truncate of the replaced file: %v, want ESTALE", status)
	}
	if again := lookup(folder, "f0.go"); again != created.NodeId {
		t.Errorf("after the rename f0.go is n%d, want the renamed file n%d", again, created.NodeId)
	}
	if strings.Contains(logs.String(), "orphaned") {
		t.Errorf("a replaced file reached go-fuse's orphan path:\n%s", logs)
	}
}
