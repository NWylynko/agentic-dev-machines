package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRepositoryServiceReportsBackendFailure(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("repository service integration requires /dev/fuse")
	}
	artifact, err := exec.LookPath("artifact-fs")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	upstream := filepath.Join(dir, "upstream")
	if err := os.Mkdir(upstream, 0755); err != nil {
		t.Fatal(err)
	}
	git(t, upstream, "init", "--initial-branch=main")
	git(t, upstream, "config", "user.name", "Repository service test")
	git(t, upstream, "config", "user.email", "repositories@example.invalid")
	git(t, upstream, "config", "uploadpack.allowFilter", "true")
	git(t, upstream, "config", "uploadpack.allowAnySHA1InWant", "true")
	write(t, filepath.Join(upstream, "README.md"), "published baseline\n")
	git(t, upstream, "add", ".")
	git(t, upstream, "commit", "-m", "baseline")
	catalog, err := json.Marshal(Catalog{Repositories: []Repository{{Owner: "example", Name: "project", Remote: "file://" + upstream, Ref: "refs/heads/main"}}})
	if err != nil {
		t.Fatal(err)
	}
	catalogPath := filepath.Join(dir, "catalog.json")
	write(t, catalogPath, string(catalog))
	pidPath := filepath.Join(dir, "backend.pid")
	wrapper := filepath.Join(dir, "artifact-fs")
	shellQuote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	write(t, wrapper, "#!/bin/sh\nif [ \"$1\" = daemon ]; then echo $$ > "+shellQuote(pidPath)+"; fi\nexec "+shellQuote(artifact)+" \"$@\"\n")
	if err := os.Chmod(wrapper, 0755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	completed := false
	defer func() {
		cancel()
		if !completed {
			select {
			case <-finished:
			case <-time.After(5 * time.Second):
				t.Error("repository service did not release its mounts during shutdown")
			}
		}
	}()
	mount := filepath.Join(dir, "repos")
	mounts, err := openMountNotifications()
	if err != nil {
		t.Fatal(err)
	}
	defer mounts.Close()
	go func() {
		finished <- run(ctx, []string{"serve", "--catalog", catalogPath, "--state", filepath.Join(dir, "state"), "--git-root", filepath.Join(dir, "git"), "--views", filepath.Join(dir, "views"), "--mount", mount, "--uid", fmt.Sprint(os.Getuid()), "--gid", fmt.Sprint(os.Getgid()), "--artifact-fs", wrapper, "--git-wrapper", ""})
	}()
	ready, stop := context.WithTimeout(ctx, 10*time.Second)
	defer stop()
	if err := waitMounted(ready, ready, mounts, mount, 0); err != nil {
		t.Fatal(err)
	}
	assertFile(t, filepath.Join(mount, "example", "project", "README.md"), "published baseline\n")
	pidBytes, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		completed = true
		if err == nil || !strings.Contains(err.Error(), "example/project") {
			t.Fatalf("backend failure must stop the service with repository diagnostics, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("repository service stayed healthy after its filesystem backend exited")
	}
}
