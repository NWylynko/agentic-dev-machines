package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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
	// One ArtifactFS daemon per opened repository. Each repository keeps its
	// own ArtifactFS root (state/OWNER/REPO), and a daemon only watches the
	// registry under its own root, so a shared daemon never mounted a second
	// repository.
	daemons   map[string]*artifactDaemon
	closed    bool
	closeOnce sync.Once
	failures  chan error
	// source answers "which repositories are in /repos right now". It is read
	// on every listing of the root and owner directories, so a repository
	// registered later appears without restarting the sidecar (TASK-112).
	source func(context.Context) (Catalog, error)
	// views holds the one root node of each repository for the life of the
	// mount. Every node inside a repository resolves its path from that root,
	// so the root must never be replaced: when the kernel forgot the root
	// before its folders (go-fuse handles FORGETs concurrently), a fresh root
	// left every folder resolving to go-fuse's orphan placeholder, and all of
	// them answered ENOENT until the kernel evicted them (TASK-125).
	views map[string]*repositoryView
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
	server *catalogServer
	owner  string
}

// mountCatalog serves a fixed catalog (development and tests).
func mountCatalog(parent context.Context, config Config, catalog Catalog) (*catalogServer, error) {
	if err := validateCatalog(catalog); err != nil {
		return nil, err
	}
	return mountSource(parent, config, func(context.Context) (Catalog, error) { return catalog, nil })
}

// mountRegistry serves the cluster repository registry kept by the lifecycle
// controller, fetched with the Pod identity each time /repos is listed.
func mountRegistry(parent context.Context, config Config) (*catalogServer, error) {
	if config.LifecycleURL == "" {
		return nil, errors.New("the repository registry needs --lifecycle-url (ADM_LIFECYCLE_URL)")
	}
	return mountSource(parent, config, func(ctx context.Context) (Catalog, error) {
		value, err := lifecycleRequest(ctx, config.LifecycleURL, config.TokenFile, "GET", "/v1/runtime/repos/registry")
		if err != nil {
			return Catalog{}, fmt.Errorf("cannot read the repository registry: %w", err)
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return Catalog{}, err
		}
		var catalog Catalog
		if err := json.Unmarshal(encoded, &catalog); err != nil {
			return Catalog{}, fmt.Errorf("invalid repository registry: %w", err)
		}
		return catalog, validateCatalog(catalog)
	})
}

func mountSource(parent context.Context, config Config, source func(context.Context) (Catalog, error)) (*catalogServer, error) {
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
	host := &catalogServer{config: config, ctx: ctx, cancel: cancel, lock: lock, repos: map[string]*repositoryRuntime{}, views: map[string]*repositoryView{}, daemons: map[string]*artifactDaemon{}, failures: make(chan error, 1), source: source}
	root := &catalogDirectory{server: host}
	host.server, err = fs.Mount(config.Mount, root, catalogFilesystemOptions(config))
	if err != nil {
		cancel()
		lock.Close()
		return nil, fmt.Errorf("mount repository catalog (FUSE required; no eager-clone fallback): %w", err)
	}
	return host, nil
}

func catalogFilesystemOptions(config Config) *fs.Options {
	zero := time.Duration(0)
	return &fs.Options{UID: config.UID, GID: config.GID, EntryTimeout: &zero, AttrTimeout: &zero, Logger: log.New(goFuseWarnings{}, "", 0), MountOptions: fuse.MountOptions{FsName: "adm-repositories", Name: "adm-repositories", AllowOther: false, DisableXAttrs: true}}
}

// goFuseWarnings puts go-fuse's warnings in the sidecar log. An orphaned node
// ("Inode.Path: nN is orphaned") answers ENOENT with no other trace, so these
// must be seen. go-fuse also warns on every getattr that it replaced the
// backing inode number with the catalog's stable one, which is expected here
// and would bury everything else, so that one is dropped.
type goFuseWarnings struct{}

