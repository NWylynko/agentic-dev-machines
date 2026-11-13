package main

// Paths git ignores in a /repos checkout live on node-local disk (TASK-81).
//
// Every write through the ArtifactFS layer crosses two FUSE daemons and lands
// on the replicated workspace volume: an npm install there took 55x as long as
// on plain disk. Ignored paths (node_modules, build output, .env, local
// databases) can be regenerated, so each repository gets a second backing
// root, Config.Ignored/OWNER/REPO, on an emptyDir, and the catalog serves an
// ignored path from it instead. That root mirrors the checkout's layout: an
// ignored path keeps its relative path there, and a folder that only exists to
// hold ignored paths (local/packages/x for packages/x/node_modules) is a
// container, shown through the ArtifactFS folder of the same name.
//
// Placement is decided when an entry is created: a new entry under a local
// folder is local; under an ArtifactFS folder it is local when git ignores it
// and it is not tracked. Existing files never move when .gitignore changes.
// Renames keep an entry where it is, except a local file renamed to a path git
// doesn't ignore (an editor's ignored temp file saved over a tracked one),
// which is copied into the ArtifactFS layer so it stays durable.

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-git/go-git/v5/plumbing/format/gitignore"
	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

// ignoredPaths answers whether git ignores a path in one checkout, reading
// .git/info/exclude and every .gitignore from the checkout's root down.
type ignoredPaths struct {
	checkout, gitDir string
	mu               sync.Mutex
	patterns         map[string]ignoreFile
	tracked          trackedPaths
}

type ignoreFile struct {
	modified int64
	size     int64
	patterns []gitignore.Pattern
}

type trackedPaths struct {
	modified int64
	size     int64
	paths    map[string]bool
}

// ignored reports whether git ignores relative path rel (slash-separated) and
// does not track it.
func (paths *ignoredPaths) ignored(rel string, isDir bool) bool {
	parts := strings.Split(rel, "/")
	var patterns []gitignore.Pattern
	patterns = append(patterns, paths.read(filepath.Join(paths.gitDir, "info", "exclude"), nil)...)
	for depth := range parts {
		patterns = append(patterns, paths.read(filepath.Join(paths.checkout, filepath.Join(parts[:depth]...), ".gitignore"), parts[:depth])...)
	}
	if !gitignore.NewMatcher(patterns).Match(parts, isDir) {
		return false
	}
	return !paths.isTracked(rel)
}

func (paths *ignoredPaths) read(file string, domain []string) []gitignore.Pattern {
	var stat unix.Stat_t
	if err := unix.Stat(file, &stat); err != nil {
		return nil
	}
	paths.mu.Lock()
	cached, ok := paths.patterns[file]
	paths.mu.Unlock()
	if ok && cached.modified == stat.Mtim.Nano() && cached.size == stat.Size {
		return cached.patterns
	}
	contents, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var patterns []gitignore.Pattern
	for _, line := range strings.Split(string(contents), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		patterns = append(patterns, gitignore.ParsePattern(line, slices.Clone(domain)))
	}
	paths.mu.Lock()
	paths.patterns[file] = ignoreFile{modified: stat.Mtim.Nano(), size: stat.Size, patterns: patterns}
	paths.mu.Unlock()
	return patterns
}

// isTracked reports whether rel is a tracked file or a folder holding one. The
// index is listed again only after it changes.
func (paths *ignoredPaths) isTracked(rel string) bool {
	var stat unix.Stat_t
	index := filepath.Join(paths.gitDir, "index")
	if err := unix.Stat(index, &stat); err != nil {
		return false
	}
	paths.mu.Lock()
	defer paths.mu.Unlock()
	if paths.tracked.paths == nil || paths.tracked.modified != stat.Mtim.Nano() || paths.tracked.size != stat.Size {
		listed, err := exec.Command("git", "--git-dir", paths.gitDir, "ls-files", "-z", "--cached").Output()
		if err != nil {
			// Unknown means durable: keep the path in the ArtifactFS layer.
			return true
		}
		tracked := map[string]bool{}
		for _, file := range bytes.Split(listed, []byte{0}) {
			for path := string(file); path != "" && path != "."; path = filepath.Dir(path) {
				tracked[path] = true
			}
		}
		paths.tracked = trackedPaths{modified: stat.Mtim.Nano(), size: stat.Size, paths: tracked}
	}
	return paths.tracked.paths[rel]
}

