#!/bin/sh
# Noodara installer (INST-01..INST-05).
#
# Published as `curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | sh`
# (06-CONTEXT.md D-03). On Ubuntu, piping into `sh` always executes under dash, regardless of this
# file's own shebang -- the shebang is inert when the interpreter is invoked explicitly. This file
# is therefore strict POSIX `sh`: no `[[ ]]`, no `$EUID`, no arrays, no `local`, `set -e` only
# (never the dash-unsupported "fail on any pipe segment" option), `.` not `source`, `printf` not
# `echo -e`/`echo -n`.
#
# All logic lives inside function bodies. The only side-effecting top-level statement is the
# final guarded dispatch at the bottom of this file. This means a `curl | sh` stream truncated
# mid-download (a slow connection, a dropped proxy) can only ever define a partial set of
# functions and then exit -- it can never half-run an install. `scripts/check-posix-sh.mjs`
# enforces both of these properties (`pnpm check:posix-sh`) as a named, non-bypassable gate,
# not just a review convention.
#
# This file can also be sourced as a pure library, with no side effects and no install attempted,
# by setting NOODARA_INSTALL_SH_SOURCE_ONLY=1 before sourcing it -- this is how
# tests/unit/installer/sh-harness.ts exercises individual functions against a real /bin/sh and
# dash (06-CONTEXT.md D-18 layer 1).
set -eu

# Overridable only for tests (undocumented for real installs -- the real install path is always
# /opt/noodara, per 06-CONTEXT.md D-10).
readonly NOODARA_INSTALL_DIR="${NOODARA_INSTALL_DIR:-/opt/noodara}"
readonly NOODARA_DEFAULT_PORT=3000
readonly NOODARA_COMPOSE_FILE=docker-compose.yml
readonly NOODARA_ENV_FILE=.env
readonly NOODARA_INSTALL_LOG_FILE=install.log

# Overridable only for tests -- the real preflight always reads the genuine system files
# (06-02-PLAN.md Task 1/2).
readonly NOODARA_OS_RELEASE_FILE="${NOODARA_OS_RELEASE_FILE:-/etc/os-release}"
readonly NOODARA_MEMINFO_FILE="${NOODARA_MEMINFO_FILE:-/proc/meminfo}"

# Overridable only for tests -- the real installer targets the genuine published GitHub repo once
# Plan 06-15's human prerequisite creates it (06-CONTEXT.md D-02). These two defaults are
# placeholders and MUST be replaced with the real owner/repo before v0.1's first real release --
# flagged here and in this plan's own SUMMARY for Plan 06-15's handoff.
readonly NOODARA_REPO_OWNER="${NOODARA_REPO_OWNER:-nooodara}"
readonly NOODARA_REPO_NAME="${NOODARA_REPO_NAME:-noodara}"

# The real default registry (06-CONTEXT.md D-01). NOODARA_FETCH_TIMEOUT bounds every curl call
# this file ever makes (T-06-31) -- the single seam is noodara_fetch_url, defined below.
readonly NOODARA_REGISTRY="${NOODARA_REGISTRY:-ghcr.io}"
readonly NOODARA_FETCH_TIMEOUT="${NOODARA_FETCH_TIMEOUT:-5}"

# Overridable only for tests (hard_rule #8): the apt keyring directory and the sources-list target
# noodara_install_docker below writes to. The real install always targets Docker's own documented
# locations (06-CONTEXT.md D-14) -- no test ever writes under a real /etc path.
readonly NOODARA_DOCKER_KEYRING_DIR="${NOODARA_DOCKER_KEYRING_DIR:-/etc/apt/keyrings}"
readonly NOODARA_DOCKER_SOURCES_FILE="${NOODARA_DOCKER_SOURCES_FILE:-/etc/apt/sources.list.d/docker.list}"

# Maps a named failure reason to its exit code (06-CONTEXT.md D-17: every preflight/runtime
# failure cause gets its own numbered exit code, never a generic failure). Prints the code to
# stdout on success so a caller can do `code=$(noodara_exit_code_for some-reason)`. An unknown
# reason is treated as an internal error in this script itself, not a preflight failure: it writes
# a diagnostic to stderr and exits 99 directly, rather than returning a code for the caller to
# act on.
noodara_exit_code_for() {
  reason="$1"
  case "$reason" in
    not-root) printf '%s\n' 10 ;;
    missing-command) printf '%s\n' 11 ;;
    unsupported-os) printf '%s\n' 12 ;;
    unsupported-arch) printf '%s\n' 13 ;;
    insufficient-ram) printf '%s\n' 14 ;;
    insufficient-disk) printf '%s\n' 15 ;;
    port-in-use) printf '%s\n' 16 ;;
    docker-via-snap) printf '%s\n' 17 ;;
    docker-install-failed) printf '%s\n' 20 ;;
    compose-plugin-missing) printf '%s\n' 21 ;;
    docker-daemon-unavailable) printf '%s\n' 22 ;;
    env-write-failed) printf '%s\n' 30 ;;
    version-resolution-failed) printf '%s\n' 40 ;;
    public-url-resolution-failed) printf '%s\n' 41 ;;
    image-pull-failed) printf '%s\n' 50 ;;
    compose-up-failed) printf '%s\n' 51 ;;
    migrations-failed) printf '%s\n' 52 ;;
    health-check-failed) printf '%s\n' 53 ;;
    *)
      printf 'noodara: internal error: unknown exit reason %s\n' "$reason" >&2
      exit 99
      ;;
  esac
}

# Output helpers (noodara-security SS8: no helper here ever interpolates a generated secret --
# every caller passes a literal, operator-facing message only). English, calm, one line per call,
# printf only.

# A single progressive step, printed to stdout, nothing to stderr.
noodara_step() {
  printf '%s\n' "$1"
}

# A non-fatal warning, printed to stderr with a stable prefix. Does not exit.
noodara_warn() {
  printf 'noodara: warning: %s\n' "$1" >&2
}

# An informational aside, printed to stdout -- lower-emphasis than noodara_step but still
# operator-visible, never for anything a script needs to act on programmatically.
noodara_note() {
  printf '%s\n' "$1"
}

# A fatal preflight/runtime failure: prints a literal message to stderr (never stdout) and exits
# with the numbered code noodara_exit_code_for maps the given reason to.
noodara_fail() {
  reason="$1"
  message="$2"
  code=$(noodara_exit_code_for "$reason")
  printf 'noodara: %s\n' "$message" >&2
  exit "$code"
}

# Preflight predicates (06-CONTEXT.md D-17, INST-03). Each predicate below is a separate,
# injectable function with its own exit-code reason from the table above and its own actionable,
# English, one-sentence message. noodara_preflight (added once every predicate below exists)
# composes them in one documented order and stops at the first failure -- no predicate here
# accumulates failures or reports more than one cause.

# Fails with reason not-root, naming sudo, when the effective user id (checked via `id -u`, POSIX
# portable, never a bash-only effective-uid shell variable) is not 0.
noodara_check_root() {
  if [ "$(id -u)" != "0" ]; then
    noodara_fail not-root "This installer must be run as root. Re-run it with sudo."
  fi
}

# Fails with reason missing-command, naming the first absent command, when any of the base
# commands the rest of this script depends on (curl, openssl, ss, ip, awk, grep) is not found on
# PATH. Uses `command -v`, never `which`.
noodara_check_base_commands() {
  for cmd in curl openssl ss ip awk grep; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      noodara_fail missing-command "Required command '$cmd' was not found. Install it and re-run this installer."
    fi
  done
}

# Prints "<ID> <VERSION_ID>" read from NOODARA_OS_RELEASE_FILE (default /etc/os-release). Sourced
# inside a subshell so ID/VERSION_ID never leak into the caller's own scope. Prints "unknown
# unknown" when the file does not exist, rather than failing itself -- noodara_check_os is the
# function that decides whether that is a preflight failure.
noodara_detect_os_version() {
  if [ ! -f "$NOODARA_OS_RELEASE_FILE" ]; then
    printf 'unknown unknown\n'
    return 0
  fi
  (
    . "$NOODARA_OS_RELEASE_FILE"
    printf '%s %s\n' "${ID:-unknown}" "${VERSION_ID:-unknown}"
  )
}

# Fails with reason unsupported-os, naming the detected OS and the two supported versions, unless
# noodara_detect_os_version reports exactly "ubuntu 22.04" or "ubuntu 24.04" (06-CONTEXT.md D-14).
noodara_check_os() {
  os_info=$(noodara_detect_os_version)
  case "$os_info" in
    "ubuntu 22.04" | "ubuntu 24.04")
      return 0
      ;;
    *)
      noodara_fail unsupported-os "Detected OS '$os_info' is not supported. Noodara requires Ubuntu 22.04 or Ubuntu 24.04."
      ;;
  esac
}

# Maps `uname -m`'s raw machine name to Noodara's own two-value architecture name: x86_64 ->
# amd64, aarch64/arm64 -> arm64. Any other machine name is printed as-is (noodara_check_arch
# decides whether that is a preflight failure).
noodara_detect_arch() {
  machine=$(uname -m)
  case "$machine" in
    x86_64)
      printf 'amd64\n'
      ;;
    aarch64 | arm64)
      printf 'arm64\n'
      ;;
    *)
      printf '%s\n' "$machine"
      ;;
  esac
}

# Fails with reason unsupported-arch, naming the detected architecture and the two supported
# ones, unless noodara_detect_arch resolves to amd64 or arm64 (06-CONTEXT.md D-16).
noodara_check_arch() {
  arch=$(noodara_detect_arch)
  case "$arch" in
    amd64 | arm64)
      return 0
      ;;
    *)
      noodara_fail unsupported-arch "Detected architecture '$arch' is not supported. Noodara requires amd64 or arm64."
      ;;
  esac
}

# Prints total system RAM in whole megabytes, read from NOODARA_MEMINFO_FILE's MemTotal line
# (default /proc/meminfo). Division happens inside awk itself, never via a `$(( ))` arithmetic
# expansion, since this file's own POSIX-sh gate treats any `((` occurrence as a bashism finding.
noodara_total_ram_mb() {
  awk '/^MemTotal:/ { printf "%d\n", $2 / 1024 }' "$NOODARA_MEMINFO_FILE"
}

# Fails with reason insufficient-ram (exit 14) when total RAM is below 1024MB; warns (stderr,
# non-fatal) and continues when RAM is between 1024 and 2047MB; is silent at 2048MB and above.
# Fails with reason insufficient-disk (exit 15) when free disk on NOODARA_INSTALL_DIR's
# filesystem (or its nearest existing ancestor, when the install dir does not exist yet) is below
# 5120MB. NOODARA_SKIP_RESOURCE_CHECK=1 skips both checks deliberately and emits one note instead
# (06-CONTEXT.md D-15).
noodara_check_resources() {
  if [ "${NOODARA_SKIP_RESOURCE_CHECK:-0}" = "1" ]; then
    noodara_note "Resource checks skipped (NOODARA_SKIP_RESOURCE_CHECK=1)."
    return 0
  fi

  ram_mb=$(noodara_total_ram_mb)
  if [ "$ram_mb" -lt 1024 ]; then
    noodara_fail insufficient-ram "Detected ${ram_mb}MB RAM, below the 1024MB minimum. Noodara requires at least 1GB of RAM (2GB recommended). Set NOODARA_SKIP_RESOURCE_CHECK=1 to override deliberately."
  elif [ "$ram_mb" -lt 2048 ]; then
    noodara_warn "Detected ${ram_mb}MB RAM, below the 2048MB recommended minimum. Continuing, but performance may be degraded."
  fi

  # Post-execution fix (orchestrator audit WR-05): previously stripped exactly one path segment,
  # which only happened to be correct for the real, fixed default (/opt/noodara, since /opt always
  # exists on a stock Ubuntu install) -- a genuinely nested, still-nonexistent NOODARA_INSTALL_DIR
  # (a test override, or any future default) fell through to a `df` call against a path that also
  # did not exist, silently producing disk_kb="" -> disk_mb=0 -> a confusing insufficient-disk
  # failure rather than a real measurement. This now walks the real ancestor chain -- one segment
  # at a time via `${x%/*}` -- until it finds a directory that genuinely exists, with `/` as the
  # floor, matching both this function's own comment above and docs/install.md's claim.
  disk_target="$NOODARA_INSTALL_DIR"
  while [ ! -d "$disk_target" ]; do
    if [ "$disk_target" = "/" ] || [ -z "$disk_target" ]; then
      disk_target="/"
      break
    fi
    disk_target="${disk_target%/*}"
    [ -z "$disk_target" ] && disk_target="/"
  done
  disk_kb=$(df -Pk "$disk_target" 2>/dev/null | awk 'NR==2 { print $4 }')
  disk_mb=$(awk -v kb="${disk_kb:-0}" 'BEGIN { printf "%d\n", kb / 1024 }')
  if [ "$disk_mb" -lt 5120 ]; then
    noodara_fail insufficient-disk "Detected ${disk_mb}MB free disk on ${disk_target}'s filesystem, below the 5120MB (5GB) minimum. Free up disk space and re-run this installer. Set NOODARA_SKIP_RESOURCE_CHECK=1 to override deliberately."
  fi

  return 0
}

# Resolves the panel port: NOODARA_PORT when set (validated as a digits-only value in 1-65535),
# otherwise NOODARA_DEFAULT_PORT (3000). Fails with reason port-in-use (exit 16, the same reason
# noodara_check_port uses) for a non-numeric or out-of-range override, since both are the operator
# giving this installer an unusable port value (06-CONTEXT.md D-06).
noodara_resolve_port() {
  port="${NOODARA_PORT:-$NOODARA_DEFAULT_PORT}"
  case "$port" in
    '' | *[!0-9]*)
      noodara_fail port-in-use "NOODARA_PORT='$port' is not a valid port number. Set NOODARA_PORT to a value between 1 and 65535."
      ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    noodara_fail port-in-use "NOODARA_PORT='$port' is out of range. Set NOODARA_PORT to a value between 1 and 65535."
  fi
  printf '%s\n' "$port"
}

# Fails with reason port-in-use (exit 16), naming the resolved panel port and suggesting
# NOODARA_PORT=<other>, when `ss -tuln` shows it already listening. The match is anchored on
# ":<port>" followed by a space so a busy port 30000 is never mistaken for port 3000
# (06-RESEARCH.md Pattern 4 -- Coolify's own missing port check is the negative example).
#
# Post-execution fix (orchestrator audit Finding A, 06-09 follow-up): on an existing installation
# (D-10's own signal: NOODARA_INSTALL_DIR/.env exists) the panel port is whatever this
# installation's own .env already recorded -- that port being in use is expected (it is this
# installation's own currently-running web container), never a preflight failure. Every re-run
# used to fail here unconditionally the moment the panel was actually up, which made a re-run
# impossible against a genuinely running installation. A fresh install (no .env yet) keeps the
# exact original busy-port check. An operator-supplied NOODARA_PORT that disagrees with the
# recorded value is not silently applied and not silently ignored either: this is the one place
# that mismatch is surfaced, with a single warning naming both values and the fix (.env always
# wins on a re-run -- D-11's own "existing values are never touched" already guarantees this at
# the merge-write level; this warning is what makes that guarantee visible instead of a silent
# no-op). Reads .env but never writes anything, preserving noodara_preflight's own "writes
# nothing" invariant.
noodara_check_port() {
  if noodara_is_installed; then
    _noodara_cp_env_path="${NOODARA_INSTALL_DIR}/${NOODARA_ENV_FILE}"
    _noodara_cp_env_port=$(noodara_env_get_value "$_noodara_cp_env_path" NOODARA_PORT)
    if [ -n "${NOODARA_PORT:-}" ] && [ -n "$_noodara_cp_env_port" ] && [ "$NOODARA_PORT" != "$_noodara_cp_env_port" ]; then
      noodara_warn "NOODARA_PORT='$NOODARA_PORT' was given, but this installation already uses port $_noodara_cp_env_port. The existing .env always wins on a re-run -- to change the port, edit ${_noodara_cp_env_path} (key NOODARA_PORT), then run: docker compose -f ${NOODARA_INSTALL_DIR}/${NOODARA_COMPOSE_FILE} up -d"
    fi
    return 0
  fi

  port=$(noodara_resolve_port)
  if ss -tuln 2>/dev/null | grep -q ":${port} "; then
    noodara_fail port-in-use "Port $port is already in use. Set NOODARA_PORT=<other> and re-run this installer."
  fi
}

