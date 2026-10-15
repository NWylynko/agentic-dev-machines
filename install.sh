#!/bin/sh
set -eu

fail() {
  printf 'adm installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Install or update ADM on a Debian Linux x86_64 management host.

Usage: sh install.sh [--version TAG] [--yes | --no-setup]
  --version TAG  Install a release tag (default: latest).
  --yes          Install without interactive onboarding.
  --no-setup     Install without running adm setup.
  --base-url URL Download release assets from this directory.
  --help         Show this help.

Requires Node.js 24+, curl, tar, sha256sum, and flock. No sudo or checkout needed.
Rerun the same command to update. Existing state and settings are preserved.
USAGE
}
version=latest
base_url=
setup=true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--base-url)
      option=$1
      shift
      [ "$#" -gt 0 ] || fail "$option requires a value"
      if [ "$option" = --version ]; then version=$1; else base_url=$1; fi
      ;;
    --yes|--no-setup)
      setup=false
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
  shift
done
case "$version" in ''|*[!A-Za-z0-9._-]*) fail 'release tags may contain letters, numbers, dots, underscores, and hyphens' ;; esac
[ "$(uname -s)" = Linux ] || fail 'supported platform is Debian Linux x86_64'
case "$(uname -m)" in x86_64|amd64) ;; *) fail 'supported architecture is x86_64' ;; esac
for dependency in node curl tar sha256sum mktemp readlink flock; do
  command -v "$dependency" >/dev/null 2>&1 || fail "missing prerequisite: $dependency"
