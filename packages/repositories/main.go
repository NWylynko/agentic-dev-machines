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
	"os/signal"
	"path/filepath"
	"regexp"
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
	// Where Git credentials for GitHub come from (TASK-111).
	LifecycleURL, TokenFile, GitCredentialURL string
	UID, GID                                  uint32
}

// GitHub repository names may start with "." or "_" (for example .github).
var namespacePart = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func validateCatalog(catalog Catalog) error {
	seen := map[string]bool{}
	for _, repo := range catalog.Repositories {
		if repo.Owner == "." || repo.Owner == ".." || repo.Name == "." || repo.Name == ".." || !namespacePart.MatchString(repo.Owner) || !namespacePart.MatchString(repo.Name) || len(repo.Owner) > 100 || len(repo.Name) > 100 {
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

func run(ctx context.Context, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: adm-repositories serve|git-credential|prepare-base")
	}
	switch arguments[0] {
	case "serve":
		flags := flag.NewFlagSet("serve", flag.ContinueOnError)
		config := Config{}
		var uid, gid uint
		var catalogPath string
		flags.StringVar(&catalogPath, "catalog", "", "fixed catalog JSON file for development; by default /repos shows the cluster registry from the lifecycle controller")
		flags.StringVar(&config.State, "state", "", "durable private ArtifactFS state")
		flags.StringVar(&config.GitRoot, "git-root", "", "private Git directories, also visible in dev container at this path")
		flags.StringVar(&config.Views, "views", "", "private ArtifactFS mount directory")
		flags.StringVar(&config.Mount, "mount", "", "exported catalog mount")
		flags.StringVar(&config.Artifact, "artifact-fs", "artifact-fs", "pinned ArtifactFS executable")
		flags.StringVar(&config.GitWrapper, "git-wrapper", "/usr/local/lib/adm-repositories/git", "image-owned no-new-privileges Git wrapper")
		flags.StringVar(&config.LifecycleURL, "lifecycle-url", os.Getenv("ADM_LIFECYCLE_URL"), "lifecycle controller that hands out the cluster GitHub login")
		flags.StringVar(&config.TokenFile, "token-file", defaultTokenFile, "projected Pod identity token")
		flags.StringVar(&config.GitCredentialURL, "git-credential-url", "https://github.com", "the only origin that receives the GitHub token")
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
		var server *catalogServer
		var err error
		if catalogPath != "" {
			var bytes []byte
			if bytes, err = os.ReadFile(catalogPath); err != nil {
				return err
			}
			var catalog Catalog
			if err = json.Unmarshal(bytes, &catalog); err != nil {
				return err
			}
			server, err = mountCatalog(ctx, config, catalog)
		} else {
			server, err = mountRegistry(ctx, config)
		}
		if err != nil {
			return err
		}
		slog.Info("repository catalog ready", "mount", config.Mount, "fixedCatalog", catalogPath != "")
		select {
		case <-ctx.Done():
			return server.Close()
		case failure := <-server.failures:
			return errors.Join(failure, server.Close())
		}
	case "git-credential":
		return gitCredential(ctx, arguments[1:], os.Stdin, os.Stdout)
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
		return prepareBase(ctx, *remote, *ref, *destination)
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
