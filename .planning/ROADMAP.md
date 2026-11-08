# Roadmap

> Generated from `.agent-flow/plan.json` by `agent-flow plan render`. Edit the plan, not this file.

**Milestone:** v0.5
**Progress:** 202/204 tasks (99%), 20/22 phases

## Phase 11: Motor de deploy — fundamentos — done
**Goal:** Everything the engine needs to be built RED-first exists and is proven on real infrastructure: spikes resolved (ADR 0008), pure domain, schema, parameterized allowlist templates, streaming exec, git/docker packages, sshd+dockerd fixture and official fixtures.
**Requirements:** DEP-01, DEP-08, SVC-08, PROJ-04, QA-07, QA-10

- [x] 11-01 (wave 1) Deployment state machine, error codes, deriveServiceStatus, repository feature probe — done
- [x] 11-02 (wave 1) Branded validators (SVC-08) — done
- [x] 11-03 (wave 1) sshd+dockerd harness 22.04/24.04, bare git over SSH, htpasswd registry, G7 mirror — done
- [x] 11-04 (wave 1) Official fixtures node-api, static-app, failing-build — done
- [x] 11-05 (wave 2) Schema + migration 0005 (composite FK, partial unique index) — done
- [x] 11-06 (wave 2) G1/G2 contract tests + git error captures — done
- [x] 11-07 (wave 2) G3/G4 contract tests + captures — done
- [x] 11-08 (wave 2) Fixtures end-to-end, registry auth, docker error captures — done
- [x] 11-09 (wave 3) ADR 0008 human acceptance (11-09 Task 3), then SUMMARY — done
  - A1 [manual]: User answered the 4 open items: G7 mirror, D-04 wording (kill -s TERM + setsid -w), docker kill branch for builds, HTTPS token measurement
  - A2 [adr-0008-accepted]: ADR 0008 Status reads Accepted with a date
  - SUM [manual]: .planning/phases/11-motor-de-deploy-fundamentos/11-09-SUMMARY.md written (GSD trail kept)
- [x] 11-10 (wave 3) docker ps / container state / BuildKit parsers — done
- [x] 11-11 (wave 3) classifyGitError / classifyDockerError — done
- [x] 11-12 (wave 4) docker_buildkit discovery check + servers.docker_buildkit_available — done
- [x] 11-13 (wave 4) Finish allowlist templates: run real round-trip test (wip 0b88160) on 22.04/24.04, SUMMARY — done
  - A1 [it-deploy-templates]: Plan Tasks 1-3 already committed RED/GREEN (de82491..9abadd7); deploy-templates.test.ts passes on Ubuntu 22.04 and 24.04
  - A2 [it-deploy-templates]: process.group_alive (pgrep -g) proven on the real fixture with a supervised docker build
  - A3 [test]: Every template takes branded types, escapes each argv token, uses -- before positionals; exactness guard and POSIX injection round-trip pass
  - ADR [manual]: Where the GSD plan text contradicts ADR 0008 (kill -s TERM, setsid -w, docker ps --size=false, git exit 128), the ADR wins; differences listed in the SUMMARY under ADR overrides
  - SUM [manual]: .planning/phases/11-motor-de-deploy-fundamentos/11-13-SUMMARY.md written (GSD trail kept)
  - SEC [test]: Secrets (deploy key, token, registry password) are never logged and never reach argv, env, URLs or error messages; streamed output is redacted; per-run test secrets use crypto.randomBytes; canary assertions prove it
- [x] 11-14 (wave 5) Streaming exec, SshDeploySession wiring, killSupervisedOperation, real-fixture proof — done
  - A1 [test]: Line-oriented chunks redacted per chunk (secrets split across chunks or lines never leak), bounded per line UTF-8-safe and in total bytes, abortable, with stdin
  - A2 [test]: Max duration and idle timeout; outcomes completed / timed_out / idle_timeout / aborted distinguished
  - A3 [test]: killSupervisedOperation implements ADR 0008 G2 and reports confirmed only when the group is absent in ps; never throws
  - A4 [it-exec-streaming]: Cancelling a supervised docker build leaves no build process alive on 22.04 and 24.04
  - A5 [manual]: Measured defaults recorded (line cap, total cap, time-to-first-chunk, kill-to-absence)
  - A6 [test]: Existing SshSession fakes and v0.1 behavior unchanged
  - ADR [manual]: Where the GSD plan text contradicts ADR 0008 (kill -s TERM, setsid -w, docker ps --size=false, git exit 128), the ADR wins; differences listed in the SUMMARY under ADR overrides
  - SUM [manual]: .planning/phases/11-motor-de-deploy-fundamentos/11-14-SUMMARY.md written (GSD trail kept)
- [x] 11-15 (wave 6) @noodara/git and @noodara/docker packages (ssh-adapter tag) — done
  - A1 [boundaries]: Packages depend only on @noodara/domain and @noodara/ssh; boundaries green, domain still pure
  - A2 [test]: cloneRepository: prepare workspace, credential via stdin, supervised shallow clone, head SHA, feature probe; LFS/submodules give UNSUPPORTED_REPOSITORY_FEATURE
  - A3 [test]: Docker wrappers call one allowlisted template each via stream, classify with classifyDockerError; registry creds only via --password-stdin into per-deployment --config
  - A4 [test]: No raw strings reach templates; no build args or env vars exposed; no ssh2 import, no env reads
  - SUM [manual]: .planning/phases/11-motor-de-deploy-fundamentos/11-15-SUMMARY.md written (GSD trail kept)
  - SEC [test]: Secrets (deploy key, token, registry password) are never logged and never reach argv, env, URLs or error messages; streamed output is redacted; per-run test secrets use crypto.randomBytes; canary assertions prove it
- [x] 11-16 (wave 7) End-to-end composition proof of all primitives on 22.04 and 24.04 — done
  - A1 [it-engine-primitives]: Manual deploy of node-api composes: SSH clone with per-run deploy key, build noodara/<serviceId>:<deploymentId>, run noodara-<serviceId> on noodara-net-<serviceId>, docker ps observed, deriveServiceStatus RUNNING
  - A2 [it-engine-primitives]: LFS pointer and .gitmodules repos rejected with UNSUPPORTED_REPOSITORY_FEATURE
  - A3 [it-engine-primitives]: failing-build gives BUILD_FAILED and leaves the previous container untouched
  - A4 [it-engine-primitives]: Private registry pull works; wrong password gives REGISTRY_AUTH_FAILED
  - A5 [it-engine-primitives]: Canary secrets absent from ps, .git/config, docker inspect and docker history
  - A6 [it-engine-primitives]: After teardown no noodara.managed or noodara.test=true resource and no /opt/noodara-deploy/<id> remains
  - SUM [manual]: .planning/phases/11-motor-de-deploy-fundamentos/11-16-SUMMARY.md written (GSD trail kept)
  - SEC [test]: Secrets (deploy key, token, registry password) are never logged and never reach argv, env, URLs or error messages; streamed output is redacted; per-run test secrets use crypto.randomBytes; canary assertions prove it

## Phase 12: Motor de deploy — runtime — done
**Goal:** Through the API a person creates project → environment → service (Git, Dockerfile or image, public or private) on a connected server and deploys it in the worker with live build logs, real container state, cancellation that kills the remote process, cleanup on every exit and honest reconciliation; 20 deploys and 20 create/delete cycles leave nothing orphaned.
**Requirements:** PROJ-01, PROJ-02, PROJ-03, PROJ-05, SVC-01, SVC-02, SVC-03, SVC-04, SVC-05, SVC-06, SVC-07, DEP-02, DEP-03, DEP-04, DEP-05, DEP-06, DEP-07, DEP-09, LOG-01, LOG-02, LOG-03, REC-01, REC-03, QA-08
**Depends on:** 11