func (goFuseWarnings) Write(line []byte) (int, error) {
	text := strings.TrimSpace(string(line))
	if !strings.Contains(text, "rawBridge.getattr: overriding ino") {
		slog.Error("go-fuse", "warning", text)
	}
	return len(line), nil
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
		for _, daemon := range server.daemons {
			select {
			case <-daemon.done:
			default:
				if err := daemon.command.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
					result = errors.Join(result, err)
				}
			}
		}
		for _, daemon := range server.daemons {
			<-daemon.done
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

// owners reads the current catalog grouped by owner. A failure is logged and
// reported as an I/O error: a stale or empty /repos would hide the cause.
//
// The fetch runs on the server's context, not the FUSE request's: the kernel
// cancels a request whenever its caller gets a signal, and Go programs (go vet,
// gopls) are signalled constantly by their own runtime, so a request context
// turned ordinary lookups into EIO ("context canceled", TASK-125).
func (server *catalogServer) owners() (map[string][]Repository, syscall.Errno) {
	catalog, err := server.source(server.ctx)
	if err != nil {
		slog.Error("repository catalog unavailable", "error", err)
		return nil, syscall.EIO
	}
	owners := map[string][]Repository{}
	for _, repo := range catalog.Repositories {
		owners[repo.Owner] = append(owners[repo.Owner], repo)
	}
	return owners, 0
}

// openedRepository is the repository's view if this workspace has already
// opened it. An opened repository is local work, so finding it again needs no
// registry: a lifecycle restart must not make every file in it fail (TASK-125).
func (server *catalogServer) openedRepository(owner, name string) *repositoryView {
	server.mu.Lock()
	view := server.views[owner+"/"+name]
	server.mu.Unlock()
	if view == nil {
		return nil
	}
	view.mu.Lock()
	defer view.mu.Unlock()
	if !view.ready {
		return nil
	}
	return view
}

func (server *catalogServer) hasOpenedRepositoryOf(owner string) bool {
	server.mu.Lock()
	var candidates []*repositoryView
	for _, view := range server.views {
		if view.repo.Owner == owner {
			candidates = append(candidates, view)
		}
	}
	server.mu.Unlock()
	for _, view := range candidates {
		if server.openedRepository(view.repo.Owner, view.repo.Name) != nil {
			return true
		}
	}
	return false
}

func (node *catalogDirectory) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	owners, errno := node.server.owners()
	if errno != 0 {
		return nil, errno
	}
	entries := []fuse.DirEntry{}
	if node.owner == "" {
		for owner := range owners {
			entries = append(entries, fuse.DirEntry{Name: owner, Mode: syscall.S_IFDIR})
		}
	} else {
		for _, repo := range owners[node.owner] {
			entries = append(entries, fuse.DirEntry{Name: repo.Name, Mode: syscall.S_IFDIR})
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return fs.NewListDirStream(entries), 0
}

func (node *catalogDirectory) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	out.Uid = node.server.config.UID
	out.Gid = node.server.config.GID
	if node.owner == "" {
		if !node.server.hasOpenedRepositoryOf(name) {
			owners, errno := node.server.owners()
			if errno != 0 {
				return nil, errno
			}
			if _, exists := owners[name]; !exists {
				return nil, syscall.ENOENT
			}
		}
		out.Mode = syscall.S_IFDIR | 0555
		return node.NewInode(ctx, &catalogDirectory{server: node.server, owner: name}, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: stableInodeNumber("catalog-owner:" + name)}), 0
	}
	view := node.server.openedRepository(node.owner, name)
	if view == nil {
		owners, errno := node.server.owners()
		if errno != 0 {
			return nil, errno
		}
		for _, repo := range owners[node.owner] {
			if repo.Name == name {
				view = node.server.repositoryView(repo)
			}
		}
	}
	if view == nil {
		return nil, syscall.ENOENT
	}
	// The name is visible before any Git data exists. Acquisition starts from
	// the first operation that needs the working tree, not from this lookup.
	out.Mode = syscall.S_IFDIR | 0755
	return node.NewInode(ctx, view, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: stableInodeNumber("catalog-repository:" + node.owner + "/" + name)}), 0
}

