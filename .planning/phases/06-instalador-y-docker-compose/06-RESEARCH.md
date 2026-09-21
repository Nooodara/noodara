# Phase 6: Instalador y Docker Compose - Research

**Researched:** 2026-09-21
**Domain:** Self-hosted PaaS one-command installer (Coolify/Dokploy category) — POSIX shell, Docker Compose v2 production topology, multi-arch GHCR release pipeline, Testcontainers-based installer testing
**Confidence:** MEDIUM-HIGH overall — HIGH on verifiable facts (Next.js build-time rewrites, Drizzle migrator API, Docker's own official apt-repo steps, dash/pipefail incompatibility, GHCR arm64 runner availability), MEDIUM on installer-script design choices synthesized from Coolify/Dokploy/Docker's own real scripts (all fetched and read directly, not just summarized secondhand)

## Summary

This phase has no ambiguity about *what* to build — D-01 through D-19 in 06-CONTEXT.md already lock the shape (prebuilt GHCR images, `/opt/noodara`, additive `.env` merge, apt-repo Docker install, three-layer testing). What research resolves is *how*, verified against the real Coolify (`coollabsio/coolify/scripts/install.sh`) and Dokploy (`Dokploy/website/apps/website/public/install.sh`) scripts, Docker's own official `get.docker.com` script, current Next.js/Drizzle documentation, and current GitHub Actions capabilities.

The single most consequential finding: **`curl | sh` is not `curl | bash`.** Both Coolify and Dokploy actually publish `| bash` (or `| sudo bash`) and their scripts open with `#!/bin/bash` and use `$EUID`, `[[ ]]`, and other bashisms freely. Noodara's D-03 explicitly commits to `| sh`. On Ubuntu 22.04/24.04, `/bin/sh` is dash (0.5.11 and 0.5.12 respectively), which does **not** support `set -o pipefail` (added to dash only in 0.5.13+) and rejects `[[ ]]`, `$EUID`, arrays, and `local` is a non-portable dash extension best avoided. Piping into `sh` does not honor the script's own shebang line — dash interprets the whole stream as POSIX sh regardless of what `#!` says. Docker's own official installer (`get.docker.com`) is written for exactly this scenario: `#!/bin/sh`, `set -e` only (no `-o pipefail`), zero bashisms. **Noodara's `install.sh` must follow `get.docker.com`'s convention, not Coolify's or Dokploy's** — this is the opposite of what a naive "look at what Coolify does" pass would conclude, and it must be tested under real dash (not bash) to catch violations before they reach a user's VPS.

The second load-bearing finding: Next.js's `rewrites()` **is evaluated once at `next build` time** and baked into `routes-manifest.json`; a `next start`/standalone production server never re-invokes the user's `rewrites()` function — it reads the pre-built manifest. This confirms 06-CONTEXT.md's own suspicion: `NOODARA_API_ORIGIN` must be a **build-time** argument to the `web` Docker image, fixed to the Compose-internal address of the `api` service (e.g. `http://api:3000`), not a runtime environment variable read by a running container. This has direct consequences for the release workflow (the `web` image must be built knowing the service name the production Compose file will use) and for `.env`/Compose design (the `api` service's internal port and name become a contract baked into every published `web` image tag, not just a runtime config value).

Third: **Dokploy's own installer is the direct, current precedent for public-IP discovery** (`ifconfig.io` → `icanhazip.com` → `ipecho.net/plain`, each with a short `--connect-timeout`, falling back to asking the operator to set the address manually) — Noodara should reuse this exact fallback chain rather than inventing a new one, since it is already proven against the flakiness of any single IP-echo service (Dokploy's own issue tracker documents `ifconfig.me` outages breaking installs when only one service was used).

