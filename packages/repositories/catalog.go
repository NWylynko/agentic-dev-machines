package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

type catalogServer struct {
	config    Config
	ctx       context.Context
	cancel    context.CancelFunc
	server    *fuse.Server
	lock      *os.File
	mu        sync.Mutex
	acquireMu sync.Mutex
	repos     map[string]*repositoryRuntime
	daemon    *artifactDaemon
	closed    bool
	closeOnce sync.Once
	failures  chan error
}

type repositoryRuntime struct {
	mu     sync.Mutex
	repo   Repository
	server *catalogServer
	path   string
}

type artifactDaemon struct {
	command *exec.Cmd
	done    chan struct{}
	err     error
	ctx     context.Context
	cancel  context.CancelFunc
}

type catalogDirectory struct {
	fs.Inode
	server       *catalogServer
	owner        string
	owners       map[string][]Repository
	repositories map[string]Repository
}

func mountCatalog(parent context.Context, config Config, catalog Catalog) (*catalogServer, error) {
	if err := validateCatalog(catalog); err != nil {
		return nil, err
	}
	paths := []string{config.State, config.GitRoot, config.Views, config.Mount}
	for i, path := range paths {
		if !filepath.IsAbs(path) || filepath.Clean(path) == "/" {
			return nil, errors.New("state, git-root, views and mount must be explicit absolute directories")
		}
		for j, other := range paths {
			if i != j && (path == other || strings.HasPrefix(path, other+"/")) {
				return nil, errors.New("repository storage/mount roots must be separate sibling paths")
			}
		}
	}
	if config.GitWrapper != "" {
		info, err := os.Stat(config.GitWrapper)
		if err != nil {
			return nil, fmt.Errorf("Git privilege wrapper unavailable: %w", err)
		}
		stat := info.Sys().(*syscall.Stat_t)
		if stat.Uid != 0 || info.Mode().Perm()&022 != 0 {
			return nil, errors.New("Git wrapper must be image-owned by root and not group/world writable")
		}
	}
	for _, path := range paths {
		mode := os.FileMode(0700)
		if path == config.GitRoot || path == config.Mount {
			mode = 0755
		}
		if err := os.MkdirAll(path, mode); err != nil {
			return nil, err
		}
		if err := os.Chmod(path, mode); err != nil {
			return nil, err
		}
	}
	lock, err := os.OpenFile(filepath.Join(config.State, "owner.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("repository store already has an owner: %w", err)
	}
	ctx, cancel := context.WithCancel(parent)
	host := &catalogServer{config: config, ctx: ctx, cancel: cancel, lock: lock, repos: map[string]*repositoryRuntime{}, failures: make(chan error, 1)}
	root := &catalogDirectory{server: host, owners: map[string][]Repository{}}
	for _, repo := range catalog.Repositories {
		root.owners[repo.Owner] = append(root.owners[repo.Owner], repo)
	}
	zero := time.Duration(0)
	host.server, err = fs.Mount(config.Mount, root, &fs.Options{UID: config.UID, GID: config.GID, EntryTimeout: &zero, AttrTimeout: &zero, MountOptions: fuse.MountOptions{FsName: "adm-repositories", Name: "adm-repositories", AllowOther: false, DisableXAttrs: true}})
	if err != nil {
		cancel()
		lock.Close()
		return nil, fmt.Errorf("mount repository catalog (FUSE required; no eager-clone fallback): %w", err)
	}
	return host, nil
}

func (server *catalogServer) Close() error {
	var result error
	server.closeOnce.Do(func() {
		server.mu.Lock()
		server.closed = true
		server.mu.Unlock()
		// Release the exported view before stopping its backing filesystems.
		if err := server.server.Unmount(); err != nil {
			result = err
		}
		server.cancel()
		server.acquireMu.Lock()
		if daemon := server.daemon; daemon != nil {
			select {
			case <-daemon.done:
			default:
				if err := daemon.command.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
					result = errors.Join(result, err)
				}
				<-daemon.done
			}
		}
		server.acquireMu.Unlock()
		if err := server.lock.Close(); err != nil {
			result = errors.Join(result, err)
		}
	})
	return result
}