func (server *catalogServer) repositoryView(repo Repository) *repositoryView {
	server.mu.Lock()
	defer server.mu.Unlock()
	key := repo.Owner + "/" + repo.Name
	view := server.views[key]
	if view == nil {
		view = &repositoryView{server: server, repo: repo}
		server.views[key] = view
	}
	return view
}

// repositoryView is the catalog entry for one repository. Listing it does not
// clone; the private checkout is created when a caller reads or writes inside.
type repositoryView struct {
	fs.LoopbackNode
	server *catalogServer
	repo   Repository
	mu     sync.Mutex
	ready  bool
	// local is the node-local root for paths git ignores, and ignore decides
	// which those are (TASK-81). Both nil without Config.Ignored.
	local  *fs.LoopbackRoot
	ignore *ignoredPaths
}

type repositoryLoopbackNode struct {
	fs.LoopbackNode
}

// replaced reports whether this node has lost its path: its file or folder
// was renamed over or removed while the kernel still held the node, so an
// operation already on its way can arrive. Every path-based operation answers
// such a node with ESTALE, which makes the kernel walk the path again and
// reach whatever is there now, as it does for NFS (open, stat, truncate,
// unlink, mkdir and the rest retry once with revalidation). ENOENT failed the
// caller instead, e.g. "printf > f" while another process saved f (TASK-125).
// Operations on an open file handle use its descriptor and never ask.
func (node *repositoryLoopbackNode) replaced() bool {
	root := node.RootData.RootNode.EmbeddedInode()
	for current := node.EmbeddedInode(); current != root; {
		_, parent := current.Parent()
		if parent == nil {
			return true
		}
		current = parent
	}
	return false
}

func (node *repositoryLoopbackNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if node.replaced() {
		return nil, syscall.ESTALE
	}
	return lookupRepositoryChild(ctx, node, node.RootData, name, out)
}

func (node *repositoryLoopbackNode) Create(ctx context.Context, name string, flags uint32, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	if node.replaced() {
		return nil, nil, 0, syscall.ESTALE
	}
	return createRepositoryFile(ctx, node, node.RootData, name, flags, mode, out)
}

func (node *repositoryLoopbackNode) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if node.replaced() {
		return nil, syscall.ESTALE
	}
	return makeRepositoryDirectory(ctx, node, node.RootData, name, mode, out)
}

func (node *repositoryLoopbackNode) Symlink(ctx context.Context, target, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if node.replaced() {
		return nil, syscall.ESTALE
	}
	return makeRepositorySymlink(ctx, node, node.RootData, target, name, out)
}

func (node *repositoryLoopbackNode) Mknod(ctx context.Context, name string, mode, rdev uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if node.replaced() {
		return nil, syscall.ESTALE
	}
	return makeRepositoryNode(ctx, node, node.RootData, name, mode, rdev, out)
}

func (node *repositoryLoopbackNode) Link(ctx context.Context, target fs.InodeEmbedder, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if node.replaced() {
		return nil, syscall.ESTALE
	}
	return linkRepositoryEntry(ctx, node, node.RootData, target, name, out)
}

func (node *repositoryLoopbackNode) Unlink(ctx context.Context, name string) syscall.Errno {
	if node.replaced() {
		return syscall.ESTALE
	}
	return removeRepositoryEntry(node, node.RootData, name, false)
}

func (node *repositoryLoopbackNode) Rmdir(ctx context.Context, name string) syscall.Errno {
	if node.replaced() {
		return syscall.ESTALE
	}
	return removeRepositoryEntry(node, node.RootData, name, true)
}

func (node *repositoryLoopbackNode) Rename(ctx context.Context, name string, newParent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	if target, ok := newParent.(*repositoryLoopbackNode); node.replaced() || ok && target.replaced() {
		return syscall.ESTALE
	}
	return renameRepositoryEntry(node, node.RootData, name, newParent, newName, flags)
}

