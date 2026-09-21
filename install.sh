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

# Overridable only for tests -- the real preflight always reads the genuine system files
# (06-02-PLAN.md Task 1/2).
readonly NOODARA_OS_RELEASE_FILE="${NOODARA_OS_RELEASE_FILE:-/etc/os-release}"
readonly NOODARA_MEMINFO_FILE="${NOODARA_MEMINFO_FILE:-/proc/meminfo}"

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

  disk_target="$NOODARA_INSTALL_DIR"
  if [ ! -d "$disk_target" ]; then
    disk_target="${NOODARA_INSTALL_DIR%/*}"
    [ -z "$disk_target" ] && disk_target="/"
  fi
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
noodara_check_port() {
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

# Entry point. For now this only prints the version banner and returns -- the real preflight ->
# Docker install -> .env -> compose up -> migrate -> health-check flow lands in Plan 06-09, once
# every piece it orchestrates (Plans 06-02..06-08) exists.
noodara_main() {
  noodara_step "Noodara installer"
  return 0
}

if [ "${NOODARA_INSTALL_SH_SOURCE_ONLY:-0}" != "1" ]; then
  noodara_main "$@"
fi