# Fails with reason docker-via-snap (exit 17), naming the removal command, when `snap list docker`
# succeeds -- i.e. Docker is installed via snap, which Noodara does not support
# (06-CONTEXT.md D-14). Calling `snap list docker` directly (rather than gating on `command -v
# snap` first) is deliberate: it is injectable either way (a test can shadow `snap` with a shell
# function) and behaves correctly whether `snap` is absent, present-but-without-docker, or
# present-with-docker, with no separate existence check needed.
noodara_check_docker_snap() {
  if snap list docker >/dev/null 2>&1; then
    noodara_fail docker-via-snap "Docker is installed via snap, which Noodara does not support. Remove it (sudo snap remove docker) and re-run this installer."
  fi
}

# Docker Engine + Compose plugin installation (06-CONTEXT.md D-14, INST-01): a missing Docker
# Engine or Compose v2 plugin is installed from Docker's own official apt repository -- never a
# third-party curl-pipe-sh installer, never Ubuntu's own conflicting distro packages -- so a
# failure can name what broke instead of a generic "installation failed". noodara_check_docker_snap
# above has already rejected a snap-installed Docker by the time anything below ever runs.

# Returns 0 when `docker version` succeeds, non-zero when the command is absent or fails -- e.g. a
# `docker` binary present with an unreachable daemon. Keys on the command's exit code, never
# `command -v`, matching phase-2 ADR 0004's own detection precedent. stdout/stderr are discarded;
# the operator never sees raw `docker version` output from this probe, only a noodara_step line
# from a caller.
noodara_docker_present() {
  docker version >/dev/null 2>&1
}

# Post-execution fix (orchestrator audit Finding 2): a narrower probe than noodara_docker_present
# above -- true when a `docker` binary is merely found on PATH (`command -v docker`), regardless
# of whether its daemon responds. noodara_docker_present's own exit-code-based contract is left
# completely untouched (still the only thing that decides "Docker Engine is usable"); this
# function exists only so noodara_ensure_docker can distinguish "Docker is genuinely absent" from
# "Docker is installed but its daemon is not responding" before running any apt/gpg/file-write/
# systemctl operation.
noodara_docker_binary_present() {
  command -v docker >/dev/null 2>&1
}

# Checks the `compose` plugin subcommand specifically -- never a standalone, no-longer-supported
# v1 `docker-compose` binary.
noodara_compose_present() {
  docker compose version >/dev/null 2>&1
}

# Every apt-get invocation below goes through this one helper: DEBIAN_FRONTEND is non-interactive,
# -y answers every prompt, dpkg conffile prompts are pre-answered (--force-confdef/--force-
# confold), and Acquire/DPkg::Lock timeouts bound how long a concurrent unattended-upgrades run or
# a slow mirror can block an unattended `curl | sh` (hard_rule #9, T-06-38). Output is captured,
# never streamed raw to the terminal -- a successful call prints nothing beyond this file's own
# noodara_step notices, however verbose apt itself is; a failing call prints its own last lines to
# stderr before returning non-zero, so the caller's own noodara_fail message is followed by enough
# context to diagnose (hard_rule #9's "tail on failure") without ever writing a persistent log file.
_noodara_did_run_apt() {
  if _noodara_did_output=$(DEBIAN_FRONTEND=noninteractive apt-get -y \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold \
    -o Acquire::http::Timeout=10 \
    -o Acquire::Retries=3 \
    -o DPkg::Lock::Timeout=60 \
    "$@" 2>&1); then
    return 0
  fi
  printf '%s\n' "$_noodara_did_output" | tail -n 40 >&2
  return 1
}

# Fails with reason docker-install-failed (exit 20), naming the given step -- one call site per
# step below, so a failure always names the exact step that broke rather than a generic message
# (T-06-40).
_noodara_did_fail_step() {
  noodara_fail docker-install-failed "Docker installation failed at step: $1. See the apt output above for details."
}

# Step: removes conflicting distro packages, Docker's own documented first step. This step's own
# exit status is deliberately never checked -- a package that is simply absent is not a failure,
# matching Docker's documented per-package removal loop where each removal is allowed to no-op.
# Never removes docker-ce/containerd.io themselves (the packages the sequence below installs) and
# never touches /var/lib/docker (operator data).
noodara_docker_remove_conflicting_packages() {
  _noodara_did_run_apt remove docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc || true
}

# Step: refreshes the apt package index. Called twice by noodara_install_docker/
# noodara_ensure_compose_plugin below -- once before Docker's repository is trusted, once after,
# so the newly-written sources file is actually consulted.
noodara_docker_apt_update() {
  _noodara_did_run_apt update || _noodara_did_fail_step "apt-get update"
}

# Step: installs the given package names, failing with the given step label.
_noodara_did_install_packages() {
  _noodara_dip_step="$1"
  shift
  _noodara_did_run_apt install "$@" || _noodara_did_fail_step "$_noodara_dip_step"
}

noodara_docker_apt_install_prereqs() {
  _noodara_did_install_packages "install ca-certificates, curl and gnupg" ca-certificates curl gnupg
}

# Step: creates the keyring directory Docker's GPG key is written into, mode 0755 (world-readable,
# root-writable) -- the same `install -m 0755 -d /etc/apt/keyrings` Docker's own docs and this
# repo's own sshd-ubuntu-22.04/Dockerfile already run successfully in CI.
noodara_docker_create_keyring_dir() {
  install -m 0755 -d "$NOODARA_DOCKER_KEYRING_DIR" || _noodara_did_fail_step "create the apt keyring directory"
}

# Step: downloads Docker's GPG key through noodara_fetch_url -- the single seam every network call
# in this file goes through; no other function ever calls curl directly. Writes atomically (a temp
# file in the same directory, then mv) so a crash or a rejected response never leaves a half-
# written keyring behind; an empty response fails this step outright rather than writing a bad
# keyring and letting the sequence continue.
#
# Post-execution fix (orchestrator audit Finding 1): an empty check alone let an HTML body served
# with HTTP 200 (captive portal, proxy error page) or a truncated download through unchecked --
# apt would only fail later, at `apt-get update`, with a confusing signature error attributed to
# the wrong step. Before writing anything, the body must genuinely look like an ASCII-armored PGP
# public key block: its first non-empty line is exactly the BEGIN marker and its last non-empty
# line is exactly the END marker (a trailing CR is tolerated on either, via `tr -d`, for a
# CRLF-terminated transport). Anything else fails this same step -- naming it, never echoing the
# rejected body -- with no keyring file and no temp file ever written.
#
# Post-execution fix (orchestrator audit Finding 3): the temp-file write and the final `mv` now
# each have their own named `_noodara_did_fail_step "write Docker's keyring file"` on failure --
# previously a failing `printf`/`mv` (e.g. an unwritable keyring directory) aborted through
# `set -e` with no step name and no mapped exit code at all. Any temp file that exists after a
# failed write or move is removed (`rm -f`, itself never checked -- there is nothing further to do
# if cleanup fails too, the step has already failed).
noodara_docker_download_gpg_key() {
  _noodara_ddgk_file="${NOODARA_DOCKER_KEYRING_DIR}/docker.asc"
  _noodara_ddgk_key=$(noodara_fetch_url body "https://download.docker.com/linux/ubuntu/gpg" 2>/dev/null) || _noodara_ddgk_key=""
  if [ -z "$_noodara_ddgk_key" ]; then
    _noodara_did_fail_step "download Docker's GPG key"
  fi

  _noodara_ddgk_first=$(printf '%s\n' "$_noodara_ddgk_key" | awk 'NF { print; exit }' | tr -d '\r')
  _noodara_ddgk_last=$(printf '%s\n' "$_noodara_ddgk_key" | awk 'NF { l = $0 } END { print l }' | tr -d '\r')
  if [ "$_noodara_ddgk_first" != "-----BEGIN PGP PUBLIC KEY BLOCK-----" ] || [ "$_noodara_ddgk_last" != "-----END PGP PUBLIC KEY BLOCK-----" ]; then
    _noodara_did_fail_step "download Docker's GPG key"
  fi

  _noodara_ddgk_tmp="${_noodara_ddgk_file}.tmp.$$"
  if ! printf '%s\n' "$_noodara_ddgk_key" > "$_noodara_ddgk_tmp"; then
    rm -f "$_noodara_ddgk_tmp"
    _noodara_did_fail_step "write Docker's keyring file"
  fi
  if ! mv "$_noodara_ddgk_tmp" "$_noodara_ddgk_file"; then
    rm -f "$_noodara_ddgk_tmp"
    _noodara_did_fail_step "write Docker's keyring file"
  fi
}

# Step: makes the keyring world-readable -- apt itself reads it as the unprivileged `_apt` user,
# not root.
noodara_docker_chmod_gpg_key() {
  chmod a+r "${NOODARA_DOCKER_KEYRING_DIR}/docker.asc" || _noodara_did_fail_step "set the keyring file's permissions"
}

# Step: writes the apt sources line, pinned to the exact keyring file above via `signed-by=` --
# never [trusted=yes], never apt-key. Architecture comes from `dpkg --print-architecture`; the
# codename comes from NOODARA_OS_RELEASE_FILE's own VERSION_CODENAME (reusing
# noodara_detect_os_version's own file constant rather than sourcing /etc/os-release a second
# time), read inside a subshell so it cannot leak into the caller's scope. Both are checked against
# an explicit allow-list before either is ever interpolated into a file this installer goes on to
# trust -- preflight already restricts noodara_check_os/noodara_check_arch to the same two
# codenames/two architectures, but this step does not rely on that having already run.
#
# Post-execution fix (orchestrator audit Finding 3): the final write is now atomic -- a temp file
# in the same directory as the real target, then `mv` -- rather than a direct `>` redirect onto
# NOODARA_DOCKER_SOURCES_FILE. A failure mid-write used to be able to leave a half-written apt
# source behind; a temp file that never successfully becomes the real target is instead removed.
noodara_docker_write_sources_list() {
  _noodara_dwsl_arch=$(dpkg --print-architecture) || _noodara_did_fail_step "detect the package architecture"
  case "$_noodara_dwsl_arch" in
    amd64 | arm64)
      ;;
    *)
      _noodara_did_fail_step "write the apt sources list (unsupported architecture '$_noodara_dwsl_arch')"
      ;;
  esac
  _noodara_dwsl_codename=$(
    if [ -f "$NOODARA_OS_RELEASE_FILE" ]; then
      . "$NOODARA_OS_RELEASE_FILE"
      printf '%s\n' "${VERSION_CODENAME:-}"
    fi
  )
  case "$_noodara_dwsl_codename" in
    jammy | noble)
      ;;
    *)
      _noodara_did_fail_step "write the apt sources list (unsupported codename '$_noodara_dwsl_codename')"
      ;;
  esac
  _noodara_dwsl_dir="${NOODARA_DOCKER_SOURCES_FILE%/*}"
  if [ "$_noodara_dwsl_dir" = "$NOODARA_DOCKER_SOURCES_FILE" ]; then
    _noodara_dwsl_dir="."
  fi
  _noodara_dwsl_tmp="${_noodara_dwsl_dir}/.noodara-docker-sources-tmp.$$"
  if ! printf 'deb [arch=%s signed-by=%s/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$_noodara_dwsl_arch" "$NOODARA_DOCKER_KEYRING_DIR" "$_noodara_dwsl_codename" > "$_noodara_dwsl_tmp"; then
    rm -f "$_noodara_dwsl_tmp"
    _noodara_did_fail_step "write the apt sources list"
  fi
  if ! mv "$_noodara_dwsl_tmp" "$NOODARA_DOCKER_SOURCES_FILE"; then
    rm -f "$_noodara_dwsl_tmp"
    _noodara_did_fail_step "write the apt sources list"
  fi
}

noodara_docker_apt_install_engine() {
  _noodara_did_install_packages "install docker-ce, docker-ce-cli, containerd.io, docker-buildx-plugin and docker-compose-plugin" \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

noodara_docker_apt_install_compose_plugin() {
  _noodara_did_install_packages "install docker-compose-plugin" docker-compose-plugin
}

# Full installation sequence (06-CONTEXT.md D-14), one named step at a time, in exactly this
# order -- never chained with && inside one function, since set -e plus one command per function
# is what gives each step its own attributable failure message (T-06-40):
#   remove conflicting packages -> apt-get update -> install ca-certificates/curl/gnupg ->
#   create the keyring directory -> download the GPG key -> chmod it -> write the sources list ->
#   apt-get update -> install docker-ce/docker-ce-cli/containerd.io/docker-buildx-plugin/
#   docker-compose-plugin. This translates the identical sequence
#   tests/integration/images/sshd-ubuntu-22.04/Dockerfile already builds successfully in CI
#   (06-RESEARCH.md Pattern 5) from Dockerfile RUN/if syntax into POSIX sh.
noodara_install_docker() {
  noodara_step "Installing Docker Engine from Docker's official apt repository..."
  noodara_docker_remove_conflicting_packages
  noodara_docker_apt_update
  noodara_docker_apt_install_prereqs
  noodara_docker_create_keyring_dir
  noodara_docker_download_gpg_key
  noodara_docker_chmod_gpg_key
  noodara_docker_write_sources_list
  noodara_docker_apt_update
  noodara_docker_apt_install_engine
}

# Installs only the Compose plugin, reusing the same trusted-repository setup (idempotent: an
# already-present keyring file or sources line is simply overwritten with identical content)
# rather than assuming a prior noodara_install_docker run configured it -- Docker Engine may be
# present through a route this installer never controlled.
noodara_ensure_compose_plugin() {
  noodara_step "Installing the Docker Compose plugin from Docker's official apt repository..."
  noodara_docker_apt_update
  noodara_docker_create_keyring_dir
  noodara_docker_download_gpg_key
  noodara_docker_chmod_gpg_key
  noodara_docker_write_sources_list
  noodara_docker_apt_update
  noodara_docker_apt_install_compose_plugin
}

# Bounded, short retry (never unbounded) for `docker version` to start succeeding right after
# `apt-get install docker-ce ...` itself returns (06-12-PLAN.md Task 2, D-14/INST-01). apt's own
# docker-ce postinst starts docker.service ASYNCHRONOUSLY -- via systemd on a real host, and not at
# all on a bare privileged container with no init system (exactly the no-Docker installer-DinD
# fixture this plan's own preflight-scenarios.test.ts exercises, where a background watcher starts
# dockerd itself once the binary appears). Checking `docker version` in the exact instant apt-get
# returns can race a daemon that is still starting, on EITHER kind of host -- this applies to every
# real install, not just the test fixture (hard_rule's own instruction: a general, unit-tested,
# bounded wait, never a test-only branch). Overridable only for tests, matching this file's other
# NOODARA_*_WAIT_ATTEMPTS/INTERVAL constants (NOODARA_HEALTH_WAIT_ATTEMPTS/INTERVAL, above).
readonly NOODARA_DOCKER_READY_WAIT_ATTEMPTS="${NOODARA_DOCKER_READY_WAIT_ATTEMPTS:-10}"
readonly NOODARA_DOCKER_READY_WAIT_INTERVAL="${NOODARA_DOCKER_READY_WAIT_INTERVAL:-1}"

noodara_wait_for_docker_ready() {
  _noodara_wfdr_attempt=0
  _noodara_wfdr_ready=1
  while [ "$_noodara_wfdr_attempt" -lt "$NOODARA_DOCKER_READY_WAIT_ATTEMPTS" ]; do
    if noodara_docker_present; then
      _noodara_wfdr_ready=0
      break
    fi
    _noodara_wfdr_attempt=$(awk -v n="$_noodara_wfdr_attempt" 'BEGIN { print n + 1 }')
    if [ "$_noodara_wfdr_attempt" -lt "$NOODARA_DOCKER_READY_WAIT_ATTEMPTS" ]; then
      sleep "$NOODARA_DOCKER_READY_WAIT_INTERVAL"
    fi
  done
  return "$_noodara_wfdr_ready"
}

# Orchestrator (INST-01, D-14): installs Docker Engine and/or the Compose plugin only when
# missing. An already-present Docker Engine and Compose plugin are left completely alone -- zero
# apt/gpg/file-write calls -- so a re-run never reinstalls, upgrades or restarts a running Docker
# daemon and the stack it is running (T-06-39). Fails with reason compose-plugin-missing (exit 21)
# when the plugin is still missing after an install was attempted, and docker-install-failed
# (exit 20) when Docker Engine itself is still absent after the full sequence.
#
# Post-execution fix (orchestrator audit Finding 2): before ever running an apt/gpg/file-write
# operation, distinguishes "Docker is genuinely absent" from "a docker binary is present but its
# daemon is not responding" (noodara_docker_binary_present, above). Treating the latter as
# "absent" used to run the full removal-then-reinstall sequence against an operator's existing
# Docker installation -- including removing their docker.io/containerd/etc. packages uninvited --
# and still fail, since nothing in that sequence starts a stopped daemon. Fails outright with
# reason docker-daemon-unavailable (exit 22), naming the fix (start the daemon, re-run), with zero
# side effects.
noodara_ensure_docker() {
  if noodara_docker_present && noodara_compose_present; then
    noodara_note "Docker Engine and the Compose plugin are already installed; nothing to do."
    return 0
  fi

  if ! noodara_docker_present && noodara_docker_binary_present; then
    noodara_fail docker-daemon-unavailable "Docker is installed but its daemon is not responding. Start it (sudo systemctl start docker) and re-run this installer."
  fi

  if noodara_docker_present; then
    noodara_ensure_compose_plugin
    if ! noodara_compose_present; then
      noodara_fail compose-plugin-missing "Docker Engine is present but the Compose plugin (docker compose) is still missing after installation. Install it manually and re-run this installer."
    fi
    return 0
  fi

  noodara_install_docker
  if ! noodara_wait_for_docker_ready; then
    noodara_fail docker-install-failed "Docker Engine installation completed but 'docker version' still fails. Check the output above and try installing manually."
  fi
  if ! noodara_compose_present; then
    noodara_fail compose-plugin-missing "Docker Engine was installed but the Compose plugin (docker compose) is still missing. Install it manually and re-run this installer."
  fi
  noodara_step "Docker Engine and the Compose plugin installed successfully."
}

# .env generation (06-CONTEXT.md D-10/D-11, INST-01/INST-02/INST-05). Secrets are generated fresh
# per installation via `openssl rand` -- never a literal or fallback value anywhere in this file
# (T-06-03, Dokploy CVE-2026-24840 precedent).

# Injection guards, called at every .env write boundary before the first byte of that write
# (post-06-04 security fix, orchestrator audit Finding A). A value containing an embedded LF or CR
# would otherwise inject an extra `.env` line past the intended `KEY=` assignment -- e.g. a
# NOODARA_ADMIN_PASSWORD of `pw\nNOODARA_MASTER_KEY=attacker` silently appending a second,
# attacker-chosen NOODARA_MASTER_KEY line that a last-wins parser would prefer. Detection uses a
# `case` pattern against a literal embedded newline / a CR obtained via `printf '\r'` -- never
# `$'...'` or `[[ ]]` (neither is POSIX, `scripts/check-posix-sh.mjs` rejects both).

# Fails with reason env-write-failed, naming `_noodara_ael_name` but never echoing
# `_noodara_ael_value` (T-06-24's own precedent: a value here may be a password), when the value
# contains an embedded LF or CR. Parameter names are deliberately namespaced and unlike every
# other function in this file (`path`, `key`, `value`, ...): this file has no `local` (strict
# POSIX sh), so every "variable" is process-global, and this guard is called from inside other
# functions that already have their own `value`/`key` globals in scope at the call site --
# generic parameter names here would silently clobber the caller's own variable of the same name
# the moment this function ran, corrupting the very value the caller goes on to write.
noodara_env_assert_single_line() {
  _noodara_ael_name="$1"
  _noodara_ael_value="$2"
  _noodara_ael_cr=$(printf '\r')
  case "$_noodara_ael_value" in
    *"
"*)
      noodara_fail env-write-failed "$_noodara_ael_name must not contain a newline. Refusing to write .env."
      ;;
    *"$_noodara_ael_cr"*)
      noodara_fail env-write-failed "$_noodara_ael_name must not contain a carriage return. Refusing to write .env."
      ;;
  esac
}

