package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// TASK-81: paths git ignores inside a /repos checkout (node_modules, build
// output, .env, local databases) live on node-local disk instead of the
// ArtifactFS layer, so installs run at local-disk speed and nothing ignored is
// written to the replicated volume.
func TestIgnoredPathsLiveOnNodeLocalDiskAtLocalSpeed(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("repository integration requires /dev/fuse")
	}
	artifact, err := exec.LookPath("artifact-fs")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	upstream := filepath.Join(dir, "upstream")
	if err := os.MkdirAll(filepath.Join(upstream, "packages", "x"), 0755); err != nil {
		t.Fatal(err)
	}
	git(t, upstream, "init", "--initial-branch=main")
	git(t, upstream, "config", "user.name", "Repository test")
	git(t, upstream, "config", "user.email", "repositories@example.invalid")
	git(t, upstream, "config", "uploadpack.allowFilter", "true")
	git(t, upstream, "config", "uploadpack.allowAnySHA1InWant", "true")
	write(t, filepath.Join(upstream, ".gitignore"), "node_modules/\n.env\n*.db\ndist/\n")
	write(t, filepath.Join(upstream, "README.md"), "upstream\n")
	write(t, filepath.Join(upstream, "packages", "x", "index.js"), "module.exports = 1\n")
	if err := os.MkdirAll(filepath.Join(upstream, "dist"), 0755); err != nil {
		t.Fatal(err)
	}
	// Tracked although its folder is ignored: tracked paths never move.
	write(t, filepath.Join(upstream, "dist", "keep.txt"), "tracked\n")
	git(t, upstream, "add", "-f", ".")
	git(t, upstream, "commit", "-m", "upstream")

	root := filepath.Join(dir, "workspace")
	config := Config{State: filepath.Join(root, "state"), GitRoot: filepath.Join(root, "git"), Views: filepath.Join(root, "views"), Mount: filepath.Join(root, "repos"), Ignored: filepath.Join(dir, "node-local"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Artifact: artifact}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server, err := mountCatalog(ctx, config, Catalog{Repositories: []Repository{{Owner: "example", Name: "project", Remote: "file://" + upstream, Ref: "refs/heads/main"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	checkout := filepath.Join(config.Mount, "example", "project")
	layer := filepath.Join(config.Views, "example", "project")
	local := filepath.Join(config.Ignored, "example", "project")
	assertFile(t, filepath.Join(checkout, "README.md"), "upstream\n")

	// An install's worth of writes, then its removal: into an ignored folder,
	// into a folder git tracks (through the ArtifactFS layer), and on plain
	// disk for reference. Live, a real npm ci of 16,980 files took 9.7 s in
	// /repos against 5.7 s on plain disk, where it took 314 s before.
	native := filepath.Join(dir, "native")
	if err := os.Mkdir(native, 0755); err != nil {
		t.Fatal(err)
	}
	diskInstall, diskRemove := timeInstallAndRemove(t, filepath.Join(native, "node_modules"))
	ignoredInstall, ignoredRemove := timeInstallAndRemove(t, filepath.Join(checkout, "node_modules"))
	layerInstall, layerRemove := timeInstallAndRemove(t, filepath.Join(checkout, "vendor"))
	t.Logf("install: disk %v, ignored %v, layer %v; rm -rf: disk %v, ignored %v, layer %v", diskInstall, ignoredInstall, layerInstall, diskRemove, ignoredRemove, layerRemove)
	if ignoredInstall*3 > layerInstall {
		t.Errorf("install into an ignored folder took %v, not 3x faster than the ArtifactFS layer's %v", ignoredInstall, layerInstall)
	}
	if ignoredRemove*3 > layerRemove {
		t.Errorf("rm -rf of an ignored folder took %v, not 3x faster than the ArtifactFS layer's %v", ignoredRemove, layerRemove)
	}

	// Ignored paths, at any depth, are written to node-local disk only.
	install(t, filepath.Join(checkout, "node_modules"), 3, 3)
	install(t, filepath.Join(checkout, "packages", "x", "node_modules"), 2, 2)
	write(t, filepath.Join(checkout, ".env"), "SECRET=1\n")
	write(t, filepath.Join(checkout, "packages", "x", "dev.db"), "sqlite\n")
	write(t, filepath.Join(checkout, "dist", "bundle.js"), "built\n")
	write(t, filepath.Join(checkout, "dist", "keep.txt"), "tracked, edited\n")
	write(t, filepath.Join(checkout, "src.js"), "source\n")
	for _, path := range []string{"node_modules/pkg0/file0.js", "packages/x/node_modules/pkg1/file1.js", ".env", "packages/x/dev.db", "dist/bundle.js"} {
		if _, err := os.Stat(filepath.Join(local, path)); err != nil {
			t.Errorf("ignored %s is not on node-local disk: %v", path, err)
		}
		if _, err := os.Lstat(filepath.Join(layer, path)); !os.IsNotExist(err) {
			t.Errorf("ignored %s reached the ArtifactFS layer: %v", path, err)
		}
	}
	for _, path := range []string{"dist/keep.txt", "src.js"} {
		if _, err := os.Lstat(filepath.Join(local, path)); !os.IsNotExist(err) {
			t.Errorf("%s is not ignored but went to node-local disk: %v", path, err)
		}
	}
	assertFile(t, filepath.Join(layer, "dist", "keep.txt"), "tracked, edited\n")
	assertFile(t, filepath.Join(checkout, ".env"), "SECRET=1\n")

	// The checkout shows both kinds of path as one tree, and git sees only the
	// real changes.
	listing := names(t, checkout)
	for _, name := range []string{".env", ".gitignore", "README.md", "dist", "node_modules", "packages", "src.js"} {
		if !slices.Contains(listing, name) {
			t.Errorf("checkout listing %v is missing %s", listing, name)
		}
	}
	if listing := names(t, filepath.Join(checkout, "dist")); !slices.Equal(listing, []string{"bundle.js", "keep.txt"}) {
		t.Errorf("dist listing: %v", listing)
	}
	status := git(t, checkout, "status", "--porcelain")
	if status != " M dist/keep.txt\n?? src.js\n" {
		t.Errorf("git status:\n%s", status)
	}

	// A folder that holds ignored paths can't be removed while they're there,
	// and goes once they're gone.
	if err := os.Remove(filepath.Join(checkout, "packages", "x")); err == nil {
		t.Error("removed packages/x while it still held node_modules and dev.db")
	}
	if output, err := exec.Command("rm", "-rf", filepath.Join(checkout, "packages")).CombinedOutput(); err != nil {
		t.Fatalf("rm -rf packages: %v\n%s", err, output)
	}
	for _, path := range []string{filepath.Join(checkout, "packages"), filepath.Join(local, "packages", "x", "dev.db")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Errorf("%s survived rm -rf: %v", path, err)
		}
	}

	// Renaming a folder carries its ignored paths along.
	if err := os.Rename(filepath.Join(checkout, "dist"), filepath.Join(checkout, "out")); err != nil {
		t.Fatal(err)
	}
	assertFile(t, filepath.Join(checkout, "out", "bundle.js"), "built\n")
	assertFile(t, filepath.Join(checkout, "out", "keep.txt"), "tracked, edited\n")
}

// install writes an npm-like tree: folders of small files, made and filled
// one at a time, as package managers extract packages.
func install(t *testing.T, root string, packages, files int) {
	t.Helper()
	contents := []byte(strings.Repeat("module.exports = {};\n", 50))
	for p := range packages {
		folder := filepath.Join(root, fmt.Sprintf("pkg%d", p))
		if err := os.MkdirAll(folder, 0755); err != nil {
			t.Fatal(err)
		}
		for f := range files {
			if err := os.WriteFile(filepath.Join(folder, fmt.Sprintf("file%d.js", f)), contents, 0644); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func timeInstallAndRemove(t *testing.T, root string) (time.Duration, time.Duration) {
	t.Helper()
	started := time.Now()
	install(t, root, 300, 20)
	installed := time.Since(started)
	started = time.Now()
	if output, err := exec.Command("rm", "-rf", root).CombinedOutput(); err != nil {
		t.Fatalf("rm -rf %s: %v\n%s", root, err, output)
	}
	return installed, time.Since(started)
}

func names(t *testing.T, path string) []string {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	var result []string
	for _, entry := range entries {
		result = append(result, entry.Name())
	}
	return result
}
