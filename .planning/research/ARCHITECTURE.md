# Architecture Research — v0.2 Projects & Services

**Domain:** Self-hosted PaaS control plane — Docker/Git deployment engine layered onto an existing SSH-only control plane
**Researched:** 2026-09-22
**Confidence:** HIGH (grounded directly in the shipped v0.1 codebase, not training data — every claim below cites a real file)

## Summary verdict

v0.2 is **not a new subsystem**, it is four additions to the existing v0.1 skeleton, applied at the exact seams v0.1 already built for this:

1. `packages/domain` gets a second state machine (`Deployment`), following `server-state.ts`'s pattern verbatim.
2. `packages/ssh`'s command allowlist gains **parameterized, escaped** templates (git/docker), and a **new streaming exec primitive** next to the existing whole-buffer `execWithTimeout` — the current `SshSession.exec(name: CommandName): Promise<ExecResult>` takes zero arguments and buffers the full 64 KB-capped output in memory, which is architecturally wrong for a multi-minute build log.
3. `apps/control-plane` gets a second BullMQ queue (`deployments`, next to the existing `servers` queue), a periodic reconciliation job, four new route files, and new SSE event types layered onto the *existing* single `GET /api/events` stream — no second SSE endpoint.
4. `apps/web` gets a hierarchical Project → Environment → Service tree replacing today's flat 3-item sidebar, and the three-panel layout `docs/ui-build-prompt.md` §2.6 already mandates be reachable without a rewrite gets its first real (non-placeholder) inspector content: the live deployment log.

Two new workspace packages (`packages/docker`, `packages/git`) and two new apps (`apps/docs`, `apps/site`) are required; none exist today (`ls packages/` → `config domain ssh ui`; `ls apps/` → `control-plane web`).

---

## 1. New entities and relations

### 1.1 Entity summary (extends CLAUDE.md §4)

CLAUDE.md §4 already names `Project`, `Environment`, `Service`, `Deployment` in its target entity list — v0.2 is the milestone that actually implements them. One **addition CLAUDE.md §4 does not currently name** is needed and should be added to that section: a deployment log storage entity (`DeploymentLogChunk` below) — this is infrastructure for the "build/runtime logs available" acceptance criterion (roadmap §7.8), not a first-class domain concept with its own state machine, but it does need a durable table.

```text
Project ── Environment ── Service ── Deployment ── DeploymentLogChunk
Server  ── Service                                        (existing relation, unchanged)
```

