# ADR 0007: Production topology and installer

## Status

Accepted — 2026-09-21

## Context

v0.1's own acceptance criteria (INST-01..INST-05) require a single VPS install command that a
person with one Ubuntu server can run, understand, and trust. Every prior phase already fixed a
runtime contract this phase has to package, not invent: ADR 0003 (`dist/server.js`/`dist/worker.js`,
`packages/domain` compiled ahead of time, no TypeScript loader in production) and ADR 0006
(`apps/web` reaches `apps/control-plane` only through a same-origin rewrite proxy, keyed on
`NOODARA_API_ORIGIN`). Phase 1's own D-04/D-09/D-12 already fixed how the setup token is printed
and how master-key/secret handling works; this phase only consumes that contract, never changes it.

D-02 is the one prerequisite outside this phase's control: the public GitHub repository this
installer, its raw script URL and its GHCR images all assume does not exist yet — it is created
manually by a human, and every artifact this ADR records is built and tested against that
assumption without ever running `gh repo create` or `git push` itself.

## Decision

**Orchestrator and topology (D-10).** Production runs on Docker Compose v2, never Swarm. Six
services: `postgres`, `redis`, `migrate` (one-shot), `api`, `worker`, `web`. Only `web` publishes a
host port; `postgres` and `redis` are unreachable from outside the host, and `api` is reached only
through `web`'s own same-origin proxy (ADR 0006). Data lives in two named Docker volumes
(`noodara_postgres_data`, `noodara_redis_data`), never a bind mount.

**One image, four entrypoints (D-01).** `api`, `worker` and `migrate` all run the identical
published `noodara-control-plane` image, differing only by the `command:` Compose gives each
service — `node dist/server.js` / `node dist/worker.js` / `node dist/db/migrate.js` — the direct
container-level extension of ADR 0003's runtime contract. The same image also carries the compiled
`noodara` operator CLI (`dist/cli/index.js`), reachable with `docker compose exec api`.

**Migrations as an idempotent one-shot.** `migrate` is gated by
`depends_on: condition: service_completed_successfully` on every service that needs it. Compose's
own documented behavior re-runs a one-shot on every `docker compose up`, including the installer's
own upgrade path — this is safe, and deliberately left unsuppressed, only because Drizzle's
`migrate()` diffs the migrations-tracking table and no-ops when nothing is pending. The correctness
guarantee lives in that idempotency, not in any skip-logic added on top of it.

**`NOODARA_API_ORIGIN` baked once, at build time (ADR 0006).** The `web` image's build receives
`NOODARA_API_ORIGIN=http://api:3000` as a single Docker build argument, consumed twice inside the
built image: once by `next.config.ts`'s `rewrites()` (evaluated once, at `next build`) and once as
a runner-stage runtime `ENV` (`apps/web/src/proxy.ts` and the SSE route both read it at request
time). There is exactly one place to set this value correctly, not two, and the production
`docker-compose.yml` never tries to override it with its own `environment:` entry.

**Prebuilt, multi-arch, never `:latest` (D-01, D-04, D-16).** Images are published to GHCR
(`ghcr.io/<owner>/noodara-control-plane`, `ghcr.io/<owner>/noodara-web`) by a tag-triggered release
workflow — there is no build-on-VPS path and no source-build fallback. Both images are published as
a genuine two-architecture (`linux/amd64` + `linux/arm64`) manifest, built on native runners rather
than under QEMU emulation, because `argon2` and `ssh2` carry native addons with a documented
emulated-build failure history. The installer and the release workflow both resolve and validate
the version tag with the identical character-class rules, and neither ever resolves or publishes
the unversioned `:latest` tag — a restart must never silently change which release is running.

