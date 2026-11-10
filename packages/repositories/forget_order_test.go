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

	// go-fuse's own warnings reach the sidecar log: a node whose path can no
	// longer be resolved is logged, not just answered with ENOENT.
	file := lookup(inner2, "box.go")
	if status := raw.Unlink(nil, &fuse.InHeader{NodeId: inner2}, "box.go"); status != fuse.OK {
		t.Fatalf("unlink: %v", status)
	}
	if status := getattr(file); status != fuse.Status(syscall.ENOENT) {
		t.Fatalf("getattr on an unlinked node: %v", status)
	}
	if !strings.Contains(logs.String(), "orphaned") {
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