func (node *catalogDirectory) Getattr(_ context.Context, _ fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = syscall.S_IFDIR | 0555
	out.Uid = node.server.config.UID
	out.Gid = node.server.config.GID
	return 0
}

func (node *catalogDirectory) Readdir(_ context.Context) (fs.DirStream, syscall.Errno) {
	entries := []fuse.DirEntry{}
	if node.owner == "" {
		for owner := range node.owners {
			entries = append(entries, fuse.DirEntry{Name: owner, Mode: syscall.S_IFDIR})
		}
	} else {
		for name := range node.repositories {
			entries = append(entries, fuse.DirEntry{Name: name, Mode: syscall.S_IFDIR})
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return fs.NewListDirStream(entries), 0
}

func (node *catalogDirectory) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if node.owner == "" {
		repos, exists := node.owners[name]
		if !exists {
			return nil, syscall.ENOENT
		}
		child := &catalogDirectory{server: node.server, owner: name, repositories: map[string]Repository{}}
		for _, repo := range repos {
			child.repositories[repo.Name] = repo
		}
		out.Mode = syscall.S_IFDIR | 0555
		out.Uid = node.server.config.UID
		out.Gid = node.server.config.GID
		return node.NewInode(ctx, child, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: stableInodeNumber("catalog-owner:"+name, nil)}), 0
	}
	repo, exists := node.repositories[name]
	if !exists {
		return nil, syscall.ENOENT
	}
	// The name is visible before any Git data exists. Acquisition starts from
	// the first operation that needs the working tree, not from this lookup.
	out.Mode = syscall.S_IFDIR | 0755
	out.Uid = node.server.config.UID
	out.Gid = node.server.config.GID
	return node.NewInode(ctx, &repositoryView{server: node.server, repo: repo}, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: stableInodeNumber("catalog-repository:"+repo.Owner+"/"+repo.Name, nil)}), 0
}

// repositoryView is the catalog entry for one repository. Listing it does not
// clone; the private checkout is created when a caller reads or writes inside.
type repositoryView struct {
	fs.LoopbackNode
	server *catalogServer
	repo   Repository
	mu     sync.Mutex
	ready  bool
}

type repositoryLoopbackNode struct {
	fs.LoopbackNode
}

func (node *repositoryLoopbackNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return lookupRepositoryChild(ctx, node, node.RootData, name, out)
}

func (node *repositoryLoopbackNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	root := node.RootData.RootNode.EmbeddedInode()
	relativePath := node.Path(root)
	baseFD, err := unix.Open(node.RootData.Path, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, 0, fs.ToErrno(err)
	}
	defer unix.Close(baseFD)
	flags &^= syscall.O_APPEND
	fd, err := unix.Openat2(baseFD, relativePath, &unix.OpenHow{
		Flags:   uint64(flags) | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_NO_SYMLINKS,
	})
	if err != nil {
		path := filepath.Join(node.RootData.Path, relativePath)
		slog.Error("repository file open failed", "path", path, "relativePath", relativePath, "flags", fmt.Sprintf("%#x", flags), "inode", node.EmbeddedInode().StableAttr().Ino, "errno", fs.ToErrno(err))
		return nil, 0, fs.ToErrno(err)
	}
	return fs.NewLoopbackFile(fd), 0, 0
}

