package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

type Repository struct {
	Owner          string `json:"owner"`
	Name           string `json:"name"`
	Remote         string `json:"remote"`
	Ref            string `json:"ref"`
	UpstreamGitDir string `json:"upstreamGitDir,omitempty"`
}

type Catalog struct {
	Repositories []Repository `json:"repositories"`
}

type Config struct {
	State, GitRoot, Views, Mount, Artifact, GitWrapper string
	UID, GID                                           uint32
}

var namespacePart = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func validateCatalog(catalog Catalog) error {
	seen := map[string]bool{}
	for _, repo := range catalog.Repositories {
		if !namespacePart.MatchString(repo.Owner) || !namespacePart.MatchString(repo.Name) || len(repo.Owner) > 100 || len(repo.Name) > 100 {
			return errors.New("repository owner/name must be plain GitHub namespace components")
		}
		key := strings.ToLower(repo.Owner + "/" + repo.Name)
		if seen[key] {
			return fmt.Errorf("duplicate repository %s", key)
		}
		seen[key] = true
		remote, err := url.Parse(repo.Remote)
		if err != nil || remote.User != nil || remote.RawQuery != "" || remote.Fragment != "" {
			return errors.New("repository remote must not contain credentials, query parameters, or fragments")
		}
		if remote.Scheme != "https" && remote.Scheme != "file" && remote.Scheme != "ssh" {
			return errors.New("repository remote must use https, ssh, or explicitly selected local file transport")
		}
		if remote.Scheme != "file" && remote.Host == "" {
			return errors.New("repository remote host is required")
		}
		if !strings.HasPrefix(repo.Ref, "refs/heads/") || strings.ContainsAny(repo.Ref, "\n\r\x00 ~^:?*[\\") || strings.Contains(repo.Ref, "..") || strings.HasSuffix(repo.Ref, "/") {
			return errors.New("repository ref must be an explicit refs/heads/<branch> ref")
		}
		if repo.UpstreamGitDir != "" && !filepath.IsAbs(repo.UpstreamGitDir) {
			return errors.New("upstreamGitDir must be an absolute read-only published Git base path")
		}
	}
	return nil
}

func discover(ctx context.Context, owner string, limit int, gh string) (Catalog, error) {
	if !namespacePart.MatchString(owner) || limit < 1 || limit > 100000 {
		return Catalog{}, errors.New("invalid owner or catalog limit")
	}
	command := exec.CommandContext(ctx, gh, "repo", "list", owner, "--limit", fmt.Sprint(limit), "--json", "name,nameWithOwner,url,defaultBranchRef")
	output, err := command.Output()
	if err != nil {
		return Catalog{}, fmt.Errorf("GitHub catalog discovery failed; authenticate gh on the management host: %w", err)
	}
	var records []struct {
		Name             string `json:"name"`
		NameWithOwner    string `json:"nameWithOwner"`
		URL              string `json:"url"`
		DefaultBranchRef *struct {
			Name string `json:"name"`
		} `json:"defaultBranchRef"`
	}
	if err := json.Unmarshal(output, &records); err != nil {
		return Catalog{}, fmt.Errorf("invalid gh catalog JSON: %w", err)
	}
	catalog := Catalog{}
	for _, record := range records {
		parts := strings.Split(record.NameWithOwner, "/")
		if len(parts) != 2 || !strings.EqualFold(parts[0], owner) || parts[1] != record.Name {
			return Catalog{}, errors.New("gh returned a repository outside the requested owner")
		}
		// Empty repositories have no starting revision and cannot form a Git base.
		if record.DefaultBranchRef == nil || record.DefaultBranchRef.Name == "" {
			continue
		}
		catalog.Repositories = append(catalog.Repositories, Repository{Owner: parts[0], Name: parts[1], Remote: record.URL + ".git", Ref: "refs/heads/" + record.DefaultBranchRef.Name})
	}
	sort.Slice(catalog.Repositories, func(i, j int) bool { return catalog.Repositories[i].Name < catalog.Repositories[j].Name })
	return catalog, validateCatalog(catalog)
}