# Fails with reason env-write-failed, naming `_noodara_aeq_name` but never echoing
# `_noodara_aeq_value`, when the value contains a literal single quote. Called only for values
# this file writes single-quoted into `.env` (Finding B, below): unlike POSIX shell, Docker
# Compose's own `.env` parser has no escape sequence for a quote embedded inside a single-quoted
# value, so such a value cannot be written safely at all -- rejecting it outright beats emitting a
# `.env` that silently truncates it. Namespaced parameter names for the same global-scope reason
# as noodara_env_assert_single_line above.
noodara_env_assert_no_single_quote() {
  _noodara_aeq_name="$1"
  _noodara_aeq_value="$2"
  case "$_noodara_aeq_value" in
    *"'"*)
      noodara_fail env-write-failed "$_noodara_aeq_name must not contain a single quote character. Choose a value without one and re-run this installer."
      ;;
  esac
}

# Admin password policy mirror (orchestrator audit WR-04, design decision -- recorded in
# STATE.md). packages/domain/src/validators/password.ts's `validatePassword` is the single real
# source of truth, enforced by the control plane at boot (bootstrap-admin.ts's preseedAdmin) --
# but that enforcement happens only after `docker compose up`, so a policy-violating
# NOODARA_ADMIN_PASSWORD previously surfaced as an opaque exit 53 only after this installer's full
# NOODARA_HEALTH_WAIT_ATTEMPTS x NOODARA_HEALTH_WAIT_INTERVAL budget (5 minutes by default)
# elapsed. install.sh cheaply and stably mirrors only the two parts of that policy that are fixed
# and simple enough not to drift silently: the minimum length, and the equals-identifier rule.
# Deliberately NOT mirrored here: the common-password list (packages/domain/src/validators/
# common-passwords.ts) -- a data file, not a stable constant, that a shell copy would eventually
# drift from; docs/install.md instead tells the operator that check happens at control-plane boot
# and surfaces as exit 53 with the real reason in the `api` service's own log tail.
#
# tests/unit/installer/admin-password-policy.test.ts's own guard test extracts
# PASSWORD_MIN_LENGTH's real numeric value out of password.ts's TypeScript source at test time and
# asserts it equals the constant below, so the two can never silently drift apart.
readonly NOODARA_ADMIN_PASSWORD_MIN_LENGTH=12

# Fails with reason env-write-failed, naming the violated rule but never echoing
# `_noodara_vap_password`, when NOODARA_ADMIN_PASSWORD is shorter than
# NOODARA_ADMIN_PASSWORD_MIN_LENGTH or equals the admin email address (or its local part),
# case-insensitively -- matching validatePassword's own PASSWORD_TOO_SHORT/
# PASSWORD_EQUALS_IDENTIFIER checks. `${#value}` counts BYTES under dash/POSIX sh, never Unicode
# characters: for a password containing multi-byte UTF-8 characters the byte count is always >=
# the character count, so this check can only ever ACCEPT a password that is genuinely too short
# in real characters (a false accept), never REJECT one that is genuinely long enough (a false
# reject) -- the real, character-accurate rejection still happens in the control plane at boot.
# That is the safe direction for a fast, best-effort shell-side pre-filter to err in.
noodara_validate_admin_password_policy() {
  _noodara_vap_email="$1"
  _noodara_vap_password="$2"

  if [ "${#_noodara_vap_password}" -lt "$NOODARA_ADMIN_PASSWORD_MIN_LENGTH" ]; then
    noodara_fail env-write-failed "NOODARA_ADMIN_PASSWORD must be at least ${NOODARA_ADMIN_PASSWORD_MIN_LENGTH} characters (the control plane's admin password policy). Choose a longer password and re-run this installer."
  fi

  _noodara_vap_email_lower=$(printf '%s' "$_noodara_vap_email" | tr 'A-Z' 'a-z')
  _noodara_vap_password_lower=$(printf '%s' "$_noodara_vap_password" | tr 'A-Z' 'a-z')
  _noodara_vap_local_part="${_noodara_vap_email_lower%%@*}"
  if [ "$_noodara_vap_password_lower" = "$_noodara_vap_email_lower" ] || [ "$_noodara_vap_password_lower" = "$_noodara_vap_local_part" ]; then
    noodara_fail env-write-failed "NOODARA_ADMIN_PASSWORD must not equal the admin email address, or the part of it before the @ (the control plane's admin password policy). Choose a different password and re-run this installer."
  fi
}

# Generates a fresh random secret. `base64` decodes to exactly 32 raw bytes -- the only shape
# apps/control-plane/src/env.ts's NOODARA_MASTER_KEY validator accepts. `hex` is 64 lowercase hex
# characters and is the shape every other generated secret must use: a base64 secret's '/', '+' or
# '=' characters corrupt DATABASE_URL/REDIS_URL when `new URL()` parses them (proven by this
# plan's own negative-control test in tests/integration/installer/env-contract.test.ts), while hex
# characters are all URL-unreserved and always round-trip byte-for-byte.
noodara_generate_secret() {
  kind="$1"
  case "$kind" in
    base64)
      openssl rand -base64 32
      ;;
    hex)
      openssl rand -hex 32
      ;;
    *)
      printf 'noodara: internal error: unknown secret kind %s\n' "$kind" >&2
      exit 99
      ;;
  esac
}

# Compose-internal hostname/port/role/database name are hardcoded here deliberately -- these are
# the production Compose service names (Plan 06-07), never exposed to the host
# (06-CONTEXT.md D-10/same-origin), so there is nothing here for an operator to override.
noodara_build_database_url() {
  password="$1"
  printf 'postgresql://noodara:%s@postgres:5432/noodara\n' "$password"
}

noodara_build_redis_url() {
  password="$1"
  printf 'redis://:%s@redis:6379\n' "$password"
}

# Re-asserts mode 600 and root:root ownership on an existing .env -- called on every run, not
# only at creation (06-RESEARCH.md Security Domain: mode/ownership drift after a manual operator
# edit). Tolerates running as a non-root caller (this file's own unit tests, run on a macOS dev
# machine) by only escalating a chown failure to a fatal error when the caller genuinely is root
# (the real /opt/noodara target) -- a non-root caller failing to chown is expected and swallowed.
noodara_secure_env_file() {
  path="$1"
  chmod 600 "$path"
  if chown root:root "$path" 2>/dev/null; then
    return 0
  fi
  if [ "$(id -u)" = "0" ]; then
    noodara_fail env-write-failed "Failed to set root ownership on $path."
  fi
  return 0
}

# Generates a fresh, complete .env for a new installation (06-CONTEXT.md D-10/D-11, INST-01/
# INST-02/INST-05). Writes under `umask 077` before the first redirect so the file is never
# briefly world-readable between creation and chmod, then re-asserts mode/ownership via
# noodara_secure_env_file. NOODARA_ADMIN_EMAIL/NOODARA_ADMIN_PASSWORD are read from the
# environment (never as positional args, so they never appear in a process listing of this
# function's own invocation) and written only when both are present (D-04); when only one is set,
# a warning names both variable names and never the value (T-06-24).
noodara_generate_env() {
  env_path="$1"
  public_url="$2"
  port="$3"
  version="$4"
  image_prefix="$5"

  # Validate every operator-influenced value before any write -- including before the parent
  # directory is created -- so a rejected value never leaves a partial .env or a stray temp file
  # behind (Finding A). NOODARA_PUBLIC_URL/NOODARA_ADMIN_EMAIL/NOODARA_ADMIN_PASSWORD are also
  # checked for an embedded single quote because they are written single-quoted below (Finding B).
  noodara_env_assert_single_line NOODARA_PUBLIC_URL "$public_url"
  noodara_env_assert_no_single_quote NOODARA_PUBLIC_URL "$public_url"
  noodara_env_assert_single_line NOODARA_PORT "$port"
  noodara_env_assert_single_line NOODARA_VERSION "$version"
  noodara_env_assert_single_line NOODARA_IMAGE_PREFIX "$image_prefix"
  if [ -n "${NOODARA_ADMIN_EMAIL:-}" ]; then
    noodara_env_assert_single_line NOODARA_ADMIN_EMAIL "$NOODARA_ADMIN_EMAIL"
    noodara_env_assert_no_single_quote NOODARA_ADMIN_EMAIL "$NOODARA_ADMIN_EMAIL"
  fi
  if [ -n "${NOODARA_ADMIN_PASSWORD:-}" ]; then
    noodara_env_assert_single_line NOODARA_ADMIN_PASSWORD "$NOODARA_ADMIN_PASSWORD"
    noodara_env_assert_no_single_quote NOODARA_ADMIN_PASSWORD "$NOODARA_ADMIN_PASSWORD"
  fi
  # WR-04: mirrors the control plane's own length/equals-identifier admin password policy
  # up front, before anything is written -- see noodara_validate_admin_password_policy's own
  # comment for exactly what is (and is deliberately not) mirrored here.
  if [ -n "${NOODARA_ADMIN_EMAIL:-}" ] && [ -n "${NOODARA_ADMIN_PASSWORD:-}" ]; then
    noodara_validate_admin_password_policy "$NOODARA_ADMIN_EMAIL" "$NOODARA_ADMIN_PASSWORD"
  fi

  env_dir="${env_path%/*}"
  if [ "$env_dir" = "$env_path" ]; then
    env_dir="."
  fi
  if [ ! -d "$env_dir" ]; then
    (umask 077 && mkdir -p "$env_dir") || noodara_fail env-write-failed "Failed to create $env_dir."
  fi

  master_key=$(noodara_generate_secret base64)
  auth_secret=$(noodara_generate_secret hex)
  pg_password=$(noodara_generate_secret hex)
  redis_password=$(noodara_generate_secret hex)
  database_url=$(noodara_build_database_url "$pg_password")
  redis_url=$(noodara_build_redis_url "$redis_password")

  tmp_file="${env_path}.tmp.$$"
  (
    umask 077
    {
      printf '# NOODARA_VERSION pins the exact release tag (D-04) -- never :latest, so a restart never\n'
      printf '# silently changes version.\n'
      printf 'NOODARA_VERSION=%s\n' "$version"
      printf '# NOODARA_PREVIOUS_VERSION records the version this installation was upgraded from,\n'
      printf '# so D-12'"'"'s rollback hint (NOODARA_VERSION=<previous>) has a real number to name.\n'
      printf 'NOODARA_PREVIOUS_VERSION=%s\n' "$version"
      printf 'NOODARA_IMAGE_PREFIX=%s\n' "$image_prefix"
      printf 'NOODARA_PORT=%s\n' "$port"
      # Single-quoted (Finding B): Docker Compose's own .env parser interpolates $VAR/${VAR} and
      # treats an unquoted or double-quoted value's ' #' as an inline comment -- a single-quoted
      # value is the one shape that parser takes fully literally. noodara_env_assert_no_single_quote
      # above already ruled out the one case a POSIX single-quoted value cannot represent.
      printf "NOODARA_PUBLIC_URL='%s'\n" "$public_url"
      printf 'NOODARA_MASTER_KEY=%s\n' "$master_key"
      printf 'BETTER_AUTH_SECRET=%s\n' "$auth_secret"
      printf 'POSTGRES_USER=noodara\n'
      printf 'POSTGRES_PASSWORD=%s\n' "$pg_password"
      printf 'POSTGRES_DB=noodara\n'
      printf 'REDIS_PASSWORD=%s\n' "$redis_password"
      printf 'DATABASE_URL=%s\n' "$database_url"
      printf 'REDIS_URL=%s\n' "$redis_url"
      printf '# PORT is the api service'"'"'s internal port, baked into the web image'"'"'s proxy target --\n'
      printf '# do not change it.\n'
      printf 'PORT=3000\n'
      case "$public_url" in
        http://*)
          printf '# NOODARA_COOKIE_INSECURE exists only because the panel is served over plain HTTP --\n'
          printf '# remove it once a TLS proxy is in front (D-05).\n'
          printf 'NOODARA_COOKIE_INSECURE=true\n'
          ;;
      esac
    } > "$tmp_file"
  )

  if [ -n "${NOODARA_ADMIN_EMAIL:-}" ] && [ -n "${NOODARA_ADMIN_PASSWORD:-}" ]; then
    (
      umask 077
      {
        # Single-quoted for the same reason as NOODARA_PUBLIC_URL above (Finding B) -- an admin
        # password is exactly the value most likely to contain '$', '#' or a space.
        printf "NOODARA_ADMIN_EMAIL='%s'\n" "$NOODARA_ADMIN_EMAIL"
        printf "NOODARA_ADMIN_PASSWORD='%s'\n" "$NOODARA_ADMIN_PASSWORD"
      } >> "$tmp_file"
    )
  elif [ -n "${NOODARA_ADMIN_EMAIL:-}" ] || [ -n "${NOODARA_ADMIN_PASSWORD:-}" ]; then
    noodara_warn "NOODARA_ADMIN_EMAIL and NOODARA_ADMIN_PASSWORD must both be set, or neither -- ignoring the one that was provided."
  fi

  mv "$tmp_file" "$env_path"
  noodara_secure_env_file "$env_path"
}

