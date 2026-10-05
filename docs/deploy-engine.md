# Deploy Engine API Surface & Measured Defaults

Phase 12 runtime engine: project/environment/service setup, deployment queue, live logs, cancellation and reconciliation.

## API Routes

### Projects
- `POST /api/projects` — create project (name, slug, description)
- `GET /api/projects` — list projects  
- `PATCH /api/projects/:projectId` — update project
- `DELETE /api/projects/:projectId` — archive/delete project (soft archive, then hard delete requiring name confirmation)

### Environments
- `POST /api/projects/:projectId/environments` — create environment
- `GET /api/projects/:projectId/environments` — list environments
- `PATCH /api/projects/:projectId/environments/:environmentId` — update environment
- `DELETE /api/projects/:projectId/environments/:environmentId` — delete environment (cascades services, deployments, logs)

### Services
- `POST /api/projects/:projectId/services` — create service (Git source: URL, branch, context, Dockerfile path, `target`; or image reference or Dockerfile service)
- `GET /api/projects/:projectId/services` — list services
- `GET /api/projects/:projectId/services/:serviceId` — get service detail
- `PATCH /api/projects/:projectId/services/:serviceId` — update service
- `DELETE /api/projects/:projectId/services/:serviceId` — delete service (cascades deployments, cleans container/network/images/workspace)
- `POST /api/projects/:projectId/services/:serviceId/:operation` — service operations (stop, restart, remove)
- `POST /api/projects/:projectId/services/:serviceId/redeploy` — trigger a new deployment from current source

### Deployments
- `POST /api/services/:serviceId/deploy` — trigger deployment (returns 201 with deployment in `QUEUED` state)
- `GET /api/services/:serviceId/deployments` — list deployments for a service (paginated)
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
| `FAILED` | Error at any stage; prior container still running if deployment exists | Yes |
| `CANCELLED` | User or timeout kill; confirmed remote absence; cleanup complete | Yes |

Valid transitions (enforced):
- `QUEUED → PREPARING | CANCELLED`
- `PREPARING → BUILDING | FAILED | CANCELLED`
- `BUILDING → DEPLOYING | FAILED | CANCELLED | TIMEOUT`
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
| `BUILD_TIMEOUT` | (logged) | Exceeded `NOODARA_DEPLOY_MAX_MS` |
| `BUILD_STALLED` | (logged) | No output for `NOODARA_DEPLOY_IDLE_MS` |
| `CLONE_FAILED` | (logged) | Git clone failed (auth, missing repo/branch) |
| `REPOSITORY_AUTH_FAILED` | (logged) | Deploy key or HTTPS token rejected |
| `IMAGE_PULL_FAILED` | (logged) | Base or registry image pull failed |
| `START_FAILED` | (logged) | Container failed to start or failed health checks |
| `WORKER_CRASHED` | (logged) | Worker died mid-deployment; cleanup triggered on restart |

## Measured Defaults

Fixtures: real `sshd+dockerd` on Ubuntu 22.04 LTS, 24.04 LTS; Docker Desktop macOS arm64. **Not yet measured on CI amd64 runner** (open item in ADR 0008).

| Knob | Default | Min | Max | Rationale | Measured |
|---|---|---|---|---|---|
| `NOODARA_DEPLOY_MAX_MS` | 3,600,000 (1 h) | 300,000 (5 min) | 14,400,000 (4 h) | Total time budget for clone+build+deploy; `BUILD_TIMEOUT` if exceeded | — |
| `NOODARA_DEPLOY_IDLE_MS` | 300,000 (5 min) | 10,000 (10 s) | 3,600,000 (1 h) | Inactivity threshold; `BUILD_STALLED` if no output for this duration | — |
| `NOODARA_DEPLOY_CONCURRENCY` | 1 | 1 | 10 | Max simultaneous deploys per control-plane instance | — |
| `NOODARA_DEPLOY_LOG_MAX_BYTES` | 10,485,760 (10 MiB) | 16,384 (16 KiB, per-line cap) | 104,857,600 (100 MiB) | Per-phase (build/deploy) log cap; excess lines truncated with notice | 20 deployments, 4-5 sec each; ~4-5 MiB logs per fixture |
| `NOODARA_DEPLOY_LOG_FLUSH_MS` | 250 | 50 | 5,000 | Time-based flush to SSE/database | 250 ms windows in canary test |
| `NOODARA_DEPLOY_LOG_FLUSH_BYTES` | 16,384 (16 KiB) | 1,024 | 16,384 | Size-based flush batch; never exceeds one log line | 16 KiB flush batches in live SSE |
| `NOODARA_DEPLOY_LOG_RETENTION_DAYS` | 30 | 1 | 365 | Build log retention in database | — |
| `NOODARA_RECONCILE_INTERVAL_MS` | 30,000 (30 s) | 5,000 (5 s) | 600,000 (10 min) | Frequency of `docker ps` poll per server | One tick per 5 s in test; real cost ~34-37 ms per 50k-layer image on 22.04, ~25-27 ms on 24.04 |
| `NOODARA_RUNTIME_LOG_TAIL` | 1,000 | 1 | 10,000 | Default tail lines for runtime logs | — |
| `NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS` | 600,000 (10 min) | 10,000 | 3,600,000 | Max duration of live log follow stream | — |

### Phase 12 Soak Test Results (Ubuntu 24.04, fixture)

**A1: 20 consecutive node-api deploys (same service)**
- 20/20 SUCCESS; p50 4036 ms, p95 5554 ms (within budget 300s max)
- docker system df: Images 3 (1 active), Containers 1, Build Cache 9 / 234.1 MB

**A2: 20 create → deploy → delete cycles**
- 20/20 SUCCESS; per-cycle deploy p50 4033 ms, p95 4897 ms; full cycle p50 4373 ms
- After each delete: container, network, image, workspace gone; rows deleted cleanly
- docker system df before/after: stable (Images/Containers/Volumes equal, Build Cache BuildKit-owned per Phase 14)

## Build-Cache Decision (2026-10-05)

**Context:** Each cancelled or timed-out build leaves one orphan BuildKit record (`mount / from exec`, ~8 KiB, parent = base layer). Images, Containers, Local Volumes unaffected. `docker system df Build Cache` grew `7 / 234MB` → `8 / 234.1MB` per cancel in tests.

**Decision:** Cancel cleanup (task 12-13) is checked against `docker system df Images/Containers/Local Volumes` parity only. BuildKit records are **excluded** from that parity and only checked for bounded growth (≤ 64 KiB per cancel observed). Build cache retention/pruning policy assigned to Phase 14 (D-12).

Rationale: BuildKit owns its cache lifecycle independently; forcing a full `docker builder prune` mid-deployment would slow every cancel by seconds and waste already-built stages.
