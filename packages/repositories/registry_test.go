package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// The repositories sidecar shows the cluster registry (TASK-112): a repository
// registered after the sidecar started appears in /repos without restarting it,
// and a removed one disappears. Listing never acquires anything.
func TestRegistryRepositoriesAppearAndDisappearWithoutRestart(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("repository integration requires /dev/fuse")
	}
	var mu sync.Mutex
	registry := Catalog{Repositories: []Repository{{Owner: "example", Name: "first", Remote: "https://github.com/example/first.git", Ref: "refs/heads/main"}}}
	var failing bool
	lifecycle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer pod-identity" || r.URL.Path != "/v1/runtime/repos/registry" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if failing {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": "lifecycle is restarting"}})
			return
		}
		_ = json.NewEncoder(w).Encode(registry)
	}))
	defer lifecycle.Close()
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "identity")
	write(t, tokenFile, "pod-identity\n")
	config := Config{State: filepath.Join(dir, "state"), GitRoot: filepath.Join(dir, "git"), Views: filepath.Join(dir, "views"), Mount: filepath.Join(dir, "repos"), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), LifecycleURL: lifecycle.URL, TokenFile: tokenFile}
	server, err := mountRegistry(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	names := func(path string) []string {
		entries, err := os.ReadDir(filepath.Join(config.Mount, path))
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		result := []string{}
		for _, entry := range entries {
			result = append(result, entry.Name())
		}
		return result
	}
	if got := strings.Join(names(""), ","); got != "example" {
		t.Fatalf("owners = %s", got)
	}
	if got := strings.Join(names("example"), ","); got != "first" {
		t.Fatalf("repositories = %s", got)
	}

	// Registered after the sidecar started: a new repository under an existing
	// owner and a new owner, both visible immediately.
	mu.Lock()
	registry.Repositories = append(registry.Repositories,
		Repository{Owner: "example", Name: "later", Remote: "https://github.com/example/later.git", Ref: "refs/heads/main"},
		Repository{Owner: "newowner", Name: "fresh", Remote: "https://github.com/newowner/fresh.git", Ref: "refs/heads/trunk"})
	mu.Unlock()
	if got := strings.Join(names(""), ","); got != "example,newowner" {
		t.Fatalf("owners after registering = %s", got)
	}
	if got := strings.Join(names("example"), ","); got != "first,later" {
		t.Fatalf("repositories after registering = %s", got)
	}
	if _, err := os.Stat(filepath.Join(config.Mount, "newowner", "fresh")); err != nil {
		t.Fatalf("a repository registered after start must resolve: %v", err)
	}

	// Removed from the registry: gone from the listing.
	mu.Lock()
	registry.Repositories = registry.Repositories[1:2]
	mu.Unlock()
	if got := strings.Join(names("example"), ","); got != "later" {
		t.Fatalf("repositories after removal = %s", got)
	}

	// An unreachable registry is an error naming the cause, never a stale or empty list.
	mu.Lock()
	failing = true
	mu.Unlock()
	if _, err := os.ReadDir(config.Mount); err == nil {
		t.Fatal("listing /repos must fail while the registry cannot be read")
	}
}