func lookupRepositoryChild(ctx context.Context, parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	parentInode := parent.EmbeddedInode()
	rootInode := root.RootNode.EmbeddedInode()
	path := filepath.Join(root.Path, parentInode.Path(rootInode), name)
	var stat syscall.Stat_t
	if err := syscall.Lstat(path, &stat); err != nil {
		return nil, fs.ToErrno(err)
	}
	out.Attr.FromStat(&stat)
	var child fs.InodeEmbedder = &fs.LoopbackNode{RootData: root}
	if root.NewNode != nil {
		child = root.NewNode(root, parentInode, name, &stat)
	}
	stable := fs.StableAttr{
		Mode: uint32(stat.Mode) & syscall.S_IFMT,
		Ino:  stableInodeNumber("backing:"+path, &stat),
	}
	return parentInode.NewInode(ctx, child, stable), 0
}

func stableInodeNumber(identity string, backing *syscall.Stat_t) uint64 {
	hash := sha256.New()
	_, _ = hash.Write([]byte(identity))
	if backing != nil {
		var statIdentity [16]byte
		binary.LittleEndian.PutUint64(statIdentity[:8], backing.Dev)
		binary.LittleEndian.PutUint64(statIdentity[8:], backing.Ino)
		_, _ = hash.Write(statIdentity[:])
	}
	var digest [32]byte
	copy(digest[:], hash.Sum(nil))
	// go-fuse allocates automatic IDs from the high-bit namespace. Keeping
	// stable path-derived IDs below that range avoids recycled ArtifactFS IDs.
	inode := binary.LittleEndian.Uint64(digest[:8]) &^ (uint64(1) << 63)
	if inode == 0 {
		return 1
	}
	return inode
}

func (node *repositoryView) activate(ctx context.Context) syscall.Errno {
	node.mu.Lock()
	defer node.mu.Unlock()
	if node.ready {
		return 0
	}
	path, err := node.server.acquire(node.repo)
	if err != nil {
		slog.Error("repository acquisition failed", "repository", node.repo.Owner+"/"+node.repo.Name, "error", err)
		return syscall.EIO
	}
	// Keep each backing device in the stable inode id. ArtifactFS mounts reuse
	// low inode numbers, and a shared root device would alias separate repos.
	node.RootData = &fs.LoopbackRoot{
		Path:     path,
		Dev:      0,
		RootNode: node,
		NewNode: func(root *fs.LoopbackRoot, _ *fs.Inode, _ string, _ *syscall.Stat_t) fs.InodeEmbedder {
			return &repositoryLoopbackNode{LoopbackNode: fs.LoopbackNode{RootData: root}}
		},
	}
	node.ready = true
	return 0
}

func (node *repositoryView) Getattr(ctx context.Context, handle fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	node.mu.Lock()
	ready := node.ready
	node.mu.Unlock()
	if !ready {
		out.Mode = syscall.S_IFDIR | 0755
		out.Uid = node.server.config.UID
		out.Gid = node.server.config.GID
		return 0
	}
	return node.LoopbackNode.Getattr(ctx, handle, out)
}

func (node *repositoryView) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return lookupRepositoryChild(ctx, node, node.RootData, name, out)
}

func (node *repositoryView) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return node.LoopbackNode.Readdir(ctx)
}

func (node *repositoryView) OpendirHandle(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, 0, errno
	}
	return node.LoopbackNode.OpendirHandle(ctx, flags)
}

func (node *repositoryView) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, 0, errno
	}
	return node.LoopbackNode.Open(ctx, flags)
}

func (node *repositoryView) Create(ctx context.Context, name string, flags uint32, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, nil, 0, errno
	}
	return node.LoopbackNode.Create(ctx, name, flags, mode, out)
}

func (node *repositoryView) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return node.LoopbackNode.Mkdir(ctx, name, mode, out)
}

func (node *repositoryView) Mknod(ctx context.Context, name string, mode, rdev uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return node.LoopbackNode.Mknod(ctx, name, mode, rdev, out)
}

func (node *repositoryView) Unlink(ctx context.Context, name string) syscall.Errno {
	if errno := node.activate(ctx); errno != 0 {
		return errno
	}
	return node.LoopbackNode.Unlink(ctx, name)
}