// repositoryRoots are the two backing roots of one checkout.
func repositoryRoots(root *fs.LoopbackRoot) (view *repositoryView, local *fs.LoopbackRoot) {
	view = root.RootNode.(*repositoryView)
	return view, view.local
}

// localCacheTimeout lets the kernel cache node-local entries and attributes.
// Every change to node-local disk goes through this mount, so the kernel's
// view stays right; ArtifactFS entries keep zero timeouts (TASK-125).
const localCacheTimeout = time.Second

func isLocal(root *fs.LoopbackRoot) bool {
	_, local := repositoryRoots(root)
	return local != nil && root == local
}

func cacheLocalEntry(root *fs.LoopbackRoot, out *fuse.EntryOut) {
	if isLocal(root) {
		out.SetEntryTimeout(localCacheTimeout)
		out.SetAttrTimeout(localCacheTimeout)
	}
}

// relativePath is the slash-separated path of name under parent, from the
// checkout's root.
func relativePath(parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string) string {
	return filepath.ToSlash(filepath.Join(parent.EmbeddedInode().Path(root.RootNode.EmbeddedInode()), name))
}

// placement is the backing root a new entry name under parent is created in.
// A local entry's container folders are made on the way.
func placement(parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string, isDir bool) (*fs.LoopbackRoot, syscall.Errno) {
	view, local := repositoryRoots(root)
	if local == nil || root == local {
		return root, 0
	}
	if !view.ignore.ignored(relativePath(parent, root, name), isDir) {
		return root, 0
	}
	if err := os.MkdirAll(filepath.Join(local.Path, parent.EmbeddedInode().Path(root.RootNode.EmbeddedInode())), 0755); err != nil {
		return nil, fs.ToErrno(err)
	}
	return local, 0
}

// residence is the backing root that holds the existing entry name under
// parent: the ArtifactFS layer when it has it, else node-local disk.
func residence(parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string) *fs.LoopbackRoot {
	_, local := repositoryRoots(root)
	if local == nil || root == local {
		return root
	}
	if _, err := os.Lstat(repositoryChildPath(parent, root, name)); err == nil || !os.IsNotExist(err) {
		return root
	}
	if _, err := os.Lstat(repositoryChildPath(parent, local, name)); err == nil {
		return local
	}
	return root
}

// containerPath is the node-local container of an ArtifactFS folder, which
// holds the folder's ignored entries.
func containerPath(node fs.InodeEmbedder, root *fs.LoopbackRoot) string {
	_, local := repositoryRoots(root)
	if local == nil || root == local {
		return ""
	}
	return filepath.Join(local.Path, node.EmbeddedInode().Path(root.RootNode.EmbeddedInode()))
}

