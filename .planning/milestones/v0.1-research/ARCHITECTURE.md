# Architecture Research

**Domain:** Self-hosted PaaS control plane (Coolify/Dokploy category) — TypeScript monorepo
**Researched:** 2026-09-10
**Confidence:** HIGH for internal component boundaries and SSH safety patterns (derived from the already-fixed stack + first-principles design); MEDIUM for Coolify/Dokploy topology specifics (WebSearch/DeepWiki-derived, not directly diffed against source in every case — flagged per claim below)

---

## 1. Deployment Topology on the User's VPS

### What Coolify does (MEDIUM-HIGH confidence — docker-compose.yml location verified, contents summarized via WebSearch, not fully diffed line-by-line)

Coolify's own `docker-compose.yml` (coollabsio/coolify, `main` branch) ships:

| Service | Image | Role |
|---|---|---|
| `coolify` | PHP/Laravel app | Web UI + API (monolithic, server-rendered via Livewire — no separate API process) |
| `postgres` | `postgres:15-alpine` | Control-plane DB, container name `coolify-db` |
| `coolify-redis` | `redis:7-alpine` | Queue backend + cache, container name `coolify-redis` |
| `soketi` | Pusher-protocol WebSocket server | Real-time push to the browser (deploy logs, status) |

Notes: all services on one isolated bridge Docker network; `coolify` mounts `/var/run/docker.sock` (it manages the *local* server's Docker directly, in addition to remote servers over SSH) plus a `coolify-data` volume; web UI reachable on a fixed port (reported as 8000) for first-run setup. Installer is a public `install.sh` (`curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`) that installs Docker Engine + Compose v2 if missing, pulls prebuilt images (no build-on-VPS), and does `docker compose up -d`. Re-running the installer is the documented upgrade path (idempotent — pulls new image tags, re-applies compose, runs migrations).

### What Dokploy does (MEDIUM confidence — docs + DeepWiki summaries, not directly fetched in full)

Dokploy's installer (`curl -sSL https://dokploy.com/install.sh | sh`) is structurally different: it **initializes Docker Swarm mode** even on a single node (`docker swarm init`, destructive if a swarm already exists — the installer explicitly warns about this), then deploys itself as Swarm **services** rather than plain Compose containers:

| Service | Role |
|---|---|
| Dokploy app (Next.js, manager node) | Web UI + API (tRPC, no separate backend process) — control plane |
| PostgreSQL | Dokploy's own config/state DB |
| Redis | BullMQ queue backend |
| Traefik | Reverse proxy, deployed and managed as part of the control plane itself (not per-app only) |

Manager node = control plane (UI + API + DB + Swarm manager). Worker nodes (if the user adds them) run only application containers/builds — Dokploy's own control-plane services stay on the manager. Env var overrides exist for advanced setups (`ADVERTISE_ADDR`, `DOCKER_SWARM_INIT_ARGS`, `RELEASE_TAG`, `TZ`).

### Recommendation for Noodara v0.1 (builds on STACK.md, restated here because it is an architecture decision, not just a tooling pick)

**Plain Docker Compose v2, not Swarm.** Reasons specific to architecture (beyond STACK.md's simplicity argument):
- Swarm couples the control plane's own lifecycle to a clustering primitive Noodara doesn't need until it does true multi-node worker scheduling (out of scope through v0.5 per the roadmap's explicit exclusion list).
- Swarm init is a destructive, stateful operation on the host (`docker swarm init`/`leave`) — a much larger blast radius for a "one command on a stranger's VPS" installer than starting some containers. Coolify's simpler Compose model has shipped in this exact product category for years without needing Swarm for a single-server install.
- Adding Swarm later (if Noodara ever needs true multi-node container scheduling, which is not on the roadmap through v0.5) is additive; retrofitting *away* from Swarm once users depend on it is not.

**Recommended `docker-compose.yml` shape for Noodara v0.1:**

| Service | Image/build | Purpose | Notes |
|---|---|---|---|
| `api` | `apps/control-plane` build | Fastify HTTP API (routes: auth, servers, activity, config) | Serves both the JSON API and the SSE endpoint for live status (§7) |
| `worker` | same image as `api`, different entrypoint/command | BullMQ worker(s): SSH connect job, discovery job | Separate container from `api` from day one (see §3, §8) even though v0.1's job volume is tiny — this is the cheap moment to split them; retrofitting later means re-plumbing graceful shutdown, concurrency limits, and deploy scripts under load in v0.3 |
| `web` | `apps/web` (Next.js) build | Browser UI | Talks to `api` over HTTP + SSE, never directly to Postgres/Redis |
| `postgres` | `postgres:17-alpine` | Control-plane DB | Named volume `noodara-db-data`; healthcheck gates `depends_on: condition: service_healthy` for `api`/`worker` |
| `redis` | `redis:7-alpine` | BullMQ backend | Named volume optional (queue data is not the durability boundary — Postgres is) |

All on one Docker network (`noodara-net`), no ports published except `web`'s (and `api`'s, if the UI calls it cross-origin rather than same-origin/proxied — prefer same-origin: have `web`/Next.js proxy `/api/*` to the `api` container internally, so only one port needs to be exposed to the host, mirroring Coolify's single-fixed-port first-run UX).

Migrations run as a one-shot init container/entrypoint step (`drizzle-kit migrate`) before `api` starts serving — same pattern both reference products use. Upgrade path = re-run the installer: pull new pinned image tags, `docker compose up -d`, run migrations, matching Coolify's re-run-the-installer upgrade model (this only works if migrations are additive/backward-compatible enough to run before old containers fully stop — standard expand/contract migration discipline, worth stating explicitly as a constraint now since v0.1 already has migrations).

---

## 2. SSH-from-Control-Plane vs Installed Agent

### Confirmed via research

| Product | Default | Agent | When agent kicks in |
|---|---|---|---|
| **Dokploy** | SSH-only, always | None for standalone remote servers. Explicitly does **not** collect CPU/RAM/disk metrics for non-primary remote servers "due to performance reasons" (its own docs). Executes generated bash scripts over `ssh2`, streams output back. | Never, in the "remote servers" model — each remote server runs fully standalone Docker/Traefik, no cross-server agent. (Multi-node Swarm mode is a different, opt-in topology, not a metrics agent.) |
| **Coolify** | SSH-only baseline (`ServerCheckJob` polls over SSH for reachability + container state) | **Optional** — "Sentinel," a lightweight Go binary deployed as a container *on the remote server*, pushes metrics (CPU/mem/disk/network) and container status back to the control plane over an authenticated push channel (per-server `sentinel_token`, not the shared session auth). When Sentinel is enabled, the control plane prefers push data over "expensive SSH polling." | User opts in per-server once they want live, low-latency metrics beyond periodic SSH checks; SSH remains the fallback/bootstrap path even with Sentinel enabled. |

### What this means for Noodara

Both reference products validate the roadmap's own decision (`.planning/PROJECT.md`: "v0.1 opera por SSH desde el control plane, sin agent"): **SSH-only is not a toy shortcut, it is the production baseline used by the closest TypeScript precedent (Dokploy) even for their non-trivial remote-server feature.** An agent is an *optional, additive* optimization for push-based, low-latency metrics — not a prerequisite for correctness.

**When an agent becomes necessary (concrete triggers to watch for, not needed pre-emptively):**
1. **Polling cost at scale** — periodic SSH polling of many servers for live metrics (v0.5's observability) creates N concurrent SSH sessions on a cadence; an agent turns this into push-on-interval from the target, removing that fan-out cost from the control plane. This is exactly why Coolify added Sentinel *after* shipping SSH-only.
2. **Sub-minute freshness requirements** — SSH connect+exec round trips (hundreds of ms to seconds) make sub-10s polling intervals expensive/unreliable at more than a handful of servers; an agent with a persistent push connection doesn't have this ceiling.
3. **Streaming interactive use cases** — live terminal access, live log tailing with low latency, or the future Infrastructure Graph needing frequent state deltas are natural agent triggers (both reference products keep pure command-exec on SSH for one-shot operations, but use a persistent channel — Soketi/WebSocket for Coolify's UI push, Dokploy's own WebSockets for log/terminal streaming — for anything continuous).

None of these triggers exist in the v0.1 scope (connect + one-time discovery, no continuous metrics). **Decision for Noodara: v0.1 is SSH-only, matching both precedents. Design the `packages/ssh` port/adapter boundary (§3) so an agent can later be introduced as an *alternative adapter implementation* behind the same application-service interface — not a parallel code path** — this is the concrete thing that keeps a future agent cheap rather than a rewrite.

---

## 3. Internal Boundaries — Ports & Adapters over a Pure Domain Core

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|---|---|---|
| `packages/domain` | Entities, value objects, state machines (Server connection state, later Deployment state machine), validators, pure business rules. **Zero I/O, zero framework imports.** | Plain TypeScript classes/functions + Zod schemas for validation; this is the ≥95%-covered core the roadmap mandates |
| `packages/ssh` | Port (interface) + adapter (ssh2-based implementation) for "connect, run allowlisted command, disconnect." Owns TOFU fingerprint handling, per-command timeouts, output sanitization. | `SshPort` interface in the package root; `Ssh2Adapter implements SshPort` as the only concrete implementation in v0.1; a future `AgentAdapter implements SshPort` slots in without touching callers |
| `packages/docker` | Port + adapter for Docker operations (v0.2+: build, run, inspect). Not needed for v0.1's discovery (`docker version` is just a shell command over `packages/ssh`), but the package boundary should exist now so v0.2 doesn't have to carve it out of application code | Dockerode against a local socket for the control plane's *own* future local-Docker needs (STACK.md); remote-server Docker inspection stays shell-over-SSH per STACK.md's "What NOT to Use" (no remote Docker Engine API dependency) |
| `packages/git` | Port + adapter for Git operations. Empty/stub in v0.1, exists as a package boundary so v0.2 doesn't restructure the monorepo | — |
| `packages/ai` | Port + adapter for AI provider calls. Empty/stub in v0.1 | — |
| `packages/ui` | Shared design-system components consumed by `apps/web` | React components, Tailwind/CSS tokens matching the Apple-inspired design system |
| **Application services** (inside `apps/control-plane`, not a separate package) | Orchestrate domain + ports for a use case: `ConnectServerService`, `DiscoverServerService`, `RegisterServerService`. Own transactions, call `packages/domain` for rules, call `packages/ssh` for I/O, call the activity-log writer | Plain classes/functions injected with their port dependencies (constructor injection is enough — no DI container needed at this scale, consistent with STACK.md's Fastify-over-NestJS rationale) |
| **HTTP layer** (`apps/control-plane/src/routes`) | Fastify routes: parse/validate request (Zod), call an application service, map result to HTTP response/error. No business logic. | Fastify plugins per domain area (`auth`, `servers`, `activity`, `config`), each depending only on application services |
| **Worker** (`apps/control-plane/src/worker`, separate container/entrypoint, same codebase) | BullMQ job processors: `connect-server`, `discover-server`. Call the *same* application services as the HTTP layer — the queue is a delivery mechanism, not a second implementation of the logic | BullMQ `Worker` instances; jobs enqueued by the HTTP layer via BullMQ `Queue`, never call SSH inline from a request handler |

**Key rule (state this explicitly for the roadmap/plans):** application services are the single entry point into domain + ports. Both the HTTP layer and the worker call the *same* service classes — this is what prevents "the API does X one way and the worker does X another way" drift once v0.2+ adds more job types (builds, deploys).

### Recommended Project Structure

```
apps/
├── control-plane/            # Fastify API + BullMQ worker (one deployable image, two entrypoints)
│   ├── src/
│   │   ├── routes/           # HTTP layer — Fastify plugins, Zod schemas, no business logic
│   │   ├── services/         # Application services — orchestrate domain + ports, own transactions
│   │   ├── worker/           # BullMQ job processors, call the same services/ as routes/
│   │   ├── db/                # Drizzle schema + migrations (control-plane's own persistence)
│   │   └── activity/         # Activity log writer (used by services/, read by routes/)
│   └── ...
├── web/                       # Next.js UI — thin client of control-plane's HTTP/SSE API
└── agent/                     # v0.2+/later — empty/absent in v0.1, package boundary reserved

packages/
├── domain/                   # Pure — Server entity, connection state machine, validators. No I/O.
├── ssh/                      # SshPort interface + Ssh2Adapter. TOFU, timeouts, sanitization.
├── docker/                   # DockerPort interface + Dockerode adapter (stub-level in v0.1)
├── git/                      # GitPort interface (stub in v0.1)
├── ai/                       # AIProvider interface (stub in v0.1, matches roadmap §10.5)
└── ui/                       # Shared design-system components for apps/web
```

### Structure Rationale

- **`packages/domain` has zero dependencies on any other workspace package or Node built-in for I/O** — enforce with Turborepo boundaries (STACK.md already flags this: "enable `turbo.json` boundaries... so `packages/core-domain` cannot import from `apps/api` or `apps/web`"). Extend that same enforcement to forbid `packages/domain` importing `packages/ssh`/`packages/docker` too — domain defines the *interfaces* (ports) that live either in `packages/domain` itself or a thin `packages/ports` package; adapters implement them from the outside. This is what makes the ≥95% branch coverage requirement cheap: pure functions and state machines are trivial to exhaustively unit test without mocking SSH/Docker.
- **One deployable image for `api` + `worker`, two entrypoints/commands** — not two separate codebases. This keeps v0.1 simple (one build, one Dockerfile) while still getting the operational benefit of independent containers/processes (§1) — the split is at the Compose/process level, not the package level.
- **`apps/agent` reserved but absent** — creating the empty folder now costs nothing and documents the decision in §2 that an agent is a planned *addition*, not an afterthought bolted onto a two-app monorepo later.

---

## 4. Running SSH Commands Safely

This is the highest-risk component per the project's own Core Value statement ("sin fugas de credenciales, sin estados falsos, sin caídas por fallos del servidor remoto"). Concrete pattern, building on STACK.md's SSH discovery table:

### Allowlisted command templates, not arbitrary shell

`packages/ssh`'s adapter should expose a small, closed set of typed operations — not a generic `exec(anyString)` used ad hoc by callers. For v0.1:

```ts
// packages/ssh — the port (interface), lives in domain-adjacent code
interface SshPort {
  testConnection(target: SshTarget): Promise<ConnectionResult>;
  runDiscovery(target: SshTarget): Promise<DiscoverySnapshot>;
}
```

Internally the adapter runs a fixed, versioned set of commands (the table in STACK.md's "SSH Discovery" section — `hostname`, `cat /etc/os-release`, `uname -m`, `nproc`, `free -b`, `df -B1 /`, `cat /proc/uptime`, `docker version --format '{{json .}}'`), batched over one connection with unique delimiters, never string-interpolating any user-controlled value into the command text. This is the same shape Coolify and Dokploy use (they generate bash scripts server-side from fixed templates, not from free-form user input) and it is what makes "no arbitrary shell execution" achievable even before the roadmap's later requirement (v0.5 §10.6: AI must never "execute arbitrary shell") — v0.1 establishing this discipline early makes that later constraint nearly free instead of a retrofit.

### Timeouts

Two distinct timeouts, both explicit (roadmap §6.3, §6.5 require this):
- **Connection timeout** — time to establish the TCP+SSH handshake (`ssh2`'s `readyTimeout` option). Recommend 10s default.
- **Command timeout** — time for each exec'd command to complete, enforced independently (ssh2 has no native per-exec timeout; wrap each `client.exec()` call in a `Promise.race` against a timer that also kills the stream). Recommend 15–30s for discovery commands (they're all fast local reads; a hung command past that window indicates a stuck/unreachable host, not a slow legitimate operation).

Both timeouts must map to a distinct connection-state outcome (`UNREACHABLE` for connection timeout, `ERROR` with a specific reason code for command timeout) so the UI/activity log can distinguish "couldn't reach the box" from "reached it but something inside failed."

### Host key verification — TOFU (HIGH confidence on ssh2's API shape)

`ssh2`'s `Client.connect()` accepts `hostVerifier(key, callback)` (or a synchronous-return form). Pattern:
1. On first successful connect to a given `Server` record, capture the host key (`hostHash: 'sha256'` gives you a stable hex digest) and persist it on the `Server` row (`hostKeyFingerprint` column).
2. On every subsequent connect, `hostVerifier` compares the presented key's fingerprint against the stored one; mismatch ⇒ reject the handshake and surface a distinct, loud state (do not silently fall back to "just connect anyway" — a changed host key is either a legitimate server rebuild or a MITM, and the roadmap's Core Value statement treats "no fugas de credenciales" as non-negotiable, so this must be a user-visible, explicit re-confirmation step, not an auto-accept).
3. This is exactly TOFU as OpenSSH implements it via `known_hosts`, just scoped per-`Server`-row instead of a shared file — appropriate because Noodara already models servers as first-class entities with their own state machine.
4. First-connect UX: surface the fingerprint to the user before/during the first connection attempt (the roadmap explicitly requires "Host fingerprint strategy definida" — this *is* that strategy) so the admin has something to compare if they want to verify out-of-band, mirroring what SSH clients show on first connect.

### Connection pooling / reuse per server

For v0.1's scope (test connectivity + one discovery pass, both short-lived, both triggered by an explicit user action or a one-shot job), **a pooled/long-lived SSH connection is not needed and is actively worse**: it adds idle-connection lifecycle management (keepalives, reconnect-on-drop, per-server pool sizing) for a workload that is fundamentally "connect, run ~8 commands, disconnect" a handful of times. **Recommendation: connect-per-job, not a persistent pool.** Within a single discovery job, reuse the one connection for all ~8 discovery commands (already implied by STACK.md's "batched command... reusing one connection"), then close it. Revisit pooling only when v0.5's observability introduces recurring polling at a cadence tight enough that repeated handshake overhead matters — that is a clearly later, clearly triggered decision, not a v0.1 concern.

### Concurrency limits

Two levels:
- **Per-server**: at most one in-flight SSH operation per `Server` at a time — enforce with a BullMQ job option (`group` by server id, or a simple advisory lock keyed on server id read before starting a job) so a user clicking "test connection" twice, or a discovery job overlapping a manual reconnect, can't race two SSH sessions against the same host.
- **Global**: cap total concurrent SSH connections from the control plane (BullMQ worker `concurrency` setting) — protects the control plane's own file descriptors/memory when a user has registered many servers and triggers bulk actions. A concurrency of 5–10 is a reasonable v0.1 default; make it configurable via the "Configuración global del control plane" requirement already in scope.

---

## 5. Discovery Data Flow — Snapshot vs Current State

Two distinct persistence concepts, worth separating now even though v0.1 only needs the second one populated once per connect:

| Concept | What it is | Storage shape | Roadmap tie-in |
|---|---|---|---|
| **`DiscoverySnapshot`** | The raw, timestamped result of one discovery run — hostname, distro, OS version, arch, CPU, RAM, disk, uptime, Docker version, *as observed at time T* | Append-only rows (`discovery_snapshots`: `id`, `server_id`, `collected_at`, `payload jsonb` or normalized columns, `raw_ok boolean`) | Not explicitly required to be historical by v0.1's acceptance criteria, but v0.5's observability ("Last deployment," metrics history) and diagnosis features are naturally built on a time series of exactly this shape — modeling it as append-only from day one avoids a schema migration from "single mutable row" to "history table" later |
| **`Server.currentState`** | The *current* denormalized view the UI reads for the server list/detail page — status enum, last-known hostname/OS/CPU/RAM/disk/uptime/Docker, `lastSeenAt` | Columns directly on the `servers` table, updated by the discovery job after each successful run | Directly required: roadmap §6's Server Detail view (hostname, status, OS, CPU, RAM, disk, uptime, Docker, last seen) reads this, not a join across snapshot history |

**Flow:** `ConnectServerService` (triggered by user action) → enqueues `connect-server` BullMQ job → worker calls `SshPort.testConnection` → updates `Server.currentState.status` (`CONNECTING` → `CONNECTED`/`UNREACHABLE`/`ERROR`) and writes an `ActivityEvent` → on success, enqueues `discover-server` job → worker calls `SshPort.runDiscovery` → writes one `DiscoverySnapshot` row *and* updates the denormalized fields on `Server` → writes an `ActivityEvent` → UI (polling the server detail via SSE, §7) reflects the new state.

Writing both the snapshot and the denormalized current-state row in the same job (same transaction where possible) is the concrete decision that keeps v0.5's observability cheap: the history table already exists and is already populated, it just isn't surfaced in the UI yet.

---

## 6. Activity Log Design

Roadmap requirement: "Registro de actividad... Activity log de las operaciones relevantes sobre servidores y sesión."

**Shape:** a single, append-only `activity_events` table, not per-entity log tables — this generalizes cleanly as v0.2+ adds Projects/Services/Deployments without a redesign.

| Column | Purpose |
|---|---|
| `id` | PK |
| `occurred_at` | timestamp |
| `actor_type` / `actor_id` | who did it — v0.1 is single-admin so this is always "the admin user" or "system" (for automated actions like a scheduled recheck, if any exist in v0.1 — likely none, but the column should exist for v0.2's webhook-triggered deploys) |
| `event_type` | discriminated string, e.g. `server.registered`, `server.connection_tested`, `server.discovery_completed`, `server.deleted`, `auth.login`, `auth.logout` |
| `subject_type` / `subject_id` | polymorphic reference (`server`, id) — generalizes to `project`/`service`/`deployment` later |
| `metadata` | `jsonb`, event-specific structured detail — **must go through the same `toLogSafe()`-style mapper as pino logs (STACK.md's redaction pattern)** before being written, since this table is user-facing (displayed in the UI) and therefore an even more direct leak vector for credentials than application logs |
| `outcome` | `success` / `failure` + optional error code, so failed connection attempts are visible in the log, not just successes |

Write path: only application services write activity events (never routes or workers directly) — keeps "what counts as an activity-worthy action" centralized in one place per service, and guarantees the redaction mapper is always applied since it lives in the same layer.

---

## 7. Real-Time Status to the UI — SSE, not WebSocket, for v0.1

Both reference products use a persistent push channel (Coolify: Soketi/Pusher-protocol WebSocket; Dokploy: native WebSocket) for live UI updates — but both also support use cases beyond v0.1's scope (live deploy logs, interactive terminal) that are genuinely bidirectional or high-frequency streaming, which is why they reached for WebSocket-family tech.

**v0.1's actual real-time need is narrower and one-directional**: server connection status transitioning (`PENDING → CONNECTING → CONNECTED/UNREACHABLE/ERROR`) and discovery completing, both server → browser only, no client → server streaming. Current (2026) general guidance converges on: **SSE as the default for one-way server push (dashboards, status, notifications); WebSocket reserved for genuinely bidirectional/interactive cases (chat, collaborative editing, terminals).** MEDIUM confidence (WebSearch-derived consensus across multiple 2026 sources, not a single authoritative spec recommendation, but directionally consistent and matches Fastify's own first-class SSE support with no extra infrastructure).

**Recommendation for Noodara v0.1:** Fastify route emitting `text/event-stream` for server status (`GET /api/servers/:id/events` or a single `/api/events` stream scoped to the session), no separate WebSocket server, no Soketi-equivalent. This is simpler to operate (works through any reverse proxy/load balancer without special config, no separate stateful process to run in the Compose topology) and avoids STACK.md's "What NOT to Use"-style trap of adding infrastructure (a Pusher-protocol server) the v0.1 scope doesn't need.

**Explicit flag for v0.2+**: once deploy build logs (streamed, high-frequency, possibly very long) and later an interactive terminal/agent shell are in scope, revisit — SSE handles log streaming fine (it's still one-directional), but an interactive terminal is genuinely bidirectional and will need WebSocket (Fastify has `@fastify/websocket` ready, per STACK.md). Keep the SSE endpoint and a future WebSocket endpoint as separate routes rather than trying to force one transport to do both jobs.

---

## 8. Suggested Build Order for v0.1 (with dependencies)

```
1. packages/domain
   Server entity, connection state machine, validators (host/port/credential),
   encryption helpers. Zero I/O — build and fully unit-test this first,
   independent of everything else.
        │
        ▼
2. apps/control-plane: db layer (Drizzle schema + migrations for
   users/sessions, servers, discovery_snapshots, activity_events, config)
   + auth (Better Auth or hand-rolled sessions, per STACK.md's flagged decision)
        │
        ▼
3. packages/ssh (SshPort interface + Ssh2Adapter)
   Can be built in parallel with step 2 once step 1's Server/credential
   types exist — integration-tested against Testcontainers + a real
   sshd container (STACK.md already specifies this).
        │
        ▼
4. apps/control-plane: application services
   (RegisterServerService, ConnectServerService, DiscoverServerService)
   — wires domain (1) + db (2) + ssh (3) together. This is where the
   activity log writer and the toLogSafe() redaction mapper are built.
        │
        ├──────────────┬───────────────────┐
        ▼              ▼                   ▼
5a. HTTP routes    5b. BullMQ worker   5c. SSE endpoint
   (Fastify,          (processes           (Fastify route,
   Zod validation,    connect-server/       streams status
   calls services)    discover-server       transitions from
                       jobs, calls the       the same services)
                       same services)
        │              │                   │
        └──────────────┴───────────────────┘
                        │
                        ▼
6. apps/web (Next.js UI)
   Server list, add/edit/delete server, connect flow, server detail —
   consumes the HTTP API + SSE stream from step 5. Can start on static/
   mocked data (MSW, per STACK.md) in parallel with step 4-5, then
   wire to the real API last.
        │
        ▼
7. docker-compose.yml + install.sh
   Can be drafted early (it's independent of application code) but
   only finalized once steps 2-5 define real env vars, migration
   entrypoints, and healthcheck endpoints. Do this close to the end
   so it reflects the real container shape, not a guess.
```

**Why this order:** the pure domain layer first maximizes early unit-test coverage against the ≥95% target with zero infrastructure dependency (fastest feedback loop, matches the TDD mandate). SSH is the highest-risk, most failure-prone component (per the project's Core Value) — building and integration-testing it early, in isolation, against a real ephemeral SSH server (Testcontainers) means the riskiest part is de-risked before it's wired into the full connect→discover flow. The worker and HTTP routes can be built in parallel once application services exist because they are both thin callers of the same services (§3's key rule) — this parallelism is only possible *because* the port/adapter + application-service boundary was established first.

---

## 9. Explicit Decisions v0.1 Must Lock Now (to keep v0.2–v0.5 cheap)

| Decision | Why it must be made in v0.1, not deferred |
|---|---|
| **`SshPort` interface lives above the `ssh2` adapter, not inlined into application services** | This is the single decision that makes an agent (§2) or a different SSH library swap-in-place later instead of a rewrite of every caller |
| **Application services are the only entry point for both HTTP routes and the worker** | Prevents divergent logic between "the API does X" and "the queue does X" once v0.3's deployment engine adds many more job types on top of the same two entry points |
| **`DiscoverySnapshot` modeled as an append-only history table from day one, even though v0.1 only ever shows the latest** | Retrofitting "current single row" → "time series" after data exists means a backfill/migration; modeling it right the first time costs nothing extra now |
| **Activity log is one polymorphic `activity_events` table, not per-entity tables** | v0.2+ adds Projects/Environments/Services/Deployments; a per-entity log table design would need a new table (and a new UI aggregation view) every milestone |
| **`packages/domain` is enforced (via Turborepo boundaries) to have zero I/O and zero dependency on `packages/ssh`/`packages/docker`/`packages/git`** | This is what keeps the ≥95%-covered core actually pure and cheaply testable as the roadmap adds the deployment state machine (v0.3, needs 100% branch coverage per §8.7) and the Infrastructure Graph (v0.5) into the same package |
| **SSE endpoint is a separate, additive route from any future WebSocket endpoint — not a single transport doing double duty** | v0.2+'s build/deploy logs and a later interactive terminal have different transport needs (one-directional streaming vs bidirectional); deciding this now avoids re-architecting the real-time layer mid-milestone |
| **Docker Compose (not Swarm) for the control plane's own deployment topology** | Reversing this later (once users depend on a Swarm-based install) is far more disruptive than starting simple and adding Swarm-only features later if ever needed — Dokploy's own installer explicitly warns against re-running its Swarm-init installer on an existing cluster, illustrating the one-way-door risk of choosing Swarm early |
| **`api` and `worker` are split into separate containers/processes from the same image now, even at v0.1's tiny job volume** | The alternative (SSH calls made inline inside HTTP request handlers) blocks the event loop on multi-second SSH operations and makes v0.3's build/deploy jobs (much longer-running) a forced mid-milestone refactor instead of "add another job type to the existing worker" |

---

## Sources

- [coolify/docker-compose.yml (coollabsio/coolify, GitHub)](https://github.com/coollabsio/coolify/blob/main/docker-compose.yml) — service list (postgres, redis, soketi, coolify app), volumes, network. MEDIUM-HIGH confidence (location verified, contents summarized via search, not fully diffed).
- [Coolify installation docs](https://coolify.io/docs/get-started/installation) — installer behavior, upgrade-by-reinstall pattern.
- [DeepWiki: coollabsio/coolify — Server Monitoring (Sentinel and Metrics)](https://deepwiki.com/coollabsio/coolify/3.5-server-monitoring-(sentinel-and-metrics)), [Sentinel Metrics Push](https://deepwiki.com/coollabsio/coolify/8.6-sentinel-metrics-push) — Sentinel push-based agent vs SSH polling fallback, `sentinel_token` auth. MEDIUM confidence (third-party wiki, not Coolify's own docs, but internally consistent and consistent with Coolify's public marketing of Sentinel as an add-on).
- [Dokploy — Architecture](https://docs.dokploy.com/docs/core/architecture) — manager/worker node split, Swarm-based control plane, Traefik/Postgres/Redis bundled. MEDIUM confidence.
- [Dokploy — Remote Servers docs](https://docs.dokploy.com/docs/core/remote-servers) (previously reviewed in STACK.md research) — SSH-only, no cross-server agent, no remote metrics collection "for performance reasons." MEDIUM confidence.
- [mscdex/ssh2 (GitHub)](https://github.com/mscdex/ssh2), [ssh2 npm](https://www.npmjs.com/package/ssh2) — `hostVerifier`/`hostHash` API shape for TOFU host-key pinning. HIGH confidence (primary source, library README/API docs).
- [Understanding known_hosts and Host Key Verification: TOFU (DEV Community)](https://dev.to/mahafuz/understanding-knownhosts-and-host-key-verification-what-it-protects-against-and-how-tofu-works-pid) — TOFU model explanation, consistent with OpenSSH's own documented behavior. MEDIUM confidence (secondary source, but describes well-established, non-controversial SSH behavior).
- Multiple 2026 secondary sources on SSE vs WebSocket vs polling (Medium/dev.to/FlowVerify, aggregated) — converging 2026 guidance: SSE default for one-way server push/dashboards, WebSocket for bidirectional/interactive, polling for low-frequency/serverless. MEDIUM confidence (consistent across independent sources, no single authoritative spec source, but directionally uncontroversial and matches Fastify's own SSE support).
- `.planning/research/STACK.md` (this project, already-completed sibling research) — Dokploy's Next.js+tRPC+Drizzle+BullMQ+ssh2 stack, Coolify's Laravel+Livewire+Soketi stack, SSH discovery command table, encryption/logging/redaction patterns. Cross-referenced throughout rather than re-derived.

---
*Architecture research for: Noodara v0.1 Foundation (self-hosted PaaS control plane)*
*Researched: 2026-09-10*