func (node *repositoryView) Rmdir(ctx context.Context, name string) syscall.Errno {
	if errno := node.activate(ctx); errno != 0 {
		return errno
	}
	return node.LoopbackNode.Rmdir(ctx, name)
}

func (node *repositoryView) Rename(ctx context.Context, name string, newParent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	if errno := node.activate(ctx); errno != 0 {
		return errno
	}
	return node.LoopbackNode.Rename(ctx, name, newParent, newName, flags)
}

func (node *repositoryView) Symlink(ctx context.Context, target, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return node.LoopbackNode.Symlink(ctx, target, name, out)
}

func (node *repositoryView) Link(ctx context.Context, target fs.InodeEmbedder, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return node.LoopbackNode.Link(ctx, target, name, out)
}

func (node *repositoryView) Setattr(ctx context.Context, handle fs.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	if errno := node.activate(ctx); errno != 0 {
		return errno
	}
	return node.LoopbackNode.Setattr(ctx, handle, in, out)
}

func (server *catalogServer) acquire(repo Repository) (string, error) {
	// ArtifactFS runs one daemon per workspace state/view root. Its daemon
	// watches the shared registry and mounts every registered repository.
	// Serializing acquisition prevents concurrent repo registrations from
	// starting competing daemons against the same SQLite state and FUSE mounts.
	server.acquireMu.Lock()
	defer server.acquireMu.Unlock()

	key := repo.Owner + "/" + repo.Name
	server.mu.Lock()
	if server.closed {
		server.mu.Unlock()
		return "", errors.New("repository workspace is closing")
	}
	runtime := server.repos[key]
	if runtime == nil {
		runtime = &repositoryRuntime{repo: repo, server: server}
		server.repos[key] = runtime
	}
	server.mu.Unlock()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	// path is set only after the view is mounted. A failed attempt leaves it
	// empty so the same repository can be acquired again.
	if runtime.path != "" {
		return runtime.path, nil
	}
	config := server.config
	state := filepath.Join(config.State, repo.Owner, repo.Name)
	gitDir := filepath.Join(config.GitRoot, repo.Owner, repo.Name)
	viewRoot := filepath.Join(config.Views, repo.Owner)
	view := filepath.Join(viewRoot, repo.Name)
	if err := os.MkdirAll(state, 0700); err != nil {
		return "", err
	}
	if err := os.MkdirAll(viewRoot, 0700); err != nil {
		return "", err
	}
	// A deadline bounds actual acquisition; filesystem readiness is driven by
	// kernel mount notifications, never by arbitrary startup sleeps.
	ctx, cancel := context.WithTimeout(server.ctx, 2*time.Minute)
	defer cancel()
	gitExecutable := "git"
	if config.GitWrapper != "" {
		gitExecutable = config.GitWrapper
	}
	gitCommand := func(args ...string) *exec.Cmd {
		command := exec.CommandContext(ctx, gitExecutable, args...)
		command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		return command
	}
	if repo.UpstreamGitDir != "" {
		var stat unix.Statfs_t
		if err := unix.Statfs(repo.UpstreamGitDir, &stat); err != nil {
			return "", fmt.Errorf("published upstream base unavailable: %w", err)
		}
		if stat.Flags&unix.ST_RDONLY == 0 {
			return "", errors.New("upstreamGitDir must be on an explicitly read-only mount; a writable shared cache could leak unpublished work")
		}
		if bytes, err := gitCommand("--git-dir", repo.UpstreamGitDir, "rev-parse", "--is-bare-repository").Output(); err != nil || strings.TrimSpace(string(bytes)) != "true" {
			return "", errors.New("upstreamGitDir must be a published bare Git repository")
		}
	}
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(gitDir), 0755); err != nil {
			return "", err
		}
		acquisition, err := os.MkdirTemp(filepath.Dir(gitDir), ".acquire-")
		if err != nil {
			return "", err
		}
		defer os.RemoveAll(acquisition)
		privateGit := filepath.Join(acquisition, "git")
		work := filepath.Join(acquisition, "checkout")
		args := []string{"clone", "--filter=blob:none", "--no-checkout", "--single-branch", "--no-tags", "--branch", strings.TrimPrefix(repo.Ref, "refs/heads/"), "--separate-git-dir", privateGit}
		if repo.UpstreamGitDir != "" {
			args = append(args, "--reference", repo.UpstreamGitDir)
		}
		args = append(args, "--", repo.Remote, work)
		output, err := gitCommand(args...).CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("lazy Git acquisition failed for %s (configure a scoped credential helper for private repositories): %w: %s", key, err, output)
		}
		if strings.Contains(string(output), "filtering not recognized by server") {
			return "", errors.New("upstream does not support partial-clone filtering; refusing an eager clone")
		}
		if output, err := gitCommand("--git-dir", privateGit, "read-tree", "HEAD").CombinedOutput(); err != nil {
			return "", fmt.Errorf("initialize private Git index: %w: %s", err, output)
		}
		// Publish only a complete filtered checkout. A failed or rejected clone
		// must never become an apparently valid baseline on the next open.
		if err := os.Rename(privateGit, gitDir); err != nil {
			return "", fmt.Errorf("publish private Git baseline: %w", err)
		}
	} else if err != nil {
		return "", err
	}
	// The durable source identity prevents a modified catalog from silently
	// retargeting existing work. New source revisions need normal Git commands.
	identity := filepath.Join(state, "source.json")
	expected, _ := json.Marshal(repo)
	if bytes, err := os.ReadFile(identity); err == nil {
		if string(bytes) != string(expected) {
			return "", errors.New("catalog source changed for an existing private checkout; use a new workspace or explicit Git operations")
		}
	} else if os.IsNotExist(err) {
		if err := os.WriteFile(identity, expected, 0600); err != nil {
			return "", err
		}
	} else {
		return "", err
	}
	env := append(os.Environ(), "ARTIFACT_FS_ROOT="+state, "GIT_TERMINAL_PROMPT=0")
	if config.GitWrapper != "" {
		env = append(env, "PATH="+filepath.Dir(config.GitWrapper)+":"+os.Getenv("PATH"))
	}
	// Subscribe before registering a repository: an already-running daemon can
	// notice the new registry entry and mount it before add-repo returns.
	mounts, err := openMountNotifications()
	if err != nil {
		return "", err
	}
	defer mounts.Close()
	previousMountID, err := fuseMountID(view)
	if err != nil {
		return "", fmt.Errorf("inspect existing ArtifactFS mount: %w", err)
	}
	marker := filepath.Join(state, "registered")
	if _, err := os.Stat(marker); os.IsNotExist(err) {
		command := exec.CommandContext(ctx, config.Artifact, "add-repo", "--name", repo.Name, "--remote", repo.Remote, "--ref", repo.Ref, "--mount-root", viewRoot, "--git-dir", gitDir, "--refresh", "never")
		command.Env = env
		output, err := command.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("ArtifactFS preparation failed: %w: %s", err, output)
		}
		if err = os.WriteFile(marker, []byte("1\n"), 0600); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	daemon, err := server.ensureArtifactDaemon(env, key)
	if err != nil {
		return "", err
	}
	if err := waitMounted(ctx, daemon.ctx, mounts, view, previousMountID); err != nil {
		return "", fmt.Errorf("ArtifactFS mount unavailable: %w", err)
	}
	runtime.path = view
	slog.Info("repository ready", "repository", key, "gitDir", gitDir, "view", view, "sharedBase", repo.UpstreamGitDir != "")
	return view, nil
}

