package main

import (
	"context"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

// TASK-113: every workspace clones against one shared, read-only base per
// repository, so a file read in two workspaces is stored once (in the base),
// while each workspace's edits, commits and branches stay private.
func TestSharedBaseStoresFilesOnceAndKeepsWorkPrivate(t *testing.T) {
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
	git(t, upstream, "config", "uploadpack.allowFilter", "true")
	git(t, upstream, "config", "uploadpack.allowAnySHA1InWant", "true")
	// Incompressible, so a stored copy shows up clearly in disk use.
	random := make([]byte, 2<<20)
	rand.New(rand.NewSource(113)).Read(random)
	large := string(random)
	write(t, filepath.Join(upstream, "README.md"), "upstream\n")
	write(t, filepath.Join(upstream, "large.bin"), large)
	git(t, upstream, "add", ".")
	git(t, upstream, "commit", "-m", "upstream")
	baseline := strings.TrimSpace(git(t, upstream, "rev-parse", "HEAD"))

	// The lifecycle prepares the base on a volume it owns; workspaces only ever
	// see that volume through a read-only mount.
	writable := filepath.Join(dir, "bases")
	if err := run(context.Background(), []string{"prepare-base", "--remote", "file://" + upstream, "--ref", "refs/heads/main", "--destination", filepath.Join(writable, "example", "project.git")}); err != nil {
		t.Fatal(err)
	}
	readOnly := filepath.Join(dir, "bases-ro")
	mountReadOnly(t, writable, readOnly)
	base := filepath.Join(readOnly, "example", "project.git")

	newWorkspace := func(name string) Config {
		root := filepath.Join(dir, name)
		return Config{State: filepath.Join(root, "state"), GitRoot: filepath.Join(root, "git"), Views: filepath.Join(root, "views"), Mount: filepath.Join(root, "repos"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Artifact: artifact}
	}
	shared := Catalog{Repositories: []Repository{{Owner: "example", Name: "project", Remote: "file://" + upstream, Ref: "refs/heads/main", UpstreamGitDir: base}}}
	a, b, alone := newWorkspace("a"), newWorkspace("b"), newWorkspace("alone")
	for _, workspace := range []struct {
		config  Config
		catalog Catalog
	}{{a, shared}, {b, shared}, {alone, Catalog{Repositories: []Repository{{Owner: "example", Name: "project", Remote: "file://" + upstream, Ref: "refs/heads/main"}}}}} {
		server, err := mountCatalog(context.Background(), workspace.config, workspace.catalog)
		if err != nil {
			t.Fatal(err)
		}
		defer server.Close()
	}
	projectA, projectB := filepath.Join(a.Mount, "example", "project"), filepath.Join(b.Mount, "example", "project")
	for _, project := range []string{projectA, projectB, filepath.Join(alone.Mount, "example", "project")} {
		assertFile(t, filepath.Join(project, "large.bin"), large)
	}
	// Without a base the workspace downloads its own copy of large.bin; with
	// the base it reads the base's copy and stores almost nothing itself.
	withoutBase := gitDirKiB(t, alone)
	for _, workspace := range []Config{a, b} {
		if used := gitDirKiB(t, workspace); used*4 > withoutBase {
			t.Fatalf("workspace %s stores %d KiB of Git data with the shared base, %d KiB without: the file was stored again", workspace.GitRoot, used, withoutBase)
		}
	}
	if withoutBase < 2048 {
		t.Fatalf("control workspace stores only %d KiB; the measurement cannot see a 2 MiB file", withoutBase)
	}

	// Work stays private to each workspace.
	git(t, projectA, "config", "user.name", "Workspace A")
	git(t, projectA, "config", "user.email", "a@example.invalid")
	write(t, filepath.Join(projectA, "README.md"), "private A\n")
	git(t, projectA, "commit", "-am", "private A")
	git(t, projectA, "branch", "private-branch")
	commitA := strings.TrimSpace(git(t, projectA, "rev-parse", "HEAD"))
	assertFile(t, filepath.Join(projectB, "README.md"), "upstream\n")
	if other := strings.TrimSpace(git(t, projectB, "rev-parse", "HEAD")); other != baseline {
		t.Fatalf("A's commit moved B: %s", other)
	}
	if _, err := exec.Command("git", "-C", projectB, "cat-file", "-e", commitA).Output(); err == nil {
		t.Fatal("B can read A's unpublished commit")
	}
	if output := git(t, projectB, "branch", "--list", "private-branch"); output != "" {
		t.Fatalf("branch leaked: %s", output)
	}
	if _, err := exec.Command("git", "--git-dir", filepath.Join(writable, "example", "project.git"), "cat-file", "-e", commitA).Output(); err == nil {
		t.Fatal("A's commit was written into the shared base")
	}

	// Refreshing the base adds the new upstream commit without moving any
	// workspace's checkout.
	write(t, filepath.Join(upstream, "README.md"), "upstream moved\n")
	git(t, upstream, "commit", "-am", "upstream moved")
	moved := strings.TrimSpace(git(t, upstream, "rev-parse", "HEAD"))
	if err := run(context.Background(), []string{"prepare-base", "--remote", "file://" + upstream, "--ref", "refs/heads/main", "--destination", filepath.Join(writable, "example", "project.git")}); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.Command("git", "--git-dir", base, "cat-file", "-e", moved).Output(); err != nil {
		t.Fatal("refresh did not add the new upstream commit to the base")
	}
	if head := strings.TrimSpace(git(t, projectB, "rev-parse", "HEAD")); head != baseline {
		t.Fatalf("refreshing the base moved B to %s", head)
	}
	assertFile(t, filepath.Join(projectB, "README.md"), "upstream\n")
	if head := strings.TrimSpace(git(t, projectA, "rev-parse", "HEAD")); head != commitA {
		t.Fatalf("refreshing the base moved A to %s", head)
	}
}

// A base the workspace could write to would let one workspace's objects reach
// every other workspace, so the sidecar refuses it.
func TestSharedBaseMustBeReadOnly(t *testing.T) {
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
	git(t, upstream, "config", "uploadpack.allowFilter", "true")
	write(t, filepath.Join(upstream, "README.md"), "upstream\n")
	git(t, upstream, "add", ".")
	git(t, upstream, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-m", "upstream")
	base := filepath.Join(dir, "bases", "example", "project.git")
	if err := run(context.Background(), []string{"prepare-base", "--remote", "file://" + upstream, "--destination", base}); err != nil {
		t.Fatal(err)
	}
	config := Config{State: filepath.Join(dir, "state"), GitRoot: filepath.Join(dir, "git"), Views: filepath.Join(dir, "views"), Mount: filepath.Join(dir, "repos"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Artifact: artifact}
	server, err := mountCatalog(context.Background(), config, Catalog{Repositories: []Repository{{Owner: "example", Name: "project", Remote: "file://" + upstream, Ref: "refs/heads/main", UpstreamGitDir: base}}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	if _, err := os.ReadFile(filepath.Join(config.Mount, "example", "project", "README.md")); err == nil {
		t.Fatal("opened a repository against a writable shared base")
	}
}

// mountReadOnly exposes source at target through a read-only FUSE mount, the
// unprivileged stand-in for the workspace Pod's readOnly volume mount.
func mountReadOnly(t *testing.T, source, target string) {
	t.Helper()
	if err := os.MkdirAll(target, 0755); err != nil {
		t.Fatal(err)
	}
	root, err := fs.NewLoopbackRoot(source)
	if err != nil {
		t.Fatal(err)
	}
	server, err := fs.Mount(target, root, &fs.Options{MountOptions: fuse.MountOptions{Options: []string{"ro"}, FsName: "test-base", Name: "test-base"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Unmount() })
}

// gitDirKiB is the disk a workspace uses for its private Git directories.
func gitDirKiB(t *testing.T, config Config) int64 {
	t.Helper()
	output, err := exec.Command("du", "-sk", config.GitRoot).CombinedOutput()
	if err != nil {
		t.Fatalf("du %s: %v\n%s", config.GitRoot, err, output)
	}
	used, err := strconv.ParseInt(strings.Fields(string(output))[0], 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return used
}
