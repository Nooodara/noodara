# Deploy Engine API Surface & Measured Defaults

Phase 12 runtime engine: project/environment/service setup, deployment queue, live logs, cancellation and reconciliation.

## API Routes

- Projects: `POST|GET /api/projects`, `GET|PATCH /api/projects/:projectId`, `POST .../{archive|unarchive}` (archived projects reject deploys), `DELETE` (archived only, name confirmation).
- Environments: `POST|GET /api/projects/:projectId/environments`, `GET|PATCH|DELETE .../environments/:environmentId`. `DELETE` takes `{ confirmName }` (exact name, else 422 `DELETE_CONFIRMATION_MISMATCH`) and only removes an empty environment (else 409 `ENVIRONMENT_NOT_EMPTY`); it writes `environment.deleted`.
- Services (`/api/projects/:projectId/services`): `POST` (Git source with `target`, image reference or Dockerfile), `GET`, `GET|PATCH|DELETE /:serviceId` (delete cascades deployments and cleans container/network/images/workspace), `POST /:serviceId/{stop|restart|remove}` (one per `SERVICE_OPERATIONS`, see `services.ts`), `POST /:serviceId/redeploy`, `GET|PUT|DELETE /:serviceId/credentials[/repository|/registry]` (never returns values).
- Deployments: `POST /api/services/:serviceId/deploy` (201, `QUEUED`), `GET /api/services/:serviceId/deployments[/:deploymentId]`, `GET /api/deployments/:deploymentId`, `POST /api/deployments/:deploymentId/cancel` (202).
- Build logs: `GET /api/deployments/:deploymentId/logs?phase=&since=&limit=` (append-only chunks, resync without replay).
- Runtime logs: `GET /api/projects/:projectId/services/:serviceId/logs?tail=` (JSON) and `.../logs/follow?tail=` (NDJSON, bounded by duration).
- Server operations are unchanged from Phase 11.

## Deployment Statuses

States (ADR 0004): `QUEUED`, `PREPARING`, `BUILDING`, `DEPLOYING` (active); `SUCCESS`, `FAILED`, `CANCELLED` (terminal). Timeouts are not a state: they end `FAILED` with `BUILD_TIMEOUT` / `BUILD_STALLED`; a failed deploy leaves the prior container running.

Transitions: `QUEUED → PREPARING | CANCELLED`; `PREPARING → BUILDING | FAILED | CANCELLED`; `BUILDING → DEPLOYING | FAILED | CANCELLED`; `DEPLOYING → SUCCESS | FAILED | CANCELLED`.

## Error Codes

Full list in `apps/site/content/docs/reference/error-codes.mdx`. Build-time codes (`BUILD_FAILED`, `BUILD_TIMEOUT`, `BUILD_STALLED`, `CLONE_FAILED`, `REPOSITORY_AUTH_FAILED`, `GIT_HOST_KEY_MISMATCH`, `GIT_HOST_KEY_UNAVAILABLE`, `IMAGE_PULL_FAILED`, `START_FAILED`, `WORKER_CRASHED`) are logged on the deployment, not returned as HTTP errors. HTTP: `DEPLOYMENT_IN_PROGRESS` 409, `DEPLOYMENT_INPUT_INVALID` 422, `DEPLOYMENT_NOT_CANCELLABLE` 409, `CONTAINER_NOT_FOUND` 409, `RUNTIME_LOG_TAIL_INVALID` 422 (`tail` 1-10000), `RUNTIME_LOG_FOLLOW_LIMIT_REACHED` 429, `RUNTIME_LOGS_FAILED` 502, `RUNTIME_LOGS_TIMEOUT` 504, `PORT_IN_USE` 409.

## Git Host Keys (14-06, 14-07)

SSH clones run with `StrictHostKeyChecking=yes`. GitHub, GitLab and Bitbucket use bundled keys; any other host is trust-on-first-use, pinned per service.