func (server *catalogServer) ensureArtifactDaemon(env []string, key string) (*artifactDaemon, error) {
	if daemon := server.daemon; daemon != nil {
		select {
		case <-daemon.done:
			return nil, fmt.Errorf("ArtifactFS daemon exited for %s: %w", key, daemon.err)
		default:
			return daemon, nil
		}
	}
	ctx, cancel := context.WithCancel(server.ctx)
	command := exec.Command(server.config.Artifact, "daemon", "--root", server.config.Views)
	command.Env = env
	stderr, err := command.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := command.Start(); err != nil {
		cancel()
		return nil, err
	}
	daemon := &artifactDaemon{command: command, done: make(chan struct{}), ctx: ctx, cancel: cancel}
	server.daemon = daemon
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			slog.Info("artifact-fs", "repository", key, "diagnostic", scanner.Text())
		}
	}()
	go func() {
		daemon.err = command.Wait()
		close(daemon.done)
		daemon.cancel()
		server.mu.Lock()
		closing := server.closed
		server.mu.Unlock()
		if !closing {
			select {
			case server.failures <- fmt.Errorf("ArtifactFS exited for %s: %w", key, daemon.err):
			default:
			}
		}
	}()
	return daemon, nil
}

func openMountNotifications() (*os.File, error) {
	// os.Open registers this pollable proc file with Go's runtime epoll loop.
	// Linux mounts_poll consumes its notification cursor on every poll call,
	// so the runtime could steal the event before our explicit Poll sees it.
	fd, err := unix.Open("/proc/self/mounts", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), "/proc/self/mounts"), nil
}

