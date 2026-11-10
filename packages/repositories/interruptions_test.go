package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

// TASK-125: edits through /repos failed with "input/output error" (truncate,
// write, opendir) and left 0-byte files, while the same edits straight on the
// ArtifactFS view never failed. The sidecar's own threads make those calls into
// ArtifactFS, the Go runtime signals its threads to preempt goroutines, the
// kernel turns each signal into a FUSE INTERRUPT, and ArtifactFS answers an
// interrupted request with EIO. Here ordinary shell tools edit, rename over and
// read files in parallel through /repos, as an agent's tools do.
//
// It also fails on any orphaned node: a folder whose node lost its path
// answers "Directory nonexistent" to whoever still holds it.
func TestParallelEditsThroughReposNeverFailOrEmptyFiles(t *testing.T) {
	logs := captureLogs(t)
	_, repo := mountGeneratedRepository(t, 20, 5, 20)
	// Files in even folders are saved by rename (an editor's atomic save)
	// while others rewrite them in place; files in odd folders are written and
	// read back. Nothing reads a file while it is renamed over: ArtifactFS
	// itself refuses fstat on a file replaced while open (ESTALE), which no
	// change here can fix.
	script := `
cd "$1" || exit 1
saved=$(find . -name '*.go' -path './d?[02468]/*' | sort)
reread=$(find . -name '*.go' -path './d?[13579]/*' | sort)
pick() { echo "$1" | sed -n "$(( ($(od -An -N2 -tu2 /dev/urandom) % $(echo "$1" | wc -l)) + 1 ))p"; }
worker() {
  w=$1; i=0
  while [ $i -lt 120 ]; do
    i=$((i + 1))
    case $((w % 4)) in
      0) f=$(pick "$saved"); printf 'package x // rewrite %s %s\n' "$w" "$i" > "$f" ;;
      1) f=$(pick "$saved"); printf 'package x // rename %s %s\n' "$w" "$i" > "$f.tmp.$w" && mv -f "$f.tmp.$w" "$f" ;;
      2) f=$(pick "$reread"); printf 'package x // reread %s %s\n' "$w" "$i" > "$f" && cat "$f" > /dev/null ;;
      3) f=$(pick "$saved"); ls "$(dirname "$f")" > /dev/null ;;
    esac
  done
}
w=0; while [ $w -lt 12 ]; do worker $w & w=$((w + 1)); done; wait
`
	out, err := exec.Command("sh", "-c", script, "edits", repo).CombinedOutput()
	if err != nil || len(strings.TrimSpace(string(out))) > 0 {
		t.Errorf("parallel edits through /repos failed (%v):\n%s", err, out)
	}
	empty, err := exec.Command("find", repo, "-name", "*.go", "-size", "0").Output()
	if err != nil {
		t.Fatal(err)
	}
	if len(strings.TrimSpace(string(empty))) > 0 {
		t.Errorf("edits left empty files:\n%s", empty)
	}
	if strings.Contains(logs.String(), "orphaned") {
		t.Errorf("repository nodes lost their path:\n%s", logs)
	}
}

// A caller interrupted by a signal (a Go program being preempted, a Ctrl-C)
// made the kernel cancel its lookup, which cancelled the registry fetch behind
// it and turned the lookup into EIO (live: "context canceled" at 14:41 UTC).
// The lookup must still answer.
func TestInterruptedLookupStillFindsTheRepository(t *testing.T) {
	host := mountTestCatalog(t, Catalog{Repositories: []Repository{{Owner: "example", Name: "project", Remote: "file:///unused", Ref: "refs/heads/main"}}})
	raw := fs.NewNodeFS(&catalogDirectory{server: host}, catalogFilesystemOptions(host.config))
	interrupted := make(chan struct{})
	close(interrupted)
	var out fuse.EntryOut
	if status := raw.Lookup(interrupted, &fuse.InHeader{NodeId: fuse.FUSE_ROOT_ID}, "example", &out); status != fuse.OK {
		t.Fatalf("interrupted lookup of the owner: %v", status)
	}
	if status := raw.Lookup(interrupted, &fuse.InHeader{NodeId: out.NodeId}, "project", &out); status != fuse.OK {
		t.Fatalf("interrupted lookup of the repository: %v", status)
	}
}

// mountTestCatalog mounts a catalog whose registry answers only while the
// request that needs it is still wanted, as the real HTTP fetch does.
func mountTestCatalog(t *testing.T, catalog Catalog) *catalogServer {
	t.Helper()
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("FUSE integration requires /dev/fuse")
	}
	dir := t.TempDir()
	config := Config{State: filepath.Join(dir, "state"), GitRoot: filepath.Join(dir, "git"), Views: filepath.Join(dir, "views"), Mount: filepath.Join(dir, "repos"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	host, err := mountSource(context.Background(), config, func(ctx context.Context) (Catalog, error) {
		if err := ctx.Err(); err != nil {
			return Catalog{}, fmt.Errorf("cannot read the repository registry: %w", err)
		}
		return catalog, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { host.Close() })
	return host
}

// mountGeneratedRepository opens a repository of dirs x subdirs x files Go
// files through a real catalog and returns the server and its /repos path.
func mountGeneratedRepository(t *testing.T, dirs, subdirs, files int) (*catalogServer, string) {
	t.Helper()
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("FUSE integration requires /dev/fuse")
	}
	artifact, err := exec.LookPath("artifact-fs")
	if err != nil {
		t.Fatal("FUSE tests require the pinned artifact-fs binary: ", err)
	}
	dir := t.TempDir()
	upstream := filepath.Join(dir, "upstream")
	git(t, dir, "init", "-q", "--initial-branch=main", upstream)
	git(t, upstream, "config", "user.name", "Repository test")
	git(t, upstream, "config", "user.email", "repositories@example.invalid")
	git(t, upstream, "config", "uploadpack.allowFilter", "true")
	git(t, upstream, "config", "uploadpack.allowAnySHA1InWant", "true")
	for d := range dirs {
		for s := range subdirs {
			path := filepath.Join(upstream, fmt.Sprintf("d%02d", d), fmt.Sprintf("s%d", s))
			if err := os.MkdirAll(path, 0755); err != nil {
				t.Fatal(err)
			}
			for f := range files {
				write(t, filepath.Join(path, fmt.Sprintf("f%d.go", f)), fmt.Sprintf("package x // %d %d %d\n", d, s, f))
			}
		}
	}
	git(t, upstream, "add", ".")
	git(t, upstream, "commit", "-q", "-m", "upstream")
	root := filepath.Join(dir, "workspace")
	config := Config{State: filepath.Join(root, "state"), GitRoot: filepath.Join(root, "git"), Views: filepath.Join(root, "views"), Mount: filepath.Join(root, "repos"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Artifact: artifact}
	host, err := mountCatalog(context.Background(), config, Catalog{Repositories: []Repository{{Owner: "example", Name: "project", Remote: "file://" + upstream, Ref: "refs/heads/main"}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { host.Close() })
	return host, filepath.Join(config.Mount, "example", "project")
}