**Primary recommendation:** Write `install.sh` as strict POSIX `sh` (verified against real `dash`, not just `shellcheck --shell=sh`), test its pure functions with Vitest spawning `sh` (no new tooling dependency — bats-core would be a new, non-npm CI toolchain requirement this project's "zero new tooling unless justified" posture doesn't currently need), build `api`/`worker`/`web` images via `turbo prune --docker` + multi-stage Dockerfiles with a non-root user, run Drizzle's `migrate()` from plain compiled JS as a one-shot Compose service gated by `depends_on: condition: service_completed_successfully`, and publish multi-arch images using GitHub's native `ubuntu-24.04-arm` runners (free and unlimited for public repos since August 2025) rather than QEMU emulation, specifically because `argon2`'s and `ssh2`'s native addons are exactly the kind of dependency that misbehaves under emulated builds.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| OS/arch/RAM/disk/port/snap preflight | Host (install.sh, POSIX sh) | — | Runs before any container exists; must work with only coreutils + curl, no Docker yet |
| Docker Engine + Compose plugin install | Host (install.sh, apt) | — | System package management, outside any container's reach |
| `.env` generation / additive merge | Host (install.sh) | — | Secrets must exist on the host filesystem (`/opt/noodara/.env`, mode 600) before any container reads them |
| Image pull / version pinning | Host (install.sh → Docker Compose CLI) | — | `docker compose pull` against GHCR; no build-on-VPS (D-01) |
| Migrations | `api`/`migrate` one-shot container | Database / Storage | Compiled `node dist/db/migrate.js` run as a Compose one-shot service, gated before `api`/`worker` start |
| HTTP API + SSE | `api` container | — | Existing Fastify app, unchanged contract (phase 4) |
| Background jobs | `worker` container | — | Existing BullMQ worker, unchanged contract (phase 4) |
| Same-origin proxy (`/api/*` → `api`) | `web` container (Next.js rewrites, baked at build time) | CDN/Static (none in v0.1) | ADR 0006; rewrites are resolved at `next build`, so the internal `api` address is a Docker image build-time constant, not a runtime env var |
| Setup-token / admin bootstrap read | Host (install.sh reads `docker compose logs api`) | — | D-01/D-04 already implemented; installer only consumes stdout, never generates tokens itself |
| Firewall (ufw) | Host (advisory only) | — | D-08: install.sh detects and warns, never mutates `ufw` rules |
| Multi-arch image build | CI (GitHub Actions, release workflow) | — | Runs once per release, produces the images `install.sh` later only pulls |

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Images are prebuilt and published to GHCR (`ghcr.io/<owner>/noodara-*`); the installer only `pull`s. No build-on-VPS, no fallback to build-from-source.
- **D-02:** The public GitHub repo is created manually by the user (does not exist yet). No plan runs `gh repo create` or `git push`.
- **D-03:** `install.sh` is served from `raw.githubusercontent.com` (`curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | sh`). No custom domain in v0.1; the script must not assume its own URL.
- **D-04:** Default version = latest stable release, resolved by the script; `NOODARA_VERSION` overrides it explicitly. The exact tag is written to `.env` and Compose references it — never `:latest`.
- **D-05:** Default install is HTTP. If the resulting `NOODARA_PUBLIC_URL` is `http://`, the installer writes `NOODARA_COOKIE_INSECURE=true` to `.env` and prints a clear unencrypted-traffic warning. An `https://` URL never gets the opt-out written.
- **D-06:** Panel port on host: 3000, overridable via `NOODARA_PORT`. 80/443 stay free for Traefik (v0.4). Busy port fails preflight with a suggested override.
- **D-07:** `NOODARA_PUBLIC_URL` resolution order: explicit override > external public-IP service with short timeout > local default-route IP. Installer prints the chosen URL and how to change it.
- **D-08:** If `ufw` is active, install.sh detects and warns, never modifies rules. Prints the exact `ufw allow <port>/tcp` command and a note about cloud-provider firewalls, with accurate wording about Docker's published ports typically bypassing `ufw`.
- **D-09:** Re-running = upgrade to latest release (or `NOODARA_VERSION`): preserves `.env` and volumes, pulls, migrates, `docker compose up -d`. No-op with health check if already on that version. Only upgrade path in v0.1.
- **D-10:** Install location: `/opt/noodara` (compose file + `.env`, mode 600, root). Data in named Docker volumes (`noodara_postgres_data`, `noodara_redis_data`), never bind mounts. `/opt/noodara/.env`'s existence signals "already installed."
- **D-11:** Existing `.env`: secrets are never regenerated or rewritten. A release-added required variable is appended without touching existing ones (additive merge). A `.env.bak-<timestamp>` (mode 600) is written before any change. Normal upgrade only changes `NOODARA_VERSION`.
- **D-12:** A healthcheck-failing upgrade fails with diagnostics, no automatic rollback. Non-zero exit, names the unhealthy service, tails its logs, states how to roll back (`NOODARA_VERSION=<previous>`, which the installer records). Data/secrets untouched.
- **D-13:** Re-run with an existing admin: final message shows only the URL (no token). Without an admin: re-prints the current token read from logs.
- **D-14:** Missing Docker/Compose installed from Docker's official apt repo, step by step (GPG key + `download.docker.com` + `docker-ce` + `docker-compose-plugin`), each step with its own error message. Never `get.docker.com`. Ubuntu only, no multi-distro logic.
- **D-15:** RAM < 1 GB fails, < 2 GB warns; disk free < 5 GB fails. Override: `NOODARA_SKIP_RESOURCE_CHECK=1`.
- **D-16:** Architectures: amd64 and arm64 only, multi-arch images via buildx in the release workflow; any other arch fails preflight. arm64 build must be genuinely verified (argon2, ssh2 native deps).
- **D-17:** Full preflight (OS 22.04/24.04, arch, RAM/disk, panel port, Docker-via-snap, root/sudo) runs before writing or installing anything; every failure has its own exit code and actionable message, never a generic "installation failed".
- **D-18:** Three testing layers with TDD: (1) shell unit tests for preflight/URL-version-resolution/`.env`-merge as pure shell functions with fixtures (bats vs. Vitest+`sh` — research decides); (2) Testcontainers integration: privileged Ubuntu 22.04/24.04 with Docker-in-Docker running `install.sh` twice in a row against locally-built images, covering idempotency, busy port, snap Docker, low RAM, unsupported OS, admin pre-seed, printed token; (3) manual validation on a real VPS by the user as the phase's closing gate.
- **D-19:** For layer 2 to work without a registry, the installer accepts a test-only registry/tag override (name at planner's discretion); never documented as a user feature.

### Claude's Discretion

- Internal `install.sh` structure (POSIX `sh` vs. `bash` — note the published command is `| sh`), function names, exit-code table.
- Root vs. `sudo` detection/re-exec mechanics.
- Output tone/format (English; calm, progressive, "Calm interface"), whether to keep `/opt/noodara/install.log` (no secrets).
- Dockerfiles: multi-stage, base image, non-root user, Next.js `output: 'standalone'`, final image size.
- How production migrations run (one-shot Compose service vs. `docker compose run`); `db:migrate` today uses `tsx`, production needs a compiled entrypoint.
- Concrete public-IP discovery service and timeout; "latest stable release" resolution mechanism (GitHub API vs. `releases/latest` redirect).
- GHCR image names, release workflow triggers, image signing/provenance.
- `redis`/`web` Compose healthchecks; per-container memory limits.
- Minimal install docs (README/`docs/`): command, supported vars, upgrade, troubleshooting.

### Deferred Ideas (OUT OF SCOPE)

- Automatic image rollback after a failed upgrade — v0.3+ (deployment engine's scope).
- Automatic `pg_dump` backup before each upgrade.
- Custom install-script domain (`get.noodara.*`) — when a domain exists; D-03 keeps the script agnostic to its own URL.
- Nightly job running the real `install.sh` on a clean Ubuntu runner — once the remote exists.
- Build-from-source on the VPS as a pull alternative.
- Uninstaller and a host-side `noodara` CLI wrapper.
- HTTPS automation, Traefik, domains — v0.4 by roadmap.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INST-01 | One-command install: Docker+Compose if missing, `.env` with random secrets, api/worker/web/postgres/redis up, migrations applied | §"Standard Stack", §"Architecture Patterns" (Dockerfiles, Compose shape), §"Code Examples" (apt-repo steps, migration one-shot), §"Idempotent .env merge" |
| INST-02 | Re-running an existing install never destroys data/secrets: detects and updates or no-ops | §D-09/D-11 support in "Architecture Patterns", §"Common Pitfalls" (Compose re-running one-shot services), §"Idempotent .env merge" |
| INST-03 | Preflight (OS, ports, Docker-via-snap, arch, RAM) fails with actionable message before touching the system | §"Code Examples" (Coolify/Dokploy real preflight snippets), §"Common Pitfalls" |
| INST-04 | Installer prints panel URL + one-time setup token at the end | §"Code Examples" (reading `NOODARA_SETUP_TOKEN=` from `docker compose logs api`, already implemented in phase 1) |
| INST-05 | `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` create the admin directly, skipping interactive setup | Already implemented (`bootstrap-admin.ts`, D-04 phase 1); installer only passes the env vars through `.env` |
</phase_requirements>

## Standard Stack

### Core

| Tool | Version | Purpose | Why Standard |
|------|---------|---------|---------------|
| POSIX `sh` (dash-compatible) | dash 0.5.11 (22.04) / 0.5.12 (24.04) | `install.sh` implementation language | `curl \| sh` executes under `/bin/sh` = dash on Ubuntu, ignoring the script's own shebang; Docker's own `get.docker.com` uses this exact convention `[CITED: get.docker.com]` |
| Docker Engine + `docker-compose-plugin` | Latest stable from `download.docker.com/linux/ubuntu` apt repo | Container runtime + Compose v2 CLI | D-14 locked; official apt-repo steps `[CITED: docs.docker.com/engine/install/ubuntu]` |
| `docker buildx` | Bundled with Docker Engine ≥ 19.03 / `docker-buildx-plugin` | Multi-arch image builds in CI | Standard for GHCR multi-arch publishing `[CITED: docs.docker.com]` |
| Turborepo `prune --docker` | Already pinned `turbo@^2.10.12` (root devDependency) | Produces a minimal build context per app for Docker | Already in the repo, zero new dependency; official Vercel-documented Docker pattern for pnpm+Turborepo monorepos `[CITED: turborepo.dev/docs/guides/tools/docker]` |
| `drizzle-orm/node-postgres/migrator`'s `migrate()` | Already pinned `drizzle-orm@0.45.2` | Applies pending migrations from plain compiled JS | Already used by `apps/control-plane/src/db/migrate.ts`; only the entrypoint changes for production (plain `node`, not `tsx`) `[VERIFIED: Context7 /drizzle-team/drizzle-orm-docs]` |
| Vitest (`spawnSync`/`execFileSync` against real `sh`) | Already pinned `vitest@5.0.0` | Shell unit tests for `install.sh`'s pure functions | Zero new tooling; keeps the entire test pyramid on one framework — see §"Shell testing layer" below |

### Supporting

| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| `docker/setup-qemu-action`, `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action` (GitHub Actions) | Current major versions at release-workflow authoring time — pin to a commit SHA per this repo's existing CI convention | Multi-arch image build/push pipeline | Standard GHCR publishing toolchain `[CITED: multiple 2026 sources, cross-checked]` |
| `ubuntu-24.04-arm` GitHub-hosted runner | GA since 2025-08-07 | Native arm64 build leg (no QEMU) | Free/unlimited on public repos; avoids emulation risk for `argon2`/`ssh2` native addons `[CITED: github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available]` |
| Testcontainers `GenericContainer` (already pinned `testcontainers@12.1.0`) | — | Privileged Ubuntu 22.04/24.04 container running its own `dockerd`, driving `install.sh` from outside via `exec()` | Already the project's integration-test pattern (`tests/integration/helpers/ssh.ts`); no new dependency |

### Alternatives Considered

| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| Vitest spawning real `sh` for shell unit tests | `bats-core` | bats is the de facto shell-testing standard and gives natural per-function isolation, but it is a new, non-npm CI/dev toolchain dependency (apt/brew install, separate CI step) that no other layer of this codebase uses; project posture explicitly favors zero new tooling unless justified — rejected, see §"Shell testing layer" |
| `turbo prune --docker` + Dockerfile per app | `pnpm deploy` | `pnpm deploy` assembles a self-contained prod copy of one package (dist + prod deps) and is simpler for a single-package repo, but does not prune the *source* build context the way `turbo prune` does, and this repo already depends on Turborepo's task graph (`^build` dependsOn) for correct build ordering across `packages/domain` → `packages/ssh`/`packages/ui` → apps; `turbo prune --docker` preserves that graph inside the pruned workspace, `pnpm deploy` does not run `turbo run build` at all `[CITED: turborepo.dev/docs/reference/prune]`, `[MEDIUM: pnpm/pnpm#10116 discussion]` |
| Debian-slim (`node:22-slim`) base image | Alpine (`node:22-alpine`) | Alpine is smaller and `argon2`'s prebuilt binaries have supported Alpine arm64 musl since v0.28.2 (well before the pinned 0.45.1) `[CITED: github.com/ranisalt/node-argon2 releases/socket.dev]`, so Alpine is *viable*, not broken — but `ssh2`'s optional `cpu-features` addon has a documented history of native-build friction on less-common target/build combinations `[CITED: github.com/mscdex/ssh2 issues #1080, #1139, #1083]`; since `cpu-features` is genuinely optional (ssh2 degrades gracefully without it) this is a low-severity risk either way. Recommend debian-slim as the primary choice for maximum native-module compatibility headroom given this is the very first production image this project has ever built; Alpine remains a documented, lower-risk-than-it-looks fallback if image size becomes a real constraint later |
| GitHub API (`api.github.com/repos/.../releases/latest`) for "latest stable" resolution | `releases/latest` HTTP redirect (`-o /dev/null -w '%{redirect_url}'`) | The redirect approach needs no JSON parsing at all (no `jq`, no `grep -Po`) and avoids `api.github.com`'s unauthenticated 60 req/hour rate limit entirely, since it's a plain HTTP 302 off `github.com` (not the API host) — recommended as primary. The JSON API is a viable fallback if a pre-release/draft filter is ever needed, using `grep -Po '"tag_name": "\K.*?(?=")'` to avoid a `jq` dependency `[CITED: gist.github.com/steinwaywhw, verified pattern]` |

**Installation:** No new npm packages are required for this phase — see Package Legitimacy Audit below.

**Version verification:** All versions above are either already pinned in this repo's `package.json`/`pnpm-lock.yaml` (re-verify with `npm view <pkg> version` only if the plan changes a pin) or are OS-level/GitHub-Actions tooling with no npm registry entry to check.

## Package Legitimacy Audit

No new npm/PyPI/crates packages are introduced by this phase. Everything needed (`drizzle-orm`, `turbo`, `vitest`, `testcontainers`) is already an approved, pinned dependency from earlier phases (see `docs/adr/0000-package-legitimacy-approvals.md`). The phase does add non-npm supply-chain surface that deserves the same scrutiny, tracked here instead of the npm-specific table:

| Artifact | Source | Trust basis | Disposition |
|----------|--------|--------------|-------------|
| `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin` (apt) | `download.docker.com/linux/ubuntu` official repo, GPG-signed | D-14 locked; official first-party vendor repo, not a third-party mirror | Approved |
| `node:22-slim` (or `node:22-alpine`) base image | Docker Hub, official `node` image (Node.js Foundation) | First-party official image | Approved |
| `docker/setup-qemu-action`, `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action` | GitHub Marketplace, `docker` org (verified publisher) | First-party Docker Inc. actions, same trust tier as `actions/checkout` already pinned-by-SHA elsewhere in this repo's workflows | Approved — pin to commit SHA per this repo's existing CI convention (see `.github/workflows/ci.yml`'s own comment on why) |
| `gitleaks/gitleaks-action` | Already pinned-by-SHA in `.github/workflows/ci.yml` | Precedent already established | N/A (no new usage this phase) |

**Packages removed due to slopcheck [SLOP] verdict:** none (no npm packages added).
**Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
                         ┌─────────────────────────────────────────┐
   curl -fsSL .../install.sh | sh                                  │
        │                                                          │
        ▼                                                          │
  ┌───────────────────────────┐   preflight (before any write)    │
  │ install.sh (POSIX sh)      │──► OS 22.04/24.04? arch amd64/    │
  │ runs on the bare VPS host  │    arm64? RAM/disk? port free?    │
  └──────────┬──────────────────┘  Docker via snap? root/sudo?     │
             │ pass                                                │
             ▼                                                     │
  ┌───────────────────────────┐                                    │
  │ Docker missing? install    │──► apt-repo GPG key, sources list, │
  │ from download.docker.com   │    docker-ce + compose-plugin      │
  └──────────┬──────────────────┘                                  │
             ▼                                                     │
  ┌───────────────────────────┐  first run: generate secrets       │
  │ /opt/noodara/.env          │  re-run: additive merge only,      │
  │ (mode 600)                 │  backup to .env.bak-<ts>           │
  └──────────┬──────────────────┘                                  │
             ▼                                                     │
  ┌───────────────────────────┐                                    │
  │ docker compose pull        │──► GHCR: ghcr.io/<owner>/          │
  │ (pinned NOODARA_VERSION)   │    noodara-control-plane:<tag>,    │
  └──────────┬──────────────────┘    noodara-web:<tag>              │
             ▼                                                     │
  ┌─────────────────────────────────────────────────────────────┐  │
  │ docker compose up -d  (production docker-compose.yml)        │  │
  │                                                                │  │
  │  postgres ──healthy──► migrate (one-shot, exits 0) ──► api ──► worker
  │  redis    ──healthy──►────────────────────────────────────┘     │
  │                                                    web (proxies  │
  │                                                    /api/* to api,│
  │                                                    NOODARA_API_  │
  │                                                    ORIGIN baked  │
  │                                                    at image      │
  │                                                    build time)   │
  └──────────┬──────────────────────────────────────────────────┘  │
             ▼                                                     │
  ┌───────────────────────────┐                                    │
  │ wait for api /health       │──► read `docker compose logs api`  │
  │ then print result           │    for `NOODARA_SETUP_TOKEN=...`  │
  └───────────────────────────┘    print panel URL + token/upgrade  │
                                    summary                          │
                                                                     │
  Separate pipeline (CI, not on the VPS):                           │
  ┌───────────────────────────┐                                    │
  │ release workflow (tag push)│──► turbo prune --docker per app    │
  │ buildx + native arm64      │    → multi-stage Dockerfile build  │
  │ runner + QEMU-free arm64   │    → push ghcr.io/.../<tag>        │
  └───────────────────────────┘    (amd64 + arm64 manifest list)    │
                                                          ────────────┘
```

### Recommended Project Structure

```
/ (repo root)
├── install.sh                        # POSIX sh, single file, sourced-and-tested functions
├── docker-compose.yml                # production compose (api/worker/web/postgres/redis)
├── .dockerignore
├── apps/
│   ├── control-plane/
│   │   └── Dockerfile                # multi-stage: pruner → installer → builder → runner (api & worker share this image, differ only by `command`)
│   └── web/
│       └── Dockerfile                # multi-stage: pruner → installer → builder → runner (Next.js standalone)
├── .github/workflows/
│   └── release.yml                   # tag-triggered, buildx multi-arch, pushes to GHCR
└── docs/
    └── install.md                    # command, supported env vars, upgrade, troubleshooting
```

### Pattern 1: POSIX-only `install.sh`, verified against real `dash`

**What:** Write every function in `install.sh` using only POSIX `sh` constructs: `[ ]` not `[[ ]]`, `id -u` not `$EUID`, `case` for pattern matching instead of `[[ =~ ]]`, no arrays, no `local` (dash supports it as a non-portable extension — avoid to stay strictly POSIX and portable to any future non-dash `/bin/sh`), `.` not `source`, `command -v` not `which`, `printf` not `echo -e`. `set -e` only — never `set -o pipefail` (unsupported on Ubuntu's shipped dash until 0.5.13+, which neither 22.04's 0.5.11 nor 24.04's 0.5.12 provide) `[CITED: launchpad.net/ubuntu/+source/dash — 22.04 ships 0.5.11+git..., 24.04 ships 0.5.12-6ubuntu5]`, `[CITED: shellcheck.net/wiki/SC3040]`.

**When to use:** The entire `install.sh`, because the published command is `curl -fsSL .../install.sh | sh` (D-03) and piping into `sh` on Ubuntu always executes under dash, regardless of any `#!/bin/bash` shebang line in the script text — the shebang is inert when the interpreter is invoked explicitly.

**Example (verified pattern, Docker's own official installer):**
```sh
#!/bin/sh
set -e
# Docker Engine for Linux installation script.
# ...
# Source: https://get.docker.com — fetched and read directly for this research.
```
`[CITED: get.docker.com, fetched 2026-09-21]`

**Contrast — what Coolify/Dokploy actually do (do NOT copy this part):**
```bash
#!/bin/bash
if [ $EUID != 0 ]; then
    echo "Please run this script as root or with sudo"
    exit
fi
```
`[CITED: github.com/coollabsio/coolify/blob/main/scripts/install.sh, fetched 2026-09-21]` — published as `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash`, i.e. explicitly `bash`, not `sh`. Dokploy is the same: `#!/bin/bash`, published `| sh` in some docs pages but its own script uses `$(id -u)` (POSIX-safe) alongside other bash-only constructs elsewhere — inconsistent, and not a safe model to copy verbatim.

### Pattern 2: Root/sudo detection (POSIX-safe)

**What:** Use `id -u` (POSIX, works under dash), not `$EUID` (bash-only).
```sh
if [ "$(id -u)" != "0" ]; then
  printf 'This installer must be run as root or with sudo.\n' >&2
  exit 1
fi
```
`[CITED: get.docker.com pattern + Dokploy's `$(id -u)` usage, both fetched 2026-09-21]`

### Pattern 3: snap-installed Docker detection

**What:** Coolify's actual check, POSIX-compatible as written:
```sh
if command -v snap >/dev/null 2>&1; then
  if snap list docker >/dev/null 2>&1; then
    printf 'Docker is installed via snap, which Noodara does not support. Remove it (sudo snap remove docker) and re-run this installer.\n' >&2
    exit 1
  fi
fi
```
`[CITED: github.com/coollabsio/coolify/blob/main/scripts/install.sh, fetched 2026-09-21 — logic verified compatible with strict POSIX sh]`

### Pattern 4: Port-in-use preflight (neither Coolify nor Dokploy does this well — Dokploy is the closer precedent)

**What:** Dokploy checks specific ports with `ss`, which ships by default on Ubuntu (`iproute2`, always present):
```sh
if ss -tulnp 2>/dev/null | grep -q ":${NOODARA_PORT} "; then
  printf 'Port %s is already in use. Set NOODARA_PORT=<other> and re-run.\n' "$NOODARA_PORT" >&2
  exit 1
fi
```
`[CITED: Dokploy/website install.sh, fetched 2026-09-21]` — Coolify has **no port-check at all** in its script, which is exactly the root cause of its own documented issue #3693 ("proxy doesn't start if port 80 is in use, even when not configured to use that port") and the port-8000 silent-failure pattern in PITFALLS.md #5. This is the concrete negative example that justifies D-17's hard requirement.

### Pattern 5: Official Docker apt-repo installation (D-14)

```sh
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```
`[CITED: docs.docker.com/engine/install/ubuntu, fetched 2026-09-21 — this is the current official documented form; Docker's docs now recommend a DEB822-format `.sources` file as the primary example but the classic `.list` form above remains supported and is simpler to generate from `sh` without DEB822 quoting edge cases]`. Note Docker's own docs list **conflicting packages to remove first** (`docker.io`, `docker-compose`, `docker-doc`, `podman-docker`, `containerd`, `runc`) — worth a `apt-get remove -y` pass before install, each removal non-fatal if the package isn't present.

### Pattern 6: Public-IP discovery with fallback chain and short timeouts (D-07)

**What:** Dokploy's exact, already-battle-tested chain:
```sh
get_public_ip() {
  curl -4s --connect-timeout 5 https://ifconfig.io 2>/dev/null && return 0
  curl -4s --connect-timeout 5 https://icanhazip.com 2>/dev/null && return 0
  curl -4s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null && return 0
  return 1
}
```
`[CITED: Dokploy/website install.sh, fetched 2026-09-21]`. Coolify uses a single `ifconfig.io` call with `--max-time 5` and no fallback — Dokploy's multi-service chain is the stronger precedent given Dokploy's own issue tracker documents a single-service outage (`ifconfig.me`) breaking installs. **Local default-route IP fallback** (D-07's third tier) for when all external services fail:
```sh
get_local_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}'
}
```
`ip` (iproute2) is present by default on Ubuntu Server 22.04/24.04.

### Pattern 7: Resolving "latest stable release" without `jq`

**Primary — HTTP redirect (no JSON parsing at all):**
```sh
resolve_latest_version() {
  curl -fsSL -o /dev/null -w '%{redirect_url}' "https://github.com/${OWNER}/${REPO}/releases/latest" | \
    awk -F/ '{print $NF}'
}
```
This hits `github.com` (not `api.github.com`), so it is **not subject to the unauthenticated REST API's 60 requests/hour rate limit** — a meaningful robustness win for an installer that many independent users will run concurrently against the same repo. `[MEDIUM: synthesized from documented curl redirect-following patterns, cross-checked against GitHub's documented `releases/latest` redirect behavior — no single authoritative source states the rate-limit exemption explicitly, but it follows directly from the endpoint being served by github.com's web frontend, not api.github.com]`

**Fallback — GitHub REST API, `grep`-parsed (no `jq`):**
```sh
resolve_latest_version_api() {
  curl -fsSL "https://api.github.com/repos/${OWNER}/${REPO}/releases/latest" | \
    grep -Po '"tag_name":\s*"\K[^"]+'
}
```
`[CITED: gist.github.com/steinwaywhw pattern, cross-checked against multiple independent "no jq" GitHub-release gists, fetched 2026-09-21]`. Use only as fallback since it consumes API rate-limit budget and requires `grep -P` (GNU grep PCRE support — present on Ubuntu's default `grep`, but worth a `grep -P` capability check since not every `sh`-invoking environment guarantees GNU grep).

### Pattern 8: Next.js `rewrites()` is a build-time contract, not runtime config

**Verified via Context7 `/vercel/next.js`:**
> "During `next build`, `loadCustomRoutes(config)` is called, which invokes the user's `rewrites()` function. In production (`next start`), the server reads rewrites from the pre-built JSON manifest instead of calling the user's function again. Only in dev mode is `loadCustomRoutes` called at server start." `[VERIFIED: Context7 /vercel/next.js, source packages/next/src/server/lib/router-utils/filesystem.ts]`

**Implication for this phase:** `NOODARA_API_ORIGIN` must be passed as a Docker **build** argument (`docker build --build-arg NOODARA_API_ORIGIN=http://api:3000 ...`), not a Compose `environment:` entry on the `web` service at runtime — a runtime-only env var would be silently ignored because the standalone server never re-reads `next.config.ts`'s `rewrites()`. This makes the `api` service's Compose-internal name (`api`) and port (whatever `PORT` the image runs `dist/server.js` on — currently 3000 per `env.ts`'s default) a **contract baked into every published `web` image tag**. The release workflow's `web` Dockerfile build step must set this build arg to the fixed internal address the production `docker-compose.yml` will always use for the `api` service (recommend keeping the compose service literally named `api` so this never needs to vary between releases).

### Pattern 9: Production migrations from plain compiled JS

**Verified via Context7 `/drizzle-team/drizzle-orm-docs`:** `migrate(db, { migrationsFolder })` from `drizzle-orm/node-postgres/migrator` is the exact function `apps/control-plane/src/db/migrate.ts` already wraps (`runMigrations`). ADR 0003 already established that `apps/control-plane/dist` is self-contained — `copy-migration-assets.mjs` copies `src/db/migrations` into `dist/db/migrations` as part of `pnpm build`, and `apps/control-plane/package.json`'s `db:migrate` script (`tsx src/db/migrate.ts`) is a **dev-only** entrypoint. For production, the compiled `dist/db/migrate.js` already works standalone under plain `node` — no new code needed, only a new Compose service invoking it:

```yaml
migrate:
  image: ghcr.io/<owner>/noodara-control-plane:${NOODARA_VERSION}
  command: ["node", "dist/db/migrate.js"]
  env_file: .env
  depends_on:
    postgres:
      condition: service_healthy
  restart: "no"

api:
  image: ghcr.io/<owner>/noodara-control-plane:${NOODARA_VERSION}
  command: ["node", "dist/server.js"]
  depends_on:
    migrate:
      condition: service_completed_successfully
    redis:
      condition: service_healthy
```
`restart: "no"` on `migrate` is deliberate — a one-shot that should never auto-restart on exit (success or failure); its exit code alone gates `api`/`worker`. **Known pitfall:** `docker compose up` on subsequent runs (including the installer's own upgrade path, D-09) will start the `migrate` container again even though its previous run already exited 0 — this is a [documented Compose behavior](https://github.com/docker/compose/issues/9260), not a bug in this design. It is harmless here specifically because Drizzle's `migrate()` is idempotent (it diffs the migrations-tracking table and no-ops when nothing is pending) — this must be stated explicitly as the reason it's safe, not silently relied upon. `[VERIFIED: Context7 /drizzle-team/drizzle-orm-docs — migrate() "picks previously unapplied migrations"]`, `[CITED: github.com/docker/compose/issues/9260]`.

### Pattern 10: Dockerfile — `turbo prune --docker` + multi-stage, non-root

```dockerfile
# ---- pruner ----
FROM node:22-slim AS pruner
RUN corepack enable
WORKDIR /app
COPY . .
RUN npx turbo prune @noodara/control-plane --docker

# ---- installer (deps only, cache-friendly) ----
FROM node:22-slim AS installer
RUN corepack enable
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# ---- builder ----
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
RUN npx turbo run build --filter=@noodara/control-plane

# ---- runner ----
FROM node:22-slim AS runner
WORKDIR /app
RUN groupadd -r noodara && useradd -r -g noodara noodara
COPY --from=builder --chown=noodara:noodara /app/apps/control-plane/dist ./dist
COPY --from=builder --chown=noodara:noodara /app/apps/control-plane/node_modules ./node_modules
COPY --from=builder --chown=noodara:noodara /app/node_modules ./root_node_modules
USER noodara
EXPOSE 3000
CMD ["node", "dist/server.js"]
```
`[CITED: turborepo.dev/docs/guides/tools/docker, cross-checked structure against the pattern described in computingforgeeks.com/turborepo-docker-builds-turbo-prune]`. The `worker` image is the **same** built artifact — Compose overrides only `command: ["node", "dist/worker.js"]` (already the pattern locked by phase 4 D-23/ADR 0003 — one image, two entrypoints). `apps/web`'s Dockerfile follows the same pruner/installer/builder shape, with the `builder` stage additionally requiring `output: 'standalone'` added to `next.config.ts` (currently absent — a real code change this phase must make) and the `runner` stage following the official Next.js standalone pattern exactly:

```dockerfile
# runner stage, web
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd -r nodejs && useradd -r -g nodejs nodejs
RUN mkdir .next && chown nodejs:nodejs .next
COPY --from=builder --chown=nodejs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nodejs:nodejs /app/apps/web/.next/static ./.next/static
USER nodejs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```
`[VERIFIED: Context7 /vercel/next.js, examples/with-docker/Dockerfile]` — note `apps/web/public/` does not currently exist in this repo (confirmed by directory listing); the standard `COPY .../public ./public` line should be omitted or made conditional, since `next build`'s standalone tracing does not require a `public/` directory to exist.

**Note on argon2's native build:** `pnpm-workspace.yaml` already declares `onlyBuiltDependencies: [argon2]`, so a plain `pnpm install --frozen-lockfile` inside the `installer` stage will run argon2's install script without an interactive approval prompt — no Dockerfile change needed for this. `argon2@0.45.1` (the pinned version) has shipped Alpine-arm64-musl prebuilds since v0.28.2, well before this pin, and debian-slim (glibc) prebuilds since v0.26.0 — either base image resolves without a compiler toolchain in the image. `[CITED: github.com/ranisalt/node-argon2/releases, socket.dev/npm/package/argon2]`.

### Pattern 11: GHCR multi-arch release workflow

```yaml
name: release
on:
  push:
    tags: ['v*.*.*']
permissions:
  contents: read
  packages: write
jobs:
  build-and-push:
    strategy:
      matrix:
        include:
          - app: control-plane
            image: noodara-control-plane
          - app: web
            image: noodara-web
    runs-on: ubuntu-24.04-arm   # native arm64 leg
    # a second job (or a matrix `arch` dimension) on ubuntu-latest builds the amd64 leg;
    # docker/build-push-action + buildx merges both into one multi-arch manifest via
    # `platforms: linux/amd64,linux/arm64` when run on a single job with QEMU, OR — the
    # stronger recommendation given argon2/ssh2 native deps — two separate native-arch
    # jobs each pushing a per-arch tag, then a final `docker buildx imagetools create`
    # step combining them into one manifest list. This avoids QEMU emulation entirely.
    steps:
      - uses: actions/checkout@<sha>
      - uses: docker/setup-buildx-action@<sha>
      - uses: docker/login-action@<sha>
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@<sha>
        with:
          context: .
          file: apps/${{ matrix.app }}/Dockerfile
          push: true
          tags: ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}:${{ github.ref_name }}
```
`[CITED: multiple 2026 sources on docker/build-push-action multi-arch patterns, cross-checked against docker/setup-qemu-action's own README and GitHub's arm64-runner GA announcement]`. **Permissions:** `contents: read` + `packages: write` is the minimum for GHCR push via the built-in `GITHUB_TOKEN` — no PAT needed. **Recommendation: prefer two native-arch jobs over one QEMU job** specifically because this is the first Docker build this codebase has ever produced with native addons in the dependency tree (`argon2`, `ssh2`'s optional `cpu-features`), and QEMU-emulated `npm`/`pnpm` install-script execution for native addons has a documented history of subtle, hard-to-diagnose failures across the ecosystem — native arm64 runners eliminate that entire risk class for the cost of one extra job, and are free/unlimited on a public repo. `[CITED: github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available]`.

### Anti-Patterns to Avoid

- **Writing `install.sh` with bash syntax because Coolify/Dokploy do.** Both are actually invoked with `bash`, not `sh` — copying their syntax into a script published as `| sh` produces a script that passes every local `bash install.sh` test run and then fails with syntax errors the first time a real user runs the actual published `curl | sh` command.
- **`set -o pipefail` anywhere in `install.sh`.** Fails immediately under dash on both target Ubuntu versions with `set: Illegal option -o pipefail`.
- **Relying on `next start`/the standalone server to pick up `NOODARA_API_ORIGIN` at runtime.** It won't — `rewrites()` only runs at `next build`.
- **Skipping the port-in-use preflight "because it's rare."** This is Coolify's own documented, still-open failure mode (#3693, the port-8000 silent-failure pattern in PITFALLS.md #5) — the exact negative example D-17 exists to prevent.
- **Using `ifconfig.me` as the sole public-IP source.** Documented single point of failure in Dokploy's own issue tracker; use the 3-service fallback chain.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Parsing GitHub's release JSON | A custom JSON parser in `sh` | `grep -Po '"tag_name":\s*"\K[^"]+'` (fallback) or the `releases/latest` redirect (primary, no parsing at all) | POSIX sh has no JSON support; regex-over-known-shape is the standard, well-precedented workaround for exactly this one field |
| Multi-arch image assembly | Manual manifest-list `docker manifest create` scripting | `docker buildx build --platform ...` / `docker buildx imagetools create` | buildx is the current first-party tool for this; hand-rolling manifest lists is what buildx replaced |
| `.env` file parsing/merging in shell | A bespoke line-by-line parser with ad hoc quote handling | POSIX `case`/`grep -q '^KEY='` presence checks per known variable name, appending only missing keys — see §"Idempotent `.env` merge" below | `.env.example`'s variable set is small, fixed, and fully known at install-script-authoring time; a generic dotenv parser is unneeded complexity for a closed, known key set |
| Waiting for container health before proceeding | Custom polling loops with arbitrary `sleep` | Compose's own `healthcheck:` + `depends_on: condition: service_healthy` / `service_completed_successfully` | Already the pattern `docker-compose.dev.yml` and phase 4's `/health` design use; Compose's built-in wait semantics are more precise than an external poll loop |

**Key insight:** Every "don't hand-roll" item above has a small, fixed, closed problem shape (one known JSON field, one known variable set, one known health contract) — the temptation to hand-roll comes from `sh`'s limited tooling, not from the problems actually being open-ended. Resist reaching for a new dependency (`jq`, a Python script) to solve a problem `grep`/`case`/Compose's own primitives already solve within the "no new tooling" posture.

## Common Pitfalls

### Pitfall 1: `curl | sh` executing bash-only syntax under dash

**What goes wrong:** `install.sh` is authored and tested with `bash install.sh` (or even just visually reviewed) and looks correct, then fails the moment a real user runs the actual published `curl -fsSL ... | sh` command, because `/bin/sh` on Ubuntu is dash and rejects `[[ ]]`, `$EUID`, arrays, `+=`, and `set -o pipefail`.
**Why it happens:** Bash is nearly always present and `bash script.sh` "just works" during development, masking the gap between "what I tested" and "what D-03 actually publishes."
**How to avoid:** Every shell unit test (D-18 layer 1) must invoke functions through real `sh` (`/bin/sh`, or explicitly `dash` in CI), never `bash script.sh`. Add a CI step that runs `shellcheck --shell=sh install.sh` in addition to the dash-based functional tests, since shellcheck's `sh` dialect check catches many (not all) bashisms statically.
**Warning signs:** Any test invocation of the script that says `bash install.sh` or `. install.sh` inside a bash-launched CI step.

### Pitfall 2: Compose re-running the `migrate` one-shot on every `up` (including upgrades)

**What goes wrong:** Naive expectation that a one-shot container that already exited 0 stays "done" forever; in reality `docker compose up -d` (the installer's own upgrade command, D-09) restarts it again on every re-run.
**Why it happens:** Compose v2's documented behavior for services without an explicit "already succeeded, skip" concept — `service_completed_successfully` only gates *dependents*, it does not make the one-shot itself skip re-execution.
**How to avoid:** This is safe *only because* Drizzle's `migrate()` is idempotent (diffs the migration-tracking table). State this explicitly in the Compose file's comments so a future contributor doesn't "fix" it by adding fragile skip-logic that could itself introduce a bug. Do not set `restart: always` on `migrate` — only the default `restart: "no"`.
**Warning signs:** A `migrate` service with any `restart:` policy other than `"no"`, or migration code that isn't provably idempotent.

### Pitfall 3: Baking the wrong `NOODARA_API_ORIGIN` into the `web` image

**What goes wrong:** A `web` image built with `NOODARA_API_ORIGIN=http://localhost:3100` (a dev value) leaking into a published release tag, silently breaking every production install because the standalone server never re-reads it.
**Why it happens:** `next build`'s failure mode for a *wrong* (but present) value is not a crash — it just proxies to the wrong address, producing confusing runtime 502s/timeouts rather than a clear build-time error.
**How to avoid:** The release workflow's `web` Dockerfile build step must explicitly set `--build-arg NOODARA_API_ORIGIN=http://api:3000` (or whatever the production Compose file's fixed internal contract is) and this value must be covered by an integration test that actually curls `/api/*` through a running `web` container against a running `api` container, not just a build-succeeds check.
**Warning signs:** Any Dockerfile for `apps/web` that doesn't set `NOODARA_API_ORIGIN` as a `ARG`/`ENV` pair before the `RUN pnpm build` (or `turbo run build`) step.

### Pitfall 4: Redis healthcheck in `docker-compose.dev.yml` is silently broken — do not copy it into production unfixed

**What goes wrong:** `docker-compose.dev.yml`'s redis healthcheck (`redis-cli -a $${REDIS_PASSWORD} ping | grep -q PONG`) always reports unhealthy, because `$${REDIS_PASSWORD}` only substitutes at Compose-file-parse time when building the `command:` array — the `redis` service has no `environment: REDIS_PASSWORD: ...` entry, so the variable is **undefined inside the container's own shell** when the healthcheck actually executes there. `[VERIFIED: read docker-compose.dev.yml directly — `environment:` block for `redis` is absent; only `command:` references `${REDIS_PASSWORD}`]`.
**Why it happens:** `${VAR}` and `$${VAR}` look almost identical and Compose's host-side vs. container-side substitution timing is a genuinely easy mistake.
**How to avoid:** The production `docker-compose.yml`'s `redis` service must add an explicit `environment: REDIS_PASSWORD: ${REDIS_PASSWORD}` entry so the value exists inside the container for the healthcheck's `CMD-SHELL` to reference via `$$REDIS_PASSWORD`. Verify with an actual `docker inspect --format='{{.State.Health.Status}}'` check in the Testcontainers installer test (D-18 layer 2), not just "container is running."
**Warning signs:** `docker compose ps` showing `redis` as `unhealthy` indefinitely despite `redis-cli ping` working manually.

### Pitfall 5: `ufw` warning with imprecise wording (D-08)

**What goes wrong:** A warning that implies "ufw will block this" (false — Docker's `iptables` rules in the `FORWARD`/`DOCKER` chains run before `ufw`'s `INPUT`-chain rules ever see the packet for a *published* port) or implies "ufw fully protects you" (also false, for the same reason) both mislead the operator.
**Why it happens:** The interaction between Docker's own iptables manipulation and `ufw` is genuinely counter-intuitive and widely misunderstood even among experienced operators.
**How to avoid:** Precise wording: *"Docker publishes container ports by inserting its own iptables rules, which typically bypass ufw's rules entirely for published ports — a port Docker publishes may be reachable from the internet even if ufw shows it as denied. If you rely on ufw to restrict access to this port, see [docs link] for the DOCKER-USER-chain configuration needed to make ufw actually govern Docker's published ports."* `[CITED: github.com/docker/for-linux/issues/690, github.com/chaifeng/ufw-docker — DOCKER-USER chain explanation, fetched 2026-09-21]`
**Warning signs:** Any wording using "ufw will protect/block" without the "typically bypassed for Docker's published ports" qualifier.

### Pitfall 6: Testing the installer only against a "clean enough" VPS

**What goes wrong:** D-18 layer 2 covers snap Docker, busy port, low RAM, unsupported OS — but a real VPS may combine failure modes (e.g., Docker via snap *and* a busy port), and a preflight that checks in the wrong order could report the wrong root cause first.
**Why it happens:** Individual scenario tests each isolate one failure; combined scenarios are easy to skip.
**How to avoid:** At minimum, D-17's full preflight order should be deterministic and documented (e.g., OS → arch → RAM/disk → root/sudo → Docker-via-snap → port), and the D-18 layer-2 suite should include at least one multi-failure scenario asserting only the *first* applicable check's message is shown, not a confusing multi-line dump.
**Warning signs:** A preflight function that continues checking after the first failure instead of exiting immediately with that failure's specific exit code (contradicts D-17's "cada causa tiene mensaje accionable y exit code propio" requirement if it doesn't fail fast).

## Shell testing layer (D-18.1 decision)

**Recommendation: Vitest spawning real `sh`, not bats-core.**

Rationale:
1. **Zero new tooling.** `vitest@5.0.0` is already the project's sole test framework across unit/integration/component layers (noodara-tdd skill §2's table has no separate "shell" row — this phase is the first to need one, and the project's stated posture is "cero dependencias de tooling nuevas salvo necesidad justificada"). Vitest spawning `sh` satisfies the need with zero net-new CI/dev toolchain.
2. **bats-core is a genuinely good tool but is a new toolchain category.** It requires either an apt/homebrew install step or the `bats-core/bats-action` GitHub Action in every CI job that runs shell tests, plus a second, unrelated test-runner mental model (TAP output, `.bats` file syntax) alongside Vitest everywhere else in the repo. `[CITED: github.com/bats-core/bats-core, shellspec.info/comparison.html — both confirm bats' TAP/bash-family design]`
3. **The technique is straightforward and precedented elsewhere in this ecosystem:** structure `install.sh`'s logic as small, pure, side-effect-free `sh` functions (already necessary for D-17's per-cause exit codes) in a way that a test can `. install.sh --source-only` (a documented pattern: guard the script's own `main`-equivalent invocation behind a check so sourcing the file doesn't execute it) and then invoke individual functions via `execFileSync('sh', ['-c', 'source-and-call-here'])` or, more simply, `spawnSync('sh', [scriptPath, '--test-<function-name>', ...args])` with a small internal dispatch table for testability. Assert on `stdout`/`stderr`/exit code exactly as the integration layer already does for other subprocess-driven behavior (`tests/integration/helpers/boot-process.ts` is the existing in-repo precedent for spawning a real process and asserting on its output/exit code).
4. **This still genuinely exercises real `sh` (dash) semantics**, closing Pitfall 1 above, as long as the CI runner's `sh` is dash (true on `ubuntu-latest`) and the local test explicitly invokes `/bin/sh`, never falling back to whatever `$SHELL` a developer's machine happens to default to.

**Rejected:** bats-core, for the toolchain-proliferation reason above — not because it is a worse testing tool in isolation.

## Idempotent `.env` merge (D-11) without a full dotenv parser

Given `.env.example`'s known, fixed key set (§ read directly from the repo), a safe additive merge needs only:

```sh
# For each known KEY, append "KEY=" placeholder or a freshly generated value ONLY if
# no line starting with "KEY=" already exists. Never touches existing lines.
env_has_key() {
  key="$1"
  grep -q "^${key}=" /opt/noodara/.env 2>/dev/null
}

env_append_if_missing() {
  key="$1"
  value="$2"
  if ! env_has_key "$key"; then
    printf '%s=%s\n' "$key" "$value" >> /opt/noodara/.env
  fi
}
```

This avoids the general "parse arbitrary shell-quoted values with `#`, embedded `=`, base64 padding" problem entirely — the merge never *reads* existing values, it only checks **presence** of a `KEY=` prefix via anchored `grep -q '^KEY='`, then appends whole new lines for genuinely missing keys. Values already containing `#`, quotes, or `=` (e.g., a `DATABASE_URL` with a URL-encoded password, or a base64 secret ending in `=`/`==` padding) are never re-parsed or re-written, so nothing about their internal content matters to this logic — this is the concrete mechanism that keeps D-11 exact-and-safe. Before any write: `cp /opt/noodara/.env "/opt/noodara/.env.bak-$(date +%Y%m%d%H%M%S)"` then `chmod 600` both the backup and (on generation) the new file.

## Compose details (Claude's Discretion items, resolved with evidence)

| Item | Recommendation | Evidence |
|------|-----------------|----------|
| `redis` healthcheck | `test: ["CMD-SHELL", "redis-cli -a \"$$REDIS_PASSWORD\" ping \| grep -q PONG"]` **plus** an `environment: REDIS_PASSWORD: ${REDIS_PASSWORD}` entry on the service (missing in dev compose — see Pitfall 4) | Direct read of `docker-compose.dev.yml`, confirmed broken as designed |
| `web` healthcheck | `test: ["CMD", "node", "-e", "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]` — Node 22's built-in global `fetch`, since a debian-slim/alpine image has no guaranteed `curl`/`wget` | Standard pattern for minimal Node images lacking a HTTP CLI tool; Node 22 ships `fetch` globally (stable since Node 18) |
| `stop_grace_period` | `api`/`worker`: derive from the same D-14 (phase 4) job-timeout budget already computed for `lockDuration` (`connectMs × 2 + 2000 + discoveryMs + 30000` ms, converted to a grace period with headroom) — do not invent a new number; `web`: Next.js's default SIGTERM handling is fast, a short default (10s) suffices | Phase 4 D-25 already locks the worker's own graceful-shutdown budget; this phase must reuse it, not redefine it |
| `depends_on` conditions | `postgres`/`redis`: `condition: service_healthy`; `migrate`: `condition: service_completed_successfully` on `api`/`worker` | Standard Compose v2 primitive, already the pattern `docker-compose.dev.yml` uses for postgres/redis health |
| Memory limits | Set conservative `deploy.resources.limits.memory` per service (e.g., `api`/`worker`: 512M each, `web`: 512M, `postgres`/`redis`: use their own conventional defaults) sized against D-15's 1GB-fail/2GB-warn RAM floor, so a 2GB VPS can run the full stack without OOM | Derived from D-15's own stated minimums; needs validation against real measured usage during D-18 layer 2/3 testing, not assumed correct on paper — flag as an assumption (see below) |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|-----------------|
| A1 | The `releases/latest` HTTP-redirect approach for resolving the latest tag is not subject to `api.github.com`'s 60 req/hr unauthenticated rate limit, because it is served by `github.com`'s web frontend, not the REST API host | Pattern 7 | If wrong, high-traffic install days could see 302-redirect failures too — low likelihood (no evidence GitHub rate-limits its own web redirect the same way as the API), but not independently confirmed against GitHub's own documented rate-limit policy for this specific endpoint |
| A2 | Two native-arch GitHub Actions jobs (one on `ubuntu-latest`, one on `ubuntu-24.04-arm`) combined via `docker buildx imagetools create` is preferable to a single QEMU-emulated multi-platform build for this specific dependency tree (argon2, ssh2) | Pattern 11 | If the native-arch approach has its own friction (e.g., cache-sharing complexity across two jobs) the QEMU single-job approach remains a documented, simpler fallback — not a hard blocker either way |
| A3 | Memory limits (512M for api/worker/web) are sized correctly against D-15's 1-2GB RAM floor | Compose details table | Actual usage is unmeasured; must be validated empirically during D-18 layer 2/3, not treated as locked from research alone |
| A4 | A DEB822-format `.sources` file (Docker's now-preferred documented form) vs. the classic `.list` form both remain fully supported on 22.04/24.04 at install time | Pattern 5 | If Docker deprecates the `.list` form before this phase ships, the apt-repo step needs updating; current docs (fetched 2026-09-21) present both, with `.list` still functional |

**If this table is empty:** N/A — see entries above.

## Open Questions

1. **Does `docker buildx imagetools create` cleanly combine two separately-pushed per-arch tags into one multi-arch manifest list referenced by the final release tag, without a race if both arch jobs finish at different times?**
   - What we know: This is buildx's documented mechanism for exactly this two-job pattern.
   - What's unclear: Exact GitHub Actions job-dependency wiring (`needs:`) to guarantee both per-arch pushes complete before the manifest-list step runs — not yet drafted as real YAML.
   - Recommendation: Planner should draft the release workflow with an explicit `needs: [build-amd64, build-arm64]` gate before the `imagetools create` step; verify with a real (non-tagged, manually `workflow_dispatch`-triggered) dry run before the first real version tag.

2. **Exact Testcontainers DinD image for the installer's layer-2 harness — build once and reuse, or build per Ubuntu version like the existing sshd fixtures?**
   - What we know: The project already has a precedent (`tests/integration/images/`, `GenericContainer.fromDockerfile`) for Ubuntu 22.04/24.04 variant images built via Testcontainers; the installer harness needs the same duality plus a running `dockerd` inside (install Docker Engine into the image via the same apt-repo steps `install.sh` itself uses, then start `dockerd` as the container's entrypoint before `install.sh` is `exec()`'d into it).
   - What's unclear: Whether to load locally-built `api`/`worker`/`web` images into the nested `dockerd` via `docker save | docker load` (no registry needed, matches D-19) or stand up a throwaway local registry container reachable from the nested `dockerd` — `docker save`/`load` is simpler and avoids a second nested service.
   - Recommendation: `docker save` the three locally-built images to a tar, copy into the DinD container via Testcontainers' `copyFilesToContainer`, `docker load` inside before running `install.sh` with the D-19 test-only registry/tag override pointed at the locally-loaded tags.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|--------------|-----------|----------|----------|
| Docker Engine (local dev/CI) | Testcontainers DinD harness, buildx builds, `pnpm test:integration` | ✓ (already required by every prior phase's integration suite) | Whatever `ubuntu-latest`/local dev already provides | — |
| `dash` (`/bin/sh`) | Shell unit tests (D-18.1), install.sh's actual execution model | ✓ (default on `ubuntu-latest` and any Ubuntu target) | 0.5.11 (22.04) / 0.5.12 (24.04) | — |
| `ubuntu-24.04-arm` GitHub-hosted runner | Native arm64 release build leg | ✓ (GA, free/unlimited on public repos since 2025-08-07) | — | QEMU-emulated single-job build (Assumption A2) |
| GHCR (`ghcr.io`) | Image publishing | ✓ (built into every GitHub repo, `packages: write` on `GITHUB_TOKEN`) | — | — |
| A public GitHub repo for this project | D-03's `raw.githubusercontent.com` URL, GHCR image namespace, GH Actions `schedule:`/`release` triggers | ✗ (D-02: does not exist yet, human prerequisite) | — | None — this blocks the installer's real-world validation (D-18 layer 3) and the release workflow's first real run until the human creates the repo, per D-02 |

**Missing dependencies with no fallback:**
- The public GitHub repo itself (D-02) — already documented as a human prerequisite in 06-CONTEXT.md; no plan in this phase should attempt to create it.

**Missing dependencies with fallback:**
- Native arm64 build capacity — QEMU remains a viable, simpler (if riskier for native addons) fallback if the two-job native-arch approach proves too complex to wire correctly (Open Question 1).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.0 (already root-pinned) + Testcontainers 12.1.0 (already root-pinned) |
| Config file | `vitest.integration.config.ts` (existing) — new test files added under `tests/integration/installer/` |
| Quick run command | `vitest run --config vitest.integration.config.ts tests/integration/installer/shell-functions.test.ts` (layer 1, no Docker needed beyond `/bin/sh` presence) |
| Full suite command | `pnpm test:integration` (existing script already picks up new files under `tests/integration/**`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| INST-01 | Fresh clean-VPS install brings up all 5 services + migrations, no manual SSH | integration (DinD) | `vitest run --config vitest.integration.config.ts tests/integration/installer/fresh-install.test.ts` | ❌ Wave 0 |
| INST-02 | Re-run detects existing install, upgrades or no-ops, never destroys data/secrets | integration (DinD, two sequential runs) | `vitest run --config vitest.integration.config.ts tests/integration/installer/idempotent-rerun.test.ts` | ❌ Wave 0 |
| INST-03 | Preflight fails with actionable message + specific exit code per cause (OS/port/snap/arch/RAM), before any write | unit (shell functions, real `sh`) + integration (DinD scenario images) | `vitest run --config vitest.integration.config.ts tests/integration/installer/shell-functions.test.ts` (unit) / `tests/integration/installer/preflight-scenarios.test.ts` (integration) | ❌ Wave 0 |
| INST-04 | Prints panel URL + one-time setup token at the end | integration (DinD, reads `docker compose logs api` for `NOODARA_SETUP_TOKEN=`) | `vitest run --config vitest.integration.config.ts tests/integration/installer/fresh-install.test.ts` (same file as INST-01, additional assertion) | ❌ Wave 0 |
| INST-05 | `NOODARA_ADMIN_EMAIL`/`PASSWORD` skip interactive setup and create admin directly | integration (DinD, env vars passed through the installer's `.env` generation) | `vitest run --config vitest.integration.config.ts tests/integration/installer/preseed-admin.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** the shell-function unit suite (`shell-functions.test.ts`) — fast, no Docker build, runs against real `/bin/sh`.
- **Per wave merge:** full `tests/integration/installer/**` suite (DinD harness), since each run builds/loads real images and takes real Docker-in-Docker startup time.
- **Phase gate:** `pnpm test:integration` full green + a genuine manual VPS run (D-18 layer 3) before `/gsd:verify-work` closes this phase — this manual step is a hard requirement per D-18, not optional.

### Wave 0 Gaps

- [ ] `tests/integration/installer/shell-functions.test.ts` — layer 1, spawns real `/bin/sh` against sourced `install.sh` functions (preflight predicates, version/URL resolution, `.env`-merge helpers)
- [ ] `tests/integration/helpers/installer-dind.ts` — new Testcontainers helper: privileged Ubuntu 22.04/24.04 image with Docker Engine pre-installed (via the same apt-repo steps `install.sh` uses) and `dockerd` started as entrypoint, `noodara.test=true` labelled, following the existing `ssh.ts`/`postgres.ts` helper shape
- [ ] `tests/integration/installer/fresh-install.test.ts`, `idempotent-rerun.test.ts`, `preflight-scenarios.test.ts`, `preseed-admin.test.ts` — layer 2, D-18's six required scenarios (idempotency, busy port, snap Docker, low RAM, unsupported OS, pre-seed admin + printed token)
- [ ] Framework install: none — all frameworks already present (Vitest, Testcontainers); the gap is purely new test files and one new helper

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|---------------------|
| V2 Authentication | Indirect — installer only passes `NOODARA_ADMIN_EMAIL`/`PASSWORD` through to already-implemented, already-tested `bootstrap-admin.ts` (phase 1); no new auth logic this phase | N/A — reused |
| V3 Session Management | No | — |
| V4 Access Control | Yes — `.env` file mode 600, root-owned, `/opt/noodara` directory permissions | `chmod 600`, `chown root:root` explicitly asserted after every write, including the `.env.bak-*` backup |
| V5 Input Validation | Yes — `NOODARA_VERSION`, `NOODARA_PORT`, `NOODARA_ADMIN_EMAIL/PASSWORD` all originate as installer-time input (env vars the operator sets) | Reuse `packages/domain`'s existing `validateEmail`/`validatePassword` is not directly callable from `sh`, but the **values** still flow into the same already-validated `env.ts`/`bootstrap-admin.ts` path inside the container — the installer itself only needs to validate shape (non-empty, matches a port-number regex) before writing to `.env`, never re-implementing password policy in shell |
| V6 Cryptography | Yes — secret generation for `NOODARA_MASTER_KEY`/`BETTER_AUTH_SECRET`/`DATABASE_URL` password | `openssl rand -base64 32` (already documented in `.env.example`'s own comments) — `openssl` is guaranteed present after the Docker apt-repo install step pulls in `ca-certificates`/related deps, but must be independently verified present as a preflight check too, since it's also needed before Docker is installed (for TLS to `download.docker.com` etc. via `curl`, which links against it) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|------------------------|
| Hardcoded/fallback DB password baked into an installer (Dokploy CVE-2026-24840 precedent, already documented in PITFALLS.md #1) | Elevation of Privilege | `install.sh` must generate `DATABASE_URL`'s password fresh via `openssl rand -base64 32` (or equivalent) on every genuinely new install — never a literal string in the script, and `env.ts`'s existing `WEAK_DB_PASSWORDS` denylist is a second, independent layer already in place |
| Installer curl-piped-to-shell supply-chain risk (the script itself as an attack surface) | Tampering | `raw.githubusercontent.com` serves over TLS (D-03); recommend documenting a "download, read, then run" alternative in `docs/install.md` for security-conscious operators, mirroring `get.docker.com`'s own documented "verify the script's content" step |
| `.env` mode/ownership drift after a manual edit by the operator | Information Disclosure | Re-assert `chmod 600`/`chown root:root` on every installer run (idempotent, cheap), not only at first creation |
| Docker published ports bypassing `ufw`, operator believes they are firewalled when they are not | Information Disclosure / unauthorized access | D-08's precise warning wording (Pitfall 5 above) — advisory only, never silently "fixed" by the installer itself, since mutating firewall rules is explicitly out of scope |
| Secrets in installer stdout/log (`/opt/noodara/install.log`, if kept) | Information Disclosure | Never log the generated `.env` file's contents; only log which variables were generated/preserved by *name*, never value — mirrors the existing Redactor discipline (`noodara-security` skill §3) even though this is shell, not TypeScript |

## Sources

### Primary (HIGH confidence)

- Context7 `/vercel/next.js` — `rewrites()` build-time evaluation (`packages/next/src/server/lib/router-utils/filesystem.ts`), standalone output Dockerfile example (`examples/with-docker/Dockerfile`), environment-variable build-vs-runtime docs
- Context7 `/drizzle-team/drizzle-orm-docs` — `migrate()` API shape, node-postgres migrator, idempotent-reapply behavior
- [get.docker.com](https://get.docker.com) — fetched directly 2026-09-21; `#!/bin/sh`, `set -e` only, zero bashisms, official Docker-maintained convention for `curl | sh`
- [docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/) — fetched directly 2026-09-21; current official apt-repo GPG/sources/package steps, conflicting-package removal list
- [github.com/coollabsio/coolify/blob/main/scripts/install.sh](https://github.com/coollabsio/coolify/blob/main/scripts/install.sh) — fetched directly 2026-09-21; root/`$EUID` check, snap detection, apt-repo install, disk-space check, no port check, `#!/bin/bash` + `curl | sudo bash`
- [github.com/Dokploy/website/blob/main/apps/website/public/install.sh](https://github.com/Dokploy/website/blob/main/apps/website/public/install.sh) — fetched directly 2026-09-21; public-IP fallback chain, port checks via `ss`, unconditional `docker swarm leave --force` + re-init, `#!/bin/bash`
- [launchpad.net/ubuntu/+source/dash/+changelog](https://launchpad.net/ubuntu/+source/dash/+changelog) and [packages.ubuntu.com/dash](https://packages.ubuntu.com/dash) — dash 0.5.11 (22.04) / 0.5.12 (24.04) versions, confirms pre-`pipefail`-support
- [shellcheck.net/wiki/SC3040](https://www.shellcheck.net/wiki/SC3040) — `set -o pipefail` undefined in POSIX/dash `sh` dialect
- [github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/) — `ubuntu-24.04-arm`/`ubuntu-22.04-arm` free/unlimited on public repos, GA
- [github.com/ranisalt/node-argon2/releases](https://github.com/ranisalt/node-argon2/releases) and [socket.dev/npm/package/argon2](https://socket.dev/npm/package/argon2) — argon2 prebuild platform matrix (Alpine arm64 musl since v0.28.2, well before this repo's pinned 0.45.1)
- Direct repository reads (this session): `docker-compose.dev.yml`, `.env.example`, `apps/control-plane/src/env.ts`, `apps/control-plane/src/boot/bootstrap-admin.ts`, `apps/control-plane/src/auth/auth.ts`, `apps/web/next.config.ts`, `docs/adr/0003-runtime-entrypoints-and-module-resolution.md`, `docs/adr/0006-web-app-same-origin-proxy-and-ports.md`, `apps/control-plane/src/db/migrate.ts`, `turbo.json`, `pnpm-workspace.yaml`, package.json files across all workspaces, `.github/workflows/ci.yml`/`nightly.yml`

### Secondary (MEDIUM confidence)

- [turborepo.dev/docs/guides/tools/docker](https://turborepo.dev/docs/guides/tools/docker) and [turborepo.dev/docs/reference/prune](https://turborepo.dev/docs/reference/prune) — `turbo prune --docker` output shape
- [computingforgeeks.com/turborepo-docker-builds-turbo-prune](https://computingforgeeks.com/turborepo-docker-builds-turbo-prune/) — cross-check of the prune+multi-stage pattern structure
- [github.com/docker/compose/issues/9260](https://github.com/docker/compose/issues/9260) — one-shot service re-execution on subsequent `up`
- [github.com/docker/for-linux/issues/690](https://github.com/docker/for-linux/issues/690), [github.com/chaifeng/ufw-docker](https://github.com/chaifeng/ufw-docker) — Docker/ufw iptables-chain interaction, `DOCKER-USER` chain explanation
- [gist.github.com/steinwaywhw](https://gist.github.com/steinwaywhw/a4cd19cda655b8249d908261a62687f8) and multiple cross-checked "latest GitHub release without jq" gists — `grep -Po` tag-name extraction pattern
- [github.com/bats-core/bats-core](https://github.com/bats-core/bats-core), [shellspec.info/comparison.html](https://shellspec.info/comparison.html) — bats-core/ShellSpec positioning, used to justify the rejection in favor of Vitest+`sh`

### Tertiary (LOW confidence)

- General 2026 blog-post-level sources on GitHub Actions multi-arch buildx patterns (oneuptime.com, pradumnasaraf.dev, actuated.com, obviy.us) — used only to corroborate the standard `setup-qemu-action`/`setup-buildx-action`/`build-push-action` wiring shape, not as the basis for any specific claim; the permissions requirement (`packages: write`) and native-arm64-runner recommendation are independently corroborated by the primary GitHub changelog source above

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every tool is either already pinned in this repo or independently verified via Context7/official docs fetched this session
- Architecture (install.sh shell dialect, Compose shape, Dockerfile pattern): HIGH — the dash/pipefail incompatibility and the Next.js build-time rewrites finding are both independently verified facts, not inferred; the Compose/Dockerfile shapes follow directly from already-locked D-01..D-19 decisions plus official docs
- Pitfalls: MEDIUM-HIGH — five of six pitfalls are backed by a directly-fetched, real source script or a direct read of this repo's own `docker-compose.dev.yml`; the ufw-wording pitfall is corroborated by two independent technical sources but is inherently a "commonly misunderstood" area worth a human double-check before finalizing the exact warning copy

**Research date:** 2026-09-21
**Valid until:** ~30 days for the shell/Compose/Dockerfile findings (stable); the GitHub Actions arm64-runner and Next.js build-time-rewrites findings are version-current facts unlikely to regress but worth a quick re-check if this phase's execution slips more than a few months