# Additive merge and timestamped backup for an existing .env (06-CONTEXT.md D-11, INST-02).
# Presence checks use an anchored `grep -q "^${key}="` against the file; an existing value is
# never read, re-quoted or rewritten -- this is the entire mechanism that keeps D-11 exact for a
# value containing '#', quotes, '=' or base64 padding, since its content is never parsed, only its
# key's presence is checked.

# True (exit 0) only when `path` contains a line beginning with exactly "<key>=" -- anchored so a
# key that is a suffix or prefix of another key never falsely matches.
noodara_env_has_key() {
  path="$1"
  key="$2"
  grep -q "^${key}=" "$path" 2>/dev/null
}

# Appends "<key>=<value>" as a new line only when noodara_env_has_key reports the key absent;
# returns 0 without writing when it is already present (D-11: an existing value is never touched).
#
# Post-execution fix (orchestrator audit WR-01): previously appended directly to the live file via
# `>> "$path"` -- the one `.env`-mutating writer in this file that did not follow the same
# temp-file-then-atomic-`mv` pattern every sibling writer uses. Now copies the existing content to
# a `.tmp.$$` file in the same directory under `umask 077`, appends the new line there, and only
# `mv`s it over the original once the write is proven to have succeeded -- so a write failure
# partway through (disk-full, an I/O error) can never leave a truncated/malformed line appended
# directly to the real, in-use `.env`. `cat "$path"` reproduces every existing byte exactly,
# including a file with no trailing newline: `tail -c 1` on the ORIGINAL file (read once, before
# any write) reports whether its own last byte is already a newline, so this function emits its
# own leading newline only when one is genuinely missing -- the new key always lands on its own
# line, and no existing byte, including the previous last line's own terminator, is ever altered
# beyond that.
noodara_env_append_if_missing() {
  path="$1"
  key="$2"
  value="$3"
  # Validated before the presence check, so a rejected key or value never reaches the file even
  # when the key happens to already be present (Finding A). `key` is always a literal this file's
  # own callers control, never echoed back verbatim in its own failure message; `value` is named
  # by `key` once `key` itself is proven single-line.
  noodara_env_assert_single_line "the key argument to noodara_env_append_if_missing" "$key"
  noodara_env_assert_single_line "$key" "$value"
  if noodara_env_has_key "$path" "$key"; then
    return 0
  fi

  dir="${path%/*}"
  if [ "$dir" = "$path" ]; then
    dir="."
  fi
  tmp_file="${dir}/.noodara-env-append-tmp.$$"
  _noodara_eaim_last=$(tail -c 1 "$path" 2>/dev/null)
  if ! (
    umask 077
    cat "$path"
    if [ -n "$_noodara_eaim_last" ]; then
      printf '\n'
    fi
    printf '%s=%s\n' "$key" "$value"
  ) > "$tmp_file"; then
    rm -f "$tmp_file"
    noodara_fail env-write-failed "Failed to append $key to $path."
  fi
  if ! mv "$tmp_file" "$path"; then
    rm -f "$tmp_file"
    noodara_fail env-write-failed "Failed to append $key to $path."
  fi
}

# Copies `path` to `<path>.bak-<YYYYmmddHHMMSS>` and chmods the copy 600 -- written before any
# mutation of an existing .env (D-11).
noodara_backup_env() {
  path="$1"
  backup_path="${path}.bak-$(date +%Y%m%d%H%M%S)"
  cp "$path" "$backup_path"
  chmod 600 "$backup_path"
  printf '%s\n' "$backup_path"
}

# Rewrites the single line anchored on "^<key>=" to "<key>=<value>", leaving every other line
# byte-identical. Used only for NOODARA_VERSION and NOODARA_PREVIOUS_VERSION (D-12's rollback
# hint). Writes to a temp file in the same directory under `umask 077`, then `mv`s over the
# original, so a crash mid-write can never leave a truncated .env (T-06-23).
noodara_set_env_value() {
  path="$1"
  key="$2"
  value="$3"

  noodara_env_assert_single_line "$key" "$value"

  dir="${path%/*}"
  if [ "$dir" = "$path" ]; then
    dir="."
  fi
  tmp_file="${dir}/.noodara-env-tmp.$$"
  # Post-execution fix (orchestrator audit WR-02): the awk write and the final `mv` now each have
  # their own named `noodara_fail env-write-failed` on failure, and the temp file -- a full copy
  # of `.env`, mode 600, still containing every secret -- is removed on either failure, matching
  # noodara_docker_download_gpg_key/noodara_docker_write_sources_list's own precedent. Never
  # echoes `value` in the failure message, only `key` (a literal this file's own callers control).
  if ! (
    umask 077
    # `key`/`value` are passed through ENVIRON, never `awk -v` -- `awk -v`'s assignment operand
    # goes through the same backslash-escape processing as a string constant, so a value
    # containing a literal two-character `\n` sequence would silently become a real newline
    # (a second injection path into the very line this function rewrites). ENVIRON values are not
    # escape-processed.
    NOODARA_SET_ENV_KEY="$key" NOODARA_SET_ENV_VALUE="$value" awk '
      BEGIN { k = ENVIRON["NOODARA_SET_ENV_KEY"]; v = ENVIRON["NOODARA_SET_ENV_VALUE"]; pattern = "^" k "=" }
      $0 ~ pattern { print k "=" v; next }
      { print }
    ' "$path" > "$tmp_file"
  ); then
    rm -f "$tmp_file"
    noodara_fail env-write-failed "Failed to write $key to $path."
  fi
  if ! mv "$tmp_file" "$path"; then
    rm -f "$tmp_file"
    noodara_fail env-write-failed "Failed to write $key to $path."
  fi
}

# Additive merge over an existing .env: backs up once before any write, rewrites only the
# NOODARA_VERSION line via noodara_set_env_value, then appends any given "<key> <value>" pairs
# only when genuinely missing (D-11's "a release-added required variable is appended without
# touching existing ones"). Re-secures mode/ownership after the last write. Extra pairs whose key
# is already present are safe no-ops, so a caller may pass the full current variable set every
# time without special-casing "what changed".
noodara_merge_env() {
  path="$1"
  version="$2"
  shift 2

  noodara_backup_env "$path" >/dev/null

  noodara_set_env_value "$path" NOODARA_VERSION "$version"

  while [ "$#" -ge 2 ]; do
    key="$1"
    value="$2"
    noodara_env_append_if_missing "$path" "$key" "$value"
    shift 2
  done

  noodara_secure_env_file "$path"
}

# Version, public URL and image-prefix resolution (06-CONTEXT.md D-04/D-07/D-19, INST-01): the
# three values this installer cannot know in advance -- which release to install, what public URL
# the panel is reachable at, and which image registry/tag prefix to pull from.

# The single seam every network call in this file goes through -- no other function may call
# `curl` directly (enforced by a grep-count acceptance criterion, 06-06-PLAN.md Task 1; the POSIX
# gate itself does not enforce this). `mode` is `body` (prints the response body, following
# redirects) or `redirect` (prints the final redirect target WITHOUT following it). Every call is
# bounded by NOODARA_FETCH_TIMEOUT/15s and restricted to TLS 1.2+ https (T-06-31, hard_rule #8) --
# this is the one place a hostile or slow remote can influence what gets installed, so it is also
# the one place those protections need to live.
#
# Post-execution fix (orchestrator audit Finding 1, empirically verified against real curl 8.7.1):
# redirect mode must NEVER pass -L/--location. With -L, curl follows the redirect itself, so
# `%{redirect_url}` is empty after the final 200 -- `curl -fsSL -o /dev/null -w
# '%{redirect_url}' <releases/latest URL>` printed `[]` (empty), while the same call without -L
# printed the real `https://github.com/<owner>/<repo>/releases/tag/<tag>` target. The old `-fsSL`
# in redirect mode made the "primary" resolution path dead code in production: every real install
# silently fell through to the rate-limited api.github.com path. `body` mode legitimately needs to
# follow redirects (an IP-echo service or a real API response may itself redirect), so it keeps
# -L and additionally pins `--proto-redir '=https'` (Finding 3) so a followed redirect can never
# downgrade the connection to plain http -- `--proto` alone only pins the initial request.
noodara_fetch_url() {
  _noodara_ffu_mode="$1"
  _noodara_ffu_url="$2"
  case "$_noodara_ffu_mode" in
    body)
      curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout "$NOODARA_FETCH_TIMEOUT" --max-time 15 "$_noodara_ffu_url"
      ;;
    redirect)
      curl -fsS -o /dev/null -w '%{redirect_url}' --proto '=https' --tlsv1.2 --connect-timeout "$NOODARA_FETCH_TIMEOUT" --max-time 15 "$_noodara_ffu_url"
      ;;
    *)
      printf 'noodara: internal error: unknown fetch mode %s\n' "$_noodara_ffu_mode" >&2
      exit 99
      ;;
  esac
}

# Strips a single leading "v" from a version tag if present -- normalised exactly once, before
# validation, so .env's NOODARA_VERSION and the image tag this installer pulls always agree
# (06-CONTEXT.md D-04).
noodara_normalize_tag() {
  case "$1" in
    v*) printf '%s\n' "${1#v}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# Fails with reason version-resolution-failed (exit 40), naming the allowed character set but
# never the rejected value itself, unless the tag is 1-128 characters, its first character is
# [A-Za-z0-9_], every character is [A-Za-z0-9_.-], and it is not the literal "latest". Applied
# unconditionally to every source of a version tag -- operator override, redirect tail, API body
# -- after normalisation (T-06-30): a newline here would otherwise inject an extra line into
# .env; a `/` or `:` would redirect the image reference `docker pull` resolves.
noodara_validate_tag() {
  _noodara_vt_tag="$1"
  case "$_noodara_vt_tag" in
    '')
      noodara_fail version-resolution-failed "Resolved version tag is empty. Set NOODARA_VERSION to a valid release tag (first character [A-Za-z0-9_], remaining characters [A-Za-z0-9_.-], 1-128 characters total)."
      ;;
    latest)
      noodara_fail version-resolution-failed "Resolved version tag must not be 'latest'. Set NOODARA_VERSION to an explicit release tag."
      ;;
  esac
  case "$_noodara_vt_tag" in
    [!A-Za-z0-9_]*)
      noodara_fail version-resolution-failed "Resolved version tag has an invalid first character. Allowed: first character [A-Za-z0-9_], remaining characters [A-Za-z0-9_.-], 1-128 characters total."
      ;;
  esac
  case "$_noodara_vt_tag" in
    *[!A-Za-z0-9_.-]*)
      noodara_fail version-resolution-failed "Resolved version tag contains a disallowed character. Allowed: first character [A-Za-z0-9_], remaining characters [A-Za-z0-9_.-], 1-128 characters total."
      ;;
  esac
  if [ "${#_noodara_vt_tag}" -gt 128 ]; then
    noodara_fail version-resolution-failed "Resolved version tag is too long. Allowed: first character [A-Za-z0-9_], remaining characters [A-Za-z0-9_.-], 1-128 characters total."
  fi
}

# Resolves the release tag to install (06-CONTEXT.md D-04): NOODARA_VERSION when the operator set
# it (normalised and validated like any other source, zero network calls); otherwise the
# `releases/latest` redirect tail (primary -- hits github.com, not api.github.com, so it does not
# consume the unauthenticated REST API's rate limit, 06-RESEARCH.md Assumption A1); otherwise the
# GitHub REST API response, sed-parsed line-by-line (never with `jq`, `grep -P` or a hand-rolled
# JSON parser -- a match requires the whole "tag_name": "..." pair on one physical line, which
# also means a value straddling a real newline, or a body with no matching line at all -- HTML,
# empty, truncated -- simply extracts nothing). Fails with reason version-resolution-failed
# (exit 40) naming NOODARA_VERSION as the manual remedy when every source fails.
noodara_resolve_version() {
  if [ -n "${NOODARA_VERSION:-}" ]; then
    _noodara_rv_tag=$(noodara_normalize_tag "$NOODARA_VERSION")
    noodara_validate_tag "$_noodara_rv_tag"
    printf '%s\n' "$_noodara_rv_tag"
    return 0
  fi

  # Post-execution fix (orchestrator audit Finding 2): a repository with no published release
  # answers `releases/latest` with a 302 to `.../releases` (no `/tag/<tag>` at all) --
  # `awk -F/ '{print $NF}'` on that target used to yield the bogus tag "releases", which passed
  # noodara_validate_tag's character-class check unmodified (every character in "releases" is
  # allowed). Only the exact shape
  # https://github.com/<owner>/<repo>/releases/tag/<tag> for the configured owner/repo may ever be
  # accepted -- a prefix match on the full expected prefix, with the remainder rejected if it
  # contains a further `/`, `?` or `#` (an extra path segment, a query string, or a fragment are
  # never part of a genuine tag). Anything else -- the no-release case, a login redirect, another
  # host, another repo -- falls through to the API path exactly like a redirect failure would.
  _noodara_rv_redirect=$(noodara_fetch_url redirect "https://github.com/${NOODARA_REPO_OWNER}/${NOODARA_REPO_NAME}/releases/latest" 2>/dev/null) || _noodara_rv_redirect=""
  if [ -n "$_noodara_rv_redirect" ]; then
    _noodara_rv_prefix="https://github.com/${NOODARA_REPO_OWNER}/${NOODARA_REPO_NAME}/releases/tag/"
    case "$_noodara_rv_redirect" in
      "$_noodara_rv_prefix"*)
        _noodara_rv_raw="${_noodara_rv_redirect#"$_noodara_rv_prefix"}"
        case "$_noodara_rv_raw" in
          *'/'* | *'?'* | *'#'*)
            _noodara_rv_raw=""
            ;;
        esac
        ;;
      *)
        _noodara_rv_raw=""
        ;;
    esac
    if [ -n "$_noodara_rv_raw" ]; then
      _noodara_rv_tag=$(noodara_normalize_tag "$_noodara_rv_raw")
      noodara_validate_tag "$_noodara_rv_tag"
      printf '%s\n' "$_noodara_rv_tag"
      return 0
    fi
  fi

  _noodara_rv_body=$(noodara_fetch_url body "https://api.github.com/repos/${NOODARA_REPO_OWNER}/${NOODARA_REPO_NAME}/releases/latest" 2>/dev/null) || _noodara_rv_body=""
  if [ -n "$_noodara_rv_body" ]; then
    _noodara_rv_raw=$(printf '%s\n' "$_noodara_rv_body" | sed -n 's/.*"tag_name"[ 	]*:[ 	]*"\([^"]*\)".*/\1/p' | head -n 1)
    if [ -n "$_noodara_rv_raw" ]; then
      _noodara_rv_tag=$(noodara_normalize_tag "$_noodara_rv_raw")
      noodara_validate_tag "$_noodara_rv_tag"
      printf '%s\n' "$_noodara_rv_tag"
      return 0
    fi
  fi

  noodara_fail version-resolution-failed "Could not resolve the latest release version automatically. Set NOODARA_VERSION=<tag> and re-run this installer."
}