func (node *repositoryLoopbackNode) Readlink(ctx context.Context) ([]byte, syscall.Errno) {
	if node.replaced() {
		return nil, syscall.ESTALE
	}
	return node.LoopbackNode.Readlink(ctx)
}

func (node *repositoryLoopbackNode) OpendirHandle(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if node.replaced() {
		return nil, 0, syscall.ESTALE
	}
	return openRepositoryDirectory(node, node.RootData)
}

func (node *repositoryLoopbackNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	if node.replaced() {
		return nil, syscall.ESTALE
	}
	return node.LoopbackNode.Readdir(ctx)
}

func (node *repositoryLoopbackNode) Statfs(ctx context.Context, out *fuse.StatfsOut) syscall.Errno {
	if node.replaced() {
		return syscall.ESTALE
	}
	return node.LoopbackNode.Statfs(ctx, out)
}

func (node *repositoryLoopbackNode) Getattr(ctx context.Context, handle fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	if handle == nil && node.replaced() {
		return syscall.ESTALE
	}
	errno := node.LoopbackNode.Getattr(ctx, handle, out)
	if errno == 0 && isLocal(node.RootData) {
		out.SetTimeout(localCacheTimeout)
	}
	return errno
}

func (node *repositoryLoopbackNode) Statx(ctx context.Context, handle fs.FileHandle, flags uint32, mask uint32, out *fuse.StatxOut) syscall.Errno {
	if handle == nil && node.replaced() {
		return syscall.ESTALE
	}
	return node.LoopbackNode.Statx(ctx, handle, flags, mask, out)
}

func (node *repositoryLoopbackNode) Setattr(ctx context.Context, handle fs.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	if handle == nil && node.replaced() {
		return syscall.ESTALE
	}
	return node.LoopbackNode.Setattr(ctx, handle, in, out)
}

func (node *repositoryLoopbackNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if node.replaced() {
		return nil, 0, syscall.ESTALE
	}
	root := node.RootData.RootNode.EmbeddedInode()
	relativePath := node.Path(root)
	baseFD, err := unix.Open(node.RootData.Path, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, 0, fs.ToErrno(err)
	}
	defer unix.Close(baseFD)
	fd, err := unix.Openat2(baseFD, relativePath, &unix.OpenHow{
		Flags:   backingOpenHowFlags(flags),
		Resolve: unix.RESOLVE_NO_SYMLINKS,
	})
	if err != nil {
		path := filepath.Join(node.RootData.Path, relativePath)
		slog.Error("repository file open failed", "path", path, "relativePath", relativePath, "flags", fmt.Sprintf("%#x", flags), "inode", node.EmbeddedInode().StableAttr().Ino, "errno", fs.ToErrno(err))
		return nil, 0, fs.ToErrno(err)
	}
	return fs.NewLoopbackFile(fd), 0, 0
}

// backingOpenFlags are the open flags forwarded to openat2 for a backing
// file. FUSE passes on the kernel's file flags, which can carry internal bits
// such as __FMODE_EXEC (0x20, set when execve opens the file). open(2)
// ignores unknown bits, but openat2 rejects them with EINVAL, so every program
// run from /repos failed with "invalid argument" until only the flags openat2
// knows were kept. O_APPEND is left out, as go-fuse's loopback does, because
// FUSE writes already carry their offset.
const backingOpenFlags = unix.O_ACCMODE | unix.O_CREAT | unix.O_EXCL | unix.O_NOCTTY | unix.O_TRUNC |
	unix.O_NONBLOCK | unix.O_DSYNC | unix.O_SYNC | unix.O_ASYNC | unix.O_DIRECT | unix.O_LARGEFILE |
	unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_NOATIME | unix.O_PATH | unix.O_TMPFILE

func backingOpenHowFlags(flags uint32) uint64 {
	return uint64(flags)&backingOpenFlags | unix.O_CLOEXEC
}

