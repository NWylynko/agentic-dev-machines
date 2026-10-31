package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Private GitHub repositories open with the cluster's GitHub login (TASK-111).
// Git asks this binary for credentials (`git-credential`); the helper fetches
// the token from the lifecycle controller with the Pod identity, hands it to
// Git on stdout, and keeps nothing. The token is never in a remote URL, in Git
// config, or on the workspace volume.

const defaultTokenFile = "/var/run/secrets/kubernetes.io/serviceaccount/token"

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

// gitEnvironment is the environment for every Git and ArtifactFS child: no
// prompts, and this binary as the credential helper for the GitHub origin.
// Existing GIT_CONFIG_* entries are kept.
func (config Config) gitEnvironment(extra ...string) ([]string, error) {
	env := append(os.Environ(), extra...)
	env = append(env, "GIT_TERMINAL_PROMPT=0")
	if config.LifecycleURL == "" {
		return env, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	helper := "!" + shellQuote(executable) + " git-credential --lifecycle-url " + shellQuote(config.LifecycleURL) + " --token-file " + shellQuote(config.TokenFile) + " --url " + shellQuote(config.GitCredentialURL)
	count := 0
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, "GIT_CONFIG_COUNT="); ok {
			if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
				count = parsed
			}
		}
	}
	return append(env,
		"GIT_CONFIG_KEY_"+strconv.Itoa(count)+"=credential."+config.GitCredentialURL+".helper",
		"GIT_CONFIG_VALUE_"+strconv.Itoa(count)+"="+helper,
		"GIT_CONFIG_COUNT="+strconv.Itoa(count+1),
	), nil
}

func lifecycleRequest(ctx context.Context, lifecycleURL, tokenFile, method, path string) (map[string]any, error) {
	identity, err := os.ReadFile(tokenFile)
	if err != nil {
		return nil, fmt.Errorf("cannot read the Pod identity token: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(lifecycleURL, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(identity)))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("cannot reach the lifecycle controller (%v); GitHub login comes from adm repos login github", err)
	}
	defer response.Body.Close()
	bytes, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	var value map[string]any
	_ = json.Unmarshal(bytes, &value)
	if response.StatusCode >= 300 {
		if inner, ok := value["error"].(map[string]any); ok {
			if message, ok := inner["message"].(string); ok && message != "" {
				return nil, errors.New(message)
			}
		}
		return nil, fmt.Errorf("the lifecycle controller answered %d; run adm repos login github", response.StatusCode)
	}
	return value, nil
}

// gitCredential implements the credential helper protocol for one origin.
func gitCredential(ctx context.Context, arguments []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("git-credential", flag.ContinueOnError)
	lifecycleURL := flags.String("lifecycle-url", "", "lifecycle controller URL")
	tokenFile := flags.String("token-file", defaultTokenFile, "projected Pod identity token")
	origin := flags.String("url", "https://github.com", "the only origin that receives the token")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("usage: git-credential get|store|erase")
	}
	allowed, err := url.Parse(*origin)
	if err != nil || *lifecycleURL == "" {
		return errors.New("git-credential needs --lifecycle-url and a valid --url")
	}
	fields := map[string]string{}
	scanner := bufio.NewScanner(stdin)
	for scanner.Scan() {
		if key, value, ok := strings.Cut(scanner.Text(), "="); ok {
			fields[key] = value
		}
	}
	if fields["protocol"] != allowed.Scheme || fields["host"] != allowed.Host {
		return nil
	}
	switch flags.Arg(0) {
	case "get":
		value, err := lifecycleRequest(ctx, *lifecycleURL, *tokenFile, http.MethodGet, "/v1/runtime/repos/token")
		if err != nil {
			return err
		}
		token, _ := value["token"].(string)
		if token == "" {
			return errors.New("the lifecycle controller returned no token; run adm repos login github")
		}
		_, err = fmt.Fprintf(stdout, "username=x-access-token\npassword=%s\n", token)
		return err
	case "erase":
		_, _ = lifecycleRequest(ctx, *lifecycleURL, *tokenFile, http.MethodPost, "/v1/runtime/repos/rejected")
		return errors.New("GitHub rejected the cluster login; run adm repos login github")
	}
	return nil
}
