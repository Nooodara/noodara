# Deploy Engine API Surface & Measured Defaults

Phase 12 runtime engine: project/environment/service setup, deployment queue, live logs, cancellation and reconciliation.

## API Routes

### Projects
- `POST /api/projects` — create project (name, slug, description)
- `GET /api/projects` — list projects  
- `PATCH /api/projects/:projectId` — update project
- `GET /api/projects/:projectId` — get project
- `POST /api/projects/:projectId/{archive|unarchive}` — archive / restore (archived projects reject deploys)
- `DELETE /api/projects/:projectId` — hard delete; only an archived project, name confirmation required

### Environments
- `POST /api/projects/:projectId/environments` — create environment
- `GET /api/projects/:projectId/environments` — list environments
- `GET /api/projects/:projectId/environments/:environmentId` — get environment
- `PATCH /api/projects/:projectId/environments/:environmentId` — update environment

### Services
- `POST /api/projects/:projectId/services` — create service (Git source: URL, branch, context, Dockerfile path, `target`; or image reference or Dockerfile service)
- `GET /api/projects/:projectId/services` — list services
- `GET /api/projects/:projectId/services/:serviceId` — get service detail
- `PATCH /api/projects/:projectId/services/:serviceId` — update service
- `DELETE /api/projects/:projectId/services/:serviceId` — delete service (cascades deployments, cleans container/network/images/workspace)
- `POST /api/projects/:projectId/services/:serviceId/{operation}` — one route per entry of `SERVICE_OPERATIONS` (see `services.ts`)
- `POST /api/projects/:projectId/services/:serviceId/redeploy` — trigger a new deployment from current source
- `GET|PUT|DELETE /api/projects/:projectId/services/:serviceId/credentials[/repository|/registry]` — credential slots (never returns values)

### Deployments
- `POST /api/services/:serviceId/deploy` — trigger deployment (returns 201 with deployment in `QUEUED` state)
- `GET /api/services/:serviceId/deployments` — list deployments for a service
- `GET /api/services/:serviceId/deployments/:deploymentId` — get deployment detail
- `GET /api/deployments/:deploymentId` — get deployment (any service)
- `POST /api/deployments/:deploymentId/cancel` — cancel queued/running deployment (returns 202)

### Build Logs
- `GET /api/deployments/:deploymentId/logs?phase=:phase&since=:seq&limit=:n` — read persisted build logs (append-only chunks, resync without replay)

### Runtime Logs
- `GET /api/projects/:projectId/services/:serviceId/logs?tail=:n` — tail N runtime container logs (JSON response)
- `GET /api/projects/:projectId/services/:serviceId/logs/follow?tail=:n` — stream runtime logs live (NDJSON, bounded by duration)

### Server Operations
- (Server operations unmodified from Phase 11: connect, disconnect, discover)

## Deployment Statuses & State Machine

Seven states (Phase 11 ADR 0004):

| State | Meaning | Terminal |
|---|---|---|
| `QUEUED` | Waiting for a worker slot | No |
| `PREPARING` | Cloning repo, fetching base images | No |
| `BUILDING` | Running `docker build` | No |
| `DEPLOYING` | Starting/verifying container | No |
| `SUCCESS` | Container running, checks passed | Yes |
| `FAILED` | Error at any stage, including `BUILD_TIMEOUT` / `BUILD_STALLED`; prior container keeps running | Yes |
| `CANCELLED` | User cancel; confirmed remote absence; cleanup complete | Yes |

Valid transitions (enforced):
- `QUEUED → PREPARING | CANCELLED`
- `PREPARING → BUILDING | FAILED | CANCELLED`
- `BUILDING → DEPLOYING | FAILED | CANCELLED`

Timeouts are not a state: they end `FAILED` with `BUILD_TIMEOUT` / `BUILD_STALLED`.
- `DEPLOYING → SUCCESS | FAILED | CANCELLED`

## Error Codes