func lookupRepositoryChild(ctx context.Context, parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	root = residence(parent, root, name)
	path := repositoryChildPath(parent, root, name)
	var stat syscall.Stat_t
	if err := syscall.Lstat(path, &stat); err != nil {
		return nil, fs.ToErrno(err)
	}
	out.Attr.FromStat(&stat)
	cacheLocalEntry(root, out)
	// The node already under this name is the one the kernel and every
	// in-flight operation hold. go-fuse moves nodes on rename, so a renamed
	// file keeps its node under the new name; handing out a different node for
	// the same name would orphan the held one (TASK-125).
	if existing := parent.EmbeddedInode().GetChild(name); existing != nil && existing.StableAttr().Mode == uint32(stat.Mode)&syscall.S_IFMT {
		if node, ok := existing.Operations().(*repositoryLoopbackNode); !ok || node.RootData == root {
			return existing, 0
		}
	}
	return repositoryChildInode(ctx, parent, root, path, &stat), 0
}

func repositoryChildPath(parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string) string {
	return filepath.Join(root.Path, parent.EmbeddedInode().Path(root.RootNode.EmbeddedInode()), name)
}

// repositoryChildInode makes the node for a backing path that has none under
// its parent yet. Inside a repository go-fuse's tree is the identity: a lookup
// returns the node already under the name (lookupRepositoryChild), so a node
// number only has to be unique, and go-fuse's automatic numbers are. Numbers
// derived from the path or from ArtifactFS clashed: a renamed file kept its old
// path's number, ArtifactFS reissues inode numbers whenever it forgets a path,
// and go-fuse hands an existing node to any lookup with a matching number, so
// one name got several nodes or two names shared one, orphaning whichever the
// kernel still held (TASK-125). Created entries use this too, never go-fuse's
// loopback numbering.
func repositoryChildInode(ctx context.Context, parent fs.InodeEmbedder, root *fs.LoopbackRoot, path string, stat *syscall.Stat_t) *fs.Inode {
	child := root.NewNode(root, parent.EmbeddedInode(), filepath.Base(path), stat)
	return parent.EmbeddedInode().NewInode(ctx, child, fs.StableAttr{Mode: uint32(stat.Mode) & syscall.S_IFMT})
}

// createRepositoryFile, makeRepositoryDirectory and makeRepositorySymlink are
// go-fuse's loopback Create, Mkdir and Symlink with the catalog's node
// identity. ArtifactFS refuses hard links and mknod before any node exists,
// so Link and Mknod keep go-fuse's.
func createRepositoryFile(ctx context.Context, parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string, flags, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	root, errno := placement(parent, root, name, false)
	if errno != 0 {
		return nil, nil, 0, errno
	}
	path := repositoryChildPath(parent, root, name)
	fd, err := syscall.Open(path, int(flags&^syscall.O_APPEND)|os.O_CREATE, mode)
	if err != nil {
		return nil, nil, 0, fs.ToErrno(err)
	}
	preserveCallerOwnership(ctx, path)
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		syscall.Close(fd)
		return nil, nil, 0, fs.ToErrno(err)
	}
	out.FromStat(&stat)
	cacheLocalEntry(root, out)
	return repositoryChildInode(ctx, parent, root, path, &stat), fs.NewLoopbackFile(fd), 0, 0
}

func makeRepositoryDirectory(ctx context.Context, parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	root, errno := placement(parent, root, name, true)
	if errno != 0 {
		return nil, errno
	}
	path := repositoryChildPath(parent, root, name)
	if err := os.Mkdir(path, os.FileMode(mode)); err != nil {
		return nil, fs.ToErrno(err)
	}
	preserveCallerOwnership(ctx, path)
	var stat syscall.Stat_t
	if err := syscall.Lstat(path, &stat); err != nil {
		syscall.Rmdir(path)
		return nil, fs.ToErrno(err)
	}
	out.Attr.FromStat(&stat)
	cacheLocalEntry(root, out)
	return repositoryChildInode(ctx, parent, root, path, &stat), 0
}