// openRepositoryDirectory lists an ArtifactFS folder together with its
// node-local container, or a node-local folder on its own.
func openRepositoryDirectory(node fs.InodeEmbedder, root *fs.LoopbackRoot) (fs.FileHandle, uint32, syscall.Errno) {
	path := filepath.Join(root.Path, node.EmbeddedInode().Path(root.RootNode.EmbeddedInode()))
	container := containerPath(node, root)
	if container == "" {
		stream, errno := fs.NewLoopbackDirStream(path)
		return stream, 0, errno
	}
	extra, err := os.ReadDir(container)
	if err != nil || len(extra) == 0 {
		stream, errno := fs.NewLoopbackDirStream(path)
		return stream, 0, errno
	}
	stream, errno := fs.NewLoopbackDirStream(path)
	if errno != 0 {
		return nil, 0, errno
	}
	defer stream.Close()
	var entries []fuse.DirEntry
	seen := map[string]bool{}
	for stream.HasNext() {
		entry, errno := stream.Next()
		if errno != 0 {
			return nil, 0, errno
		}
		seen[entry.Name] = true
		entries = append(entries, entry)
	}
	for _, entry := range extra {
		if seen[entry.Name()] {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		stat := info.Sys().(*syscall.Stat_t)
		entries = append(entries, fuse.DirEntry{Name: entry.Name(), Mode: uint32(stat.Mode), Ino: stat.Ino})
	}
	return fs.NewListDirStream(entries), 0, 0
}

// removeRepositoryEntry unlinks or removes the folder name under parent from
// whichever root holds it. An ArtifactFS folder that still holds ignored
// entries is not empty; once removed, its empty container goes too.
func removeRepositoryEntry(parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string, folder bool) syscall.Errno {
	holder := residence(parent, root, name)
	path := repositoryChildPath(parent, holder, name)
	if !folder {
		return fs.ToErrno(syscall.Unlink(path))
	}
	_, local := repositoryRoots(root)
	container := ""
	if local != nil && holder != local {
		container = repositoryChildPath(parent, local, name)
		if entries, err := os.ReadDir(container); err == nil && len(entries) > 0 {
			return syscall.ENOTEMPTY
		}
	}
	if err := syscall.Rmdir(path); err != nil {
		return fs.ToErrno(err)
	}
	if container != "" {
		_ = syscall.Rmdir(container)
	}
	return 0
}

// renameRepositoryEntry renames name under parent to newName under newParent.
func renameRepositoryEntry(parent fs.InodeEmbedder, root *fs.LoopbackRoot, name string, newParent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	target, ok := newParent.(interface{ loopbackRoot() *fs.LoopbackRoot })
	if !ok {
		return syscall.EXDEV
	}
	newRoot := target.loopbackRoot()
	view, local := repositoryRoots(root)
	if newView, _ := repositoryRoots(newRoot); newView != view {
		return syscall.EXDEV
	}
	from := residence(parent, root, name)
	source := repositoryChildPath(parent, from, name)
	var stat syscall.Stat_t
	if err := syscall.Lstat(source, &stat); err != nil {
		return fs.ToErrno(err)
	}
	folder := stat.Mode&syscall.S_IFMT == syscall.S_IFDIR
	to := from
	if local != nil && from == local && newRoot != local && !view.ignore.ignored(relativePath(newParent, newRoot, newName), folder) {
		to = view.RootData
	}
	if to == local && newRoot != local {
		if err := os.MkdirAll(filepath.Join(local.Path, newParent.EmbeddedInode().Path(newRoot.RootNode.EmbeddedInode())), 0755); err != nil {
			return fs.ToErrno(err)
		}
	}
	destination := repositoryChildPath(newParent, to, newName)
	if to != from {
		if folder {
			return syscall.EXDEV
		}
		if errno := copyIntoLayer(source, destination, stat.Mode&07777); errno != 0 {
			return errno
		}
		if err := syscall.Unlink(source); err != nil {
			return fs.ToErrno(err)
		}
		moveNodeRoot(parent, name, to)
		return 0
	}
	if err := unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, destination, uint(flags)); err != nil {
		return fs.ToErrno(err)
	}
	// An ArtifactFS folder takes its ignored entries along.
	if local != nil && from != local && folder {
		container := repositoryChildPath(parent, local, name)
		if _, err := os.Lstat(container); err == nil {
			newContainer := repositoryChildPath(newParent, local, newName)
			if err := os.MkdirAll(filepath.Dir(newContainer), 0755); err != nil {
				return fs.ToErrno(err)
			}
			if err := os.Rename(container, newContainer); err != nil {
				return fs.ToErrno(err)
			}
		}
	}
	return 0
}

// copyIntoLayer writes a local file to a path in the ArtifactFS layer through
// a temporary name, so the destination is replaced in one step.
func copyIntoLayer(source, destination string, mode uint32) syscall.Errno {
	in, err := os.Open(source)
	if err != nil {
		return fs.ToErrno(err)
	}
	defer in.Close()
	temporary := filepath.Join(filepath.Dir(destination), "."+filepath.Base(destination)+".adm-move")
	out, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, os.FileMode(mode))
	if err != nil {
		return fs.ToErrno(err)
	}
	_, err = io.Copy(out, in)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temporary, destination)
	}
	if err != nil {
		_ = os.Remove(temporary)
		var errno syscall.Errno
		if errors.As(err, &errno) {
			return errno
		}
		return syscall.EIO
	}
	return 0
}

// moveNodeRoot points the node go-fuse is about to move under its new name at
// the root its file now lives in.
func moveNodeRoot(parent fs.InodeEmbedder, name string, root *fs.LoopbackRoot) {
	if child := parent.EmbeddedInode().GetChild(name); child != nil {
		if node, ok := child.Operations().(*repositoryLoopbackNode); ok {
			node.RootData = root
		}
	}
}

func (node *repositoryLoopbackNode) loopbackRoot() *fs.LoopbackRoot { return node.RootData }

func (node *repositoryView) loopbackRoot() *fs.LoopbackRoot { return node.RootData }
