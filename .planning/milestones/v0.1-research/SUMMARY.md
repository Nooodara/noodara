# Project Research Summary

**Project:** Noodara
**Domain:** Self-hosted, AI-native PaaS control plane (Coolify / Dokploy category)
**Researched:** 2026-09-10
**Confidence:** MEDIUM-HIGH

## Executive Summary

Noodara v0.1 is building the same category of product as Coolify (PHP/Laravel) and Dokploy (TypeScript, closest precedent) — a self-hosted control plane that installs in one command, authenticates a single local admin, registers remote servers over SSH, and discovers what's running on them. Research across all four documents converges on the same core lesson: **this category's hardest problems are not features, they are trust and failure-mode discipline** — credential handling, host-key verification, connection-state truthfulness, and migration/installer robustness. Both reference products have public, CVE-documented histories of getting exactly these things wrong (hardcoded auth secrets, secrets leaking into logs, command injection via unsanitized identifiers, false "unreachable" flapping, host-key UX with no recovery path). Noodara's stated Core Value — "sin fugas de credenciales, sin estados falsos, sin caídas" — is literally the list of things Coolify and Dokploy have had security advisories or long-running GitHub issues about, which means v0.1's acceptance criteria should treat their bug trackers as a pre-written pitfalls list, not just a features list.

The recommended approach: a TypeScript monorepo (pnpm + Turborepo) with a pure `packages/domain` core (Server entity, connection state machine, validators — zero I/O, ≥95% coverage), a `packages/ssh` port/adapter around `ssh2` with TOFU host-fingerprint pinning and allowlisted command templates (never string-interpolated shell), Fastify + Drizzle + Postgres + BullMQ + Redis for the control plane, and a Next.js UI consuming the API over HTTP + SSE. Docker Compose v2 (not Swarm) is the deployment topology, matching Coolify's simpler, lower-blast-radius model rather than Dokploy's swarm-init installer. `api` and `worker` should be split into separate containers/processes from the same image from day one, since SSH operations are multi-second and must not block the event loop or a future v0.3 deploy queue.

Two stack decisions remain genuinely open for the user to confirm (auth library, web UI framework) — research has a lean on both but flags them explicitly rather than silently deciding, per this product's own security-first positioning. The FEATURES and PITFALLS research also surface several concrete additions not currently in the roadmap/PROJECT.md that are cheap now and expensive to retrofit later (first-run admin bootstrap hardening, key-versioning in the encryption schema, `DiscoverySnapshot` as an append-only history table) — these should be raised explicitly at the requirements-approval step, not silently folded in.

## Key Findings

### Recommended Stack