func makeRepositorySymlink(ctx context.Context, parent fs.InodeEmbedder, root *fs.LoopbackRoot, target, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	root, errno := placement(parent, root, name, false)
	if errno != 0 {
		return nil, errno
	}
	path := repositoryChildPath(parent, root, name)
	if err := syscall.Symlink(target, path); err != nil {
		return nil, fs.ToErrno(err)
	}
	preserveCallerOwnership(ctx, path)
	var stat syscall.Stat_t
	if err := syscall.Lstat(path, &stat); err != nil {
		syscall.Unlink(path)
		return nil, fs.ToErrno(err)
	}
	out.Attr.FromStat(&stat)
	cacheLocalEntry(root, out)
	return repositoryChildInode(ctx, parent, root, path, &stat), 0
}

func makeRepositoryNode(ctx context.Context, parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string, mode, rdev uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	root, errno := placement(parent, root, name, false)
	if errno != 0 {
		return nil, errno
	}
	path := repositoryChildPath(parent, root, name)
	if err := syscall.Mknod(path, mode, int(rdev)); err != nil {
		return nil, fs.ToErrno(err)
	}
	preserveCallerOwnership(ctx, path)
	var stat syscall.Stat_t
	if err := syscall.Lstat(path, &stat); err != nil {
		syscall.Unlink(path)
		return nil, fs.ToErrno(err)
	}
	out.Attr.FromStat(&stat)
	cacheLocalEntry(root, out)
	return repositoryChildInode(ctx, parent, root, path, &stat), 0
}

// linkRepositoryEntry hard-links within one root; ArtifactFS refuses hard
// links, and a link can't span the two roots.
func linkRepositoryEntry(ctx context.Context, parent fs.InodeEmbedder, root *fs.LoopbackRoot, target fs.InodeEmbedder, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	source, ok := target.(*repositoryLoopbackNode)
	if !ok {
		return nil, syscall.EXDEV
	}
	root, errno := placement(parent, root, name, false)
	if errno != 0 {
		return nil, errno
	}
	if source.RootData != root {
		return nil, syscall.EXDEV
	}
	path := repositoryChildPath(parent, root, name)
	if err := syscall.Link(filepath.Join(root.Path, source.EmbeddedInode().Path(root.RootNode.EmbeddedInode())), path); err != nil {
		return nil, fs.ToErrno(err)
	}
	var stat syscall.Stat_t
	if err := syscall.Lstat(path, &stat); err != nil {
		return nil, fs.ToErrno(err)
	}
	out.Attr.FromStat(&stat)
	cacheLocalEntry(root, out)
	return repositoryChildInode(ctx, parent, root, path, &stat), 0
}

// preserveCallerOwnership gives a new entry to the caller, as go-fuse's
// loopback does, when the sidecar runs as root.
func preserveCallerOwnership(ctx context.Context, path string) {
	if os.Getuid() != 0 {
		return
	}
	if caller, ok := fuse.FromContext(ctx); ok {
		_ = syscall.Lchown(path, int(caller.Uid), int(caller.Gid))
	}
}

// stableInodeNumber numbers the catalog's own folders (owners and repository
// roots), which are never renamed. go-fuse allocates automatic IDs from the
// high-bit namespace, so these stay below it.
func stableInodeNumber(identity string) uint64 {
	digest := sha256.Sum256([]byte(identity))
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
	newNode := func(root *fs.LoopbackRoot, _ *fs.Inode, _ string, _ *syscall.Stat_t) fs.InodeEmbedder {
		return &repositoryLoopbackNode{LoopbackNode: fs.LoopbackNode{RootData: root}}
	}
	if ignored := node.server.config.Ignored; ignored != "" {
		local := filepath.Join(ignored, node.repo.Owner, node.repo.Name)
		if err := os.MkdirAll(local, 0755); err != nil {
			slog.Error("node-local folder for ignored paths failed", "repository", node.repo.Owner+"/"+node.repo.Name, "path", local, "error", err)
			return syscall.EIO
		}
		node.local = &fs.LoopbackRoot{Path: local, RootNode: node, NewNode: newNode}
		node.ignore = &ignoredPaths{checkout: path, gitDir: filepath.Join(node.server.config.GitRoot, node.repo.Owner, node.repo.Name), patterns: map[string]ignoreFile{}}
	}
	node.RootData = &fs.LoopbackRoot{Path: path, Dev: 0, RootNode: node, NewNode: newNode}
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
	return openRepositoryDirectory(node, node.RootData)
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
	return createRepositoryFile(ctx, node, node.RootData, name, flags, mode, out)
}

