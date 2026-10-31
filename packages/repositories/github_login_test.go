package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// The sidecar's Git credential helper is this very binary: git runs
// `<exe> git-credential ... get`. Under `go test` the executable is the test
// binary, so route that invocation to the real main.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "git-credential" {
		main()
		return
	}
	os.Exit(m.Run())
}

const clusterToken = "gho_clustertoken0123456789"

// A private upstream served over HTTP by git itself, refusing anyone without
// the cluster's GitHub token, and a lifecycle controller that hands that token
// to the Pod only while the cluster is logged in.
func TestPrivateRepositoryOpensWithTheClusterGitHubLogin(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("repository integration requires /dev/fuse")
	}
	artifact, err := exec.LookPath("artifact-fs")
	if err != nil {
		t.Fatal(err)
	}
	backend, err := exec.Command("git", "--exec-path").Output()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	served := filepath.Join(dir, "served")
	upstream := filepath.Join(served, "project")
	if err := os.MkdirAll(upstream, 0755); err != nil {
		t.Fatal(err)
	}
	git(t, upstream, "init", "--initial-branch=main")
	git(t, upstream, "config", "user.name", "Repository test")
	git(t, upstream, "config", "user.email", "repositories@example.invalid")
	git(t, upstream, "config", "uploadpack.allowFilter", "true")
	git(t, upstream, "config", "uploadpack.allowAnySHA1InWant", "true")
	write(t, filepath.Join(upstream, "README.md"), "private baseline\n")
	git(t, upstream, "add", ".")
	git(t, upstream, "commit", "-m", "baseline")
	cgiBackend := &cgi.Handler{
		Path: filepath.Join(strings.TrimSpace(string(backend)), "git-http-backend"),
		Env:  []string{"GIT_PROJECT_ROOT=" + served, "GIT_HTTP_EXPORT_ALL=1"},
	}
	var anonymous atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, password, ok := r.BasicAuth(); !ok || password != clusterToken {
			anonymous.Add(1)
			w.Header().Set("WWW-Authenticate", `Basic realm="github"`)
			http.Error(w, "Repository not found", http.StatusUnauthorized)
			return
		}
		cgiBackend.ServeHTTP(w, r)
	}))
	defer remote.Close()
	var loggedIn atomic.Bool
	lifecycle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer pod-identity" || r.URL.Path != "/v1/runtime/repos/token" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if !loggedIn.Load() {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": "GitHub is not connected to this installation: run adm repos login github"}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"token": clusterToken, "account": "nwylynko"})
	}))
	defer lifecycle.Close()
	tokenFile := filepath.Join(dir, "identity")
	write(t, tokenFile, "pod-identity\n")
	// The catalog names the real GitHub remote; git rewrites it to the local
	// server, exactly as it would resolve any other URL.
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "url."+remote.URL+"/.insteadOf")
	t.Setenv("GIT_CONFIG_VALUE_0", "https://github.com/example/")
	config := Config{State: filepath.Join(dir, "state"), GitRoot: filepath.Join(dir, "git"), Views: filepath.Join(dir, "views"), Mount: filepath.Join(dir, "repos"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Artifact: artifact, LifecycleURL: lifecycle.URL, TokenFile: tokenFile, GitCredentialURL: remote.URL}
	repo := Repository{Owner: "example", Name: "project", Remote: "https://github.com/example/project", Ref: "refs/heads/main"}
	server, err := mountCatalog(context.Background(), config, Catalog{Repositories: []Repository{repo}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	// Without a cluster login the open fails and says what to run.
	_, err = server.acquire(repo)
	if err == nil || !strings.Contains(err.Error(), "run adm repos login github") {
		t.Fatalf("a private repository without a cluster login must point at adm repos login github, got %v", err)
	}
	if _, err := os.ReadFile(filepath.Join(config.Mount, "example", "project", "README.md")); err == nil {
		t.Fatal("a private repository opened without a cluster login")
	}

	// With the login the same repository opens, through the same sidecar.
	loggedIn.Store(true)
	assertFile(t, filepath.Join(config.Mount, "example", "project", "README.md"), "private baseline\n")

	// The token reached Git only through the credential helper: it is not in
	// the remote URL, Git config or any file the sidecar keeps on the volume.
	filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() || strings.HasPrefix(path, served) {
			return nil
		}
		if bytes, err := os.ReadFile(path); err == nil && strings.Contains(string(bytes), clusterToken) {
			t.Errorf("%s contains the cluster GitHub token", path)
		}
		return nil
	})
}
