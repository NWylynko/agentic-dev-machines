package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// prepareBase makes or refreshes the shared read-only base for one registered
// repository (TASK-113): a bare clone of its branch that every workspace
// clones against with --reference. A refresh only fetches, so it adds objects
// and moves the base's branch; workspaces' own refs never change. Objects are
// never pruned (gc.auto=0), because workspaces rely on the base keeping every
// object it ever had.
func prepareBase(ctx context.Context, remote, ref, destination string) error {
	branch := strings.TrimPrefix(ref, "refs/heads/")
	gitCommand := func(args ...string) *exec.Cmd {
		command := exec.CommandContext(ctx, "git", args...)
		command.Stdout = os.Stdout
		command.Stderr = os.Stderr
		return command
	}
	if _, err := os.Lstat(destination); err == nil {
		if err := gitCommand("--git-dir", destination, "fetch", "--no-tags", "--", remote, "+"+ref+":"+ref).Run(); err != nil {
			return fmt.Errorf("refresh shared base %s: %w", destination, err)
		}
		fmt.Fprintln(os.Stdout, "refreshed", destination)
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		return err
	}
	// Clone beside the destination and rename, so a failed clone never leaves
	// a partial base that workspaces would trust.
	staging, err := os.MkdirTemp(filepath.Dir(destination), ".prepare-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	clone := filepath.Join(staging, "base.git")
	if err := gitCommand("clone", "--bare", "--single-branch", "--no-tags", "--branch", branch, "--", remote, clone).Run(); err != nil {
		return fmt.Errorf("shared base clone of %s failed: %w", remote, err)
	}
	if err := gitCommand("--git-dir", clone, "config", "gc.auto", "0").Run(); err != nil {
		return err
	}
	// Workspaces read the base as UID 1000 through a read-only mount.
	if err := os.Chmod(clone, 0755); err != nil {
		return err
	}
	if err := os.Rename(clone, destination); err != nil {
		if _, statErr := os.Lstat(destination); statErr == nil {
			return errors.New("another prepare-base created " + destination + " at the same time")
		}
		return err
	}
	fmt.Fprintln(os.Stdout, "prepared", destination)
	return nil
}