- **Project**: `id, name, description, archivedAt, createdAt, updatedAt`. Soft-delete via `archivedAt` (roadmap §7.1 says "Archivar/eliminar"; archiving is reversible, deleting is not — recommend archive-first, hard-delete only when no environments remain, mirroring the existing "delete requires typing the exact name" confirmation pattern already built for Server in `apps/web`'s delete dialog, §3.1 of `docs/ui-build-prompt.md`).
- **Environment**: `id, projectId (FK), name, kind ('production'|'staging'|'development'|'custom'), createdAt, updatedAt`. Roadmap §7.1 explicitly says names are not limited to the four conventions — model `kind` as a free-text column with those four as UI-suggested defaults, not a Postgres enum (an enum would need a migration every time a team wants a fifth custom label; `serverStatusEnum`'s enum-mirrors-domain-constant pattern is right for closed state sets, wrong for open-ended user labels).
- **Service**: `id, projectId (FK, denormalized), environmentId (FK), serverId (FK → servers.id), name, sourceType ('git'|'dockerfile'|'image'), repository (nullable — URL for git/dockerfile, image ref for image), branch (nullable), internalPort, status (derived, see §2.3), containerName (deterministic, see §6), createdAt, updatedAt`.
  - `projectId` is **denormalized onto Service** even though it is reachable via `environmentId → environment.projectId`. Reason: roadmap §7.8's acceptance criterion "Service ownership nunca cruza proyectos" is a value the service layer must be able to check and the database must be able to enforce with a single index, not a join — a composite FK `(environmentId, projectId) REFERENCES environments(id, projectId)` (Postgres supports composite FKs against a unique composite key) makes "this service's environment actually belongs to this service's project" a constraint the database rejects, not just something application code remembers to check. This mirrors the existing style of pushing invariants into Postgres indexes rather than trusting service-layer discipline alone (`servers_name_lower_unique_idx`, `servers_host_port_unique_idx` in `apps/control-plane/src/db/schema/servers.ts`).
- **Deployment**: exactly the fields roadmap §8.1 lists (`id, serviceId, commitSha, source, status, startedAt, completedAt, duration, trigger, triggeredBy, previousDeploymentId, errorCode, errorMessage`) — build the v0.3 shape now, since it costs nothing extra and avoids a v0.3 column migration. `commitSha`/`duration`/`previousDeploymentId` are nullable in v0.2 (not populated until v0.3 needs them for rollback), `trigger` in v0.2 is always `'manual'` (webhooks are v0.3).
- **DeploymentLogChunk** *(new, not in CLAUDE.md §4 — recommend adding it there)*: `id, deploymentId (FK), phase ('build'|'runtime'), seq (int, monotonic per deployment+phase), text, createdAt`. Append-only, one row per flushed chunk (see §4). Never updated, only inserted — same shape discipline as `activity_events`.

### 1.2 Relation table

| Relation | Cardinality | Enforced by |
|---|---|---|
| Project → Environment | 1:N | `environments.project_id` FK |
| Environment → Service | 1:N | `services.environment_id` FK |
| Project → Service | 1:N (denormalized) | composite FK `(environment_id, project_id)` against `environments(id, project_id)` |
| Server → Service | 1:N | `services.server_id` FK (mirrors `servers.credential_id → credentials.id` precedent) |
| Service → Deployment | 1:N | `deployments.service_id` FK |
| Deployment → DeploymentLogChunk | 1:N | `deployment_log_chunks.deployment_id` FK |

**Deleting a Server** must now also consider "does any Service still reference this server" — extend `apps/control-plane/src/services/delete-server.ts` (currently deletes credential + snapshots in one transaction, per PROJECT.md's validated Fase 3 note) with a guard that refuses deletion while active services exist, rather than silently orphaning `services.server_id`. This is a **modification**, not new code.

---

## 2. Where the Deployment state machine lives, and its v0.2 states

### 2.1 Location and pattern (new file, following an exact existing precedent)

`packages/domain/src/deployment/deployment-state.ts` — copy the shape of `packages/domain/src/server/server-state.ts` line for line:

- `DEPLOYMENT_STATUSES` frozen tuple (source of truth for both the TypeScript union and the Postgres enum, exactly like `SERVER_STATUSES` → `serverStatusEnum` in `apps/control-plane/src/db/schema/servers.ts:18`).
- `TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>>`, frozen.
- `transition(from, to, options)` — the **only** function allowed to produce a new status. No caller anywhere mutates `deployment.status` with a raw string, exactly as CLAUDE.md §4 requires ("nunca se mutan estados con strings sueltos").
- `InvalidTransitionError` / (no `MissingTransitionReasonError` needed in v0.2 — no edge requires a reason yet; the pattern stays available for v0.3's rollback edges).
- Test file `deployment-state.test.ts` exhaustively asserts every ordered pair, matching `server-state.test.ts`'s existing standard (CLAUDE.md §3.1: ≥95% statement/branch in domain state machines).

### 2.2 v0.2 minimal state set — chosen to make v0.3 additive, not a rename

Roadmap §8.2 fixes the **full** v0.3 set: `QUEUED, PREPARING, BUILDING, DEPLOYING, HEALTHCHECK, SUCCESS, FAILED, ROLLING_BACK, ROLLED_BACK, CANCELLED`. Two ways to reach v0.2 from here:

- (a) Pre-create all 10 enum values now, only wire transitions for a subset.
- (b) Create **only the 7 states v0.2 actually uses**, spelled identically to their v0.3 counterparts, and let v0.3 do an additive `ALTER TYPE ... ADD VALUE` migration for the remaining 3.

**Recommend (b).** Postgres enum values are cheap to add, expensive/impossible to remove cleanly — (a) would ship two dead states (`HEALTHCHECK`, `ROLLING_BACK`, `ROLLED_BACK`... three, not two) with no code path ever reaching them, which is exactly the "no adelantar features de una versión posterior" violation CLAUDE.md §1 forbids, applied to schema instead of code. (b) is forward-compatible because **no v0.2 state is renamed or removed in v0.3** — v0.3 only *inserts* `HEALTHCHECK` between `DEPLOYING` and `SUCCESS`, and *adds* `ROLLING_BACK`/`ROLLED_BACK` as new edges off `FAILED`. Existing v0.2 deployment rows never need backfilling.

**v0.2 `DEPLOYMENT_STATUSES`:**
```text
QUEUED PREPARING BUILDING DEPLOYING SUCCESS FAILED CANCELLED
```

**v0.2 `TRANSITIONS`:**
```text
QUEUED     → PREPARING | CANCELLED
PREPARING  → BUILDING  | FAILED | CANCELLED
BUILDING   → DEPLOYING | FAILED | CANCELLED
DEPLOYING  → SUCCESS   | FAILED | CANCELLED
SUCCESS    → (terminal)
FAILED     → (terminal)
CANCELLED  → (terminal)
```

No state is re-enterable via `CONNECTING`-style loops the way `ServerStatus` is (`CONNECTED → CONNECTING` etc.) — a Deployment is a single append-only attempt, not a resource with an idle steady state. A "redeploy" **always creates a new Deployment row**, it never resets an old one to `QUEUED` — this is what makes `previousDeploymentId` meaningful once v0.3 wires rollback.

`PREPARING` covers workspace creation + git clone/checkout or image pull-metadata; `BUILDING` covers `docker build` (or is skipped straight to `DEPLOYING` for `sourceType: 'image'`, since there is nothing to build — see §2.4). `DEPLOYING` covers container create+start. There is **no `HEALTHCHECK` state in v0.2** — the roadmap's own v0.2 E2E (§7.7: "run container → service becomes HEALTHY") is satisfied by the **container reconciliation loop** (§5) observing "container running", not by a real healthcheck (that's `v0.3`'s roadmap §8.5 concept). Do not let `Deployment.status = SUCCESS` be gated on a healthcheck in v0.2 — `SUCCESS` means "container was created and started without a Docker-reported error"; "the container is still running N seconds later" is a *Service*-level derived fact (§2.3), not a Deployment state re-check, because `Deployment` is a historical record of one attempt and must not flap after the attempt is over.

### 2.3 Service status is a derived value, not a second state machine

Roadmap §7.1 lists `status` as a Service field but gives no transition table (unlike Server and the v0.3 Deployment spec). Recommend **not** building a validated FSM for it — instead a pure function in `packages/domain/src/service/derive-service-status.ts`:

```ts
deriveServiceStatus(latestDeployment: DeploymentSummary | null, containerState: ContainerObservedState | null): ServiceStatus
```//
Values: `NEVER_DEPLOYED | DEPLOYING | RUNNING | STOPPED | FAILED | UNKNOWN`. `UNKNOWN` covers "server unreachable, last container observation is stale" — never silently reused as `STOPPED`, matching the discipline `run-discovery.ts` already applies to "docker not installed" vs "could not parse" (never collapse two different unknowns into one). This keeps `services.status` a **cached column** written by whichever of (deploy worker | reconciliation loop) last observed a change, never a column three different writers race to `transition()` on.

---

## 3. New BullMQ queues, jobs, and idempotency keys

### 3.1 New queue: `deployments`

Second `Queue`/`Worker` pair, structurally identical to the existing `servers` queue (`apps/control-plane/src/queue/connect-server-queue.ts` + `connect-server-worker.ts`) but **not** the same queue — deploys are long-running (minutes) and must not share a concurrency/lock budget with the fast (~seconds) connect/discover jobs, and `computeJobLockDurationMs` (`job-budget.ts`) is tuned specifically to SSH connect+discovery timeouts; a deploy job needs its own, much larger, lock-duration formula (build time is unbounded-ish; needs its own `NOODARA_DEPLOY_TIMEOUT_MS` env knob and its own `computeDeployJobLockDurationMs`, new sibling file `apps/control-plane/src/queue/deploy-job-budget.ts`).

- **Job name:** `deploy-service`.
- **`jobId`:** `deploy-<deploymentId>` — **not** `deploy-<serviceId>`. This is a deliberate divergence from the `connect-<serverId>` precedent (`jobIdForServer`, `connect-server-queue.ts:21`): `connect-server`'s jobId is keyed by the *resource* because there is at most one meaningful in-flight connect per server and no history of past attempts to keep distinct. A Deployment is itself the append-only history row (roadmap §8.1's `previousDeploymentId` chain) — keying the job by `serviceId` would prevent BullMQ from ever holding two historical Deployment rows' jobs distinctly, and would make "cancel this specific deployment" ambiguous the moment a second deploy is queued for the same service. Keying by `deploymentId` makes the job 1:1 with the row it updates.

### 3.2 The real concurrency guard is a Postgres partial unique index, not BullMQ dedupe

BullMQ's jobId dedupe (the `addFreshJob` pattern in `connect-server-queue.ts:64-82`) only prevents *the same jobId* from being enqueued twice — it does nothing to stop two *different* deployments for the *same service* from both being QUEUED simultaneously, which is the actual invariant v0.2 needs ("one deploy in flight per service"). Enforce it at the database:

```sql
CREATE UNIQUE INDEX deployments_service_active_unique_idx
  ON deployments (service_id)
  WHERE status IN ('QUEUED','PREPARING','BUILDING','DEPLOYING');
```

The `triggerDeploy` service inserts the new `Deployment` row (status `QUEUED`) and only enqueues the BullMQ job if that insert succeeds; a unique-violation on this partial index is caught and turned into a `409 DEPLOYMENT_IN_PROGRESS`, mirroring the exact "DB uniqueness catches what a service-layer race could otherwise miss" discipline already used for server names/host:port. This is the two-tier defense-in-depth style this codebase already favors (SSH retry + BullMQ jobId dedupe + DB index, stacked).

### 3.3 Cancellation is **not** a second queue

A BullMQ job that is already `active` (mid `docker build` over an open SSH channel) cannot be "cancelled" by manipulating the job in Redis — the worker process is inside a `for await` loop reading SSH exec chunks. Do **not** build a `deployment-cancel` queue whose jobs race the running `deploy-service` job; instead, an **out-of-band cooperative signal**:

- `POST /api/deployments/:id/cancel` → `cancelDeployment` service validates the deployment is non-terminal, then `SET noodara:deploy-cancel:<deploymentId> 1 PX <ttl>` on Redis (reuse the existing `redis/connections.ts` connection factory — new key namespace, not a new connection). It does **not** flip `Deployment.status` itself.
- The running `deploy-service` job's streaming exec (§4) checks this key between chunks (same cadence as its own SSE flush tick, §4) and, on seeing it set, calls the streaming exec's `abort()` (destroying the SSH channel the same way `execWithTimeout`'s timeout path already calls `channel?.destroy()`, `exec-with-timeout.ts:140`), runs the cleanup path (§6), and is the one that transitions `Deployment.status → CANCELLED` — preserving the existing rule that **only the worker-owned service layer transitions status**, never a route handler directly (mirrors `connect-server-worker.ts`'s comment that a route/worker boundary test forbids a worker writing activity events itself — the same "only the owning process performs the write" discipline applies here).
- Idempotency: repeated cancel calls on an already-cancelled or already-terminal deployment are a no-op (checked against current `status` before the `SET`, returns `200` either way — never a 409 for "already cancelling", since that is not an error from the caller's perspective).
- TTL on the Redis key is bound to the deploy job's own lock duration (`computeDeployJobLockDurationMs`) so an orphaned flag (job already gone) expires rather than lingering forever — same "always give ephemeral Redis state a bound" discipline as the existing `UNSUBSCRIBE_TIMEOUT_MS` / `ENQUEUE_TIMEOUT_MS` constants in this codebase.

### 3.4 New env knobs (extend `apps/control-plane/src/env.ts`, modified file)

`NOODARA_DEPLOY_TIMEOUT_MS`, `NOODARA_DEPLOY_LOG_MAX_BYTES`, `NOODARA_RECONCILE_INTERVAL_MS`, `NOODARA_DEPLOY_CONCURRENCY` (worker concurrency for the new queue, separate knob from `NOODARA_WORKER_CONCURRENCY` since deploy jobs are heavier than connect jobs). Each needs the same "no default for anything security-relevant, explicit range validation" treatment `env.ts`'s own header comment already documents, and each new var must be added to **both** `turbo.json`'s `dev`/`dev:worker` `passThroughEnv` arrays (ADR 0003's documented pitfall: Turborepo's strict env mode silently strips undeclared vars) — a concrete modification point easy to miss.

---

## 4. Remote build streaming: SSH exec → chunked → Redis → SSE, with bounded buffers and persistence

### 4.1 Why the existing `execWithTimeout` cannot be reused as-is

`packages/ssh/src/ssh-port.ts:73` — `SshSession.exec(name: CommandName): Promise<ExecResult>` — takes **no arguments at all**. `packages/ssh/src/commands/*.ts` templates are frozen, zero-interpolation strings (`allowlist.ts`'s own doctring: "no user input ever reaches a shell"). `exec-with-timeout.ts` accumulates the *entire* stdout/stderr into an in-memory buffer capped at `MAX_OUTPUT_BYTES = 65_536` (`exec-with-timeout.ts:11`) and only resolves once, at channel `close`. Every one of these three properties is correct for an 11-command, sub-second discovery run and wrong for a `docker build` that can run for minutes and emit megabytes: no way to pass a repo URL or image tag, no incremental delivery, and a 64 KB cap would truncate most real build logs to nothing useful.

This is not a bug — it is a deliberate v0.1-scope choice (`escapeShellArg`'s own comment in `allowlist.ts:36` says: *"No v0.1 template takes an argument yet — this is forward-looking infrastructure for the day one does"*). v0.2 is that day.

### 4.2 New: parameterized, escaped command templates

Extend `packages/ssh/src/commands/` with a `docker-build.ts` / `git.ts` module whose templates are **functions**, not frozen strings, each validating and escaping every interpolated value through `escapeShellArg` (already exported, already exists, currently unused in production code) — and, for values with a stricter grammar than "any shell-safe string" (image/container names, branch names, ports), a **domain validator runs first** (new `packages/domain/src/validators/docker-naming.ts`, `packages/domain/src/validators/git.ts`) so an invalid value is rejected before it ever reaches shell-quoting, not merely quoted-and-hoped-safe. Concretely:

```ts
// packages/ssh/src/commands/git.ts
export function gitClone(url: RepositoryUrl, targetDir: DeployWorkspacePath): string {
  return `git clone --depth 1 --branch ${escapeShellArg(branch)} -- ${escapeShellArg(url)} ${escapeShellArg(targetDir)}`;
}
```

`RepositoryUrl` and `DeployWorkspacePath` are **branded types** produced only by a domain validator/constructor (mirrors `SecretValue`/`MasterKeyBase64`'s existing branding discipline in this codebase, `packages/domain/src/security/secret-value.ts`, `env.ts:15`) — a raw `string` can never reach `gitClone` without passing validation first. `DeployWorkspacePath` in particular must be validated as **exactly** `/opt/noodara-deploy/<uuid>` (§6) — never built by string-concatenating a caller-supplied path segment — which structurally rules out path traversal.

New allowlist command names (extending `CommandName`'s union, `packages/ssh/src/commands/index.ts`): `git.clone`, `git.checkout`, `docker.build`, `docker.pull`, `docker.create`, `docker.start`, `docker.stop`, `docker.restart`, `docker.remove`, `docker.inspect`, `docker.logs`, `docker.ps`, `fs.remove_deploy_dir`. Each still goes through `commandFor`-style dispatch — the allowlist stays *closed* (still 20-odd fixed templates, never a free-form string from a route), it is only the **arguments** that become dynamic and escaped, never the command shape itself.

### 4.3 New: streaming exec primitive

New file `packages/ssh/src/exec-streaming.ts`, a sibling to `exec-with-timeout.ts` reusing its internal building blocks (`trimIncompleteUtf8Tail`, the single-settle guard-flag pattern, the timeout-driven `channel?.destroy()`) but with three differences:

1. **Incremental callback**, not batch-then-resolve: `onStdout(chunk: Buffer)` / `onStderr(chunk: Buffer)` fire on every `'data'` event, each chunk passed through the injected `Redactor` **before** the caller ever sees it (same redact-before-anywhere-downstream discipline `exec-with-timeout.ts:196` already applies, just per-chunk instead of once-at-the-end).
2. **A much larger, still-bounded, total-byte cap**, distinct from the 64 KB discovery cap — a new `MAX_STREAM_OUTPUT_BYTES` sourced from `NOODARA_DEPLOY_LOG_MAX_BYTES` (§3.4), default recommendation **10 MiB** per phase (build/runtime tracked separately). Exceeding it does not fail the command — it appends a synthetic `"[log truncated at N bytes]"` chunk and stops forwarding further output (mirrors `ExecResult.truncated`'s existing boolean, extended per-chunk-stream instead of per-call).
3. **Cooperative cancellation**: accepts an `AbortSignal` (or a lighter polling callback consistent with this codebase's existing preference for explicit checks over Node's AbortController machinery elsewhere) checked on every flush tick; on abort, calls the exact same `channel?.destroy()` path the timeout branch already uses, and rejects with a distinct `DeploymentCancelledError` so the caller (the deploy worker) can distinguish "I cancelled this" from "it timed out" from "it failed" — three different `Deployment` end states (§2.2) must not be conflated.

### 4.4 Chunk flushing: worker memory → Postgres → Redis → SSE

The deploy worker (new `apps/control-plane/src/queue/deploy-worker.ts`) never buffers a whole log in process memory before persisting. A small in-worker batching buffer (flush every **250 ms or 16 KB, whichever first** — chosen to stay well under the existing SSE per-connection backpressure ceiling of `SSE_MAX_BUFFERED_BYTES = 1_048_576`, `routes/events.ts:36`, and to avoid an SSE flood on a chatty build) does, on each flush:

1. `INSERT INTO deployment_log_chunks (deployment_id, phase, seq, text) VALUES (...)` — one row per flush, `seq` a per-`(deploymentId, phase)` monotonic counter the worker increments locally (no read-then-write race since exactly one worker owns one deployment's job at a time, guaranteed by BullMQ's own per-jobId lock). This is the **persistence** half of "log persistence for later viewing" — append-only rows, same shape discipline as `activity_events`' single-insert-path precedent (`apps/control-plane/src/activity/write-activity-event.ts`), explicitly chosen over a single growing `text` column that would need a full-row rewrite (TOAST) on every append — a real cost difference for a multi-MB log written in hundreds of small appends.
2. `publishDeploymentEvent({ type: 'deployment.log_chunk', deploymentId, phase, seq, text })` — a **new sibling** to `publishServerEvent` (`apps/control-plane/src/events/server-event-publisher.ts`), same never-throw/swallow-and-log contract, same "an implementation must never reject" interface shape. Reuses the *existing* Redis pub/sub channel infra (`redis-server-event-publisher.ts`'s pattern), either a shared channel with a `type`-based dispatch already in place (`sse-broadcaster.ts`'s `handleMessage` already discriminates on `parsed.type`) or a second parallel channel subscribed by the same broadcaster — recommend **reusing the single existing channel and broadcaster instance**: `sse-broadcaster.ts`'s `KNOWN_EVENT_TYPES` set (currently `server.updated`, `server.deleted`, `server.discovery_progress`, `sse-broadcaster.ts:41-45`) is extended with `service.updated`, `service.deleted`, `deployment.updated`, `deployment.log_chunk` — no second SSE endpoint, no second broadcaster, `GET /api/events` stays the **one** global stream, exactly as `docs/ui-build-prompt.md` §2.4 documents as a contract to preserve.

### 4.5 Resync contract for logs (no replay, same discipline as Server)

`ui-build-prompt.md` §2.4 is explicit: *"no hay replay de eventos. Cada reconexión del stream dispara un GET fresco... los eventos que llegan mientras un snapshot está en vuelo se bufferean y se pliegan sobre él."* Apply the identical pattern to logs: a client opening a deployment's inspector panel mid-build does `GET /api/deployments/:id/log?phase=build&since=<seq>` (chunk-paginated REST snapshot of everything persisted so far) **then** subscribes to `/api/events` and folds incoming `deployment.log_chunk` events (by `seq`) over that snapshot — never trusts the SSE stream alone to have delivered every chunk since deployment start, because SSE here (as with Server) is best-effort/no-replay, Postgres remains the source of truth. This is a **reused contract**, not a new one — worth stating explicitly to the web layer so it is not reinvented differently for deployments than for servers.

---

## 5. Reconciliation loop for container state

### 5.1 Event-driven (`docker events` streamed over SSH) — rejected

A persistent `docker events --format '{{json .}}'` channel held open per connected server would require exactly the long-lived-SSH-channel shape `packages/ssh` was **not** built for: every existing primitive (`execWithTimeout`, `runDiscovery`) is "connect once, run N short commands, close" (`run-discovery.ts`'s own docstring: "the caller... owns the session's lifecycle"). Keeping one channel open indefinitely per server multiplies to N always-open SSH connections system-wide, needs its own reconnect-on-drop/backoff logic distinct from the existing single-retry-on-connect model (`connection-mutex.ts` + D-10's "single retry for transients"), and reintroduces exactly the kind of long-lived-resource bookkeeping the SSE broadcaster already has to manage carefully for browser connections (`SSE_MAX_BUFFERED_BYTES`, connection caps) — but per *server* instead of per *browser tab*, with no natural cap. Rejected for v0.2's scope.

### 5.2 Periodic poll — recommended

A new BullMQ **repeatable job** (`reconcile-servers`, BullMQ's native `repeat: { every: NOODARA_RECONCILE_INTERVAL_MS }` option — no cron library needed) that, on each tick, does **one SSH connection per CONNECTED server that has ≥1 Service**, running the new `docker.ps` allowlisted command (`docker ps --all --format '{{json .}}'`, matching the existing `--format '{{json .}}'`-only, "never free-text parsing" convention already stated in `packages/ssh/src/commands/docker.ts:1-3`) — **one exec covering every service on that server**, not one exec per service. Cost model: `1 connect + 1 exec` per connected server per interval, independent of how many services that server runs. Recommend a **30s default interval** (`NOODARA_RECONCILE_INTERVAL_MS`), reusing the existing `commandMs` timeout budget for the exec itself.

The reconciliation job compares each known `containerName` (deterministic, §6) against the polled `docker ps` output and updates the derived `services.status` column (§2.3) plus emits `service.updated` when the observed state changed — but it **never writes to `deployments`**. Keeping the reconciliation loop's write scope limited to `Service` (not `Deployment`) avoids a second writer racing the deploy worker on the same `Deployment` row, matching the existing "only the owning process performs the write" discipline (§3.3).

**Immediate post-deploy feedback is not this loop's job.** Right after `docker start` inside the `DEPLOYING` step, the deploy worker itself does a few short, backed-off `docker inspect` polls (still over the *same already-open* connection it used for the build, no extra connect) to decide `SUCCESS`/`FAILED` promptly — the periodic reconciliation loop is purely the **background drift detector** (container OOM-killed, manually `docker stop`-ped outside Noodara, host rebooted) that the deploy worker's synchronous check cannot catch after the fact.

---

## 6. Remote workspace layout, and a naming collision worth flagging now

### 6.1 The collision

`docker-compose.yml`'s own header comment says the **installer writes to `/opt/noodara/docker-compose.yml`** — on whatever host runs the control plane. In the common indie-dev topology (the target audience per `.planning/PROJECT.md`), that host **is the same VPS** later "connected" as the first `Server`. If deployment workspaces also used `/opt/noodara/...` on the target server, a self-managing single-VPS setup would have Service build directories landing inside the control plane's **own** install tree — right next to `docker-compose.yml`, `.env`, and the Postgres/Redis data volumes the installer already owns.

### 6.2 Recommendation

Use a **distinct namespace on the target server**: `/opt/noodara-deploy/<deploymentId>/` — one directory per deployment attempt (not per service), created fresh by `git.clone`/the Dockerfile build-context copy, and **unconditionally removed** at the end of the job regardless of outcome. Per-deployment (not per-service, shared/reused) isolation is deliberate: it means two concurrent build attempts (should the §3.2 unique-index guard ever be bypassed, or during a future v0.3 rollback that briefly needs an old build context) can never corrupt each other's checkout, and "cleanup" is always "remove exactly one UUID-named directory whose path was validated as that shape and nothing else" — never a `rm -rf` against a path built by concatenating anything caller-controlled.

```text
/opt/noodara-deploy/
└── <deploymentId>/          created by git.clone or Dockerfile COPY staging
    └── <repo contents>      removed unconditionally on SUCCESS, FAILED, CANCELLED
```

### 6.3 Container and (forward-looking) network naming

Deterministic **per-service** container name: `noodara-<serviceId>`. Deterministic naming (not per-deployment) is what lets a redeploy be "stop+remove the old container, create+start the new one under the same name" — the same mechanism the reconciliation loop (§5) relies on to find "the" container for a service without needing a second lookup table. `docker.create`/`docker.start`/`docker.stop`/`docker.remove` all take this validated name (domain-validated against Docker's own naming grammar *before* `escapeShellArg`, §4.2).

Roadmap §7.8's acceptance criterion explicitly says *"20 create/delete cycles no dejan containers **ni networks** huérfanos"* — even though v0.2 has no Traefik/multi-container routing need yet (that's v0.4). Recommend creating **one dedicated bridge network per service now**, `noodara-net-<serviceId>`, even though nothing but that one container uses it in v0.2. Rationale: v0.4's Traefik integration will need services reachable on a shared or per-service network to route to; doing this now means zero services need a network-migration when v0.4 lands, and it directly satisfies the roadmap's own "no orphan networks" wording rather than requiring a reinterpretation of it. `docker network rm noodara-net-<serviceId>` joins the cleanup path alongside container removal.

### 6.4 Cleanup discipline — every failure path, not just the happy path

The deploy job handler wraps workspace creation → build → deploy in a structure where **every exit** (`SUCCESS`, `FAILED`, `CANCELLED`, and an *unhandled* worker crash) runs the same cleanup sequence, mirroring how `connect-server-worker.ts` already has a three-layer recovery net for its own job (in-line catch → `'failed'` listener → `'stalled'` listener → startup `sweepAbandonedConnections`):

1. Always: `fs.remove_deploy_dir` for `/opt/noodara-deploy/<deploymentId>/` (idempotent — remove-if-exists, never errors if already gone).
2. On `FAILED`/`CANCELLED` **specifically**: if a container was already `docker create`-d before the failure, `docker rm -f noodara-<serviceId>` — tracked by recording "container was created" as a local step-completion flag inside the job (not a DB column; this is job-execution state, not Deployment history) before ever calling `docker create`, so the cleanup step knows whether removal is needed without guessing from `Deployment.status` alone.
3. **Startup sweep, new sibling to `sweepAbandonedConnections`:** a worker-boot routine that finds every `Deployment` still `QUEUED`/`PREPARING`/`BUILDING`/`DEPLOYING` with no live BullMQ job for its `deploy-<id>` jobId (a worker crash mid-deploy, same class of gap `sweepAbandonedConnections` (`connect-server-worker.ts:176`) already closes for `CONNECTING` servers) and transitions each to `FAILED` — but **cannot** safely run its own SSH cleanup blind (the crashed worker's own workspace/container state is unknown) — recommend this sweep marks the deployment `FAILED` with a distinct `errorCode: 'WORKER_CRASHED'` and defers to the *next* reconciliation tick (§5) to detect and remove any resulting orphan container, rather than attempting a second, riskier SSH cleanup pass from a process that does not know what state the crashed worker left things in.

---

## 7. New API routes and SSE event types

### 7.1 Routes (new files, following the existing per-entity route-file + Zod-schema + services-layer pattern from `routes/servers.ts` / `routes/server-schemas.ts`)

| Method & path | New file | Notes |
|---|---|---|
| `POST /api/projects`, `GET /api/projects`, `GET /api/projects/:id`, `PATCH /api/projects/:id`, `DELETE /api/projects/:id` | `routes/projects.ts` | mirrors CRUD shape of `routes/servers.ts` |
| `POST /api/projects/:projectId/environments`, `GET .../environments`, `PATCH /api/environments/:id`, `DELETE /api/environments/:id` | `routes/environments.ts` | nested create, flat read/update/delete by id |
| `POST /api/environments/:environmentId/services`, `GET .../services`, `GET /api/services/:id`, `PATCH /api/services/:id`, `DELETE /api/services/:id` | `routes/services.ts` | create validates `serverId` points at a `CONNECTED` server (new cross-entity check) |
| `POST /api/services/:id/deploy` | `routes/deployments.ts` | inserts `Deployment` (QUEUED) + enqueues `deploy-service`; `409` on the §3.2 unique-index violation |
| `GET /api/services/:id/deployments` | `routes/deployments.ts` | history, cursor-paginated (reuse the existing cursor pattern from `routes/activity-cursor.ts`) |
| `GET /api/deployments/:id` | `routes/deployments.ts` | current status/metadata |
| `GET /api/deployments/:id/log?phase=build\|runtime&since=<seq>` | `routes/deployments.ts` | chunk snapshot for the resync contract (§4.5) |
| `POST /api/deployments/:id/cancel` | `routes/deployments.ts` | sets the Redis cancel flag (§3.3), `200` idempotent |

All under the existing `/api` guarded scope (`routes/api-scope.ts` — session + Origin guard already apply, no new auth wiring needed). New Zod schema file `routes/project-schemas.ts`, `environment-schemas.ts`, `service-schemas.ts`, `deployment-schemas.ts`, mirroring `server-schemas.ts`'s existing strictness.

### 7.2 SSE event types (extend, don't replace, `GET /api/events`)

Extend `sse-broadcaster.ts`'s `KNOWN_EVENT_TYPES` (`sse-broadcaster.ts:41`, a **modified** file) with:

```text
service.updated
service.deleted
deployment.updated          -- status transitions
deployment.log_chunk        -- {deploymentId, phase, seq, text}
```

`project.*` / `environment.*` real-time events are **not recommended for v0.2** — projects/environments change rarely (created once, edited occasionally) and a full-page reload/refetch on those screens is an acceptable UX cost that avoids growing the SSE event surface for low-value cases; add them later only if the UI review (skill `noodara-ux-review`) finds the staleness noticeable. Keeps the allowlist's literal-string-only discipline (`sse-broadcaster.ts`'s own comment: "never a wildcard/prefix/regex match") tight.

---

## 8. Web routing / IA for the three-panel layout

`docs/ui-build-prompt.md` §2.6 states the constraint directly: *"El layout de referencia del roadmap es de tres paneles (navegación / contenido / inspector)... Cualquier decisión de este upgrade debe dejar ese tercer panel y una navegación jerárquica posibles sin reescritura."* Today's shell (`apps/web/src/app/(shell)/`) is two-panel: a flat 3-item sidebar (Servers, Activity, Settings, §3.1 of the same doc) + content column. v0.2 is the first milestone with something real to put in a third panel.

### 8.1 Recommended route tree (new, under the existing `(shell)` route group)

```text
apps/web/src/app/(shell)/
├── projects/
│   ├── page.tsx                                    -- project list (nav-panel root)
│   └── [projectId]/
│       └── environments/
│           └── [environmentId]/
│               └── services/
│                   └── [serviceId]/
│                       ├── page.tsx                 -- content panel: service overview + deploy history
│                       └── deployments/
│                           └── [deploymentId]/
│                               └── @inspector/...   -- parallel route: inspector panel content
```

Use a Next.js **parallel route** (`@inspector` slot) for the third panel rather than a full page navigation to a separate deployment URL — this is what lets selecting a deployment from the content panel's history list populate the inspector **without unmounting** the nav/content panels, matching the "three columns update independently" behavior the three-panel doctrine implies, and matching the App Router idiom Next.js 16 (already the pinned version, ADR 0006) supports natively.

### 8.2 Nav panel — hierarchical, replacing the flat sidebar

Today's sidebar (`Servers | Activity | Settings` + theme toggle + sign out, §3.1) gets a new top-level **Projects** entry whose subtree expands `Project → Environment → Service` inline (progressive disclosure, per CLAUDE.md §5's "mostrar primero lo esencial; detalle bajo demanda"). `Server`, `Activity`, `Settings` stay top-level, peer entries — **Server is not nested under Project** in the nav, because the domain relation is `Server ── Service` (a peer reference, CLAUDE.md §4), not containment: a Server exists and is manageable independently of any Service deployed to it. This nav restructuring is the one piece of this research question that most overlaps with the separate UI-redesign track PROJECT.md already schedules ahead of Projects & Services (§9 below) — recommend the redesign phase build the hierarchical nav's *shell/interaction pattern* generically (expand/collapse, breakpoint behavior at the existing 1280px/900px thresholds) before real Project data exists, then this milestone's Projects & Services phase wires it to real entities. Avoids the redesign phase inventing a nav pattern for the flat 3-item case that then needs restructuring days later.

### 8.3 Content panel

`/projects` → list (empty state reuses the existing `EmptyState` component, `packages/ui`). `/projects/:id/environments/:envId` → service list for that environment. `/projects/:id/environments/:envId/services/:svcId` → service overview: config (source, branch/image, port), a primary "Deploy" action (max-one-primary-button toolbar discipline already established for `/servers`, §3.1), and a deployment history list (rows, not cards — same hairline-row convention as `/servers` and `/activity`).

### 8.4 Inspector panel

For v0.2 its only real content is the **live/persisted deployment log** (§4.5's GET-snapshot + SSE-fold pattern) — build/runtime tabs, monospace type (already specified for logs/SHAs/ports in CLAUDE.md §5), auto-scroll-to-bottom while live with a "jump to bottom" affordance once the user scrolls up (standard log-viewer UX, not novel). This satisfies PROJECT.md's "deja previsto el tercer panel... sin placeholders" note from the milestone's own phase-2 description — v0.2 is where the inspector gets *real* content, not a stub.

---

## 9. Where the docs site and landing page live, and how CI builds/publishes them

### 9.1 Placement — two new apps, not under `apps/web`

`CLAUDE.md` §3.1's proposed structure does not currently list either. Add:

```text
apps/
├── control-plane/
├── web/
├── docs/     -- new: public documentation site
└── site/     -- new: public marketing/landing page
```

Both are covered automatically by `pnpm-workspace.yaml`'s existing `apps/*` glob (verified: `packages: ["apps/*", "packages/*"]` — **no change needed there**). `turbo.json`'s `build`/`lint`/`typecheck` tasks already apply to every workspace package generically; only its **boundaries** section (§9.3) needs a look.

**Why not fold them into `apps/web`:** `apps/web` is the authenticated product shell — same-origin-proxied to the control plane per ADR 0006, deployed as part of the self-hosted `docker-compose.yml` topology every end user runs (`web` service in `docker-compose.yml`). The docs and marketing sites are **pre-auth, public, project-website content** — they have no control-plane runtime dependency, a completely different deploy cadence (pushed whenever the Noodara *project* website changes, not when a self-hoster runs `install.sh`), and should not force every self-hosted install to also build/ship a marketing site nobody self-hosting needs to run locally.

### 9.2 Framework — left open, one constraint stated

The question this document must answer is monorepo placement and CI shape, not a framework pick (that belongs in `STACK.md` if the roadmapper wants it researched separately). The one architectural constraint worth fixing now: **both must be statically buildable with zero control-plane runtime dependency** (no `DATABASE_URL`, no `REDIS_URL`, no Better Auth) — whatever framework is chosen (a second static Next.js export, or a docs-purpose-built generator), it must not import anything from `apps/control-plane` or require it running at build time, so these two apps can be built and deployed by CI **without** the Testcontainers/Postgres/Redis machinery every other build gate in this repo needs.

### 9.3 Boundaries — one small `turbo.json` addition

`turbo.json`'s `boundaries.tags` block currently defines `pure-domain`, `ssh-adapter`, `ui-components` (`turbo.json`, tags section). `apps/docs` and `apps/site` should be free to depend on `packages/ui`'s **design tokens** (for shared brand colors/typography per PROJECT.md's "misma identidad" requirement) but nothing else product-internal — recommend they carry no special tag (implicitly unrestricted, same as `apps/web` today has no tag) but a **new boundary test** (mirroring `packages/ssh/src/boundary.test.ts`'s pattern of catching what Turborepo's own dependency-graph check cannot see) asserting neither app imports anything from `apps/control-plane` or `@noodara/domain` — a docs/marketing site importing a domain validator would be a smell worth catching mechanically, not just by convention.

### 9.4 CI/publishing — a separate workflow, decoupled from the product release pipeline

`.github/workflows/` currently has `ci.yml` (PR gates), `nightly.yml`, `release.yml` (the versioned, GHCR-published `noodara-control-plane`/`noodara-web` images described in PROJECT.md's Fase 6 entry). **Do not** add `docs`/`site` services to `docker-compose.yml` — that file is the self-hosted *product* topology every end user's VPS runs; the project's own public website is not something a self-hoster installs.

Recommend a **new workflow**, `.github/workflows/public-site.yml`, path-filtered on `apps/docs/**` and `apps/site/**`, triggered on push to `main`, building and publishing to a static host (Vercel/Cloudflare Pages/Netlify/GitHub Pages — hosting and domain are explicitly deferred to the requirements phase per PROJECT.md's own note: *"hosting y dominio se deciden en requisitos"*, so this document fixes the **shape** — a separate, path-filtered, static-deploy workflow — without committing to a host). This keeps the public site's deploy cadence (every docs edit) fully decoupled from the versioned, gated `release.yml` pipeline that ships the actual product images — a docs typo fix should never need to cut a `v0.2.x` product release, and a product release should never be blocked on an unrelated marketing-copy build failure.

---

## 10. Build order — 7 phases with dependencies

The backend deployment-engine work (Phases 2–6 below) is the architecturally load-bearing part of v0.2 and is this document's main focus; identity/UI-redesign/docs-site work (PROJECT.md's own separately-ordered target features 1–4) is noted as a parallel track since it has no hard dependency on the deployment engine, only on `packages/ui` and static brand assets.

```
Phase 1: Domain & schema foundation
  packages/domain: Project/Environment/Service/Deployment validators,
  deployment-state.ts (§2), derive-service-status.ts (§2.3), docker-naming.ts
  + git.ts validators (§4.2). apps/control-plane: db/schema + migration 0004,
  composite-FK ownership constraint (§1.2), partial unique index (§3.2).
  Depends on: nothing new. Can start immediately, in parallel with the
  identity/redesign track.
        │
        ├──────────────────────────────────────────────┐
        ▼                                                ▼
Phase 2: Remote execution primitives                Phase 0 (parallel, separate track):
  NEW packages/git, packages/docker (thin, typed      Identity/brand kit → UI redesign
  wrappers composing packages/ssh's new templates).    (per PROJECT.md's own target-feature
  packages/ssh: parameterized command templates,       ordering 1–2). Feeds packages/ui
  exec-streaming.ts (§4.2–4.3), workspace path          tokens Phase 4/9 both need.
  builder+validator (§6). Depends on Phase 1 only for
  the branded-type validators; otherwise independent
  low-level work.
        │
        ▼
Phase 3: Queue & worker
  deployments BullMQ queue + deploy-service job
  (§3.1), deploy-job-budget.ts, cancellation signal
  (§3.3), chunk flush→persist→publish pipeline (§4.4),
  reconciliation repeatable job (§5), startup-crash
  sweep (§6.4). Depends on: Phase 1 + Phase 2.
        │
        ▼
Phase 4: API layer
  routes/{projects,environments,services,deployments}.ts
  + schemas, services layer (createProject, ...,
  triggerDeploy, cancelDeployment), SSE event-type
  extension (§7.2), activity-log actions for new
  entities, delete-server.ts guard update (§1.2).
  Depends on: Phase 3 (needs the queue to enqueue
  into) + Phase 1 (schema).
        │
        ▼
Phase 5: Web UI wiring
  Hierarchical nav (§8.2), parallel-route inspector
  (§8.1/8.4), GET-snapshot+SSE-fold log viewer (§4.5),
  create-project/environment/service flows, deploy
  trigger + history UI. Depends on: Phase 4, and
  ideally lands after Phase 0's redesign so new
  screens are built once, in the final visual
  language (matches PROJECT.md's own stated reasoning
  for ordering redesign before Projects & Services).
        │
        ▼
Phase 6: Fixtures & E2E
  fixtures/node-api, static-app, failing-build
  (roadmap §7.6). E2E critical path (§7.7): create
  project → env → Git service → server → build → run
  → HEALTHY. 20-consecutive-deploy stress, 20
  create/delete-cycle orphan check (§7.8). Depends on:
  Phase 4 + Phase 5 (E2E drives through the UI,
  matching this repo's existing Playwright pattern).
        │
        ▼
Phase 7: Hardening & release gate
  v0.1 operator debt carried into v0.2's Active scope
  (log rotation, .env.bak-* pruning, image size,
  22.04/arm64/ufw, small-VPS memory — PROJECT.md
  "Active" list) + apps/docs, apps/site scaffolding
  and public-site.yml (§9). Mostly independent of the
  deployment-engine phases; can run in parallel with
  Phases 2–6 but should close last, as the release
  gate always does (skill noodara-release-gate).
```

**Critical path:** `1 → 2 → 3 → 4 → 5 → 6` (6 phases, sequential dependencies). Phase 0 (identity/redesign) and Phase 7's docs/site + hardening halves are parallelizable side tracks that do not block the critical path but should both be closed before the milestone's own release gate, consistent with how v0.1's gate (`docs/releases/v0.1-gate.md`, 17/17) rolled up every phase's criteria at the end.

---

## 11. Explicit change inventory — new vs. modified

### New files/packages
- `packages/git/` (new workspace package)
- `packages/docker/` (new workspace package)
- `packages/domain/src/deployment/deployment-state.ts` (+ test)
- `packages/domain/src/deployment/*` (Deployment/Project/Environment/Service validators)
- `packages/domain/src/service/derive-service-status.ts`
- `packages/domain/src/validators/docker-naming.ts`, `packages/domain/src/validators/git.ts`
- `packages/ssh/src/commands/git.ts`, `packages/ssh/src/commands/docker-build.ts` (parameterized templates)
- `packages/ssh/src/exec-streaming.ts`
- `apps/control-plane/src/db/schema/projects.ts`, `environments.ts`, `services.ts`, `deployments.ts`, `deployment-log-chunks.ts`
- `apps/control-plane/src/db/migrations/0004_*.sql` (and onward)
- `apps/control-plane/src/queue/deploy-service-queue.ts`, `deploy-worker.ts`, `deploy-job-budget.ts`, `reconcile-servers-job.ts`
- `apps/control-plane/src/events/service-event-publisher.ts`, `deployment-event-publisher.ts`
- `apps/control-plane/src/routes/{projects,environments,services,deployments}.ts` + matching `*-schemas.ts`
- `apps/control-plane/src/services/{project,environment,service,deployment}-services.ts` (create/edit/delete/triggerDeploy/cancelDeployment)
- `apps/web/src/app/(shell)/projects/**` (new route tree, §8.1)
- `apps/docs/`, `apps/site/` (new apps)
- `.github/workflows/public-site.yml`

### Modified files
- `packages/ssh/src/commands/index.ts` — extend `CommandName` union with new allowlist entries.
- `packages/ssh/src/commands/allowlist.ts` — `COMMAND_TEMPLATES` gains parameterized entries (still closed-set, now some are functions).
- `apps/control-plane/src/db/schema/index.ts` — barrel exports for the 5 new tables.
- `apps/control-plane/src/db/schema/servers.ts` — no column change, but `delete-server.ts` (service) gains the "no active services" guard (§1.2).
- `apps/control-plane/src/events/sse-broadcaster.ts` — `KNOWN_EVENT_TYPES` extended (§7.2).
- `apps/control-plane/src/env.ts` — new env knobs (§3.4).
- `turbo.json` — new `passThroughEnv` entries in `dev`/`dev:worker`; possibly a new `boundaries` tag if `packages/docker`/`packages/git` need one distinct from `ssh-adapter` (recommend folding them into the existing `ssh-adapter` tag rather than inventing a new one, since their sole allowed dependency is exactly `ssh-adapter` + `pure-domain`, matching that tag's existing `allow` list verbatim).
- `apps/web/src/app/(shell)/` sidebar/nav component — hierarchical restructuring (§8.2).
- `docker-compose.yml` — **not modified** for docs/site (§9.4); may need `NOODARA_DEPLOY_*`/`NOODARA_RECONCILE_INTERVAL_MS` env passthrough for `api`/`worker` services once those knobs exist.
- `CLAUDE.md` §4 — add `DeploymentLogChunk` to the named entity list (currently missing, §1.1).

### Security-relevant call-outs (per CLAUDE.md §2.3 / noodara-security skill)
- Every new SSH command argument (repo URL, branch, image/container name, port) is **validated by a domain type before being shell-escaped** — never escaped-only (escaping alone stops shell injection but not, e.g., a container name that collides with an existing unrelated container). Never on argv directly for anything secret-bearing — private Git repo credentials (roadmap §7.3: "Manejar repos privados mediante credencial segura") must reuse the existing `SecretValue`/encrypted-credential pattern (`credentials` table, `envelope.ts`) and be injected via an SSH `askpass` helper or a short-lived credential file on the target server (cleaned up in the same §6.4 cleanup path), **never** embedded in the `git clone` command string itself, which would otherwise leak into shell history/`ps` output on the target server exactly as the existing `docker.ts` comment already warns against for Redis passwords.
- Deployment log chunks pass through the same `Redactor` as every other SSH-sourced text in this codebase, per-chunk, before persistence — a secret accidentally printed by a broken Dockerfile/build script must not survive into `deployment_log_chunks` or the SSE stream unredacted.
- Timeouts: `NOODARA_DEPLOY_TIMEOUT_MS` bounds the whole deploy job the same way `discoveryMs` bounds `runDiscovery`; `NOODARA_RECONCILE_INTERVAL_MS`'s own poll still uses the existing per-command `commandMs` timeout — no new unbounded remote operation is introduced anywhere in this design.
- Cleanup runs on every failure path (§6.4), not just success — satisfies CLAUDE.md §2.2's "ningún fallo de infraestructura... tumba la API" and roadmap §7.8's explicit "no orphan resources" acceptance criteria.

## Sources

- Direct code reading (all file paths cited inline above): `apps/control-plane/src/**`, `packages/ssh/src/**`, `packages/domain/src/**`, `docker-compose.yml`, `turbo.json`, `pnpm-workspace.yaml`.
- `docs/roadmap-v0.1-v0.5.md` §7 (v0.2 scope) and §8.1–8.2 (v0.3 Deployment entity/state machine, used to derive the v0.2-forward-compatible subset).
- `docs/adr/0004-ssh-adapter-empirical-contracts.md` (measured `ssh2` error/timeout/mid-exec-death behavior — informs the streaming-exec cancellation design in §4.3).
- `docs/adr/0006-web-app-same-origin-proxy-and-ports.md` (informs §9.1's decision to keep docs/site off the same-origin proxy topology).
- `docs/ui-build-prompt.md` §2.4–§2.6, §3.1 (three-panel constraint, existing SSE resync contract, current nav inventory).
- `.planning/PROJECT.md` (current milestone scope, target feature ordering, validated v0.1 decisions).

---
*Architecture research for: Noodara v0.2 Projects & Services*
*Researched: 2026-09-22*