func (node *repositoryView) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return makeRepositoryDirectory(ctx, node, node.RootData, name, mode, out)
}

func (node *repositoryView) Mknod(ctx context.Context, name string, mode, rdev uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return makeRepositoryNode(ctx, node, node.RootData, name, mode, rdev, out)
}

func (node *repositoryView) Unlink(ctx context.Context, name string) syscall.Errno {
	if errno := node.activate(ctx); errno != 0 {
		return errno
	}
	return removeRepositoryEntry(node, node.RootData, name, false)
}

func (node *repositoryView) Rmdir(ctx context.Context, name string) syscall.Errno {
	if errno := node.activate(ctx); errno != 0 {
		return errno
	}
	return removeRepositoryEntry(node, node.RootData, name, true)
}

func (node *repositoryView) Rename(ctx context.Context, name string, newParent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	if errno := node.activate(ctx); errno != 0 {
		return errno
	}
	return renameRepositoryEntry(node, node.RootData, name, newParent, newName, flags)
}

func (node *repositoryView) Symlink(ctx context.Context, target, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return makeRepositorySymlink(ctx, node, node.RootData, target, name, out)
}

func (node *repositoryView) Link(ctx context.Context, target fs.InodeEmbedder, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if errno := node.activate(ctx); errno != 0 {
		return nil, errno
	}
	return linkRepositoryEntry(ctx, node, node.RootData, target, name, out)
}

func (node *repositoryView) Setattr(ctx context.Context, handle fs.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	if errno := node.activate(ctx); errno != 0 {
		return errno
	}
	return node.LoopbackNode.Setattr(ctx, handle, in, out)
}

func (server *catalogServer) acquire(repo Repository) (string, error) {
	// Serializing acquisition keeps daemon startup and the mount-notification
	// wait for one repository from racing another's.
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
	gitEnv, err := config.gitEnvironment()
	if err != nil {
		return "", err
	}
	gitCommand := func(args ...string) *exec.Cmd {
		command := exec.CommandContext(ctx, gitExecutable, args...)
		command.Env = gitEnv
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
		// The clone below links to the shared base for good, so the lifecycle
		// must know this workspace uses it before it can ever delete the base.
		if repo.UpstreamGitDir != "" && config.LifecycleURL != "" {
			if _, err := lifecycleRequest(ctx, config.LifecycleURL, config.TokenFile, "POST", "/v1/runtime/repos/opened/"+key); err != nil {
				return "", fmt.Errorf("cannot record that this workspace uses the shared base of %s: %w", key, err)
			}
		}
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
			return "", fmt.Errorf("lazy Git acquisition failed for %s (private repositories need the cluster GitHub login: run adm repos login github): %w: %s", key, err, output)
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
	// The shared base is only where objects are stored, not which repository
	// this is, so a base that appears later does not change the identity.
	identity := filepath.Join(state, "source.json")
	source := repo
	source.UpstreamGitDir = ""
	expected, _ := json.Marshal(source)
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
	env, err := config.gitEnvironment("ARTIFACT_FS_ROOT=" + state)
	if err != nil {
		return "", err
	}
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
	if daemon := server.daemons[key]; daemon != nil {
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
	server.daemons[key] = daemon
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