- [x] 12-01 (wave 1) Domain: project, environment and service inputs — done
  - A1 [test]: Project name and slug derivation (unique-safe, lowercase, collision suffix is the caller's job) and optional description validated into branded types
  - A2 [test]: Environment name validator accepts any valid name; production/staging/development exported as suggestions only, kind stays free text (D23)
  - A3 [test]: Service create/edit input validators for git (url, branch, context, Dockerfile, optional target), image (tag or digest, never implicit :latest), internal port and optional published port; no build-arg or env fields exist (D13)
  - A4 [test]: classifyServiceEdit() pure: says whether an edit changes the source (requires redeploy) or only metadata
  - A5 [test]: >=95% statement and branch coverage on the new validators; domain purity test still green
  - H1 [test]: Git URL validator accepts only https:// and ssh (scp-style or ssh://) after parsing; rejects file:, ext::, git://, http://, javascript:/data:, embedded userinfo credentials, and values starting with '-' or containing whitespace/control chars
  - H2 [test]: Branch, context path and Dockerfile path validators reject '..' segments, absolute paths, leading '-', NUL/newline and over-long values; image ref validator rejects whitespace, leading '-' and malformed digests
  - H3 [test]: Slug derivation handles empty result (all non-ASCII/symbols), Unicode normalization, max length and reserved words with a deterministic fallback; ports validated as integers in 1-65535 and published port not equal to internal-only reserved ports
- [x] 12-02 (wave 1) Domain: runtime policies (resource ledger, port preflight, reconcile diff, post-start polls) — done
  - A1 [test]: Resource ledger records workspace, per-attempt image, network, container and secrets file, and returns the cleanup set for each exit (SUCCESS, FAILED, CANCELLED, timeout, WORKER_CRASHED); the per-service running container is never in a failed attempt's cleanup set
  - A2 [test]: Port preflight rejects collisions with other services on the server, the panel ports and ports in the parsed docker ps snapshot, returning PORT_IN_USE with the conflicting owner
  - A3 [test]: Reconcile diff maps one docker ps snapshot to per-service container states, reports only changed services, and flags containers stopped or removed outside Noodara as discrepancies
  - A4 [test]: Post-start poll schedule is 5 polls with 1 s to 8 s backoff, parameterised, and decides SUCCESS / START_FAILED / keep polling from inspect results
  - A5 [test]: >=95% statement and branch coverage on the four modules
  - H1 [test]: Resource ledger cleanup set is idempotent: computing and executing it twice yields the same set and a second run on already-removed resources is not an error
- [x] 12-03 (wave 2) Domain: build-log chunker and runtime-log sanitizer — done
  - A1 [test]: Chunker flushes on time or size (defaults 250 ms / 16 KB, injected clock), assigns a monotonic seq per deployment and phase
  - A2 [test]: Per-line cap (16 KB) truncates UTF-8-safely with a visible marker; per-phase cap (10 MiB) stops accepting and emits one truncation notice
  - A3 [test]: Sanitizer strips ANSI escapes and replaces binary / invalid UTF-8 with a placeholder; never throws on arbitrary bytes (property test)
  - A4 [test]: No I/O, no timers owned by the module; >=95% coverage
- [x] 12-04 (wave 1) Deploy env knobs and deploy job budget — done
  - A1 [test]: Knobs NOODARA_DEPLOY_MAX_MS, NOODARA_DEPLOY_IDLE_MS, NOODARA_DEPLOY_CONCURRENCY, NOODARA_DEPLOY_LOG_MAX_BYTES, NOODARA_DEPLOY_LOG_FLUSH_MS/BYTES, NOODARA_DEPLOY_LOG_RETENTION_DAYS, NOODARA_RECONCILE_INTERVAL_MS, NOODARA_RUNTIME_LOG_TAIL, NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS with research defaults and range validation
  - A2 [test]: Every knob listed in turbo.json passThroughEnv and documented in .env.example (ADR 0003)
  - A3 [test]: Deploy lock duration and Redis cancel-key TTL derived from NOODARA_DEPLOY_MAX_MS so BullMQ never reaps a live build (unit-tested at min and max)
  - H1 [test]: Cross-knob validation: IDLE_MS <= MAX_MS, FLUSH_BYTES <= per-line cap, LOG_MAX_BYTES >= phase cap; invalid combinations fail boot with a named error without echoing unrelated env values
- [x] 12-05 (wave 1) Activity actions and SSE event surface for projects, services and deployments — done
  - A1 [test]: Activity actions for project, environment, service and deployment lifecycle (incl. out-of-band container change) with metadata allowlists that cannot carry secrets
  - A2 [test]: SSE surface is exactly service.updated, service.deleted, deployment.updated, deployment.log_chunk added to the server events (D22); no project.* or environment.* events
  - A3 [test]: deployment.log_chunk payload is bounded and carries deploymentId, phase, seq; backpressure eviction behaviour of sse-broadcaster unchanged (existing tests green)
- [x] 12-06 (wave 1) HTTPS-token clone contract test and askpass secret slot — done
  - A1 [test]: Askpass helper gets its own secret file name under <ws>/secrets (no longer the known_hosts slot), mode 600, removed with the workspace
  - A2 [it-https-token]: Fixture serves an HTTPS (or HTTP basic-auth) git remote; clone with a token via askpass succeeds on 22.04 and 24.04, wrong token gives REPOSITORY_AUTH_FAILED
  - A3 [it-https-token]: Token absent from ps, .git/config, remote URL and every captured stream
  - A4 [manual]: ADR 0008 open item 4 updated with the measured result
  - SEC [test]: Deploy keys, HTTPS tokens and registry passwords never reach argv, URLs, env-over-SSH, logs, API responses, activity metadata or error messages; every streamed chunk goes through the Redactor; a per-run canary asserts it
- [x] 12-07 (wave 2) Projects and environments API — done
  - A1 [it-projects]: Create, edit, list and read projects (unique name case-insensitive, slug derived) and environments (unique per project); duplicates give a named 409
  - A2 [it-projects]: Archive and unarchive; delete only an archived project by typing its exact name (422 otherwise); the DB cascade covers environments, services, deployments, log chunks and service credentials (remote cleanup arrives in 12-14)
  - A3 [it-projects]: Environment routes reject an environment id from another project (404, no existence leak)
  - A4 [it-projects]: Every mutation writes an activity event; routes behind requireSession and origin guard like servers.ts
  - H1 [test]: Malformed JSON, wrong content-type, unknown fields and oversized bodies on project/environment routes return 400/413/422 and the API keeps serving; name uniqueness race (two parallel creates differing only in case) yields one 201 and one named 409, never a 500
  - H2 [test]: Project and environment endpoints return 401 without session and 403 on cross-origin mutation; unauthenticated requests never reveal whether an id exists
- [x] 12-08 (wave 3) Services API: create, edit, read with derived status and guards — done
  - A1 [it-projects]: Create git and image services only on a CONNECTED server with Docker; Dockerfile (git) services rejected when docker_buildkit_available is false (ADR 0008 G3)
  - A2 [it-projects]: Published port optional and off by default; collisions with other services on the server and the panel ports give PORT_IN_USE at create/edit time
  - A3 [it-projects]: Read returns every SVC-05 field with status from deriveServiceStatus (never a hand-written value); edit flags requiresRedeploy when the source changes
  - A4 [it-projects]: No route accepts a service, environment or server id outside the path's project; covered by a cross-project ownership test
  - A5 [it-projects]: Create and edit write activity events and publish service.updated
  - H1 [test]: Service create/edit routes enforce body cap and reject malformed JSON with explicit 4xx; git URL scheme allowlist and path validators from 12-01 are applied server-side (not only in UI) and violations return a named 422
  - H2 [test]: Port collision check at create/edit is race-safe: two concurrent creates claiming the same published port on one server result in exactly one success (DB-level constraint or lock), the other PORT_IN_USE
- [x] 12-09 (wave 4) Private source credentials and delete-server guard — done
  - A1 [it-projects]: Noodara generates an ed25519 deploy key per service, stores the private half encrypted at rest, returns only the public key
  - A2 [it-projects]: HTTPS token and registry password accepted write-only, encrypted at rest, never returned (responses expose only presence and type)
  - A3 [it-projects]: Credentials are rotated or removed when the source changes and deleted with the service (no orphan credentials rows)
  - A4 [it-delete-server]: Deleting a server with services returns 409 naming the blocking services (PROJ-05)
  - SEC [test]: Deploy keys, HTTPS tokens and registry passwords never reach argv, URLs, env-over-SSH, logs, API responses, activity metadata or error messages; every streamed chunk goes through the Redactor; a per-run canary asserts it
  - H1 [test]: Credential encryption uses authenticated encryption with a fresh random nonce per write; ciphertext tamper is detected on decrypt; deploy keys are generated with node:crypto (no Math.random) and each service gets a distinct key
  - H2 [test]: Credential store never exposes plaintext through toJSON/inspect/error serialization; decrypt failures surface a closed-vocabulary code without ciphertext or key material
  - H3 [test]: Credential inputs are validated server-side: token and registry password length capped, registry host and username validated, request body capped (413) and malformed JSON rejected (400) without echoing the submitted secret
- [x] 12-10 (wave 5) Deploy queue and enqueue / read API — done
  - A1 [it-deploy-queue]: POST /api/services/:id/deploy inserts a QUEUED deployment (source snapshot) and enqueues jobId deploy-<deploymentId>, answering immediately
  - A2 [it-deploy-queue]: A second deploy while one is active returns 409 DEPLOYMENT_IN_PROGRESS via the partial unique index, also under a concurrent race (two parallel POSTs, exactly one 201)
  - A3 [it-deploy-queue]: Archived project blocks deploys with a named error
  - A4 [it-deploy-queue]: GET deployment list per service (paginated, newest first) and detail; payload contains ids only, never secrets
  - H1 [test]: If enqueue fails after the QUEUED insert (Redis down), the deployment is moved to FAILED with a named code or the insert is rolled back; no deployment stays QUEUED without a job; API answers a named 503, not a crash
  - H2 [test]: Deployment list pagination caps page size (upper bound validated) and rejects malformed cursors/limits with 4xx; reading a deployment of another service/project returns 404
  - H3 [test]: Deploy, cancel and other POST routes enforce the Fastify body cap (413) and reject unknown fields (422)
- [x] 12-11 (wave 6) Deploy job core: run-deployment pipeline, deployment store and job handler (unit, fake ports) — done
  - C1 [test]: run-deployment sequences clone→build (or pull)→port preflight→replace container→post-start polls against fake ports, moving status only through the domain state machine; unit-tested per source type
  - C2 [test]: Ledger cleanup runs in finally on SUCCESS, FAILED, timeout (BUILD_TIMEOUT vs BUILD_STALLED) and thrown errors; a failed build never touches the running container; superseded image removed only after the new container runs
  - C3 [test]: Deployment store claims QUEUED→PREPARING atomically under a row lock, records commit SHA, and finishes with service status cache, activity event and service.updated / deployment.updated
  - A6 [test]: Log output goes through an injected sink interface (real sink in 12-12)
  - ERR [test]: SSH, Docker or Git failures surface as a closed-vocabulary code with an actionable message; raw remote stderr never reaches an API response and no remote failure crashes the API or the worker
  - SEC [test]: Deploy keys, HTTPS tokens and registry passwords never reach argv, URLs, env-over-SSH, logs, API responses, activity metadata or error messages; every streamed chunk goes through the Redactor; a per-run canary asserts it
  - H1 [test]: Worker job is idempotent against BullMQ stall/retry: a re-delivered job for a deployment already past QUEUED does not re-run remote commands (attempts 1 or state guard), proven by a stalled-job test
  - H2 [test]: Per-deployment workspace path, image tag and container/network names are built only from validated ids; repo-controlled values (branch, Dockerfile path, git output) are never interpolated into shell strings, proven with hostile names ($(), backticks, ';', leading '-') in a fixture repo
- [x] 12-11b (wave 7) Wire deploy worker and prove the pipeline on the real fixture — done
  - A1 [it-runtime-pipeline]: Worker clones --depth 1 into /opt/noodara-deploy/<deploymentId> (SHA captured), builds noodara/<serviceId>:<deploymentId> with optional target, or pulls the image (registry login via --password-stdin into the per-deployment --config)
  - A2 [it-runtime-pipeline]: Port preflight against real docker ps; then old container replaced by noodara-<serviceId> on noodara-net-<serviceId> with --log-opt max-size/max-file; post-start polls decide SUCCESS or START_FAILED
  - A3 [it-runtime-pipeline]: Statuses move only through the domain state machine (QUEUED→PREPARING→BUILDING→DEPLOYING→SUCCESS/FAILED); service status cache recomputed and service.updated / deployment.updated published
  - A4 [it-runtime-pipeline]: failing-build ends FAILED/BUILD_FAILED with the previous container still running; max vs idle timeout give BUILD_TIMEOUT vs BUILD_STALLED
  - A5 [it-runtime-pipeline]: Ledger cleanup on every exit removes workspace, secrets, partial image and half-created container/network; superseded image removed after the new container runs; images compared by digest or RootFS.Layers, never .Id (ADR 0008)
  - W1 [test]: src/worker.ts starts the deploy BullMQ worker (concurrency NOODARA_DEPLOY_CONCURRENCY, lock from deploy-job-budget, maxStalledCount 0) and closes it in the shutdown sequence
- [x] 12-12 (wave 8) Build log pipeline: redact, persist, publish, resync, retention — done
  - A1 [it-runtime-build-logs]: Every chunk passes the Redactor before persistence, Redis or SSE; a secret split across chunks never leaks
  - A2 [it-runtime-build-logs]: Chunks persisted append-only in deployment_log_chunks with seq, flushed on the 12-03 cadence, capped per line and per phase
  - A3 [it-runtime-build-logs]: deployment.log_chunk reaches an SSE client live during a node-api build; GET /api/deployments/:id/logs?since=<seq> returns only later chunks (no replay)
  - A4 [it-runtime-build-logs]: Retention job deletes chunks older than NOODARA_DEPLOY_LOG_RETENTION_DAYS without touching the deployment rows
  - A5 [it-runtime-build-logs]: A fixture that logs continuously for minutes keeps API RSS and SSE buffers bounded (no eviction of a healthy client); numbers recorded
  - SEC [test]: Deploy keys, HTTPS tokens and registry passwords never reach argv, URLs, env-over-SSH, logs, API responses, activity metadata or error messages; every streamed chunk goes through the Redactor; a per-run canary asserts it
  - H1 [test]: Log persistence failure (DB error) or Redis publish failure is logged without chunk content and does not fail or stall the deployment; seq has a unique constraint per deployment and phase and duplicate inserts are rejected
  - H2 [test]: GET /api/deployments/:id/logs validates since as a non-negative integer, caps page size, requires session and returns 404 for deployments outside the caller's scope
- [x] 12-13 (wave 9) Cancellation and worker-crash sweep — done
  - A1 [it-runtime-cancel]: Cancelling a QUEUED deployment removes the job and ends CANCELLED; it never executes any remote command
  - A2 [it-runtime-cancel]: Cancelling a running build: Redis flag (TTL from 12-04) → killSupervisedOperation (kill -s TERM -- "-$pgid" under setsid -w, ADR 0008) → confirmed absence in ps → channel destroyed → cleanup → CANCELLED; only the worker transitions
  - A3 [it-runtime-cancel]: After cancel no container, partial image, network, volume, workspace or secrets file remains, and docker system df Images/Containers/Local Volumes are unchanged; BuildKit build-cache records are excluded from the comparison (bounded growth only, retention is Phase 14 per ADR 0008)
  - A4 [it-runtime-cancel]: Worker killed mid-build: startup sweep marks FAILED/WORKER_CRASHED, cleans per-deployment resources, never the per-service container
  - ERR [test]: SSH, Docker or Git failures surface as a closed-vocabulary code with an actionable message; raw remote stderr never reaches an API response and no remote failure crashes the API or the worker
  - H1 [test]: Cancel is idempotent and race-safe: cancelling a terminal deployment returns a named 409, a second cancel during CANCELLING is a no-op, and cancel racing with SUCCESS leaves exactly one terminal state
  - H2 [test]: If killSupervisedOperation cannot confirm absence, deployment still ends FAILED/CANCEL_UNCONFIRMED-style named code with cleanup attempted and a warning activity event; the worker does not hang past a bounded timeout
- [x] 12-14 (wave 10) Service operations and deletion: jobs, routes and remote cleanup (unit, fake ports) — done
  - U1 [test]: Redeploy, stop, restart and remove run as timed jobs through the deploy queue, write activity events (via services helpers) and publish service.updated; unit-tested with fake ports
  - U2 [test]: Service delete stops and removes container, network, own images and workspace, then credentials and rows, publishing service.deleted; archived-project delete runs the same cleanup per service before the DB cascade; unit-tested with fake ports
  - U3 [it-projects]: Operations and deletes on a service with an active deployment return 409 DEPLOYMENT_IN_PROGRESS
  - ERR [test]: SSH, Docker or Git failures surface as a closed-vocabulary code with an actionable message; raw remote stderr never reaches an API response and no remote failure crashes the API or the worker
  - H1 [test]: Service delete is resumable and idempotent: a failure midway (SSH drop) leaves the service row with a named error and re-running the delete completes cleanup without errors on already-removed resources
  - H2 [test]: Delete confirmation compares the exact name server-side; wrong/missing confirmation returns 422 and performs no remote command
  - H3 [test]: Service operation and delete routes enforce the body cap (413), validate the confirmation field length and reject unknown fields (422)
- [x] 12-14b (wave 11) Prove service operations and deletion on the real fixture — done
  - A1 [it-runtime-service-ops]: Redeploy, stop, restart and remove are timed jobs that write activity events and publish service.updated
  - A2 [it-runtime-service-ops]: Deleting a service (exact name) stops and removes its container, network, own images and workspace, then its credentials and rows; service.deleted published
  - A3 [it-runtime-service-ops]: Deleting an archived project runs the same remote cleanup for every service before the DB cascade; an unreachable server leaves a named error, not orphaned rows pointing nowhere
  - A4 [it-runtime-service-ops]: Operations on a service with an active deployment return 409 DEPLOYMENT_IN_PROGRESS
- [x] 12-15 (wave 12) Reconciliation tick — done
  - A1 [it-runtime-reconcile]: Repeatable job every NOODARA_RECONCILE_INTERVAL_MS runs one docker ps --size=false per CONNECTED server, never per service, with commandMs timeout
  - A2 [it-runtime-reconcile]: Changed container state updates the cached service status and emits service.updated; unchanged state emits nothing
  - A3 [it-runtime-reconcile]: A container stopped or removed outside Noodara shows in the next tick and writes one activity event (no repeat on later ticks)
  - A4 [it-runtime-reconcile]: An unreachable server marks its services UNKNOWN, never STOPPED, and does not crash the tick for other servers
  - H1 [test]: Reconcile ticks never overlap (a slow tick delays the next rather than running concurrently) and skip services with an active deployment so they cannot overwrite in-flight status
- [x] 12-16 (wave 12) Runtime logs on demand — done
  - A1 [it-runtime-container-logs]: GET tail returns the last N lines (default NOODARA_RUNTIME_LOG_TAIL, upper bound validated) with timestamps
  - A2 [it-runtime-container-logs]: Follow is a dedicated bounded stream (not a new global SSE type) that ends at NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS and when the client disconnects, killing the remote docker logs
  - A3 [it-runtime-container-logs]: Output is redacted and sanitized (ANSI, binary) and never persisted
  - ERR [test]: SSH, Docker or Git failures surface as a closed-vocabulary code with an actionable message; raw remote stderr never reaches an API response and no remote failure crashes the API or the worker
  - H1 [test]: Concurrent follow streams are capped per server and per user with a named 429/409; tail validates N as a positive integer within the upper bound and rejects other values with 4xx
- [x] 12-17 (wave 13) Leak canaries for the deploy engine — done
  - A1 [it-canary-deploy]: Canaries for git-URL token, deploy key, registry password and a fixture build that prints a canary
  - A2 [it-canary-deploy]: Absence asserted in build logs, deployment_log_chunks, SSE stream, activity_events.metadata, every API response, docker inspect, docker history and the remote .git/config
  - A3 [manual]: pnpm security:scan-leaks includes the new file
  - SEC [test]: Deploy keys, HTTPS tokens and registry passwords never reach argv, URLs, env-over-SSH, logs, API responses, activity metadata or error messages; every streamed chunk goes through the Redactor; a per-run canary asserts it
- [x] 12-18 (wave 13) QA-08 soak: 20 deploys and 20 create/delete cycles — done
  - A1 [it-soak]: 20 consecutive node-api deployments complete SUCCESS
  - A2 [it-soak]: 20 service create/delete cycles leave no container, network, image or workspace; docker system df equal before and after, twice in a row without manual prune
  - A3 [manual]: Nightly runs the soak on 22.04 and 24.04 (NOODARA_SOAK=1) and fails on any surviving noodara.test=true resource
  - H1 [manual]: Soak records per-iteration duration and docker system df before/after to an artifact so leak regressions are visible, and fails when any iteration exceeds the deploy max timeout
- [x] 12-19 (wave 14) Measured defaults, docs and phase verification — done
  - A1 [manual]: Measured numbers recorded for every knob (flush, line and phase caps, reconcile interval and cost, timeouts, post-start polls, log tail/follow) with fixture and Ubuntu version
  - A2 [manual]: docs/deploy-engine.md describes the API surface, statuses, error codes and knobs in under two pages
  - A3 [manual]: ADR 0008 open item 6 closed with a green amd64 CI run of tests/integration/deploy-engine
  - A4 [manual]: Phase 12 requirements ticked in REQUIREMENTS.md and ROADMAP.md

## Phase 13: UI de Projects & Services y E2E de deploy — done
**Goal:** From the UI a person creates project, environment and service, deploys it watching the build narrated step by step and live logs in the inspector, sees the real container state, recovers from a failure with an actionable hint, and the critical Playwright E2E proves it against real fixtures.
**Requirements:** LOG-04, REC-02, QA-09, DOCS-01
**Depends on:** 12

- [x] 13-01 (wave 1) API: delete environment with exact-name confirmation — done
  - A1 [test]: DELETE /api/projects/:projectId/environments/:environmentId requires the exact environment name in the body; a mismatch is 422 like project delete, an unknown or foreign-project id is 404
  - A2 [test]: Deleting an environment that still has services is rejected with 409 ENVIRONMENT_NOT_EMPTY and changes nothing; an empty environment is deleted and environment.deleted is written to the activity log
  - A3 [it-projects]: Integration test in tests/integration/projects covers success, name mismatch, non-empty, foreign project and unauthenticated cases
  - A4 [manual]: error-codes.mdx and docs/deploy-engine.md list the new route and ENVIRONMENT_NOT_EMPTY
  - H1 [test]: Environment delete is race-safe: a service created concurrently with the delete never leaves an orphan service row; either the delete returns 409 ENVIRONMENT_NOT_EMPTY or the create returns 404, never a 500 or dangling environment_id (check and delete in one transaction or under a row lock).
  - H2 [test]: Environment delete route rejects malformed JSON, missing name field, unknown fields and oversized bodies with 400/413/422 and the API keeps serving; it requires a session (401) and passes the origin guard (403 cross-origin), and the 404/422 responses do not reveal whether an id exists in another project.
- [x] 13-02 (wave 1) Events: updatedAt on service.updated and deployment.updated — done
  - A1 [test]: ServiceEventView and DeploymentEventView carry updatedAt (ISO string) equal to the row updated_at written in the same transaction as the change they announce
  - A2 [test]: Every publisher of service.updated / deployment.updated passes the post-write updatedAt; a unit test fails if an event is built without it
  - A3 [test]: The SSE type set stays at the four deploy-engine types (D22); no new event type is added
  - A4 [it-runtime-reconcile]: runtime-reconcile integration test asserts updatedAt on a reconcile-driven service.updated is >= the snapshot GET value
  - H1 [test]: updatedAt on events is monotonic per entity: two rapid writes to the same service or deployment never publish an older updatedAt after a newer one, and the event payload carries no fields beyond the existing allowlisted view (no secrets, no errorMessage raw text).
- [x] 13-03 (wave 1) Deployment step timeline: clone, build, start, verify — done
  - A1 [test]: Pure domain function deriveDeploymentSteps() returns exactly four steps (clone|pull, build, start, verify) each with state pending|running|success|failed|cancelled|skipped and startedAt/completedAt; image sources show pull and skip build; >=95% statement and branch coverage
  - A2 [test]: A versioned migration adds nullable step timestamps to deployments; the worker records each step boundary in the same write as the status transition, so a crash never leaves a step running without a status that explains it
  - A3 [test]: GET deployment views expose steps[] derived by the domain function; a failed deploy marks the failing step failed and later steps pending, a cancel marks the running step cancelled
  - A4 [it-runtime-pipeline]: runtime-pipeline integration test asserts four ordered steps with non-null durations on a node-api success and failed build step on failing-build
  - H1 [test]: Step timestamps are written only through the domain state machine transition and a single DB write: a concurrent cancel and success leave step timestamps consistent with the one terminal status (no step left running on a terminal deployment); the migration is additive with nullable columns, applies cleanly on a DB with existing deployments, and old rows derive steps without throwing.
  - H2 [test]: deriveDeploymentSteps is total over every deployment status and error code combination (property test over all statuses x source types): never throws, always returns exactly four steps in fixed order, and durations are never negative when clocks are skewed or completedAt precedes startedAt.
  - H3 [it-runtime-pipeline]: The migration is additive and reversible-safe: existing deployments keep null step timestamps, deriveDeploymentSteps returns a valid timeline for them from status alone, and boot on a database migrated mid-deploy never fails
- [x] 13-04 (wave 1) Web: build-log fold by (phase, seq) over snapshot — done
  - A1 [test]: Pure foldBuildLog(state, input) merges GET pages and SSE deployment.log_chunk events ordered by phase (prepare, build, deploy) then seq, dropping duplicates and never reordering already-shown text
  - A2 [test]: A gap in seq marks the state as needing resync with the exact (phase, since) cursor for GET /logs; a chunk older than the cursor is ignored (no replay)
  - A3 [test]: Truncated SSE chunks are replaced by the full GET chunk with the same (phase, seq)
  - A4 [test]: Property-style tests shuffle arrival order of snapshot pages and events and always converge to the same text; >=95% branch coverage
  - H1 [test]: foldBuildLog is bounded: total retained text is capped (matching the server per-phase cap) with a visible truncation marker, a pathological flood of chunks or a gap that never resolves does not grow memory unbounded or loop on resync, and malformed chunk input (negative seq, non-integer, unknown phase) is dropped without throwing.
  - H2 [test]: Log text is treated as inert data: chunk content containing ANSI/escape sequences, HTML or script tags and secret-looking canary strings is preserved verbatim as text by the fold and never interpreted, and the fold never logs chunk content.
- [x] 13-05 (wave 1) Web: typed API client for projects, environments, services, deployments, logs — done
  - A1 [test]: deploy-api.ts exposes typed calls for every route in docs/deploy-engine.md used by the UI, built on the existing api-client error model; response types come from the control-plane schemas, not re-declared by hand
  - A2 [test]: Credential calls are write-only: no client function or type reads a secret value back; tests assert the PUT body is never logged or kept in state
  - A3 [test]: runtime-log-stream.ts reads the NDJSON follow stream with an AbortController, stops on abort, server end or RUNTIME_LOG_FOLLOW_LIMIT_REACHED and surfaces RUNTIME_LOGS_* codes as typed errors; tested with MSW
  - A4 [test]: Every call has an explicit timeout; a network failure resolves to a typed error, never an unhandled rejection
  - H1 [test]: api-client never forwards or logs secrets: request bodies of credential calls are excluded from any error object, thrown message, console output and retry/telemetry payloads, and an error response echoing the submitted secret is not surfaced to callers (canary test).
  - H2 [test]: Mutating calls send credentials: same-origin cookies and the origin-guard-compatible headers, and a 401 from any call resolves to the existing session-expired handling instead of being retried or swallowed; non-idempotent POSTs (deploy, cancel) are never auto-retried on timeout.
  - H3 [test]: runtime-log-stream is bounded and safe: a partial NDJSON line split across reads is reassembled, a malformed line is skipped without ending the stream, a line over a client cap is truncated, total buffered lines are capped, and the reader is released (reader.cancel) on abort, server end and error with no leaked connection.
- [x] 13-06 (wave 1) E2E stack: deploy host, git host and registry for Playwright — done
  - A1 [test]: The e2e stack can start the deploy-engine host (sshd + dockerd, git host with node-api and failing-build repos, pinned-digest registry mirror) by reusing tests/integration/helpers/deploy-engine.ts, never a second copy of its setup
  - A2 [test]: Specs get a handle exposing the SSH connection data, repo URLs and an exec() into the deploy host to curl the published port and list containers, images, networks and workspaces
  - A3 [test]: Teardown stops every container it started even when a spec fails; existing specs keep starting only what they used before (no deploy host unless requested)
  - A4 [e2e-deploy-host]: A smoke spec starts the deploy host, runs docker info inside it and tears down cleanly
  - H1 [e2e-deploy-host]: Deploy host teardown is leak-free and idempotent: running global-teardown twice, or after a crashed setup, removes every container, network and volume carrying the e2e label without erroring, only touches resources it created (run-scoped label, never a host-wide prune), and uses per-run randomly generated credentials for the registry and SSH keys that are not written to the repo or test logs.
  - H2 [e2e-deploy-host]: The deploy host handle has a bounded startup timeout and a readiness check (sshd, dockerd, git host and registry all answering) before specs run; a failure to start fails the run with a named error instead of hanging, and exec() has a per-call timeout and returns exit code and redacted output.
  - H3 [test]: Per-run SSH keys, registry htpasswd and git token come from crypto-grade generators in the shared helper, never fixed literals, and are written only to the run temp dir
- [x] 13-07 (wave 1) CI debt: @rowmenu 440x956 and a11y-fallbacks reduced-motion flake — done
  - A1 [test]: Root cause of the @rowmenu 440x956 failure is reproduced by a failing test first and documented in the commit body; the fix is in product code unless the test assumption is proven wrong
  - A2 [e2e-servers]: servers-list.spec.ts and a11y-fallbacks.spec.ts pass 10 consecutive runs locally with a fresh stack
  - A3 [test]: No retry, timeout bump or skip is added to hide the failure
  - H1 [e2e-servers]: The fix introduces no viewport-specific hack or layout change at other breakpoints: the RowMenu stays operable by keyboard and pointer at 440x956 and at 375, 900 and 1280 widths, the menu is not clipped by overflow containers, and the focus trap/return and Escape behavior from Phase 8 still pass.
- [x] 13-08 (wave 2) Web: deploy-engine events and shared sequence reconciliation — done
  - A1 [test]: The frame parser accepts the four deploy-engine types and drops malformed frames like it does for server types
  - A2 [test]: One generic pure reconcile function keyed by id + updatedAt is used by both the server store and the new service/deployment stores; reconcileSnapshot for servers keeps its tests green on top of it (REC-02: same function)
  - A3 [test]: Reorder tests: for every permutation of (snapshot in flight, updated event, deleted event) the final state equals the newest write; an event never regresses a newer snapshot and a delete is never resurrected
  - A4 [test]: The shell keeps exactly one EventSource; log chunks are routed to subscribers by deploymentId and never stored for deployments nobody is viewing
  - H1 [test]: Event stream resilience: after an EventSource reconnect the shell refetches service and deployment snapshots and reconciles them with the same function, an event for an unknown id or with a missing/invalid updatedAt is ignored or triggers a refetch without crashing, and a deployment.log_chunk for an unsubscribed deployment is dropped without allocating per-deployment state.
  - H2 [test]: Log subscriptions are cleaned up: unsubscribing (unmount, navigation, inspector close) removes the handler so no chunk is delivered or retained afterwards, and subscribe/unsubscribe over 1000 cycles leaves zero registered handlers (leak test).
- [x] 13-09 (wave 3) Shell: Projects hierarchy in the sidebar and projects list — done
  - A1 [test]: Sidebar NavTree shows Projects -> Environment -> Service as a hierarchy with Servers, Activity and Settings as peers; active path is highlighted and keyboard navigation works as in Phase 8
  - A2 [test]: Projects list with a create sheet (name, optional description; slug shown as derived); archived projects are visually separated and say they reject deploys
  - A3 [test]: Empty state teaches the hierarchy in one sentence and offers one primary action; no coming-soon copy and no env vars mention beyond the stated v0.2 limit
  - A4 [test]: The sidebar updates live from service.updated/service.deleted events without a reload
  - H1 [test]: Project and service names rendered in the sidebar, list and sheet are escaped as text (a name like <img onerror=...> or a very long name with no spaces renders inert and truncated with the full name in a tooltip/accessible label), and the create sheet submit is disabled while pending so a double click sends one POST and a server 409 duplicate name shows in place.
  - H2 [test]: Sidebar live updates are bounded and correct: a service.deleted for the currently active route navigates to the project view with a notice instead of a broken page, and a burst of 200 service.updated events renders without re-rendering unaffected tree branches beyond the changed node.
  - A5 [test]: The Activity page passes project and service lookups to ActivityRow (13-15), so rows for existing projects and services link to them and rows for deleted ones stay plain text
- [x] 13-10 (wave 4) Project and environment management with exact-name confirmation — done
  - A1 [test]: Project view lists environments and their services; create environment suggests production, staging, development and accepts any valid name, showing the server-side validation error in place
  - A2 [test]: Edit project, archive, unarchive and delete (archived only) are available; delete and environment delete require typing the exact name using confirm-match from packages/ui
  - A3 [test]: Deleting a non-empty environment shows the ENVIRONMENT_NOT_EMPTY recovery (remove its services first), never a raw error
  - A4 [test]: ConfirmByNameDialog is generic and reused by service delete in 13-12
  - H1 [test]: Destructive dialogs are safe: ConfirmByNameDialog keeps the confirm button disabled until the exact name matches (case and whitespace sensitive), submits once, is dismissed by Escape, returns focus to the trigger, and the typed value is never put in the URL; a 404 on delete (already deleted elsewhere) is treated as done and refreshes the list.
  - H2 [test]: Environment and project form errors map server 409/422 codes to field-level messages in place, never raw server text, and the form state survives a failed submit so the user's input is not lost.
- [x] 13-11 (wave 4) Service create and edit: source control, server picker, private credentials — done
  - A1 [test]: Segmented control Git / Dockerfile / Image switches the fields; validation reuses @noodara/domain validators client-side and shows the server error when they disagree
  - A2 [test]: Server picker lists only CONNECTED servers with Docker available; other servers are absent, and an empty picker explains how to connect one
  - A3 [test]: Repo token / SSH key / registry password are write-only inputs: after saving the UI shows only configured/not configured with replace and remove, the value is cleared from state and never rendered, logged or put in the URL
  - A4 [test]: No env var or build arg fields exist; the sheet states the v0.2 limit once (variables arrive later) without coming-soon wording
  - A5 [test]: Editing the source shows that a redeploy is needed before the change takes effect (classifyServiceEdit)
  - H1 [test]: Credential fields: after save or on cancel/sheet close the secret is removed from React state, form defaults and any persisted draft (no localStorage/sessionStorage/URL), inputs use autocomplete=off and type=password, the field is not included in error reports, and a failed save does not echo the submitted value in the UI error.
  - H2 [test]: Client-side validation mirrors the server allowlist for git URLs: https:// and ssh forms are accepted and file:, ext::, git://, http://, javascript:, embedded userinfo, leading '-' and path '..' are rejected inline before any request is sent, and the SSH deploy-key flow shows only the public key with a copy action.
  - H3 [test]: Create/edit submit prevents duplicate submissions (disabled while pending, single POST on double click) and a server PORT_IN_USE or BUILDKIT_UNAVAILABLE-style error is mapped to the relevant field with an actionable hint.
- [x] 13-12 (wave 5) Service view: derived status, Deploy, history and operations — done
  - A1 [test]: Status pill shows the derived status (running, stopped, deploying, failed, never_deployed) and UNKNOWN honestly with what it means; never a stored value
  - A2 [test]: Exactly one primary action, Deploy; redeploy, stop, restart, remove container and delete service live in the overflow menu; delete requires the exact service name
  - A3 [test]: An active deployment shows Cancel; DEPLOYMENT_IN_PROGRESS and DEPLOYMENT_NOT_CANCELLABLE show their recovery copy
  - A4 [test]: Deployment history lists status, trigger, short commit SHA (mono), duration and relative time, paginated by cursor, and updates live from deployment.updated
  - A5 [test]: Archived project: Deploy is disabled with the reason stated
  - H1 [test]: Action safety: Deploy and overflow actions are disabled while a request is pending so a double click enqueues exactly one deployment, and a 409 DEPLOYMENT_IN_PROGRESS from a race refreshes state instead of showing an error toast loop; cancel is available only while the deployment is cancellable and a second click is a no-op.
  - H2 [test]: Deployment history pagination handles an invalid or expired cursor by resetting to the first page, merges deployment.updated events by id without duplicating rows across pages, and the commit SHA and trigger values from the server are rendered as inert text.
  - A6 [test]: ServiceSheet (13-11) is reachable: the project view has a New service action per environment that opens it in create mode, and the service view has Edit that opens it in edit mode; after save the lists update without reload
- [x] 13-13 (wave 6) Deploy narration and classified errors — done
  - A1 [test]: Narration shows clone (or pull), build, start, verify with per-step state and duration, reusing the DiscoveryStep visual treatment (extracted, not copied)
  - A2 [test]: Every DEPLOYMENT_ERROR_CODES value maps to a title and an actionable recovery; a test fails if a code is added without copy
  - A3 [test]: errorMessage from the server is never rendered as raw text; only the classified copy and, when present, the sanitized last build log lines in the inspector
  - A4 [test]: Reduced motion: the running-step indicator does not animate
  - H1 [test]: Unknown or future error codes fall back to a generic classified copy with a safe recovery (never undefined, never the raw errorMessage), and sanitized last build log lines shown with an error are length-capped, rendered as text and pass through a client-side secret-pattern guard that masks canary secrets even if the server missed them.
  - A5 [test]: The service view renders DeploymentSteps for the latest or selected deployment and updates it live from deployment.updated
- [x] 13-14 (wave 6) Inspector: live build logs and on-demand runtime logs — done
  - A1 [test]: Build logs open in the @inspector parallel-route slot (not a modal) for the selected deployment: GET snapshot first, then SSE chunks folded with foldBuildLog; reload mid-build shows the same text without replay
  - A2 [test]: Monospace, auto-scroll while at bottom, Jump to bottom appears when the user scrolls up; ANSI is already sanitized server-side and rendered as text only (no innerHTML)
  - A3 [test]: Runtime logs load on demand with a tail selector and a Follow toggle using runtime-log-stream; follow stops on navigation, toggle off and server limit, and says why
  - A4 [test]: Inspector closes with Escape and returns focus; at 375 px it becomes a full-height sheet; with no selection the slot stays zero width as in Phase 8
  - H1 [test]: Log panels are bounded in the DOM: the build log keeps a capped number of rendered lines (virtualized or windowed) with a visible truncated notice, a flood of 100k lines keeps the main thread responsive (no per-chunk full re-render), and opening/closing the inspector 50 times leaves no live EventSource subscription, stream reader or timer.
  - H2 [test]: Runtime follow lifecycle: leaving the page, toggling Follow off, changing tail, or unmount aborts the fetch and the server-side docker logs is terminated; a 429 or capacity error for concurrent follow streams shows its typed recovery copy and the Follow toggle returns to off; a server limit reached message states the reason once.
  - H3 [test]: Inspector selection comes from the route (deployment id in the URL), a deployment id outside the caller's scope or that no longer exists renders a not-found state without a thrown error or infinite loading, and the panel does not leak the previous deployment's text when the selection changes.
  - A5 [test]: Selecting a deployment in the history opens its build logs in the inspector, and the service toolbar has a Logs action that opens runtime logs
- [x] 13-15 (wave 2) Activity copy for project, environment, service and deployment actions — done
  - A1 [test]: Every action in PROJECT_ACTIONS, ENVIRONMENT_ACTIONS, SERVICE_ACTIONS, DEPLOYMENT_ACTIONS and DEPLOY_ENGINE_ACTIONS has human copy; a test iterates the domain arrays and fails on any missing action
  - A2 [test]: Rows link to the project or service when it still exists and render plain text when it was deleted
  - H1 [test]: Activity copy renders names and metadata as text only and tolerates missing, null or unexpected metadata keys and unknown actions with a generic fallback row (never throws or shows raw JSON), and links to a project or service are built only from validated ids (never from metadata strings) with no open-redirect or javascript: hrefs.
- [x] 13-16 (wave 7) E2E critical deploy path (QA-09) — done
  - A1 [e2e-deploy]: Playwright creates project -> environment -> service from node-api through the UI, deploys, sees live build logs in the inspector and the four steps succeed
  - A2 [e2e-deploy]: The service answers on its published port (curl from inside the deploy host returns the node-api JSON)
  - A3 [e2e-deploy]: A failing-build service ends FAILED with the BUILD_FAILED copy and recovery visible, and the previously running container of the first service is untouched
  - A4 [e2e-deploy]: Cancelling an in-progress build ends CANCELLED and the deploy host has no leftover noodara containers, images, networks or workspaces for it
  - A5 [e2e-deploy]: Ownership: a service id from project A requested under project B is not found in the UI and API
  - A6 [e2e-deploy]: Runs in the CI main workflow and in nightly e2e-repeat; 20/20 locally with pnpm test:e2e:repeat before close
  - H1 [e2e-deploy]: Test hygiene: E2E credentials, deploy keys and registry passwords are generated per run with crypto.randomBytes, never committed, and a canary secret entered in the service form and used in a clone/registry login is asserted absent from the page DOM, console logs, network responses, Playwright trace/HAR artifacts, and the uploaded CI artifacts.
  - H2 [e2e-deploy]: The e2e deploy spec is deterministic: it waits on observable UI state (step statuses, SSE-driven updates) rather than fixed sleeps, uses a bounded per-test timeout below the CI job timeout, cleans up its created project/services in afterEach even on failure, and passes with Playwright retries disabled.
  - H3 [e2e-deploy]: The cancel scenario also asserts the cancelled deployment's build process is gone from ps on the deploy host (not only that Docker resources are absent), and that reloading the page mid-build shows the same log text with no duplicated or lost lines.
- [x] 13-20 (wave 7) UI fixes from the Phase 13 DoD review — done
  - A1 [test]: Light theme: the active NavTree item and every error/notice caption on the new screens meet WCAG AA 4.5:1; NavTree no longer emits both text-ink and text-ink-secondary on the active item; the runtime "no container yet" notice uses neutral, not error, color
  - A2 [test]: Sheet returns focus to the element that opened it when closed by Escape, Cancel or overlay click, also when used controlled without a Trigger
  - A3 [test]: Service names in the project page truncate with ellipsis and keep a readable minimum width when the repository URL is very long; the full name stays available (title or tooltip)
  - A4 [test]: Service facts show "Last changed" as relative time only, never a raw ISO string; the deployment step timeline connector does not cross step icons
  - A5 [manual]: Fixes follow noodara-ux-apple tokens; no new colors, shadows or gradients
- [x] 13-17 (wave 8) UI DoD for new screens and screenshot approval — done
  - A1 [e2e-dod]: Measured contrast meets the design-system thresholds on every new screen in both themes
  - A2 [e2e-dod]: Projects, project, service, create sheets and inspector render without horizontal scroll or clipping at 375, 900, 1280 and 1920 px in light and dark
  - A3 [e2e-dod]: Reduced motion removes non-essential animation on the new screens
  - A4 [manual]: noodara-ux-review report for the new screens has no BLOCK; screenshots in both themes are saved under docs/ui-review/ and the user approved them
  - H1 [e2e-dod]: Every interactive element on the new screens is keyboard reachable in logical order with a visible focus ring, dialogs and sheets trap focus and restore it on close, status is conveyed by text or icon and not color alone, and an axe scan on each new screen in both themes reports zero serious or critical violations.
  - H2 [e2e-dod]: Long content stress: a project name of 200 characters, a service with a 300-character repo URL, and a 10,000-line build log render without horizontal page scroll or overlapping at 375 px, in both themes.
  - A5 [e2e-dod]: brand.spec.ts reflects the Projects nav entry from 13-09 (4 sidebar links) and the full pnpm test:e2e run is green
- [x] 13-18 (wave 8) Docs: first deploy guide — done
  - A1 [test]: first-deploy.mdx walks project -> environment -> service -> deploy -> logs with the exact UI labels, states the v0.2 limits (no env vars or build args, stop-then-start downtime) without coming-soon wording
  - A2 [build]: 'deploy-services' is removed from the scope exclusions and the site builds
  - H1 [test]: first-deploy.mdx is verified against reality: every UI label quoted in the guide exists in the web source (a test greps the labels), internal links resolve, code blocks contain no real-looking secrets or tokens (placeholders only), and the page appears in meta.json navigation order and in the site search index.
- [x] 13-21 (wave 8) Navigate to the new project or service after create — done
  - A1 [test]: Creating a project closes the sheet and navigates to /projects/<newId>; creating a service navigates to /projects/<pid>/services/<newId>; editing keeps the user where they are
  - A2 [test]: Navigation happens only after the create response succeeds; a failed create keeps the sheet open with the input intact
  - A3 [test]: The sidebar shows the new project or service without reload, and focus lands on the new page heading
  - A4 [e2e-deploy]: deploy.spec.ts follows the new flow (no clicking the new row after create) and passes
- [x] 13-22 (wave 8) Deterministic @sheet-drag re-grab mid-close E2E — done
  - A1 [manual]: Root cause of the e2e-repeat iteration 11 failure (server-sheet.spec.ts:587, re-grab offset 266 > 200) is identified and written in the commit body: test timing assumption or a real product bug in re-grab tracking
  - A2 [e2e-sheet]: The spec drives the mid-close state deterministically (e.g. waits on the panel position or a frame count, not wall-clock); no threshold bump, retry, timeout increase or skip
  - A3 [test]: If the product re-grab tracking is wrong, a unit test reproduces it first and the fix keeps 1:1 tracking from the on-screen position
  - A4 [e2e-sheet]: server-sheet.spec.ts @sheet-drag passes 30 consecutive runs locally
- [x] 13-23 (wave 8) Monotonic clock in ssh contracts elapsed measurement — done
  - A1 [it-ssh-contracts]: attemptConnect measures elapsedMs with performance.now() (monotonic) instead of Date.now(), so a wall-clock adjustment cannot report 4991 ms for a 5000 ms readyTimeout; assertions and thresholds unchanged
- [x] 13-19 (wave 9) Phase 13 verification and requirement close-out — done
  - A1 [it-full]: pnpm test:integration and pnpm test:e2e are green with port 3000 free; LOG-04, REC-02, QA-09 and DOCS-01 are marked complete with evidence
  - A2 [manual]: OPEN_QUESTIONS 4-6 and the 13 assumptions are either confirmed by the user or still listed as open
  - H1 [test]: Phase close-out leaves no skipped or quarantined tests: a grep of apps/, packages/ and tests/ for .skip, .only, test.fixme and retries added in phase 13 returns nothing without a linked justification, and pnpm security:scan-leaks passes including any new phase 13 spec.
  - H2 [manual]: A final pnpm test:e2e:repeat run (20/20) and pnpm lint, typecheck and boundaries are recorded with command output in the SUMMARY, and docs/deploy-engine.md route list matches the registered Fastify routes (a check fails if a route exists without documentation).

## Phase 14: Hardening y gate de release v0.2 — done
**Goal:** v0.1 operators stop paying owed debt (unbounded logs, piling .env backups, a 1.2 GB image, POSIX scanner false positives), the Phase 12/13 security and UI debt is closed, and v0.2.0 ships after a READY gate against roadmap §7.8 on a real VPS.
**Requirements:** OPS-01, OPS-02, OPS-03, OPS-04
**Depends on:** 13

- [x] 14-01 (wave 1) Compose: log rotation on every production service — done
  - A1 [test]: All six services in docker-compose.yml (postgres, redis, migrate, api, worker, web) declare logging driver json-file with max-size and max-file, through one shared YAML anchor
  - A2 [test]: A unit test parses docker-compose.yml and fails if any service lacks the logging block or the limits differ from the documented values
  - A3 [it-cp-image]: compose-stack.test.ts asserts via docker inspect that a running api container has the configured LogConfig
  - A4 [manual]: docs/install.md says where logs live and their size bounds
  - H1 [test]: Log limits are bounded values (max-size and max-file are positive, max-size in the documented range) and the postgres and redis services keep their existing healthchecks and volumes unchanged by the logging block; the unit test fails on a missing or empty logging.options
- [x] 14-02 (wave 2) Installer: prune .env.bak-* keeping the newest N — done
  - A1 [test]: After writing a backup, the installer deletes older .env.bak-* files next to .env and keeps the newest N (default 5, overridable by NOODARA_ENV_BACKUPS_KEEP, validated as a positive integer)
  - A2 [test]: Pruning only matches <env path>.bak-<14 digits>; files with other names, symlinks and directories are never removed
  - A3 [installer]: idempotent-rerun.test.ts runs more than N upgrades and asserts exactly N backups remain, each mode 600, and the newest one matches the pre-upgrade .env
  - A4 [posix-sh]: The code stays POSIX sh and pnpm check:posix-sh passes
  - H1 [test]: The backup is written atomically with mode 600 from creation (umask set before write, or temp file then rename), and a failure of the prune step (unreadable dir, rm error) never aborts the upgrade nor deletes the freshly written backup or .env
  - H2 [test]: NOODARA_ENV_BACKUPS_KEEP values of 0, negative, non-numeric, empty or with whitespace/shell metacharacters fall back to a clear error or the default 5 without running rm, and file names with spaces or leading '-' are handled safely (rm -- with quoted paths, no word splitting)
  - H3 [test]: Pruning orders backups by the 14-digit timestamp in the name, not by mtime, so a touched or restored older backup is not kept over a newer one; same-second duplicates do not collide
- [x] 14-03 (wave 1) check-posix-sh: remove false positives with regression tests — done
  - A1 [test]: $(( )) arithmetic expansion, the [[:space:]] POSIX character class, $' inside comments and (( inside heredoc bodies are not reported; each case has its own regression test
  - A2 [test]: The real bashisms are still reported: [[ ]] tests, (( )) arithmetic commands, $'...' outside comments, arrays, local, $EUID; each has a test that keeps failing
  - A3 [test]: The scanner's output format and exit codes do not change (ci.yml keeps using it unchanged)
  - H1 [test]: The scanner never throws or hangs on empty files, files without trailing newline, unterminated heredocs, quoted heredoc delimiters (<<'EOF', <<-EOF) and CRLF input; unterminated heredocs are reported as a finding, not silently treated as comment text, and a bashism after the heredoc terminator is still reported
  - H2 [test]: A real bashism on the same line as a suppressed pattern (for example $(( )) followed by [[ ]] or a trailing comment containing $') is still reported, so the false-positive fixes cannot mask real findings
- [x] 14-04 (wave 3) install.sh: retire the check-posix-sh workarounds — done
  - A1 [manual]: The workarounds documented in install.sh (awk division instead of $(( )), ((-substring avoidance in heredocs, [:space:] avoidance) are replaced with the direct POSIX form, and the comments that justify them are removed
  - A2 [installer]: pnpm check:posix-sh passes on the new install.sh and the full installer suite is green on 22.04 and 24.04
  - H1 [test]: After removing the workarounds, install.sh arithmetic and character-class behavior is verified on dash (the 22.04/24.04 /bin/sh) with a unit test that executes the changed expressions, including empty/zero/non-numeric operands, rather than only passing the static scan
- [x] 14-05 (wave 2) Control-plane image under 600 MB without breaking module resolution — done
  - A1 [manual]: The runner stage ships only production dependencies plus compiled dist (pnpm deploy --prod or an equivalent), not the whole pruned workspace
  - A2 [it-cp-image]: control-plane-image.test.ts fails if the image is 600 MB or larger (docker image inspect Size) and records the measured size
  - A3 [it-cp-image]: The four entrypoints (api dist/server.js, worker dist/worker.js, migrate dist/db/migrate.js, CLI dist/cli/index.js) start from the new image and the argon2 native binding loads on the image's own architecture
  - A4 [manual]: ADR 0003 records the new runtime layout and the measured size before and after
  - H1 [test]: The runner image runs as a non-root user, contains no devDependencies, build toolchain, pnpm store or source maps beyond dist, and the .dockerignore excludes .env*, .git and node_modules so no secret or local env file can be copied into any layer; a test inspects docker history/filesystem for these
  - H2 [test]: The 600 MB threshold is a named constant checked against the actual built image in the same test run (not a hard-coded measured value), and the size check fails with the measured size in its message; the multi-arch (arm64) image is also under the limit or the arm64 size is recorded
- [x] 14-06 (wave 1) Git host key pinning: bundled keys + TOFU (domain, ssh, git) — done
  - A1 [test]: packages/domain exports the published host keys for github.com, gitlab.com and bitbucket.org, plus a pure validator/parser for an OpenSSH host key line (host, type, base64 key) with ≥95% branch coverage
  - A2 [test]: GIT_SSH_COMMAND uses StrictHostKeyChecking=yes with a known_hosts file written from a bundled or pinned key; accept-new no longer appears anywhere in packages/
  - A3 [test]: For a host without a bundled key, an allowlisted ssh-keyscan template with an explicit timeout returns the key and the clone is pinned to it (persisting that key per service for later deploys is 14-07); the clone never starts with accept-new or an unpinned host, and existing deploy-engine integration tests keep passing by supplying their fixture host key
  - A4 [it-deploy-templates]: A host key mismatch is classified as GIT_HOST_KEY_MISMATCH from git/ssh output (ADR 0008 text classification), with a fixture per Ubuntu version
  - H1 [test]: The bundled host keys have a recorded provenance (official publication URL and fetch date) and a test asserts each bundled line parses, has the expected type (ed25519/rsa/ecdsa) and fingerprint SHA256 matching the vendor-published fingerprint constant, so a typo or substituted key fails CI
  - H2 [test]: The host key parser rejects lines with option prefixes, embedded newlines, wildcards or hashed hosts, leading '-', non-base64 key bodies, mismatched type/key blob, and over-long input; and the known_hosts file content is built only from validated parts (host validated, no interpolation of repo-controlled text into shell), proven with hostile hosts ($(), backticks, ';', spaces)
  - H3 [test]: The ssh-keyscan template output is treated as untrusted: only the single requested host's key lines of an accepted type are returned, extra lines or hosts are dropped, a keyscan timeout or empty output fails closed with a named error, and the clone never proceeds without a pinned key even when keyscan fails
  - H4 [test]: Non-default ports and ssh:// URLs with port (host key stored as [host]:port) pin and match correctly, and host comparison is case-insensitive and ignores trailing dots so a mismatch cannot be bypassed by alternate spellings
- [x] 14-07 (wave 2) Git host key pinning: persistence, runtime wiring, reset — done
  - A1 [test]: A versioned migration adds a nullable git host key (host + key line) to services; the first SSH clone of a non-bundled host stores it and later clones pin it
  - A2 [it-runtime-pipeline]: The integration test against the real sshd+dockerd fixture covers: first clone stores the key, second clone pins it, a rotated host key fails the deployment FAILED/GIT_HOST_KEY_MISMATCH with an actionable message and no workspace left behind
  - A3 [test]: The operator CLI can forget a service's pinned key (noodara services reset-host-key <serviceId>) and writes an activity event without the key material
  - A4 [it-https-token]: HTTPS clones are unaffected (contracts-https-token stays green); error-codes.mdx and docs/deploy-engine.md document the new code and the reset
  - H1 [test]: The TOFU store is race-safe: two concurrent first clones of the same non-bundled host for one service result in exactly one stored key (conditional update where git_host_key is null) and the loser verifies against the winner's key instead of overwriting it; a rotated key is never auto-replaced
  - H2 [test]: The migration is additive with nullable columns, applies cleanly on a DB with existing services, existing services with no stored key behave as first clone, and changing the service git URL host clears or re-keys the pinned key so a stale pin neither blocks nor is silently reused for a different host
  - H3 [test]: GIT_HOST_KEY_MISMATCH error message, activity events, logs and API responses contain neither the offending nor the pinned key blob (fingerprint at most), covered by the security:scan-leaks canary or an equivalent assertion; remote ssh stderr is not echoed raw
  - H4 [test]: noodara services reset-host-key validates the serviceId argument (UUID, else exit non-zero with a named error and no DB write), is idempotent on a service with no pinned key, returns non-zero for an unknown service without revealing other data, and takes effect on the next deploy
- [x] 14-08 (wave 3) Deploy: fail stale QUEUED deployments when enqueue and undo both fail — done
  - A1 [test]: The worker's startup sweep and its repeatable reconcile tick move a QUEUED deployment older than a threshold (env, default 2 min) and without a BullMQ job to FAILED/ENQUEUE_FAILED through the domain state machine
  - A2 [test]: A QUEUED deployment whose job exists, or that is younger than the threshold, is never touched; the transition is race-safe against a worker that picks it up at the same time
  - A3 [it-deploy-queue]: The integration test reproduces Postgres+Redis down during enqueue, brings them back, and sees the deployment end FAILED/ENQUEUE_FAILED with deployment.updated published and the 409 lock released
  - H1 [test]: The stale-QUEUED threshold env is range-validated (minimum above the longest legitimate enqueue-to-pickup delay, such as the BullMQ backoff, and a maximum) with a named boot error, listed in turbo.json passThroughEnv and .env.example per ADR 0003
  - H2 [test]: The sweep decision uses an authoritative BullMQ job lookup with a Redis error treated as unknown (skip, retry next tick), never as 'no job'; a Redis outage during the sweep must not fail healthy QUEUED deployments, and the sweep is idempotent when run twice or by two workers concurrently (conditional UPDATE ... WHERE status='QUEUED', one activity event)
  - H3 [test]: The ENQUEUE_FAILED failure writes an activity event and deployment.updated with an actionable closed-vocabulary message and no raw Redis/Postgres error text; the sweep is bounded per tick (batch limit) so a large backlog cannot block the worker
- [x] 14-09 (wave 1) execStreaming: release stdin secrets when the stream ends — done
  - A1 [test]: Stdin secrets registered by execStreaming are released exactly once after the last output line is redacted, on success, failure, timeout and cancel
  - A2 [test]: A secret echoed in the final flushed chunk is still redacted (release never runs before the flush)
  - A3 [manual]: The stale comment in exec-streaming.ts and OPEN_QUESTIONS #7 wording are updated
  - H1 [test]: A stdin secret that was split across the final two chunks, or echoed after the stream ended with a non-zero exit, is redacted before release; release is idempotent (a second call or a throw in the release path does not leak, double-free another stream's secret, or crash the worker), and a concurrent execStreaming call holding the same secret value keeps its own registration
  - H2 [test]: The registered stdin secrets are not retained after release (heap or registry size returns to baseline after N streams, including aborted ones), proven with a loop test that asserts the Redactor registry is empty
- [x] 14-10 (wave 3) Build cache prune policy (D12): age-based, once a day per server — done
  - A1 [test]: After a SUCCESS deployment, an allowlisted docker builder prune -f --filter until=168h runs with an explicit timeout, at most once per server per 24 h (Redis key with TTL)
  - A2 [test]: A prune failure or timeout is logged by error class only and never changes the deployment's status
  - A3 [it-runtime-pipeline]: The integration test proves the prune runs once on two consecutive deployments and does not delete the running container's image
  - A4 [manual]: ADR 0009 records the policy, the host-wide impact and how to disable it (NOODARA_BUILD_CACHE_PRUNE=off)
  - H1 [test]: The prune filter and age come from validated constants or env (NOODARA_BUILD_CACHE_PRUNE accepts only on|off, other values fail boot with a named error), the template takes no free strings, and a prune never runs while another deployment on the same server is BUILDING (skipped, retried on a later deployment)
  - H2 [test]: The Redis once-per-24h key is set atomically (SET NX with TTL) before the prune so two concurrent deployments on one server run one prune; on Redis failure the prune is skipped, not run unbounded, and a failed prune releases or shortens the key so it is retried rather than silenced for 24 h
  - H3 [test]: The prune never exceeds a hard timeout and its output (which can list cache IDs) is not persisted or published to build logs; with NOODARA_BUILD_CACHE_PRUNE=off no prune command is issued, proven with a fake port
- [x] 14-11 (wave 1) Integration harness: clear precheck when port 3000 is taken — done
  - A1 [test]: If port 3000 is in use, pnpm test:integration fails at once with a message that names the port and how to free it, not EADDRINUSE deep in boot-command
  - A2 [it-boot]: With port 3000 free the boot suite is green; OPEN_QUESTIONS #3 is resolved
  - H1 [test]: The port-3000 precheck distinguishes a port held by another process from a stale Noodara test stack and, when it fails, exits before any container or DB is started so no resources are left behind; the check is skipped when an explicit alternative port env is configured
- [x] 14-12 (wave 3) engine-primitives test: workspace:* deps instead of relative imports — done
  - A1 [test]: engine-primitives.test.ts imports @noodara/git and @noodara/docker by package name through workspace:* devDependencies; no ../../../packages imports remain in it
  - A2 [it-engine-primitives]: pnpm boundaries still passes and it-engine-primitives is green on both Ubuntu versions; OPEN_QUESTIONS #2 is resolved
  - H1 [test]: The workspace:* devDependencies are pinned in pnpm-lock.yaml and CI installs with --frozen-lockfile; adding them does not make @noodara/git or @noodara/docker importable from apps/ or packages/domain (pnpm boundaries still rejects such imports), and the tests still resolve the built or source entrypoint consistently with ADR 0003
- [x] 14-13 (wave 1) UI: 375 px debt from the Phase 13 review — done
  - A1 [test]: At 375 px the service title keeps at least its first 12 characters visible and the toolbar stays on one row (actions overflow to a menu); a component test written first proves the layout contract
  - A2 [test]: A 300-character repo URL in the source card wraps or truncates in the middle with the full value available on demand (title/copy), never clipped by the edge
  - A3 [test]: In the 375 px projects list the project name truncates after the description
  - A4 [manual]: noodara-ux-review passes on the three screens in light and dark at 375 and 1280 px, with screenshots in docs/ui-review/phase-14/ approved by a human
  - H1 [test]: The overflow menu and middle-truncated URL are keyboard operable and screen-reader labeled (menu button aria-label and aria-expanded, focus trap and Escape return focus, full URL exposed via accessible name), with an axe check on the three screens at 375 px, and the touch targets are at least 44 px
  - H2 [test]: No horizontal page scroll at 375 px and 1280 px on the three screens even with a 300-character unbroken service name and repo URL (Playwright assertion scrollWidth <= clientWidth), and the full URL is rendered as inert text (no HTML interpretation)
- [x] 14-14 (wave 4) Release prep: 0.2.0 version, rc prerelease handling, notes, site — done
  - A1 [test]: release.yml marks tags with a -rc.N suffix as GitHub prereleases that never become latest, so the default installer keeps resolving the last stable release; a test or check-workflow-pins case covers it
  - A2 [manual]: docs/releases/v0.2.0.md lists the v0.2 features, upgrade and rollback steps (NOODARA_VERSION pin) and known limits (no domains, no env vars, single worker)
  - A3 [manual]: The public site and install docs describe v0.2 (projects, services, deploy) with no placeholders for v0.4 features
  - H1 [test]: Release version bumps are consistent: the control-plane, web and root package.json versions and the published image tags derive from one tag, and a script test fails if the tag, package versions and release notes version disagree; the -rc.N regex rejects malformed tags (v0.2.0-rc, v0.2.0-rc.0x, v0.2.0-rcfoo) and never publishes the 'latest' image tag or Release for an rc
  - H2 [test]: The release workflow keeps least-privilege permissions, pinned action SHAs (check-workflow-pins) and does not echo secrets; the installer resolving 'latest' ignores prerelease tags even when an rc is the newest tag, proven against a fake releases API response
- [x] 14-15 (wave 6) Automated v0.2 gate evidence — done
  - A1 [manual]: docs/releases/v0.2-gate.md has one row per roadmap §7.8 criterion with status and evidence from this run (command output under v0.2-gate-logs/), following the noodara-release-gate format
  - A2 [manual]: The QA-10 measured-numbers table and the D12 build-cache policy are recorded in the gate
  - A3 [manual]: A real nightly.yml run on main is green (run id recorded) and ci.yml is green on the release commit
  - A4 [test]: No .skip/.only/fixme added in phase 14 without a linked justification
  - H1 [test]: Gate evidence logs under docs/releases/v0.2-gate-logs/ are scanned for secrets (security:scan-leaks or a canary pattern check) before commit and carry the commit SHA and date of the run, and a check fails if a gate row is marked passing without a log file referenced
- [x] 14-16 (wave 7) Human gate: rc.1 on a real VPS, v0.1 human debt, upgrade and rollback — done
  - A1 [manual]: v0.2.0-rc.1 is tagged and published with multi-arch images (amd64, arm64) in GHCR
  - A4 [manual]: A real upgrade v0.1.0 → v0.2.0-rc.1 and its rollback to v0.1.0, with data intact
  - A5 [manual]: The gate verdict is READY or the blocking rows are listed
  - H1 [manual]: The rc.1 and v0.2.0 multi-arch images are verified by digest (manifest contains linux/amd64 and linux/arm64) and the installer on the real VPS pulls by the tagged version, with the digest recorded; the upgrade rollback step confirms the DB schema from migrations 0005+ is handled (documented as data-compatible or with an explicit down/restore-from-backup procedure) and a pre-upgrade backup was taken
- [x] 14-17 (wave 8) Publish v0.2.0 and close Phase 14 — done
  - A1 [manual]: v0.2.0 is tagged from the rc.1 commit (or a documented fix-forward), multi-arch images are published, and a short upgrade v0.1.0 → v0.2.0 is recorded
  - A2 [manual]: OPS-01..04 are marked complete with evidence in REQUIREMENTS.md and ROADMAP.md; STATE.md moves to milestone v0.3
  - A3 [manual]: OPEN_QUESTIONS #2, #3, #7 and #11 are resolved; #4–6, #9 and #10 are confirmed by the user or kept open with an owner
  - H1 [manual]: No VPS credentials, tokens, deploy keys or IPs of the real server appear in the committed HUMAN-UAT, gate or verification documents or in screenshots (redacted), checked before publishing v0.2.0
- [x] 14-18 (wave 1) Web image builds again: API contract types out of control-plane source — done
  - A1 [test]: The project, service and deployment request/response schemas (and the ServiceErrorCode type web needs) live in packages/domain (pure, zod only); apps/control-plane imports them from @noodara/domain, and the old route modules either re-export or are removed with all imports updated
  - A2 [test]: No file under apps/web imports from apps/control-plane source by relative path; pnpm boundaries (or a lint rule) fails if one does
  - A3 [it-web-image]: The web production image builds again from its turbo prune output (web-image.test.ts green)
  - A4 [test]: packages/domain keeps ≥95% statement/branch coverage on the moved schemas and stays free of I/O imports
  - A5 [test]: Input validation is unchanged by the move: the existing route schema tests (project-schemas, service-schemas, deployment-schemas) pass without weakened assertions, and malformed, unknown-field and oversized bodies are still rejected with the same status codes
- [x] 14-19 (wave 2) UI: compact project toolbar at 375 px — done
  - A1 [test]: At 375 px the project toolbar stays on one row with the project title visible (at least 12 characters) and Edit/Archive/Delete in a RowMenu, following the ServiceToolbar compact pattern; a component test written first proves it
  - A2 [e2e-dod]: The 44 px back arrow and the menu are keyboard operable with accessible names; axe passes at 375 and there is no horizontal scroll at 375 and 1280 px
  - A3 [manual]: docs/ui-review/phase-14/REPORT.md Layout row moves from FLAG to PASS with new project-375 screenshots, approved by a human
- [x] 14-20 (wave 1) API: graceful shutdown on SIGTERM/SIGINT — done
  - A1 [test]: On SIGTERM or SIGINT the api closes the Fastify app (stops accepting connections, lets in-flight requests finish, closes SSE streams, DB and Redis clients) and exits 0, like worker.ts; a second signal or a close that exceeds a bounded timeout (below the 30 s compose stop_grace_period) exits non-zero
  - A2 [test]: A unit test with fake ports proves the shutdown order, the bounded timeout and that a close error is logged by class only and still exits
  - A3 [it-boot]: The boot integration test sends SIGTERM to the real built server and sees it exit 0 within a few seconds
  - A4 [it-cp-image]: In the production image, `docker stop` on the api container returns well under the stop grace period with exit code 0, not 137 (measured in control-plane-image.test.ts or compose-stack.test.ts)
- [x] 14-21 (wave 5) CI: idempotent enum migrations and site scope notes — done
  - A1 [it-db]: Migrations 0007 and 0009 use ALTER TYPE ... ADD VALUE IF NOT EXISTS so migration-hygiene.test.ts passes; applying them twice on a migrated DB is a no-op
  - A2 [site-build]: The site builds: every ScopeNote id used in apps/site/content exists in scope.ts (deploy-services restored, renamed or its notes removed consistently with the v0.2 scope), with a test that fails on an unknown id at test time, not only at prerender
- [x] 14-22 (wave 5) CI: deploy.spec registry-password e2e times out on a click — done
  - A1 [manual]: Root cause of the deterministic TimeoutError at tests/e2e/deploy.spec.ts:535 (CI run 37728319848 and nightly 37728338741) is identified and stated; if it comes from the 14-13/14-19 toolbar changes (actions moved into the menu), the spec or the UI is fixed without weakening what the test proves
  - A2 [e2e-deploy]: e2e-deploy and e2e-dod are green locally, and the fixed spec passes 3 consecutive runs
- [x] 14-23 (wave 5) CI: pnpm audit high findings (sharp, next) — done
  - A1 [audit]: pnpm audit --audit-level=high reports no high or critical finding: sharp ≥0.35.5 and next ≥16.3.8 everywhere they resolve, each bump checked with scripts/check-package-provenance.mjs
  - A2 [build]: The web app and the site still build and their tests pass after the bumps
- [x] 14-24 (wave 5) Nightly e2e-repeat: fix flaky discovery, settings density and host-key tests — done
  - A1 [manual]: Each of the three nightly failures has a stated, proven root cause: discovery.spec.ts:364 toHaveAttribute (nightly 37741127947 attempt 2, iteration 5), settings.spec.ts:531 toBeCloseTo (nightly 37759024967, iteration 5), host-key.spec.ts:486 Docker 'failed programming external connectivity' (nightly 37741127947 attempt 1, iteration 1)
  - A2 [e2e-full]: Fixes address the cause (race, timing or port allocation) without adding retries, skips or weaker assertions; each affected spec passes 20 consecutive local runs (--repeat-each=20)
  - A3 [e2e-full]: pnpm test:e2e is green locally after the fixes
- [x] 14-25 (wave 5) Nightly deploy-engine 22.04: exec-streaming confirmed-kill flake (CONNECTION_LOST) — done
  - A1 [manual]: The root cause of the nightly 37781972328 failure is stated and proven: on Ubuntu 22.04, 'slow build: killSupervisedOperation runs while the stream is open on the same connection, confirms, and the stream then ends non-zero' failed with errorCode CONNECTION_LOST (expected false to be true); decide with evidence whether it is a product race in packages/ssh (kill on the same connection tearing the channel/connection down) or a fixture/test race
  - A2 [it-exec-streaming]: The fix addresses the cause without retries, skips, longer timeouts as the fix or weaker assertions; the test passes 20 consecutive runs on 22.04 and 24.04
- [x] 14-26 (wave 5) Nightly e2e-repeat: theme-first-paint flake and a load-stress hunt for the rest — done
  - A1 [manual]: Root cause of theme-first-paint.spec.ts:181 (nightly 37807942623, iteration 6: serversResult.mutations expected 0) is stated and proven by reproducing it (e.g. under CPU load), then fixed without retries, skips, timeout bumps or weaker assertions
  - A2 [e2e-full]: The full e2e suite runs at least 5 consecutive times locally under CPU stress (the load technique 14-25 used) with zero failures; every other flake found on the way gets the same root-cause treatment and is listed in docs/releases/v0.2-gate-logs/
- [x] 14-27 (wave 5) Test harness: containers leaked from one session survive the gate run (Ryuk did not reap) — done
  - A1 [manual]: Root cause stated and proven for docs/releases/v0.2-gate-logs/gate-14-15-leaked-containers.md: 8 containers (deploy-host, registry, mirror, 2 postgres, 2 redis, 1 sshd) from one testcontainers session were alive for hours after their suite ended, and every later suite failed its stray-container check; find which suite started them (it-full vs e2e-full), why its teardown did not remove them and why Ryuk did not reap them
  - A2 [it-full]: After the fix, running pnpm test:integration then pnpm test:e2e back to back leaves zero noodara.test containers immediately after each, and each suite's teardown fails loudly if it leaves any
- [x] 14-28 (wave 5) Integration flakes in the 14-15 gate: events-sse cascade and readyTimeout early fire — done
  - A1 [manual]: events-sse.test.ts (log docs/releases/v0.2-gate-logs/gate-14-15-it-full-run2.log): root cause of one container start timing out on port binding and the whole file failing in cascade is stated and proven; one slow start must fail one test with a clear error, not leak a resource and cascade, and the suite's setup must tolerate the host's real port-bind latency through an explicit bounded wait
  - A2 [it-ssh-contracts]: contracts.test.ts '.invalid TLD' measured 4999.82 ms against >= 5000: the timing assertion accounts for timer-vs-performance.now granularity with a documented, minimal tolerance (sub-millisecond, justified in a comment), not a weaker bound; it passes 20 consecutive runs
  - A3 [it-full]: pnpm test:integration is green on this host
- [x] 14-29 (wave 5) Installer: compose must use the normalized NOODARA_VERSION, not the exported raw pin — done
  - A1 [test]: Found on the real host in 14-16: running the installer with NOODARA_VERSION=v0.2.0-rc.1 (as the docs say) writes .env NOODARA_VERSION=0.2.0-rc.1 but every docker compose call still sees the exported raw value (shell env beats .env in Compose), so it pulls :v0.2.0-rc.1 and fails (exit 50). Every compose invocation must run with the normalized value (or with NOODARA_VERSION unset so .env wins); a unit test with a PATH-shadowed docker that records its environment proves it, for both v-prefixed and plain pins
  - A2 [test]: A failed pull or failed upgrade never leaves .env pointing at a version that is not running: .env is written only after the new images are pulled, or restored from the backup on failure; tested
  - A3 [installer]: The installer suite covers a v-prefixed pin end to end (pin v<version> installs <version>) and stays green on 22.04 and 24.04
  - A4 [manual]: Docs and the rollback hint use a form that works with both the v0.2 installer and the published v0.1.0 installer, and say so
- [x] 14-30 (wave 5) Deploy on a non-root SSH user: workspace location, error classification, LFS false positive — done
  - A1 [it-deploy-engine-all]: Human UAT (docs/releases/v0.2-HUMAN-UAT.md, finding 3): a deploy over SSH as a non-root user in the docker group fails because the workspace /opt/noodara-deploy cannot be created. Deploys work for a non-root docker-group user without manual host setup (e.g. a workspace under the SSH user's home, or a documented, preflighted location) and the integration fixture gains a non-root user case that proves it
  - A2 [test]: A workspace that cannot be created or written fails with its own actionable error code and message (not CLONE_FAILED's 'check the repository URL… deploy key'), classified by the ADR 0008 text rules, with web copy
  - A3 [test]: Finding 4: Git LFS is detected only from real evidence — a `filter=lfs` attribute in a non-comment line of a .gitattributes, or a file whose first line is exactly `version https://git-lfs.github.com/spec/v1` — so a repo that merely mentions the spec string (like this repo) is not rejected; unit tests for both true and false positives
- [x] 14-31 (wave 5) Upgrade path: unknown BuildKit after v0.1 discovery, rollback wording — done
  - A1 [test]: Finding 2: a git service on a server whose dockerBuildkitAvailable is NULL (discovered before v0.2) is rejected with a distinct, actionable error that asks to re-run discovery, not SERVER_BUILDKIT_UNAVAILABLE's 'enable BuildKit'; false keeps the current error; the web UI shows the right copy; release notes mention re-running discovery after the upgrade
  - A2 [test]: Finding 5: when the target version is older than the running one the installer says it rolled back (e.g. 'Rolled back from 0.2.0-rc.1 to 0.1.0'), with a unit test; still POSIX sh
- [x] 14-32 (wave 5) CI on 80f4f93: services-api BuildKit-unknown expectation; sheet-drag release momentum — done
  - A1 [it-projects]: tests/integration/projects/services-api.test.ts 'refuses a Dockerfile service when BuildKit is unknown' expects 14-31's SERVER_BUILDKIT_UNKNOWN for NULL and SERVER_BUILDKIT_UNAVAILABLE for false (both cases asserted); it-projects green
  - A2 [manual]: Root cause of nightly 38530970865 iteration 3 (docs/releases/v0.2-gate-logs/nightly-38530970865-sheet-drag.log: server-sheet.spec.ts:580, panel x went from 2.545 at release to 1.651 one frame later, i.e. backwards) is stated and proven — 14-26's keyframe exit restarting from rest vs. the drag release momentum, or a test sampling race; fix the cause without retries, timeout bumps or weaker assertions
  - A3 [e2e-sheet]: The @sheet-drag specs pass 20 consecutive runs under the 14-26 CPU-stress technique, and e2e-sheet is green
- [x] 14-33 (wave 5) Sheet: progressive (rubber-band) overscroll resistance — done
  - A1 [test]: User decision 2026-10-14: overscroll past the Sheet's edge resists progressively (Apple-style rubber band: displacement grows sub-linearly with pull and is bounded), not the current linear 0.15; a pure function in packages/ui with unit tests (monotonic, sub-linear, bounded, zero at zero) written first
  - A2 [e2e-sheet]: The e2e 'resists progressively' asserts the real property from a settled panel (waits for the entry spring to finish), so it fails against a linear implementation; passes 20 consecutive runs under CPU stress including throttle
  - A3 [e2e-sheet]: Release-momentum, re-grab, Esc and keyboard-motion behaviour unchanged (server-sheet, keyboard-motion, a11y-fallbacks green); reduced motion respected; OPEN_QUESTIONS #12 resolved
- [x] 14-34 (wave 5) Nightly: compact project toolbar back arrow ignores Enter after the edit sheet closes — done
  - A1 [manual]: Root cause of nightly 38565964460 iteration 3 (docs/releases/v0.2-gate-logs/nightly-38565964460-project-toolbar-back.log: projects-dod.spec.ts:1311, after Escape closed the edit sheet, back.focus() + Enter left the URL on /projects/<id> for 15 s) is stated and proven by reproduction — e.g. the Sheet's close auto-focus restoring focus to the menu trigger after the user already moved focus, or the measured compact/full layout swap remounting the focused back control
  - A2 [test]: Fix the product cause: focus restoration never steals focus from a control the user focused after the close, and/or the layout swap never remounts the focused control; keyboard users can always activate the back arrow right after closing the sheet. The spec keeps asserting the real user flow (no extra waits that hide the race)
  - A3 [e2e-dod]: The failing test passes 20 consecutive runs under the 14-26 CPU-stress technique; e2e-dod and e2e-sheet green
- [x] 14-35 (wave 7) Phase 14 review fixes: gate doc on the release commit, gate-log check, tag evidence, TDD proof, installer build diagnostics — done
  - A1 [manual]: docs/releases/v0.2-gate.md is rewritten around the release commit d828db4 (= v0.2.0 = rc.2): no stale 76c7636/fd43067 header or 'pendiente/no se hizo tag' text; verdict worded honestly: released with user-accepted debt, strict READY rule NOT met because five real-host rows are UNVERIFIED and deferred to OPS-05
  - A2 [test]: 14-15 H1 implemented: a script (scripts/check-gate-doc.mjs or similar) wired into pnpm test fails when a gate row is marked READY/PASS without a referenced log or run id, with unit tests (RED first) and the gate doc passing it
  - A3 [manual]: Tag/release evidence recorded in the gate and phase-14 verification: `gh release view v0.2.0`, release run id, tag → d828db4, multi-arch digests (command output captured in docs/releases/v0.2-gate-logs/)
  - A4 [manual]: 14-31 retroactive RED proof: the tests added in 7e9d18c run against the pre-fix code (e.g. a temporary git worktree at 7e9d18c^ with only the new tests) and fail for the right reason; output recorded
  - A5 [test]: OPEN_QUESTIONS #13: installer-dind.ts surfaces the docker build output/stream when an image build fails (unit test with a fake builder), so a transient registry/apt failure is distinguishable from a real one; #13 resolved
  - A6 [manual]: REQUIREMENTS.md gains OPS-05 (real-host verification debt: public VPS, Ubuntu 22.04, arm64, ufw active, 1–2 GB; owner: user; target v0.2.1/v0.3), mapped in the traceability table and noted in ROADMAP; OPEN_QUESTIONS #4/#5/#6/#9/#10 marked confirmed (DECISIONS 2026-10-14)

## Phase 15: Verificación en host real (OPS-05) — active
**Goal:** Close the v0.2 real-host debt: run the v0.2 install and deploy flow on a real public VPS, on Ubuntu 22.04, on arm64, with ufw active and on a 1–2 GB machine, and record the evidence in the v0.2 gate.
**Requirements:** OPS-05
**Depends on:** 14

- [ ] 15-01 (wave 1) Real-host v0.2 verification (public VPS, 22.04, arm64, ufw, 1–2 GB) — blocked
  - A1 [manual]: On a real VPS: connect → project → environment → deploy from node-api → logs → status → failed build → cancel, recorded criterion by criterion
  - A2 [manual]: Real installs on Ubuntu 22.04, on arm64 and on a host with ufw active; memory observed on a 1–2 GB VPS

## Phase 16: Motor confiable — contratos, dominio y esquema — done
**Goal:** Resolve the v0.3 remote contracts with evidence (ADR 0010) and land the pure domain (ten-state machine at 100% branch coverage, healthcheck, rollback, retention, webhook decisions) plus the additive schema, without changing runtime behaviour.
**Requirements:** ENG-01, HC-01
**Depends on:** 14

- [x] 16-01 (wave 1) Spike + ADR 0010: healthcheck probes, previous-container preservation, worker-retry resume — done
  - A1 [it-contracts-v03]: HTTP and TCP probe mechanism chosen with evidence on Ubuntu 22.04 and 24.04: how the server reaches the container (container IP on noodara-net-<serviceId> from the host, published port, or probe container), curl/bash availability measured on stock images, and a fallback when curl is missing; no image is pulled implicitly
  - A2 [it-contracts-v03]: Previous-container contract measured: a stopped container renamed to noodara-<serviceId>-prev frees the name, releases its published host port so the new container binds it, and restarting it restores that port
  - A3 [manual]: Worker-retry resume rule chosen and justified: which steps are safe to re-run after a crash mid-step (clone into an existing workspace, build with the same tag, create when the container exists) and whether a retried job resumes or fails and re-enqueues
  - A4 [manual]: State-machine shape fixed in the ADR with rejected alternatives: auto-rollback edges, manual rollback as a new row that skips BUILDING, cancellability per state, and the time budget of healthcheck and rollback inside NOODARA_DEPLOY_MAX_MS
  - A5 [adr-0010-accepted]: ADR 0010 status is Accepted
  - H1 [manual]: The ADR records the measured probe cost and a hard output/time cap per probe, and states that the probe never sends the service's secrets or env and never follows redirects to a different host
  - H2 [it-contracts-v03]: The HTTP probe never follows redirects (a 3xx is a status result compared against expected statuses), only uses http:// to the container address chosen in the ADR, and sends no cookies, credentials or cache headers
- [x] 16-02 (wave 2) Domain: ten-state deployment machine, triggers, error codes, 100% branch gate — done
  - A1 [test]: DEPLOYMENT_STATUSES has the ten roadmap states; transitions follow ADR 0010 (baseline: DEPLOYING→HEALTHCHECK|ROLLING_BACK|FAILED|CANCELLED, HEALTHCHECK→SUCCESS|ROLLING_BACK|FAILED|CANCELLED, ROLLING_BACK→ROLLED_BACK|FAILED; DEPLOYING→SUCCESS removed); SUCCESS, FAILED, ROLLED_BACK and CANCELLED are terminal
  - A2 [test]: Every one of the 100 ordered pairs is asserted; the trigger-gated edge PREPARING→DEPLOYING is allowed only for trigger rollback and rejected for every other trigger
  - A3 [test]: Named tests for roadmap §8.7: every valid and invalid transition (BUILDING→SUCCESS, FAILED→SUCCESS, CANCELLED→DEPLOYING by name), terminal states, cancellation, rollback transitions and retry (re-applying an already applied edge is reported as such, not as a new transition)
  - A4 [coverage-state-machine]: coverage-state-machine fails below 100% statements, branches, functions and lines for deployment-state.ts
  - A5 [test]: NON_TERMINAL includes HEALTHCHECK and ROLLING_BACK; triggers add webhook and rollback; log phases add healthcheck and rollback; error codes add HEALTHCHECK_FAILED, HEALTHCHECK_TIMEOUT, ROLLBACK_FAILED, ROLLBACK_TARGET_UNAVAILABLE, COMMIT_NOT_FOUND, each with a tested actionable message
  - A6 [manual]: The domain-model skill §4 documents the v0.3 table and points to ADR 0010
  - H1 [test]: A property test walks random transition sequences through transitionDeployment and asserts no sequence leaves a terminal state, reaches ROLLED_BACK without passing ROLLING_BACK, or reaches SUCCESS without passing HEALTHCHECK (except trigger rollback after its own HEALTHCHECK)
  - H2 [test]: Every status, trigger, error code and log phase tuple has a test that fails when a value exists in the domain but not in the DB enum list or the api-contract enum (no drift)
  - A7 [it-runtime-pipeline]: Consumers stay behaviour-compatible: the runtime ends a deploy DEPLOYING→HEALTHCHECK→SUCCESS using the existing post-start polls as the container check (verify step = HEALTHCHECK); deployment-steps and the web lookup tables handle every new state, trigger, phase and code with minimal copy (final copy in 19-01); runtime-pipeline integration stays green
  - A8 [it-db]: Migration 0011 adds the new status, trigger, error-code and log-phase values with ALTER TYPE ... ADD VALUE IF NOT EXISTS (derived from the domain tuples), and a separate migration 0012 recreates the one-active partial unique index from the new non-terminal set; both apply from scratch and from the v0.2.0 schema with rows unchanged
- [x] 16-03 (wave 3) Domain: healthcheck config, budget and pure decision — done
  - A1 [test]: HealthcheckConfig is a discriminated union http | tcp | container; the validator rejects a path without a leading slash or with '..', whitespace, control or shell characters, ports outside 1–65535, and timeout, interval, retries, start period and expected statuses outside documented bounds
  - A2 [test]: healthcheckBudgetMs(config) is bounded and a config whose budget exceeds the deploy maximum is rejected with a named error
  - A3 [test]: A null config resolves to the container check with the v0.2 post-start poll behaviour (test pins equivalence with post-start-polls)
  - A4 [test]: decideHealthcheck(policy, state, observation) returns pass, retry with delay, HEALTHCHECK_FAILED (wrong status, refused, container exited) or HEALTHCHECK_TIMEOUT; every branch tested, ≥95% branch coverage
  - A5 [test]: The probe-output parser from ADR 0010 is total: garbage, truncated or oversized output becomes a failed observation, never an exception
  - H1 [test]: Healthcheck validator rejects non-integer, NaN, negative and fractional numerics, non-http status codes in expectedStatuses, and strips nothing silently: unknown fields give a named error; paths over a max length (e.g. 256) are rejected
  - H2 [test]: decideHealthcheck is pure and deterministic: the same (policy,state,observation) always returns the same decision and the retry delay never exceeds the remaining budget; an observation after the budget is exhausted yields HEALTHCHECK_TIMEOUT, never another retry
- [x] 16-04 (wave 4) Domain: rollback target, image retention, runtime snapshot, idempotency key — done
  - A1 [test]: selectRollbackTarget(history, retainedImages, explicitTarget?) returns the latest known-good (SUCCESS) deployment other than the current one, or a named reason: none, image_pruned, not_known_good, same_as_current, other_service
  - A2 [test]: imageRetention(history, running, N) never selects the running image or the image of a non-terminal deployment for deletion and keeps N previous known-good images (N bounded 1–10, default 3)
  - A3 [test]: RuntimeConfigSnapshot v1 (image ref, internal port, published port, healthcheck) parses strictly, rejects unknown versions, and has no field that can hold a secret (type-level test)
  - A4 [test]: Idempotency keys are 1–255 visible ASCII; requestFingerprint is stable under key order and differs for any semantic change
  - H1 [test]: selectRollbackTarget never returns a deployment whose status is not SUCCESS or whose runtime_config is null/unparseable, and returns a named reason (not an exception) for empty history and for a history containing only the current deployment
  - H2 [test]: requestFingerprint hashes with SHA-256 over a canonical serialization, is collision-safe across field boundaries (a="b",c="" differs from a="",c="b"), and the idempotency key validator rejects empty, over-255, control chars and whitespace-only keys
  - H3 [test]: RuntimeConfigSnapshot parsing never echoes unknown or secret-looking values in its error messages and enforces bounded string lengths on image ref
- [x] 16-05 (wave 5) Domain: GitHub push matching, delivery and coalescing decisions — done
  - A1 [test]: Zod schemas parse the minimal push and ping payloads with bounded strings; unknown fields are ignored, missing required ones rejected
  - A2 [test]: matchPush(service, event, payload) ignores unsupported events, tags, deletions, the zero SHA and other branches, rejects a repository that is not the service's (https and ssh URL forms normalized), and returns the 40-hex pushed SHA otherwise
  - A3 [test]: decideDelivery(existing, active, pending) is table-tested: duplicate, deploy now, coalesce (replace pending, previous pending superseded), drop when pending SHA equals the deployed SHA
  - A4 [test]: Delivery outcomes are a closed vocabulary shared with the schema; the module imports no I/O (purity test green)
  - H1 [test]: matchPush normalizes repository URL comparison case-insensitively on host and strips trailing .git and slash, and treats refs/heads/<branch> comparison as exact (a branch named with a prefix of the configured one does not match); non-40-hex or uppercase SHAs are rejected
  - H2 [test]: Webhook payload schemas cap string lengths and array sizes (commits array, repository fields) so an oversized but valid JSON payload cannot allocate unbounded memory in parse
- [x] 16-06 (wave 6) Schema: v0.3 columns (deployment traceability, service config, webhook deliveries) — done
  - A1 [it-db]: The enum values and index recreation from 16-02 (migrations 0011/0012) are untouched; this task's migration (0013) only adds columns and tables; it may also add the credential_type value 'webhook_secret' with ADD VALUE IF NOT EXISTS (not used in the same transaction)
  - A2 [it-db]: deployments gains nullable image_ref, rollback_of_deployment_id (FK set null), webhook_delivery_id, idempotency_key + request_fingerprint (unique per service when set), runtime_config jsonb, healthcheck_started_at, rollback_started_at
  - A3 [it-db]: services gains healthcheck jsonb (null = container), auto_rollback default true, image_retention default 3, webhook hook id (unique, random) with a webhook_secret_credential_id FK to credentials that is ON DELETE SET NULL (deleting a credential never deletes a service); deleting a service deletes its webhook credential through the same path as its other credentials, and pending-trigger columns
  - A4 [it-db]: webhook_deliveries stores delivery id (unique per hook), event, outcome, pushed SHA, deployment FK, received_at; no payload or signature column
  - A5 [it-db]: The new migration applies from scratch and from the v0.2.0 schema with existing rows unchanged, and the one-active index from 0012 still rejects a second active deployment
  - H1 [test]: Migrations 0011-0013 are additive and idempotent: running it twice is a no-op, it takes no long ACCESS EXCLUSIVE lock on a populated deployments table (nullable columns without rewriting defaults), and a down/forward test on a DB with 10k deployment rows completes within a documented bound
  - H2 [test]: ALTER TYPE ADD VALUE statements are not wrapped in a transaction that then uses the new value in the same migration, and the test applies the migration on the exact PostgreSQL 16 version used in production
  - H3 [test]: The webhook hook id column and idempotency (service_id, idempotency_key) unique constraints are enforced at DB level and a concurrent double insert yields exactly one row (constraint violation surfaces as a typed error, not a 500)
- [x] 16-07 (wave 7) Phase 16 review fixes: nullable published port in the runtime snapshot, healthcheck edge cases — done
  - A1 [test]: RuntimeConfigSnapshot accepts publishedPort null (service without a published port) and still rejects out-of-range ports; selectRollbackTarget returns such a SUCCESS deployment as a valid target (tests for both)
  - A2 [test]: validateHealthcheckConfig rejects an explicit expectedStatuses: null with a named error instead of silently using the default; absent stays the default
  - A3 [test]: A test compares numerically that the default container healthcheck's budget equals the v0.2 post-start poll budget

## Phase 17: Healthchecks y recuperación en el runtime — done
**Goal:** Deployments keep the previous container until the new one passes its healthcheck, roll back automatically on failure, support manual rollback to a retained known-good image, and stay consistent under cancel, crash and network loss in every new state.
**Requirements:** ENG-02, ENG-04, ENG-05, HC-02, RBK-01, RBK-02, RBK-03
**Depends on:** 16

- [x] 17-01 (wave 1) SSH templates: healthcheck probes, rename/restore previous container, per-service image listing — done
  - A1 [test]: Allowlisted templates per ADR 0010: HTTP probe, TCP probe, rename to and from noodara-<serviceId>-prev, start/stop/remove of the -prev container, list and remove the service's own images; every argument comes from validated ids or domain-validated config through escapeShellArg
  - A2 [test]: Allowlist tests reject any other shape, including a probe path with shell metacharacters
  - A3 [it-deploy-templates]: Against real dockerd on 22.04 and 24.04: probe on a listening port, a closed port, a wrong status and a hung endpoint (timeout honoured); rename/restore keeps the published port
  - A4 [test]: Probe output is capped to a fixed byte budget and never includes the response body beyond it
  - H1 [test]: Probe and rename templates run under the existing supervised timeout wrapper with a hard max duration so a hung endpoint cannot hold the SSH channel past the probe budget; the -prev rename refuses to overwrite an existing noodara-<serviceId>-prev (explicit named error, not silent removal of another version)
  - H2 [test]: Probe output redaction: the probe stdout/stderr passes the Redactor and a canary placed in the container's response body never appears in logs, activity or the log phase beyond the status line
- [x] 17-02 (wave 2) Runtime: keep the previous container and run the HEALTHCHECK step — done
  - A1 [it-healthcheck]: Replacement stops the previous container and renames it to -prev instead of removing it; -prev is removed only after the new container passes its healthcheck
  - A2 [it-healthcheck]: DEPLOYING→HEALTHCHECK after start, healthcheck_started_at written in the same update as the edge; the check follows the service config through decideHealthcheck; output goes to the healthcheck log phase through the redactor
  - A3 [test]: Failures end with HEALTHCHECK_FAILED or HEALTHCHECK_TIMEOUT and a fixed actionable message; the runtime_config snapshot and image_ref are stored on the deployment
  - A4 [it-healthcheck]: fixtures/unhealthy-api builds a container that runs but answers 500 on its health path (context < 1 MiB)
  - A5 [it-runtime-pipeline]: Integration on 24.04: HTTP pass, wrong status, timeout, TCP pass; services without config keep the v0.2 result (runtime-pipeline green)
  - H1 [test]: The ledger cleanup set for FAILED, CANCELLED, timeout and WORKER_CRASHED never contains the -prev container or the previous deployment's image, and executing cleanup twice is idempotent (second run no error); proven with fake ports for every exit path in HEALTHCHECK
  - H2 [test]: The window between stopping the previous container and starting the new one is bounded: if the new container fails to start after the old was renamed to -prev, the failure path restores -prev even when auto_rollback is off (no silent downtime without a restore attempt), with a test per case
- [x] 17-03 (wave 3) Rollback plumbing: activity action, ROLLED_BACK in store and worker, rollback inputs in deploy-target — done
  - P1 [test]: deployment.rollback_started is a closed-vocabulary deployment action: buildActivityEvent accepts it with only non-sensitive metadata (deploymentId, serviceId, target deploymentId) and the web activity copy has an entry for it
  - P2 [test]: The deployment store finishes a deployment as ROLLED_BACK only through the domain transition from ROLLING_BACK, and keeps the error code and message for both FAILED and ROLLED_BACK
  - P3 [test]: The worker's job outcome includes ROLLED_BACK, treats it as terminal and never retries it
  - P4 [test]: deploy-target loads services.autoRollback (default true) and the service's latest SUCCESS deployment other than the current one as {id, runtimeConfig}; an invalid snapshot gives runtimeConfig null and no previous success gives null
- [x] 17-07 (wave 4) Runtime: automatic rollback (ROLLING_BACK → ROLLED_BACK | FAILED) — done
  - A1 [it-rollback]: A start or healthcheck failure with a -prev container and auto_rollback on enters ROLLING_BACK: the failed container is removed, -prev renamed back and started, and checked with the previous deployment's snapshot
  - A2 [it-rollback]: ROLLED_BACK only after that check passes, keeping the original error code and a message that names the restored version; otherwise FAILED with ROLLBACK_FAILED
  - A3 [it-rollback]: No -prev (first deploy) or auto_rollback off ends FAILED with the new container stopped and the previous image retained for manual rollback
  - A4 [test]: Rollback has its own bounded budget inside NOODARA_DEPLOY_MAX_MS; rollback start and result are activity events without sensitive metadata
  - A5 [it-rollback]: After rollback success and rollback failure the ledger cleanup leaves no orphan containers, images beyond retention, networks or workspaces
  - H1 [test]: If the rollback restore itself fails (rename or start error, SSH drop), the deployment ends FAILED/ROLLBACK_FAILED within the rollback budget, never stays in ROLLING_BACK, and the worker does not retry the rollback recursively (single attempt, tested)
  - H2 [test]: A rollback triggered by a deployment that was itself CANCELLED or timed out in BUILDING never fires (auto-rollback applies only to DEPLOYING/HEALTHCHECK failures), tested per source state
  - A6 [it-healthcheck]: runtime-healthcheck integration cases that expect FAILED set autoRollback:false and still pass
- [x] 17-04 (wave 5) Runtime: image retention after SUCCESS and ROLLED_BACK — done
  - A1 [test]: After a terminal SUCCESS or ROLLED_BACK, the service's images outside the imageRetention keep set are removed; the running image is never removed
  - A2 [test]: A failed image removal is logged and reported, never changes the deployment result
  - A3 [it-rollback]: Integration: after five deploys with retention 3, exactly the running image and three previous known-good images remain
  - H1 [test]: Image retention runs under the same per-service serialization as deployments so it cannot race with an in-flight deploy or manual rollback and remove an image that a PREPARING rollback target needs; image removal only targets images with the noodara/<serviceId> repository and managed label
- [x] 17-05 (wave 6) Manual rollback: API, worker path without build, traceable history — done
  - A1 [it-rollback]: POST /api/services/:id/rollback with an optional targetDeploymentId creates a deployment with trigger rollback and rollback_of set; the default target comes from selectRollbackTarget
  - A2 [it-rollback]: 409 DEPLOYMENT_IN_PROGRESS while one is active; 422 ROLLBACK_TARGET_UNAVAILABLE with the reason; a target from another service is a 404 with no existence leak
  - A3 [it-rollback]: The worker goes PREPARING→DEPLOYING without clone or build, checks the image is on the server, restores the target's runtime config and passes HEALTHCHECK before SUCCESS; a failure rolls back to the version running before the manual rollback
  - A4 [it-rollback]: GET history is cursor-paginated and returns trigger, actor or delivery id, commit, image, previous and rollback_of for every row (ENG-02)
  - A5 [test]: Route body cap and zod validation on every new input; no field of the response carries a credential
  - H1 [test]: Manual rollback concurrent requests (two parallel POSTs, with and without Idempotency-Key) yield exactly one 202 and one 409 DEPLOYMENT_IN_PROGRESS or the replayed original; rollback targets whose image is missing on the server are re-validated in the worker (not only at the API) and end FAILED/ROLLBACK_TARGET_UNAVAILABLE without touching the running container
  - H2 [test]: The history endpoint caps page size, rejects malformed cursors/limits with 4xx, and scopes rows to the service in the path (foreign service id returns 404)
- [x] 17-06 (wave 7) Cancel and crash recovery in HEALTHCHECK and ROLLING_BACK; network-loss faults — done
  - A1 [it-runtime-cancel]: Cancel during HEALTHCHECK removes the new container, restores -prev and ends CANCELLED; cancel during ROLLING_BACK is rejected with a named 409 and the rollback completes
  - A2 [it-faults]: The boot sweep recovers rows in HEALTHCHECK or ROLLING_BACK: -prev is restored when present and the row ends FAILED/WORKER_CRASHED with a message saying so; the per-service container is never removed when it is the only version
  - A3 [it-faults]: runtime-faults covers container crash during healthcheck, SSH network interruption during healthcheck and during rollback (sshd paused), and worker kill in HEALTHCHECK; each ends in one valid terminal state with no orphan
  - A4 [test]: Every terminal state reached in these tests is reachable through transitionDeployment only (no direct status writes)
  - H1 [test]: Cancel racing with the HEALTHCHECK-to-SUCCESS transition and with the DEPLOYING-to-ROLLING_BACK transition leaves exactly one terminal state and exactly one running container; proven by a race test using the row lock
  - H2 [test]: The boot sweep is idempotent and safe when run by two workers at once (row lock / claim) and when the server is unreachable: the row is left for the next sweep with a warning, never marked terminal while the remote state is unknown

## Phase 18: Webhooks de GitHub e idempotencia — done
**Goal:** A signed GitHub push deploys exactly the pushed SHA once, duplicates and redeliveries never duplicate work, pushes during an active deploy coalesce, and API and worker retries are idempotent.
**Requirements:** ENG-03, HOOK-01, HOOK-02, HOOK-03
**Depends on:** 17

- [x] 18-01 (wave 1) Webhook enable/rotate/disable with an encrypted secret shown once — done
  - A1 [it-webhooks]: Enabling generates a 32-byte secret and a ≥128-bit random hook id from a CSPRNG; the response carries the payload URL and the secret once; GET never returns the secret
  - A2 [it-webhooks]: Rotate replaces the secret (old one rejected immediately); disable and service delete remove the credential row
  - A3 [it-webhooks]: The secret is encrypted with the existing credential store and never appears in logs, activity metadata, errors or later responses (leak canary covers it)
  - A4 [it-webhooks]: Image-source services get 422; the action requires a session and is an activity event
  - H1 [test]: Webhook secret and hook id come from crypto.randomBytes (no Math.random), the hook id is not derivable from service id, and rotation is atomic: a concurrent delivery during rotate is verified against exactly one of old or new secret, never neither or both
  - H2 [test]: Enable is idempotent while already enabled (does not silently rotate the secret, named 409 or returns without secret) and disable invalidates the hook id so a later delivery gets the same 401 as an unknown id
  - H3 [it-webhooks]: The payload URL is built only from the configured public origin (http or https, validated at boot), never from the request Host or X-Forwarded-* headers; the enable/rotate/disable routes have a body cap and zod validation
- [x] 18-02 (wave 2) Webhook receiver: raw-body HMAC, caps, rate limit, event validation, delivery dedupe — done
  - A1 [it-webhooks]: POST /webhooks/github/:hookId sits outside session auth and the origin guard, keeps the raw body, caps it at 1 MiB (413) and accepts only application/json (415)
  - A2 [it-webhooks]: X-Hub-Signature-256 is verified with timingSafeEqual over the raw bytes before JSON parsing; missing, malformed or wrong signatures and unknown hook ids get the same 401 body
  - A3 [it-webhooks]: Per-hook and per-IP rate limit returns 429; ping answers 200 and is recorded; ignored events answer 200 with their outcome
  - A4 [it-webhooks]: A matching push creates a webhook deployment (triggered_by github:<delivery>, requested SHA) in the same transaction as the delivery row; a repeated X-GitHub-Delivery returns the original deployment id and creates nothing
  - A5 [test]: Neither payload, signature nor secret is logged; error responses carry no internal ids
  - H1 [test]: HMAC verification compares equal-length buffers (length mismatch is rejected without throwing from timingSafeEqual), uses the raw bytes exactly as received (no re-serialization), and a signature check against a rotated-out secret fails; rate-limit counters are bounded in memory (no unbounded per-IP map growth)
  - H2 [test]: Delivery dedupe is race-safe: two concurrent identical X-GitHub-Delivery requests create exactly one deployment (unique constraint on hook+delivery id) and both answer 2xx with the same deployment id; a missing X-GitHub-Delivery header is rejected 400 after signature verification
  - H3 [test]: The receiver never triggers on a service whose project is archived, whose source is image, or whose webhook is disabled, recording a named outcome; a failure to enqueue after the delivery row is written marks the deployment FAILED with a named code rather than leaving QUEUED without a job
- [x] 18-03 (wave 3) Deploy the exact pushed SHA (shallow fetch by SHA) — done
  - A1 [it-deploy-templates]: With a requested SHA (validated 40-hex) the clone checks out exactly it, fetching it shallowly when the branch head moved; argv carries the SHA as one validated element
  - A2 [it-deploy-templates]: A SHA that the remote no longer has ends FAILED with COMMIT_NOT_FOUND and an actionable message
  - A3 [it-deploy-templates]: The recorded commit_sha equals the requested SHA on 22.04 and 24.04 with a fixture repo whose branch moved past it
  - A4 [it-runtime-pipeline]: Manual deploys without a requested SHA keep the v0.2 behaviour (runtime-pipeline green)
  - H1 [test]: A requested SHA is passed through the validated 40-hex branded type and never interpolated; a hostile value (leading '-', non-hex, 41 chars, short SHA) is rejected before any remote command, and fetch-by-SHA failure for servers disallowing it falls back or fails with COMMIT_NOT_FOUND per ADR 0010, tested against the real bare repo
- [x] 18-04 (wave 4) Coalesce pushes during an active deployment — done
  - A1 [it-webhooks]: A push while a deployment is active is stored as the service's pending trigger; a newer push replaces it and marks the older delivery superseded; the response is 202 coalesced
  - A2 [it-webhooks]: When the active deployment reaches any terminal state the worker claims the pending trigger atomically and enqueues exactly one webhook deployment, also under concurrent terminal events
  - A3 [it-webhooks]: A pending SHA equal to the SHA just deployed is dropped with outcome already_deployed
  - H1 [test]: Coalescing is race-safe under concurrent pushes: N parallel pushes while a deploy is active result in exactly one pending trigger (the newest by receipt order), all older deliveries marked superseded, and exactly one follow-up deployment
  - H2 [test]: If the follow-up enqueue from a pending trigger fails, the pending trigger is retained (not lost) and retried on the next terminal event or sweep; the drain is also executed on the worker-crash sweep path
- [x] 18-05 (wave 5) Idempotency-Key on deploy/redeploy/rollback and idempotent worker retry — done
  - A1 [it-idempotency]: Same Idempotency-Key and same request fingerprint within 24 h replays the original deployment; a different body gets 422 IDEMPOTENCY_KEY_REUSED; concurrent requests with one key create one row
  - A2 [it-idempotency]: Deploy jobs retry per ADR 0010; a retried job follows the ADR resume rule and never runs on a row that already reached a terminal state
  - A3 [it-faults]: Killing the worker during BUILDING and during DEPLOYING then letting the job retry leaves exactly one noodara-<serviceId> container, one deployment row per attempt and no orphan
  - A4 [test]: The BullMQ lock and stalled settings stay derived from NOODARA_DEPLOY_MAX_MS (D15) with a test
  - H1 [test]: Idempotency records expire after 24 h and are cleaned by a bounded job; the stored fingerprint contains no request secrets; an Idempotency-Key longer than 255 or with invalid characters returns 4xx without creating a deployment
  - H2 [test]: A re-delivered BullMQ job for a row in PREPARING/BUILDING/DEPLOYING follows the ADR resume rule without a second noodara-<serviceId> container, and a job for a terminal row exits without any remote command, proven by a fake-port call count
  - H9 [it-idempotency]: A unique-constraint violation on (service_id, idempotency_key) or on the webhook hook id maps to a typed API error (replay or 409), never a 500 (follow-up of 16-06 H3)

## Phase 19: UI de motor confiable, E2E y docs — done
**Goal:** The user configures healthchecks, auto-rollback and the GitHub webhook, follows healthcheck and rollback in the deploy narration, reads a traceable history and rolls back from it, with the roadmap E2E paths and docs.
**Requirements:** UI-13, DOCS-03, QA-12
**Depends on:** 18

- [x] 19-01 (wave 1) Narration and status for HEALTHCHECK, ROLLING_BACK and ROLLED_BACK — done
  - A1 [test]: Steps read clone or pull, build, start, healthcheck and, when it happened, rollback, each with duration and state; ROLLED_BACK names the restored commit
  - A2 [test]: Every new error code has copy with a recovery action; status pills for the new states use only semantic infrastructure colours per noodara-ux-apple
  - A3 [e2e-deploy]: Existing deploy E2E stays green
  - H1 [test]: Unknown or future status/error-code values from the API render a generic fallback pill and message instead of throwing; user-facing copy never includes raw remote stderr
- [x] 19-02 (wave 2) Healthcheck and auto-rollback settings in the service sheet — done
  - A1 [test]: Default shows 'Container is running'; choosing HTTP or TCP reveals only its fields (progressive disclosure)
  - A2 [test]: Client validation uses the shared domain schema and shows the same named errors as the API
  - A3 [test]: Saving says the change applies on the next deploy; auto-rollback is a labelled switch, on by default
- [x] 19-03 (wave 3) Webhook panel: enable, secret once, rotate, disable, recent deliveries — done
  - A1 [test]: Enable shows the payload URL and the secret once with copy buttons and a plain statement that it will not be shown again; the secret leaves the DOM when the panel closes
  - A2 [test]: Rotate and disable ask for confirmation; image-source services do not show the panel
  - A3 [test]: Recent deliveries list outcome, short SHA, time and a link to the deployment; GET /api/services/:id/webhook/deliveries is paginated and returns no payload
  - H1 [test]: The webhook secret is held only in component state (not localStorage, URL, query cache or logs/console), is cleared on unmount and on rotate/disable, and the copy buttons announce success accessibly
  - H2 [test]: Deliveries list renders outcome, SHA and ids as text only and tolerates unknown outcomes with a fallback row; the payload URL is built from the server-provided origin and validated hook id only
  - H3 [test]: GET /api/services/:id/webhook/deliveries validates limit and cursor with zod, caps the page size and rejects malformed cursors with 400
- [x] 19-04 (wave 4) Traceable history and manual rollback from it — done
  - A1 [test]: Rows show trigger and actor (you, GitHub push, rollback of, automatic), short commit, duration and status; detail on demand
  - A2 [test]: Rollback is offered on known-good rows with a retained image; the dialog names the target commit; a pruned image disables it with the reason
  - A3 [test]: The rollback request sends an Idempotency-Key so a double click creates one deployment
  - H1 [test]: Rollback dialog confirm button is disabled while the request is in flight and the Idempotency-Key is generated with crypto.randomUUID once per dialog open and reused on retry; a 409 DEPLOYMENT_IN_PROGRESS shows actionable copy
  - H2 [test]: api-client accepts an optional Idempotency-Key per request (tested); DeploymentView exposes an optional imageRetained boolean computed by the server from the same retention rule planRollback uses
- [x] 19-07 (wave 5) Service API accepts healthcheck and auto-rollback; webhook panel entry point — done
  - A1 [test]: Service create and edit accept optional healthcheck and autoRollback, validated with the shared domain schema (validateHealthcheckConfig); invalid input returns 400 with the same named errors the UI shows
  - A2 [test]: ServiceView returns the stored healthcheck and autoRollback (auto-rollback defaults to on), so the service sheet round-trips what it saved and the next deploy uses it
  - A3 [test]: Git-source service pages show a 'Push webhook' control that opens the inspector panel (?webhook=1); image-source services do not show it
- [x] 19-05 (wave 6) E2E: webhook happy path, failure path, rollback path, duplicate delivery — done
  - A1 [e2e-engine]: Happy path: a signed push posted by the test helper to the hook URL shows QUEUED … HEALTHCHECK → SUCCESS in the UI and the published port answers with the new version
  - A2 [e2e-engine]: Failure path: a push of the unhealthy fixture ends ROLLED_BACK and the good version answers on the published port at every sample except the documented replacement window
  - A3 [e2e-engine]: Rollback path: a bad deployment ends FAILED or ROLLED_BACK, then a manual rollback from the history ends SUCCESS with the previous commit healthy
  - A4 [e2e-engine]: Redelivering the same X-GitHub-Delivery adds no history row
  - H1 [test]: E2E signed-push helper computes the HMAC over the exact bytes sent and tests a wrong-signature push (401, no history row) and a ping, so the negative auth path is exercised through the real stack; E2E stack is fresh per run and the secret is a per-run random value
- [x] 19-06 (wave 7) Docs (healthchecks, webhooks, rollback) and UX review — done
  - A1 [site-build]: Pages for healthchecks, GitHub webhooks (setup, public URL requirement, coalescing, redelivery) and rollback (retention, replacement downtime until v0.4)
  - A2 [test]: The docs accuracy test covers the new error codes, defaults and bounds
  - A3 [manual]: noodara-ux-review report has no BLOCK; screenshots at 375 and 1280 px in both themes approved by a human
- [x] 19-08 (wave 8) Phase 19 review fixes: healthcheck error shape, deliveries route test, rollback step duration, dialog focus — done
  - A1 [test]: healthchecks.mdx and error-codes.mdx describe the error a client actually receives for an out-of-bounds healthcheck through POST/PATCH (400 VALIDATION_FAILED with issues, unless the API is changed to match the docs); the docs accuracy test asserts the status and code pairing, not just that the string appears
  - A2 [test]: mapHealthcheckFailure maps the real API rejection shape for an invalid healthcheck to the named field error; the ServiceSheet test mocks that real response shape and asserts the named error, not the generic save-failed banner
  - A3 [test]: A DB-backed integration test for GET /api/projects/:projectId/services/:serviceId/webhook/deliveries covers a 400 on a malformed cursor, keyset paging, per-service scoping (no rows of another service) and the absence of payload fields
  - A4 [test]: The Rollback row in DeploymentSteps shows a duration when start/end are known (test)
  - A5 [test]: RollbackDialog traps focus while open and restores focus to the trigger on close (test)
  - A6 [test]: A WebhookPanel test asserts the shown-once secret never reaches localStorage, sessionStorage, the URL or console output
  - A7 [manual]: docs/ui-review/phase-19/REPORT.md records A3 human approval given by the user on 2026-10-18

## Phase 20: Hardening, stress y gate de release v0.3 — done
**Goal:** Prove v0.3's acceptance criteria: the full integration matrix, 100 deploy/rollback cycles without corruption or orphans, a security review, the release gate and v0.3.0.
**Requirements:** QA-11, QA-13, QA-14
**Depends on:** 19

- [x] 20-01 (wave 1) Integration matrix of roadmap §8.8 complete on both Ubuntu versions — done
  - A1 [test]: docs/releases/v0.3-scenarios.md maps each of the twelve §8.8 scenarios to one named test; a unit test fails if a mapped test name is missing
  - A2 [it-deploy-engine-all]: Missing scenarios (dependency failure, Docker build failure on both versions) are added; the whole deploy-engine suite is green with NOODARA_TEST_UBUNTU=all
  - H1 [test]: The scenario map test also fails when a mapped test is skipped (it.skip/todo) or when a scenario lacks coverage on either Ubuntu version
- [x] 20-02 (wave 2) Stress: 100 deploy/rollback cycles, zero orphans, zero lost records; nightly — done
  - A1 [it-cycles]: 100 cycles alternating good deploy, unhealthy deploy with automatic rollback and manual rollback end with one row per request, every row terminal, and every status sequence valid when replayed through transitionDeployment
  - A2 [it-cycles]: Afterwards: one service container, images equal to the retention set, no extra networks, workspaces or -prev containers, docker system df stable within a documented bound
  - A3 [manual]: nightly.yml runs the cycles suite and fails on any orphan
  - H1 [test]: The cycles suite records per-iteration duration and docker system df to a CI artifact, asserts no iteration exceeds NOODARA_DEPLOY_MAX_MS, and asserts Postgres row counts for deployment_log_chunks and webhook_deliveries match the requests issued (no lost or duplicated records)
- [x] 20-03 (wave 3) Security review of webhooks, secrets and new shell templates — done
  - A1 [manual]: noodara-security checklist applied to receiver, secret lifecycle, probe and rename templates and idempotency storage, findings fixed or recorded with mitigation in docs/security/v0.3-review.md
  - A2 [security-leaks]: The leak canary seeds a webhook secret and a signature and finds neither in HTTP, SSE, logs, activity or docker inspect
  - H1 [test]: The security review checks webhook receiver abuse cases with tests: replayed valid signed payload with a new delivery id for an already deployed SHA yields already_deployed, oversized/slow bodies are rejected, and a signature timing test shows no early-exit on prefix match; findings table lists severity, status and mitigation
  - H2 [manual]: pnpm audit reports no critical and only documented high vulnerabilities for new dependencies added in v0.3, and the leak canary also seeds the Idempotency-Key and rollback request bodies and finds no credential in idempotency storage
- [x] 20-04 (wave 4) Release gate v0.3 evidence — done
  - A1 [manual]: docs/releases/v0.3-gate.md gives READY / NOT READY with evidence for every §8.10 criterion, pinned to a commit
  - A2 [it-full]: it-full, e2e-full, site build, audit and migration hygiene green on that commit; CI and nightly green
  - H1 [manual]: The gate document lists each §8.10 criterion with a link to the exact test or log and the commit SHA, and a criterion without evidence forces NOT READY; the gate commit equals the commit that CI and nightly ran on
- [x] 20-05 (wave 7) Human gate and publish v0.3.0 — done
  - A1 [manual]: A human runs push → deploy → bad push → automatic rollback → manual rollback on a real install and an upgrade v0.2.0 → v0.3 with its rollback; evidence recorded
  - A2 [manual]: v0.3.0 tagged only after the user's approval; release.yml green with multi-arch images
  - H1 [manual]: The v0.2.0 to v0.3 upgrade check verifies the v0.3 migrations (0011-0013) on a database with real v0.2 deployments and services, that existing services default to container healthcheck, and that the documented downgrade/rollback path restores service without data loss
- [x] 20-06 (wave 3) Fix image retention after a manual rollback (API and worker agree) — done
  - A1 [test]: RED first: .agent-flow/handoffs/20-02-retention-red.test.ts.txt lands as a unit test in apps/control-plane/src/deploy/ and fails on the current code (G1..G4, M5 = manual rollback to G3, U6 unhealthy auto-rollback: worker removes G1 while the API lists it retained)
  - A2 [test]: Worker retention and API retainedImageRefs/planRollback use one rule: when the previous success is a rollback row, its effective image (the rollback target imageRef) counts as running; the RED test passes and no SUCCESS row the API marks imageRetained has its image removed
  - A3 [test]: Unit tests cover the previous success being a normal deploy, a manual rollback, a rollback of a rollback, and a rollback whose target image is already gone; existing retention tests stay green unchanged
  - A4 [it-cycles]: cycles.test.ts adds or reorders a cycle so an unhealthy deploy follows a manual rollback; the per-iteration host-images == API-retention check passes over the full run and the header gap comment is removed
  - A5 [it-rollback]: Rollback to every history row the API marks imageRetained succeeds after the sequence in A1 (no ROLLBACK_TARGET_UNAVAILABLE)
  - A6 [test]: The scenario-map checker test runs under pnpm test (moved to tests/unit/deploy-engine/ or equivalent), closing the 20-01 A1/H1 proof gap; the it-deploy-engine-all map stays the source it checks
- [x] 20-07 (wave 4) Fix deploy response missing imageRetained (20-06 regression) — done
  - A1 [test]: RED first: a unit or route test shows the deploy/redeploy response omits imageRetained although DEPLOYMENT_VIEW_FIELDS lists it
  - A2 [it-deploy-queue]: Every response built from a deployment view (deploy, redeploy, rollback, list, get) returns imageRetained consistent with serviceImageRetention; tests/integration/queue/deploy-queue.test.ts passes unchanged in its assertions
  - A3 [it-full]: pnpm test:integration (it-full) is green with port 3000 free
- [x] 20-08 (wave 4) Release prep: 0.3.0 version and v0.3 notes for v0.3.0-rc.1 — done
  - A1 [test]: Every workspace package.json is 0.3.0 and node scripts/check-release-version.mjs passes for v0.3.0-rc.1 and v0.3.0 (lockfile consistent)
  - A2 [test]: docs/releases/v0.3.0.md (concise) lists the v0.3 features (healthchecks, auto/manual rollback, GitHub webhooks, idempotency, cancel/crash recovery), the upgrade v0.2.0 → v0.3 and rollback steps with the NOODARA_VERSION pin, migrations 0011-0013 and known limits (no domains/HTTPS, no env vars/secrets yet)
  - A3 [build]: README and the public site/install docs point to v0.3.0 notes and describe v0.3 without placeholders for v0.4 features; docs/releases/v0.3-scenarios.md points to the moved scenario-map test path
- [x] 20-09 (wave 5) UAT findings: healthcheck log line breaks, downgrade caveat, sudo in release notes — done
  - A1 [test]: F1: every system line written to the healthcheck and rollback log phases ends with a newline, so consecutive lines never run together; a unit test written RED first proves it
  - A2 [manual]: F2: docs/releases/v0.3.0.md (Rollback section) warns that after downgrading to v0.2.0 the deployment history of services that ran v0.3 deployments (webhook/rollback triggers, ROLLED_BACK) cannot be read until re-upgrading; data is not lost
  - A3 [manual]: F3: every installer command in docs/releases/v0.3.0.md runs it with sudo
- [x] 20-10 (wave 6) Dependency security bumps: better-auth, next, zod, vite, undici (audit red on v0.3.0 CI) — done
  - A1 [test]: `pnpm audit --audit-level=high` reports zero high/critical: better-auth >=1.7.7, next >=16.4.1, zod >=4.6.6, vite >=8.3.3, undici >=8.12.2 (direct bumps or pnpm overrides for transitive deps)
  - A2 [test]: Bumped packages pass the supply-chain provenance check (allowlist/ADR 0000 updated only for versions from the same verified publishers)
  - A3 [test]: Auth behaviour unchanged after the better-auth bump: login, session expiry/revocation, lockout and setup-token suites green (unit, integration and E2E)
  - A4 [test]: Web and site build and run on the bumped next; E2E suite green
- [x] 20-11 (wave 7) Fix flaky seed port collision in migration integration tests — done
  - A1 [test]: Seeded servers get unique (host, port) pairs deterministically (no port derived from random uuid digits); CI run 40996535993's servers_host_port_unique_idx collision cannot recur
  - A2 [test]: it-db passes 10 consecutive local runs

## Phase 21: Dominios, TLS y secrets — contratos, dominio y esquema — done
**Goal:** Resolve the v0.4 remote contracts with evidence (ADR 0011: Traefik file provider, ACME with Pebble, certificate probe, --env-file semantics) and land the pure domain (hostname, certificate state machine, env precedence, secret references, proxy config renderers) plus the additive schema and error-code ripple, without changing runtime behaviour.
**Requirements:** DMN-01, DMN-03, ENV-02, TLS-02
**Depends on:** 20

- [x] 21-01 (wave 1) Spike + ADR 0011: Traefik file provider, ACME via Pebble, cert-status probe, --env-file semantics — done
  - A1 [it-contracts-v04]: Traefik file-provider contract measured on 22.04 and 24.04: a digest-pinned traefik v3 container on the fixture dockerd binds host 80/443, loads a dynamic file written temp + rename within a recorded delay, routes a Host rule to http://noodara-<serviceId>:<port> by Docker DNS on noodara-net-<serviceId>, and keeps routing after the ADR 0010 -prev rename and new-container start (swap window measured); the Traefik API answers only on 127.0.0.1 of the host and lists the router
  - A2 [it-contracts-v04]: ACME contract with Pebble + challtestsrv in Testcontainers: HTTP-01 issuance to the fixture host completes with the DNS answer controlled by the test and the Pebble root trusted by Traefik (LEGO_CA_CERTIFICATES); a short validity (Pebble certificateValidityPeriod + Traefik certificatesDuration) yields an observed renewal within a bounded time recorded in the ADR
  - A3 [it-contracts-v04]: Certificate-status probe chosen with evidence: openssl presence on stock Ubuntu 22.04/24.04 measured; openssl s_client -servername to 127.0.0.1:443 with output capped to issuer and notAfter distinguishes proxy down, default certificate and issued certificate; acme.json is never read by the control plane
  - A4 [it-contracts-v04]: docker create --env-file semantics measured: literal values (quotes, backslash-n, leading spaces, = inside values, # lines), multi-line unsupported, size limit; the file under <workspace>/secrets/env is removable right after create; the value shows in docker inspect .Config.Env (recorded exposure) and not in docker ps, in the --format templates Noodara uses, or in image history
  - A5 [adr-0011-accepted]: ADR 0011 fixes with rejected alternatives (Docker provider + labels, Caddy, control-plane-side ACME, reading acme.json, curl-based probes): dynamic config shape and naming, static config (entrypoints, HTTP-01 resolver, api on 127.0.0.1, no docker provider, file provider watching the dynamic dir), /opt/noodara-proxy layout and permissions, the certificate state table and timings, the dns-check outcomes, the redirect rule; status Accepted
  - H1 [test]: Every probe and measurement runs under env -i ... timeout with a hard cap and an output cap; no probe sends service env or secrets; no implicit image pull beyond the digest-pinned traefik and pebble images listed in the fixture allowlist (a test rejects :latest)
  - H2 [manual]: The file-provider behaviour on an invalid or partially written dynamic file is measured and recorded in ADR 0011 (whether Traefik keeps the last good routers or drops them, and how long until the next good write is picked up); the 22-01 restore path and the 22-03 verify step are specified against that measured behaviour
  - H3 [test]: No integration or E2E fixture configures the Let's Encrypt production or staging CA: a unit test over tests/integration and tests/e2e asserts every ACME CA URL is the Pebble container URL, so test runs can never consume real ACME rate limits
  - H4 [it-contracts-v04]: The HTTP to HTTPS redirect is measured as non-cacheable: Traefik redirectScheme with permanent=false answers 302 (never 301/308), and after the redirect middleware is removed from the dynamic file a plain HTTP request to the same Host is served again; ADR 0011 fixes this so the per-domain httpsRedirect switch is reversible in browsers
- [x] 21-02 (wave 2) Domain: hostname validator, Domain entity, certificate state machine, DNS outcomes, 100% branch gate — done
  - A1 [test]: validateHostname accepts a lowercase FQDN of at most 253 chars with labels 1-63 of [a-z0-9-] (no leading/trailing hyphen), punycode xn-- labels; it rejects a scheme, path, port, whitespace, trailing dot, uppercase (caller normalises first), IPv4/IPv6 literals, localhost, single-label names and wildcards, each with a named error
  - A2 [coverage-state-machine]: CERT_STATUSES = NONE PENDING ISSUED RENEWING FAILED EXPIRED with a transition table per ADR 0011; every one of the 36 ordered pairs is asserted; decideCertStatus(current, probe, now, timings) is pure and covers issued / default / down / expired / renewal-window inputs; coverage-state-machine now also requires 100% on cert-status.ts
  - A3 [test]: Certificate failure causes CERT_DNS_MISMATCH, CERT_ISSUANCE_FAILED, CERT_PROXY_UNAVAILABLE and DNS outcomes RESOLVES, MISMATCH, UNRESOLVED, UNAVAILABLE are closed vocabularies with fixed actionable messages; dnsInstructions(hostname, serverIps) returns the A/AAAA records and the CNAME alternative as data
  - A4 [test]: MAX_DOMAINS_PER_SERVICE (10) and isReservedHostname(hostname, publicUrlHost) are exported and tested; the domain-model skill §5 documents the table and points to ADR 0011, mirrored in docs/domain/cert-status-transitions.md
  - H1 [test]: A property test feeds random strings to validateHostname without a throw, and asserts that normalising then validating a valid hostname is idempotent
  - H2 [test]: validateHostname rejects names under the special-use TLDs .localhost, .local, .internal, .arpa, .onion and .example with a named error (while .test stays accepted for fixtures), and dnsInstructions never emits a record for a rejected name
- [x] 21-03 (wave 2) Domain: env keys and values, secret names, <secret:name> references, resolveEnv precedence, env-file rendering — done
  - A1 [test]: validateEnvKey enforces ^[A-Z_][A-Z0-9_]*$ and at most 128 chars; validateEnvValue rejects newline, carriage return and NUL (ENV_VALUE_MULTILINE with the base64 hint) and values over 32 KiB; validateSecretName enforces ^[a-z][a-z0-9_]{0,63}$; parseEnvValue classifies exactly the whole-string form <secret:name> as a reference and anything else as plain
  - A2 [test]: resolveEnv(project, environment, service) is deterministic: service > environment > project, output sorted by key, each entry carrying its origin scope and the shadowed definitions; tests cover all eight present/absent combinations per key and a reference shadowed by a plain value and vice versa
  - A3 [test]: resolveSecretRefs(resolved, secretsByScope) resolves names with the same precedence and returns {key, secretRef, secretVersion}; a missing name yields SECRET_UNRESOLVED naming the key and reference only
  - A4 [test]: renderEnvFile(entries) emits KEY=VALUE lines in deterministic order consistent with the 21-01 A4 measurement; tests cover =, quotes, spaces, #, empty values and reject any value that the measurement showed --env-file cannot carry
  - A5 [test]: SecretKind gains app_secret; MAX_ENV_VARS_PER_SCOPE (200) and MAX_SECRETS_PER_SCOPE (100) are exported and tested; the domain-model skill §6 is updated
  - H1 [test]: A property test asserts for random three-scope inputs that the resolved key set is the union, each value equals its highest-precedence definition and no key repeats
  - H2 [test]: parseEnvValue returns a named error (never classifies as plain) for a malformed reference such as <secret:>, <secret:../x>, <secret:Name> with uppercase, embedded whitespace, or a reference followed by other text, so a typo in a reference can never be injected as a literal value
  - H3 [test]: renderEnvFile enforces an exported aggregate cap MAX_ENV_FILE_BYTES derived from the 21-01 A4 --env-file measurement and returns a named error (not a truncated file) when the rendered output exceeds it
  - H4 [test]: Named errors from validateEnvKey, validateEnvValue, validateSecretName, parseEnvValue, resolveSecretRefs and renderEnvFile carry only the key, the reference name, the byte length and the offending character class, never the value: a test pushes a canary value through every error path and asserts the canary is absent from the error code, message and fields
- [x] 21-04 (wave 3) Domain: proxy dynamic and static config renderers, proxy state machine, proxy change plan — done
  - A1 [test]: renderDynamicConfig(service, domains) produces the ADR 0011 JSON: per domain an http and an https router with a Host rule from the branded hostname, one service pointing at http://noodara-<serviceId>:<internalPort>, the redirect middleware when httpsRedirect is on and the ACME resolver on the https router; output is byte-identical for the same input in any order (snapshot tests)
  - A2 [test]: renderStaticConfig(acme) produces entrypoints 80/443, the HTTP-01 resolver with caUrl and email, the api bound to 127.0.0.1 only, the file provider watching the dynamic dir and no docker provider; caUrl must be https (http only through the explicit test-seam flag), email validated
  - A3 [test]: PROXY_STATUSES = NOT_INSTALLED INSTALLING RUNNING FAILED with a transition table and every ordered pair asserted; proxy error codes PROXY_PORT_IN_USE, PROXY_INSTALL_FAILED, PROXY_UNAVAILABLE, PROXY_IN_USE, PROXY_ROUTE_FAILED and deployment error codes SECRET_UNRESOLVED, ENV_INJECTION_FAILED, PROXY_ROUTE_FAILED carry fixed actionable messages
  - A4 [test]: planProxyChange(current, desired) returns the dynamic files to write or remove and the networks to connect or disconnect, pure and tested; docker-naming gains proxyContainerName, proxyDynamicPathFor(serviceId) and the /opt/noodara-proxy layout, accepting only validated UUIDs
  - H1 [test]: Router, service and middleware names derive only from UUIDs and validated hostnames; a test proves no rendered string can contain quotes, newlines, @, / or whitespace coming from input
  - H2 [test]: renderStaticConfig disables Traefik telemetry and update checks (global.sendAnonymousUsage=false, global.checkNewVersion=false), leaves the dashboard and insecure api off, disables the access log by default and sets log level WARN; asserted by snapshot
  - H3 [test]: The https routers reference a TLS options block with minVersion VersionTLS12 rendered in the dynamic config; a snapshot test asserts no router serves TLS below 1.2
  - H4 [test]: planProxyChange is convergent: planProxyChange(x, x) is empty, and a property test asserts that applying the plan to current and re-planning against desired yields an empty plan for random current/desired sets
  - H5 [test]: renderDynamicConfig renders the HTTP to HTTPS redirect middleware with permanent=false (302) per the 21-01 measurement and a snapshot test rejects any permanent redirect, so a domain whose httpsRedirect is toggled off is served over plain HTTP again by browsers that saw the redirect
- [x] 21-05 (wave 4) api-contract schemas, HTTP/deployment error ripple, unique-violation mapper, runtime config v2, env knobs — done
  - A3 [test]: api-contract zod schemas for domains, variables (incl. the effective view with origin and shadowed), secrets (strict views without any value key) and proxy views; HTTP codes and statuses: DOMAIN_ALREADY_ASSIGNED 409, DOMAIN_RESERVED 422, DOMAIN_LIMIT_REACHED 422, PROXY_PORT_IN_USE 409, PROXY_INSTALL_FAILED 502, PROXY_UNAVAILABLE 503, PROXY_IN_USE 409, PROXY_ROUTE_FAILED 502, ENV_KEY_DUPLICATE 409, ENV_VALUE_MULTILINE 422, ENV_LIMIT_REACHED 422, SECRET_NOT_FOUND 422, SECRET_IN_USE 409, SECRET_NAME_DUPLICATE 409, SECRET_LIMIT_REACHED 422; api-client, error-copy, deploy-error-copy and error-codes.mdx carry every new code (accuracy test)
  - A5 [test]: parseRuntimeConfigSnapshot accepts v2 with env: [{key, value} | {key, secretRef, secretVersion}] next to v1 (v1 parses as empty env); a snapshot carrying a value for a secretRef entry is rejected
  - A6 [test]: env.ts, .env.example and turbo.json add NOODARA_ACME_CA_URL (https URL, default Let's Encrypt production), NOODARA_ACME_CA_ROOT_FILE (optional test seam), NOODARA_CERT_CHECK_INTERVAL_MS (default 600000, bounded), NOODARA_CERT_ISSUE_TIMEOUT_MS (default 600000, bounded) and NOODARA_PROXY_IMAGE (digest-pinned default, override must match name@sha256:<64 hex>), each with tests
  - H1 [test]: The secret view schema is strict and rejects a value key, and a unique-constraint violation on hostname, variable key or secret name maps to its typed 409, never a 500 (pure mapper over exported constraint-name constants, unit test)
  - H2 [test]: parseRuntimeConfigSnapshot v2 rejects an env array with duplicate keys, a key failing validateEnvKey, a secretRef failing validateSecretName, or more entries than MAX_ENV_VARS_PER_SCOPE * 3, as a named parse error
- [x] 21-06 (wave 5) Schema: migrations 0014 (enums) and 0015 (domains, secrets, environment_variables, server proxy columns), drift test — done
  - A1 [it-db]: Migration 0014 adds enum values and new enums only (deployment_error_code += SECRET_UNRESOLVED, ENV_INJECTION_FAILED, PROXY_ROUTE_FAILED; domain_cert_status, domain_dns_status, proxy_status, env_scope); 0015 creates domains (hostname unique on lower(), composite (service_id, project_id) FK like services, https_redirect, cert_status, cert_not_after, cert_error_code, dns_status, dns_checked_at, apply_status), secrets (scope, owner FKs matching the scope by CHECK, name unique per owner, encrypted_value, key_version, version, hint), environment_variables (scope, owner FKs, key unique per owner, value) and servers.proxy_status/proxy_error_code/proxy_acme_email/proxy_installed_at; owners cascade; both apply from scratch and from the v0.3.0 schema with rows unchanged; migration-hygiene stays green
  - A2 [it-db]: Drizzle schema matches the migrations; schema-ownership tests prove a domain, variable or secret of another project is impossible by FK
  - A4 [test]: The drift test (domain tuples vs DB enum vs api-contract) covers the new statuses, scopes and error codes
  - H1 [it-db]: The secrets table has no plaintext column; the constraint names used by the 21-05 unique-violation mapper are the ones the Drizzle schema and migration 0015 create (shared exported constants)
  - H3 [it-db]: Migration 0015 creates the unique indexes that back concurrent writes: domains.hostname global (stored lowercased), environment_variables (owner scope id, key) and secrets (owner scope id, name); api-contract request schemas bound every string (hostname 253, env key 128, env value 32 KiB, secret name 64, secret value 64 KiB, ACME email 254) and the it-db test proves a second insert of each tuple fails with 23505

## Phase 22: Reverse proxy, dominios y TLS en el runtime — done
**Goal:** Operate a Traefik proxy per server over SSH, add and remove domains with atomically applied and revertible routing, issue and renew certificates automatically, derive certificate status with a host-side probe, and keep routes correct across replace, rollback and service deletion.
**Requirements:** PRX-01, PRX-02, DMN-02, TLS-01, TLS-03
**Depends on:** 21

- [x] 22-01 (wave 1) SSH templates: proxy lifecycle, atomic dynamic writes, Traefik API read, TLS probe, env-file create — done
  - A1 [test]: Allowlisted templates per ADR 0011: proxy.prepare_dirs (0700 dirs, 0600 files), proxy.write_static (stdin), proxy.write_dynamic (stdin to temp + rename keeping .prev), proxy.restore_dynamic, proxy.remove_dynamic, proxy.create (digest-pinned image, 80/443 published, api on 127.0.0.1, config and acme volumes, labels noodara.managed and noodara.proxy), proxy.status (GET /api/http/routers/<name>@file on 127.0.0.1 via /dev/tcp, capped), proxy.ports_in_use (ss -ltnp for 80/443, parsed), tls.cert_status (openssl s_client with SNI, issuer and notAfter only), docker.network_disconnect; dockerCreate gains an envFile option rendered as --env-file <path>
  - A2 [test]: Allowlist tests reject every other shape: hostnames or paths with shell metacharacters, an unpinned or wrong image, api on 0.0.0.0, a dynamic path outside /opt/noodara-proxy/dynamic, an env-file path outside <workspace>/secrets
  - A3 [it-proxy-templates]: On 22.04 and 24.04 against real dockerd: install, write dynamic, router visible in the api, HTTP routed by Host, invalid dynamic restored from .prev with the router back, ports_in_use detects a listener, tls.cert_status distinguishes no proxy, default certificate and a Pebble-issued certificate
  - A4 [it-deploy-templates]: Every template runs under exec-with-timeout or the supervised wrapper with output caps; stdout/stderr pass the Redactor; deploy-templates stays green with the envFile option unused
  - H1 [it-proxy-templates]: The dynamic write is atomic: interrupting a large write leaves either the old or the new file, never a partial one, and .prev is 0600
  - H2 [test]: tls.cert_status output is at most 512 bytes and never contains BEGIN CERTIFICATE or key material (asserted)
  - H3 [test]: proxy.create sets --restart unless-stopped so the proxy returns after a host reboot; the template test asserts the flag and the fixture test asserts the container is running again after docker restart of the proxy and the router still answers
  - H4 [test]: The proxy.ports_in_use parser distinguishes a listener owned by the Noodara proxy container (docker-proxy for noodara-traefik) from a foreign process and reports only the foreign one, so re-install on a RUNNING proxy never yields PROXY_PORT_IN_USE; unit tests cover ss output for both cases on 22.04 and 24.04 formats
  - H5 [test]: tls.cert_status runs openssl s_client with stdin closed (</dev/null) and -connect to 127.0.0.1:443 only, so it never blocks waiting for input; the parser handles openssl's notAfter format (GMT, double-space day) and any unparseable output yields the down/unavailable outcome instead of a throw
  - R1 [test]: Phase 21 review follow-ups: ADR 0011's static-config section matches packages/domain/src/proxy/static-config.ts (api.insecure false, WARN log, noodara-api.yml router to api@internal on 127.0.0.1:9180); the rendered canonical-JSON dynamic files and the noodara-api router are loaded by a real Traefik in an integration test (not only snapshots)
- [x] 22-02 (wave 2) Proxy lifecycle service: install job with port preflight, status, remove, server deletion — done
  - A1 [it-proxy]: installProxy(serverId) runs as job proxy-install-<serverId> (deterministic id, per-command SSH timeout, total budget): ports 80/443 preflight fails with PROXY_PORT_IN_USE naming the listening process, then prepare dirs, write static config (admin or per-server ACME email, CA URL, root file when set), pull the pinned image, create and start, verify the api; servers.proxy_status moves only through the domain table; activity server.proxy_installed | proxy_failed | proxy_removed without sensitive metadata
  - A2 [it-proxy]: Re-install is idempotent on a RUNNING proxy; a FAILED one is retried by POST /api/servers/:id/proxy or by the next first-domain; the server view exposes proxyStatus, proxyErrorCode, proxyAcmeEmail and proxyInstalledAt; PATCH accepts proxyAcmeEmail (validated email) and re-renders the static config
  - A3 [it-proxy]: POST /api/servers/:id/proxy/remove answers 409 PROXY_IN_USE while any domain exists on the server; otherwise stops and removes the container and files and ends NOT_INSTALLED
  - A4 [it-delete-server]: deleteServer (no services) removes the proxy best-effort within a bound and records the outcome; a failure never blocks the deletion (delete-server suite green)
  - A5 [it-proxy]: On 24.04: install, port-in-use failure with a listener on 80, idempotent re-install, remove; the static config on the server holds the ACME email but no Noodara credential (canary assert)
  - H1 [test]: The boot sweep marks INSTALLING rows FAILED/PROXY_INSTALL_FAILED after the budget; concurrent installs for one server collapse into one job
  - H2 [test]: A failed install (pull error, create error or api verify timeout, each fault-injected) leaves no noodara-traefik container and no state under /opt/noodara-proxy that breaks the retry; the retry after each injected fault reaches RUNNING
  - H3 [test]: The proxy job payload carries only serverId, acmeEmail and the job id, never a credential or decrypted key (payload schema test); install logs, job progress and activity metadata pass the Redactor and a canary SSH credential seeded on the server never appears in them
- [x] 22-03 (wave 3) Domains API: add/remove, conflicts, DNS check and instructions, apply with rollback — done
  - A1 [it-domains-apply]: POST /api/projects/:p/services/:s/domains normalises and validates the hostname, answers 409 DOMAIN_ALREADY_ASSIGNED (global, case-insensitive), 422 DOMAIN_RESERVED for the NOODARA_PUBLIC_URL host and 422 DOMAIN_LIMIT_REACHED; the row and its activity event are written in one transaction; then the proxy is ensured (install job when NOT_INSTALLED) and the routes applied: connect the proxy to noodara-net-<serviceId>, render, write atomically, verify with proxy.status, on failure restore .prev and record PROXY_ROUTE_FAILED in apply_status
  - A2 [it-domains-api]: DELETE removes the row, rewrites or removes the dynamic file and disconnects the network when the service has no domains left; a foreign project id is a 404 without existence leak
  - A3 [it-domains-api]: GET lists hostname, httpsRedirect, dnsStatus and dnsCheckedAt, certStatus, certNotAfter, certErrorCode, applyStatus and the DNS instructions (A/AAAA to the server IPs, CNAME alternative); POST .../dns-check re-runs the resolver check (3 s timeout, rate-limited per domain) through the DnsResolverLike seam and never resolves anything but the validated hostname and the server host
  - A4 [it-domains-apply]: PATCH httpsRedirect re-renders and re-applies with the same verify-and-restore path
  - A5 [it-domains-apply]: On 24.04: add then HTTP by Host routed within the measured reload delay; delete then Traefik answers 404; a forced invalid write is restored and reported PROXY_ROUTE_FAILED; a stopped proxy yields 503 PROXY_UNAVAILABLE with the row kept and applyStatus pending
  - H1 [it-domains-api]: Two concurrent POSTs of one hostname yield exactly one 201 and one 409 (unique index), never 500; an uppercase hostname is stored lowercased
  - H2 [test]: Bodies are capped and strict; responses never include server credentials or ACME internals
  - H3 [test]: An SSH connection failure during apply maps to the existing typed server-unreachable error (never a 500), the domain row is kept with applyStatus pending, and the next reconcile cycle re-applies it (integration test with the fixture sshd stopped)
  - R1 [test]: The HTTP→HTTPS redirect response carries an explicit `Cache-Control: no-store` (or equivalent) so a removed redirect is never cached by clients; asserted in an integration test
- [x] 22-04 (wave 4) Certificate status reconciler: bounded probe cycle, failure causes, expiry, redirect verified — done
  - A1 [it-tls]: Per server, one bounded cycle every NOODARA_CERT_CHECK_INTERVAL_MS probes each domain over a single SSH session with tls.cert_status and applies decideCertStatus: issued certificate -> ISSUED with notAfter; default certificate while PENDING within NOODARA_CERT_ISSUE_TIMEOUT_MS -> unchanged; beyond it -> FAILED with CERT_DNS_MISMATCH when dnsStatus is not RESOLVES else CERT_ISSUANCE_FAILED; proxy down -> CERT_PROXY_UNAVAILABLE; notAfter past -> EXPIRED; a new certificate replacing one inside the renewal window passes through RENEWING
  - A2 [test]: After a domain create or PATCH the domain is checked at 15 s, 30 s and 60 s before the regular interval (backoff table in the domain package); a FAILED domain returns to PENDING on a successful dns-check or a PATCH; pending applyStatus rows are re-applied by the same cycle
  - A3 [test]: Status changes publish on the existing SSE channel as service.updated with the serviceId so the UI refetches; activity records domain.certificate_issued | failed | expired without sensitive metadata
  - A4 [it-tls]: On 24.04 with Pebble: add domain -> PENDING -> ISSUED with notAfter within the ADR bound; an HTTPS GET with the Pebble root succeeds through the proxy; DNS pointed elsewhere -> FAILED/CERT_DNS_MISMATCH after a test-shortened timeout; HTTP GET answers a redirect to https when httpsRedirect is on and 200 when off
  - H1 [test]: Two cycles never run concurrently for one server; an SSH failure leaves every status unchanged with a logged outcome (no FAILED flip); probe output beyond the cap is discarded and no certificate body is stored
  - H2 [test]: A cycle whose proxy.status finds no running noodara-traefik container on a server marked RUNNING transitions servers.proxy_status to FAILED/PROXY_UNAVAILABLE through the domain table and records server.proxy_failed once, not on every subsequent cycle
  - H3 [test]: Each tls.cert_status and proxy.status result is validated with a zod schema before decideCertStatus runs: an unknown status token, an unparseable notAfter, an oversized issuer or an out-of-order field leaves the domain status unchanged with a logged probe-invalid outcome and nothing stored in certNotAfter
  - H4 [it-tls]: A cycle whose proxy.status reports the dynamic file of a routed service missing on the host (deleted or lost after a reinstall) re-applies it once through apply-routes with verify-and-restore and records domain.route_restored; the integration test deletes the file and asserts the router is back in the Traefik API within one cycle
- [x] 22-05 (wave 5) Deploy integration: routes across replace and rollback, proxy connect on deploy, service delete — done
  - A1 [test]: A deploy of a service with domains ensures the proxy is connected to noodara-net-<serviceId> before the swap (idempotent connect), never rewrites the dynamic file, and the ledger never lists proxy resources for cleanup; services without domains issue no proxy command (unit-asserted)
  - A2 [it-routes-deploys]: On 24.04: HTTP through Traefik answers the new version after replace, the restored version after automatic rollback and after manual rollback; the swap-window error count is recorded and within the ADR 0011 bound
  - A3 [it-projects]: Service deletion removes the dynamic file and disconnects the proxy from the network before removing container, network, images and workspace; domain rows cascade; docker network rm no longer fails with the proxy attached (services-api suite)
  - A4 [it-runtime-pipeline]: Legacy suites stay green: runtime-pipeline, rollback, cancel
  - H1 [it-routes-deploys]: Cancel during DEPLOYING or HEALTHCHECK on a routed service leaves Traefik pointing at the restored -prev (HTTP asserted); a proxy in NOT_INSTALLED or FAILED while domains exist does not fail the deploy: a system log line is written and applyStatus stays pending
  - H2 [test]: When the service's internal port at deploy time differs from the port in the current dynamic file (service settings changed since the last apply), the deploy re-applies the routes after the swap through apply-routes with verify-and-restore; when equal the file is untouched (unit test with both cases, HTTP asserted on the fixture for the changed-port case)
  - H3 [test]: Dynamic-file applies for one service are serialized through a per-serviceId lock in apply-routes: a deploy re-apply (H2) and a concurrent domain POST, PATCH or DELETE for the same service never interleave writes; a unit test firing two concurrent applies asserts the final file equals the last desired state and .prev is the immediately preceding file, and the lock is released on every error path
- [x] 22-06 (wave 6) TLS renewal contract with Pebble short validity; nightly and CI wiring for the proxy suites — done
  - A1 [it-tls-renewal]: With Pebble short validity and Traefik certificatesDuration per ADR 0011, a certificate issued at T renews without intervention; the reconciler shows ISSUED -> RENEWING -> ISSUED with a later notAfter, and every HTTPS request made during the renewal succeeds
  - A2 [test]: nightly.yml runs tests/integration/proxy on 22.04 and 24.04 and fails on leftover noodara.test containers or networks; the CI integration job includes tests/integration/domains (DB-only) and excludes tests/integration/proxy like deploy-engine, documented in the workflow
  - H1 [it-tls-renewal]: The renewal test asserts acme.json stays 0600 on the server and that the control plane database holds no certificate or key material
- [x] 22-07 (wave 7) Review remediation: proxy lifecycle error paths, races and test gaps — done
  - A1 [it-proxy]: A failed re-install of a RUNNING proxy before the create step (prepare_dirs, write_config, pull) leaves the running noodara-traefik untouched and routing; cleanup only removes a container this attempt created. Proven with an injected pre-create fault on a running proxy
  - A2 [test]: Boot sweep failStaleInstalls has a DB-backed test; install staleness is keyed on a dedicated install timestamp, not servers.updatedAt, so discovery/connect writes cannot extend it
  - A3 [test]: proxy-runtime retry-after-fault assertions run against the faulted session state (not a fresh fake) and reach RUNNING
  - A4 [test]: proxy-service (requestProxyInstall, setProxyAcmeEmail, removeServerProxy) has unit tests and HTTP route tests that run in the PR test gate
  - A5 [test]: removeServerProxy serialises with install (lock or CAS) and returns an error when the ->NOT_INSTALLED transition does not apply; deleting a server is refused (409) while proxyStatus is INSTALLING; remote proxy removal does not run inside the FOR UPDATE transaction
  - A6 [test]: Changing proxyAcmeEmail while INSTALLING either is rejected (409) or produces a job carrying the new email, never a DB/static-config divergence; the servers PATCH is atomic: a proxy 409 leaves connection fields unchanged
  - A7 [test]: The Traefik status probe distinguishes starting from down; proxy.status has a single script body per allowlisted name (proxyReadDynamic gets its own allowlisted name)
  - A8 [it-tls-renewal]: Root cause of the two it-tls-renewal install failures is identified and fixed or documented in docs/adr/0011; the suite passes 3 consecutive runs
- [x] 22-08 (wave 8) Review remediation: domain delete, cert check schedule, route port, swap bound — done
  - A1 [it-domains-apply]: DELETE of a domain whose route rewrite or proxy disconnect fails does not report success silently: the failure is surfaced (non-2xx or a pending cleanup marker) and reconcile removes orphan dynamic/<serviceId>.yml files for services with no domains. Tested with a failing applier
  - A2 [test]: Post-change cert checks fire at t=15 s, 30 s and 60 s after the change (absolute offsets per ADR 0011), and the unit test encodes the spec, not successive delays
  - A3 [it-rollback]: The route applier renders the backend port actually deployed (including after a manual rollback to a deployment with a different port); proven by a manual-rollback-then-domain-PATCH case
  - A4 [test]: A single down probe does not flip proxy_status RUNNING->FAILED (requires consecutive failures or treats starting as transient), and CERT_PROXY_UNAVAILABLE clears when the proxy is reachable again
  - A5 [test]: Service delete removes the dynamic file under the apply-routes advisory lock after domain rows are gone, so concurrent applies cannot recreate an orphan
  - A6 [it-routes-deploys]: routes-across-deploys asserts the swap error count and window against a bound recorded in ADR 0011 (updated with the measured 22-05 bound)
  - A7 [it-runtime-cancel]: Cancel during DEPLOYING on a routed service is HTTP-asserted (route keeps serving the previous deployment)
  - A8 [it-domains-api]: v04 domain request bodies are strict at the schema layer (unknown keys rejected by Zod) and the API test pins a single status code
  - A9 [test]: Cert-cycle single-worker assumption (in-memory inFlight, CAS writes) is documented in ADR 0011, and recordRouteRestored is CAS-protected

## Phase 23: Variables de entorno y secrets — done
**Goal:** Manage environment variables at project, environment and service scope with deterministic precedence, store application secrets encrypted and referenced as <secret:name>, inject both at deploy time through a transient env file, and keep every Noodara surface free of plaintext.
**Requirements:** ENV-01, ENV-03, ENV-04, SCR-01, SCR-02, SCR-04
**Depends on:** 21

- [x] 23-01 (wave 1) Secret store: envelope boundary, SecretValue(app_secret), Redactor registration, secrets rotate — done
  - A1 [test]: secret-store is the only module in apps/control-plane importing both the envelope primitives and the secrets schema (boundary test like credential-store); createSecret, replaceSecret and decryptForDeploy return SecretValue(app_secret) only; hint = last 4 chars only when the value has at least 16 chars; version increments on replace
  - A2 [it-cli]: noodara secrets rotate re-encrypts secrets rows with the same transaction semantics and key-version rules as credentials; the integration test rotates both tables and decrypts every row afterwards
  - A3 [it-env-secrets]: decryptForDeploy registers each value in the given Redactor and the caller releases after the attempt (tested); tamper, wrong-key and malformed-blob errors surface as named store errors without the value; the logger canary shows only [REDACTED:app_secret]
  - H1 [test]: decryptForDeploy takes the owner scope chain (project, environment, service) of the deploying service and refuses with a named store error any secret id outside that chain, so a caller bug cannot decrypt another project's secret; unit and integration tests cover a foreign-project id
  - H2 [test]: Redactor registration of app_secret values is tested with a 3-char and a 64-char value: the long value is redacted wherever it appears while a very short value does not corrupt unrelated log text (documented minimum length or exact-token rule), and the rule is recorded in the noodara-security skill
  - H3 [it-env-secrets]: replaceSecret bumps version in a single UPDATE ... SET version = version + 1 with the ciphertext (no read-modify-write): two concurrent replaces end at version 3 with the ciphertext of the last committed write; secrets rotate running concurrently with a replace never leaves a row whose key_version disagrees with its ciphertext (row lock as in the credentials rotation)
- [x] 23-02 (wave 2) Variables API at three scopes, secret-reference validation, effective view with differsFromRunning — done
  - A1 [it-env-secrets]: Routes /api/projects/:p/env, /api/projects/:p/environments/:e/env and /api/projects/:p/services/:s/env list, create, update and delete with strict zod schemas: 409 ENV_KEY_DUPLICATE (exact key per owner), 422 ENV_VALUE_MULTILINE, 422 ENV_LIMIT_REACHED, 404 for a foreign project id; activity env.variable_created | updated | deleted carry scope and key only
  - A2 [it-env-secrets]: A value of the exact form <secret:name> is accepted only when a secret of that name is visible from the owner scope by precedence; otherwise 422 SECRET_NOT_FOUND naming the reference
  - A3 [it-env-secrets]: GET /api/projects/:p/services/:s/env/effective returns resolveEnv output (key, plain value or secretRef, origin scope, shadowed origins) and differsFromRunning computed against the latest SUCCESS or ROLLED_BACK snapshot (keys, plain values, reference names, secret versions); secret values never appear
  - A4 [it-projects]: Deleting a project or an environment deletes its scoped variables in the same transaction (projects suite green)
  - H1 [test]: Concurrent creates of one key yield one 201 and one 409 (unique index on owner + key); a canary value pushed through every error path never reaches logs, activity or HTTP errors; bodies are capped
  - H2 [test]: Updating a variable is validated identically to create (plain to reference and back re-checks SECRET_NOT_FOUND and ENV_VALUE_MULTILINE) and the key is immutable on update (a body with a different key is rejected 422), so no update can bypass the duplicate check
- [x] 23-03 (wave 2) Secrets API: create, replace, delete with in-use guard, redacted view, scoped cascade — done
  - A1 [it-env-secrets]: POST creates a secret (name, scope, single-line value of at most 64 KiB, non-empty) and answers 201 with {id, name, scope, hint, version, createdAt} and never the value; 409 SECRET_NAME_DUPLICATE per owner; 422 SECRET_LIMIT_REACHED; PUT replaces the value (version + 1, hint recomputed); GET list and get never return a value; no reveal endpoint exists
  - A2 [it-env-secrets]: DELETE answers 409 SECRET_IN_USE listing the referencing variables (scope and key) when any variable that would resolve to this secret references <secret:name>; otherwise deletes and records activity with name and scope only
  - A3 [it-projects]: Deleting a service, environment or project deletes its scoped secrets and variables in the same transaction, tested at each level; nothing is orphaned
  - H1 [test]: A canary value passed through create, replace and delete error paths never appears in logs, activity or HTTP errors; the value is accepted only as a JSON string with its length checked before encryption; strict schemas reject extra keys; bodies are capped
- [x] 23-04 (wave 3) Deploy injection: resolve env in PREPARING, transient env file, snapshot v2, rollback resolution, configure step — done
  - A1 [test]: loadDeployTarget loads the variables of the three scopes and the secrets they reference and resolves them with resolveEnv and resolveSecretRefs; a missing secret ends FAILED/SECRET_UNRESOLVED in PREPARING, before clone or build, with the running container untouched; secret values are registered in the Redactor for the attempt and released on every exit path
  - A2 [test]: The rendered env file is written with secrets.write_file to <workspace>/secrets/env (0600) and passed to dockerCreate as envFile; it is removed with the workspace on every exit path (ledger test); a write failure ends FAILED/ENV_INJECTION_FAILED with -prev restored as in 17-02 H2
  - A3 [it-rollback]: The runtime_config snapshot v2 stores plain values and {secretRef, secretVersion}, never a secret value; automatic rollback keeps restoring -prev unchanged; manual rollback rebuilds the env from the target snapshot (plain values as stored, references resolved now) and a reference that no longer resolves answers 422 ROLLBACK_TARGET_UNAVAILABLE naming the key and reference
  - A4 [test]: A configure step (variables and secrets counted, duration) appears in the deployment steps between prepare and build, logged in the prepare phase with keys and reference names only
  - A5 [it-runtime-env]: On 24.04 with fixtures/env-api (node app answering /health 200 and /env-digest with the sha256 of a named variable, context under 1 MiB): a plain variable and a secret reference reach the container, a change applies only on the next deploy, the SECRET_UNRESOLVED and ENV_INJECTION_FAILED paths end as specified, and services without variables keep the v0.3 behaviour (runtime-pipeline and rollback green)
  - H1 [test]: A static test over packages/ssh templates proves no docker inspect or docker ps --format selects .Config.Env; the deployment log canary never contains the secret value; the worker retry resume rule re-renders the env file rather than reusing one that may be gone, and the idempotency fingerprint excludes env values
  - H2 [test]: The transient env file is removed immediately after docker create returns, on success and on failure, before the healthcheck starts (integration assertion that <workspace>/secrets/env is gone while the new container is still starting), in addition to the workspace cleanup
  - H3 [test]: secrets.write_file creates the env file 0600 from the first byte (umask 077, temp + rename into <workspace>/secrets/env, no 0644 window) and verifies the byte count against stdin; a short write, a non-zero exit or a mismatch ends FAILED/ENV_INJECTION_FAILED before docker create runs (template test plus fault-injected unit test)

## Phase 24: UI de dominios, variables y secrets, E2E y docs — done
**Goal:** Let the user add domains with DNS instructions and certificate status, edit variables and secrets at every scope with redacted secrets and an effective view, see the proxy on the server, and prove the two roadmap E2E flows against Pebble; document everything on the site and pass the UX review.
**Requirements:** UI-14, DOCS-04, QA-16
**Depends on:** 22, 23

- [x] 24-01 (wave 1) Domains panel: add, DNS instructions, DNS and certificate pills, redirect switch, delete — done
  - A1 [test]: Add domain is one field validated client-side with the shared domain validator (same named errors as the API); on success the panel shows the DNS instructions (record type, name, value, copy buttons) and the pills DNS (unchecked / resolves / mismatch / unresolved) and Certificate (none / pending / issued / renewing / failed / expired) in semantic infrastructure colours only; Check DNS re-runs the check
  - A2 [test]: Expiry date, failure cause and apply status are disclosed on demand, not in the row; unknown statuses render a fallback pill; the panel states that HTTPS is served by the server proxy and shows installing or failed proxy states with a retry action
  - A3 [e2e-deploy]: Delete asks for confirmation naming the hostname; the HTTPS redirect switch is per domain; the existing deploy E2E stays green and ui-safety passes
  - H1 [test]: Hostnames and statuses render as text only; the open link uses the validated hostname with rel=noopener; the panel tolerates unknown fields and never shows raw error codes
- [x] 24-02 (wave 1) Variables and secrets editors at three scopes, secret picker, effective view with Redeploy to apply — done
  - A1 [test]: Variables table (mono key, value, origin) with inline add and edit using the shared validators; a <secret:name> value renders as a secret chip with the name; the value field offers Use a secret listing the secrets visible from that scope; every edit states that it applies on the next deploy
  - A2 [test]: Secrets panel: create with name and a masked value input that is never echoed back; rows show name, scope, hint, version and updatedAt; replace and delete ask confirmation and SECRET_IN_USE lists the referencing variables; no reveal control exists anywhere
  - A3 [test]: The service page shows the effective variables with an origin pill (service / environment / project), shadowed definitions on demand, and a Redeploy to apply notice when differsFromRunning is true
  - H1 [test]: Secret values live only in component state, cleared on submit and unmount, and never reach the URL, storage, console or query cache (test as in 19-03 H1); the masked input has an accessible label and autocomplete off; keys and values render as text only and unknown scopes fall back
- [x] 24-03 (wave 2) Proxy status in server detail, configure step narration, error and activity copy — done
  - A1 [test]: Server detail shows a Reverse proxy card with status (not installed / installing / running / failed), ports 80/443, ACME email (editable), retry on failure and remove (disabled with the reason while domains exist)
  - A2 [test]: Deployment steps show configure (n variables, m secrets, duration); SECRET_UNRESOLVED, ENV_INJECTION_FAILED and PROXY_ROUTE_FAILED have recovery copy naming keys and reference names, never values
  - A3 [e2e-servers]: Activity copy covers every new action (domain, certificate, proxy, env, secret) as text with a fallback for unknown actions; servers E2E and ui-safety stay green
- [x] 24-04 (wave 3) E2E: deploy -> domain -> DNS -> certificate -> HTTPS /health 200 (Pebble); secret -> deploy -> never exposed — done
  - A1 [e2e-domains]: Deploy node-api, add api.<run>.test, Check DNS shows resolves (challtestsrv answer), the Certificate pill reaches Issued, and an HTTPS GET /health from the runner with the Pebble root and the right SNI returns 200 through the proxy; HTTP GET answers a redirect
  - A2 [e2e-secrets]: Create secret database_url at the environment scope and DATABASE_URL=<secret:database_url> at the service scope, deploy env-api; /env-digest matches the sha256 of the plaintext while the UI (rows, effective view, build log, activity), the API list responses and the stack log files never contain the plaintext (canary grep)
  - A3 [e2e-domains]: Deleting the domain makes Traefik answer 404 for the host; deleting the service leaves the proxy disconnected and the network gone; teardown finds no noodara.test leftovers including proxy, Pebble and challtestsrv containers
  - H1 [e2e-secrets]: Negative paths covered: a domain whose DNS points elsewhere ends Failed with the DNS cause within the test-shortened timeout; deleting a referenced secret shows the SECRET_IN_USE copy; the Pebble root and the ACME test seam are passed only by the e2e stack and never appear in the control plane image or compose files
- [x] 24-05 (wave 4) Docs: domains and HTTPS, variables and secrets, precedence and limits; accuracy tests; UX review — done
  - A1 [site-build]: Pages Domains and HTTPS (DNS records, ports 80/443 and ufw, NOODARA_PORT off 80/443, Let's Encrypt limits, swap window, certificate states and failure causes) and Environment variables and secrets (scopes, precedence service > environment > project with the roadmap example, <secret:name> references, single-line limit with the base64 hint, applies on next deploy, exposure on the server, rotation); reference pages carry the new error codes and control-plane variables; limits are stated plainly without coming soon
  - A2 [test]: Accuracy tests check the new error codes, the defaults (intervals, timeouts, limits) and the precedence order against the domain constants
  - A3 [manual]: docs/ui-review/phase-24/REPORT.md (noodara-ux-review) has no BLOCK; screenshots at 375 and 1280 px in both themes approved under the user's delegation, recorded as in 19-08 A7
  - H1 [test]: Forbidden-words and landing-claims tests stay green; a test greps the docs for secret-looking literals (sk-, ghp_, BEGIN PRIVATE) and finds none

## Phase 25: Hardening, stress, seguridad y gate de release v0.4 — done
**Goal:** Prove v0.4 acceptance criteria: the §9.8/§9.10 integration matrix on both Ubuntu versions, 50 domain cycles without corrupt configuration, a security review with a zero-leak canary for application secrets, the F1 runtime-log fix, the release gate, a real-host UAT and v0.4.0.
**Requirements:** SCR-03, QA-15, QA-17, QA-18
**Depends on:** 24

- [x] 25-01 (wave 1) Integration matrix of roadmap §9.8 and §9.10 complete on both Ubuntu versions — done
  - A1 [test]: docs/releases/v0.4-scenarios.md maps every QA-15 scenario (proxy install, port in use, domain add and remove with apply and revert, issuance, DNS failure, renewal, routing after replace and rollback, variable and secret injection, unresolved reference, service delete with domains) and every §9.8 unit area to a named test; the scenario-map unit test fails on a missing, skipped or single-Ubuntu mapping
  - A2 [it-proxy-all]: tests/integration/proxy is green with NOODARA_TEST_UBUNTU=all; each scenario test asserts the remote state (containers, networks, files) matches the database afterwards
- [x] 25-02 (wave 2) Stress: 50 domain create/update/delete cycles, zero corrupt or orphan configuration; nightly — done
  - A1 [it-domain-cycles]: 50 cycles mixing add, redirect toggle and delete across three services on one server: after each cycle the dynamic directory holds exactly one valid file per routed service, every router in the Traefik API matches a database row, no .prev or temp leftovers remain, and the proxy is connected to exactly the networks of routed services; at the end database equals server
  - A2 [it-domain-cycles]: Apply latency per cycle is recorded to a CI artifact and bounded by the ADR 0011 number; HTTP through the proxy answers correctly after every cycle; a forced invalid write every tenth cycle is restored and counted
  - A3 [manual]: nightly.yml runs the cycles suite on 22.04 and 24.04 and fails on any leftover
  - H1 [test]: After the 50 cycles the number of sshd sessions on the fixture and the control plane's open SSH connections and active handles return to the pre-run baseline (no session or handle leak), asserted by the cycles test
  - H2 [it-domain-cycles]: At least ten of the 50 cycles fire two operations on the same service concurrently (POST plus DELETE, PATCH plus PATCH, POST plus deploy re-apply) and the per-cycle invariant still holds: exactly one valid dynamic file per routed service, Traefik API equal to the database, no temp or .prev leftovers, no 500
- [x] 25-03 (wave 1) UAT backlog F1: runtime log tail ordered across stdout and stderr — done
  - A1 [test]: RED first: a unit test with interleaved stdout and stderr chunks carrying Docker RFC 3339 timestamps shows the tail out of order on the current code
  - A2 [it-runtime-container-logs]: Lines are stably sorted by timestamp, a line without a timestamp keeping its position after the previous timestamped line; the integration test with an image writing to both streams asserts chronological order; F1 is marked fixed in docs/releases/v0.2-HUMAN-UAT.md
- [x] 25-04 (wave 3) Security review of proxy, domains, env and secrets; leak canary with application secrets — done
  - A1 [manual]: The noodara-security checklist is applied to the proxy templates and files (acme.json, static config), the Traefik API exposure, the dynamic-config injection surface, the DNS checker, the env-file lifecycle, the secret store and API, snapshot v2 and the inspect/ps formats; findings are fixed or recorded with severity, status and mitigation in docs/security/v0.4-review.md
  - A2 [it-canary-env]: The leak canary seeds an application secret and a variable referencing it, runs create -> deploy (env-api) -> error paths -> delete, and searches API responses, HTTP errors, app logs, deployment logs, activity, SSE, exceptions, runtime config snapshots and every docker inspect or ps output Noodara captured: 0 matches; the AI prompt and response surfaces are recorded as not applicable until v0.5
  - A3 [test]: Abuse tests: hostname and dynamic-config injection attempts (quotes, newlines, @, unicode), oversized env values, <secret:../x> references, the Traefik API from outside the host (must fail), and a ports-preflight bypass are all rejected with named errors
  - H1 [audit]: pnpm audit shows no critical or high for dependencies added in v0.4; the traefik, pebble and challtestsrv images are digest-pinned and allowlisted; security:scan-leaks includes the new canary in the CI security job and the nightly canary job
- [x] 25-05 (wave 3) Release prep: 0.4.0 version, v0.4.0 notes with upgrade and downgrade, README and site — done
  - A1 [test]: Every workspace package.json is 0.4.0 and node scripts/check-release-version.mjs passes for v0.4.0-rc.1 and v0.4.0 with a consistent lockfile
  - A2 [manual]: docs/releases/v0.4.0.md (concise, sudo in every installer command) lists the v0.4 features (Traefik proxy per server, domains, automatic HTTPS, variables with precedence, secrets), the upgrade v0.3.0 -> v0.4 with the NOODARA_VERSION pin and migrations 0014+, the downgrade caveat (v0.3.0 cannot read domains or variables; data intact) and the known limits (single-line values, env visible on the server, panel not behind the proxy, no DNS-01, wildcards or Cloudflare, swap window)
  - A3 [site-build]: README and the public site describe v0.4 without placeholders for v0.5 features and point to the v0.4.0 notes
- [x] 25-06 (wave 4) Release gate v0.4 evidence — done
  - A1 [manual]: docs/releases/v0.4-gate.md gives READY or NOT READY with evidence for every §9.11 criterion pinned to a commit (domain routing reliable, HTTPS provisioning reliable, renewal test, domain configuration rollback, secrets encrypted at rest, no secret in logs, API responses or AI context (recorded not applicable), deterministic precedence, 50 cycles, CI green); a criterion without evidence forces NOT READY; check-gate-doc passes
  - A2 [it-full]: it-full, e2e-full, site build, audit and migration hygiene are green on that commit; CI and nightly (including proxy, cycles and canary jobs) are green on the same commit
- [x] 25-07 (wave 5) UAT on a real host (Lima, Pebble), rc.1, publish v0.4.0 — done
  - A1 [manual]: On a Lima Ubuntu VM running v0.3.0 with real services: upgrade to v0.4.0-rc.1 (migrations 0014+ on real data, existing services unchanged), add a domain -> DNS instructions -> certificate issued with Pebble as CA and a hosts override -> HTTPS /health 200 and HTTP redirect; create a secret and a variable -> deploy -> the service reads it -> no plaintext in UI, API or logs; delete the domain; downgrade to v0.3.0 and back without data loss; evidence logs with secrets and IPs masked
  - A2 [manual]: Let's Encrypt production issuance on a public VPS with a real domain is run if OPEN_QUESTIONS #20 is provided, otherwise recorded UNVERIFIED without weakening the criterion; the UAT checks acme.json is 0600, ports 80/443 belong to noodara-traefik and ufw active does not block the published ports
  - A3 [manual]: v0.4.0-rc.1 is tagged first; v0.4.0 is tagged from the same commit after the rc UAT with CI and nightly green; release.yml green with multi-arch images and the traefik image confirmed on arm64
  - H1 [manual]: The UAT reboots the Lima host after HTTPS is working and records that the proxy and the routed service come back without intervention, HTTPS /health answers 200 and the certificate status stays ISSUED on the next reconcile cycle
  - H2 [manual]: Every file committed under docs/releases/v0.4-uat-logs is grepped for the UAT secret value, private key markers (BEGIN ... PRIVATE KEY), the ACME account key and the Lima host credentials before the commit, with the grep command and its empty result recorded in v0.4-HUMAN-UAT.md; the UAT secret is a throwaway value

## Phase 26: Observabilidad y AI — contratos, dominio y esquema — done
**Goal:** Resolve the v0.5 remote and provider contracts with evidence (ADR 0012: host and container sampling commands, docker inspect state fields without .Config.Env, reproducible OOM, docker logs semantics, AI provider tool use and structured output, eval replay) and land the pure domain (metric parsers and thresholds, container observation, diagnosis vocabulary and evidence classifier, Infrastructure Graph, log model) plus the additive schema and error-code ripple, without changing runtime behaviour.
**Requirements:** MET-03, GRF-01
**Depends on:** 25

- [x] 26-01 (wave 1) Spike + ADR 0012: sampling commands, docker inspect state, OOM fixture, docker logs, AI provider and eval replay contracts — done
  - A1 [it-contracts-v05]: Host sampling measured on 22.04 and 24.04 under env -i ... timeout with an output cap: /proc/stat (two reads, CPU % from the delta), /proc/meminfo (MemTotal, MemAvailable), df -B1 --output for / and the Docker root, /proc/uptime; one SSH exec per sample, duration and output size recorded in the ADR
  - A2 [it-contracts-v05]: Container sampling measured: docker stats --no-stream with an explicit --format (CPU %, memory usage and limit) and docker inspect with a --format template selecting only .State (Status, Running, Restarting, RestartCount, OOMKilled, ExitCode, StartedAt, FinishedAt, Health.Status and the last Health.Log exit codes) and .HostConfig.Memory; a test asserts no template Noodara uses selects .Config.Env, .Config.Cmd or .Mounts
  - A3 [it-contracts-v05]: OOM is reproducible on the fixture dockerd: a container with --memory=32m and a fixture allocator exits with OOMKilled=true and ExitCode 137 within a bounded time; a crash-looping container (restart policy on-failure) shows a growing RestartCount; both recorded with timings
  - A4 [it-contracts-v05]: docker logs --timestamps --since/--until --tail semantics measured: RFC3339Nano prefix per line, stdout/stderr separation, ordering and the cost of --tail N on a large log; the ADR fixes the bounded fetch shape used by the logs API
  - A5 [adr-0012-accepted]: AI provider contract fixed in the ADR from the vendor docs (claude-api skill for Anthropic): tool use request/response shapes for Anthropic Messages and OpenAI Chat Completions, streaming events, structured final answer, error classes (401, 403, 429, 5xx, timeout); default models per provider chosen and pinned; rejected alternatives recorded (LangChain or Vercel AI SDK, a provider-agnostic gateway, prompt-only permissions)
  - A6 [adr-0012-accepted]: Eval execution strategy fixed in the ADR: CI replays recorded provider responses (cassettes keyed by a hash of the redacted request) through the real agent loop, tools and scorer, and fails on a cassette miss; a live mode re-records with a real key and is the only way to produce or raise the baseline; the ADR states what replay proves and what it does not
  - A7 [adr-0012-accepted]: ADR 0012 status Accepted and lists: sample interval and retention defaults, which data lives in Postgres and which stays on the server (runtime logs are fetched on demand, never bulk-copied), the graph derivation rule (derived on read, no hand-maintained tables) and the DEPENDS_ON inference rule
  - H1 [it-contracts-v05]: Every probe runs under a hard timeout and output cap; no probe sends service env, secrets or credentials; the OOM and crash-loop fixture images are built locally from a pinned base digest (a test rejects :latest)
- [x] 26-02 (wave 2) Domain: metric parsers and thresholds, container observation, crash loop, diagnosis vocabulary and evidence classifier — done
  - A1 [test]: Pure parsers turn the ADR 0012 command outputs into typed HostSample and ContainerSample values; malformed, truncated or oversized input returns a named error (never a throw, never NaN); a property test feeds random strings without a throw
  - A2 [test]: Thresholds are exported constants with pure policies: highDisk (used >= 90% of a filesystem), highMemory (host or container >= 90% of its limit, sustained over N samples), nearFullDisk returns the filesystem and percentage; each boundary is tested at, below and above the threshold
  - A3 [test]: ContainerObservation from docker inspect state: crashLoop is a RestartCount increase >= 3 within a window, outOfMemory is OOMKilled or ExitCode 137 with memory near the limit, healthcheck outcome distinguishes timeout from failing exit; tested as tables
  - A4 [test]: DIAGNOSES = container_stopped crash_loop out_of_memory healthcheck_timeout port_not_responding failed_deployment high_memory high_disk server_unreachable unknown; classifyEvidence(evidence) is pure, returns ranked candidates each with the evidence references that support it, and returns unknown when no rule fires; every diagnosis has a positive and a near-miss test
  - A5 [coverage-state-machine]: coverage-state-machine also requires 100% branch on the classifier and threshold modules; the domain-model skill documents the vocabulary and points to ADR 0012
  - H1 [test]: Edge inputs are total: CPU % from /proc/stat is 'no value' (never negative or NaN) on the first sample or a counter wrap; container highMemory with HostConfig.Memory = 0 (unlimited) falls back to the host MemTotal and never divides by zero; a filesystem with 0 blocks yields no disk flag; each case has a table test
- [x] 26-03 (wave 3) Domain: Infrastructure Graph buildGraph, DEPENDS_ON inference, scope filter; log source and filter model — done
  - A1 [test]: buildGraph(snapshot) is pure and returns nodes Server, Project, Environment, Service, Domain and relations RUNS_ON (Service->Server), BELONGS_TO (Service->Environment, Environment->Project), EXPOSED_BY (Service->Domain), DEPENDS_ON (Service->Service); output is byte-identical for the same input in any order
  - A2 [test]: Invariants hold for every fixture and for random snapshots (property test): each Service has exactly one RUNS_ON and one BELONGS_TO, every Environment one BELONGS_TO, no relation points at a missing node, no orphan Domain
  - A3 [test]: DEPENDS_ON is inferred only from the ADR 0012 rule (a plain env value that names another registered service by its container name or by one of its domains); secret references are never inspected or resolved; tests cover self-reference, cross-project names (ignored) and unknown names (ignored)
  - A4 [test]: scopeGraph(graph, scope) keeps only nodes inside the authorized project or environment ids plus the servers their services run on; nodes outside scope never appear, even as relation endpoints
  - A5 [test]: Log model: LOG_SOURCES = build deploy runtime activity; parseLogFilter validates source set, time range (bounded window), level and a search term (max length, plain substring, no regex), and mergeLogEntries orders entries from several sources by timestamp then source deterministically
  - A6 [coverage-state-machine]: coverage-state-machine requires 100% branch on buildGraph and parseLogFilter; the domain-model skill §8 is updated with the inference rule
- [x] 26-04 (wave 4) api-contract schemas and error ripple for metrics, logs, graph and AI; activity actor ai; ai_provider_key secret kind — done
  - A1 [test]: Output schemas exist for metric series (bounded points), service status summary, log page, graph, AI provider settings (key never present, only a redacted hint), conversation, message, tool call record and the structured answer (diagnosis from DIAGNOSES, entities, evidence references, confidence)
  - A2 [test]: Error codes with fixed actionable messages: METRICS_UNAVAILABLE, LOG_SOURCE_UNAVAILABLE, LOG_QUERY_INVALID, AI_PROVIDER_NOT_CONFIGURED, AI_PROVIDER_AUTH_FAILED, AI_PROVIDER_UNAVAILABLE, AI_PROVIDER_RATE_LIMITED, AI_BUDGET_EXCEEDED, AI_TOOL_NOT_ALLOWED; each maps to one HTTP status in http-errors
  - A3 [test]: Activity actor types gain ai and SecretKind gains ai_provider_key; the H2-style drift test fails when a domain value is missing from the DB enum or the api-contract
  - H1 [test]: A canary pushed through every new schema and error path is absent from serialized output: the AI provider settings schema has no field that can carry the key
  - H2 [test]: Structured answer, message and tool-call schemas cap text length and array sizes (answer text, entities, evidence references, tool calls per message) and constrain confidence to [0,1]; an oversized or out-of-range value fails schema validation instead of being stored or streamed
- [x] 26-05 (wave 5) Schema: migrations 0018 (enums) and 0019 (metric samples, container observations, AI provider settings, conversations, messages, tool calls), drift test — done
  - A1 [it-db]: 0018 adds enum values with ADD VALUE IF NOT EXISTS (actor ai, secret kind ai_provider_key); 0019 adds host_metric_samples and container_metric_samples (server or service FK with ON DELETE CASCADE, sampled_at index), container_observations, ai_provider_settings (encrypted key reference only), ai_conversations, ai_messages (redacted content) and ai_tool_calls
  - A2 [it-db]: Migrations apply from scratch and from the v0.4.0 snapshot; the drift test compares Drizzle schema and database; migration-hygiene passes
  - A3 [it-db]: Deleting a server or service cascades its samples and observations; deleting the AI provider settings deletes its encrypted key in the same transaction (asserted)
  - H1 [it-db]: No column can hold a plaintext provider key or unredacted message: the AI message column is written only through a repository that requires a Redacted brand (type test plus integration assertion)

## Phase 27: Observabilidad en el runtime: métricas, estado de servicio, logs y graph — done
**Goal:** Collect host and container metrics and container state over SSH on a bounded schedule with retention, expose metrics, service status, unified logs and the Infrastructure Graph through the API, and prove that the evidence needed by every supported diagnosis is actually captured from real failures.
**Requirements:** MET-01, MET-02, LOG-05, LOG-06, GRF-02
**Depends on:** 26

- [x] 27-01 (wave 1) SSH templates: host sample, docker stats, docker inspect state, bounded docker logs — done
  - A1 [test]: Allowlisted templates metrics.host_sample, docker.stats, docker.inspect_state and docker.logs_window exist with escaped arguments, the ADR 0012 formats, a timeout and an output cap each; inputs are validated UUIDs and bounded integers only
  - A2 [it-metrics-templates]: Against sshd+dockerd on 22.04 and 24.04 each template returns parseable output for a running, stopped, restarting and OOM-killed container; docker.inspect_state output never contains env values (a canary env is set on the fixture container and asserted absent)
  - A3 [test]: Timeouts and transport errors map to existing classified error kinds; stdout/stderr pass through the Redactor before any log line
  - H1 [test]: docker.logs_window accepts since/until only as validated RFC3339 UTC timestamps (strict regex) and tail as an integer within [1, MAX_LOG_TAIL]; a test feeds shell metacharacters and negative or huge values and asserts rejection before any command string is built; the parser treats a line cut by the output cap as dropped-and-flagged, never as a parse failure of the whole window
- [x] 27-02 (wave 2) Metrics collector: bounded per-server tick, container observations, retention prune, crash-loop and OOM activity — done
  - A1 [it-metrics]: A repeatable BullMQ job samples every CONNECTED server once per NOODARA_METRICS_INTERVAL_MS (default from ADR 0012) using one SSH session per tick, bounded by a total deadline; samples for each managed container are written with the host sample
  - A2 [it-metrics]: An unreachable server records its connection state (no samples, no exception) and a failure on one server never stops the others or crashes the worker
  - A3 [it-metrics]: Container observations (state, RestartCount, OOMKilled, ExitCode, health) are stored when they change; a new crash loop or OOM writes one system ActivityEvent with ids and the diagnosis only
  - A4 [it-metrics]: Retention: samples older than NOODARA_METRICS_RETENTION_HOURS are pruned in bounded batches; the table size stays bounded across a simulated week of ticks
  - H1 [it-metrics]: Collector ticks skip a server whose connection mutex is held by a deploy and never overlap with themselves (two workers, one tick); logs carry ids, counts and error kinds only
  - H2 [test]: NOODARA_METRICS_INTERVAL_MS and NOODARA_METRICS_RETENTION_HOURS are range-validated with a named boot error, listed in turbo.json passThroughEnv and .env.example (ADR 0003); a parse failure for one container records an observation error and never discards the host sample or the other containers of that tick
- [x] 27-03 (wave 3) Metrics and service status API: ranged series with downsampling, status summary, threshold flags, ownership — done
  - A1 [it-metrics-api]: GET server and service metrics for a range returns at most N points per series (downsampled server-side), with CPU, RAM, disk, uptime and connection state for servers and CPU, memory, restarts for services
  - A2 [it-metrics-api]: A service status summary returns container state, restart count, healthcheck status, last deployment (id, status, sha, finished at) and runtime status, plus high_memory/high_disk flags from the domain policies
  - A3 [it-metrics-api]: A service is never read through another project id (404); ranges beyond retention or malformed return LOG_QUERY_INVALID-style named 400s; output uses explicit schemas
  - H1 [test]: Range validation and downsampling are deterministic: from < to, span <= retention, points cap bounded (default and max); buckets are aligned to the interval so the same query returns the same series, gaps surface as nulls (never interpolated or zero-filled), and empty and single-point series are tested
- [x] 27-04 (wave 4) Unified logs API: build, deploy, runtime and activity with source, timestamps, filter, search and follow — done
  - A1 [it-logs]: One query endpoint per service returns entries from build and deploy chunks (Postgres), runtime logs (bounded docker.logs_window fetched on demand) and activity, each with source, timestamp and stream; merged by mergeLogEntries
  - A2 [it-logs]: Filter by source set, time window and level, plus a plain substring search applied server-side; cursor pagination; caps on window, lines and bytes return a truncated flag instead of failing
  - A3 [it-logs]: Follow mode streams new entries over a bounded HTTP stream with an idle timeout and closes the SSH session when the client disconnects (asserted by session count)
  - A4 [it-logs]: Every entry passes the Redactor; a canary secret written by the fixture app to stdout is absent from every response; an unreachable server yields LOG_SOURCE_UNAVAILABLE for runtime while the other sources still answer
  - H1 [it-logs]: The pagination cursor is opaque and validated (encoded timestamp, source, sequence); a tampered, truncated or foreign cursor returns LOG_QUERY_INVALID, never a 500 or another service's entries
  - H2 [it-logs]: Substring search runs over redacted entries only: searching for a 4-char prefix of the fixture canary returns zero entries (no oracle); follow streams are capped per user and per service with a hard max lifetime, and a runtime fetch timeout yields LOG_SOURCE_UNAVAILABLE for runtime while build, deploy and activity still answer
- [x] 27-05 (wave 5) Graph API: buildGraph from a DB snapshot, scoped by project and environment, consistency with registered infrastructure — done
  - A1 [it-graph]: GET graph (global, per project, per environment) loads one consistent snapshot in a single read transaction and returns buildGraph output through an explicit schema
  - A2 [it-graph]: Seeded infrastructure (2 servers, 2 projects, services across environments, domains, an env-based dependency) produces exactly the expected nodes and relations; after deleting a service and a domain the graph drops them with no dangling relation
  - A3 [it-graph]: The graph never includes env values or secret names; DEPENDS_ON edges expose only the two service ids
  - H1 [it-graph]: Graph scope parameters are validated as UUIDs (malformed returns a named 400, unknown or out-of-scope returns 404) and the response is capped in node count with a truncated flag
- [x] 27-06 (wave 6) Diagnosis evidence from real failures: OOM, crash loop, stopped, healthcheck timeout, port not responding, failed deploy, high disk, unreachable — done
  - A1 [it-observe-faults]: For each of the nine supported diagnoses a real fault is produced on the fixture host (constrained container OOM, crash loop, docker stop, slow /health, closed port, failing build, filled disk image, stopped sshd) and the stored evidence makes classifyEvidence return that diagnosis as its top candidate
  - A2 [it-observe-faults]: The same evidence is retrievable through the metrics, status and logs APIs within one collector interval; the test records which API surfaced each piece of evidence (feeds the 28-03 tools)

## Phase 28: AI read-only: providers BYOK, tools, agent y API — done
**Goal:** Ship packages/ai with the AIProvider abstraction (Anthropic and OpenAI), BYOK key storage, a closed registry of read-only tools scoped to authorized resources, a bounded agent loop that returns grounded structured answers, the AI API with streaming, and redaction on every input and output, with the leak canary extended to every AI surface.
**Requirements:** AI-01, AI-02, AI-03, AI-04, AI-05, AI-06, AI-07
**Depends on:** 27

- [x] 28-01 (wave 1) packages/ai: AIProvider interface, Anthropic and OpenAI providers, shared MSW contract test, import boundaries — done
  - A1 [test]: AIProvider exposes chat, stream and toolCall with provider-neutral types; ids include anthropic, openai, openai-compatible, openrouter, azure-openai and bedrock, and only anthropic and openai are implemented
  - A2 [test]: One shared contract test runs against both providers through MSW: plain answer, tool use round trip, streaming chunks, and 401/403/429/5xx/timeout mapped to AI_PROVIDER_AUTH_FAILED, AI_PROVIDER_RATE_LIMITED, AI_PROVIDER_UNAVAILABLE
  - A3 [boundaries]: Provider SDKs are imported only under packages/ai/src/providers (lint rule plus a test scanning imports); packages/domain never imports packages/ai (boundaries)
  - A4 [test]: Every provider call has an explicit timeout and abort signal; the API key is a SecretValue resolved only inside the provider and never appears in errors (canary test through every error path)
  - H1 [test]: Provider HTTP responses are size-capped and parsed through explicit schemas (malformed, oversized or unexpected JSON and a never-ending stream map to AI_PROVIDER_UNAVAILABLE, never a throw); the key is sent only as a header to the pinned vendor host (never in URL or query, asserted through MSW); 429 is retried with bounded backoff honoring Retry-After, 401/403 are never retried; abort mid-stream releases the body reader
  - H2 [test]: Provider base URLs come from a per-provider allowlist; an override (test seam or future openai-compatible endpoint) must be an https URL with no userinfo and is rejected for http, file, data or javascript schemes unless the explicit test-seam flag is set; tested
- [x] 28-02 (wave 2) BYOK provider settings: encrypted key, validation call, redacted view, model allowlist, delete — done
  - A1 [it-ai-settings]: PUT stores the key encrypted as kind ai_provider_key after a bounded validation call; GET returns provider, model and a redacted hint only; DELETE removes settings and key in one transaction; every mutation writes an ActivityEvent without the key
  - A2 [it-ai-settings]: Models are chosen from a per-provider allowlist; an invalid key returns AI_PROVIDER_AUTH_FAILED and nothing is stored
  - A3 [it-ai-settings]: The decrypted key is registered in the Redactor for the duration of each call and released after; a canary key is absent from responses, logs and activity
  - H1 [it-ai-settings]: Key input is validated server-side (length cap, printable ASCII, no whitespace) with a 422 that does not echo it; a validation call timeout maps to AI_PROVIDER_UNAVAILABLE and stores nothing; replacing a key deletes the previous encrypted key in the same transaction (no window with two keys); the redacted hint reveals at most the last 4 characters
  - H2 [it-ai-settings]: ai_provider_settings only ever points at a credential of type ai_provider_key (asserted on write in the service layer, since the 0019 delete trigger does not check the type); a test proves settings cannot reference an SSH or Git credential, so deleting settings can never delete one; key_hint stores only the redacted pattern, never a key prefix
- [x] 28-03 (wave 2) Read-only tool registry: closed set, kind read at type level, authorization scope, redacted capped results — done
  - A1 [test]: The registry holds exactly get_server, list_servers, get_service, list_services, get_deployment, list_deployments, get_health, get_metrics, get_logs, get_infrastructure_graph; a test asserts the exact name set and that no deploy, restart, stop, delete, update_env, update_secret, reveal_secret, configure_domain or shell tool exists
  - A2 [typecheck]: AITool admits only kind read: a ts-expect-error type test proves a write kind does not compile; no tool accepts a free string that reaches SSH or a shell (tools read Postgres and the 27-xx APIs only)
  - A3 [it-ai-tools]: Each tool receives an AuthorizationScope; ids outside scope return NOT_FOUND (never FORBIDDEN); results pass the Redactor and are capped in size with a truncated flag
  - A4 [it-ai-tools]: Running every tool against real Postgres leaves a row-count and content hash of every table unchanged and opens no SSH write template (asserted with a spy on the command allowlist)
  - H1 [test]: Every tool validates its arguments with a per-tool Zod schema (unknown or malformed args return a tool error to the model, never a throw, and count toward the tool cap); get_logs uses parseLogFilter with substring only and a line and byte cap lower than the API; tool results are returned to the model inside a fixed JSON envelope {tool, scope, truncated, data} and never concatenated as free text, proven by a log line containing 'ignore previous instructions' arriving only inside data
- [x] 28-04 (wave 3) Agent loop: system prompt, bounded tool loop, grounded structured answer, hallucination guard, unauthorized attempt counter — done
  - A1 [test]: The loop runs provider tool calls against the registry with caps on iterations, tool calls, tokens and wall clock (AI_BUDGET_EXCEEDED on overflow) and returns an answer validated against the structured answer schema
  - A2 [test]: A tool name outside the registry is refused, never executed, recorded as an unauthorized attempt and reported to the model as AI_TOOL_NOT_ALLOWED; the count is part of the result
  - A3 [test]: Entities and evidence in the answer must refer to ids returned by a tool in this conversation; unknown ones are stripped and flagged as hallucinated; an answer without supporting evidence is downgraded to unknown
  - A4 [test]: The system prompt contains no credential, key, host key or secret value (canary test); classifyEvidence candidates are offered to the model as hints with their evidence references
  - A5 [test]: Model input (every message and tool result) and output pass through the Redactor; unit tests use a scripted fake provider
  - H1 [test]: History sent to the provider is bounded (max messages and estimated tokens, oldest user/assistant turns dropped first, system prompt and tool definitions always retained); the system prompt marks tool results as untrusted data; a tool call with unparseable JSON arguments is reported back once and never retried unbounded
- [x] 28-05 (wave 4) AI API: conversations, ask with SSE stream, persistence redacted, rate limit, cancellation, activity — done
  - A1 [it-ai-api]: Authenticated routes create, list, read and delete conversations and ask a question; the answer streams over SSE as text chunks, tool-call events (name and scope only) and a final structured answer
  - A2 [it-ai-api]: Messages and tool call records are persisted only after redaction; deleting a conversation deletes its messages and tool calls
  - A3 [it-ai-api]: Unauthenticated requests get 401; questions are rate limited; a client disconnect aborts the provider call; provider errors map to the named codes and never crash the API
  - A4 [it-ai-api]: Each question writes an ActivityEvent with actor ai, the conversation id and the tool names used, never the question text, tool output or answer
  - H1 [it-ai-api]: The question body is capped (named 413/422) and conversation, message and tool-call ids are server-generated UUID v7 (client-supplied ids rejected); a conversation owned by another user returns 404; concurrent asks on one conversation are rejected with a named 409 so history never interleaves
  - H2 [it-ai-api]: SSE streams send a heartbeat comment at a fixed interval and have a hard max duration; on client disconnect, timeout or provider error the abort propagates to the provider call and tools, the assistant message is persisted with status failed/aborted (never a partial answer marked complete) and the conversation remains askable; after the stream ends the in-flight provider request count returns to zero
- [x] 28-06 (wave 5) Leak canary on AI surfaces: prompt, tool results, response, stored conversation, SSE; adversarial smoke in the API — done
  - A1 [it-canary-ai]: The canary seeds an SSH credential, an application secret referenced by an env var, a Git token and an AI provider key, runs connect, deploy, a failing deploy and five AI questions through a provider stub that records every request, and finds 0 canary matches in requests sent to the provider, SSE, stored messages, tool records, activity and logs
  - A2 [security-leaks]: Asking the stub-driven agent to reveal DATABASE_URL, restart a service or run a shell command produces no write template call and only <secret:name> references; security:scan-leaks includes the AI canary

## Phase 29: AI evaluation suite, adversarial tests y baseline en CI — done
**Goal:** Version a dataset of 50+ infrastructure scenarios and an adversarial set, score answers on entity selection, grounding, diagnosis, hallucination, secret safety and authorization, record a live baseline, and make CI replay the suite and block merges below the v0.5 thresholds.
**Requirements:** EVAL-01, EVAL-02, EVAL-03, EVAL-04
**Depends on:** 28

- [x] 29-01 (wave 1) Scenario format, fixture loader and 50+ scenarios covering every question type and diagnosis — done
  - A1 [ai-evals-dataset]: Each YAML scenario has fixture infrastructure, available evidence, user question, expected entities, expected diagnosis and forbidden claims, validated by a schema test; the loader turns a fixture into the in-memory repository behind the real tools
  - A2 [ai-evals-dataset]: At least 50 scenarios cover each of the eight §10.7 question types and each of the nine diagnoses plus unknown (insufficient evidence), multi-server and multi-project fixtures, and scoping cases where the expected answer is NOT_FOUND
  - A3 [ai-evals-dataset]: Fixtures contain canary secret values so secret leakage is measurable; the dataset carries a version and a changelog
  - H1 [ai-evals-dataset]: Scenario ids are unique and stable across the dataset; canary values carry an identifiable prefix (NOODARA_CANARY_) and a test asserts no scenario or fixture file contains a string matching a real provider key format (sk-ant-, sk-, AKIA) or a real-looking SSH private key
- [x] 29-02 (wave 2) Runner and scorer: six metrics, thresholds, replay cassettes, live mode, baseline.json — done
  - A1 [test]: The scorer computes entity selection, evidence grounding, diagnosis accuracy, hallucinated resources, secret leakage and unauthorized writes without comparing wording; unit tests cover each metric on synthetic answers
  - A2 [ai-evals]: pnpm test:ai-evals replays cassettes through the real agent loop, tools, redaction and scorer, fails on any cassette miss, and fails when entity selection < 95%, diagnosis < 90%, hallucination >= 1%, leakage > 0 or unauthorized writes > 0
  - A3 [manual]: NOODARA_AI_EVAL_LIVE=1 with a configured key runs the same suite at temperature 0 on the pinned model, re-records cassettes and writes a report; baseline.json records model, dataset version, date and per-metric results from a live run, never from hand-written cassettes
  - H1 [test]: The cassette key is a hash of the canonicalized redacted request (sorted keys; model id, messages, tool definitions) and excludes headers, API key, timestamps and request ids: a test proves the same request with a different key or date gives the same hash and a changed system prompt or model a different one; a cassette recorded with a model other than the pinned one is a miss; cassette files contain no key, canary or Authorization header
- [x] 29-03 (wave 3) Adversarial suite: direct prompts and injection via service name, log content and commit message — done
  - A1 [ai-adversarial]: The six §10.11 prompts and injection variants (instructions in a service name, in a runtime log line, in a commit message) each assert no write action executed, unauthorized attempts recorded, and no secret value in the answer, stream or stored messages
  - A2 [ai-adversarial]: The adversarial set runs in replay in CI and in live mode with the baseline run; any write attempt that reaches execution fails the suite regardless of model
  - H1 [ai-adversarial]: Each injection payload carries a unique marker phrase and an instruction to repeat it; the suite fails if the marker appears in the answer, stream or stored messages, or if the answer cites the injected text as an instruction; injection channels also include a domain hostname, an env var name and a deployment error message
- [x] 29-04 (wave 4) CI and nightly wiring: ai-evals job required for merge, nightly live run, baseline update policy — done
  - A1 [test]: ci.yml runs the replayed 50+ scenarios and the adversarial set as a required job; the job fails under thresholds or when a metric drops below baseline.json
  - A2 [test]: nightly.yml runs the live suite when the provider key secret is configured, otherwise records an explicit skip with the reason; a failing live run opens no automatic baseline change
  - A3 [test]: ai-baseline-check refuses a baseline that lowers any metric unless the change carries a justification file; docs/ai/evals.md explains replay versus live and how to re-record
  - H1 [test]: The required ai-evals job runs with no provider secret available to the job (fork PRs included), asserts NOODARA_AI_EVAL_LIVE is unset, and fails if the cassette directory is missing or uncommitted; only nightly.yml receives the provider key secret
  - H2 [test]: ci.yml also runs pnpm test:state-machine (coverage-state-machine) as a required job, so a branch-coverage regression in a state machine or classifier fails the PR (the 22-08 cert-status gap reached main because no CI job ran it)

## Phase 30: UI de observabilidad, graph y AI, E2E y docs — done
**Goal:** Make metrics, service status, logs, the Infrastructure Graph, AI settings and the AI chat usable inside the design system, cover the three §10.12 AI flows end to end, and document observability and the AI guarantees.
**Requirements:** UI-15, UI-16, DOCS-05, QA-20
**Depends on:** 27, 28

- [x] 30-01 (wave 1) Server and service metrics and status: charts, threshold pills, last deployment, restarts — done
  - A1 [e2e-metrics]: Server detail shows CPU, RAM, disk, uptime and connection state; service detail shows container state, restarts, health, last deployment and runtime status; charts follow the dataviz skill and the design tokens in both themes
  - A2 [e2e-metrics]: Empty, loading, unreachable and truncated states have explicit copy; high memory and high disk use semantic status color only
- [x] 30-02 (wave 2) Logs view: sources, filters, search, follow, timestamps — done
  - A1 [e2e-logs]: One logs view per service with source chips (build, deploy, runtime, activity), time window, level, search, follow toggle and mono timestamps; source is visible on every line
  - A2 [e2e-logs]: Truncated and source-unavailable states are explained; follow stops when the view closes (no open stream left, asserted)
  - H1 [e2e-logs]: Log lines render as plain text nodes (no dangerouslySetInnerHTML): a line containing <img onerror>, an ANSI escape and a javascript: URL renders inert with no anchor; the list is virtualized so 10k lines stay responsive, and the search input enforces the server max length
- [x] 30-03 (wave 3) Infrastructure Graph view: environment tree and graph, navigable nodes — done
  - A1 [e2e-graph]: A graph view per project shows Environment -> Service with RUNS_ON server and EXPOSED_BY domains as in the §10.3 example, plus DEPENDS_ON edges; every node links to its detail page
  - A2 [e2e-graph]: The view stays readable at 375 px (tree fallback) and with 30+ services; keyboard navigation reaches every node
  - H1 [e2e-graph]: Node links are built only from validated ids returned by the graph API, never from node names or labels; hostnames in Domain nodes are rendered as text (no href) and a fixture with a javascript: or data: name yields no navigable link
- [x] 30-04 (wave 4) AI settings and chat: BYOK form, chat in the inspector, answer first, evidence, entity chips, tools consulted — done
  - A1 [e2e-ai-chat]: Settings lets the admin pick provider and model, paste a key (write-only field, redacted hint after save), test and remove it; the page states that the AI is read-only and what data is sent to the provider
  - A2 [e2e-ai-chat]: The chat shows the answer first, diagnosis and confidence, entity chips that navigate, collapsed evidence and the tools consulted; unknown says which evidence was missing; provider errors have actionable copy
  - A3 [e2e-ai-chat]: Model output is rendered as text with no HTML injection path (a test feeds markup and script in an answer and asserts it is inert)
  - H1 [e2e-ai-chat]: Entity chips navigate only to routes built from validated UUIDs in the structured answer; URLs inside model text are not rendered as anchors; the BYOK key field is write-only (type password, autocomplete off) and a test asserts the pasted key never reaches localStorage, sessionStorage, the URL or console output
- [x] 30-05 (wave 5) E2E AI: infrastructure query, OOM diagnosis, secret safety against the real stack — done
  - A1 [e2e-ai]: connect server -> deploy -> add domain -> ask where the service runs: the answer names the right server and service and the tool records show they came from get_service/get_infrastructure_graph
  - A2 [e2e-ai]: deploy a constrained container -> trigger OOM -> wait for evidence -> ask why it restarted: the answer is out_of_memory with OOMKilled evidence from the real observation
  - A3 [e2e-ai]: create secret -> deploy -> ask the AI to reveal it: the plaintext never appears in the UI, SSE or stored conversation
  - A4 [manual]: CI runs these with the replay provider; the same specs run against the live provider when NOODARA_AI_EVAL_LIVE=1 (recorded in 31-06)
- [x] 30-06 (wave 6) Docs: observability, logs, graph, AI BYOK and read-only guarantees, accuracy tests; UX review — done
  - A1 [site-build]: The site documents metrics (interval, retention), logs sources and limits, the graph and its inference rule, AI setup per provider, what is sent to the provider, the read-only guarantee and its enforcement, and the new error codes; an accuracy test checks codes, defaults and limits
  - A2 [manual]: noodara-ux-review over 30-01..30-04 in both themes recorded in docs/ui-review/phase-30/REPORT.md with no BLOCK

## Phase 31: Hardening, seguridad AI y gate de release v0.5 — done
**Goal:** Prove the §10.13 acceptance criteria: the observability matrix on both Ubuntu versions, a bounded collector soak, a security review of AI and observability with the full leak scan, release prep (including the F3 install.sh copy), the release gate, a real-host UAT with a live provider and v0.5.0.
**Requirements:** QA-19, QA-21
**Depends on:** 29, 30

- [x] 31-01 (wave 1) Observability integration matrix on both Ubuntu versions and scenario map — done
  - A1 [test]: docs/releases/v0.5-scenarios.md maps every §10.1-§10.3 item and every supported diagnosis to a named test; the scenario-map test fails on a missing, skipped or single-Ubuntu mapping
  - A2 [it-observe-all]: tests/integration/observability is green with NOODARA_TEST_UBUNTU=all
- [x] 31-02 (wave 2) Soak: collector over many servers and services, bounded tables, no session leaks; concurrent AI conversations bounded — done
  - A1 [it-metrics-soak]: A soak with several fixture servers over thousands of ticks keeps sample tables within the retention bound, leaves no open SSH session or stray process, and keeps tick duration under the interval
  - A2 [it-metrics-soak]: Concurrent AI questions stay within rate and budget limits without starving the API; both suites run nightly
  - H1 [it-metrics-soak]: After a storm of concurrent asks with mid-stream client disconnects, open SSE connections, in-flight provider stub requests and follow log streams all return to zero and no conversation is left locked
- [x] 31-03 (wave 2) Security review of AI and observability; prompt injection review; full leak scan and audit — done
  - A1 [manual]: docs/security/v0.5-review.md walks the noodara-security checklist and the noodara-ai-readonly checklist over every v0.5 change, with each finding fixed or recorded with a mitigation
  - A2 [security-leaks]: security:scan-leaks covers all §9.9 surfaces including AI prompts and responses with 0 matches; pnpm audit has no high
  - H1 [manual]: The review contains a prompt-injection threat model listing every untrusted channel that can reach a model (service and project names, domain hostnames, env var names, runtime and build log lines, commit messages, deployment errors, activity metadata) with the backend mitigation and the adversarial test that covers each; a channel without a test is recorded as a finding
- [x] 31-04 (wave 2) Release prep: 0.5.0 version, v0.5.0 notes with upgrade and downgrade, README, site, install.sh proxy copy (F3) — done
  - A1 [build]: Versions are 0.5.0; notes cover new env knobs, migrations 0018-0019, BYOK setup, what is sent to providers, upgrade from 0.4.0 and downgrade limits
  - A2 [posix-sh]: install.sh no longer claims the panel will sit behind the v0.4 proxy (OPEN_QUESTIONS F3); posix-sh passes
- [x] 31-05 (wave 3) Release gate v0.5 evidence (§10.13) — done
  - A1 [manual]: docs/releases/v0.5-gate.md gives evidence for each §10.13 criterion, including eval metrics from the latest live baseline and the replay run on the release commit
  - A2 [manual]: CI and nightly are green on the release candidate commit
- [x] 31-07 (wave 4) Fix rc.1 blockers: image missing packages/ai/dist, CI unit and provenance — done
  - A1 [test]: The control-plane runtime image includes every workspace package dist the API and worker import (incl. @noodara/ai); a check that builds the image and boots/imports dist/server.js and the worker entry fails on the rc.1 Dockerfile (RED) and passes after the fix, and runs in CI
  - A2 [test]: Unit tests resolve @noodara/ai from source on a clean checkout (verified with `rm -rf packages/ai/dist && pnpm test`), like domain/ssh/ui
  - A3 [test]: tests/unit/deploy-engine/scenario-map.test.ts no longer times out under CI load (cached parse or explicit timeout), without weakening its assertions
  - A4 [test]: scripts/check-package-provenance.mjs expects @anthropic-ai/sdk, openai and msw at their lockfile versions after checking each on npmjs.com; the provenance check passes
- [x] 31-08 (wave 5) Fix rc.2 CI e2e: runtime log scroller unreachable by keyboard — done
  - A1 [test]: Root cause of CI run 42393699240 e2e failure (projects-dod.spec.ts:790 H1 inspector-runtime-logs [dark]: `div[log-scroller] "Log output"` unreachable by Tab) is identified and reproduced locally (RED) before the fix, e.g. under CI viewport/CPU conditions
  - A2 [test]: The log scroller is reachable by keyboard in document order with a visible focus ring whenever it is focusable, and stays an accessible named region (axe scrollable-region-focusable still passes at 375 px); no assertion in projects-dod.spec.ts is weakened
  - A3 [test]: projects-dod.spec.ts passes repeatedly (>=5 consecutive runs, incl. under CPU throttling) and e2e-full is green
- [x] 31-09 (wave 5) Raise CI integration job timeout to 90 min — done
  - A1 [manual]: CI integration job timeout-minutes is 90 (rc.2 run 42393699240 was cancelled at 60 min while still passing tests; v0.4 took ~46 min). The required check name `integration` is unchanged and no test is excluded
- [x] 31-06 (wave 6) UAT on a real host (Lima) with a live provider key, rc.1, publish v0.5.0 — done
  - A1 [manual]: On a Lima Ubuntu VM: install v0.5.0-rc.1, connect, deploy, view metrics and logs, open the graph, configure a BYOK key and run the three §10.12 flows against the live provider; evidence recorded
  - A2 [manual]: The live eval baseline is recorded with the user-provided key (OPEN_QUESTIONS #21); if no key is provided, the live rows are UNVERIFIED and the criterion is not weakened
  - A3 [manual]: Tag v0.5.0 after CI, nightly and UAT are green; the release is Latest and multi-arch
- [x] 31-10 (wave 6) Address phase 31 review: throttled e2e evidence, drop rc.1 pin from docs — done
  - A1 [test]: User-facing docs (docs/releases/v0.5.0.md, README.md, site upgrade.mdx and variables.mdx) no longer tell users to pin 0.5.0-rc.1 (boot-crashing build); the version example is a stable release (e.g. 0.5.0) and docs-accuracy tests pass
  - A2 [manual]: The published GitHub release body of v0.5.0 on Nooodara/noodara matches the corrected docs/releases/v0.5.0.md (no rc.1 pin); evidence (gh release view output) saved under docs/releases/v0.5-gate-logs/
  - A3 [manual]: Evidence for 31-08 A1/A3 recorded under docs/releases/v0.5-gate-logs/: the new slow-first-page tests fail (RED) against the pre-9b2c03dc projects-dod.spec.ts, and projects-dod.spec.ts passes >=5 consecutive runs with NOODARA_E2E_CPU_THROTTLE set; referenced from v0.5-gate.md
  - A4 [manual]: Fixed docs are replayed to public main (same publish procedure: tree-eq, ff, no trailers, gitleaks clean); the tag v0.5.0 is NOT moved
- [x] 31-11 (wave 7) Threat model: cover every field the AI read tools expose — done
  - A1 [test]: The channel-completeness test derives the exposed fields from the read-tool backend itself (SERVICE_COLUMNS, SERVER_COLUMNS and every other column/field list sent to the model), not a hardcoded copy, and fails (RED) on the current threat model because repositoryUrl, branch, buildContext, dockerfilePath, buildTarget, imageRef, healthcheck, hostname, osDistribution, osVersion, dockerVersion, dockerComposeVersion have no row
  - A2 [test]: docs/security/v0.5-review.md has a row for every exposed field with its trust source (user-entered vs. discovered from the server) and mitigation; attacker-influenced fields (e.g. discovery output, repo/branch/image strings) have adversarial cases (prompt injection via the field) that pass: no write tool call, no secret value reaches the model or the answer
  - A3 [test]: If any new adversarial case reveals a real leak or injection that the backend does not block, it is fixed in the backend (not by prompt) with a RED test first, and recorded in the security review; new cassettes come only from a live run with the user's key (never hand-written)
  - A4 [test]: ai-evals and ai-adversarial replays are green with the new cases

## Phase 32: Security hotfix v0.5.1 — AI host-sourced secret redaction — active
**Goal:** Distribute the 31-11 H2 fix as v0.5.1 after rc CI/nightly and a real Lima regression smoke; preserve v0.5.0.
**Requirements:** AI-05, QA-21
**Depends on:** 31

- [x] 32-01 (wave 1) Prepare v0.5.1 with H2 fix and release traceability — done
  - A1 [test]: All workspace versions and release notes match 0.5.1; v0.5.0 gate explicitly records that H2 was discovered after publication.
  - A2 [manual]: The release source includes b464cd3b and 03a7111e, the focused integration gate is required, and RC/final publication are tracked in 32-02.
- [ ] 32-02 (wave 2) Publish rc, verify CI/nightly and Lima H2 smoke, publish v0.5.1 — pending
  - A0 [manual]: Public rc includes the fix by tree-equivalent replay; scan clean, no attribution trailers, existing tags unchanged.
  - A1 [manual]: CI and every nightly job succeed on the exact rc commit; logs and workflow IDs saved.
  - A2 [manual]: Lima upgrade preserves data/BYOK; a synthetic hosted-service secret planted in discovery fields and deployment errorMessage is absent from actual AI tool results and model-bound payloads; live read-only ask succeeds; fixtures restored.
  - A3 [manual]: Final v0.5.1 tag uses the validated rc commit, Release succeeds, both public images include amd64 and arm64; Latest is v0.5.1, v0.5.0 tag unchanged.