# Resolves the GHCR image prefix (06-CONTEXT.md D-01/D-19): NOODARA_REGISTRY/NOODARA_REPO_OWNER by
# default, or the undocumented, test-only NOODARA_INTERNAL_IMAGE_PREFIX override when set --
# letting the Docker-in-Docker layer-2 suite (Plan 06-10) point at locally built images with no
# registry. Setting the override also implies skipping `docker pull` (the flag Plan 06-09 reads);
# never documented in docs/install.md (T-06-32). The override is still validated even though it is
# test-only, since it lands in .env and in image references: no whitespace, double quote, single
# quote, dollar sign, backtick or embedded newline/CR.
noodara_resolve_image_prefix() {
  if [ -n "${NOODARA_INTERNAL_IMAGE_PREFIX:-}" ]; then
    noodara_env_assert_single_line NOODARA_INTERNAL_IMAGE_PREFIX "$NOODARA_INTERNAL_IMAGE_PREFIX"
    noodara_env_assert_no_single_quote NOODARA_INTERNAL_IMAGE_PREFIX "$NOODARA_INTERNAL_IMAGE_PREFIX"
    case "$NOODARA_INTERNAL_IMAGE_PREFIX" in
      *' '*)
        noodara_fail env-write-failed "NOODARA_INTERNAL_IMAGE_PREFIX must not contain a space."
        ;;
    esac
    case "$NOODARA_INTERNAL_IMAGE_PREFIX" in
      *'"'*)
        noodara_fail env-write-failed "NOODARA_INTERNAL_IMAGE_PREFIX must not contain a double quote."
        ;;
    esac
    case "$NOODARA_INTERNAL_IMAGE_PREFIX" in
      *"\$"*)
        noodara_fail env-write-failed "NOODARA_INTERNAL_IMAGE_PREFIX must not contain a dollar sign."
        ;;
    esac
    case "$NOODARA_INTERNAL_IMAGE_PREFIX" in
      *'`'*)
        noodara_fail env-write-failed "NOODARA_INTERNAL_IMAGE_PREFIX must not contain a backtick."
        ;;
    esac
    printf '%s\n' "$NOODARA_INTERNAL_IMAGE_PREFIX"
    return 0
  fi
  printf '%s\n' "${NOODARA_REGISTRY}/${NOODARA_REPO_OWNER}"
}

# Loose shape check for a plain IPv4 address (06-CONTEXT.md D-07, T-06-29): rejects an HTML
# captive-portal body or an empty response from a public-IP service, without attempting full RFC
# validation -- a `case` pattern over dot-separated digit groups, deliberately not a regex.
#
# Post-execution tightening (optional, orchestrator audit): the original digits-and-dots-only
# check accepted "1.2.3.4.5" (five groups), "1..2.3" (an empty group) and "9999.9999.9999.9999"
# (out-of-range groups) -- never an injection risk (the value only ever flows into a URL string,
# already length/character-bounded by callers), just a broken shape check. Tightened to exactly
# four groups, each 1-3 digits, each <= 255, via a POSIX IFS field split (no regex interval
# expressions, which are not universally supported by every awk this file might run under).
noodara_looks_like_ipv4() {
  case "$1" in
    *[!0-9.]*)
      return 1
      ;;
  esac
  _noodara_liv4_oldifs="$IFS"
  IFS='.'
  set -- $1
  IFS="$_noodara_liv4_oldifs"
  if [ "$#" -ne 4 ]; then
    return 1
  fi
  for _noodara_liv4_octet in "$1" "$2" "$3" "$4"; do
    case "$_noodara_liv4_octet" in
      '' | ????*)
        return 1
        ;;
    esac
    if [ "$_noodara_liv4_octet" -gt 255 ]; then
      return 1
    fi
  done
  return 0
}

# Tries https://ifconfig.io, then https://icanhazip.com, then https://ipecho.net/plain, each
# through noodara_fetch_url, stopping at the first response that shape-validates as a plain IPv4
# address (06-CONTEXT.md D-07, T-06-29). A non-IPv4 response (HTML, empty) never stops the chain --
# it just means the next service is tried. Returns non-zero when all three fail.
noodara_get_public_ip() {
  for _noodara_gpi_url in https://ifconfig.io https://icanhazip.com https://ipecho.net/plain; do
    _noodara_gpi_body=$(noodara_fetch_url body "$_noodara_gpi_url" 2>/dev/null) || _noodara_gpi_body=""
    if noodara_looks_like_ipv4 "$_noodara_gpi_body"; then
      printf '%s\n' "$_noodara_gpi_body"
      return 0
    fi
  done
  return 1
}

# Extracts the "src" address from `ip route get 1.1.1.1` -- the default-route local IP, D-07's
# third and final tier. Injectable via shell-function shadowing of `ip` (hard_rule #9), same as
# every other system-state probe in this file.
noodara_get_local_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1) }' | head -n 1
}

# Post-execution fix (orchestrator audit Finding 4): validates an explicit NOODARA_PUBLIC_URL
# override before it is ever returned or written to `.env`. Previously the override was returned
# completely verbatim and unvalidated -- `ftp://evil`, `javascript:alert(1)` and `not a url` all
# passed through with exit 0. Fails with reason public-url-resolution-failed (the same reason
# noodara_resolve_public_url already uses for total resolution failure), naming NOODARA_PUBLIC_URL
# and the violated rule, but never echoing the (possibly injection-laden) value itself -- the same
# never-echo discipline noodara_validate_tag already applies to version tags. D-05's exact-scheme-
# preservation guarantee still holds: this only rejects, it never rewrites the accepted value, so a
# caller who passes `https://...` still gets that exact scheme back.
noodara_validate_public_url() {
  _noodara_vpu_url="$1"
  case "$_noodara_vpu_url" in
    http://?* | https://?*)
      ;;
    *)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must start with http:// or https:// followed by a host. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
  esac
  case "$_noodara_vpu_url" in
    *' '*)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must not contain whitespace. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
  esac
  _noodara_vpu_tab=$(printf '\t')
  case "$_noodara_vpu_url" in
    *"$_noodara_vpu_tab"*)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must not contain whitespace. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
  esac
  case "$_noodara_vpu_url" in
    *"'"*)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must not contain a single quote character. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
  esac
  case "$_noodara_vpu_url" in
    *'"'*)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must not contain a double quote character. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
  esac
  case "$_noodara_vpu_url" in
    *'\'*)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must not contain a backslash. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
  esac
  case "$_noodara_vpu_url" in
    *"\$"*)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must not contain a dollar sign. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
  esac
  case "$_noodara_vpu_url" in
    *'`'*)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must not contain a backtick. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
  esac
  _noodara_vpu_cr=$(printf '\r')
  case "$_noodara_vpu_url" in
    *"
"*)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must not contain a newline. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
    *"$_noodara_vpu_cr"*)
      noodara_fail public-url-resolution-failed "NOODARA_PUBLIC_URL must not contain a carriage return. Set NOODARA_PUBLIC_URL to a valid URL and re-run this installer."
      ;;
  esac
}

# Resolves NOODARA_PUBLIC_URL (06-CONTEXT.md D-07): explicit override (returned verbatim, no
# lookup, no scheme normalisation -- D-05's cookie opt-out keys off the scheme exactly as given) >
# external public-IP service (noodara_get_public_ip) > local default-route IP
# (noodara_get_local_ip, with a warning that a private address was used). Fails with reason
# public-url-resolution-failed (exit 41) naming NOODARA_PUBLIC_URL as the manual remedy when every
# source fails.
#
# Never prints the URL twice: the one operator-facing note below (chosen URL + how to change it)
# goes to stderr, not this function's stdout return channel. This function's stdout is a strict
# single-line return contract, mirroring noodara_resolve_version/noodara_resolve_port, consumed by
# callers via `public_url=$(noodara_resolve_public_url)` -- a second stdout line here would
# silently corrupt that capture with an embedded newline, which noodara_generate_env's own
# noodara_env_assert_single_line guard exists specifically to catch. D-07 still requires telling
# the operator both the chosen URL and how to change it; stderr reaches the real terminal exactly
# the same way stdout does, without touching the return channel.
noodara_resolve_public_url() {
  if [ -n "${NOODARA_PUBLIC_URL:-}" ]; then
    noodara_validate_public_url "$NOODARA_PUBLIC_URL"
    printf '%s\n' "$NOODARA_PUBLIC_URL"
    return 0
  fi

  _noodara_rpu_port=$(noodara_resolve_port)
  _noodara_rpu_url=""

  _noodara_rpu_ip=$(noodara_get_public_ip) || _noodara_rpu_ip=""
  if [ -n "$_noodara_rpu_ip" ]; then
    _noodara_rpu_url="http://${_noodara_rpu_ip}:${_noodara_rpu_port}"
  else
    _noodara_rpu_ip=$(noodara_get_local_ip) || _noodara_rpu_ip=""
    if [ -n "$_noodara_rpu_ip" ]; then
      noodara_warn "Could not reach any public-IP service; falling back to this server's own private-network address instead. If this server is behind NAT, the panel may not be reachable at this address from outside."
      _noodara_rpu_url="http://${_noodara_rpu_ip}:${_noodara_rpu_port}"
    fi
  fi

  if [ -z "$_noodara_rpu_url" ]; then
    noodara_fail public-url-resolution-failed "Could not resolve a public URL automatically. Set NOODARA_PUBLIC_URL=<url> and re-run this installer."
  fi

  printf 'noodara: Resolved public URL: %s -- to change it, edit %s/%s (key NOODARA_PUBLIC_URL), then run: docker compose -f %s/%s up -d\n' "$_noodara_rpu_url" "$NOODARA_INSTALL_DIR" "$NOODARA_ENV_FILE" "$NOODARA_INSTALL_DIR" "$NOODARA_COMPOSE_FILE" >&2

  printf '%s\n' "$_noodara_rpu_url"
}

# Post-execution fix (orchestrator audit Finding B, 06-09 follow-up): on an existing installation,
# the public URL used everywhere downstream (the summary, the plain-HTTP warning, the ufw note) is
# the one this installation's own .env already recorded -- read via noodara_env_get_value, which
# already strips the single quotes noodara_generate_env wrote it with -- never re-resolved from
# the network. noodara_resolve_public_url's own external-IP-service/local-IP chain used to run
# unconditionally on every re-run even though .env already had the answer, which made an upgrade
# needlessly depend on outbound reachability to services this host may have no route to (an
# upgrade on such a host used to fail with exit 41 for no real reason) and, worse, could silently
# advertise a different URL than the one actually written into .env (D-11's own "existing values
# are never touched" already guarantees .env keeps the original -- this function is what makes the
# rest of the summary agree with that guarantee instead of contradicting it). An operator-supplied
# NOODARA_PUBLIC_URL that disagrees with the recorded value gets the exact same single warning as
# noodara_check_port's own port mismatch above -- .env wins, edit it to change. Falls back to a
# full noodara_resolve_public_url (network lookups included) only when .env genuinely has no
# NOODARA_PUBLIC_URL key at all -- a hand-edited or partially-written .env, never the case for a
# real installation this script itself wrote. The value read back from .env is still passed
# through noodara_validate_public_url before ever being returned or printed, since an operator may
# have hand-edited the file to something invalid.
noodara_resolve_installed_public_url() {
  _noodara_ripu_env_path="${NOODARA_INSTALL_DIR}/${NOODARA_ENV_FILE}"
  _noodara_ripu_env_url=$(noodara_env_get_value "$_noodara_ripu_env_path" NOODARA_PUBLIC_URL)
  if [ -z "$_noodara_ripu_env_url" ]; then
    noodara_resolve_public_url
    return 0
  fi
  if [ -n "${NOODARA_PUBLIC_URL:-}" ] && [ "$NOODARA_PUBLIC_URL" != "$_noodara_ripu_env_url" ]; then
    noodara_warn "NOODARA_PUBLIC_URL='$NOODARA_PUBLIC_URL' was given, but this installation already uses '$_noodara_ripu_env_url'. The existing .env always wins on a re-run -- to change it, edit ${_noodara_ripu_env_path} (key NOODARA_PUBLIC_URL), then run: docker compose -f ${NOODARA_INSTALL_DIR}/${NOODARA_COMPOSE_FILE} up -d"
  fi
  noodara_validate_public_url "$_noodara_ripu_env_url"
  printf '%s\n' "$_noodara_ripu_env_url"
}

# noodara_preflight (06-CONTEXT.md D-17, INST-03): runs every predicate above in exactly this
# order, stopping at the first failure via that predicate's own noodara_fail call --
# never a collector that accumulates every applicable cause:
#
#   root -> base commands -> OS -> architecture -> resources -> Docker-via-snap -> panel port
#
# Cheapest and most fundamental checks run first: an unsupported OS or architecture makes every
# later check meaningless (there is no point reporting a busy port on a machine Noodara cannot
# install onto at all), and the privilege/tooling gates (root, base commands) are checked before
# any system-state probe that depends on them. Wiring this into the real install flow
# (noodara_main) happens in Plan 06-09, once Docker install, .env generation and compose
# orchestration all exist -- this function alone is provably safe to call early: no predicate
# above ever writes a file or invokes a package manager (06-RESEARCH.md Pitfall 6).
noodara_preflight() {
  noodara_step "Checking system requirements..."
  noodara_check_root
  noodara_check_base_commands
  noodara_check_os
  noodara_check_arch
  noodara_check_resources
  noodara_check_docker_snap
  noodara_check_port
  noodara_step "System requirements satisfied."
}

# Install-directory bootstrap and the fresh-vs-upgrade branch (06-CONTEXT.md D-09/D-10/D-11,
# INST-01/INST-02). D-10: the existence of $NOODARA_INSTALL_DIR/.env -- never the directory alone
# -- is the single signal of an existing installation.

# Reads the value of a single "^<key>=" line out of an existing .env (last match wins, matching
# every writer in this file appending rather than rewriting). Strips one layer of surrounding
# single quotes if present -- noodara_generate_env writes NOODARA_PUBLIC_URL/NOODARA_ADMIN_*
# single-quoted (Finding B, 06-04-SUMMARY.md) but NOODARA_VERSION itself unquoted; this helper
# stays generic so any future caller can read either shape safely. `${var#pattern}`/`${var%pattern}`
# parameter expansion only strips the quote when it is actually present, so this is a safe no-op
# for an unquoted value. Prints an empty line (never fails) when the key is absent -- the caller
# decides whether that is fatal.
noodara_env_get_value() {
  _noodara_egv_path="$1"
  _noodara_egv_key="$2"
  _noodara_egv_line=$(grep "^${_noodara_egv_key}=" "$_noodara_egv_path" 2>/dev/null | tail -n 1)
  _noodara_egv_raw="${_noodara_egv_line#*=}"
  _noodara_egv_raw="${_noodara_egv_raw#\'}"
  _noodara_egv_raw="${_noodara_egv_raw%\'}"
  printf '%s\n' "$_noodara_egv_raw"
}

# True (exit 0) only when $NOODARA_INSTALL_DIR/.env exists -- the directory existing alone (e.g.
# left behind by a failed first attempt with nothing written yet) is not enough (D-10).
noodara_is_installed() {
  [ -f "${NOODARA_INSTALL_DIR}/${NOODARA_ENV_FILE}" ]
}

# Creates $NOODARA_INSTALL_DIR mode 700 when absent (via `umask 077` so it is never briefly more
# permissive between mkdir and chmod), and re-asserts mode 700 unconditionally when it already
# exists -- covers both a fresh install and mode drift after a manual operator edit on a re-run.
# The caller already ran as root (noodara_check_root, earlier in noodara_main), so a directory
# this process creates is already root-owned; no separate chown is needed.
noodara_prepare_install_dir() {
  if [ ! -d "$NOODARA_INSTALL_DIR" ]; then
    (umask 077 && mkdir -p "$NOODARA_INSTALL_DIR") || noodara_fail env-write-failed "Failed to create $NOODARA_INSTALL_DIR."
  fi
  chmod 700 "$NOODARA_INSTALL_DIR" || noodara_fail env-write-failed "Failed to set permissions on $NOODARA_INSTALL_DIR."
}

_noodara_pcf_lp='('