done
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || fail 'Node.js 24 or newer is required'
case "${HOME-}" in /*) ;; *) fail 'HOME must be an absolute path' ;; esac
data_home=${XDG_DATA_HOME:-$HOME/.local/share}
case "$data_home" in /*) ;; *) fail 'XDG_DATA_HOME must be an absolute path' ;; esac
prefix=$data_home/adm/install
bin_dir=$HOME/.local/bin
for directory in "$prefix" "$prefix/releases" "$bin_dir"; do
  [ ! -L "$directory" ] || fail "refusing symlink directory: $directory"
  [ ! -e "$directory" ] || [ -d "$directory" ] || fail "not a directory: $directory"
done
for binary in adm adm-repositories; do
  command_path=$bin_dir/$binary
  if [ -e "$command_path" ] || [ -L "$command_path" ]; then
    [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$prefix/current/bin/$binary" ] || fail "refusing to overwrite unmanaged command: $command_path"
  fi
done
if [ -e "$prefix/current" ] || [ -L "$prefix/current" ]; then
  [ -L "$prefix/current" ] || fail "refusing unmanaged current path: $prefix/current"
  current_target=$(readlink "$prefix/current")
  printf '%s\n' "$current_target" | LC_ALL=C awk '/^releases\/[a-f0-9]{64}$/ {valid=1} END {exit !valid}' || fail 'current symlink is not an ADM release'
  current_marker=$prefix/$current_target/.adm-release-sha256
  [ -f "$current_marker" ] && [ ! -L "$current_marker" ] && [ "$(cat "$current_marker")" = "${current_target#releases/}" ] || fail 'current release is not managed by the ADM installer'
fi
if [ -z "$base_url" ]; then
  if [ "$version" = latest ]; then
    base_url=https://github.com/NWylynko/agentic-dev-machines/releases/latest/download
  else
    base_url=https://github.com/NWylynko/agentic-dev-machines/releases/download/$version
  fi
fi
case "$base_url" in http://*|https://*) ;; *) fail '--base-url must be an HTTP or HTTPS release asset directory' ;; esac
base_url=${base_url%/}
archive_name=adm-linux-amd64.tar.gz
mkdir -p "$prefix/releases" "$bin_dir"
exec 9>"$prefix/install.lock"
flock -n 9 || fail 'another ADM installation is in progress'
temporary=$(mktemp -d "$prefix/.install.XXXXXXXX")
cleanup() {
  if [ -n "${temporary-}" ] && [ -d "$temporary" ]; then rm -r "$temporary"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Downloading ADM %s...\n' "$version"
curl --fail --silent --show-error --location "$base_url/$archive_name" -o "$temporary/$archive_name" || fail "release download failed; check that a GitHub release exists for $version"
curl --fail --silent --show-error --location "$base_url/SHA256SUMS" -o "$temporary/SHA256SUMS" || fail 'release checksum download failed'
checksum=$(awk -v archive="$archive_name" '$2 == archive || $2 == "*" archive {print $1; count++} END {if(count != 1) exit 1}' "$temporary/SHA256SUMS") || fail 'expected exactly one archive checksum in SHA256SUMS'
printf '%s\n' "$checksum" | LC_ALL=C awk '/^[a-f0-9]{64}$/ {valid=1} END {exit !valid}' || fail 'invalid archive checksum'
printf '%s  %s\n' "$checksum" "$temporary/$archive_name" | sha256sum -c - >/dev/null || fail 'archive checksum mismatch; existing installation was not changed'
tar -tzf "$temporary/$archive_name" > "$temporary/entries" || fail 'invalid release archive'
awk '/^\// || /(^|\/)\.\.(\/|$)/ {exit 1}' "$temporary/entries" || fail 'archive contains an unsafe path'
mkdir "$temporary/bundle"
tar --no-same-owner --no-same-permissions -xzf "$temporary/$archive_name" -C "$temporary/bundle" || fail 'release extraction failed'
bundle=$temporary/bundle
for binary in adm adm-repositories; do
  [ -f "$bundle/bin/$binary" ] && [ -x "$bundle/bin/$binary" ] || fail "release is missing executable bin/$binary"
done
for path in runtime/runner.mjs runtime/terminal.mjs package.json VERSION IMAGE; do
  [ -f "$bundle/$path" ] || fail "release is missing $path"
done
[ -d "$bundle/node_modules" ] || fail 'release is missing node_modules'
node - "$bundle" <<'NODE' || fail 'release validation failed; existing installation was not changed'
const fs = require('node:fs'), path = require('node:path');
const root = fs.realpathSync(process.argv[2]);
function validateLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(filename);
      if (target !== root && !target.startsWith(root + path.sep))
        throw new Error(`unsafe release link outside installation: ${filename}`);
    } else if (entry.isDirectory()) validateLinks(filename);
    else if (!entry.isFile()) throw new Error(`unsafe release file type: ${filename}`);
  }
}
validateLinks(root);
if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).type !== 'module')
  throw new Error('release package.json must declare type module');
for (const name of ['VERSION', 'IMAGE']) {
  const value = fs.readFileSync(path.join(root, name), 'utf8').trim();
  if (!value || /\s/.test(value)) throw new Error(`invalid release ${name}`);
}
NODE
node --check "$bundle/runtime/runner.mjs" >/dev/null || fail 'runner validation failed'
node --check "$bundle/runtime/terminal.mjs" >/dev/null || fail 'terminal validation failed'
"$bundle/bin/adm" --version >/dev/null || fail 'ADM executable validation failed'
release=$prefix/releases/$checksum
first_install=true
if [ -L "$prefix/current" ]; then first_install=false; fi
if [ "$(readlink "$prefix/current" 2>/dev/null || :)" = "releases/$checksum" ]; then
  for binary in adm adm-repositories; do
    if [ ! -L "$bin_dir/$binary" ]; then ln -s "$prefix/current/bin/$binary" "$bin_dir/$binary"; fi
  done
  printf 'ADM is already up to date.\n'
  exit 0
fi
if [ -e "$release" ] || [ -L "$release" ]; then
  [ -d "$release" ] && [ ! -L "$release" ] && [ -f "$release/.adm-release-sha256" ] && [ ! -L "$release/.adm-release-sha256" ] && [ "$(cat "$release/.adm-release-sha256")" = "$checksum" ] || fail "refusing unmanaged release directory: $release"
fi
restart_runner=false
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet adm-runner.service 2>/dev/null; then
  restart_runner=true
  service_command=$(systemctl --user show adm-runner.service --property=ExecStart --value 2>/dev/null) || service_command=
  case "$service_command" in
    *--project-dir*|'')
      printf 'adm installer: adm-runner.service has a custom ExecStart; run adm setup to use %s without a checkout, then verify the service.\n' "$bin_dir/adm" >&2
      ;;
    *"$bin_dir/adm"*) ;;
    *)
      printf 'adm installer: adm-runner.service has a custom ExecStart; run adm setup to use %s, then verify the service.\n' "$bin_dir/adm" >&2
      ;;
  esac
fi
if [ "$restart_runner" = false ]; then
  node - "${ADM_STATE_DIR:-$data_home/adm}" <<'NODE' || fail 'stop the standalone runner with adm stop, rerun the installer, then run adm start'
const fs = require('node:fs'), path = require('node:path');
const state = path.resolve(process.argv[2]);
try {
  const pid = fs.readFileSync(path.join(state, 'runner.pid'), 'utf8').trim();
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('invalid runner.pid; inspect existing runner state');
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const directory = args.indexOf('--state-dir');
  if (args.some(argument => argument.endsWith('/runtime/runner.mjs') || argument.endsWith('/packages/runner/src/main.ts')) &&
      directory >= 0 && path.resolve(args[directory + 1]) === path.join(state, 'runner'))
    process.exitCode = 1;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
NODE
fi
if [ ! -e "$release" ]; then
  [ ! -e "$bundle/.adm-release-sha256" ] && [ ! -L "$bundle/.adm-release-sha256" ] || fail 'archive contains reserved installer metadata'
  printf '%s\n' "$checksum" > "$bundle/.adm-release-sha256"
  mv "$bundle" "$release"
fi
ln -s "releases/$checksum" "$temporary/current"
mv -T "$temporary/current" "$prefix/current"
for binary in adm adm-repositories; do
  if [ ! -L "$bin_dir/$binary" ]; then ln -s "$prefix/current/bin/$binary" "$bin_dir/$binary"; fi
done
if [ "$restart_runner" = true ]; then
  systemctl --user restart adm-runner.service || fail 'ADM was updated, but adm-runner.service restart failed; inspect systemctl --user status adm-runner.service'
fi
printf 'Installed ADM %s.\n' "$(cat "$release/VERSION")"
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Add %s to PATH.\n' "$bin_dir" ;; esac
if [ "$first_install" = true ]; then
  if [ "$setup" = true ] && [ -t 1 ] && ( : </dev/tty ) 2>/dev/null; then
    "$bin_dir/adm" setup </dev/tty
  else
    printf 'Run adm setup to configure the management host.\n'
  fi
fi