Detailed in `apps/site/content/docs/reference/error-codes.mdx`. Key codes for Phase 12:

| Code | HTTP | Meaning |
|---|---|---|
| `DEPLOYMENT_IN_PROGRESS` | 409 | Service already has active deployment |
| `DEPLOYMENT_INPUT_INVALID` | 422 | Invalid request fields |
| `DEPLOYMENT_NOT_CANCELLABLE` | 409 | Deployment already terminal |
| `CONTAINER_NOT_FOUND` | 409 | Service has no container for runtime logs |
| `RUNTIME_LOG_TAIL_INVALID` | 422 | `tail` out of valid range (1-10000) |
| `RUNTIME_LOG_FOLLOW_LIMIT_REACHED` | 429 | Too many open follow streams |
| `RUNTIME_LOGS_FAILED` | 502 | Docker logs command failed on server |
| `RUNTIME_LOGS_TIMEOUT` | 504 | Docker logs timed out |
| `PORT_IN_USE` | 409 | Published port conflicts with another service or system |
| `BUILD_FAILED` | (logged) | Build exited non-zero |
| `BUILD_TIMEOUT` | (logged, deployment `FAILED`) | Exceeded `NOODARA_DEPLOY_MAX_MS` |
| `BUILD_STALLED` | (logged, deployment `FAILED`) | No output for `NOODARA_DEPLOY_IDLE_MS` |
| `CLONE_FAILED` | (logged) | Git clone failed (auth, missing repo/branch) |
| `REPOSITORY_AUTH_FAILED` | (logged) | Deploy key or HTTPS token rejected |
| `IMAGE_PULL_FAILED` | (logged) | Base or registry image pull failed |
| `START_FAILED` | (logged) | Container failed to start or failed health checks |
| `WORKER_CRASHED` | (logged) | Worker died mid-deployment; cleanup triggered on restart |

## Measured Defaults

Fixtures: real `sshd+dockerd`. Phase 12 numbers below are **Ubuntu 24.04 on macOS arm64 Docker Desktop**; Phase 11 contract numbers cover 22.04 and 24.04. Also run on a GitHub amd64 runner (`ubuntu-latest`): ADR 0008 open item 6 is resolved by nightly run 37398385044.

"Fresh" = re-run for 12-19 on 2026-10-05. "Test" = asserted by the named integration test (`tests/integration/deploy-engine/`). "Unit" = unit-tested only; default value not exercised end to end.

| Knob | Default (min / max) | Measured / verified |
|---|---|---|
| `NOODARA_DEPLOY_MAX_MS` | 1 h (5 min / 4 h) | 60 min is not run in a test. Unit: job lock = max + 5 min cleanup + 30 s margin, checked at min and max bounds (`deploy-job-budget`). Scaled-down max: chatty build with max 40 s ends `FAILED/BUILD_TIMEOUT` (`runtime-pipeline` A4). Happy-path deploys ran with max 300 s |
| `NOODARA_DEPLOY_IDLE_MS` | 5 min (10 s / 1 h) | Scaled-down: silent build with idle 15 s ends `FAILED/BUILD_STALLED` (`runtime-pipeline` A4); idle only counts output, so the chatty build is not stalled |
| `NOODARA_DEPLOY_CONCURRENCY` | 1 (1 / 10) | Default 1 not load-tested. Pipeline ran with concurrency 2 and one active deploy per service held (partial unique index, DEP-06); range checked in `env.ts` unit tests |
| `NOODARA_DEPLOY_LOG_MAX_BYTES` | 10 MiB (16 KiB / 100 MiB) | Per-line cap 16,384 B and a 65,536 B phase cap each truncate with one notice (`runtime-build-logs` A1/A2). node-api deploy logs are small; the 4-5 MiB figure in older notes was not reproduced and is dropped |
| `NOODARA_DEPLOY_LOG_FLUSH_MS` / `_BYTES` | 250 ms / 16 KiB | Canary halves emitted 1.5 s apart straddle a 16 KiB cut with no leak and `seq` 1..n per phase (`runtime-build-logs` A1/A2) |
| `NOODARA_DEPLOY_LOG_RETENTION_DAYS` | 30 (1 / 365) | Chunks aged 40 days purged, recent kept; duplicate `seq` rejected (`runtime-build-logs` A4/H1) |
| `NOODARA_RECONCILE_INTERVAL_MS` | 30 s (5 s / 10 min) | Fresh: at 5 s, one `docker ps --size=false` per CONNECTED server per tick; A1 passed in 7.1 s (`runtime-reconcile`). Per-call cost is a Phase 11 contract number (ADR 0008 table): 34-37 ms on 22.04, 25-27 ms on 24.04 (50k-file layer); not re-timed in Phase 12 |
| `NOODARA_RUNTIME_LOG_TAIL` | 1,000 (1 / 10,000) | Fresh: tail 1..10000 accepted, outside it `422` with no SSH work (`runtime-container-logs` H1, 4 ms) |
| `NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS` | 10 min (10 s / 1 h) | Scaled-down max 4 s: follow ended at 4,121 ms (fresh) with `end: max_duration` and remote `docker logs` killed; client disconnect also kills it in 125 ms (`runtime-container-logs` A2) |
| Post-start polls (domain policy) | 5 polls, 1 s doubling to 8 s, 2 stable | Unit-tested policy. End to end, node-api trigger to terminal incl. polls: p50 4,036 ms (soak below) |