# Writes the production compose file (this repo's own root docker-compose.yml, Plan 06-07) to
# $NOODARA_INSTALL_DIR/docker-compose.yml, mode 644, on every run -- overwriting any previous copy
# is how an upgrade picks up a new topology (D-09). The file carries no secret, only ${VAR}
# references Compose itself resolves from .env at `docker compose` invocation time, never at
# install.sh write time -- every heredoc delimiter below is quoted so every ${VAR}/$$VAR reference
# passes through completely literally, unexpanded by this shell.
#
# This is the same byte content as the repo's own docker-compose.yml (proven by
# tests/unit/installer/main-flow.test.ts, which calls this function against a tmpdir and diffs the
# written file against the real one) -- with one necessary exception: two of the file's
# healthcheck.test lines contain the literal JS arrow-function syntax "catch(()=>...)", embedding
# the two-character substring "((" directly. scripts/check-posix-sh.mjs's arith-command rule
# (meant to catch bash's double-paren arithmetic compound command) cannot tell that substring apart
# from unrelated heredoc body text -- and hard_rule #7 forbids editing that gate. The workaround
# matches this file's own established false-positive-workaround precedent (06-06-SUMMARY.md):
# never let the literal two-character sequence "((" appear together on any physical source line of
# install.sh. _noodara_pcf_lp above holds a single "(" character; the two affected lines are
# written via a separate printf call that only brings the two parens together at RUNTIME (one
# %s substitution -- "catch(" itself already supplies the method-call's own opening paren),
# never in this file's own source text.
noodara_place_compose_file() {
  _noodara_pcf_target="${NOODARA_INSTALL_DIR}/${NOODARA_COMPOSE_FILE}"
  _noodara_pcf_tmp="${_noodara_pcf_target}.tmp.$$"
  if ! {
    cat <<'NOODARA_COMPOSE_EOF_A'
name: noodara

# This is the PRODUCTION topology the installer writes to /opt/noodara/docker-compose.yml
# (D-10) -- docker-compose.dev.yml is the local-development sibling (Postgres/Redis only, no
# app containers) and is NOT this file; do not merge the two.
#
# The `migrate` one-shot re-runs on every `docker compose up` -- including the installer's own
# upgrade path -- by Compose's own documented design (github.com/docker/compose/issues/9260):
# `depends_on: condition: service_completed_successfully` only gates *dependents*, it does not
# make the one-shot itself skip re-execution once it has already exited 0 once. This is safe here
# ONLY because Drizzle's `migrate()` (apps/control-plane/src/db/migrate.ts, compiled to
# dist/db/migrate.js) diffs the migrations-tracking table and no-ops when nothing is pending --
# proven by tests/integration/installer/compose-stack.test.ts's own second-`up` assertion. Do NOT
# "fix" the re-run itself with skip logic; the correctness guarantee lives in migrate() being
# idempotent, not in Compose running it only once.
#
# Memory limits below are derived from real `docker stats --no-stream` samples taken against this
# exact file, across more than one run to absorb normal run-to-run variance (idle RSS observed:
# postgres 26-38MiB, redis 5-16MiB, api 66-75MiB, worker 50-59MiB, web 41-59MiB) -- see
# .planning/phases/06-instalador-y-docker-compose/06-07-SUMMARY.md for the literal `docker stats`
# output. Each limit is at least a 2x headroom multiple over the HIGHEST observed sample for that
# service (in practice 3.4x-6x here) -- not guessed (06-RESEARCH.md Assumption A3). `migrate` is
# the one exception: its whole run completes in well under a second, too fast for `docker stats` to
# reliably sample, so its limit is bounded by analogy to `postgres`'s own measured ceiling instead
# (same order of magnitude, comfortably above what a Node process doing a handful of DB statements
# needs). These are idle-stack numbers on a development machine, not a load test; they remain
# subject to real-VPS validation in Plan 06-15.

services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required -- write /opt/noodara/.env before running docker compose}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required -- write /opt/noodara/.env before running docker compose}
      POSTGRES_DB: ${POSTGRES_DB:?POSTGRES_DB is required -- write /opt/noodara/.env before running docker compose}
    volumes:
      - noodara_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}']
      interval: 5s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits:
          # Idle RSS measured at 26-38MiB, but idle is not representative for postgres: its default
          # shared_buffers (128MB) only counts against the cgroup once pages are touched. Measured
          # under load (postgres:17-alpine, no swap): at a 192M cap a single-connection bulk write
          # of ~320MB got a backend SIGKILLed and the whole cluster dropped into crash recovery; at
          # 256M and above the same operation completes. 512M leaves room above that floor. Do not
          # lower this without re-running a write-heavy measurement, not an idle one.
          memory: 512M

  # T-06-33/Pitfall 4: docker-compose.dev.yml's redis service has no `environment:` block, so its
  # own `$${REDIS_PASSWORD}` healthcheck reference is undefined INSIDE the container's shell when
  # the healthcheck actually runs there -- it reports unhealthy forever despite `redis-cli ping`
  # working manually. The `environment: REDIS_PASSWORD:` entry below is what makes the
  # identical-looking healthcheck below actually work: it gives the container-side shell
  # a real value to substitute at `$$REDIS_PASSWORD`. Verify with `docker inspect
  # --format='{{.State.Health.Status}}'`, never just "container is running".
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['redis-server', '--requirepass', '${REDIS_PASSWORD:?REDIS_PASSWORD is required -- write /opt/noodara/.env before running docker compose}']
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD:?REDIS_PASSWORD is required -- write /opt/noodara/.env before running docker compose}
    volumes:
      - noodara_redis_data:/data
    # T-06-36: `redis-server --requirepass` above already puts the password in ITS OWN argv (an
    # accepted, documented risk -- see this plan's threat model, matching redis's own configuration
    # surface). The healthcheck below does not need to repeat that exposure: `REDISCLI_AUTH` is
    # redis-cli's own documented env-var convention for supplying the password, set here as a
    # shell-prefix on the child process's environment rather than a `-a` CLI flag -- so the
    # password never appears in this specific command's own argv (a `ps`/`docker top` listing).
    healthcheck:
      test: ['CMD-SHELL', 'REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping | grep -q PONG']
      interval: 5s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits:
          memory: 96M # Measured idle RSS 5-16MiB across runs; >=2x headroom over the high end (6.0x).

  migrate:
    image: ${NOODARA_IMAGE_PREFIX:?NOODARA_IMAGE_PREFIX is required}/noodara-control-plane:${NOODARA_VERSION:?NOODARA_VERSION is required -- never use the unversioned tag, D-04}
    command: ['node', 'dist/db/migrate.js']
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no" # Never "always": a one-shot must not auto-restart on its own exit.
    deploy:
      resources:
        limits:
          # Not directly measured (see the file-level comment above): bounded by analogy to
          # postgres's own measured ceiling, same order of magnitude as api/worker's own image.
          memory: 192M

  api:
    image: ${NOODARA_IMAGE_PREFIX:?NOODARA_IMAGE_PREFIX is required}/noodara-control-plane:${NOODARA_VERSION:?NOODARA_VERSION is required -- never use the unversioned tag, D-04}
    command: ['node', 'dist/server.js']
    env_file:
      - .env
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    restart: unless-stopped
    stop_grace_period: 30s
    # Node 22's global `fetch`, since node:22-slim has no guaranteed curl/wget. Any 2xx (including
    # GET /health's 200 "degraded" when only redis/the worker are down) is healthy -- only a 503
    # (dead Postgres) is unhealthy, matching apps/control-plane/src/routes/health.ts's own
    # documented intent (D-26): the orchestrator must restart the API for a dead database, but
    # never merely because Redis or the worker is unavailable.
    healthcheck:
NOODARA_COMPOSE_EOF_A
    printf "      test: ['CMD', 'node', '-e', \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(%s)=>process.exit(1))\"]\n" "$_noodara_pcf_lp"
    cat <<'NOODARA_COMPOSE_EOF_B'
      interval: 5s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits:
          memory: 256M # Measured idle RSS 66-75MiB across runs; >=2x headroom over the high end (3.4x).

  worker:
    image: ${NOODARA_IMAGE_PREFIX:?NOODARA_IMAGE_PREFIX is required}/noodara-control-plane:${NOODARA_VERSION:?NOODARA_VERSION is required -- never use the unversioned tag, D-04}
    command: ['node', 'dist/worker.js']
    env_file:
      - .env
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    restart: unless-stopped
    # computeJobLockDurationMs (apps/control-plane/src/queue/job-budget.ts) = connectMs*2 + 2000 +
    # discoveryMs + 30000; with env.ts's own defaults (10000ms connect, 60000ms discovery) that is
    # 112000ms = 112s, and runWorkerShutdown (phase 4 D-25) is given exactly that as its graceful-
    # shutdown budget. This grace period must exceed it, not invent a separate number.
    stop_grace_period: 150s
    # No healthcheck: the worker's liveness is reported through the api container's own /health
    # `checks.worker` heartbeat (D-26), not a second, independent probe.
    deploy:
      resources:
        limits:
          memory: 256M # Measured idle RSS 50-59MiB across runs; >=2x headroom over the high end (4.3x).

  web:
    image: ${NOODARA_IMAGE_PREFIX:?NOODARA_IMAGE_PREFIX is required}/noodara-web:${NOODARA_VERSION:?NOODARA_VERSION is required -- never use the unversioned tag, D-04}
    ports:
      - '${NOODARA_PORT:?NOODARA_PORT is required}:3000' # The only published port in this whole file.
    depends_on:
      api:
        condition: service_healthy
    restart: unless-stopped
    stop_grace_period: 10s
    healthcheck:
NOODARA_COMPOSE_EOF_B
    printf "      test: ['CMD', 'node', '-e', \"fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(%s)=>process.exit(1))\"]\n" "$_noodara_pcf_lp"
    cat <<'NOODARA_COMPOSE_EOF_C'
      interval: 5s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits:
          memory: 256M # Measured idle RSS 41-59MiB across runs; >=2x headroom over the high end (4.3x).

volumes:
  noodara_postgres_data:
  noodara_redis_data:
NOODARA_COMPOSE_EOF_C
  } > "$_noodara_pcf_tmp"; then
    rm -f "$_noodara_pcf_tmp"
    noodara_fail env-write-failed "Failed to write the compose file to $_noodara_pcf_target."
  fi
  if ! mv "$_noodara_pcf_tmp" "$_noodara_pcf_target"; then
    rm -f "$_noodara_pcf_tmp"
    noodara_fail env-write-failed "Failed to write the compose file to $_noodara_pcf_target."
  fi
  chmod 644 "$_noodara_pcf_target" || noodara_fail env-write-failed "Failed to set permissions on $_noodara_pcf_target."
}

# Image pull, compose up, and health wait (06-CONTEXT.md D-09/D-12, exit reasons image-pull-failed
# =50/compose-up-failed=51/migrations-failed=52/health-check-failed=53). Every `docker compose`
# call below runs with the install directory as cwd (docker-compose.yml and .env both live there --
# Compose's own default project-directory/.env resolution needs nothing more, matching Plan
# 06-07's own compose-stack.test.ts convention).