func run(ctx context.Context, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: adm-repositories discover|serve|prepare-base")
	}
	switch arguments[0] {
	case "discover":
		flags := flag.NewFlagSet("discover", flag.ContinueOnError)
		owner := flags.String("owner", "", "GitHub owner")
		limit := flags.Int("limit", 10000, "maximum repositories")
		gh := flags.String("gh", "gh", "GitHub CLI executable")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		catalog, err := discover(ctx, *owner, *limit, *gh)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(catalog)
	case "serve":
		flags := flag.NewFlagSet("serve", flag.ContinueOnError)
		config := Config{}
		var uid, gid uint
		var catalogPath string
		flags.StringVar(&catalogPath, "catalog", "", "catalog JSON file")
		flags.StringVar(&config.State, "state", "", "durable private ArtifactFS state")
		flags.StringVar(&config.GitRoot, "git-root", "", "private Git directories, also visible in dev container at this path")
		flags.StringVar(&config.Views, "views", "", "private ArtifactFS mount directory")
		flags.StringVar(&config.Mount, "mount", "", "exported catalog mount")
		flags.StringVar(&config.Artifact, "artifact-fs", "artifact-fs", "pinned ArtifactFS executable")
		flags.StringVar(&config.GitWrapper, "git-wrapper", "/usr/local/lib/adm-repositories/git", "image-owned no-new-privileges Git wrapper")
		flags.UintVar(&uid, "uid", 1000, "development user UID")
		flags.UintVar(&gid, "gid", 1000, "development user GID")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		config.UID = uint32(uid)
		config.GID = uint32(gid)
		if os.Getuid() == 0 || uint32(os.Getuid()) != config.UID || uint32(os.Getgid()) != config.GID {
			return errors.New("serve must run as the configured unprivileged development UID/GID; launch it through setpriv, never as root")
		}
		bytes, err := os.ReadFile(catalogPath)
		if err != nil {
			return err
		}
		var catalog Catalog
		if err = json.Unmarshal(bytes, &catalog); err != nil {
			return err
		}
		server, err := mountCatalog(ctx, config, catalog)
		if err != nil {
			return err
		}
		slog.Info("repository catalog ready", "mount", config.Mount, "repositories", len(catalog.Repositories))
		select {
		case <-ctx.Done():
			return server.Close()
		case failure := <-server.failures:
			return errors.Join(failure, server.Close())
		}
	case "prepare-base":
		flags := flag.NewFlagSet("prepare-base", flag.ContinueOnError)
		remote := flags.String("remote", "", "published upstream URL")
		destination := flags.String("destination", "", "new immutable base directory")
		ref := flags.String("ref", "refs/heads/main", "upstream branch ref")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if err := validateCatalog(Catalog{Repositories: []Repository{{Owner: "upstream", Name: "base", Remote: *remote, Ref: *ref}}}); err != nil {
			return err
		}
		if !filepath.IsAbs(*destination) {
			return errors.New("base destination must be absolute")
		}
		if _, err := os.Lstat(*destination); !os.IsNotExist(err) {
			return errors.New("immutable base destination already exists or cannot be inspected")
		}
		command := exec.CommandContext(ctx, "git", "clone", "--bare", "--single-branch", "--no-tags", "--branch", strings.TrimPrefix(*ref, "refs/heads/"), "--", *remote, *destination)
		command.Stdout = os.Stdout
		command.Stderr = os.Stderr
		if err := command.Run(); err != nil {
			return fmt.Errorf("published upstream base acquisition failed: %w", err)
		}
		if _, err := exec.CommandContext(ctx, "git", "--git-dir", *destination, "config", "gc.auto", "0").Output(); err != nil {
			return err
		}
		fmt.Fprintln(os.Stdout, "Mount this immutable published base read-only at the same path in the sidecar and development containers before selecting upstreamGitDir.")
		return nil
	default:
		return fmt.Errorf("unknown repositories command %q", arguments[0])
	}
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	if err := run(ctx, os.Args[1:]); err != nil {
		slog.Error("repositories failed", "error", err)
		os.Exit(1)
	}
}