**`install.sh` as strict POSIX `sh` (D-03, D-17).** The published script
(`curl -fsSL .../install.sh | sh`) is strict POSIX `sh`, verified under real `dash` (the interpreter
Ubuntu's own `sh` actually is), not just a bash-flavored `/bin/sh`. Every behavior lives inside a
function body; the only side-effecting top-level statement is a single guarded dispatch at the
bottom of the file, so a `curl | sh` stream truncated mid-download can only ever define a partial
set of functions and then exit — it can never half-run an install. `scripts/check-posix-sh.mjs`
enforces both properties as a named, non-bypassable static gate. The full preflight (OS, arch,
RAM/disk, panel port, Docker-via-snap, root) runs before anything is written or installed, and each
failure cause carries its own exit code and actionable message, never a generic failure.

**`/opt/noodara`, `.env` as the installed-marker, additive merge, no automatic rollback (D-09,
D-10, D-11, D-12).** The install root is always `/opt/noodara`; the existence of its `.env` (mode
`600`, root-owned) is the single signal of an existing installation. Re-running the installer is
the only upgrade path in v0.1: it never regenerates or rewrites an existing secret, only adds a
variable a newer release genuinely requires (D-11's additive merge), and backs up `.env` once,
timestamped, before any such write. A failed upgrade's health check fails loudly, with a named
service, a redacted log tail and the exact rollback command — it never rolls back automatically,
and it never touches a volume or an already-written `.env` beyond that one backup.

**HTTP by default, advisory-only firewall posture (D-05, D-08).** The default install serves the
panel over plain HTTP. Only when the resolved public URL is `http://` does the installer write
`NOODARA_COOKIE_INSECURE=true`; an `https://` URL never gets the opt-out. The installer detects an
active `ufw` and prints an advisory naming the precise, easy-to-miss reality — Docker's own
published-port `iptables` rules typically bypass `ufw` — but never modifies a firewall rule itself.

**Three testing layers, one framework (D-18).** Unit-level shell functions are tested by spawning
real `/bin/sh` and real `dash` from Vitest — chosen over `bats-core` specifically to keep the
project at one test framework rather than introducing a second, shell-specific one. Integration
tests run the real `install.sh` against a privileged Docker-in-Docker Testcontainers fixture on
both supported Ubuntu versions, exercising fresh install, idempotent re-run, upgrade, repair and
the full preflight matrix against real containers. A real VPS validation by a human is the closing
gate before the release is declared done. D-19: layer 2 needs a way to point the installer at
locally built images with no registry at all — an undocumented, test-only registry-prefix override
exists for exactly this, and is never presented to an operator as a supported feature.

## Rejected alternatives

- **Docker Swarm**, considered and rejected before this phase (carried forward from earlier
  research): Compose v2 is simpler to reason about, easier to debug on a single VPS, and is what
  the installer's own target audience (one server, no cluster) actually needs.
- **A `get.docker.com`-style third-party curl-pipe-sh Docker installer.** Docker Engine and the
  Compose plugin are installed from Docker's own official apt repository, step by step, with a GPG
  key pinned via `signed-by=` — never a third-party script, never Ubuntu's own conflicting
  `docker.io` package.
- **Building images on the VPS.** Requires the full monorepo, `pnpm`, a working `turbo prune`
  toolchain and meaningfully more disk/RAM/time on every install and every upgrade, for no benefit
  over a prebuilt, already-tested image pull.
- **`bats-core` for the shell-unit testing layer.** Adds a second, shell-specific test framework
  and runner for one file, when Vitest can already spawn a real `/bin/sh`/`dash` process directly
  and keep every test in the same reporting/coverage pipeline as the rest of the codebase.
- **Automatic rollback on a failed upgrade.** Deferred past v0.1 deliberately — automatic rollback
  is deployment-engine scope, and a v0.1 installer that fails loudly with a precise, actionable
  remedy is a safer default than one that silently reverses state it cannot fully verify.

## Consequences

- Every future v0.1 change to the production topology, the image contract or the installer's exit
  codes is a change to an already-Accepted decision, not a blank page — a later phase (Traefik,
  HTTPS, domains) extends this topology instead of renegotiating it from scratch.
- `docker-compose.yml`'s per-service memory limits are derived from real, measured `docker stats`
  samples against this exact topology, not guessed — a future change to any service's image or
  workload should be re-measured, not assumed to still fit the existing limit.
- The `NOODARA_API_ORIGIN` build-time/runtime duality is a real coupling a future contributor must
  remember: changing how `api` is reached in production means changing exactly one build argument
  in the release workflow, never a `docker-compose.yml` environment override.
- `install.sh`'s strict-POSIX-`sh` constraint and its static gate apply to every future change to
  the file, not just this phase's own additions — a bashism introduced in a later plan is caught by
  the same `scripts/check-posix-sh.mjs` gate this phase built.
- The full installer suite (`pnpm test:installer`) is real, Docker-in-Docker infrastructure with a
  measured multi-minute runtime — CI runs it on push-to-main and nightly, never on every pull
  request, a cost/coverage tradeoff this ADR records as intentional, not an oversight.