# Extracts the value of `field` from the JSON object whose "Service" field equals `svc`, out of
# `docker compose ps[--format json]`'s stdout on stdin -- without jq (D-18 layer 1 has no such
# dependency). Tracks curly-brace DEPTH character-by-character rather than splitting on every "}"
# (`RS = "}"`) -- a genuine record boundary is only the "}" that returns depth to 0, never one
# contributed by a nested object. Handles both shapes Compose has shipped -- a single JSON array
# (objects possibly spanning multiple physical lines) and NDJSON (one compact object per line) --
# since it operates on the whole byte stream, not per physical line.
#
# Post-execution fix (orchestrator audit, 06-11-PLAN.md -- the first real `docker compose ps
# --format json` run against a genuinely running stack): the real Compose CLI (v5.5.1) emits a
# non-empty "Publishers" ARRAY OF OBJECTS for every service that exposes a container port -- true
# for every service in docker-compose.yml except the port-less `migrate` one-shot, including a
# service that publishes no HOST port at all (its one Publishers element still has
# "PublishedPort":0). That nested object contributes its OWN "}" strictly before the record's own
# outer "}". The OLD `RS = "}"` splitter therefore cut every such record in two: alphabetically,
# "Health"/"ExitCode" sort before "Publishers" (so they land in the FIRST fragment) and "Service"
# sorts after it (so it lands in the SECOND fragment) -- no single fragment ever matched both the
# "Service" pattern and the queried field, so this function silently returned nothing for api,
# postgres, redis, worker and web on every real run. This is exactly why noodara_wait_for_health
# polled for its full 300s timeout (exit 53) against a stack `docker inspect` already reported
# genuinely healthy -- reproduced empirically inside a real installer-DinD fixture before writing
# this fix, and pinned by tests/unit/installer/main-flow.test.ts against the real recorded JSON
# shape (never a hand-simplified fixture missing the Publishers array).
noodara_compose_json_field_for_service() {
  awk -v svc="$1" -v fld="$2" '
    BEGIN { depth = 0; record = "" }
    {
      line = $0
      len = length(line)
      for (i = 1; i <= len; i++) {
        c = substr(line, i, 1)
        record = record c
        if (c == "{") {
          depth++
        } else if (c == "}") {
          depth--
          if (depth == 0) {
            if (record ~ ("\"Service\"[ ]*:[ ]*\"" svc "\"")) {
              if (match(record, "\"" fld "\"[ ]*:[ ]*\"?[^\",}]*\"?")) {
                val = substr(record, RSTART, RLENGTH)
                sub("\"" fld "\"[ ]*:[ ]*", "", val)
                gsub(/"/, "", val)
                print val
                exit
              }
            }
            record = ""
          }
        }
      }
    }
  '
}

# The live Health status ("healthy"/"unhealthy"/"starting"/empty) for a running service, from
# `docker compose ps` (running containers only).
noodara_service_health() {
  (cd "$NOODARA_INSTALL_DIR" && docker compose ps --format json) | noodara_compose_json_field_for_service "$1" Health
}

# Post-execution fix (orchestrator audit Finding E, 06-09 follow-up): a single, immediate health
# read for both api and web -- no sleep, no polling loop. Used only to decide whether a
# same-version no-op *candidate* (Finding C: NOODARA_VERSION already matches .env and every merge
# key is already present) can genuinely skip straight to the summary, or whether the stack needs
# repairing first. Finding C's own no-op path used to skip `docker compose pull`/`up -d`
# unconditionally the moment the version/keys matched, then poll for up to
# NOODARA_HEALTH_WAIT_ATTEMPTS x NOODARA_HEALTH_WAIT_INTERVAL (5 minutes by default) against
# containers that may never have started at all -- a first install whose `pull`/`up -d` failed
# (a network blip) or a manually stopped stack could never recover except by deleting `.env`,
# breaking INST-02's own idempotency promise. This function is never the final health gate itself
# -- that is always noodara_wait_for_health's own bounded loop, run afterwards whenever this
# single read reports not-healthy.
noodara_stack_healthy_now() {
  _noodara_shn_api=$(noodara_service_health api)
  _noodara_shn_web=$(noodara_service_health web)
  [ "$_noodara_shn_api" = "healthy" ] && [ "$_noodara_shn_web" = "healthy" ]
}

# The live State ("running"/"created"/"exited"/"dead", or empty when no container exists for the
# service at all) from `docker compose ps -a` (`-a` so a container that was created but never
# started, or one that already exited, is still reported -- not just running containers). Distinct
# from noodara_service_health above: State answers "does a running container exist to even
# health-check in the first place", which noodara_compose_up's own Finding F fix (below) needs to
# know BEFORE ever deciding whether polling for health makes any sense at all.
noodara_service_state() {
  (cd "$NOODARA_INSTALL_DIR" && docker compose ps -a --format json) | noodara_compose_json_field_for_service "$1" State
}

# The exit code of a (possibly already-exited) service, from `docker compose ps -a` (`-a` so a
# one-shot like `migrate` that has already exited is still reported, not just running containers).
noodara_service_exit_code() {
  (cd "$NOODARA_INSTALL_DIR" && docker compose ps -a --format json) | noodara_compose_json_field_for_service "$1" ExitCode
}

# True (exit 0) only when the `migrate` one-shot's own recorded exit code is present and non-zero
# -- distinguishes "migrations genuinely failed" from "some other compose-up failure" so
# noodara_compose_up below can surface exit 52 (migrations-failed) instead of the generic 51
# (compose-up-failed) when that is the real cause (Task 2's own behavior spec).
noodara_migrate_did_fail() {
  _noodara_mdf_code=$(noodara_service_exit_code migrate)
  [ -n "$_noodara_mdf_code" ] && [ "$_noodara_mdf_code" != "0" ]
}

# Redacts any NOODARA_SETUP_TOKEN=<value> line and any userinfo-bearing connection-string-shaped
# URL (scheme://user:pass@host) from a block of text before it is ever shown to the operator or
# written anywhere. The D-12 diagnostic log tail (below) is the one place raw container output
# reaches the operator -- application logs already pass through the phase-1 pino redactor, but the
# setup-token line deliberately bypasses pino (bootstrap-admin.ts writes it straight to stdout),
# and a stack-trace-shaped error line could still echo a DATABASE_URL/REDIS_URL-style connection
# string verbatim. Never uses a POSIX `[:space:]` character class -- its own text starts with the
# literal two-character substring "[[", which check-posix-sh's bracket-test rule flags as a
# false-positive bashism (06-02-SUMMARY.md's own precedent for the identical class of finding).
noodara_redact_diagnostic_text() {
  sed -e 's/NOODARA_SETUP_TOKEN=[^ ]*/NOODARA_SETUP_TOKEN=[REDACTED]/g' \
    -e 's#://[^:@]*:[^@]*@#://[REDACTED]@#g'
}

# Pulls every image `docker-compose.yml` references, unless NOODARA_INTERNAL_IMAGE_PREFIX is set
# (D-19: the layer-2 test suite loads locally built images into the daemon directly and has no
# registry to pull from at all -- this is the one flag that already implies skipping the pull,
# reusing Plan 06-06's own documented override rather than a second new one). Fails with reason
# image-pull-failed (exit 50) on any pull failure.
noodara_pull_images() {
  if [ -n "${NOODARA_INTERNAL_IMAGE_PREFIX:-}" ]; then
    noodara_note "Skipping image pull (NOODARA_INTERNAL_IMAGE_PREFIX is set -- using locally built images, D-19)."
    return 0
  fi
  noodara_step "Pulling images..."
  if ! (cd "$NOODARA_INSTALL_DIR" && docker compose pull); then
    noodara_fail image-pull-failed "Failed to pull images. Check network connectivity and the resolved image tags, then re-run this installer."
  fi
}

# Runs `docker compose up -d`. On failure, checks whether the `migrate` one-shot is the real cause
# (exit 52, migrations-failed, with its own log tail) -- D-12: nothing here removes a volume,
# deletes .env, or re-runs `docker compose down`; data and secrets are always left untouched on
# this path.
#
# Post-execution fix (06-12-PLAN.md, real DinD discovery): a real `docker compose up -d` can fail
# on its OWN dependency-wait ("dependency failed to start: container ... is unhealthy") before
# this installer ever gets a chance to run its own noodara_wait_for_health -- Compose itself
# refuses to finish `up -d` when a service another service `depends_on: condition: service_healthy`
# never becomes healthy (this docker-compose.yml's own topology: web on api, api/worker on redis,
# migrate on postgres). A non-migrate `up -d` failure defers to noodara_wait_for_health, which
# judges the containers this `up -d` attempt already created on their OWN real health and produces
# the full, already-tested D-12 diagnostic (service name, redacted log tail, rollback hint)
# regardless of which code path first noticed the underlying problem -- but ONLY once api/web are
# genuinely running (see the Finding F fix immediately below); the previous behavior (a generic,
# un-actionable "Failed to start services" message with no service name and no log tail) violated
# D-12's own requirement for exactly this failure shape.
#
# Post-execution fix (06-12-PLAN.md, orchestrator audit Finding F): the fix above was ITSELF a
# regression for every `up -d` failure that is NOT a health problem at all -- an unresolvable image
# reference, an invalid compose file, a port already allocated, a daemon-side error -- none of
# which ever create a running api/web container. Deferring unconditionally to
# noodara_wait_for_health in THAT case used to poll for the FULL health budget (up to
# NOODARA_HEALTH_WAIT_ATTEMPTS x NOODARA_HEALTH_WAIT_INTERVAL, 5 minutes by default) before finally
# reporting a generic timeout with NOTHING to show as a log tail, while Compose's own real error
# message had long scrolled off the top of the operator's terminal -- and made exit 51
# (compose-up-failed) permanently unreachable. A single, immediate read of api/web's own container
# STATE (never Health -- State answers "does a running container exist to even health-check",
# noodara_service_state above) classifies the failure BEFORE ever touching noodara_wait_for_health:
# not-running (absent/created/exited/dead) -> fail now, naming Compose's own error (already on
# stderr above this function's own output) and a redacted `docker compose ps -a` state table, zero
# health polling at all; running -> defer to noodara_wait_for_health exactly as the prior fix
# already proved correct. Accepts an optional `$1` context, `"repair"`, mirroring
# noodara_wait_for_health's own -- a repair run's .env may still carry an OLD NOODARA_PREVIOUS_VERSION
# from a real, earlier upgrade, and comparing it against NOODARA_VERSION alone would wrongly treat
# that as "this run changed the version" (06-09 Finding E's own precedent for the identical trap).
noodara_compose_up() {
  _noodara_cu_context="${1:-}"
  noodara_step "Starting services..."
  if ! (cd "$NOODARA_INSTALL_DIR" && docker compose up -d); then
    if noodara_migrate_did_fail; then
      _noodara_cu_tail=$(cd "$NOODARA_INSTALL_DIR" && docker compose logs --tail 50 migrate 2>&1 | noodara_redact_diagnostic_text)
      printf '%s\n' "$_noodara_cu_tail" >&2
      noodara_fail migrations-failed "Database migrations failed. See the migrate service log tail above. Data and secrets are untouched."
    fi

    # Real-DinD discovery (second real Finding F bug, found re-running the first fix against the
    # real fixture): docker-compose.yml's own topology (web depends_on: api: condition:
    # service_healthy) means Compose genuinely CREATES web's container early but never STARTS it
    # while api has not yet reported healthy -- web legitimately stays in state "created" for as
    # long as api is unhealthy, a state DERIVED from api's own problem, not an independent failure
    # signal. Requiring web to be strictly "running" here made exit 51 fire on the ordinary
    # api-is-unhealthy case too (web is never "running" in that case). "created" is therefore
    # accepted for web specifically; any OTHER non-running state (exited/dead/absent) still means
    # web itself has its own, genuinely independent problem.
    _noodara_cu_api_state=$(noodara_service_state api)
    _noodara_cu_web_state=$(noodara_service_state web)
    _noodara_cu_not_ready=0
    if [ "$_noodara_cu_api_state" != "running" ]; then
      _noodara_cu_not_ready=1
    elif [ "$_noodara_cu_web_state" != "running" ] && [ "$_noodara_cu_web_state" != "created" ]; then
      _noodara_cu_not_ready=1
    fi
    if [ "$_noodara_cu_not_ready" = "1" ]; then
      _noodara_cu_ps=$(cd "$NOODARA_INSTALL_DIR" && docker compose ps -a 2>&1 | noodara_redact_diagnostic_text)
      printf '%s\n' "$_noodara_cu_ps" >&2

      _noodara_cu_message="Failed to start services with docker compose up -d -- see Compose's own error and the service state above. Data and secrets are untouched."
      if [ "$_noodara_cu_context" != "repair" ]; then
        _noodara_cu_version=$(noodara_env_get_value "${NOODARA_INSTALL_DIR}/${NOODARA_ENV_FILE}" NOODARA_VERSION)
        _noodara_cu_previous=$(noodara_env_get_value "${NOODARA_INSTALL_DIR}/${NOODARA_ENV_FILE}" NOODARA_PREVIOUS_VERSION)
        if [ -n "$_noodara_cu_previous" ] && [ "$_noodara_cu_previous" != "$_noodara_cu_version" ]; then
          _noodara_cu_message="${_noodara_cu_message} To go back, re-run this installer with NOODARA_VERSION=${_noodara_cu_previous}."
        fi
      fi
      noodara_fail compose-up-failed "$_noodara_cu_message"
    fi

    noodara_note "docker compose up -d reported a failure -- checking service health directly."
  fi
}

# Bounded poll loop, never an unbounded infinite `while` (D-12): 06-07-SUMMARY.md measured the real
# production stack reaching healthy well within its own test run; 60 attempts x 5s = 300s (5
# minutes) gives generous headroom above that measurement. Both are overridable only for tests
# (undocumented for real installs, matching this file's other NOODARA_*-overridable-for-tests
# constants).
readonly NOODARA_HEALTH_WAIT_ATTEMPTS="${NOODARA_HEALTH_WAIT_ATTEMPTS:-60}"
readonly NOODARA_HEALTH_WAIT_INTERVAL="${NOODARA_HEALTH_WAIT_INTERVAL:-5}"

# Polls `api`/`web`'s own Health status until both report "healthy" or the bounded loop above
# elapses -- never returns success on a partially healthy stack. On timeout: exits 53
# (health-check-failed), naming the still-unhealthy service, showing that service's own last 50
# log lines via `docker compose logs --tail 50 <service>` (routed to stderr -- the one place raw
# container output reaches the operator; application logs already pass through the phase-1 pino
# redactor, and `.env`'s own contents are never read or printed anywhere on this path), and stating
# the D-12 rollback remedy by name (NOODARA_VERSION=<the value of NOODARA_PREVIOUS_VERSION>).
# Nothing on this path removes a volume, deletes .env, or runs `docker compose down` -- D-12's
# "fail with diagnostics, never roll back automatically" holds all the way through.
#
# Post-execution fix (orchestrator audit Finding E, 06-09 follow-up): accepts an optional `$1`
# context, `"repair"`, used only by noodara_main's same-version repair path (Finding E: a no-op
# candidate whose stack turned out not to be healthy). No version change ever happens on that
# path -- NOODARA_VERSION and NOODARA_PREVIOUS_VERSION both stay exactly what they already were --
# so naming a "rollback" target there would misleadingly imply an upgrade took place. Every other
# caller (a genuine fresh install or a genuine version-changed upgrade) omits `$1` and keeps the
# original rollback-remedy wording unchanged.
noodara_wait_for_health() {
  _noodara_wfh_context="${1:-}"
  noodara_step "Waiting for services to report healthy..."
  _noodara_wfh_attempt=0
  _noodara_wfh_api=""
  _noodara_wfh_web=""
  while [ "$_noodara_wfh_attempt" -lt "$NOODARA_HEALTH_WAIT_ATTEMPTS" ]; do
    _noodara_wfh_api=$(noodara_service_health api)
    _noodara_wfh_web=$(noodara_service_health web)
    if [ "$_noodara_wfh_api" = "healthy" ] && [ "$_noodara_wfh_web" = "healthy" ]; then
      noodara_step "All services are healthy."
      return 0
    fi
    # Post-execution fix (06-12-PLAN.md, orchestrator audit Finding F): "unhealthy" is Docker's own
    # DEFINITIVE outcome (the container's healthcheck already exhausted its own retries, per
    # docker-compose.yml's own retries: 10) -- continuing to poll for the rest of the budget only
    # delays reporting a failure that has already, genuinely happened. "starting"/empty are NOT
    # definitive (the app may simply be slow, or Compose's own dependency-wait gave up early while
    # the container itself is still coming up) and keep polling within the bounded budget exactly
    # as before.
    if [ "$_noodara_wfh_api" = "unhealthy" ] || [ "$_noodara_wfh_web" = "unhealthy" ]; then
      break
    fi
    _noodara_wfh_attempt=$(awk -v n="$_noodara_wfh_attempt" 'BEGIN { print n + 1 }')
    sleep "$NOODARA_HEALTH_WAIT_INTERVAL"
  done

  _noodara_wfh_bad=api
  if [ "$_noodara_wfh_api" != "unhealthy" ]; then
    if [ "$_noodara_wfh_web" = "unhealthy" ]; then
      _noodara_wfh_bad=web
    elif [ "$_noodara_wfh_api" = "healthy" ]; then
      _noodara_wfh_bad=web
    fi
  fi
  _noodara_wfh_tail=$(cd "$NOODARA_INSTALL_DIR" && docker compose logs --tail 50 "$_noodara_wfh_bad" 2>&1 | noodara_redact_diagnostic_text)
  printf '%s\n' "$_noodara_wfh_tail" >&2

  if [ "$_noodara_wfh_context" = "repair" ]; then
    noodara_fail health-check-failed "Service '$_noodara_wfh_bad' did not become healthy in time. See its log tail above. Data and secrets are untouched."
  fi

  # The real rollback remedy: NOODARA_PREVIOUS_VERSION is a key written INTO .env by
  # noodara_main (never a real process environment variable during a genuine install) -- prefer an
  # env-var override for isolated unit tests of this function, then fall back to reading the value
  # noodara_main already wrote to .env, then a generic placeholder if truly nothing is known yet.
  _noodara_wfh_prev="${NOODARA_PREVIOUS_VERSION:-}"
  if [ -z "$_noodara_wfh_prev" ]; then
    _noodara_wfh_prev=$(noodara_env_get_value "${NOODARA_INSTALL_DIR}/${NOODARA_ENV_FILE}" NOODARA_PREVIOUS_VERSION)
  fi
  if [ -z "$_noodara_wfh_prev" ]; then
    _noodara_wfh_prev="the version you were previously on"
  fi
  noodara_fail health-check-failed "Service '$_noodara_wfh_bad' did not become healthy in time. See its log tail above. Data and secrets are untouched -- to go back, re-run this installer with NOODARA_VERSION=${_noodara_wfh_prev}."
}

# Setup token, ufw advisory, install.log and the final operator summary (06-CONTEXT.md D-05/D-08/
# D-13, INST-04/INST-05).

# Reads the one-time setup token from `docker compose logs api` (D-13, T-06-45): extracts the
# value after the LAST literal "NOODARA_SETUP_TOKEN=" occurrence (bootstrap-admin.ts re-emits it
# on every boot while no admin exists yet) and validates it looks like the base64url value
# deriveSetupTokenValue actually produces -- a bounded run of [A-Za-z0-9_-], never empty, never
# absurdly long -- before ever returning it, so a log line corrupted by a terminal escape sequence
# or other junk is never echoed raw to the operator's terminal. Returns non-zero (prints nothing at
# all) when no such line exists: this installer never fabricates, reprints a stale, or prints a
# placeholder token -- the caller (noodara_print_summary) prints the admin-exists message instead.
noodara_read_setup_token() {
  _noodara_rst_logs=$(cd "$NOODARA_INSTALL_DIR" && docker compose logs api 2>&1) || return 1
  _noodara_rst_token=$(printf '%s\n' "$_noodara_rst_logs" | sed -n 's/.*NOODARA_SETUP_TOKEN=\(.*\)/\1/p' | tail -n 1 | tr -d '\r')
  if [ -z "$_noodara_rst_token" ]; then
    return 1
  fi
  case "$_noodara_rst_token" in
    *[!A-Za-z0-9_-]*)
      return 1
      ;;
  esac
  if [ "${#_noodara_rst_token}" -lt 20 ] || [ "${#_noodara_rst_token}" -gt 128 ]; then
    return 1
  fi
  printf '%s\n' "$_noodara_rst_token"
}

# Post-execution fix (orchestrator audit Finding D, 06-09 follow-up): a reliable "does an admin
# already exist" signal, without touching apps/control-plane. noodara_read_setup_token above only
# reads whatever token line the api container's log HISTORY happens to contain -- bootstrapAdmin
# (apps/control-plane/src/boot/bootstrap-admin.ts) only ever runs at boot, so on a re-run where the
# api container was not recreated (Finding C's own same-version no-op path is exactly that case),
# an earlier boot's token line is still sitting in the log even after an admin has since been
# created through the panel, and D-13 would then print a stale, meaningless token.
#
# This probe instead reuses the existing POST /api/setup route exactly as
# apps/control-plane/src/routes/setup.ts already implements it, with a deliberately-invalid,
# non-secret placeholder token/email/password that can never succeed either way -- read before
# choosing this probe: the route checks adminExists() BEFORE the submitted body is ever looked at
# (D-02's own "the setup route disappears once an admin exists" rule), so the response status
# alone tells this installer which branch was taken: 404 means an admin already exists, 400 (the
# service's own TOKEN_INVALID) means it does not. setup-service.ts's redeemSetupToken looks the
# token up by its hash BEFORE ever validating email/password, so the placeholder email/password are
# never reached, and this failure path writes zero activity events. login-guard.ts (the AUTH-04
# progressive lockout) only hooks Better Auth's own /sign-in/email path, never this plain Fastify
# route, so the lockout is never touched either. This is why no apps/control-plane change was
# needed for this fix.
#
# Runs `node -e` inside the `api` container itself (`docker compose exec -T`, the same
# "no host port needed" pattern this repo's own compose healthchecks already use for /health)
# since `api` publishes no host port at all (same-origin, D-10) -- there is nothing on the host to
# curl directly. Prints exactly one of "exists"/"missing"/"unknown" on stdout and always exits 0:
# a diagnostic probe must never fail the whole installer over its own inconclusive result.
# noodara_print_summary decides what "unknown" (the exec itself failed, an unexpected response
# status, a network error inside the container) means -- it falls back to the original D-13
# log-reading behavior, which is this fix's one documented, honest limitation: on a same-version
# no-op re-run where this probe cannot run for some other reason, a stale token could still be
# printed, exactly as before this fix.
noodara_probe_admin_exists() {
  _noodara_pae_script='fetch("http://127.0.0.1:3000/api/setup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:"noodara-installer-admin-probe-0000000000000000",email:"noodara-installer-probe@example.invalid",password:"Noodara-Installer-Probe-Not-A-Real-Password-000"}),signal:AbortSignal.timeout(5000)}).then(function(r){process.stdout.write(r.status===404?"exists\n":r.status===400?"missing\n":"unknown\n");process.exit(0);}).catch(function(){process.stdout.write("unknown\n");process.exit(0);});'
  _noodara_pae_out=$(cd "$NOODARA_INSTALL_DIR" && docker compose exec -T api node -e "$_noodara_pae_script" 2>/dev/null) || _noodara_pae_out=""
  case "$_noodara_pae_out" in
    *exists*)
      printf 'exists\n'
      ;;
    *missing*)
      printf 'missing\n'
      ;;
    *)
      printf 'unknown\n'
      ;;
  esac
}