- Storage: `services.git_host_key_host` + `git_host_key` (migration `0008`, nullable, both or neither; newline-joined known_hosts lines). Lines are re-validated on read; a tampered row pins nothing and the next clone fails closed. Store: `db/git-host-key-store.ts`.
- First clone: the scanned keys are pinned before the build in one transaction (`SELECT ... FOR UPDATE`, then `UPDATE ... WHERE git_host_key IS NULL OR host IS DISTINCT FROM`). Two concurrent first clones store one key; the loser must match the winner's keys or fails `GIT_HOST_KEY_MISMATCH`.
- Later clones pass the pin; a rotated key fails `FAILED/GIT_HOST_KEY_MISMATCH` and is never auto-replaced. The message names the reset command; no key blob reaches the message, the build log, events or activity.
- A repository URL edit to another SSH host (or https, or an image source) clears the pin; the same host keeps it.
- Reset: `noodara services reset-host-key <serviceId>` (exit 0 cleared or nothing pinned, 1 unknown service, 2 invalid id, no write). Writes a `service.updated` activity event with `changedFields: ['gitHostKey']`; the next deploy pins again.

## Step Timeline (13-03)

`GET` deployment views carry `steps[]`: always four, in order `clone` (`pull` for image sources), `build` (`skipped` for image sources), `start`, `verify`. Each has `state` (`pending|running|success|failed|cancelled|skipped`), `startedAt`, `completedAt` and `durationMs` (null unless both ends are known, never negative).

- Derived by `deriveDeploymentSteps()` in `packages/domain` (pure, total over status x source x error code). States come from the status; timestamps only add times, so a terminal deployment never shows a running step.
- Boundaries: `startedAt` (clone/pull), `building_started_at`, `deploying_started_at`, `verifying_started_at` (migration `0006`, nullable), `completedAt`. Each is written in the same `UPDATE` as its status edge; `verify` starts after `docker start`, written only while `DEPLOYING`.
- A failed deploy marks the step it reached `failed` and later steps `pending`; a cancel marks it `cancelled`. Rows without boundaries (pre-0006, or failed before the first boundary) map the error code to its step.

## Measured Defaults

Fixtures: real `sshd+dockerd`. Phase 12 numbers are **Ubuntu 24.04 on macOS arm64 Docker Desktop** ("fresh" = re-run 2026-10-05); Phase 11 contract numbers cover 22.04 and 24.04. amd64 runner: nightly run 37398385044 (ADR 0008 item 6). Tests live in `tests/integration/deploy-engine/`; "Unit" = not exercised end to end.

| Knob | Default (min / max) | Measured / verified |
|---|---|---|
| `NOODARA_DEPLOY_MAX_MS` | 1 h (5 min / 4 h) | 60 min is not run in a test. Unit: job lock = max + 5 min cleanup + 30 s margin, checked at min and max bounds (`deploy-job-budget`). Scaled-down max: chatty build with max 40 s ends `FAILED/BUILD_TIMEOUT` (`runtime-pipeline` A4). Happy-path deploys ran with max 300 s |
| `NOODARA_DEPLOY_IDLE_MS` | 5 min (10 s / 1 h) | Scaled-down: silent build with idle 15 s ends `FAILED/BUILD_STALLED` (`runtime-pipeline` A4); idle only counts output, so the chatty build is not stalled |
| `NOODARA_DEPLOY_CONCURRENCY` | 1 (1 / 10) | Default 1 not load-tested. Pipeline ran with concurrency 2 and one active deploy per service held (partial unique index, DEP-06); range checked in `env.ts` unit tests |
| `NOODARA_DEPLOY_LOG_MAX_BYTES` | 10 MiB (16 KiB / 100 MiB) | Per-line cap 16,384 B and a 65,536 B phase cap each truncate with one notice (`runtime-build-logs` A1/A2). node-api deploy logs are small; the older 4-5 MiB figure was not reproduced |
| `NOODARA_DEPLOY_LOG_FLUSH_MS` / `_BYTES` | 250 ms / 16 KiB | Canary halves emitted 1.5 s apart straddle a 16 KiB cut with no leak and `seq` 1..n per phase (`runtime-build-logs` A1/A2) |
| `NOODARA_DEPLOY_LOG_RETENTION_DAYS` | 30 (1 / 365) | Chunks aged 40 days purged, recent kept; duplicate `seq` rejected (`runtime-build-logs` A4/H1) |
| `NOODARA_RECONCILE_INTERVAL_MS` | 30 s (5 s / 10 min) | Fresh: at 5 s, one `docker ps --size=false` per CONNECTED server per tick; A1 passed in 7.1 s (`runtime-reconcile`). Per-call cost is a Phase 11 number (ADR 0008): 34-37 ms on 22.04, 25-27 ms on 24.04; not re-timed |
| `NOODARA_RUNTIME_LOG_TAIL` | 1,000 (1 / 10,000) | Fresh: tail 1..10000 accepted, outside it `422` with no SSH work (`runtime-container-logs` H1, 4 ms) |
| `NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS` | 10 min (10 s / 1 h) | Scaled-down max 4 s: follow ended at 4,121 ms (fresh) with `end: max_duration` and remote `docker logs` killed; client disconnect also kills it in 125 ms (`runtime-container-logs` A2) |
| Post-start polls | 5 polls, 1 s doubling to 8 s, 2 stable | Unit-tested policy; node-api trigger to terminal incl. polls p50 4,036 ms (soak below) |

