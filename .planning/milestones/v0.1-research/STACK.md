# Technology Stack

**Project:** Noodara — self-hosted, AI-native PaaS control plane (Coolify/Dokploy category)
**Scope of this research:** v0.1 Foundation (control plane, server registry, SSH connect + discovery, auth, activity log, installer), with forward-compatibility notes for v0.2–v0.5
**Researched:** 2026-09-10
**Overall confidence:** HIGH for fixed/well-established pieces, MEDIUM for the two framework-shaped decisions (web UI framework, TypeScript compiler version) where the ecosystem is mid-transition

---

## Recommended Stack (at a glance)

| Decision | Recommendation | Confidence |
|---|---|---|
| Monorepo tooling | **pnpm workspaces + Turborepo** | HIGH |
| HTTP framework | **Fastify 5** | HIGH |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | HIGH |
| Web UI framework | **Next.js 16 (App Router)**, used as a thin client of the Fastify API (not as the backend) | MEDIUM |
| Job queue | **BullMQ** (on the Redis already fixed by the roadmap) | HIGH |
| SSH client | **ssh2** (raw), not a wrapper | HIGH |
| Encryption at rest | **Node `node:crypto` AES-256-GCM**, envelope-encrypted with a root key from env/file | HIGH |
| Structured logging | **pino** (Fastify's native logger) with `redact` | HIGH |
| Auth / sessions | **Better Auth** (core + email/password plugin, Drizzle adapter) | MEDIUM-HIGH |
| Validation | **Zod v4** | HIGH |
| TypeScript compiler | **TypeScript 6.0.x** (classic compiler), NOT 7.0 yet | HIGH |
| Password hashing | **argon2id** (`argon2` npm package) | HIGH |
| Installer | **`curl \| sh` bootstrap script** that installs Docker + Compose plugin, writes `.env`, pulls prebuilt images, runs `docker compose up -d` and migrations | HIGH |

---

## Core Technologies

| Technology | Version (Sept 2026) | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| TypeScript | **6.0.3** | Language, strict mode | TypeScript 7.0 (GA July 2026) ships the new Go-native compiler ("tsgo") but **has no stable programmatic API until 7.1**. `typescript-eslint` explicitly does not support it yet (peer range `>=4.8.4 <6.1.0`), and closed the TS7 support request as "not planned" pending 7.1. Since the roadmap's Definition of Done requires "cero errores de lint" and "cero errores de TypeScript" via a normal ESLint + typescript-eslint + tsc pipeline, adopting 7.0 today would break linting. Use 6.0.3 (last classic-compiler release) now; revisit 7.x once 7.1 ships a stable API (tracked, several months out per Microsoft). |
| Fastify | **5.12.3** | HTTP framework for the control-plane API | Schema-first (Zod via `@fastify/type-provider-zod`), plugin/encapsulation model that maps cleanly onto Noodara's domains (auth, servers, ssh, activity), and pino as its native logger (zero-glue structured logging with request IDs). Lowest ceremony of the three candidates for a small, TDD-driven API — no DI container to mock in unit tests, unlike NestJS. Hono is optimized for edge/serverless cold starts, which is irrelevant for a long-lived single Node process holding persistent Postgres/Redis/SSH connections. |
| Drizzle ORM + drizzle-kit | **drizzle-orm 0.45.2, drizzle-kit 0.31.10** | Schema, queries, migrations | SQL-shaped, no runtime magic, migrations are plain generated SQL files reviewable in PRs (matters for an installer that runs migrations unattended on a stranger's VPS). Matches Dokploy's own choice (see below) — proven in this exact product category. Prisma's schema-DSL + generated client adds a build step and a query engine binary that complicates Docker multi-arch images; Drizzle has neither. |
| PostgreSQL | 16/17 (fixed by roadmap) | Control-plane database | Fixed. Use `pg` (node-postgres) 8.x as the driver under Drizzle. |
| Redis | 7.x (fixed by roadmap) | Queue backend, later pub/sub for live status | Fixed. Backs BullMQ. |
| BullMQ | **6.3.4** | Background jobs (SSH connect + discovery, later builds/deploys) | Redis is already a hard dependency per the roadmap, so BullMQ's main competitors (pg-boss, Graphile Worker) lose their core selling point ("no Redis needed"). BullMQ is the most mature Redis-based queue for Node/TypeScript, supports delayed jobs, retries with backoff, and per-job progress — needed because SSH connect/discovery is a multi-second operation that must not block the HTTP request and must be resumable/observable through the `PENDING → CONNECTING → CONNECTED/UNREACHABLE/ERROR` state machine. Dokploy also runs BullMQ (alongside Inngest for its heavier event pipeline). |
| ssh2 | **1.17.0** | SSH client library | Pure-JS SSH2 protocol implementation, the de facto standard Node SSH library (Dokploy uses it directly). Gives raw access to `hostVerifier` (required for TOFU host-fingerprint pinning), per-exec timeouts, keepalive intervals, and stream-level stdout/stderr separation needed to sanitize command output before logging. |
| Next.js | **16.3.4** (App Router) | Web UI | See "Web UI framework" discussion below — MEDIUM confidence, primary recommendation with a documented alternative. |
| React | **19.3.0** | UI library | Ships with Next.js 16. |
| Zod | **4.6.1** | Validation (fixed by roadmap's open pieces, confirmed as the right call) | TypeScript-first schemas double as runtime validators and static types; used both at the Fastify route boundary (`@fastify/type-provider-zod`) and inside core-domain validators (server config, SSH credentials, discovery payloads) that need ≥95% branch coverage. |
| pino | **10.3.1** | Structured logging | Fastify's built-in logger; JSON logs by default (needed for any future log aggregation in v0.5), extremely low overhead, and has a first-class `redact` option (see Pitfalls) to guarantee credentials/secrets never reach stdout — a hard requirement (6.3, 9.3, 9.9 of the roadmap). |
| Better Auth | **1.7.3** | Auth + session management | See "Auth / sessions" discussion below. |
| argon2 | **0.45.1** (`node-argon2`, native bindings) | Password hashing for the local admin account | OWASP's Password Storage Cheat Sheet lists Argon2id as its primary recommendation (ahead of bcrypt/scrypt). Native bindings are compiled inside the Docker build stage, not on the target VPS, so this doesn't complicate the one-command installer. |
| Testcontainers | **12.1.0** | Ephemeral Postgres/Redis/SSH-server for integration tests | Fixed by roadmap. Use `testcontainers` + a real `sshd`-in-a-container image (e.g. `linuxserver/openssh-server` or a minimal custom image) to cover the SSH integration scenarios in §6.5 of the roadmap (invalid credentials, invalid host, timeouts, reconnect) against a real SSH server instead of mocks. |
| Vitest | **5.0.0** | Unit + integration test runner | Fixed by roadmap. v5 requires Node ≥22.12 and Vite ≥6.4 — pin Node 22 LTS in the monorepo's `engines` field and CI matrix. |
| Playwright | **1.63.0** | E2E | Fixed by roadmap. |
| Supertest | **7.2.2** | HTTP-level integration tests against Fastify | Fixed by roadmap. Fastify exposes `app.inject()` natively, which is faster and doesn't need a real socket for most integration tests — use `inject()` for route-level tests and reserve Supertest for the few tests that need a real HTTP server (e.g. testing session cookies across the actual `set-cookie`/`fetch` boundary, or E2E-adjacent smoke tests). |
| MSW | **2.15.0** | Mocking outbound HTTP in unit tests | Fixed by roadmap. Not needed for SSH (ssh2 isn't HTTP) — for SSH-layer unit tests, inject a fake/mock `ssh2.Client` implementation instead; reserve MSW for anything that calls out over HTTP (future: Docker Registry API, GitHub webhooks in v0.2/v0.3, AI provider APIs in v0.5). |

---

## Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@fastify/type-provider-zod` | 1.0.0 | Route-level request/response validation with Zod, full TS inference on `request.body`/`request.params` | All Fastify routes from day one. |
| `@fastify/cookie`, `@fastify/session` (or Better Auth's own cookie handling) | latest | Session cookie plumbing if not fully delegated to Better Auth | Only if you end up not using Better Auth's own Fastify/Node adapter directly. |
| `pino-http` | latest | Request-scoped child logger with request ID | Wired automatically via Fastify's built-in pino integration (`fastify({ logger: true })`); use `pino-http` directly only if the API is ever split off from Fastify's own logger plugin. |
| `nanoid` | 6.0.1 | Generating opaque IDs (session tokens, job IDs, idempotency keys) | Anywhere you need a URL-safe random ID that isn't a DB primary key. |
| `dotenv` / `@t3-oss/env-core` (Zod-based env validation) | latest | Typed, validated environment variables at boot | Validate `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET` etc. with a Zod schema at process start — fail fast on a misconfigured VPS instead of failing deep inside a request handler. |
| `zx` or plain `child_process` | latest | Local shell orchestration for the installer/build scripts | Keep the actual installer as POSIX `sh` (see Installer section) — reserve `zx` for internal dev/CI scripts only, not for anything that ships to the user's VPS. |

## Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| pnpm | Package manager + workspaces | Version 10.x (workspace catalogs supported); pin via `packageManager` field in root `package.json` so the installer's Docker build stage and CI use an identical version. |
| Turborepo | Task runner/caching across the monorepo | Version 2.x; enable `turbo.json` boundaries (stable since 2.4, early 2025) to enforce that `packages/core-domain` cannot import from `apps/api` or `apps/web`, protecting the ≥95%-covered domain layer from framework leakage. |
| ESLint + typescript-eslint | Lint | typescript-eslint 10.x, ESLint 9.x (flat config). Do not upgrade to TypeScript 7 until typescript-eslint officially supports it (blocked on TS 7.1's stable API). |
| Docker + Docker Compose plugin | Runtime + installer target | Compose v2 (`docker compose`, not the old `docker-compose` v1 binary) — this is what both Coolify's and Dokploy's installers assume and install if missing. |

---

## Installation

```bash
# Monorepo root
pnpm init
pnpm add -D turbo typescript@6.0.3 eslint typescript-eslint vitest @vitest/coverage-v8 playwright testcontainers

# apps/api (Fastify control plane)
pnpm --filter api add fastify @fastify/type-provider-zod @fastify/cookie pino
pnpm --filter api add drizzle-orm pg
pnpm --filter api add -D drizzle-kit @types/pg
pnpm --filter api add bullmq ioredis
pnpm --filter api add ssh2
pnpm --filter api add -D @types/ssh2
pnpm --filter api add argon2 zod
pnpm --filter api add better-auth

# apps/web (Next.js UI)
pnpm --filter web add next@16 react@19 react-dom@19 zod

# Dev/test tooling (root)
pnpm add -D supertest msw @testcontainers/postgresql @testcontainers/redis
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Fastify | NestJS | If the team grows beyond a solo/small team and wants enforced architectural conventions (modules, DI, guards) across many contributors — NestJS's learning curve pays off at that scale, but it's friction for a small TDD-driven core in v0.1. |
| Fastify | Hono | If Noodara ever needs an edge-deployed component (e.g., a lightweight webhook receiver at the edge) — irrelevant for the always-on control plane itself. |
| Drizzle | Prisma | If the team strongly prefers Prisma's DX (auto-generated client, Prisma Studio) and accepts the extra build step and the query-engine binary's Docker multi-arch overhead. Prisma's declarative schema is arguably more approachable for newcomers, but Drizzle's SQL transparency is a better fit for an infra tool where every migration running unattended on someone's production VPS needs to be auditable. |
| Next.js App Router | TanStack Start | If you want a purely "just React" client (no RSC, no `"use client"` boundary management) that pairs more naturally with an external Fastify API and a real-time-heavy admin UI (SSH connect progress, live discovery). TanStack Start reached v1 in March 2026 and is "production-viable," but its API surface is still evolving faster than Next.js's, and its ecosystem/hiring pool is far smaller. Given v0.1's stated goal is reliability over architectural elegance, Next.js's maturity wins by default; **revisit this in v0.2+** once the UI has more real-time surface (deployment logs, live container status) where TanStack Start's simpler client model may pay off more. |
| Next.js App Router | Vite + React Router v7 | If you want the leanest possible SPA with zero SSR concerns (v0.1's UI is entirely behind a login wall — SSR/SEO buys nothing here). This is a legitimate minimalist alternative to Next.js; the main reason not to default to it is smaller built-in tooling (image optimization, `next/font`, standalone output) that Next.js gives for free. |
| BullMQ | pg-boss | If Redis were ever dropped from the stack entirely — not applicable here since Redis is a fixed roadmap dependency from v0.1. |
| BullMQ | Graphile Worker | Same as above — only compelling when Postgres-transactional job enqueueing (enqueue-in-the-same-transaction-as-the-write) is a hard requirement. Not a v0.1 requirement. |
| ssh2 (raw) | `node-ssh` (promise wrapper around ssh2) | If the team wants a simpler promise-based API for straightforward exec/SFTP and doesn't need fine-grained control over `hostVerifier`, per-command timeouts, or raw stream handling. Noodara's TOFU fingerprint requirement and explicit SSH timeout requirement (roadmap §6.3) push toward using ssh2 directly. |
| Better Auth | Hand-rolled (argon2id + a `sessions` Postgres table + signed httpOnly cookie) | If the team wants zero third-party auth-library surface and total control/auditability of every line touching credentials — legitimate given Noodara's core value proposition is exactly "no credential leaks." Lucia's own maintainers concluded, when deprecating Lucia, that hand-rolled sessions are simpler than maintaining a generic library; a single-admin, no-OAuth, no-multi-tenant use case is genuinely simple enough to hand-roll safely (session table + `crypto.randomBytes(32)` token + `argon2.verify`). **This is close enough to a coin-flip that the user should explicitly pick one** — see rationale below. |
| TypeScript 6.0.3 | TypeScript 7.0 (native/tsgo) | Once `typescript-eslint` ships stable support (gated on TS 7.1's stable programmatic API, "several months out" per Microsoft as of GA). The 8–12x build speedup is real and worth adopting the moment tooling catches up — track this explicitly as a v0.2/v0.3 upgrade candidate, not a v0.1 blocker either way. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Lucia | Deprecated March 2025; the maintainers explicitly stopped maintaining database adapters by end of 2024 and now position the project as a learning resource, not a library to depend on in production. | Better Auth, or hand-rolled sessions (see Alternatives). |
| `crypto-js` (npm package) for encryption at rest | Widely cited as a common production mistake: weak defaults, easy to misuse (e.g., ECB mode), not authenticated encryption by default. | Node's built-in `node:crypto` with `aes-256-gcm` — audited, OpenSSL-backed, no extra dependency. |
| `systeminformation` (npm package) for server discovery | It introspects the **local** machine the Node process runs on. Noodara's discovery target is a **remote** Ubuntu server reached over SSH — this library cannot help there and using it would be a fundamental misunderstanding of the architecture. | Run plain shell commands over the existing SSH connection (`hostname`, `. /etc/os-release`, `uname -m`, `nproc`, `free -b`, `df -B1 /`, `cat /proc/uptime`, `docker version --format '{{json .}}'`) and parse the text/JSON output in the SSH package. This is exactly what Coolify and Dokploy do (they generate and stream bash scripts over SSH). |
| bcrypt as the default choice for new code | OWASP now ranks it third behind Argon2id and scrypt; 72-byte password truncation and lack of memory-hardness are real (if minor, for a single admin) weaknesses. | argon2id via the `argon2` npm package. |
| Docker Compose v1 (`docker-compose` binary) | Deprecated by Docker; Coolify's and Dokploy's installers both target Compose v2 (`docker compose` plugin) and install it if missing. | Docker Compose v2 (plugin), installed via the official Docker `get-docker.sh`-style script or the distro's `docker-compose-plugin` package. |
| TypeScript 7.0 today, paired with typescript-eslint | typescript-eslint's published package refuses to install alongside `typescript@7` (peer range `<6.1.0`); a GitHub issue asking for 7.0 support was closed "not planned" pending TS 7.1. Adopting it now would break "cero errores de lint" in CI. | TypeScript 6.0.3 until typescript-eslint ships official 7.x support. |
| Hex-encoding a 32-byte AES key (common mistake) | Silently halves the effective key length people think they have if they store it as a hex string but generate it from a shorter source. | Generate the root key with `crypto.randomBytes(32)`, store it base64-encoded, and validate its decoded length at boot. |

---

## Auth / Sessions — Detailed Rationale

**Recommendation: Better Auth (core + `emailAndPassword` plugin only) with the official Drizzle/Postgres adapter, sign-up disabled after the first admin is provisioned by the installer.**

Why not hand-roll despite the simplicity of a single-admin use case:
- The roadmap's own Definition of Done requires a "security review" and the project's stated Core Value is entirely about avoiding credential/session bugs. A maintained, widely-used library (Better Auth: the direct, actively developed successor to Lucia, filling exactly the gap Lucia's deprecation left) has had far more adversarial scrutiny on cookie flags, session rotation, timing-safe comparisons, and CSRF than a bespoke implementation will get in v0.1.
- Better Auth is modular — importing only the core + `emailAndPassword` plugin keeps the dependency surface small; you are not pulling in its OAuth/organizations/multi-session plugins unless later milestones need them (none do until well past v0.5, per the roadmap's explicit out-of-scope list for multi-user/SSO).
- It already has a first-class Drizzle adapter, so it integrates with the ORM decision above with no extra glue.

Why hand-rolled is a legitimate alternative the user may prefer:
- v0.1 truly needs almost nothing: one admin, one password, login, logout, session expiry. A `sessions` table (`id`, `admin_id`, `token_hash`, `expires_at`, `created_at`) plus `argon2.hash`/`argon2.verify` and a signed httpOnly `SameSite=Lax` cookie is maybe 150 lines of fully-tested core-domain code, and "we wrote and tested every line ourselves" has genuine value for a security-first product's early trust story.
- Pulling in any auth library — even a good one — means trusting its cookie/session defaults are appropriate for a single-admin, no-multi-tenancy tool, and means one more dependency to keep patched.

**This is the one decision in this document closest to a coin-flip; flag it explicitly for the user to confirm in the roadmap review rather than silently deciding.**

---

## Encryption at Rest — Detailed Rationale

**Recommendation:** `node:crypto`, `aes-256-gcm`, envelope pattern:
- A single root key (32 bytes, base64) supplied via environment variable or a file mounted into the container (`ENCRYPTION_KEY` or `ENCRYPTION_KEY_FILE`), generated by the installer on first run if not provided (`openssl rand -base64 32`) and written to the `.env` the installer manages.
- Per-credential: fresh 12-byte IV (`crypto.randomBytes(12)`) on every encryption; store `{ keyId, iv, authTag, ciphertext }` alongside each SSH credential row (all base64).
- Design the schema so `keyId` allows future key rotation without re-encrypting everything atomically (store multiple root keys, encrypt new secrets with the newest, allow decrypting old ones by id) — not required for v0.1's acceptance criteria, but cheap to build in now and expensive to retrofit.
- Never derive the key from a password with a fast hash — if a passphrase-based key is ever wanted, use a proper KDF (`scrypt` via `node:crypto.scryptSync`, or argon2id), not SHA-256.

This is a standard, unglamorous pattern with no exotic library needed — the common mistakes are 16-byte IVs (should be 12), reused IVs, and hex-encoded keys that quietly halve entropy; all are explicitly called out as the top-cited real-world bugs in AES-GCM Node.js implementations.

---

## Structured Logging & Redaction — Detailed Rationale

Fastify uses pino as its logger by default (`fastify({ logger: true })`), so no extra wiring is needed to get JSON logs with request IDs. The critical piece for Noodara's "credentials never in logs" requirement is pino's built-in `redact` option:

```ts
const app = fastify({
  logger: {
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.sshPassword',
        'req.body.sshPrivateKey',
        '*.credential',
        '*.encryptedCredential'
      ],
      censor: '[REDACTED]'
    }
  }
});
```

`redact` operates on the log object structurally (not with regex on the final string), so it cannot be bypassed by nesting — but it only protects fields it's told about. Pair this with a core-domain rule: any object passed to `logger.info/error` that contains a `Server` or `SshCredential` entity must go through a `toLogSafe()` mapper (unit-tested for ≥95% coverage per the roadmap) rather than being logged raw, so a forgotten path in `redact.paths` isn't the only line of defense.

---

## SSH Discovery — Detailed Approach

Given the roadmap's discovery fields (hostname, distro, OS version, arch, CPU, RAM, disk, uptime, Docker + version), the standard approach used by both reference products (Coolify, Dokploy) is: connect once, run a small set of shell commands over the same SSH session, and parse plain text/JSON:

| Field | Command |
|---|---|
| hostname | `hostname` |
| distro + OS version | `cat /etc/os-release` (parse `ID`, `VERSION_ID`) |
| architecture | `uname -m` |
| CPU count | `nproc` |
| RAM | `free -b` (parse `Mem:` line) |
| disk | `df -B1 /` (parse root filesystem line) |
| uptime | `cat /proc/uptime` (first field, seconds) |
| Docker installed + version | `docker version --format '{{json .}}'` (non-zero exit / command-not-found ⇒ not installed) |

Run these as a single batched command (`&&`-joined with unique delimiters between outputs, or several sequential `exec()` calls reusing one connection) inside a BullMQ job, with an explicit per-command timeout (roadmap §6.3 requires this) and the job's overall state driving the `PENDING → CONNECTING → CONNECTED/UNREACHABLE/ERROR` machine. Sanitize all stdout/stderr before logging or persisting (roadmap §6.3's sanitization requirement) — untrusted remote output should never be logged unescaped.

---

## Installer Approach — How Coolify and Dokploy Do It, and What to Copy

Both reference products ship a single public `install.sh`, fetched via `curl | sh`/`curl | bash`, run as root on a fresh Ubuntu VPS:

**Coolify** (`curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`):
- Installs Docker Engine + Compose v2 plugin if not already present.
- Pulls the Coolify application images plus its infrastructure dependencies (an internal Postgres, Redis, and its own Traefik instance) as prebuilt images — no local build on the VPS.
- Starts everything via Docker Compose and sets up an internal Docker network.
- Whole thing takes 2–5 minutes; the app is then reachable on a fixed port for first-run setup in the browser.
- Source: `coollabsio/coolify/scripts/install.sh` on GitHub.

**Dokploy** (`curl -sSL https://dokploy.com/install.sh | sh`):
- Similarly installs Docker if missing, but initializes **Docker Swarm mode** (not plain Compose) because Dokploy uses Swarm services for its own workload scheduling, even on a single node.
- Exposes environment-variable overrides for advanced setups (`ADVERTISE_ADDR` for choosing the swarm's advertised IP on multi-NIC hosts, `DOCKER_SWARM_INIT_ARGS`, `RELEASE_TAG`, `TZ`).
- Explicitly warns users who already run a Swarm not to use the script, since it force-inits (`docker swarm init` after leaving any existing swarm), which is destructive.

**Recommendation for Noodara v0.1:** follow Coolify's simpler model, not Dokploy's — plain Docker Compose (v2 plugin), no Swarm. Noodara v0.1 has no multi-container workload scheduling need yet (that's Docker/Git deployments in v0.2+, and even then, per-server Docker without Swarm is a defensible simpler default, matching how Dokploy's own "remote servers" feature explicitly runs standalone Docker with no swarm clustering across hosts). Concretely, `install.sh` should:
1. Detect Ubuntu 22.04/24.04 (fail loudly and clearly otherwise, matching the roadmap's compatibility scope).
2. Install Docker Engine + Compose v2 plugin if missing (official `get.docker.com` convenience script or the distro's `docker-ce`/`docker-compose-plugin` packages).
3. Generate a `.env` (root encryption key, session secret, admin bootstrap token/URL) if one doesn't already exist, so re-running the installer is idempotent.
4. Write a `docker-compose.yml` (or fetch a pinned release version of one) with the API, web UI, Postgres, and Redis services, using the Compose spec's healthchecks and `depends_on: condition: service_healthy` so migrations run only once Postgres is actually ready.
5. `docker compose up -d`.
6. Run migrations as a one-shot container/entrypoint step before the API starts serving traffic.
7. Print the URL + a one-time admin bootstrap link/token to stdout, mirroring both products' "open this URL to finish setup" first-run pattern.

Keep the script itself plain POSIX `sh` (not bash-specific, not requiring `zx`/Node), since it has to run before anything Node-based exists on the target machine — this matches both reference implementations.

---

## Reference Architectures: Coolify and Dokploy

### Coolify — PHP / Laravel

- Control panel is a Laravel 11 application with Livewire for reactive server-rendered UI components (no separate SPA/API split) and Alpine.js for light client-side interactivity.
- Background work (build/deploy processes, SSH-based validation) runs through Laravel's queue system, backed by Redis.
- Real-time UI updates (deployment logs streaming, container/proxy status changes) use Laravel Echo over a self-hosted Soketi server (a Pusher-protocol-compatible WebSocket server) rather than polling; there's also a polling fallback (Coolify periodically re-checks server/container state over SSH for servers without its optional "Sentinel" agent).
- Persists its own Postgres/MySQL-agnostic data layer (Laravel's Eloquent ORM) plus a bundled Traefik instance for reverse proxying deployed apps.
- Relevance to Noodara: validates the "single opinionated Traefik instance abstracted behind domain/service/port concepts" model for v0.4, and the SSH-polling-with-optional-agent pattern for server monitoring — directly informs how Noodara might introduce its own optional Agent post-v0.1 without making it mandatory.

### Dokploy — TypeScript (closest precedent)

- Frontend: Next.js 16 + React 18/19, with **tRPC** for end-to-end type-safe procedures — Next.js's own API routes/server functions *are* the backend; there is no separate HTTP API server.
- Data layer: a shared `@dokploy/server` package using **Drizzle ORM** against PostgreSQL — the same ORM this document recommends for Noodara.
- Background/scheduled work: **BullMQ** for scheduled tasks, plus **Inngest** for event-driven background processing (Dokploy uses two queue technologies for different job shapes; Noodara v0.1 only needs the BullMQ-shaped one).
- Auth: **Better Auth** (with SSO support in Dokploy's case — Noodara only needs its email/password plugin).
- Real-time: native WebSockets for streaming logs and providing terminal access into containers/servers.
- Server management: connects to remote servers over **ssh2** directly, executing generated bash scripts and streaming output back to the UI; explicitly does *not* attempt CPU/RAM/disk monitoring on remote (non-primary) servers "due to performance reasons" — each remote server runs fully standalone Docker + its own Traefik instance, with no cross-server clustering.
- Relevance to Noodara: this is the closest real-world architecture to what Noodara is building. The main structural difference this document recommends is decoupling the API from the UI framework (Fastify API + a UI client, rather than Next.js-as-backend via tRPC) — justified because Noodara's roadmap anticipates other API consumers beyond the browser (an eventual Agent, webhooks in v0.3, AI tool-calling in v0.5) that a tRPC-inside-Next.js backend would make more awkward to serve than a plain JSON/REST (or oRPC-style) Fastify API.

---

## Stack Patterns by Variant

**If the team wants absolute minimal external dependencies in the auth path:**
- Hand-roll sessions (argon2id + Postgres `sessions` table + signed httpOnly cookie) instead of Better Auth.
- Because the single-admin, no-OAuth, no-teams scope is genuinely simple enough that "we tested every line" may be worth more than a library's battle-testing, for this specific security-critical product.

**If/when v0.2+ needs Docker build/run orchestration:**
- Add `dockerode` for local-Docker-API-shaped operations (build, container lifecycle) where Noodara controls the Docker daemon directly, and continue using raw shell-over-SSH only for remote-server discovery/inspection that has no clean Docker Engine API equivalent (or where the daemon isn't reachable remotely without extra TLS setup).

**If the UI's real-time surface grows significantly (v0.2+ deployment logs, live container state):**
- Revisit TanStack Start vs. Next.js again; also consider adding native WebSockets (Fastify has first-class `@fastify/websocket`) rather than polling, matching Dokploy's approach over Coolify's Pusher-protocol approach (simpler, one fewer moving infrastructure piece than running a Soketi-equivalent).

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `typescript@6.0.3` | `typescript-eslint@10.10.0`, `eslint@9.x`/`10.x` | Peer range for typescript-eslint is `>=4.8.4 <6.1.0` — do not bump TypeScript to 7.x until typescript-eslint publishes explicit 7.x support. |
| `vitest@5.0.0` | Node `>=22.12.0`, `vite@>=6.4.0` | Pin Node 22 LTS across `apps/api`, `apps/web`, CI, and the Docker base image. |
| `drizzle-orm@0.45.2` | `drizzle-kit@0.31.10`, `pg@8.x` | Keep `drizzle-orm` and `drizzle-kit` versions in lockstep per Drizzle's own release notes; both move together. |
| `better-auth@1.7.3` | Drizzle adapter (built-in), any Fastify version via its framework-agnostic core | Better Auth is framework-agnostic; integrate via its generic handler mounted as a Fastify route, not a Next.js-specific adapter, since auth lives in the Fastify API, not in Next.js. |
| `fastify@5.x` | `@fastify/type-provider-zod@1.0.0`, `zod@4.x` | Fastify 5's TypeScript-provider API is what makes Zod inference work end-to-end on routes; do not mix with Fastify 4 patterns. |
| `argon2@0.45.1` | Requires native build toolchain at install time | Only relevant in the Docker build stage (multi-stage build compiles it into the image); irrelevant to the target VPS, which only pulls the finished image — does not complicate the one-command installer. |

---

## Sources

- Context7 `/drizzle-team/drizzle-orm-docs`, `/fastify/fastify`, `/better-auth/better-auth`, `/taskforcesh/bullmq`, `/mscdex/ssh2`, `/pinojs/pino`, `/colinhacks/zod` — resolved for current version/API surface, Sept 2026.
- npm registry (`npm view <pkg> version`) — authoritative current published versions as of 2026-09-10 for typescript, fastify, drizzle-orm, drizzle-kit, better-auth, bullmq, ssh2, pino, zod, vitest, playwright, testcontainers, supertest, msw, pg, pnpm, turbo, next, react, argon2, dockerode.
- [Dokploy — Architecture](https://docs.dokploy.com/docs/core/architecture) — confirmed Next.js + tRPC + Drizzle + Postgres stack. MEDIUM confidence (WebSearch-derived summary, not directly fetched; cross-checked against Dokploy's public docs structure).
- [Dokploy — Installation](https://docs.dokploy.com/docs/core/installation), [Dokploy — Remote Servers](https://docs.dokploy.com/docs/core/remote-servers) — Docker Swarm bootstrap, ssh2 usage, no cross-server clustering, no remote monitoring "for performance reasons." MEDIUM confidence.
- [Coolify install.sh source](https://github.com/coollabsio/coolify/blob/main/scripts/install.sh) and [Coolify installation docs](https://coolify.io/docs/get-started/installation) — installer behavior. MEDIUM-HIGH confidence (script location verified, exact contents not directly diffed in this pass).
- [DeepWiki: coollabsio/coolify — Real-Time Features and Notifications](https://deepwiki.com/coollabsio/coolify/7.4-real-time-features-and-notifications), [DeepWiki: Server Monitoring (Sentinel and Metrics)](https://deepwiki.com/coollabsio/coolify/3.5-server-monitoring-(sentinel-and-metrics)) — Laravel/Livewire/Soketi real-time architecture, SSH-polling fallback. MEDIUM confidence (third-party wiki summary, not Coolify's own docs).
- [InfoQ — TypeScript 7 native compiler](https://www.infoq.com/news/2026/08/typescript-7-released/), typescript-eslint issue #12518 ("TypeScript 7.0.2 Support") — TS7 GA date, native-compiler performance, and the typescript-eslint incompatibility that drives the "use 6.0.3, not 7.0" recommendation. MEDIUM-HIGH confidence (multiple independent sources agree; GitHub issue is primary-source-adjacent).
- [Lucia — Migrate from Lucia v3](https://lucia-auth.com/lucia-v3/migrate), [GitHub lucia-auth/lucia discussions #1707, #1714](https://github.com/lucia-auth/lucia/discussions/1707) — Lucia deprecation timeline (March 2025) and maintainers' own rationale (adapters as "complexity tax," hand-rolled sessions recommended). MEDIUM-HIGH confidence.
- OWASP Password Storage Cheat Sheet (referenced via multiple 2026 secondary sources) — Argon2id as primary recommendation over bcrypt/scrypt/PBKDF2. MEDIUM confidence (not fetched directly from owasp.org in this pass; consistent across independent secondary sources).
- npm-trends comparison pages for BullMQ/pg-boss/Graphile Worker — adoption/download numbers. MEDIUM confidence, used only to corroborate BullMQ's dominance, not as the sole basis for the recommendation (the Redis-already-fixed argument is the primary rationale and is independent of popularity).
- TanStack Start v1 announcement coverage (InfoQ, makerkit.dev) — v1 timing (March 2026) and "production-viable but API still evolving" characterization. MEDIUM confidence (secondary sources, consistent across several).

---
*Stack research for: Noodara v0.1 Foundation (self-hosted PaaS control plane)*
*Researched: 2026-09-10*