# D-08: read-only ufw advisory. Reports nothing when ufw is absent or inactive. When active,
# prints the exact wording 06-RESEARCH.md Pitfall 5 requires (the "typically bypass" qualifier is
# load-bearing -- neither "ufw will block this" nor "ufw protects you" is accurate), the exact
# `ufw allow <port>/tcp` command, and a reminder that the cloud provider's own firewall also
# applies. Never invokes a mutating ufw subcommand (`allow`/`enable`/`deny`/...) -- `ufw status` is
# the only ufw invocation anywhere in this function. This wording is quoted verbatim by
# docs/install.md (Plan 06-14) so the two copies cannot drift.
#
# Post-execution fix (orchestrator audit Finding B, 06-09 follow-up): accepts the already-resolved
# panel port as `$1` (noodara_print_summary passes the same value it names elsewhere), so this
# advisory always names the port an existing installation's .env actually recorded rather than
# silently re-resolving it (and potentially disagreeing with the rest of the summary) via
# noodara_resolve_port's own NOODARA_PORT/default logic. Falls back to noodara_resolve_port only
# when called with no argument at all -- preserves every existing direct caller/test of this
# function unchanged.
noodara_check_ufw() {
  _noodara_cfw_port="${1:-}"
  if ! command -v ufw >/dev/null 2>&1; then
    return 0
  fi
  _noodara_cfw_status=$(ufw status 2>/dev/null) || return 0
  case "$_noodara_cfw_status" in
    *"Status: active"*) ;;
    *) return 0 ;;
  esac
  if [ -z "$_noodara_cfw_port" ]; then
    _noodara_cfw_port=$(noodara_resolve_port)
  fi
  noodara_note ""
  noodara_note "ufw is active on this server. Docker publishes container ports by inserting its own iptables rules, which typically bypass ufw's rules entirely for published ports -- a port Docker publishes may be reachable from the internet even if ufw shows it as denied."
  noodara_note "If you rely on ufw to restrict access to this port, see docs/install.md for the DOCKER-USER-chain configuration needed to make ufw actually govern Docker's published ports."
  noodara_note "To allow the panel port through ufw anyway: sudo ufw allow ${_noodara_cfw_port}/tcp"
  noodara_note "Remember your cloud provider's own firewall/security-group rules also apply -- ufw only governs this host."
}

# Appends one timestamped, non-secret step line to $NOODARA_INSTALL_DIR/install.log, mode 600,
# created under `umask 077` (06-CONTEXT.md's own discretion note; T-06-09). Records step names and
# the NAMES of variables generated or preserved -- never a value, and never the setup token
# (T-06-41): every call site below passes a literal, non-secret message, mirroring
# noodara_step/noodara_warn's own "no helper here ever interpolates a generated secret" discipline.
#
# Deliberately NOT wired into noodara_step/noodara_warn themselves, unlike this plan's own literal
# <action> text: those two helpers are called from noodara_preflight and other functions BEFORE the
# install directory is guaranteed to exist (and, for standalone unit tests of those functions, may
# never exist at all) -- 06-02-PLAN.md's own already-tested invariant ("noodara_preflight writes
# nothing under NOODARA_INSTALL_DIR") would break the moment either helper attempted a file write.
# noodara_main instead calls noodara_write_log explicitly, only once the install directory is known
# to exist (after noodara_prepare_install_dir) -- documented as a deviation in this plan's SUMMARY.
noodara_write_log() {
  _noodara_wl_path="${NOODARA_INSTALL_DIR}/${NOODARA_INSTALL_LOG_FILE}"
  (
    umask 077
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$_noodara_wl_path"
  ) || return 0
  chmod 600 "$_noodara_wl_path" 2>/dev/null || true
}

# The single place the headline operator-facing output is produced (06-CONTEXT.md D-05/D-13,
# INST-04/INST-05): the panel URL, the token or the admin-exists/admin-created line, the ufw
# advisory, the HTTP caveat, and the upgrade rollback hint. A short, calm block -- no ASCII art, no
# banners, one fact per line, matching "Complex infrastructure. Calm interface."
#
# Post-execution fix (orchestrator audit Finding B, 06-09 follow-up): takes the already-resolved
# panel port as `$4`, so the ufw advisory below names the same port the URL/env path above already
# refer to (noodara_main passes its own resolved port; every direct caller/test that omits it
# falls back to noodara_check_ufw's own noodara_resolve_port default, unchanged).
noodara_print_summary() {
  _noodara_ps_url="$1"
  _noodara_ps_env_path="$2"
  _noodara_ps_version="$3"
  _noodara_ps_port="${4:-}"

  noodara_note ""
  noodara_note "Noodara is running."
  noodara_note "Panel: ${_noodara_ps_url}"

  if [ -n "${NOODARA_ADMIN_EMAIL:-}" ] && [ -n "${NOODARA_ADMIN_PASSWORD:-}" ]; then
    # INST-05: no token is read or printed, and neither the email nor the password is echoed here
    # -- bootstrap-admin.ts already created the admin from these two variables directly.
    noodara_note "Admin account created from the supplied NOODARA_ADMIN_EMAIL/NOODARA_ADMIN_PASSWORD."
  else
    # Post-execution fix (orchestrator audit Finding D, 06-09 follow-up): ask the control plane
    # itself first, via noodara_probe_admin_exists, before ever trusting a token line out of
    # `docker compose logs api` -- that log can still contain an earlier boot's token line even
    # after an admin has since been created through the panel, whenever the api container was not
    # recreated by this same run (a same-version re-run, Finding C's own no-op path, is exactly
    # that case). "exists" is authoritative and skips the log read entirely. Anything else
    # ("missing" or "unknown" -- the probe could not be run/interpreted) falls back to the original
    # D-13 log-reading behavior unchanged.
    _noodara_ps_admin_probe=$(noodara_probe_admin_exists)
    if [ "$_noodara_ps_admin_probe" = "exists" ]; then
      noodara_note "An admin account already exists."
    else
      _noodara_ps_token=""
      if _noodara_ps_token=$(noodara_read_setup_token); then
        noodara_note "One-time setup token: ${_noodara_ps_token}"
        noodara_note "Open the panel and enter this token to create the admin account."
      else
        # D-13: no token line in the logs means an admin already exists -- never an empty token
        # field, never a fabricated one.
        noodara_note "An admin account already exists."
      fi
    fi
  fi

  case "$_noodara_ps_url" in
    http://*)
      noodara_note ""
      noodara_note "WARNING: the panel is served over plain HTTP -- traffic, including the session cookie, is unencrypted until v0.4's TLS proxy (or your own) is in front. See docs/install.md."
      ;;
  esac

  noodara_check_ufw "$_noodara_ps_port"

  # D-12's upgrade rollback hint: shown only when this run genuinely changed the version.
  _noodara_ps_previous=$(noodara_env_get_value "$_noodara_ps_env_path" NOODARA_PREVIOUS_VERSION)
  if [ -n "$_noodara_ps_previous" ] && [ "$_noodara_ps_previous" != "$_noodara_ps_version" ]; then
    noodara_note ""
    noodara_note "Upgraded from ${_noodara_ps_previous} to ${_noodara_ps_version}. To go back: re-run this installer with NOODARA_VERSION=${_noodara_ps_previous}."
  fi
}

# Entry point (06-CONTEXT.md D-09/D-10/D-11/D-17, INST-01/INST-02/INST-04/INST-05): preflight ->
# ensure Docker -> prepare the install directory -> resolve version/image-prefix/public-URL/port ->
# generate a fresh .env (first install) or merge into the existing one (upgrade) -> place the
# compose file -> pull -> up -> wait for health -> print the summary. Reads as an ordered table of
# contents of the whole install; every step it calls already exists and is independently unit-
# tested (Plans 06-02..06-08) -- this function only composes them in one documented order.
#
# Post-execution fix (orchestrator audit Findings B/C/E, 06-09 follow-up): on an existing
# installation the panel port and public URL are read from .env (Finding B, via
# noodara_resolve_installed_public_url and a direct noodara_env_get_value read for the port) --
# never re-resolved from an operator override or the network -- and a same-version re-run with
# nothing missing from .env is a no-op *candidate* (Finding C, D-09's own literal wording: "si ya
# está en esa versión, no cambia nada y solo verifica salud"). Finding E: a candidate is only
# actually treated as a no-op once a single, immediate health read (noodara_stack_healthy_now,
# no polling) confirms api/web are genuinely already healthy -- skipping the backup/merge, the
# pull and `docker compose up -d` entirely. When the candidate's stack is NOT healthy (a
# half-finished first install whose pull/up never succeeded, or a manually stopped stack), this is
# instead a repair: still no backup/merge (nothing in .env needs to change), but pull and
# `docker compose up -d` run exactly as a normal re-run would, followed by the real bounded
# noodara_wait_for_health. Every change here only applies once _noodara_main_was_installed is
# already known to be 1 -- a fresh install's own port/URL resolution and its always-runs pull/up
# are completely unchanged.
noodara_main() {
  noodara_step "Noodara installer"

  noodara_preflight
  noodara_ensure_docker

  _noodara_main_was_installed=0
  if noodara_is_installed; then
    _noodara_main_was_installed=1
  fi

  noodara_prepare_install_dir

  _noodara_main_env_path="${NOODARA_INSTALL_DIR}/${NOODARA_ENV_FILE}"
  _noodara_main_version=$(noodara_resolve_version)
  _noodara_main_image_prefix=$(noodara_resolve_image_prefix)
  _noodara_main_is_noop=0
  _noodara_main_is_repair=0

  if [ "$_noodara_main_was_installed" = "1" ]; then
    # Finding B: .env always wins on a re-run -- read directly, never re-resolved.
    _noodara_main_port=$(noodara_env_get_value "$_noodara_main_env_path" NOODARA_PORT)
    if [ -z "$_noodara_main_port" ]; then
      _noodara_main_port=$(noodara_resolve_port)
    fi
    _noodara_main_public_url=$(noodara_resolve_installed_public_url)

    # D-09/D-12: record the version being replaced BEFORE overwriting NOODARA_VERSION, and only
    # when the version genuinely changes -- a same-version re-run's rollback hint must still name
    # the last real previous version, not overwrite it with the version it is already on.
    _noodara_main_previous_version=$(noodara_env_get_value "$_noodara_main_env_path" NOODARA_VERSION)

    # Finding C: a no-op *candidate* requires both the version to already match AND every key the
    # merge below would otherwise append to already be present -- a release that added a new
    # required .env key still needs its one-time additive merge (and its one backup) even when the
    # version number itself has not moved.
    _noodara_main_noop_candidate=0
    if [ "$_noodara_main_previous_version" = "$_noodara_main_version" ] \
      && noodara_env_has_key "$_noodara_main_env_path" NOODARA_IMAGE_PREFIX \
      && noodara_env_has_key "$_noodara_main_env_path" NOODARA_PORT \
      && noodara_env_has_key "$_noodara_main_env_path" NOODARA_PUBLIC_URL; then
      _noodara_main_noop_candidate=1
    fi

    if [ "$_noodara_main_noop_candidate" = "1" ]; then
      # Finding E: the candidate is only a genuine no-op once a single, immediate health read
      # confirms the stack is already healthy -- never assumed from .env's own state alone.
      if noodara_stack_healthy_now; then
        _noodara_main_is_noop=1
        noodara_note "Already on version ${_noodara_main_version}; verifying health only."
        noodara_write_log "Re-run: already on version ${_noodara_main_version}, .env unchanged (D-09 no-op)"
      else
        _noodara_main_is_repair=1
        # WR-04: the second path admin credentials can matter on. D-11 means install.sh never
        # touches or revalidates NOODARA_ADMIN_EMAIL/NOODARA_ADMIN_PASSWORD once .env already has
        # them (noodara_merge_env's own append-pairs list never includes them) -- so if a prior
        # attempt wrote .env with a policy-violating admin password, every repair would otherwise
        # repeat the exact same NOODARA_HEALTH_WAIT_ATTEMPTS x NOODARA_HEALTH_WAIT_INTERVAL stall
        # and exit 53 for the identical, already-known reason. Read from .env -- never from the
        # operator's current shell environment, which this run's noodara_merge_env/
        # noodara_generate_env never consult for these two keys on a re-run either.
        _noodara_main_repair_admin_email=$(noodara_env_get_value "$_noodara_main_env_path" NOODARA_ADMIN_EMAIL)
        _noodara_main_repair_admin_password=$(noodara_env_get_value "$_noodara_main_env_path" NOODARA_ADMIN_PASSWORD)
        if [ -n "$_noodara_main_repair_admin_email" ] && [ -n "$_noodara_main_repair_admin_password" ]; then
          noodara_validate_admin_password_policy "$_noodara_main_repair_admin_email" "$_noodara_main_repair_admin_password"
        fi
        noodara_note "The stack is not healthy; starting it."
        noodara_write_log "Re-run: already on version ${_noodara_main_version} but the stack was not healthy -- repairing (D-09/Finding E)"
      fi
    else
      if [ -n "$_noodara_main_previous_version" ] && [ "$_noodara_main_previous_version" != "$_noodara_main_version" ]; then
        noodara_set_env_value "$_noodara_main_env_path" NOODARA_PREVIOUS_VERSION "$_noodara_main_previous_version"
      fi
      noodara_merge_env "$_noodara_main_env_path" "$_noodara_main_version" \
        NOODARA_IMAGE_PREFIX "$_noodara_main_image_prefix" \
        NOODARA_PORT "$_noodara_main_port" \
        NOODARA_PUBLIC_URL "$_noodara_main_public_url"
      noodara_write_log "Upgrade: merged .env, preserved existing secrets (NOODARA_VERSION, NOODARA_IMAGE_PREFIX, NOODARA_PORT, NOODARA_PUBLIC_URL updated)"
    fi
  else
    _noodara_main_port=$(noodara_resolve_port)
    _noodara_main_public_url=$(noodara_resolve_public_url)
    noodara_generate_env "$_noodara_main_env_path" "$_noodara_main_public_url" "$_noodara_main_port" \
      "$_noodara_main_version" "$_noodara_main_image_prefix"
    noodara_write_log "Fresh install: generated .env with fresh secrets"
  fi

  noodara_place_compose_file
  noodara_write_log "Placed docker-compose.yml"

  if [ "$_noodara_main_is_noop" = "1" ]; then
    # Finding E: a true no-op already proved the stack is healthy via the single
    # noodara_stack_healthy_now read above -- no pull, no `docker compose up -d`, and no second
    # health check (noodara_wait_for_health's own bounded loop) either; straight to the summary.
    noodara_note "Skipping image pull and docker compose up -d (already on the target version, D-09)."
    noodara_write_log "Skipped pull and up -d (D-09 no-op)"
    noodara_write_log "All services healthy"
  else
    noodara_pull_images
    noodara_write_log "Images pulled (or skipped via NOODARA_INTERNAL_IMAGE_PREFIX)"
    if [ "$_noodara_main_is_repair" = "1" ]; then
      # Finding E / Finding F: no version change happened on this path -- neither noodara_compose_up's
      # own immediate-failure diagnostic nor noodara_wait_for_health's own timeout diagnostic must
      # claim an upgrade took place.
      noodara_compose_up repair
    else
      noodara_compose_up
    fi
    noodara_write_log "docker compose up -d completed"
    if [ "$_noodara_main_is_repair" = "1" ]; then
      noodara_wait_for_health repair
    else
      noodara_wait_for_health
    fi
    noodara_write_log "All services healthy"
  fi

  noodara_print_summary "$_noodara_main_public_url" "$_noodara_main_env_path" "$_noodara_main_version" "$_noodara_main_port"
}

if [ "${NOODARA_INSTALL_SH_SOURCE_ONLY:-0}" != "1" ]; then
  noodara_main "$@"
fi