func fuseMountID(path string) (uint64, error) {
	var filesystem unix.Statfs_t
	if err := unix.Statfs(path, &filesystem); err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) {
			return 0, nil
		}
		return 0, err
	}
	if filesystem.Type != unix.FUSE_SUPER_MAGIC {
		return 0, nil
	}
	var mount unix.Statx_t
	// STATX_MNT_ID can be reused quickly after unmount. The unique form is
	// needed here because remount readiness must distinguish a replacement
	// daemon from a dead-but-still-visible FUSE mount.
	const statxMntIDUnique = 0x4000
	if err := unix.Statx(unix.AT_FDCWD, path, 0, statxMntIDUnique, &mount); err != nil {
		return 0, err
	}
	if mount.Mask&statxMntIDUnique == 0 || mount.Mnt_id == 0 {
		return 0, errors.New("kernel did not report a unique FUSE mount identity")
	}
	return mount.Mnt_id, nil
}

func waitMounted(ctx, daemon context.Context, mounts *os.File, path string, previousMountID uint64) error {
	pipe, err := unix.Eventfd(0, unix.EFD_CLOEXEC)
	if err != nil {
		return err
	}
	defer unix.Close(pipe)
	watch, stop := context.WithCancel(ctx)
	defer stop()
	callback := context.AfterFunc(daemon, stop)
	defer callback()
	joined := make(chan struct{})
	go func() { <-watch.Done(); _, _ = unix.Write(pipe, []byte{1, 0, 0, 0, 0, 0, 0, 0}); close(joined) }()
	defer func() { stop(); <-joined }()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if previousMountID == 0 {
			var filesystem unix.Statfs_t
			if err := unix.Statfs(path, &filesystem); err == nil && filesystem.Type == unix.FUSE_SUPER_MAGIC {
				return nil
			}
		} else {
			mountID, err := fuseMountID(path)
			if err != nil {
				return err
			}
			if mountID != 0 && mountID != previousMountID {
				return nil
			}
		}
		fds := []unix.PollFd{{Fd: int32(mounts.Fd()), Events: unix.POLLPRI | unix.POLLERR}, {Fd: int32(pipe), Events: unix.POLLIN}}
		_, err = unix.Poll(fds, -1)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return err
		}
		if fds[1].Revents != 0 {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.New("ArtifactFS exited before publishing its mount")
		}
	}
}