### Phase 12 Soak Results (Ubuntu 24.04, macOS arm64 Docker Desktop; taken from 12-18, `soak.test.ts`)

- **A1, 20 consecutive node-api deploys:** 20/20 SUCCESS; trigger-to-terminal p50 4,036 ms, max 5,554 ms (test max 300 s). `docker system df` after: Images 3 (1 active), Containers 1, Local Volumes 0; Build Cache (9 records, 234.1 MB) excluded (decision below).
- **A2, 20 create, deploy, delete cycles:** 20/20 SUCCESS; deploy p50 4,033 / max 4,542 ms; full cycle p50 4,373 / max 4,897 ms. After each delete container, network, image, workspace and rows are gone; `df` Images/Containers/Volumes equal before and after (no prune).
- **Nightly soak, amd64 (`ubuntu-latest`), run 37398385044 (main @ ecd3ceb), `soak` job success; both versions 20/20 SUCCESS in A1 and A2** (from the `soak-report` artifact):

| Ubuntu | A1 deploy p50 / max | A2 deploy p50 / max | A2 full cycle p50 / max |
|---|---|---|---|
| 22.04 | 5,524 / 7,546 ms | 5,018 / 5,022 ms | 5,883 / 5,957 ms |
| 24.04 | 5,521 / 7,533 ms | 5,020 / 5,521 ms | 5,879 / 6,366 ms |

Not comparable to the arm64 numbers (different hardware and Docker).

### Continuous-log build (`runtime-build-logs` A5, 12-12)

Fixture: chatty build logging for 150 s, Ubuntu 24.04, macOS arm64 Docker Desktop, run 2026-10-05; API and worker share one process, so RSS covers both. Test policy: flush 250 ms / 16,384 B, line cap 16,384 B, phase cap 4 MiB (not the 10 MiB default). Deploy ended SUCCESS in 154,161 ms.

| Measure | Value |
|---|---|
| API RSS before / peak | 138.1 / 141.4 MiB (growth 3.3 MiB); RSS after: not printed |
| Max SSE buffered bytes | 0 B (limit `SSE_MAX_BUFFERED_BYTES` = 1 MiB) |
| Sink peak pending | 3,212 B; dropped chunks 0 |
| Chunks | 463 build, 465 total persisted, 465 received over SSE; 7,190 tick lines, 1,064,528 build bytes (mean 2,299 B/chunk) |
| Evictions | no count printed; the test asserts the client stayed connected and received every persisted chunk |

## Build-Cache Decision (2026-10-05)

Each cancelled or timed-out build leaves one orphan BuildKit record (~8 KiB; `df` Build Cache `7 / 234MB` → `8 / 234.1MB` per cancel). Cancel cleanup (12-13) is checked against `docker system df` Images/Containers/Local Volumes parity only; BuildKit records are excluded and only checked for bounded growth (≤ 64 KiB per cancel). Retention/pruning is Phase 14 (D-12): BuildKit owns its cache lifecycle, and a `builder prune` mid-deploy would slow every cancel.
