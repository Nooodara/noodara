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

# Overridable only for tests -- the real installer targets the genuine published GitHub repo once
# Plan 06-15's human prerequisite creates it (06-CONTEXT.md D-02). These two defaults are
# placeholders and MUST be replaced with the real owner/repo before v0.1's first real release --
# flagged here and in this plan's own SUMMARY for Plan 06-15's handoff.
readonly NOODARA_REPO_OWNER="${NOODARA_REPO_OWNER:-REPLACE_WITH_GITHUB_OWNER}"
readonly NOODARA_REPO_NAME="${NOODARA_REPO_NAME:-noodara}"

# The real default registry (06-CONTEXT.md D-01). NOODARA_FETCH_TIMEOUT bounds every curl call
# this file ever makes (T-06-31) -- the single seam is noodara_fetch_url, defined below.
readonly NOODARA_REGISTRY="${NOODARA_REGISTRY:-ghcr.io}"
readonly NOODARA_FETCH_TIMEOUT="${NOODARA_FETCH_TIMEOUT:-5}"

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

  env_dir="${env_path%/*}"
  if [ "$env_dir" = "$env_path" ]; then
    env_dir="."
  fi
  if [ ! -d "$env_dir" ]; then
    (umask 077 && mkdir -p "$env_dir")
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
  printf '%s=%s\n' "$key" "$value" >> "$path"
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
  (
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
  )
  mv "$tmp_file" "$path"
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

  printf 'noodara: Resolved public URL: %s -- to change it, edit %s/%s (key NOODARA_PUBLIC_URL) and re-run this installer.\n' "$_noodara_rpu_url" "$NOODARA_INSTALL_DIR" "$NOODARA_ENV_FILE" >&2

  printf '%s\n' "$_noodara_rpu_url"
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
