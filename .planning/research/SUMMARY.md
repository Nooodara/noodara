# Project Research Summary — v0.2 Projects & Services

**Project:** Noodara
**Domain:** Self-hostable, AI-native PaaS control plane — milestone v0.2 adds a remote Docker/Git deploy engine over the existing SSH-only control plane, plus brand identity, an app-wide UI redesign, editable settings, a public docs site and landing page, and v0.1 operator hardening
**Researched:** 2026-09-22
**Confidence:** HIGH overall (architecture and pitfalls are grounded in the shipped v0.1 code; stack versions verified against npm/Context7; competitor behavior verified against official docs and issue trackers). MEDIUM on two mechanics that need an empirical spike before implementation: how a secret reaches the remote host without touching argv, and how a remote `docker build` is actually killed on cancel.

Inputs: `STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md`, `.planning/PROJECT.md` (Current Milestone: six target features in a user-decided order), `docs/ui-build-prompt.md` §3.3/§5.3/§8/§9 (the UI brief the redesign follows).

## Executive Summary

v0.2 is two milestones wearing one number. The first half is product surface: a brand kit, a redesign of the existing app against `docs/ui-build-prompt.md` (floating elevation, materials, purposeful motion, `RowMenu` fixes, reduced-motion/transparency/contrast fallbacks, and the first time a human ever looks at a rendered screen), editable admin settings, and a public docs site plus landing page. The second half is the first real deploy engine: Project → Environment → Service, deploy from Git/Dockerfile/image on the server connected in v0.1, streamed build logs, runtime logs, real container state, cancel with cleanup, and zero orphaned resources after 20 cycles. The user has fixed the order — identity → UI redesign → settings → docs/landing → projects/services → hardening — so that every new screen is born in the final visual language. Research confirms this order is sound and, crucially, that the deploy engine's backend has no dependency on the product-surface track, so the two can interleave without blocking each other.

The recommended approach is deliberately conservative on dependencies and aggressive on invariants. Nothing new is installed for Docker or Git: every operation is a new entry in `packages/ssh`'s closed command allowlist, now with parameterized templates whose arguments are domain-validated (branded types) and then `escapeShellArg`-quoted — the first user-controlled strings ever passed to a remote shell in this codebase. Long-running builds get a new streaming exec primitive (chunked, per-chunk redacted, bounded, cancellable) next to the existing whole-buffer `execWithTimeout`, a second BullMQ queue keyed by `deploymentId`, a Postgres partial unique index as the real "one deploy per service" guard, append-only log chunks in Postgres with a `since=<seq>` resync, and the existing single SSE stream extended with four event types. Only three new dependencies are recommended for the whole milestone: `fumadocs-core`/`fumadocs-ui` for the docs site and `motion` for the Sheet's gesture spring, all peer-compatible with the pinned Next 16.3.5 / React 19.3.0.

The risks are the ones competitors visibly get wrong. Dokploy ships a cancel button that does not stop in-progress builds and containers stuck "Running" forever; Coolify fills disks with build cache and orphaned containers. Every one of those maps to a v0.2 acceptance criterion, and every one is prevented by the same discipline: cleanup on every exit path (success, failure, cancel, worker crash), a remote kill that is confirmed before the local channel is destroyed, a reconciliation loop that keeps the UI honest, and timeouts that distinguish "slow but alive" from "hung". The security bar is unchanged from v0.1 and now applies to a bigger surface: no secret on argv, in a URL, in a log, in `docker history` or `docker inspect`; every log chunk through the Redactor before persistence or broadcast; a canary in `security:scan-leaks` for each new vector.

## Key Findings

### Recommended Stack

Detailed in `STACK.md`. The headline is what is *not* added: no `dockerode`/`docker-modem` (would open a second, independently authenticated ssh2 connection per server outside the TOFU verifier, mutex, redaction and timeout wrapper, and replace the closed allowlist with an open Engine API), no `simple-git`/`isomorphic-git`/`nodegit` (Git runs on the remote host, not the control plane), no new pub/sub transport (Redis pub/sub → SSE is already load-bearing), no object storage for logs.

**Core technologies:**
- `@noodara/ssh` + `ssh2 1.17.0` (existing): Docker and Git CLI execution on the remote host — reuses the audited pipe (one TOFU-verified connection per server, mutex, redaction, timeouts); allowlist grows from 11 fixed templates to ~24 templates, some parameterized.
- `fumadocs-core` + `fumadocs-ui` `16.15.13` (+ `fumadocs-mdx` `15.4.3` dev): public docs site — Next.js-native, peer deps `next: 16.x.x` / `react: ^19.2.0` match the repo exactly; MDX, Orama search, Tailwind v4 plugin; reuses `packages/ui` tokens.
- `motion` `13.4.1` (import `motion/react`, scoped with `LazyMotion`): the Sheet drag-to-dismiss spring that the UI brief §7.4 specifies (pointer capture, rubber-banding, momentum projection, interruptible) — CSS transitions cannot do interruptible spring gestures; everything else in the redesign stays CSS per brief §5.3.
- Test infrastructure, no new package: a **new combined Testcontainers image** (sshd + real `dockerd`, network-attached, based on the existing `sshd-ubuntu-22.04/24.04` images) and a bare Git repo fixture reachable over SSH with per-run generated deploy keys. The existing installer DinD fixture is explicitly the wrong shape for this (zero-registry by design).
- Fixtures `fixtures/node-api`, `fixtures/static-app`, `fixtures/failing-build`: dependency-free (`node:22-slim` + built-in `http`, `nginx:alpine`, a broken `RUN`), each with a real `.dockerignore`.

### Expected Features

Detailed in `FEATURES.md` (competitors: Coolify, Dokploy, Railway, Render, Fly.io, Kamal).

