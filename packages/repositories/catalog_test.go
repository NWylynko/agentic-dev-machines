package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// This is an actual filesystem and Git integration test. Run it in the
// disposable FUSE-capable container documented in README.md.
func TestRepositoryFilesystem(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("FUSE integration requires /dev/fuse; use the isolated container command in README.md")
	}
	artifact, err := exec.LookPath("artifact-fs")
	if err != nil {
		t.Fatal("FUSE tests require the pinned artifact-fs binary: ", err)
	}
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
	write(t, filepath.Join(upstream, "README.md"), "upstream\n")
	write(t, filepath.Join(upstream, "large.bin"), strings.Repeat("0123456789abcdef", 32768))
	git(t, upstream, "add", ".")
	git(t, upstream, "commit", "-m", "upstream")
	base := strings.TrimSpace(git(t, upstream, "rev-parse", "HEAD"))
	catalog := Catalog{Repositories: []Repository{
		{Owner: "example", Name: "project", Remote: "file://" + upstream, Ref: "refs/heads/main"},
		{Owner: "example", Name: "parallel", Remote: "file://" + upstream, Ref: "refs/heads/main"},
		{Owner: "example", Name: "untouched", Remote: "file:///missing-and-must-never-be-acquired", Ref: "refs/heads/main"},
	}}
	newWorkspace := func(name string) Config {
		root := filepath.Join(dir, name)
		return Config{State: filepath.Join(root, "state"), GitRoot: filepath.Join(root, "git"), Views: filepath.Join(root, "views"), Mount: filepath.Join(root, "repos"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Artifact: artifact}
	}
	a, b := newWorkspace("a"), newWorkspace("b")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first, err := mountCatalog(ctx, a, catalog)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := mountCatalog(ctx, b, catalog)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	entries, err := os.ReadDir(filepath.Join(a.Mount, "example"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 || entries[0].Name() != "parallel" || entries[1].Name() != "project" || entries[2].Name() != "untouched" {
		t.Fatalf("catalog: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(a.State, "example", "project")); !os.IsNotExist(err) {
		t.Fatalf("listing prepared repository: %v", err)
	}
	if _, err := os.Stat(filepath.Join(a.State, "example", "untouched")); !os.IsNotExist(err) {
		t.Fatalf("unused repository acquired: %v", err)
	}
	projectA, projectB := filepath.Join(a.Mount, "example", "project"), filepath.Join(b.Mount, "example", "project")
	var projectInode uint64
	for lookup := range 10 {
		info, err := os.Stat(projectA)
		if err != nil {
			t.Fatal(err)
		}
		inode := info.Sys().(*syscall.Stat_t).Ino
		if lookup > 0 && inode != projectInode {
			t.Fatalf("repository inode changed across lookups: first=%d current=%d", projectInode, inode)
		}
		projectInode = inode
	}
	assertFile(t, filepath.Join(projectA, "README.md"), "upstream\n")
	assertFile(t, filepath.Join(projectB, "README.md"), "upstream\n")
	parallelA := filepath.Join(a.Mount, "example", "parallel")
	assertFile(t, filepath.Join(parallelA, "README.md"), "upstream\n")
	git(t, parallelA, "rev-parse", "HEAD")
	git(t, projectA, "config", "user.name", "Workspace A")
	git(t, projectA, "config", "user.email", "a@example.invalid")
	write(t, filepath.Join(projectA, "README.md"), "private A\n")
	write(t, filepath.Join(projectA, "untracked.txt"), "private untracked\n")
	if err := os.Symlink("README.md", filepath.Join(projectA, "inside-link")); err != nil {
		t.Fatal(err)
	}
	assertFile(t, filepath.Join(projectA, "inside-link"), "private A\n")
	outsideLink := filepath.Join(projectA, "external-link")
	if err := os.Symlink("/workspace/shared/tool", outsideLink); err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(outsideLink); err != nil || target != "/workspace/shared/tool" {
		t.Fatalf("read external symlink target: target=%q err=%v", target, err)
	}
	git(t, projectA, "add", "README.md")
	git(t, projectA, "add", "inside-link", "external-link")
	if output := git(t, projectA, "diff", "--cached"); !strings.Contains(output, "+private A") {
		t.Fatalf("private index missing: %s", output)
	}
	if output := git(t, projectB, "diff", "--cached"); output != "" {
		t.Fatalf("index leaked: %s", output)
	}
	git(t, projectA, "commit", "-m", "private A")
	if target := strings.TrimSpace(git(t, projectA, "show", "HEAD:external-link")); target != "/workspace/shared/tool" {
		t.Fatalf("git did not preserve external symlink target: %q", target)
	}
	commitA := strings.TrimSpace(git(t, projectA, "rev-parse", "HEAD"))
	if commitA == base {
		t.Fatal("local commit did not advance HEAD")
	}
	if other := strings.TrimSpace(git(t, projectB, "rev-parse", "HEAD")); other != base {
		t.Fatalf("local main leaked into B: %s", other)
	}
	if _, err := exec.Command("git", "-C", projectB, "cat-file", "-e", commitA).Output(); err == nil {
		t.Fatal("B can read A's unpublished commit")
	}
	assertFile(t, filepath.Join(projectB, "README.md"), "upstream\n")
	if _, err := os.Stat(filepath.Join(projectB, "untracked.txt")); !os.IsNotExist(err) {
		t.Fatalf("untracked file leaked: %v", err)
	}
	git(t, projectA, "branch", "private-branch")
	if output := git(t, projectB, "branch", "--list", "private-branch"); output != "" {
		t.Fatalf("branch leaked: %s", output)
	}
	write(t, filepath.Join(projectA, "README.md"), "uncommitted after commit\n")
	previousMountID, err := fuseMountID(filepath.Join(a.Views, "example", "project"))
	if err != nil || previousMountID == 0 {
		t.Fatalf("read current ArtifactFS mount identity: id=%d err=%v", previousMountID, err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	// Replacement remounts the exact private durable paths, with no reset or
	// fetch that could erase local commits, staged state, or overlays.
	first, err = mountCatalog(ctx, a, catalog)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	assertFile(t, filepath.Join(projectA, "README.md"), "uncommitted after commit\n")
	currentMountID, err := fuseMountID(filepath.Join(a.Views, "example", "project"))
	if err != nil || currentMountID == 0 || currentMountID == previousMountID {
		t.Fatalf("replacement reused stale ArtifactFS mount: previous=%d current=%d err=%v", previousMountID, currentMountID, err)
	}
	assertFile(t, filepath.Join(projectA, "untracked.txt"), "private untracked\n")
	if actual := strings.TrimSpace(git(t, projectA, "rev-parse", "HEAD")); actual != commitA {
		t.Fatalf("replacement lost local commit: %s", actual)
	}
	if output := git(t, projectA, "branch", "--list", "private-branch"); !strings.Contains(output, "private-branch") {
		t.Fatalf("replacement lost branch: %s", output)
	}
	if _, err := os.Stat(filepath.Join(a.State, "example", "untouched")); !os.IsNotExist(err) {
		t.Fatalf("unused repository acquired after replacement: %v", err)
	}
}

func TestCatalogValidationRejectsUnsafeNamespaces(t *testing.T) {
	for _, repo := range []Repository{
		{Owner: "..", Name: "outside", Remote: "https://github.com/a/b.git", Ref: "refs/heads/main"},
		{Owner: "a", Name: "../outside", Remote: "https://github.com/a/b.git", Ref: "refs/heads/main"},
		{Owner: "a", Name: "b", Remote: "https://token@github.com/a/b.git", Ref: "refs/heads/main"},
		{Owner: "a", Name: "b", Remote: "https://github.com/a/b.git", Ref: "--upload-pack=malicious"},
	} {
		if err := validateCatalog(Catalog{Repositories: []Repository{repo}}); err == nil {
			t.Fatalf("accepted unsafe catalog: %+v", repo)
		}
	}
}

func TestRepositoryRefusesEagerCloningOnRetry(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("repository integration requires /dev/fuse")
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
	git(t, upstream, "config", "user.name", "Repository test")
	git(t, upstream, "config", "user.email", "repositories@example.invalid")
	write(t, filepath.Join(upstream, "README.md"), "upstream without filtering\n")
	git(t, upstream, "add", ".")
	git(t, upstream, "commit", "-m", "baseline")
	config := Config{State: filepath.Join(dir, "state"), GitRoot: filepath.Join(dir, "git"), Views: filepath.Join(dir, "views"), Mount: filepath.Join(dir, "repos"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Artifact: artifact}
	catalog := Catalog{Repositories: []Repository{{Owner: "example", Name: "project", Remote: "file://" + upstream, Ref: "refs/heads/main"}}}
	server, err := mountCatalog(context.Background(), config, catalog)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	for attempt := range 2 {
		if _, err := os.ReadFile(filepath.Join(config.Mount, "example", "project", "README.md")); err == nil {
			t.Fatalf("attempt %d accepted an upstream without partial-clone support", attempt+1)
		}
	}
	// A failed acquisition remains retryable when the operator fixes the upstream.
	git(t, upstream, "config", "uploadpack.allowFilter", "true")
	git(t, upstream, "config", "uploadpack.allowAnySHA1InWant", "true")
	assertFile(t, filepath.Join(config.Mount, "example", "project", "README.md"), "upstream without filtering\n")
}

func git(t *testing.T, path string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", path}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return string(output)
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

func assertFile(t *testing.T, path, expected string) {
	t.Helper()
	bytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read exported path %q: %v", path, err)
	}
	if string(bytes) != expected {
		t.Fatalf("%s: got %q, want %q", path, bytes, expected)
	}
}