### Phase 12 Soak Results (Ubuntu 24.04, macOS arm64 Docker Desktop; taken from 12-18, `soak.test.ts`)

- **A1, 20 consecutive node-api deploys:** 20/20 SUCCESS; per-deploy trigger-to-terminal p50 4,036 ms, max 5,554 ms, far under the 1 h `NOODARA_DEPLOY_MAX_MS` default (test used 300 s). `docker system df` after: Images 3 (1 active), Containers 1, Local Volumes 0. Build Cache (9 records, 234.1 MB) grows and is excluded from the comparison (decision 2026-10-05, below).
- **A2, 20 create, deploy, delete cycles:** 20/20 SUCCESS; deploy p50 4,033 ms, max 4,542 ms; full cycle p50 4,373 ms, max 4,897 ms. After each delete: container, network, image, workspace and rows gone. `df` Images/Containers/Local Volumes equal before and after (two settled checks, no prune); Build Cache excluded.
- **Nightly soak, amd64 (`ubuntu-latest`), run 37398385044 (main @ ecd3ceb), `soak` job success; both versions 20/20 SUCCESS in A1 and A2** (from the `soak-report` artifact):

| Ubuntu | A1 deploy p50 / max | A2 deploy p50 / max | A2 full cycle p50 / max |
|---|---|---|---|
| 22.04 | 5,524 / 7,546 ms | 5,018 / 5,022 ms | 5,883 / 5,957 ms |
| 24.04 | 5,521 / 7,533 ms | 5,020 / 5,521 ms | 5,879 / 6,366 ms |

  Not compared against the arm64 numbers above: different hardware and Docker.

## Build-Cache Decision (2026-10-05)

**Context:** Each cancelled or timed-out build leaves one orphan BuildKit record (`mount / from exec`, ~8 KiB, parent = base layer). Images, Containers, Local Volumes unaffected. `docker system df Build Cache` grew `7 / 234MB` → `8 / 234.1MB` per cancel in tests.

**Decision:** Cancel cleanup (task 12-13) is checked against `docker system df Images/Containers/Local Volumes` parity only. BuildKit records are **excluded** from that parity and only checked for bounded growth (≤ 64 KiB per cancel observed). Build cache is not a stable quantity: it is not part of any `df` equality claim. Retention/pruning is assigned to Phase 14 (D-12).

Rationale: BuildKit owns its cache lifecycle independently; forcing a full `docker builder prune` mid-deployment would slow every cancel by seconds and waste already-built stages.