**Must have (table stakes), all P1 for v0.2:**
- Project → Environment → Service hierarchy with ownership that never crosses projects; environment names suggested (`production`/`staging`/`development`), not enforced.
- Service from Git repo (branch, build context, Dockerfile path), from Dockerfile, from Docker image; private repos via SSH deploy key stored through the existing encrypted-credential envelope.
- Manual deploy trigger + deploy history; redeploy = new attempt from the current source ref.
- Build logs streamed live, timestamped, persisted after completion; runtime logs separate (basic tail, no search until v0.5).
- Failed build never replaces the running container; error surfaced as a closed-vocabulary code with copy (`GIT_CLONE_FAILED`, `GIT_AUTH_FAILED`, `BRANCH_NOT_FOUND`, `DOCKERFILE_NOT_FOUND`, `BUILD_FAILED`, `BUILD_TIMEOUT`, `BUILD_STALLED`, `IMAGE_PULL_FAILED`, `PORT_IN_USE`, `WORKER_CRASHED`, …), never raw server text (brief §9 #17).
- Cancel — queued **and** in-progress — with no temporary resources left behind; stop/restart/remove container; real container state in UI/API.
- Editable admin profile (name, email, password; password change signs out other sessions); appearance settings (theme auto/light/dark with persistent override, reduced motion, density).
- Public docs site (install → concepts → first deploy → reference per source type/operation → troubleshooting by error code) and landing page, both carrying the new identity.

**Should have (differentiators, cheap because they reuse v0.1 patterns):**
- Narrated deploy timeline (queued → cloning → building → starting → running, each step with pass/fail and duration) — the discovery-narration treatment applied to deploys; no competitor does this.
- Cancel that actually kills the remote build (Dokploy #2757, #390 are open requests for exactly this).
- Deterministic state reconciliation — Noodara never needs `docker restart` of itself to unstick a deploy (Dokploy #4461, #2670, #4271, #508, #2106).
- Classified build failures with actionable copy, extending the v0.1 SSH error-code discipline.

**Defer:**
- v0.3: webhooks/auto-deploy, recurring healthchecks, rollback, full 10-state deployment machine. v0.4: env vars/secrets on services, domains/HTTPS/Traefik. v0.5: log search/filter. Never (through v0.5): template marketplace, Compose-as-Service, auto-retry of failed builds. **No placeholder UI for any of these** (brief §9 #19); the first-deploy guide must state plainly that v0.2 has no env vars and no domains.

### Architecture Approach

Detailed in `ARCHITECTURE.md`. v0.2 is four additions at seams v0.1 already built for this, not a new subsystem: (1) `packages/domain` gains a `Deployment` state machine copied from `server-state.ts`'s pattern plus validators for Docker names, Git refs and workspace paths; (2) `packages/ssh` gains parameterized, escaped templates and `exec-streaming.ts`; (3) `apps/control-plane` gains a `deployments` queue, a reconciliation repeatable job, four route files, and four SSE event types on the existing `GET /api/events`; (4) `apps/web` gains a hierarchical nav and its first real inspector-panel content (the live deployment log) via a Next.js parallel route. Two new thin packages (`packages/git`, `packages/docker`, tagged `ssh-adapter`) and the public site app(s) (`apps/site`, and `apps/docs` only if D2 splits them) round it out.

**Major components:**
1. **Domain (pure):** `Project`, `Environment`, `Service`, `Deployment` (v0.3's full column set, nullable where unused), `DeploymentLogChunk` (append-only; add to `CLAUDE.md` §4); `deployment-state.ts` with 7 states — `QUEUED PREPARING BUILDING DEPLOYING SUCCESS FAILED CANCELLED` — chosen so v0.3 only *adds* `HEALTHCHECK`, `ROLLING_BACK`, `ROLLED_BACK`; `deriveServiceStatus()` as a pure function (`NEVER_DEPLOYED | DEPLOYING | RUNNING | STOPPED | FAILED | UNKNOWN`), not a second FSM; branded `RepositoryUrl`, `DeployWorkspacePath`, `ContainerName`, `ImageRef`.
2. **Schema:** `services.project_id` denormalized with a composite FK `(environment_id, project_id) → environments(id, project_id)` so cross-project ownership is impossible at the database; partial unique index `deployments(service_id) WHERE status IN (non-terminal)` as the real concurrency guard; `delete-server.ts` refuses while services reference the server.
3. **Remote execution:** allowlist entries `git.clone`, `git.checkout`, `docker.build/pull/create/start/stop/restart/remove/inspect/logs/ps`, `fs.remove_deploy_dir`; workspace `/opt/noodara-deploy/<deploymentId>/` (a distinct namespace so a self-managing single VPS never builds inside `/opt/noodara/`); container `noodara-<serviceId>`, network `noodara-net-<serviceId>`, image tag `noodara/<serviceId>:<deploymentId>`; streaming exec with per-chunk Redactor, bounded bytes, `AbortSignal`, distinct `DeploymentCancelledError`.
4. **Queue/worker:** `deploy-service` job, `jobId = deploy-<deploymentId>`, own `deploy-job-budget.ts` and `NOODARA_DEPLOY_CONCURRENCY`; cooperative cancel via Redis key `noodara:deploy-cancel:<deploymentId>` (TTL = lock duration) that only the worker acts on; cleanup on every exit; startup sweep marks abandoned deployments `FAILED/WORKER_CRASHED`; repeatable `reconcile-servers` job (one `docker ps --all --format json` per connected server with services per tick).
5. **API + SSE:** `routes/{projects,environments,services,deployments}.ts` with strict Zod schemas under the existing `/api` guarded scope; `POST /api/services/:id/deploy` (409 `DEPLOYMENT_IN_PROGRESS` on index violation), `GET /api/deployments/:id/log?phase&since`, `POST /api/deployments/:id/cancel` (200, idempotent); SSE types `service.updated`, `service.deleted`, `deployment.updated`, `deployment.log_chunk`; no `project.*`/`environment.*` events in v0.2.
6. **Web:** `(shell)/projects/[projectId]/environments/[environmentId]/services/[serviceId]` + `@inspector` parallel route; nav shows Projects as a hierarchical subtree with Servers/Activity/Settings as peers (Server is a peer reference, not a container); log viewer follows the existing GET-snapshot + SSE-fold, no-replay contract (brief §2.4).
7. **Public sites:** statically buildable with zero control-plane dependency; boundary test forbidding imports from `apps/control-plane`/`@noodara/domain`; a separate path-filtered `public-site.yml` workflow, never in `docker-compose.yml` or `release.yml`.

### Critical Pitfalls

Detailed in `PITFALLS.md` (18 pitfalls, phase-mapped). The five that shape the design:

1. **Orphaned containers/images/networks/build cache (P1) and zombie remote processes on cancel (P2)** — treat every deploy attempt as a resource ledger: record each resource *before* the command that creates it; cleanup walks the ledger on every exit (success, failure, cancel, crash). Cancel is a two-step protocol: kill the remote process and confirm it is gone, *then* destroy the local channel — `channel.destroy()` alone leaves `docker build` running on the VPS. Verify the 20-cycle test with `docker system df` before/after, twice in a row, with no manual prune, against the real sshd+dockerd fixture.
2. **Secrets leaking through build args, `docker inspect`, clone URLs, or log lines (P3)** — v0.2 accepts no `--build-arg` and no runtime env (both v0.4), which structurally closes vectors 1 and 2 for now; tokens/keys never in URLs or argv; every log chunk through the Redactor per chunk; extend `security:scan-leaks` with canaries for git-URL token, deploy key, registry password, and a build that `echo`es a secret.
3. **Log streaming blowing memory/Redis; stale container state (P4, P5)** — a separate bounded pipeline (flush cadence, per-phase byte cap, per-line cap, ANSI strip for persistence, UTF-8-safe truncation via `trimIncompleteUtf8Tail`), Postgres as source of truth with `since=<seq>` resync; UI reconciliation through a pure `reconcileDetailSnapshot`-style function keyed by `seq`/`updatedAt`, never last-write-wins by arrival.
4. **Concurrent deploys and fixed timeouts (P6, P11)** — DB partial unique index + `deploy-<deploymentId>` job id; two timeouts (hard max and no-output idle) with distinct error codes, and BullMQ lock duration derived from the hard max so a 40-minute build is never reaped as "stalled".
5. **Redesign regressions: contrast, keyboard animation, `backdrop-filter` budget, the 93 E2E tests, theme flicker (P13–P17)** — re-measure contrast per surface touched by `--shadow-floating`/vibrancy in both themes; overlay close handlers branch on trigger source (keyboard = no animation, brief §9 #10); count simultaneous `backdrop-filter`s against the 3–5 budget; run the full E2E suite after every component change and update selectors in the same plan; the new Settings theme control must call the one write path `ThemeToggle` owns.

## Resolved Disagreements

The four documents mostly agree; where they do not, the synthesis takes a position.

| Topic | STACK | FEATURES | ARCHITECTURE | PITFALLS | Resolution |
|---|---|---|---|---|---|
| Docs framework | Fumadocs 16.15.13 | — | left open; only constraint: static, no control-plane dependency | — | **Fumadocs.** It satisfies ARCHITECTURE's constraint (static Next.js export, no runtime dep) inside the existing toolchain, shares `packages/ui` tokens, and is peer-exact with the pinned Next/React. Astro/Starlight/VitePress would add a second framework and a second design-system port. |
| Container state | — | demands an explicit poll-vs-events decision | periodic `docker ps` poll (30 s repeatable job); `docker events` rejected | "polling as primary mechanism: never; acceptable only as the SSE resync's data source" | **Poll on the server side, events on the client side — these are compatible.** The worker polls `docker ps --format json` per connected server (one exec per server per tick) as the *drift detector*; it emits `service.updated` over SSE only on change; the browser never polls the API — it keeps the GET-snapshot + SSE-fold contract. The deploy worker itself does short backed-off `docker inspect` polls right after `docker start` on the same connection for immediate SUCCESS/FAILED. `docker events` over a permanently open SSH channel per server is rejected: `packages/ssh` is "connect, run N short commands, close", and N always-open channels need reconnect/backoff bookkeeping v0.2 does not have. Revisit with the Agent. |
| Log persistence | "bounded text column per row" | logs persist after completion | `deployment_log_chunks` append-only table | persist separately from broadcast; resync via GET | **Chunks table.** A growing text column rewrites the full row (TOAST) on every append of a multi-MB log; chunks give `since=<seq>` resync for free and mirror `activity_events`' single-insert discipline. |
| Runtime logs | "runtime-log stream" | "basic tail" | chunks with `phase: 'runtime'` under a deployment | bound everything | **Runtime logs are read on demand from Docker, not persisted in v0.2.** Docker's `json-file` driver already retains them; copying them into Postgres doubles disk on a 1–2 GB VPS. `docker.logs --tail N --timestamps` (bounded) for the snapshot, a follow stream with a max duration while a client is viewing, and `--log-opt max-size/max-file` on `docker create` so the driver's own retention is bounded. `phase` stays on the chunks table for build logs only. Decision D8. |
| Cancel mechanics | — | must work mid-build | Redis flag → streaming `abort()` → `channel.destroy()` → cleanup → `CANCELLED` | destroying the channel does not kill the remote process | **Both, in this order:** Redis flag → worker sends an allowlisted remote kill → confirms the process is gone → destroys the channel → walks the cleanup ledger → transitions to `CANCELLED`. The kill mechanism itself needs a spike (Gap G2). |
| Concurrency guard | — | one deploy in flight per service | partial unique index + `jobId = deploy-<deploymentId>` | BullMQ dedupe on `deploy-<serviceId>` + row lock | **Index + `deploy-<deploymentId>`.** ARCHITECTURE's reasoning wins: a Deployment is the history row, so the job must be 1:1 with it; "cancel this deployment" stays unambiguous; the per-service invariant lives in the database, not in BullMQ dedupe. The v0.1 lesson about retained terminal jobs does not recur because a deployment id is never re-enqueued. A `SELECT … FOR UPDATE` on the service inside `triggerDeploy` is fine belt-and-braces, but the index is what is load-bearing. |
| Cleanup bookkeeping | — | — | job-local "container was created" flag; startup sweep does not SSH blind | persisted resource ledger, never `docker ps --filter` heuristics | **In-job ledger + deterministic names.** Because every resource name is derived from validated ids (`/opt/noodara-deploy/<deploymentId>`, `noodara/<serviceId>:<deploymentId>`, `noodara-<serviceId>`, `noodara-net-<serviceId>`), the crash-recovery sweep can safely remove *per-deployment* resources (workspace dir, image tag) without a persisted ledger, but must never touch the *per-service* container (it may be the previous healthy one). No extra table. |
| Timeouts | new streaming duration cap | — | one `NOODARA_DEPLOY_TIMEOUT_MS` | hard max + progress-aware idle timeout, distinct errors | **Two knobs:** `NOODARA_DEPLOY_MAX_MS` and `NOODARA_DEPLOY_IDLE_MS`; error codes `BUILD_TIMEOUT` vs `BUILD_STALLED`; BullMQ lock duration derived from the hard max. |
| Private Git auth over HTTPS | `GIT_ASKPASS` reading an env var | SSH deploy key is the convergent competitor pattern | askpass helper or short-lived credential file | `-c http.extraHeader` (escaped argv) | **SSH deploy key first; HTTPS token via an askpass helper reading a mode-600 file on the remote — never `extraHeader` on argv, never `https://token@`.** An escaped argv token still shows in `ps`. Note: an env var over ssh2's `exec({ env })` is only honored if `sshd` `AcceptEnv` allows it (Ubuntu default: `LANG LC_*` only), so env injection cannot be assumed either — see Gap G1. |
| Multi-stage Dockerfile | — | — | — | require `--target` when >1 `FROM`, fail fast | **Optional `target` field, Docker's default (last stage) when absent, no fail-fast.** The last stage is what almost every multi-stage Dockerfile intends; forcing a target on every one is friction with no safety gain. Decision D9. |
| Build order | — | — | domain → ssh primitives → queue → API → web → fixtures/E2E → hardening; identity/redesign as a parallel "Phase 0" | pitfalls mapped to "deploy engine", "UI redesign", "settings", "docs/landing" phases | **The user's order stands; the engine's internal order nests inside it as three phases; the engine's backend phases may interleave with the surface track.** See "Implications for Roadmap". |

## Security Invariants (front and center)

These are not phase deliverables; they are review-blocking conditions on every plan in the engine phases, per `CLAUDE.md` §2.3 and the `noodara-security` skill.

1. **First user-controlled shell arguments.** Repository URL, branch, build context path, Dockerfile path, target stage, image reference, internal port. Each is (a) validated by a domain validator into a branded type (`RepositoryUrl`, `GitRef`, `DeployWorkspacePath` = exactly `/opt/noodara-deploy/<uuid>`, `ContainerName`, `ImageRef`, `Port`), then (b) passed through `escapeShellArg`, then (c) inserted only into a closed template from the allowlist. The allowlist stays closed: ~24 fixed shapes, dynamic *arguments*, never a dynamic *command*. `git clone` uses `--` before positional args. No template ever takes a raw `string`.
2. **No secret on argv, in a URL, in an env var over SSH, in a log, in `docker history`, in `docker inspect`, in `.git/config`.** Deploy keys, HTTPS tokens and registry passwords are decrypted only in memory on the control plane, transferred to a mode-600 file on the remote for the duration of one command (mechanism: Gap G1), used via `GIT_SSH_COMMAND`/askpass/`docker login --password-stdin`, and deleted in the same cleanup path as the workspace. v0.2 has no `--build-arg` and no `--env`; when v0.4 adds them they go through BuildKit `--secret` mounts and `--env-file`, never argv. Verify BuildKit is the active builder as part of discovery (extend `discovery.docker_version`), do not infer it from the version number.
3. **Every log chunk through the Redactor before anything downstream** (persistence, Redis, SSE, activity metadata, error messages). Raw Docker/Git stderr never reaches an API response or the UI: `classifyGitError` and `classifyDockerError` are frozen, ordered, never-throwing tables mirroring `classifySshError`.
4. **Cooperative cancel that kills the remote process.** Redis flag → remote kill (allowlisted) → confirmed exit → local channel destroyed → cleanup → `CANCELLED`. Proven by an integration test that asserts the process is gone on the remote (`ps`), not that the local promise rejected.
5. **Cleanup on every failure path.** Success, `FAILED`, `CANCELLED`, timeout, stalled, worker crash, API restart: workspace dir, per-attempt image tag, half-created container and network are removed; the previous healthy container is never touched by a failed attempt. `fs.remove_deploy_dir` is idempotent and only ever accepts a validated `DeployWorkspacePath`.
6. **Timeouts everywhere, in two kinds.** Tight per-command budgets (existing `commandMs`) for short commands (`ps`, `inspect`, `rm`); hard max + idle timeout for builds, pulls and clones; a max duration on any follow stream; TTL on the Redis cancel key; the reconcile tick uses `commandMs`. No new unbounded remote operation exists anywhere in the design.
7. **Backend enforces every restriction.** A service cannot be created against a server that is not `CONNECTED` with Docker present; ownership cannot cross projects (composite FK); a second deploy is a 409 (partial index); deleting a server with services is refused; deleting a service removes its container, network, images, and any credential it owns.
8. **Canaries.** `pnpm security:scan-leaks` gains: git-URL token, deploy key material, registry password, a fixture build that prints a canary — asserting absence in build logs, `deployment_log_chunks`, SSE, `activity_events.metadata`, API responses, `docker inspect`, `docker history`, `.git/config` on the fixture host.

## Numbers That Are Reasoned Defaults (measure during implementation)

v0.1 measured its memory limits instead of guessing them; the same applies to every number below. Each becomes an env knob with range validation in `env.ts`, declared in `turbo.json` `passThroughEnv` (ADR 0003), and gets a measurement recorded in the phase's verification.

| Knob / constant | Default proposed | Where it comes from | What to measure |
|---|---|---|---|
| Log flush cadence (worker → Postgres → Redis) | 250 ms or 16 KB, whichever first | stay well under `SSE_MAX_BUFFERED_BYTES = 1 MiB` per connection | SSE eviction count and Redis pub/sub throughput on a fixture that logs continuously for minutes; API RSS over a 10-minute build |
| `NOODARA_DEPLOY_LOG_MAX_BYTES` (per phase) | 10 MiB | order of magnitude above a real `npm install` log; bounded | size distribution of the three fixtures' build logs; Postgres growth after 20 deploys |
| Per-line cap before persistence | 16 KB, UTF-8-safe truncation | `trimIncompleteUtf8Tail` precedent; minified-JS one-liners | longest line observed in fixture builds |
| `NOODARA_RECONCILE_INTERVAL_MS` | 30 s | one connect + one exec per server per tick | SSH connect cost on a 1–2 GB VPS; drift-detection latency the UI review finds acceptable |
| `NOODARA_DEPLOY_MAX_MS` | 60 min | Pitfall 11 ("a build that takes 40 minutes") | none of the fixtures should approach it; confirm the lock-duration derivation never lets BullMQ reap a live build |
| `NOODARA_DEPLOY_IDLE_MS` | 5 min without output | distinguishes hung from slow | idle gaps in a `docker pull` of a large base image on a slow VPS uplink |
| `NOODARA_DEPLOY_CONCURRENCY` | 1 per worker (v0.2) | builds are heavy; single-VPS audience | worker memory while streaming; revisit when multi-server is real |
| Redis cancel key TTL | = deploy job lock duration | orphan flags must expire | none beyond confirming expiry |
| `docker create --log-opt max-size / max-file` | 10m / 3 | bounds Docker's own runtime-log retention on disk | disk after 20 deploys of `node-api` under load |
| Runtime log tail (`docker logs --tail`) | 1000 lines | UI viewport plus scrollback | render cost in the inspector |
| Follow-stream max duration | 10 min, then client resubscribes | bound every remote stream | reconnect UX in the log viewer |
| Post-start `docker inspect` polls | 5 polls, 1 s → 8 s backoff | prompt SUCCESS/FAILED without the reconcile tick | time-to-RUNNING for `node-api` and `static-app` |
| Build-context budget per fixture | < 1 MiB with `.dockerignore` | Pitfall 8 | measured context size asserted in tests |
| Simultaneous `backdrop-filter`s per screen | ≤ 3 (budget is 3–5) | brief §4.3, §5.3 | worst case: toolbar + Sheet + RowMenu-in-Sheet + Tooltip, on real mobile hardware |
| Discovery/list stagger | 40 ms | brief §8.2 item 10 | keep; already specified |

## Implications for Roadmap

The user's decided order is honored as the phase sequence. The deploy engine (target feature 5) is too large for one phase and has an internal dependency order (domain → remote execution → queue/API → UI/E2E); it is split into three phases. The backend engine phases touch `packages/domain`, `packages/ssh`, `packages/git`, `packages/docker`, `apps/control-plane` only; the surface phases touch `packages/ui`, `apps/web`, `apps/site`, brand assets. They share no files and no CI gate beyond the global ones, so the roadmapper may schedule Phase 5 (and 6) to start while Phases 2–4 are in flight, if the user wants the wall-clock benefit — without ever changing the order in which features *close*.

### Phase 1: Identity & brand kit
**Rationale:** First by user decision; every later surface (app chrome, README, docs, landing, favicon, OG images) consumes it. Pure design work with no code dependency.
**Delivers:** Monogram, wordmark, favicon set, OG image, color/typography application rules in both themes; applied to `apps/web` shell, README, and exported as assets/tokens in `packages/ui` for the public sites.
**Addresses:** "Brand identity" (FEATURES, listed first in PROJECT.md).
**Avoids:** brief §9 #1/#3/#6 (one action color, no gradients, no glow) — the brand must obey the same prohibitions as the UI.
**Research flag:** none (design task; use the local design-reference library and `noodara-ux-apple`).

### Phase 2: UI redesign (brief §8 P0 → P1 → P2) + structural groundwork for v0.2 screens
**Rationale:** So that Projects/Services screens are built once in the final visual language. Must also lay the *generic* shell pieces ARCHITECTURE §8 needs later — hierarchical nav (expand/collapse, 1280/900 px breakpoints), the `@inspector` third-panel slot, the account menu — without placeholders: they ship populated with what exists today (Servers, Activity, Settings) and gain Projects in Phase 7.
**Delivers:** `--shadow-floating` on Sheet/Dialog/RowMenu; `RowMenu` fixed (close on select, focus return, visible trigger on touch, stable keys) *before* it is reused on any new list; `prefers-reduced-transparency`/`prefers-contrast` fallbacks; first human visual review with screenshots in both themes; Sheet drag-to-dismiss on `motion` (scoped `LazyMotion`, only `packages/ui`'s Sheet); press feedback, custom easings, scroll-edge toolbar, anchored `transform-origin`, staggered discovery checks; tabular numerals, `text-wrap`, themed browser surfaces, blur crossfades, `Disclosure` grid rows, `@starting-style`, `clip-path` disk meter.
**Uses:** `motion@13.4.1`.
**Avoids:** P13 (re-measure contrast per surface, both themes, generalize `contrast.ts`'s token loop), P14 (no animation on keyboard-initiated actions — branch on trigger source in the component API), P15 (`backdrop-filter` count), P16 (run all 93 E2E after every component change; update selectors in the same plan; add a static gate for test-id renames).
**Exit gate:** full `pnpm test:e2e` + nightly 20x repeat green; contrast measured; human review signed.
**Research flag:** light — one Context7 check of `motion` drag/`useSpring` API against brief §7.4's behaviors; everything else is specified by the brief.

### Phase 3: Editable settings
**Rationale:** Small, builds on Phase 2's components and on v0.1's Better Auth; unblocks nothing downstream but is the user's third feature.
**Delivers:** Admin profile edit (name, email, password → revoke other sessions), appearance settings (theme auto/light/dark with persistent override, reduced motion, density) persisted server-side on the user and mirrored for first paint; activity events for profile changes without sensitive metadata.
**Addresses:** FEATURES table stakes "editable admin profile", "appearance settings".
**Avoids:** P17 (the new theme control calls the one write path `ThemeToggle` owns; first-paint no-flash reload test against the *new* path); brief §9 #16 (never show a credential, not even masked).
**Research flag:** light — verify Better Auth's `changePassword`/`changeEmail`/`revokeOtherSessions` shapes with Context7 during planning; otherwise standard CRUD.

### Phase 4: Public docs site + landing page
**Rationale:** Fourth by user decision; needs Phase 1's identity and Phase 2's tokens; independent of the engine except that the first-deploy guide describes what Phase 5–7 will ship (write it against the requirements, and make the accuracy test enforce it once the feature lands).
**Delivers:** `apps/site` (landing at `/`, Fumadocs docs at `/docs` — see D2), static export, `public-site.yml` path-filtered workflow, boundary test (no imports from control plane/domain), docs shape: Get started (install command) → Concepts (Project/Environment/Service/Server, diagrammed) → First deploy → Reference (per source type, per operation) → Troubleshooting (error-code table); landing leads with "Your infrastructure, understood" and claims only shipped capability.
**Uses:** `fumadocs-core`/`fumadocs-ui` `16.15.13`, `fumadocs-mdx` `15.4.3`.
**Avoids:** P18 (extend `install-docs-accuracy.test.ts`'s pattern: landing claims diffed against PROJECT.md's Out of Scope; documented CLI flags/commands extracted from the real `noodara` CLI; documented error codes extracted from the real classifier tables).
**Research flag:** yes, light — Fumadocs 16 + Next 16 + Tailwind v4 token sharing with `packages/ui`, and static-export constraints (Orama search in static mode); hosting/domain decision D2.

### Phase 5: Deploy engine foundation (backend only; may interleave with Phases 2–4)
**Rationale:** Everything in the engine depends on validated domain types, the schema, the parameterized allowlist, the streaming exec, and — critically — the new test fixture. PITFALLS 12 says the sshd+dockerd fixture must exist *before* the first Docker-operations integration test is written; this phase is where TDD on the engine becomes possible.
**Delivers:** `packages/domain`: Project/Environment/Service/Deployment validators, `deployment-state.ts` (7 states, exhaustive transition tests ≥95%), `deriveServiceStatus`, `docker-naming.ts`, `git.ts` (branded types). Schema + migration 0004: five tables, composite ownership FK, partial unique index, enum from `DEPLOYMENT_STATUSES`. `packages/ssh`: parameterized templates behind `escapeShellArg`, `exec-streaming.ts` (chunked, redacted, bounded, abortable, stdin-capable for `--password-stdin` and file transfer), remote-kill primitive (per Gap G2 spike), `classifyGitError`/`classifyDockerError`. `packages/git`, `packages/docker` (thin, typed, tagged `ssh-adapter`). Test infra: combined sshd+dockerd Testcontainers image (22.04 and 24.04), bare Git repo fixture with per-run deploy keys, the three official fixtures with `.dockerignore` and context-size assertions.
**Addresses:** roadmap §7.2/§7.3 operations at the unit and integration level.
**Avoids:** P3 (branded types before escaping; credential transfer never via argv), P7 (shallow `--depth 1`; LFS pointer and submodule detection → named errors; branch-not-found vs unreachable vs auth-failed), P8 (context size measured), P10 (collision tests written before the naming scheme), P12 (fixture first).
**Research flag:** **yes — the milestone's one real research phase.** Spikes needed before planning locks: G1 (secret transfer to remote host without argv: stdin to an allowlisted `umask 077; cat > <validated path>` vs ssh2 SFTP subsystem), G2 (remote kill: `channel.signal()` support in Ubuntu's OpenSSH 8.9/9.6 vs `setsid` + pidfile + `kill -- -pgid` vs `docker kill` of the BuildKit container; record as an ADR-0004-style empirical contract), G3 (BuildKit default on the apt-repo Docker `install.sh` provisions; `docker buildx` availability), G4 (`docker ps --format '{{json .}}'` field stability for the reconcile parser across Docker versions on 22.04/24.04).

### Phase 6: Deploy engine runtime — queue, worker, reconciliation, API, SSE (backend only)
**Rationale:** Needs Phase 5's primitives; produces the API the UI wires in Phase 7. Still no UI dependency, so it may also interleave with Phases 2–4.
**Delivers:** `deployments` queue, `deploy-service` job (`deploy-<deploymentId>`), `deploy-job-budget.ts`, cooperative cancel (Redis flag → remote kill → confirm → destroy → cleanup → `CANCELLED`), in-job resource ledger, cleanup on every exit, startup sweep (`WORKER_CRASHED`), `reconcile-servers` repeatable job, post-start inspect polls, chunk flush pipeline (Postgres → Redis → SSE), env knobs from the table above, routes + Zod schemas + services for projects/environments/services/deployments, `delete-server.ts` guard, activity actions for the new entities, SSE types extended, canaries extended in `security:scan-leaks`.
**Implements:** ARCHITECTURE §3–§7.
**Avoids:** P1, P2, P4, P5 (server side), P6, P9 (registry credential as a `Credential`-shaped row, `--password-stdin`), P11 (two timeouts, lock derived from hard max).
**Verification (integration, against the real fixture):** double-deploy → one 409; cancel mid-build → process gone on remote, `docker system df` unchanged; failed build → previous container untouched; worker killed mid-build → sweep marks `WORKER_CRASHED`, next deploy cleans the per-deployment leftovers; sustained-output fixture → bounded RSS and Redis; 20 consecutive deploys and 20 create/delete cycles with `docker system df` before/after, run twice with no manual prune.
**Research flag:** no (patterns exist in v0.1: `connect-server-queue/worker`, `sse-broadcaster`, `write-activity-event`, `failInFlightConnection`); planning should cite those files.

### Phase 7: Projects & Services UI, fixtures end-to-end, deploy E2E
**Rationale:** Joins the two tracks: Phase 2's shell pieces get real Project/Environment/Service data; Phase 6's API gets its client. The E2E critical path (`create project → env → Git service → server → build → run → RUNNING`) drives through the UI, so it lands here.
**Delivers:** `(shell)/projects/**` route tree with the `@inspector` parallel route; hierarchical nav wired; create flows (project, environment with suggested names, service with a source-type segmented control and server picker limited to `CONNECTED` + Docker); service overview with one primary "Deploy" action, deployment history rows, narrated deploy timeline (the discovery-narration treatment); build-log viewer (monospace, auto-scroll with jump-to-bottom, GET-snapshot + SSE-fold by `seq`, non-modal); runtime-log tail; container state from the derived status, `UNKNOWN` shown honestly; empty states that teach the hierarchy; destructive confirmations by exact name; Playwright specs for the critical path, cancel, failed build, ownership.
**Addresses:** all remaining FEATURES table stakes and the three UI-visible differentiators.
**Avoids:** P5 (client side: pure reconcile function keyed by `seq`/`updatedAt`), UX pitfalls (no modal log viewer, no spinner-style "Building…", RowMenu already fixed), brief §9 #17/#19.
**Research flag:** no — Next.js parallel routes are documented and pinned (Next 16); one Context7 check on `@slot` conventions during planning suffices.

### Phase 8: Hardening & v0.2 release gate
**Rationale:** Last by user decision and by the release-gate skill's own practice; rolls up v0.1 operator debt (log rotation, `.env.bak-*` pruning, 1.2 GB image), human UAT debt (22.04/arm64/ufw, real upgrade, small-VPS memory), and the new engine's operational knobs (build-cache retention policy, `docker builder prune` reachable from Noodara), then runs the v0.2 gate against roadmap §7.8 on a real VPS.
**Delivers:** `docs/releases/v0.2-gate.md`, measured numbers from the table above recorded, human UAT closed, release `v0.2.0`.
**Avoids:** Performance trap "accumulating build cache without retention"; PITFALLS "Looks done but isn't" checklist run item by item.
**Research flag:** light — image-size reduction techniques for the control-plane image (multi-stage + `pnpm deploy --prod`) may warrant a short Context7 check.

### Phase Ordering Rationale

- The user's order (identity → redesign → settings → docs/landing → projects/services → hardening) is preserved for feature *closure*. The engine's internal dependency chain (domain/schema → primitives + fixture → queue/API → UI/E2E) is nested inside feature 5 as Phases 5–7.
- Phases 5 and 6 are backend-only and file-disjoint from Phases 2–4; interleaving them is safe and recommended if wall-clock matters. Phase 7 must wait for both Phase 2 (final visual language, generic nav/inspector shell, fixed `RowMenu`) and Phase 6 (API).
- Phase 2 builds the hierarchical nav and inspector slot *generically* so Phase 7 wires rather than restructures — ARCHITECTURE §8.2's explicit warning about inventing a flat-nav pattern that needs redoing days later.
- Fixture-before-feature (Phase 5) is what lets the engine be built RED-first, per `noodara-tdd`.
- Docs (Phase 4) precede the engine's UI so the first-deploy guide and error-code page are written against requirements and then locked by accuracy tests when Phases 6–7 land — not written after the fact.
- Hardening closes last because the release gate always rolls up every phase, and because the engine's own retention knobs cannot be measured before the engine exists.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 5 (engine foundation):** four empirical spikes (G1 secret transfer, G2 remote kill, G3 BuildKit default, G4 `docker ps` JSON stability) — record outcomes as ADR-0004-style contracts before the plans that depend on them are written.
- **Phase 4 (docs/landing):** Fumadocs + Next 16 static export + shared Tailwind v4 tokens; hosting/domain decision.
- **Phase 2 (redesign):** light — `motion` drag API vs brief §7.4; otherwise the brief is the spec.
- **Phase 3 (settings):** light — Better Auth account-mutation APIs.
- **Phase 8 (hardening):** light — image-size reduction.

Phases with standard patterns (skip research-phase):
- **Phase 1 (identity):** design work against the local reference library.
- **Phase 6 (engine runtime):** every pattern has a v0.1 precedent file to copy.
- **Phase 7 (UI wiring + E2E):** existing Next 16 / Playwright / SSE-fold patterns.

## Decisions Needed (for the requirements phase)

Each item names the recommended option; requirements should either accept it or record the alternative with a reason.

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Docs framework | Fumadocs `16.15.13` | Peer-exact with pinned Next/React; static; shares `packages/ui` tokens; no second framework (STACK; satisfies ARCHITECTURE's only constraint) |
| D2 | One public app or two; hosting; domain | One `apps/site` with landing at `/` and Fumadocs at `/docs`; static export to Cloudflare Pages or Vercel; domain per user | Same cadence, same identity, one build and one deploy; split into `apps/docs` only if the domain decision puts docs on a separate host. Hosting/domain explicitly deferred to requirements by PROJECT.md |
| D3 | Container state reconciliation | Server-side `docker ps` poll (30 s repeatable job) + post-start inspect polls + event-driven UI; no `docker events` | Compatible with the no-long-lived-channel SSH model and with the client's no-polling SSE contract; revisit with the Agent |
| D4 | Deployment states in v0.2 | 7 states (`QUEUED PREPARING BUILDING DEPLOYING SUCCESS FAILED CANCELLED`), full v0.3 column set nullable | v0.3 becomes additive `ALTER TYPE … ADD VALUE`; no dead states; no column migration |
| D5 | Service status | Derived pure function, cached column, `UNKNOWN` distinct from `STOPPED` | Avoids three writers racing an FSM; mirrors discovery's "never collapse two unknowns" |
| D6 | Private Git auth | SSH deploy key (primary, per-service credential in the encrypted envelope); HTTPS token via askpass reading a mode-600 remote file; GitHub as first documented integration, generic Git via SSH URL | Competitor-convergent; no secret on argv or in URLs; env-over-SSH not assumed (AcceptEnv) |
| D7 | Private registry pulls in v0.2 | Yes: registry credential as a `Credential`-shaped row now, `docker login --password-stdin`, GHCR tested first | Structurally identical to the deploy key; retrofitting encryption/redaction/cascade later is the expensive path (P9) |
| D8 | Runtime logs | On demand from Docker (`--tail`, `--timestamps`), follow with max duration, not persisted; `--log-opt max-size/max-file` on create | Docker already retains them; halves disk on a small VPS; v0.5 revisits with real observability |
| D9 | Multi-stage Dockerfile target | Optional `target` field; Docker's default when absent | Last stage is the intent in nearly all cases; forced fail-fast is friction without safety |
| D10 | Published host port in v0.2 | Optional `publishedPort` (nullable), off by default; pre-flight check against live `docker ps` → `PORT_IN_USE` | Lets an indie user `curl vps:port` before v0.4 without exposing anything by default; keeps P10's collision check real |
| D11 | Per-service bridge network now | Yes, `noodara-net-<serviceId>`, removed with the service | Literal reading of "no orphan networks"; v0.4 Traefik needs it anyway |
| D12 | Image retention | Per-attempt tag `noodara/<serviceId>:<deploymentId>`; superseded image removed after the new container starts; failed-build images removed in cleanup; global build-cache prune policy in Phase 8 | Failed build never replaces the running image; disk stays bounded; v0.3 changes retention for rollback |
| D13 | Build args and env vars | None in v0.2 (no `--build-arg`, no `--env`); guide says "bake config into the image" | Roadmap assigns them to v0.4; closes P3 vectors 1–2 structurally; brief §9 #19 forbids placeholder fields |
| D14 | Git clone depth, LFS, submodules | `--depth 1 --branch <ref>`; LFS pointer files and `.gitmodules` detected → named errors (`GIT_LFS_UNSUPPORTED`, `GIT_SUBMODULES_UNSUPPORTED`) | Roadmap only needs the deployed SHA; clean rejection beats a cryptic Dockerfile failure |
| D15 | Timeouts | `NOODARA_DEPLOY_MAX_MS` (60 min) + `NOODARA_DEPLOY_IDLE_MS` (5 min); `BUILD_TIMEOUT` vs `BUILD_STALLED`; BullMQ lock derived from max | Slow-but-alive must never be reported as hung (P11) |
| D16 | Concurrency | `jobId = deploy-<deploymentId>`; partial unique index on non-terminal deployments per service → 409 `DEPLOYMENT_IN_PROGRESS`; `NOODARA_DEPLOY_CONCURRENCY = 1` | Job 1:1 with history row; DB is the guard |
| D17 | Cancel semantics | Redis flag → remote kill → confirm → destroy channel → cleanup → `CANCELLED`; cancel of terminal/already-cancelling is a 200 no-op; queued cancel skips the kill | Only the worker transitions status; P2 |
| D18 | Crash recovery | Startup sweep → `FAILED/WORKER_CRASHED`; sweep removes deterministic per-deployment leftovers (workspace, attempt image) idempotently, never the per-service container | Deterministic names make a persisted ledger unnecessary; the previous healthy container is sacred |
| D19 | Motion library | Adopt `motion@13.4.1` in `packages/ui`, `LazyMotion` scoped to the Sheet; brief §7.4's behaviors are the acceptance tests | Interruptible spring gestures are not achievable with CSS; hand-rolling a physics integrator is more code to own than the library |
| D20 | Settings persistence | Server-side on the user row + first-paint mirror through the existing pre-hydration mechanism; single write path | Survives browsers; no theme flicker (P17) |
| D21 | Password change side effects | Revoke all other sessions; activity event without sensitive metadata | Coolify's pattern; matches v0.1's session model |
| D22 | SSE event surface | Add `service.updated`, `service.deleted`, `deployment.updated`, `deployment.log_chunk`; no `project.*`/`environment.*` | Keeps the literal allowlist tight; rare-change entities refetch |
| D23 | Environment `kind` | Free-text with four suggested defaults, not a Postgres enum | Roadmap says names are not limited; enums are for closed state sets |
| D24 | Project deletion | Archive (reversible) first; hard delete only when no environments remain; exact-name confirmation | Mirrors the Server delete pattern (brief §9 #18) |
| D25 | Server deletion with services | Refuse (409) while services reference it | Never silently orphan `services.server_id` |
| D26 | Boundaries | `packages/git`/`packages/docker` under the existing `ssh-adapter` tag; boundary test for `apps/site` | Same allow list; no new tag |
| D27 | `CLAUDE.md` §4 | Add `DeploymentLogChunk` to the entity list; §3.1 structure gains `apps/site` (and `packages/git`, `packages/docker`) | Keep the operative guide accurate (user edits it; outside GSD's file scope) |

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions and peer ranges verified against npm and Context7; the "add nothing for Docker/Git" recommendation is grounded in the shipped `packages/ssh`. MEDIUM only on the credential-transfer mechanics (Gap G1) |
| Features | MEDIUM-HIGH | Competitor behavior verified against official docs and public issue trackers; docs-site shape observed directly; landing-copy guidance is convention, not sourced (LOW) |
| Architecture | HIGH | Every claim cites a real v0.1 file; the design reuses existing seams. The three places it is overridden here (runtime logs, cancel two-step, resource ledger) are refinements, not contradictions |
| Pitfalls | HIGH / MEDIUM | HIGH where grounded in this repo's mechanisms; MEDIUM for ecosystem pitfalls (BuildKit secrets, shallow clones, Coolify/Dokploy incidents) verified against current external sources |

**Overall confidence:** HIGH

### Gaps to Address

- **G1 — Secret transfer to the remote host without argv.** Deploy keys, HTTPS tokens and registry passwords must land in a mode-600 file (or `--password-stdin`) on the target. Candidates: stdin of an allowlisted `umask 077 && cat > <DeployWorkspacePath>/.cred` or ssh2's SFTP subsystem. Env-over-SSH is not viable by default (`AcceptEnv`). Spike in Phase 5 planning; record as an ADR; the streaming exec must support stdin either way.
- **G2 — Remote kill mechanism for cancel.** `channel.destroy()` does not stop `docker build`. Candidates: `channel.signal('INT')` (verify sshd support on OpenSSH 8.9/9.6 empirically), `setsid` + pidfile + `kill -- -<pgid>` via an allowlisted command (daemon-agnostic, recommended a priori), `docker kill` of the BuildKit build container. Spike with the sshd+dockerd fixture; assert the process is gone.
- **G3 — BuildKit as the active builder** on the apt-repo Docker that `install.sh` provisions on 22.04/24.04; needed now for `docker build` progress output and later for `--secret`. Add to discovery checks rather than assume.
- **G4 — `docker ps --format '{{json .}}'` field stability** across the Docker versions on both Ubuntu LTS; the reconcile parser must be tolerant and tested against captured real output, never free-text.
- **G5 — Crash-recovery ownership** is defined here (D18) but must be written into requirements precisely: what the sweep removes, what it never touches, and what the next reconcile tick does.
- **G6 — Runtime log follow while a client views** (D8): the streaming exec's max-duration and reconnect contract with the UI must be specified in requirements so the log viewer is not built twice.
- **G7 — Docker Hub anonymous rate limits in CI**: fixtures and tests should pull from GHCR or a local registry; confirm during Phase 5 planning.
- **G8 — Whether v0.2 needs any diff against a previous commit** (LOW in PITFALLS 7): research says no (`--depth 1` suffices); requirements should confirm so no engine logic assumes history.
- **G9 — Hosting and domain for the public site** (D2): deferred to requirements by PROJECT.md.

## Sources

### Primary (HIGH confidence)
- This repository, read directly: `packages/ssh/src/{exec-with-timeout,ssh-port,error-classifier}.ts`, `packages/ssh/src/commands/{allowlist,docker,index}.ts`, `packages/domain/src/server/server-state.ts`, `packages/domain/src/security/*`, `apps/control-plane/src/{queue,events,routes,services,db/schema,env}.ts`, `docker-compose.yml`, `turbo.json`, `pnpm-workspace.yaml`, `tests/integration/helpers/{ssh,installer-dind}.ts`, `tests/unit/docs/install-docs-accuracy.test.ts`, `docs/adr/0003`, `0004`, `0006`, `docs/ui-build-prompt.md`, `docs/roadmap-v0.1-v0.5.md` §7–§10, `docs/releases/v0.1-gate.md`, `.planning/{PROJECT,MILESTONES,STATE}.md`.
- npm registry (`npm view`): `fumadocs-core@16.15.13`, `fumadocs-ui@16.15.13`, `fumadocs-mdx@15.4.3`, `motion@13.4.1`, `dockerode@5.0.1`, `docker-modem@5.0.7`, `astro@7.3.3`, `@astrojs/starlight@0.42.3`, `vitepress@1.6.4`.
- Context7 `/websites/motion_dev` (App Router usage, `LazyMotion`/`domAnimation`), `/apocas/dockerode` (no native SSH transport; API shapes).
- Official docs: Coolify (deployments overview, deploy keys), Dokploy (applications, build types, providers), Railway (deployments reference, actions), Render (deploys, troubleshooting), Fly.io (rollback, releases), Kamal (rollback), Docker (build secrets).

### Secondary (MEDIUM confidence)
- GitHub issues: Dokploy #4461, #2670, #4271, #508, #2106 (stuck "Running"), #2757, #390 (cancel ineffective); Coolify #1129, #2547, #5611, #6414, #7270, #7566, discussion #3192; lekky/landit#452; apocas/docker-modem #80/#135.
- Deploy-key / `GIT_SSH_COMMAND` / askpass patterns (multiple independent guides); BuildKit `--secret` vs `--build-arg` leak behavior (Docker docs, pythonspeed, DataCamp); shallow clone and submodule/LFS deploy pitfalls (OpenReplay, DeployHQ).

### Tertiary (LOW confidence)
- Landing-page structure and copy strategy (observed convention across competitor marketing sites, not a sourced best practice).
- Absence of a narrated step-by-step deploy UI at competitors (inferred from absence in six docs sets).
- Whether v0.2 needs commit diffing at all (requirements question, PITFALLS 7).

---
*Research completed: 2026-09-22*
*Ready for roadmap: yes*