Full detail: [STACK.md](./STACK.md). Most of the stack is either fixed by the roadmap (TypeScript, PostgreSQL, Redis, Docker, Vitest, Playwright, Testcontainers, Supertest, MSW) or has a single clear HIGH-confidence winner among the pieces research was asked to decide (Fastify over NestJS/Hono, Drizzle over Prisma, BullMQ given Redis is already fixed, `ssh2` raw over wrapper libraries, `node:crypto` AES-256-GCM over `crypto-js`, argon2id over bcrypt, pino with `redact` for logging, TypeScript 6.0.3 not 7.0 — `typescript-eslint` doesn't support TS7 yet). Two decisions are explicitly **open for user approval**, flagged by the researcher as close to a coin-flip rather than settled:

- **Auth/sessions — Better Auth vs. hand-rolled.** STACK.md recommends Better Auth (core + email/password plugin, Drizzle adapter) as the primary pick, on the grounds that a maintained library gets more adversarial scrutiny on cookie/session/CSRF correctness than a bespoke implementation will in v0.1, and it's the direct, actively-maintained successor to the now-deprecated Lucia. But it explicitly notes the hand-rolled alternative (argon2id + a `sessions` Postgres table + signed httpOnly cookie, ~150 lines) is legitimate for this exact single-admin, no-OAuth scope, and that Lucia's own maintainers concluded hand-rolled sessions are simpler than maintaining a generic library at this scale. **This is the single decision STACK.md says the user should explicitly confirm, not have decided for them.**
- **Web UI framework — Next.js 16 vs. TanStack Start.** Next.js is the primary recommendation (maturity, ecosystem, matches Dokploy's own precedent), but TanStack Start (v1 since March 2026, "production-viable") is flagged as a legitimate alternative for a UI that's entirely behind a login wall with no SSR/SEO need, and that may pair more naturally with an external Fastify API and growing real-time surface (SSH connect progress, later deploy logs). Confidence on this pick is MEDIUM specifically because the ecosystem is mid-transition — worth surfacing to the user rather than treating as settled.

Everything else in STACK.md (monorepo tooling, ORM, queue, SSH client, encryption, logging, validation, password hashing, installer shape) is HIGH confidence and should be treated as settled unless the user objects.

**Core technologies:**
- Fastify 5 + Drizzle ORM + PostgreSQL — HTTP API and schema/migrations layer; schema-first, no DI container, migrations are reviewable SQL (matters for unattended installs on a stranger's VPS)
- BullMQ on the already-fixed Redis — background jobs for SSH connect + discovery, keeping multi-second SSH operations off the request thread
- `ssh2` (raw, not a wrapper) — gives direct access to `hostVerifier` for TOFU and per-exec timeout control, both hard v0.1 requirements
- `node:crypto` AES-256-GCM (envelope pattern, per-credential IV) — encryption at rest, with a `keyId` column recommended from day one for future rotation
- Next.js 16 (App Router) as a thin client of the Fastify API — not TanStack Start (open decision, see above)

### Expected Features

Full detail: [FEATURES.md](./FEATURES.md). The roadmap's v0.1 scope already matches category table stakes closely (install, add/edit/delete server, connection test with explicit state machine, discovery, server detail, minimal activity log, global settings). FEATURES.md's main contribution is identifying **gaps versus what Coolify/Dokploy actually ship that the roadmap doesn't currently call out**, and **anti-features to explicitly resist** even though users familiar with those tools will ask for them.

**Must have (table stakes, already in roadmap):**
- One-command install on Ubuntu 22.04/24.04, add/edit/delete server with host/port/user/credential, explicit "test connection" action tied to the 6-state machine, discovery snapshot (hostname/distro/OS/arch/CPU/RAM/disk/uptime/Docker+version), server detail view, minimal activity log, non-root/sudo support alongside root (implied by "usuario SSH configurable," made explicit by both competitors' validation checklists)

**Should have (candidate additions, not currently in roadmap — flag for requirements approval):**
- **First-run admin bootstrap hardening** — Coolify's own docs warn that "whoever visits the registration screen first becomes admin" is a real footgun; FEATURES.md recommends closing this in v0.1 itself (setup token printed by the installer, or localhost/private-IP-restricted first-run) rather than deferring, since it's low cost and directly serves the "no fugas de credenciales" core value.
- **Install-time admin credential pre-seeding** (`ROOT_USERNAME`/`ROOT_PASSWORD`-style env vars, mirroring Coolify) — trivial once the first-run flow exists, useful for scripted installs and future CI/E2E setup.
- **Per-check discovery progress UI** (Dokploy's `StatusRow` pattern: label + pass/fail + description per check, not a black-box spinner) — pure UX layer over already-planned discovery logic, high leverage/low cost, reinforces the "understood, not just managed" brand promise.
- **Visible, explained TOFU/host-fingerprint UI** — neither competitor surfaces host-key verification to the end user (it shows up as a raw SSH error); making it an explicit, progressive-disclosure moment in the connect flow is flagged as a differentiator, not just a backend detail.
- Do **not** auto-install Docker in v0.1 if missing (Coolify does this) — roadmap only requires *detecting* Docker; FEATURES.md flags this as a deliberate scope difference from Coolify worth confirming with the user, not an oversight.

**Defer (correctly out of scope per roadmap, confirmed by research):**
- Historical metrics/time-series charts (Coolify's Sentinel-style agent) — v0.5 Observability
- Any persistent agent on the managed server — v0.1 is SSH-only from the control plane, validated as a production-grade baseline by Dokploy's own architecture (not a toy shortcut)
- Multi-server clustering, build-server/deploy-server role distinction, cloud-provider auto-provisioning, multi-user/RBAC, general-purpose log search/export on the activity log

### Architecture Approach

Full detail: [ARCHITECTURE.md](./ARCHITECTURE.md). Ports-and-adapters over a pure domain core: `packages/domain` (Server entity, connection state machine, validators — zero I/O, zero framework imports) is called by application services (`RegisterServerService`, `ConnectServerService`, `DiscoverServerService`) that are the *only* entry point for both the Fastify HTTP routes and the BullMQ worker, preventing "the API does X one way, the worker does X another way" drift as v0.2+ adds job types. `packages/ssh` wraps `ssh2` behind an `SshPort` interface so an optional future Agent can slot in later as an alternative adapter, not a rewrite. Deployment topology is plain Docker Compose v2 (api, worker, web, postgres, redis as separate services on one network), not Swarm — Dokploy's own installer explicitly warns its Swarm-init step is destructive on an existing cluster, which is exactly the one-way-door risk to avoid this early. Real-time UI updates (connection state transitions, discovery completing) should use SSE, not WebSocket — v0.1's need is one-directional server push only; WebSocket is reserved for later bidirectional needs (interactive terminal, v0.2+).

**Major components:**
1. `packages/domain` — pure business rules and the connection state machine; the ≥95%-covered core, built and tested first with zero infrastructure dependency
2. `packages/ssh` — `SshPort` interface + `Ssh2Adapter`; owns TOFU fingerprint handling, per-command timeouts, output sanitization, allowlisted command templates
3. `apps/control-plane` (`api` + `worker`, one image, two entrypoints) — Fastify routes (HTTP layer, no business logic) and BullMQ job processors, both calling the same application services
4. `apps/web` (Next.js) — thin client consuming the API over HTTP + SSE, never talking to Postgres/Redis directly
5. Two persistence concepts worth separating from day one: `DiscoverySnapshot` (append-only history table) and `Server.currentState` (denormalized columns the UI actually reads) — modeling the former as history now avoids a schema migration when v0.5's observability needs a time series

### Critical Pitfalls

Full detail: [PITFALLS.md](./PITFALLS.md). All 10 documented pitfalls are backed by real Coolify GitHub issues, Dokploy CVEs/security advisories, or well-established SSH/sysadmin failure modes — this is the strongest-evidenced of the four research files.

1. **Hardcoded fallback for signing/encryption secrets** (Dokploy CVE-2026-45631, CVSS 10.0: `BETTER_AUTH_SECRET` fell back to a literal string, forging admin JWTs on any instance that didn't override it) — the process must fail-fast at boot if `ENCRYPTION_KEY`/`SESSION_SECRET` are missing or below minimum entropy; the installer must generate these per-install, never ship an embedded default.
2. **Secrets leaking into logs/activity log** (Coolify #7019, #6658, #7235 — reported repeatedly across versions, proving ad hoc redaction doesn't hold) — redaction must be centralized and based on domain type (`Secret`/`Credential`), not opt-in flags or field-name matching; verified by a CI test that greps all log/API/error/activity-log output for a fixture secret and expects zero matches.
3. **Host-key/TOFU handled naively** (Coolify #5357, #7980, #3664 — either disabled verification or hard-failed with no recovery UX) — capture and pin the fingerprint per-`Server` on first connect, surface it to the user, and require explicit manual re-confirmation on change; never auto-accept.
4. **Command injection via unvalidated identifiers** (Dokploy GHSA-fcgq-jjfg-hrhj, CVSS 9.9: `appName` only trimmed/lowercased before being interpolated into `execAsync`) — every identifier that reaches a shell command must pass a strict allowlist regex validated in both the API schema and the domain layer, never string-concatenated.
5. **Connection-state flapping from single-attempt failures** (Coolify #5315, #4407 false-unreachable notifications, #8151 UFW/Docker race on Hetzner) — a transition to `UNREACHABLE` must require confirmed repeated failure (e.g., 3 fast consecutive), not a single transient failure; this directly protects the roadmap's "100 consecutive successful connections" CI criterion from firewall-runner flakiness.

Two more pitfalls matter specifically because they shape the *data model*, not just runtime behavior, and are cheap now / expensive later: no key-versioning field on encrypted rows (Coolify's own docs and coolify-docs#350 show "backup exists but is useless without the original APP_KEY" as a recurring support pattern), and non-defensive migrations (`DROP CONSTRAINT` without `IF EXISTS`) breaking the first real upgrade (Coolify #3848, #2820, #3618, #5776).

## Implications for Roadmap

The roadmap for v0.1 Foundation is already scoped; research does not propose new phases beyond it so much as an internal build order and a set of specific hardening items to fold into the existing scope, sequenced so the highest-risk, highest-blast-radius pieces are built and de-risked first.

### Phase 1: Pure domain + control-plane persistence foundation
**Rationale:** ARCHITECTURE.md's build order puts `packages/domain` (Server entity, connection state machine, validators, encryption helpers) first because it has zero I/O dependencies, maximizes early unit-test coverage toward the ≥95% target, and is the layer every other component depends on. Auth/session and the DB schema (users, sessions, servers, discovery_snapshots, activity_events, config) are built alongside it.
**Delivers:** domain model with state machine, encryption envelope helpers (with `keyId` from day one), Drizzle schema + migrations, admin auth (Better Auth or hand-rolled, per user's decision).
**Addresses:** local admin auth + session management, credential encryption at rest (FEATURES.md table stakes).
**Avoids:** Pitfall 1 (hardcoded secret fallback), Pitfall 3 (missing key-versioning field), Pitfall 10 (non-defensive migrations) — all are far cheaper to get right before any data exists.

### Phase 2: SSH port/adapter, isolated and integration-tested
**Rationale:** the highest-risk component per Noodara's own Core Value statement; ARCHITECTURE.md recommends building and testing it in isolation (against Testcontainers + a real `sshd` container) before wiring it into the full connect→discover flow, so failure modes are caught early rather than debugged through the whole stack.
**Delivers:** `SshPort` interface + `Ssh2Adapter` with TOFU fingerprint pinning, separate connect/command timeouts, allowlisted discovery command templates, output sanitization.
**Uses:** `ssh2` raw client, Testcontainers with a real SSH server image.
**Avoids:** Pitfall 4 (naive TOFU), Pitfall 7 (sudo/TTY hangs), Pitfall 9 (command injection via identifiers) — this phase is where the allowlist-validation pattern for identifiers should be established, since v0.2 will reuse it for `appName`.

### Phase 3: Application services + activity log + redaction
**Rationale:** wires domain + persistence + SSH together behind `RegisterServerService`/`ConnectServerService`/`DiscoverServerService` as the single entry point both HTTP routes and the worker will call — this is the decision that prevents API/worker logic divergence once v0.2+ adds more job types.
**Delivers:** application services, activity-log writer with the same `toLogSafe()`-style redaction mapper as application logs, the confirmed-failure (not single-attempt) state-machine transition logic.
**Implements:** ARCHITECTURE.md's §3 "application services as sole entry point" rule and §6 activity-log design (single polymorphic `activity_events` table).
**Avoids:** Pitfall 2 (secrets in logs/activity log), Pitfall 8 (flapping state from transient failures).

### Phase 4: HTTP routes, BullMQ worker, SSE — built in parallel
**Rationale:** both are thin callers of the same application services from Phase 3, so they can be built concurrently once that boundary exists — this parallelism is only possible because the port/adapter and service boundary was established first.
**Delivers:** Fastify routes (auth, servers, activity, config), BullMQ job processors (connect-server, discover-server), SSE endpoint for live status.
**Uses:** Fastify, `@fastify/type-provider-zod`, BullMQ, Fastify's native SSE support.

### Phase 5: Web UI
**Rationale:** can start against mocked data (MSW) in parallel with Phases 3-4, then wire to the real API last, per ARCHITECTURE.md's build order.
**Delivers:** login → Servers list → add server → connect → discovery progress → server detail, per the Apple-inspired design system.
**Addresses:** FEATURES.md's discovery-progress-narrative and visible-TOFU differentiators — mostly UX/copy layered on already-built backend behavior.

### Phase 6: Installer + docker-compose.yml, finalized last
**Rationale:** ARCHITECTURE.md explicitly recommends drafting this early but finalizing it only once real env vars, migration entrypoints, and healthcheck endpoints exist from earlier phases, so it reflects the real container shape rather than a guess.
**Delivers:** idempotent `install.sh` (Compose v2, not Swarm), preflight checks (root/sudo, Docker-via-snap detection, port conflicts, RAM), first-run admin bootstrap (setup token, not race-to-register).
**Avoids:** Pitfall 5 (installer fails on non-pristine VPS), and closes the "first user to register becomes admin" gap FEATURES.md flags as a known Coolify/Dokploy weakness.

### Phase Ordering Rationale

- Pure domain first maximizes fast, infrastructure-free unit-test feedback toward the ≥95% coverage mandate (TDD requirement).
- SSH is isolated and de-risked in its own phase before being wired into the full flow, because it is explicitly the highest-blast-radius component per the project's Core Value and per the pitfalls evidence (CVSS 9.9-10.0 real-world incidents in this exact product category).
- Application services are established as the single entry point *before* HTTP routes and the worker are built, so those two can be built in parallel without risking logic divergence.
- The installer is finalized last because it depends on every other phase's real environment-variable and healthcheck surface — building it first would mean guessing and re-doing it.

### Research Flags

Needs deeper research during planning (`--research-phase`):
- **SSH/discovery phase:** confirm exact `ssh2` API shapes for `hostVerifier`/`hostHash` and per-exec timeout wrapping against the pinned version (1.17.0), and validate the Testcontainers + real `sshd` image setup works as described.
- **Auth phase:** once the user picks Better Auth vs. hand-rolled, research the chosen path's exact Fastify integration (Better Auth's framework-agnostic handler mounting, or the hand-rolled session-table + cookie implementation) in more depth than STACK.md's overview.
- **Installer phase:** Docker-via-snap detection and port-conflict preflight logic are sparsely documented outside Coolify's own troubleshooting docs; worth a focused look at Coolify's actual `install.sh` source before writing Noodara's.

Phases with standard, well-documented patterns (research-phase likely unnecessary):
- **Domain/persistence phase:** Drizzle schema + migrations, AES-256-GCM envelope encryption are standard, HIGH-confidence patterns already detailed in STACK.md.
- **HTTP routes/worker split phase:** Fastify + Zod + BullMQ wiring is a conventional, well-documented pattern.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH for fixed/settled pieces; MEDIUM for auth and web-UI framework | Most decisions verified via Context7 docs and current npm versions; the two open decisions are explicitly flagged as close calls by the researcher, not under-researched |
| Features | MEDIUM-HIGH | Coolify/Dokploy claims sourced from official docs (WebFetch, several HIGH-confidence); CapRover/Portainer used only for contrast at LOW confidence; activity-log conventions have lower external validation since neither competitor documents this publicly in depth |
| Architecture | HIGH for internal component boundaries and SSH safety patterns (derived from the already-fixed stack + first-principles design); MEDIUM for Coolify/Dokploy topology specifics (WebSearch/DeepWiki-derived, not fully diffed against source) |
| Pitfalls | MEDIUM-HIGH | Majority of findings verified against public GitHub issues, published CVEs, and official docs in this exact product category; a couple of general sysadmin/SSH patterns (sudo/TTY) are marked MEDIUM as general knowledge rather than Coolify/Dokploy-specific incidents |

**Overall confidence:** MEDIUM-HIGH — strong enough to proceed to roadmap and requirements definition, with two stack decisions and several recommended-but-not-yet-approved scope additions to resolve explicitly with the user first.

### Gaps to Address

- **Auth library (Better Auth vs. hand-rolled) and web UI framework (Next.js vs. TanStack Start) are unresolved** — both need an explicit user decision before Phase 1/Phase 5 planning locks in; STACK.md documents the tradeoffs for each.
- **First-run admin bootstrap hardening, install-time credential pre-seeding, and Docker-auto-install-or-not are not currently in PROJECT.md's Active requirements** — FEATURES.md recommends elevating the bootstrap-hardening item to v0.1 P1 given its low cost and direct alignment with the core value; this should be explicitly accepted or rejected at requirements approval, not silently added or silently dropped.
- **Key-versioning on encrypted credential rows, `DiscoverySnapshot` as an append-only history table, and the api/worker container split are architecture-level "decide now, cheap; retrofit later, expensive" items** flagged by ARCHITECTURE.md and PITFALLS.md that are not explicit line items in the current roadmap/PROJECT.md text — surface these for confirmation even though they don't change externally visible v0.1 scope.
- **SSE vs. WebSocket for real-time status** is a MEDIUM-confidence recommendation (converging 2026 secondary-source consensus, no single authoritative spec) — low risk to proceed on, but worth a quick sanity check against Fastify's current SSE support during Phase 4 planning.
- **License (Apache-2.0 vs. MIT)** remains an open PROJECT.md decision, unrelated to this technical research but relevant to the same approval step.

## Sources

### Primary (HIGH confidence)
- Context7 `/drizzle-team/drizzle-orm-docs`, `/fastify/fastify`, `/better-auth/better-auth`, `/taskforcesh/bullmq`, `/mscdex/ssh2`, `/pinojs/pino`, `/colinhacks/zod` — current API surface, Sept 2026
- npm registry version checks for all pinned packages (Sept 2026)
- [mscdex/ssh2 GitHub/npm](https://github.com/mscdex/ssh2) — `hostVerifier`/`hostHash` API shape
- [Coolify OpenSSH docs](https://coolify.io/docs/knowledge-base/server/openssh), [Non-root User docs](https://next.coolify.io/docs/core/infrastructure/servers/non-root-user) — official, WebFetched
- [Dokploy Remote Servers](https://docs.dokploy.com/docs/core/remote-servers), [SSH Keys](https://docs.dokploy.com/docs/core/ssh-keys), [Deploy Server](https://docs.dokploy.com/docs/core/remote-servers/instructions) — official, WebFetched
- Dokploy CVE-2026-45631 (hardcoded `BETTER_AUTH_SECRET`), CVE-2026-24840 (hardcoded DB credentials), GHSA-fcgq-jjfg-hrhj (command injection) — published security advisories
- Coolify GitHub issues #7019, #6658, #7235 (log leaks), #5357, #7980, #3664 (host key), #5315, #4407, #8151 (flapping/false unreachable), #4128, #11089, #2363 (Docker detection), #3848, #2820, #3618, #5776 (migrations), #3943, #3693 (installer) — public issue tracker

### Secondary (MEDIUM confidence)
- [Coolify docker-compose.yml source](https://github.com/coollabsio/coolify/blob/main/docker-compose.yml), [Coolify installation docs](https://coolify.io/docs/get-started/installation)
- [Dokploy Architecture docs](https://docs.dokploy.com/docs/core/architecture), [Dokploy Installation docs](https://docs.dokploy.com/docs/core/installation)
- [DeepWiki: coollabsio/coolify — Server Monitoring (Sentinel)](https://deepwiki.com/coollabsio/coolify/3.5-server-monitoring-(sentinel-and-metrics)), [DeepWiki: Real-Time Features](https://deepwiki.com/coollabsio/coolify/7.4-real-time-features-and-notifications)
- [DeepWiki: Dokploy Server Validation](https://deepwiki.com/Dokploy/dokploy/10.2-server-validation)
- [InfoQ — TypeScript 7 native compiler](https://www.infoq.com/news/2026/08/typescript-7-released/), typescript-eslint issue #12518
- OWASP Password Storage Cheat Sheet (via secondary sources, Argon2id recommendation)
- 2026 SSE-vs-WebSocket consensus sources (Medium/dev.to, aggregated)

### Tertiary (LOW confidence)
- [CapRover CLI/clustering docs](https://caprover.com/docs/cli-commands.html) — used only for anti-feature contrast, not as a v0.1 model
- Sudo/TTY-over-SSH sysadmin pattern (general knowledge, [simplified.guide](https://www.simplified.guide/ssh/sudo-no-tty-askpass), ssh2 issue #895)

---
*Research completed: 2026-09-10*
*Ready for roadmap: yes*
