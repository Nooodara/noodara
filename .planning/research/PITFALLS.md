# Pitfalls Research — v0.2 Projects & Services

**Domain:** Self-hostable PaaS control plane adding remote Docker builds/deploys over SSH, Git
integration, streamed logs, container-state reconciliation, and a UI redesign + public
docs/landing site, on top of Noodara's existing v0.1 SSH/discovery/security foundation.
**Researched:** 2026-09-22
**Confidence:** HIGH for anything grounded in this repository's existing mechanisms (cited by file
path); MEDIUM for generic Docker/Git ecosystem pitfalls verified against current external sources;
LOW is flagged inline where noted.

Every pitfall below is written against a **specific mechanism this system already has**, because
v0.2 is not greenfield: it extends `packages/ssh`'s allowlist/timeout/redaction machinery, the
`discovery_snapshots`/SSE reconciliation pattern, the BullMQ job-dedupe pattern, and the design
system frozen in `docs/ui-build-prompt.md`. The single most load-bearing piece of prior art for
this whole milestone is a comment already sitting in the codebase:

> `packages/ssh/src/commands/allowlist.ts`: *"No v0.1 template takes an argument yet — this is
> forward-looking infrastructure for the day one does."* … citing 02-RESEARCH.md's Pitfall 5:
> *"a blocklist / 'clean the input' approach is exactly what produced Dokploy's CVSS 9.9
> command-injection CVE."*

v0.2 is that day: `git clone <url> <branch>`, `docker build --build-arg`, image tags, and
container names all become the first real user-controlled arguments ever passed to a remote
shell in this codebase. Every pitfall below assumes that boundary is the one most likely to be
gotten wrong under time pressure.

---

## Critical Pitfalls

### Pitfall 1: Orphaned containers, images, networks and build cache after a failed or cancelled deploy

**What goes wrong:**
A build fails mid-`docker build`, or the user cancels while a container is mid-`docker run`, and
the intermediate layers, the half-created container, an attached network, or the build-cache
mount are never removed. On a small VPS (the human-UAT prerequisite 8 in `06-HUMAN-UAT.md`,
"memory on a 1–2 GB VPS", is still open at v0.1 close) this accumulates until `df` reports 100%
and every subsequent deploy fails with a cryptic Docker error instead of an actionable one. This is
not hypothetical for this product category: Coolify's own issue tracker has "box1 is out of disk:
every deploy now fails with 'no space left on device' and rolls back" (lekky/landit#452) and "Orphan
error when recreate and opening publicly containers" (coollabsio/coolify#2547) as exactly this
failure mode in production.

**Why it happens:**
Docker's build/run/network primitives are not transactional. A developer writes the happy path
(`build → tag → stop old → run new → remove old`) and tests it against success; the failure and
cancellation paths — the ones that actually leave garbage — get exercised far less during
development because they require deliberately breaking things.

**How to avoid:**
Model every deploy attempt as a **resource ledger**, the same shape as `discovery_snapshots`
(append-only, one row per attempt, never mutated after the fact): every container, image tag,
network and build-cache reference created during an attempt is recorded *before* the next Docker
command that could fail runs, not after success. Cleanup on any exit path (success, failure,
cancel, process crash) walks that ledger and removes everything it names via `docker rm -f` /
`docker network rm` — never relies on `docker ps -a --filter` heuristics that assume a naming
convention held. Roadmap §7.8's own acceptance criteria ("No orphan containers after failed
deployment", "No temporary resources after cancel", "20 create/delete cycles leave nothing behind")
are exactly the test that proves this; write it as an integration test against a real remote
Docker host *before* writing the deploy service, not after.

**Warning signs:** `docker system df` growing between test runs without a corresponding
`docker system prune` in the harness; the 20-consecutive-deploy test (roadmap §7.8) needs a
manual `docker system prune -af` between local runs to pass a second time; disk usage warnings
appearing only after ~15 of the 20 cycles.

**Phase to address:** Projects → Environments → Services (deploy engine) phase, as the core design
of the deploy service, not as follow-up hardening. Verification: the roadmap §7.8 20-cycle test
must run against a real remote Docker host (not DinD, see Pitfall 12) with `docker system df`
measured before and after.

---

### Pitfall 2: Zombie SSH exec channels and orphaned remote processes when a build is cancelled

**What goes wrong:**
`packages/ssh/src/exec-with-timeout.ts`'s `execWithTimeout` already proves the discipline this
system uses for a *timeout*: on timeout it calls `channel.destroy()` and explicitly never touches
`client.end()`/`client.destroy()`, so the SSH connection itself survives (see the "CR-01" late
-channel-arrival test and the "rejects with CommandTimeoutError and destroys only the channel,
never the client" test). That discipline is correct for discovery commands, which finish in
seconds and have no remote side effect worth stopping. A `docker build` invoked the same way is
different: destroying the *local* channel does **not** send a signal to the remote shell. The
remote `docker build` process (and the dockerd build job it started) keeps running to completion,
consuming CPU/disk on the VPS, and the image/cache it produces becomes exactly the orphaned
resource in Pitfall 1 — except now untracked by anything, because the client-side code already
gave up and moved on.

**Why it happens:**
`channel.destroy()` closes the local Duplex stream; it does not propagate SIGTERM/SIGINT to the
remote process group the way a locally-spawned `child_process.kill()` would. Developers who
reason from "I called destroy on cancellation" conclude the operation stopped, because that is
true for every other command in this codebase.

**How to avoid:**
Cancellation of a long-running remote command (build, docker run for healthcheck-wait, git clone)
must be a **two-step protocol**, not `channel.destroy()` alone: (1) send an explicit remote kill —
either wrap the command so the PID is captured and killed via a follow-up allowlisted command
(`docker build` supports being interrupted by `docker buildx prune`/removing the build container;
plain `docker build` can be killed by PID or by cancelling via `docker ps` + `docker kill` on the
transient builder container), then (2) only after the remote side is confirmed stopped, destroy
the local channel and release the mutex. Extend `execWithTimeout`'s own `settle()`/`destroy()`
pattern with a `cancel()` path that is distinct from `timeout()`, and add an integration test
(mirroring `exec-with-timeout.test.ts`'s fake-channel style for the unit layer, plus a real-sshd
test for the remote-process-actually-died assertion) that proves the remote build process is gone,
not just that the local promise rejected.

**Warning signs:** `ps aux` on the target VPS still showing a `docker build`/`buildkit` process
after the UI reports "cancelled"; CPU usage on the VPS staying elevated after cancellation; the
same orphaned-image symptom as Pitfall 1 specifically correlated with cancel, not failure.

**Phase to address:** Deploy engine phase, as part of the same design pass as Pitfall 1 — cancel
and failure share the same cleanup ledger, but cancel additionally needs the remote-kill step.

---

### Pitfall 3: Secrets leaking through build args, `docker inspect`, git clone URLs, or log lines

**What goes wrong:**
This is four related leak vectors that all reach the same place — a plaintext secret visible to
anyone with shell/API access to the deployed container or the Noodara host:
1. **`--build-arg SECRET=value`** bakes the value into `docker history` for every layer built
   after it, even if a later stage never references it.
2. **`docker inspect`** on a running container returns the full `Config.Env` and (for anything
   started the way Redis already is in this repo) the full launch command including any
   `--env`/password flags — `docker-compose.yml`'s own known-debt note ("Redis password visible in
   argv of `redis-server --requirepass …`, and therefore in `docker inspect`") is this exact
   failure mode, already accepted as debt for Noodara's *own* infra. v0.2 must not repeat it for
   **user** secrets/env vars passed into a deployed service's container.
3. **Git clone URLs with embedded tokens** (`https://<token>@github.com/...`) land in
   `.git/config` on the remote host and in `ps aux` output for the duration of the clone if the
   token is passed as part of the URL argument rather than via a credential helper or header.
4. **Log lines**: build output that echoes an env var (`echo $SECRET` in a Dockerfile `RUN`, or an
   npm install printing an auth token from `.npmrc`) reaches the build-log stream this milestone
   introduces, which is a brand-new unredacted surface that v0.1 never had.

**Why it happens:**
`packages/domain/src/security/redactor.ts`'s structural patterns already cover `ghp_` tokens and
`postgres://user:pass@` (per the `noodara-security` skill's §3), but those patterns only protect
output the Redactor actually sees. Build args, `docker inspect` responses, and git URLs are new
code paths this milestone adds; if the deploy service builds a `docker build` or `git clone`
command string without routing the secret through the *same* redaction/registration discipline
`execWithTimeout` already applies to stdout/stderr, the new paths bypass the Redactor entirely —
not because the Redactor is wrong, but because nobody called it.

**How to avoid:**
- Never accept a plaintext env var value or credential as a `--build-arg`. Use BuildKit's
  `RUN --mount=type=secret` (available by default since Docker 23.0+, verified current as of this
  research) so the secret is mounted only for the `RUN` that needs it and never written to any
  layer. This requires Docker's default builder to be BuildKit — confirm this explicitly for
  Ubuntu 22.04/24.04's apt-repo Docker install (the same repo `install.sh` already provisions per
  D-14) rather than assuming it.
- Never construct `docker run`/`docker create` commands with secret values as literal CLI
  arguments. Pass application secrets the same way v0.1's SSH credential is already handled: as a
  reference resolved server-side into an env-file mounted with restrictive permissions, or
  injected via `docker run --env-file` from a file written just-in-time and removed after the
  container starts — never via `--env KEY=value` on the command line, which is exactly the
  `docker-compose.yml` Redis precedent already flagged as unacceptable for anything beyond
  internal infra.
- Never embed a token in the git remote URL string that reaches an allowlisted SSH command
  template. Use a short-lived credential helper script or an `Authorization` header injected via
  git's `-c http.extraHeader` (still an argument, so it must go through `escapeShellArg`, per the
  allowlist module's own forward-looking design — see the file header quoted above) rather than
  `https://<token>@host/...`.
- Route every line of build/runtime log output through the Redactor before it is persisted or
  streamed, exactly as `execWithTimeout` already does for stdout/stderr — but do it per-chunk in
  the new streaming path (Pitfall 4), not only in the old accumulate-then-return path.
- Extend `pnpm security:scan-leaks` (already the enforcement mechanism per the `noodara-security`
  skill's §9) to register a canary secret as a build-arg value, a git-URL token, and a container
  env var, then assert it does not appear in build logs, `docker inspect` output, activity log
  metadata, or the deploy API response — the same shape as the existing full-flow canary test in
  Phase 3's `createServerServices` suite, applied to the new deploy surface.

**Warning signs:** `docker history <image>` on a locally built test image showing a secret value
in a layer's command string; `docker inspect` on a deploy fixture container showing plaintext env;
`git config --get remote.origin.url` on the cloned repo directory containing a token substring;
any build log line containing a canary value that the scan-leaks suite does not yet check.

**Phase to address:** Deploy engine phase, as a security-review gate (per `noodara-security`
skill's checklist item "¿Input de usuario llega a un shell... sin escapar?") before the phase can
be marked complete — not a follow-up hardening item, because the leak is structural to how the
feature is built, not a bug introduced later.

---

### Pitfall 4: Log streaming blowing memory or Redis (backpressure, line limits, ANSI escapes, binary output)

**What goes wrong:**
Build logs from `docker build` and runtime logs from `docker logs -f` are unbounded, high-volume,
and can contain raw ANSI escape codes (progress bars, colored npm/yarn output), extremely long
single lines (minified JS build output, base64 blobs accidentally logged), or occasional binary
noise. Naively piping this into the same Redis pub/sub + SSE mechanism v0.1 built for
`server.discovery_progress` (11 small, bounded, structured events per run) will either grow an
unbounded in-memory buffer on the API process, flood Redis pub/sub with more traffic than a small
VPS's Redis instance can sustain, or render a corrupted/frozen terminal-like view in the UI.

**Why it happens:**
v0.1's one precedent for streaming under load — the SSE route's connection cap and its "bounded
per-connection backpressure eviction (1 MiB, real-socket-proven)" — was sized for discrete,
infrequent server-state events, not for a continuous high-throughput log firehose. A developer
reusing that same SSE route/event-type allowlist for build logs without re-deriving the bound will
inherit a limit that is either far too small (truncating real build output mid-stream) or, if
naively raised, far too large (defeating the purpose of a bound).

**How to avoid:**
- Design log streaming as its own bounded pipeline from day one, reusing the *pattern* proven at
  `apps/control-plane`'s SSE route (per-connection bound, eviction rather than unbounded queueing)
  but sizing and testing it independently against a fixture that produces sustained high-volume
  output (a `fixtures/failing-build`-adjacent fixture that logs continuously for minutes, not
  the 11-check discovery fixture).
- Strip or neutralize ANSI escape sequences before persisting/broadcasting a log line — either
  strip entirely for the persisted record (searchable, diffable) or preserve them only for the
  live view and strip for anything written to Postgres/Activity.
- Cap line length independently of total payload size (a single 10 MB line with no newline is a
  different failure than 10,000 small lines) — reuse `exec-with-timeout.ts`'s own precedent of a
  hard per-stream byte cap (`MAX_OUTPUT_BYTES = 65_536`) and its multi-byte-UTF-8-safe truncation
  helper (`trimIncompleteUtf8Tail`) as the starting point for a per-line analog, since it already
  solves the "don't split a multi-byte character mid-cut" problem this new code will hit again.
- Treat non-UTF-8/binary chunks defensively: `Buffer.toString('utf8')` silently produces U+FFFD
  replacement characters for invalid sequences rather than throwing, which is fine for display but
  must not be assumed lossless if logs are later used for anything exact-match (e.g., grep-based
  docs-accuracy-style tests).
- Persist logs to Postgres/object storage for later retrieval separately from the live broadcast
  path, so a client that misses a stream reconnects to a `GET` resync (mirroring the "no replay of
  SSE events, reconnect triggers a fresh GET" contract `docs/ui-build-prompt.md` §2.4 already
  documents as load-bearing for this codebase) rather than requiring Redis to buffer history.

**Warning signs:** Redis memory usage climbing during a single build's log stream; the API
process's RSS growing linearly with build duration; the UI log view freezing or showing garbled
characters on a build with heavy npm/yarn progress-bar output; a dropped SSE connection losing log
lines with no way to recover them via resync.

**Phase to address:** Deploy engine phase (build logs are in roadmap §7.8's acceptance criteria
directly: "Build logs are available", "Runtime logs are available"). Verification: a load test
streaming a multi-minute, high-line-rate fixture build and asserting bounded memory/Redis growth,
not just correctness on a fast fixture.

---

### Pitfall 5: The UI shows a stale container state

**What goes wrong:**
A container's real status (building → starting → healthy/unhealthy → stopped) races with the
SSE event that is supposed to announce it, and the UI ends up showing "Building" after the
container is already running, or "Healthy" after it crashed a second later. This is not a new
class of bug for this codebase — it already happened once, for server connection state:

> `PROJECT.md`/`MILESTONES.md`, Phase 5: *"A pure `reconcileDetailSnapshot` guard plus a single
> `applyServer` write path stop the detail screen from showing stale or resurrected server state
> under an ordinary GET/event race"* — and separately *"a `lastReceivedIndex`-based rewrite of
> `discovery-progress.ts` stops the discovery checklist from rendering a check it never received
> as running or passed."*

**Why it happens:**
Any UI that combines an initial `GET` snapshot with a live event stream has an inherent race: the
snapshot request and the first relevant event can arrive in either order, or an event can arrive
for a state the snapshot already superseded. This system already discovered and fixed this
*exact* failure class for server connection state and discovery-check state; container/deploy
status is structurally the same problem (snapshot + ordered events) and will reproduce it if
reimplemented from scratch without reusing the fix's shape.

**How to avoid:**
Reuse the proven pattern, not just its lesson: a pure reconciliation function (like
`reconcileDetailSnapshot`) that takes the last known snapshot and an incoming event and decides,
by an explicit ordering signal (sequence number, `lastReceivedIndex`, or a monotonic
`updated_at`), whether the event supersedes the snapshot — never a bare "last write wins by
arrival order" `setState`. Model container/service status the same way `ServerStatus` already is:
a small, closed enum with a domain-level transition table (`packages/domain`), not a string set
directly from Docker's own status vocabulary (which is looser and can report transient/ambiguous
states Docker itself is still reconciling).

**Warning signs:** A UI test that deploys, immediately triggers a background refresh, and asserts
the status shown matches the last *emitted* event rather than the last *received* one; container
status flapping visually between two values on a fast build/start cycle; a status shown as
"Building" that never clears after the SSE connection drops and resyncs.

**Phase to address:** Deploy engine phase, using the same domain-level state machine discipline
`04-VALIDATION.md`/Phase 3 already established for `Server` (packages/domain state machines at
≥95% coverage). Verification: an integration test that races a `GET` and an event exactly as
Phase 5's fix was proven, not just a manual walkthrough.

---

### Pitfall 6: Race between two deploys of the same service (no idempotency key, no lock)

**What goes wrong:**
Two deploy requests for the same service — a user double-clicking "Deploy", a webhook retry
(anticipated in v0.3 but the underlying concurrency risk starts the moment deploy exists),  or a
UI retry after a slow response — run concurrently. Without serialization, both can `docker build`
into the same tag, both can attempt `docker run` with the same container name (a real, previously
reported failure mode in this exact product category: coollabsio/coolify#7566, *"Deployment
failing due to helper container name being already in use"*), or one can complete and update the
row while the other's stale in-flight job later overwrites it with an older result.

**Why it happens:**
Deploy naturally *feels* like a fire-and-forget background job (v0.1's `connectAndDiscover` is
exactly that shape), so a developer wires it the same way: enqueue on request, no gate. What v0.1's
own implementation of that shape had to add on top — and what a naive copy would miss — is the
concurrency control layered around it.

**How to avoid:**
Reuse two mechanisms this codebase already built for the same underlying problem, applied to
`Service`/`Deployment` instead of `Server`:
- **BullMQ jobId dedupe**: `connectAndDiscover`'s queue producer already dedupes by a
  deterministic jobId (`connect-<serverId>`) precisely so a second enqueue for the same server
  while one is in flight is a no-op rather than a second worker execution — the note in
  `PROJECT.md`'s Key Decisions explicitly warns that BullMQ 6.x rejects `:` in custom ids and that
  a retained terminal job silently makes the *next* enqueue a no-op if not deleted first. A
  `deploy-<serviceId>` jobId following the exact same discipline (and the exact same terminal-job
  cleanup this project already had to debug once) is the direct analog.
- **Row lock + reason-gated transition**: `editServer`'s D-11 fix closed "the concurrent-connect
  race" with a row lock during the transaction that starts a connection attempt. A `Service`'s
  transition into `DEPLOYING` needs the identical guard — acquire the lock, check the current
  state is deploy-eligible, transition, release — so a second concurrent deploy request for the
  same service is rejected (409, not silently queued a second time) rather than racing.

An idempotency key supplied by the *caller* (for a future webhook-triggered deploy in v0.3) is a
separate, additive concern; the base case for v0.2 is that Noodara's own UI/API must not be able to
race itself.

**Warning signs:** Two containers with the same intended name existing simultaneously during a
test that fires two deploy requests back to back; a `Deployment` row's final status flipping
backward (e.g., `RUNNING` → `BUILDING`) because a slower, stale job's completion arrived after a
faster retry's; the BullMQ terminal-job-retention bug (already once found and fixed for
`connect-<serverId>`) reappearing for `deploy-<serviceId>` because the lesson wasn't ported over.

**Phase to address:** Deploy engine phase, as part of the `Deployment` domain model itself.
Verification: a concurrent-double-deploy integration test mirroring the shape of Phase 3's
row-lock tests for `editServer`.

---

### Pitfall 7: Git edge cases — submodules, LFS, shallow clones, branch renames, force-push, expiring private-repo auth

**What goes wrong:**
Several distinct Git failure modes, each silently producing a wrong or broken deploy rather than
a clean error if not handled explicitly:
- **Submodules**: a superproject pins a submodule to a commit that has since been force-pushed
  away or made unreachable on the submodule's own remote — the clone succeeds for the main repo
  and then fails, confusingly, on submodule checkout.
- **Git LFS**: a repo using LFS for binary assets clones "successfully" with LFS pointer files
  (small text stubs) instead of the actual binaries unless `git lfs` is installed and `git lfs
  pull` runs — the build then fails deep inside the Dockerfile with an unrelated-looking error
  ("invalid image", "corrupt archive") rather than a Git-layer one.
- **Shallow clones**: a naive `git clone --depth 1` (attractive for build speed on a small VPS)
  breaks `git log`, `git merge-base`, and any deploy logic that needs to diff against a previous
  commit; more subtly, shallow clones cannot be pushed from and some tools assume full history is
  available for change detection.
- **Branch renamed**: a service configured against `main` when the remote's default branch was
  renamed (or the tracked branch itself renamed/deleted) fails with a generic "branch not found"
  unless the error path distinguishes "branch doesn't exist" from "repo unreachable" from
  "auth failed".
- **Force-push**: the commit SHA Noodara captured and displayed for a previous deployment
  (roadmap §7.3's explicit requirement, "capture deployed commit SHA") may no longer be
  reachable on the remote if history was rewritten — re-deploying the *same* service later, or
  displaying "deployed at commit X" as a link, must not assume that SHA is still resolvable.
- **Private-repo auth expiring mid-deploy**: a token valid at service-creation time expires (or is
  revoked) between deploys; the resulting Git auth failure must map to a specific, actionable error
  code — not the generic "connection failed" this system's SSH layer already carefully avoids for
  its own auth failures (`AUTH_FAILED` is one of the seven frozen SSH error codes; Git needs its
  own equivalent, not a reuse of the SSH one, since it is a structurally different failure).

**Why it happens:**
The happy path (public repo, no submodules, no LFS, full history, stable branch, valid token
forever) is what gets tested first and is what most fixture repos look like — including the
`node-api`/`static-app`/`failing-build` fixtures this milestone itself introduces per roadmap
§7.6, none of which are described as exercising these edge cases.

**How to avoid:**
- Default to a **shallow clone with a bounded depth sufficient to capture the target commit's
  SHA** (`--depth 1` against the specific branch/ref, not the whole history) for deploy speed, but
  never assume more history is available than was requested — no deploy-engine logic should call
  `git log`/`git merge-base` against a shallow clone.
  - LOW confidence flag: whether v0.2's scope needs diffing against a previous commit at all is a
    requirements question, not fully resolved by this research — roadmap §7.3 only asks to
    "capture deployed commit SHA", which a shallow clone already satisfies.
- Detect Git LFS pointer files after clone (they are small, structured text files with a
  recognizable `version https://git-lfs.github.com/spec/v1` header) and fail with an actionable,
  Noodara-specific error rather than letting the Dockerfile build fail cryptically — LFS support
  itself can be explicitly out of scope for v0.2 as long as the failure is clear.
  - Submodule support can likewise be explicitly deferred, but the failure when a submodule
    directive is detected and not supported must be a named error, never a silent partial clone.
- Distinguish branch-not-found from repo-unreachable from auth-failed as separate, allowlist-safe
  error classifications — following the exact precedent of `classifySshError`'s "one frozen,
  ordered, never-throwing classification table" for SSH failures (`packages/ssh/src/error-
  classifier.ts`), applied to a new `classifyGitError` module in whatever package owns Git
  operations.
- Never assume a captured commit SHA remains resolvable later; treat it as a point-in-time fact
  (the same "as of &lt;relative time&gt;" framing v0.1 already uses for discovery facts per
  `docs/ui-build-prompt.md` §3.1) rather than a live link that must always resolve.

**Warning signs:** A build failing with a Docker-layer error message when the root cause was an
LFS pointer file or a missing submodule; `git clone` succeeding but the deployed app crashing on a
missing binary asset; re-deploying an old service failing opaquely after the tracked branch was
renamed upstream.

**Phase to address:** Deploy engine phase, as part of the Git operations service (roadmap §7.3).
Verification: integration tests against real fixture repos deliberately exercising a renamed
branch and an expired/invalid token (submodules and LFS can be explicit non-goals with a named,
tested rejection path rather than full support).

---

### Pitfall 8: Dockerfile edge cases — build context size, `.dockerignore`, multi-stage target, ARG vs ENV, port detection

**What goes wrong:**
Five distinct Dockerfile-handling failure modes:
- **Build context size**: sending the entire repo (including `node_modules`, `.git`, build
  artifacts) as Docker build context over an SSH-executed `docker build` is slow, can exceed the
  per-command timeout budget entirely (see Pitfall 11), and on a small VPS can itself be a source
  of disk/network pressure.
- **Missing or wrong `.dockerignore`**: without one, the build context above happens by default;
  with one that's stale relative to the actual repo layout, large irrelevant directories still
  get sent.
- **Multi-stage builds without an explicit target**: a Dockerfile with multiple `FROM` stages and
  no `--target` flag builds (and discards) every stage up to the last one — usually fine, but a
  deploy engine that assumes "the Dockerfile has exactly one relevant stage" will mis-detect the
  runtime image if a Dockerfile author intended a named final stage.
- **ARG vs ENV confusion**: an `ARG` only exists during build and is not available at container
  runtime unless explicitly re-declared as `ENV`; a service configuration UI that lets a user set
  "environment variables" without distinguishing build-time-only from runtime-persistent values
  will silently produce a container missing a variable the user thought they set (or, worse per
  Pitfall 3, will bake a value meant to be a runtime secret into build-time `ARG`, which is the
  less secure of the two).
- **Port detection**: inferring which port a container listens on (for reverse-proxy wiring later
  in v0.4, and for healthcheck-wait now) from `EXPOSE` is unreliable — `EXPOSE` is documentation,
  not a guarantee the app actually binds that port, and many Dockerfiles omit it entirely. Roadmap
  §7.1 already requires an explicit, user-supplied `internal port` field per service specifically
  because inference is not trustworthy — the pitfall is a future implementer "helpfully" trying
  to auto-detect it from `EXPOSE` and treating a mismatch as a Noodara bug instead of documented,
  required user input.

**Why it happens:**
Local development Docker builds run in an environment (fast local disk/network, no per-command
timeout, no build-context-over-SSH transfer step) that hides all five of these; they only surface
once builds run against a real remote host under this system's existing "every remote operation
has an explicit timeout" discipline (CLAUDE.md §2.3) and its own SSH exec channel (Pitfall 2).

**How to avoid:**
- Transfer build context efficiently: prefer having the remote host do its own `git clone`
  directly (Pitfall 7) rather than tarring and shipping the local checkout over the same SSH
  channel used for command execution — the repo is already on the target host by the time
  `docker build` runs, so the "build context" is the clone directory, not a transferred archive.
- Ship the three official fixtures (`fixtures/node-api`, `fixtures/static-app`,
  `fixtures/failing-build` per roadmap §7.6) each with a real, intentional `.dockerignore`, and
  add a test asserting the effective build context size for each fixture stays under an explicit
  budget — this turns "reasonable context size" from a hope into a measured number.
- Require `--target` to be explicit (from the roadmap §7.1 service configuration) whenever a
  Dockerfile has more than one `FROM`; detect multi-stage Dockerfiles by parsing `FROM` count
  before build and fail fast with an actionable error if a target is required but missing, rather
  than silently building to the last stage.
- Never let build-time `ARG` and runtime `ENV`/env-file values share one UI field or one storage
  path — model them as the two different entities roadmap §7.1's port/branch/source-type fields
  already imply are distinct, structured data, not a single freeform key-value list.
- Keep the internal port a required, explicit field (already in roadmap §7.1's service schema) and
  treat any future auto-detection as a convenience *suggestion* the user can override, never an
  authoritative source that silently changes behavior.

**Warning signs:** A build against a large `node_modules`-containing fixture taking minutes longer
than the equivalent fixture with a `.dockerignore`; a multi-stage Dockerfile fixture producing the
wrong final image without an explicit failure; a "runtime env var" the user set not appearing in
`docker inspect`'s `Config.Env` on the deployed container.

**Phase to address:** Deploy engine phase, addressed directly by roadmap §7.4's required unit
test categories (`service configuration`, `port validation`) and §7.6's fixtures. Verification:
context-size assertions and multi-stage-target tests against the official fixtures.

---

### Pitfall 9: Image pulls needing registry authentication

**What goes wrong:**
Roadmap §7.1 explicitly includes "Docker image" as a service source type alongside Git and
Dockerfile — but `docker pull` from a private registry (Docker Hub private repo, GHCR private
image, a self-hosted registry) requires credentials the same way a private Git repo does. If the
deploy engine only ever tests against public images (the path every fixture and demo naturally
exercises first), `docker login`/registry-auth handling is invisibly absent until the first real
private-image deploy fails with an opaque `docker: unauthorized` error that never reaches the user
as anything actionable. This system's own images (`ghcr.io/nooodara/noodara-control-plane`,
`noodara-web`) are themselves public on GHCR, so there is no existing internal precedent in this
repo for *authenticated* pulls to build on — this is a genuinely new credential type, structurally
identical in sensitivity to the SSH `Credential` type in `noodara-security`'s data model table but
currently absent from it.

**Why it happens:**
"Deploy from a Docker image" sounds like a one-line `docker pull <image>` and is easy to demo
end-to-end against a public image without ever touching auth, right up until a real user's private
image is the first one tried.

**How to avoid:**
Add registry credentials as a first-class `Credential`-shaped entity from the start — encrypted
at-rest, never returned by the API, referenced (not embedded) the same way SSH credentials already
are — rather than deferring "private registry support" as a later add-on that then has to be
retrofitted into the service schema, the deploy service, and the redaction rules simultaneously.
`docker login`'s credential handling itself has the same command-injection-adjacent shape as
Pitfall 3's git-token concern: credentials must go through `docker login --password-stdin` (never
as a bare CLI argument) so a registry password never appears in `ps aux` or shell history on the
remote host.

**Warning signs:** A "Docker image" service type that only ever gets tested against `docker.io/
library/*` or GHCR public images in the test suite; a private-registry pull failing with a raw
Docker CLI error string reaching the UI (violating hard prohibition #17 in `docs/ui-build-prompt.md`,
"never render raw server text").

**Phase to address:** Deploy engine phase — registry credentials should be part of the initial
`Service` source-type design (roadmap §7.1), not bolted on later, because the credential model
(encryption, redaction, deletion-cascades) needs to exist before the first private-image test can
even be written.

---

### Pitfall 10: Name and port collisions between services on one server

**What goes wrong:**
Two services on the same server end up with colliding Docker container names (a real, previously
reported bug in this exact product category — coollabsio/coolify#7566, "Deployment failing due to
helper container name being already in use") or colliding host-published ports, and the second
deploy fails with a raw Docker error rather than a clear, pre-flight-checked Noodara error.

**Why it happens:**
Container naming and port publishing are easy to get right for a single service in isolation and
easy to get wrong the moment two services on the same server share a naming convention (e.g., both
derived from a project/service slug that happens to collide) or both request the same host port
because neither validated against what else is already running.

**How to avoid:**
Derive container names deterministically from the `Service` entity's own identity (its UUID or a
namespaced slug scoped to `project/environment/service`, not a user-freeform string) so
collisions are structurally impossible within Noodara's own bookkeeping — exactly the discipline
`SERV-08`'s access-matrix and the domain-derived enum/UUIDv7 primary-key pattern already establish
for other entities in this codebase (`PROJECT.md`, Phase 1: "Nine-table Drizzle/PostgreSQL schema
with domain-derived enums and UUIDv7 primary keys"). For ports, validate against a live query of
what the target server actually has in use (`docker ps --format json` for published ports) at
deploy time, not just against Noodara's own database, since a port could be occupied by something
Noodara never created — and fail with a specific, actionable `PORT_IN_USE`-style error rather than
surfacing Docker's raw bind error text (hard prohibition #17).

**Warning signs:** Two services created with visually similar names producing the same derived
container name in a test; a deploy failing with `port is already allocated` reaching the UI
verbatim instead of a mapped error code.

**Phase to address:** Deploy engine phase, addressed by roadmap §7.4's explicit unit-test category
"resource naming collisions" and "container naming" — write the collision test before the naming
scheme, per this project's TDD discipline.

---

### Pitfall 11: Time limits — a build that takes 40 minutes

**What goes wrong:**
v0.1's every-remote-operation-has-a-timeout discipline (CLAUDE.md §2.3, `noodara-security` skill
§4: "connect 10s, comando 30s por defecto, discovery total 60s") was sized for discovery commands
that complete in seconds. A `docker build` for a real application can legitimately take tens of
minutes (dependency installation, multi-stage compilation). If the deploy engine reuses
`execWithTimeout`'s existing default timeout (or any single fixed timeout) unmodified, every build
past that budget is killed as a `CommandTimeoutError` — indistinguishable from a genuinely hung
command — and the user's honest 40-minute build is reported as a timeout failure, not a bug in
their Dockerfile.

**Why it happens:**
The instinct that already served this codebase well ("every remote operation has an explicit
timeout") is correct, but naively applying the *same number* everywhere conflates two different
kinds of timeout: a budget that protects against a hung/unresponsive remote (should stay tight,
seconds) and a budget that bounds a legitimately slow but progressing operation (should be
minutes, and should reset on progress, not be a single fixed ceiling).

**How to avoid:**
Give builds their own, separately configured timeout budget (minutes, not the 30s default), and
make the timeout **progress-aware** rather than a single fixed ceiling: as long as new build-log
output is arriving, extend an inactivity timeout rather than enforcing one absolute deadline from
start — the same distinction Docker's own BuildKit progress output already makes available. Also
give the *BullMQ worker's* own stalled-job handling explicit awareness of this: the worker's
existing pattern (`maxStalledCount: 0` + a `stalled` listener, per Phase 4, "proven empirically
against real Redis to never reconnect over SSH") was tuned for short discovery jobs; a 40-minute
build job must not be treated as "stalled" by BullMQ's own lock-renewal timeout if that timeout
is inherited unmodified from the discovery job's configuration. Surface both an inactivity
timeout and a hard maximum (e.g., "no output for 5 minutes" vs. "never runs longer than 60
minutes total") as two distinct, separately testable behaviors, and report which one fired in the
error so a slow-but-alive build is never confused with a truly hung one.

**Warning signs:** A legitimately large fixture build being killed by the same timeout that
protects a hung SSH command; the BullMQ worker marking a real in-progress build job "stalled" and
letting the startup sweep (`listConnectingServerIds`'s analog for deploys) reap it while it is
still running remotely — reproducing Pitfall 2's zombie-process problem from a different cause.

**Phase to address:** Deploy engine phase — the timeout budget and BullMQ lock-renewal
configuration must be designed together with the streaming log mechanism (Pitfall 4), since
"progress" for the inactivity timeout is defined by log output arriving.

---

### Pitfall 12: Docker-in-Docker fixtures and Testcontainers built for a *local* daemon don't model a *remote* SSH-reached Docker host

**What goes wrong:**
This repo already has a real, working DinD fixture (`tests/integration/helpers/installer-dind.ts`,
`tests/integration/images/installer-dind-*`) — but it was built to prove `install.sh`'s behavior:
images reach the nested daemon via `docker save`/`docker load`, explicitly "zero registry
involvement" by design (its own doc comment: "D-19... zero registry involvement"). If v0.2's Docker
build/pull/registry-auth integration tests reuse this fixture unmodified on the assumption that
"we already have a Docker Testcontainers pattern", they will silently never exercise: registry
pulls over a real network, registry-auth failures, build context transferred over an actual SSH
connection (rather than files already present in the container's filesystem), or the specific
SSH-exec-channel mechanics Pitfall 2 depends on (`execWithTimeout` talking to a real remote shell,
not a local Docker socket). The existing sshd Testcontainers fixture
(`tests/integration/helpers/ssh.ts`, used throughout Phase 2/3) is closer to what's needed, but it
was built for command-allowlist/discovery testing, not for a target that also needs a real,
independently addressable Docker daemon reachable *through* that same SSH session.

**Why it happens:**
Both fixtures look superficially reusable — "we already have Docker Testcontainers" and "we
already have SSH Testcontainers" are both true — but neither one, alone or combined without
modification, models the actual v0.2 topology: **one SSH-reachable container that has both a
working sshd and a real Docker daemon the SSH session can drive `docker build`/`docker pull`
against, with genuine network access to pull images and (for private-registry tests) reach an
actual or stubbed registry.**

**How to avoid:**
Build a new, dedicated fixture combining both existing ones' proven pieces rather than repurposing
either as-is: base it on the existing sshd Ubuntu 22.04/24.04 images (`tests/integration/helpers/
ssh.ts`'s own Dockerfiles), add a real Docker Engine install inside that image (following the same
apt-repo-with-pinned-GPG-key installation `install.sh`'s `noodara_ensure_docker` already proves
works on both Ubuntu versions), and keep it network-attached (not the DinD fixture's
zero-registry-by-design isolation) so registry pull tests are real. Explicitly do **not** reuse
`installer-dind.ts`'s `docker save`/`load` no-registry pattern for anything testing registry auth
(Pitfall 9) or real build-context-over-network transfer (Pitfall 8) — that pattern was correct for
its own purpose (proving `install.sh` needs no registry) and wrong for this one.

**Warning signs:** A deploy-engine integration test suite that passes entirely in CI but the first
real registry-auth bug is found only by a human on a real VPS (mirroring exactly how v0.1's install
flow needed a real VPS run — per `06-HUMAN-UAT.md` prerequisite 7 — to catch what DinD couldn't);
tests that never exercise an actual `docker pull` over the network because everything was
pre-loaded into the fixture.

**Phase to address:** Deploy engine phase, as test-infrastructure work that should land *before*
the first Docker-operations integration test is written (roadmap §7.5's "pull Docker image",
"build Dockerfile" integration test categories), not discovered mid-phase when the existing DinD
fixture turns out to be the wrong shape.

---

### Pitfall 13: UI redesign regresses accessibility/contrast while adding depth and materials

**What goes wrong:**
`docs/ui-build-prompt.md` §5.1 documents that Noodara's `accent`/`accent-fill`/`accent-text` token
split and the `status-*-text` variants exist *specifically* because "las medidas reales de
contraste fallaban AA" when collapsed to a single token — this was measured, not assumed, and
there is a `contrast.ts` test enforcing it. The redesign backlog (§8.1–8.2) adds
`--shadow-floating`, vibrancy/translucency treatments, and new surfaces (Sheet/Dialog/RowMenu
elevation) — every one of which changes the effective background a piece of text or a border sits
on top of. Adding a shadow or a translucent material without re-measuring contrast against the new
composited background can silently reintroduce the exact AA failure the token split was built to
fix, on a *different* pair this time.

**Why it happens:**
Contrast is a property of a rendered pair (foreground vs. actual composited background), not of a
token in isolation. A change to elevation/material treatment changes the second half of that pair
even when no color token itself was edited — the class of bug is easy to miss because "I didn't
touch any color" feels true while being false for the *effective* color.

**How to avoid:**
`docs/ui-build-prompt.md` §10 (UI DoD) already requires "Contraste medido, no estimado" for *every*
visual feature closed in this milestone — treat every P0/P1 backlog item that touches
`--shadow-floating`, translucency, or a new surface as requiring a fresh `contrast.ts`-style
measurement of every text/border pair rendered on that surface, in both themes, not a one-time
audit at the start of the redesign. Generalize `contrast.ts`'s existing "name-derived
`FILL_TOKEN_RE` loop" (already built once, per `PROJECT.md`'s Key Decisions, to catch new
`accent-fill`-family tokens automatically) to also catch new elevation/material tokens as they're
added, rather than hand-adding each one to an audit list that can silently go stale.

**Warning signs:** A contrast measurement done once at the start of the redesign phase and never
re-run after `--shadow-floating`/vibrancy land; a PR touching `Sheet`/`Dialog`/`RowMenu` visuals
with no corresponding `contrast.ts` test change; a component review that eyeballs contrast in one
theme only.

**Phase to address:** UI redesign phase, gated by `docs/ui-build-prompt.md` §10's own DoD item
("Contraste medido... con copy real, en ambos temas") — this is already a hard requirement in the
brief this milestone is built against, not a new recommendation.

---

### Pitfall 14: Animating keyboard-initiated actions

**What goes wrong:**
`docs/ui-build-prompt.md` §6.1 states the rule explicitly and names the exact three surfaces it
applies to in this app: *"nunca animes una acción iniciada por teclado... En Noodara eso significa:
la navegación del sidebar, el `Tab` por el focus order y el `Esc` que cierra un overlay no llevan
animación de entrada propia."* The redesign backlog's own P1 item 5 (drag-to-dismiss `Sheet` with
a full gesture pipeline — pointer capture, rubber-banding, momentum projection, spring handoff)
and item 9 (`transform-origin` anchoring for `RowMenu`/`Tooltip`) are exactly the kind of work
where a developer, having just built a beautiful animated open/close for `Sheet`/`Dialog`, reaches
for the same animation on every dismissal path including `Esc` — because it is more code to special
-case the keyboard path than to let one animation cover all triggers.

**Why it happens:**
Keyboard dismissal and gesture dismissal share a component (the same `Sheet` closing), so the
natural implementation shape is "the sheet has one close animation" — the discipline required is
to *branch* on trigger source and suppress entry animation specifically for keyboard/frequent
paths, which is extra code the happy path doesn't need.

**How to avoid:**
Build the distinction into the component's API from the start, mirroring this codebase's own
"make the type impede the prohibited" discipline (§7.1 of the brief itself, already proven for
`ToolbarProps.primaryAction` and `ServerView`'s credential-exclusion): a `Sheet`/`Dialog`/`RowMenu`
close handler should accept (or infer from the DOM event) whether the trigger was
pointer/gesture-originated vs. keyboard-originated, and route to a no-animation close path for the
latter — not leave it to call-site discipline to remember every time. Test it explicitly: an E2E
assertion that pressing `Esc` closes the overlay within one frame, with no measurable transition
duration, alongside the existing gesture-close tests.

**Warning signs:** A `RowMenu`/`Sheet` E2E test that only exercises pointer-driven close, never
`Esc`; a code review missing that a shared `onClose` handler has no branch for trigger type; a
sidebar navigation item that visibly transitions on `Tab`+`Enter` the same way it does on click.

**Phase to address:** UI redesign phase, directly enforced by hard prohibition #10 in
`docs/ui-build-prompt.md` §9 ("Sin animación en acciones iniciadas por teclado").

---

### Pitfall 15: `backdrop-filter` jank from stacking too many translucent surfaces

**What goes wrong:**
`docs/ui-build-prompt.md` §4.3 sets a hard budget: *"Máximo 3–5 `backdrop-filter` simultáneos en
una página antes de que aparezca jank en móvil. Noodara tiene uno (el toolbar). Mantenelo así."*
The redesign explicitly adds vibrancy/translucency to `Sheet`, `Dialog`, and `RowMenu` (§5.3's
conflict-resolution table: "agregar vibrancy... Un solo `backdrop-filter` en la página" — note the
doc itself already flags the tension). A screen that can simultaneously show the toolbar
(existing) plus an open `Sheet` plus a `RowMenu` triggered from within that `Sheet` plus a
`Tooltip` is now four translucent surfaces stacked at once on exactly the kind of screen (server
detail, with its dense action menus) this app already has the most of.

**Why it happens:**
Each surface's translucency is designed and reviewed in isolation (does the `Sheet` look right by
itself? does the `RowMenu` look right by itself?) — the combinatorial case of several open at once
on a real, dense screen is easy to skip in review because it requires deliberately opening nested
overlays to reproduce, not just viewing one component in Storybook-style isolation.

**How to avoid:**
Explicitly count simultaneous `backdrop-filter` instances for the worst realistic case per screen
(toolbar + Sheet + RowMenu-inside-Sheet + Tooltip, as above) during the redesign's implementation
of §5.2's floating elevation, and cap it against the doc's own 3–5 budget — if the realistic worst
case would exceed it, collapse one of the surfaces to a solid/near-solid material instead of
translucent (the doc's own §7.7 already permits this: "las superficies grandes se leen como más
gruesas" and heavier materials are appropriate for structural regions). Test on real mobile
hardware per §7.10's own debugging guidance ("Hardware real para todo lo táctil"), not just
desktop Chrome DevTools' simulated throttling, since `backdrop-filter` compositing cost is a real
GPU/mobile-Safari-specific concern this doc calls out by name.

**Warning signs:** Visible scroll/animation stutter specifically on the server-detail screen with
a `RowMenu` open inside a `Sheet`; a redesign PR that adds `backdrop-filter` to a fourth or fifth
component without anyone counting the running total against the documented budget.

**Phase to address:** UI redesign phase, as part of implementing §5.2's floating-elevation tokens
— budget the surface count before styling each component, not after all three ship independently.

---

### Pitfall 16: Breaking the existing 93 E2E tests with test-id/selector changes

**What goes wrong:**
v0.1 closed with 93 passing E2E tests (`docs/releases/v0.1-gate.md`, criterion 4: "20/20 iterations
… 93/93 tests in each") spread across `tests/e2e/*.spec.ts` (auth, shell, servers-list, server-
detail, server-sheet, discovery, host-key, activity, settings, canary-ui, critical-path,
dod-hardening — a wide surface). The redesign backlog explicitly reworks `RowMenu` (§8.1 item 2:
"cerrar al seleccionar, devolver el foco, trigger visible en táctil, keys de React estables"),
restructures elevation on `Sheet`/`Dialog`, and touches the toolbar's divider treatment (§5.3's
"scroll edge effect" replacing `border-b`). Any of these that change a component's DOM structure,
role, or accessible name — rather than only its visual styling — can silently break `getByTestId`/
role-based Playwright locators across many of those 93 tests at once, including the security-
critical `canary-ui.spec.ts` and `dod-hardening.spec.ts` specs.

**Why it happens:**
Visual/animation work is reviewed against "does it look right", and Playwright test breakage is
only discovered by actually running the full suite — which, per the redesign's own P0 item 4
("primera revisión visual humana real"), is explicitly the first time this UI is being seriously
scrutinized end-to-end by anyone, human or automated, making this the highest-risk moment in the
project's history for a large, silent test-suite regression.

**How to avoid:**
Run the full `pnpm test:e2e` suite after every component-level change during the redesign, not
just at the end of the phase — the existing suite is the regression safety net this exact
milestone needs most, precisely because it is being modified. Where a component's accessible
role/name is intentionally changing (e.g., `RowMenu` fixing its known focus/close-on-select bugs
per §3.3's documented debt), update the corresponding E2E assertions in the same PR/plan as the
component change, per this project's TDD discipline (RED on the new expected behavior, GREEN on
the fix) — never as a follow-up "fix the tests later" pass, which is exactly the shortcut that
turns a targeted `RowMenu` fix into an untraceable batch of unrelated E2E failures. Preserve
`data-testid`/stable selectors as a deliberate, reviewed contract across the redesign (the nine
"comment-filtered static gates" already enforced in this codebase per Phase 5 — e.g., "no Radix
escape/outside-click overrides", "`@noodara/ui/testing` reachable only from tests" — are the right
model: encode the "don't silently rename test hooks" rule as an enforced, static check rather than
convention).

**Warning signs:** `pnpm test:e2e` failure counts climbing gradually across redesign PRs without
each failure being individually triaged; a batch of E2E fixes landing in the same plan as a large,
unrelated visual change; the `@canary` secret-leak E2E spec (previously found to hang on ~half its
runs from a real defect per Phase 5's own retrospective) silently skipped or disabled rather than
fixed during the redesign.

**Phase to address:** UI redesign phase — run and fix the full E2E suite continuously through the
phase, with a final full run (including the nightly 20x repeat, per the existing `e2e-repeat.mjs`
harness) as an explicit exit gate before declaring the redesign complete.

---

### Pitfall 17: Theme-override flicker on reload

**What goes wrong:**
The user sets an explicit theme override (`docs/ui-build-prompt.md` §9's hard prohibition #13:
"Dark y light son ambos de primera clase. El override manual siempre gana sobre el SO."). On page
reload, if the theme is applied only after React hydrates (reading `localStorage` in a
`useEffect`), the page renders once in the server-guessed/default theme and then visibly snaps to
the stored preference — the exact class of bug this codebase already found and fixed once: Phase 5
gap-8 closed *"a ThemeToggle that no longer hydration-mismatches for every user with a stored
theme"*, and `ThemeToggle` is explicitly called out (§7.1 of the brief itself) as *"el único
componente en todo el codebase con permiso para escribir la preferencia de tema persistida después
de la carga de página"* — a component whose correctness this milestone's new Settings screen
(target feature 3: "tema auto/claro/oscuro con override persistente") is about to build directly
on top of.

**Why it happens:**
The v0.1 fix already lives in this codebase, but the new editable-Settings theme control (a new UI
surface, not just the existing toggle) is new code with its own write path into the same persisted
preference — if it's built as a parallel implementation rather than routing through the one
already-fixed component/mechanism, it can silently reintroduce the same flash-of-wrong-theme bug
through the new path while the old toggle stays fixed.

**How to avoid:**
The new Settings theme control must call into the *same* persisted-preference write path
`ThemeToggle` already owns (per the brief's own explicit single-writer rule) rather than
implementing a second `localStorage`-writing code path. Verify with the same kind of test that
caught the original bug: a real-browser reload test asserting the theme is correct on the *first*
paint (no flash), not just eventually-correct after hydration.

**Warning signs:** A visible flash of the wrong theme on reload specifically when reached via the
new Settings screen but not via the existing sidebar `ThemeToggle`; two different modules writing
to the same theme-preference storage key.

**Phase to address:** Settings-editable phase (target feature 3), building directly on the UI
redesign phase's component work — verification should explicitly re-run the Phase-5-style
hydration test against the *new* write path, not just trust the old one still works.

---

### Pitfall 18: Docs drift from the real CLI/installer, landing claims not backed by the product

**What goes wrong:**
Two related but distinct failures on the new public surfaces (target features 4):
- **Docs drift**: the public docs site describes CLI flags, deploy behavior, or installer options
  that don't match what the shipped code actually does — the exact failure class
  `tests/unit/docs/install-docs-accuracy.test.ts` was built to prevent for `docs/install.md`
  (verified by this research: it extracts install.sh's exit-code table and ufw wording
  programmatically from the script's own source rather than trusting a hand-copied string, per its
  own header comment: *"the docs must describe the script that actually ships, not the one any
  single plan described in advance... accuracy here is tested against install.sh's own source,
  never asserted by hand"*). This milestone adds new CLI/deploy-facing surface area (Projects/
  Environments/Services CRUD, deploy flow, new fixtures) with no equivalent accuracy test yet.
- **Landing claims not backed by product**: marketing copy on the public landing page describing
  capabilities Noodara doesn't have yet (AI chat, Infrastructure Graph, multi-server orchestration
  — all explicitly v0.5+ or out of scope per `PROJECT.md`'s "Out of Scope" section) directly
  violates this project's own hard rule against "placeholders de funcionalidad que no existe"
  (`docs/ui-build-prompt.md` §9, prohibition #19) — a rule written for the in-app UI but whose
  underlying reasoning (never promise what isn't built) applies at least as strongly to public,
  externally-facing marketing copy, where the cost of over-promising is a lost user's trust rather
  than an internal placeholder.

**Why it happens:**
Docs and landing copy are written once, early, against the *intended* design, and both the CLI
surface and the product roadmap keep moving under them — exactly what already happened once for
`docs/install.md` in Phase 6 ("~10 audit-driven post-execution fixes across plans 06-04..06-13"
before the docs matched reality), and exactly what will happen again for any new docs/landing copy
that isn't mechanically checked against the shipped artifact.

**How to avoid:**
Extend the `install-docs-accuracy.test.ts` *pattern* — read the real, shipped source of truth
(CLI help output, `commandFor`'s allowlist, the fixture READMEs, `roadmap-v0.1-v0.5.md`'s own
"Out of Scope" sections) and assert docs/landing text is consistent with it, rather than hand
-verifying once at write time. Concretely: a test that greps the landing page's feature-claim copy
against the same "Out of Scope" list in `PROJECT.md` and fails if a claimed feature name appears
there; a test that extracts every CLI flag/command documented on the public docs site and asserts
it exists in the real `commander`-based `noodara` CLI (the same "structural proof against the real
files" pattern the docs-accuracy test's own header comment names as its model, mirroring
`tests/unit/scripts/check-workflow-pins.test.ts`'s approach too).

**Warning signs:** A landing page or docs PR with no corresponding test change; marketing copy
using present tense for a v0.3+/v0.5 feature; a docs page describing a deploy CLI flag that
doesn't exist yet because it describes the intended design rather than the shipped one.

**Phase to address:** Landing + docs site phase for the initial build; the deploy-engine phase
should retroactively extend the accuracy-test pattern to cover any new CLI/API surface it
introduces, so docs drift is caught the moment the underlying feature changes, not only at the
docs site's own launch.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|--------------------|-----------------|------------------|
| Reuse the existing `Sheet`/`Dialog`/`RowMenu` overlay pattern for a new "build log viewer" panel instead of designing a dedicated streaming-log surface | Faster to ship, consistent chrome | A modal-shaped overlay is the wrong interaction model for something the user wants to keep open and scroll while doing other things (§4.2's own anti-pattern: "el modal como primer pensamiento — los modales suelen ser pereza") | Never for the primary build-log view; acceptable only for a quick error summary snippet |
| Skip BuildKit `--secret` mounts and use `--build-arg` for a "just to get the demo fixture working" first pass | Fewer moving parts to wire up first | Bakes secrets into image layers (Pitfall 3); becomes the pattern every later service copies once it exists in one working example | Never, not even for internal fixtures — the fixtures are the pattern everyone will copy |
| Use a fixed 30s command timeout for the first build-engine prototype, matching the existing SSH default | Reuses `execWithTimeout` unmodified, less new code | Any real fixture build past 30s becomes unexplainable "flakiness" until someone traces it to the reused default (Pitfall 11) | Acceptable only behind an explicit `TODO` + failing test that forces the real timeout design before merge, never silently shipped |
| Poll `docker ps`/`docker inspect` on an interval instead of building the reconciliation pattern from Pitfall 5 | Simpler than a proper snapshot+event merge | Reintroduces polling this codebase deliberately avoided everywhere else ("no polling anywhere in the path" per Phase 4's SSE summary) and the exact stale-state bug already fixed once for servers | Never as the primary mechanism; acceptable only as the SSE resync's underlying data source, not a substitute for event-driven updates |
| Ship the public docs site's first draft without wiring the docs-accuracy test extension (Pitfall 18) | Faster initial launch | Repeats the ~10-fix drift-correction cycle `docs/install.md` already went through once, this time on public-facing copy a user reads before ever installing | Acceptable only if a tracked follow-up plan exists before the docs site's phase closes — never carried silently past the milestone |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|--------------------|
| GitHub (roadmap §7.3's named first integration) | Assuming GitHub-specific auth (OAuth App / GitHub App tokens, `x-access-token` username convention) generalizes to "generic Git" without a fallback path | Build the generic Git path (plain HTTPS token or SSH deploy key, per §7.3's "Generic Git debe ser soportado cuando sea razonable") as the base case, with GitHub-specific conveniences layered on top, not the other way around |
| Docker registries (Docker Hub, GHCR, self-hosted) | Assuming unauthenticated public pulls represent the real-world case; not budgeting for Docker Hub's rate limits on anonymous/free-tier pulls, which can make a fixture-based CI suite flaky purely from external rate limiting | Prefer GHCR (already this project's own registry, per `PROJECT.md`) or self-hosted test registries for CI fixtures to avoid depending on Docker Hub's anonymous rate limits; treat registry-auth as first-class from the start (Pitfall 9) |
| BuildKit availability | Assuming BuildKit is always the active builder just because Docker ≥23.0 is installed — a `DOCKER_BUILDKIT=0` env override, a `buildx` misconfiguration, or an older Ubuntu 22.04 apt-repo Docker install could leave the classic builder active, silently defeating `--secret` mounts (Pitfall 3) | Explicitly verify the active builder (`docker buildx version` / `docker info` builder field) as part of server discovery's Docker checks (extending the existing `discovery.docker_version`/`docker.compose_version` allowlisted commands), not assumed from the Docker version number alone |
| Testcontainers for remote-host semantics | Treating "we have Testcontainers" as sufficient without checking *which* existing fixture (DinD vs. sshd) actually matches the v0.2 topology (Pitfall 12) | Build a dedicated sshd+Docker fixture combining both proven pieces, network-attached, before writing the first Docker-operations integration test |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Unbounded build-log broadcast over the existing SSE/Redis pub/sub sized for discrete server events | Redis memory climbing during a build; API process RSS growing with build duration | Bounded per-connection eviction + persisted-log/resync split (Pitfall 4) | First fixture build with more than a few thousand log lines (any real `npm install`/`apt-get` heavy build) |
| Transferring the full repo (including `node_modules`, `.git`) as Docker build context over SSH | Builds that take minutes longer than expected; SSH exec approaching its timeout budget for reasons unrelated to the actual build (Pitfall 8) | Clone directly on the remote host; enforce `.dockerignore` on official fixtures; measure context size per fixture in tests | Any repo with a checked-in `node_modules`, large binary assets, or deep git history, once real user repos (not the small official fixtures) are deployed |
| A single fixed Docker/BullMQ timeout reused unmodified from the 30s SSH default (Pitfall 11) | Real builds past 30s reported as timeouts; false "flaky" reports | Separate, progress-aware build timeout + BullMQ stalled-job tuning for long jobs | The first fixture/dependency set slow enough to legitimately exceed 30s — very likely for any non-trivial `node-api` fixture with real dependencies |
| Accumulating orphaned images/build cache without a retention policy, echoing the already-accepted `.env.bak-*` unbounded-accumulation debt in `install.sh` | `docker system df` growing between deploy cycles on a long-lived server | A resource ledger with cleanup on every exit path (Pitfall 1), plus an explicit retention/prune policy for build cache specifically (separate from per-attempt cleanup) | A server that has been deploying to the same service repeatedly over days/weeks, well past the 20-cycle test's own scope |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Passing any secret as a `--build-arg` or bare `docker run --env` CLI argument | Secret readable via `docker history`/`docker inspect`/`ps aux` by anyone with host or container access — the exact class of debt already accepted for Noodara's own Redis password | BuildKit `--secret` mounts for build-time; env-file injection for runtime (Pitfall 3) |
| Embedding a Git token directly in the clone URL string | Token visible in `.git/config` on the remote host and in process listing during clone | Credential helper / `-c http.extraHeader`, quoted via `escapeShellArg`'s existing discipline (Pitfall 3, Pitfall 7) |
| Letting build/runtime log output reach persistence or the SSE stream before Redactor processing | A secret accidentally echoed by a build script (e.g., a misconfigured `RUN env`) reaches a log a wider audience can see than ever sees a secret value directly | Route every log chunk through the Redactor per-chunk in the streaming path, not only in the old accumulate-then-return path (Pitfall 4) |
| Surfacing raw Docker/Git CLI error text in API responses or the UI | Leaks internal paths, image digests, or — worst case — a not-yet-redacted secret embedded in a Docker/Git error message; also violates hard prohibition #17 | A frozen, exhaustive `classifyGitError`/`classifyDockerError` table mirroring `classifySshError`'s "one frozen, ordered, never-throwing classification table", mapped to closed-vocabulary copy |
| Storing registry credentials without extending `noodara-security`'s "Modelo de datos sensible" table | A new credential type introduced without the same encryption/redaction/deletion-cascade guarantees the table exists to enforce | Add registry credentials as a `Credential`-shaped row in that table explicitly before implementation, not implicitly assumed to inherit the guarantee |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|--------------|-------------------|
| A build-log viewer that behaves like a modal dialog the user must dismiss to do anything else | User can't monitor a deploy while navigating elsewhere; violates the modal-as-laziness anti-pattern §4.2 already names | A non-blocking panel (this codebase's own third-panel groundwork per `docs/ui-build-prompt.md` §2.6 is exactly the right shape to grow into) |
| Showing "Building…" with no honest progress signal, spinner-style, when Docker actually reports layer-by-layer progress | Feels stuck/broken on a slow build; violates the project's own no-spinners rule (hard prohibition #4) and its own precedent (discovery's honest per-check progress, not an invented percentage) | Reuse the discovery-narration pattern already singled out as this product's "signature" moment (§8.4): real, named build steps as they complete, not a generic bar |
| A new Project/Environment/Service empty state that doesn't teach the hierarchy (what's a Project vs. an Environment vs. a Service) | New users unsure what to create first | Empty states that "enseñan la interfaz" per §4.2's own rule, extended to the new three-level hierarchy the same way the existing server empty state already teaches "add a server" |
| Reusing `RowMenu` for new per-service/per-deployment action menus before its known focus/close/touch bugs (§3.3) are fixed | The same known accessibility gaps multiply across every new list this milestone adds, instead of being fixed once | Fix `RowMenu` (§8.1 item 2) before it is reused on new Project/Environment/Service lists, not in parallel with expanding its usage |

## "Looks Done But Isn't" Checklist

- [ ] **Cancel a deploy:** Often missing the remote-process-kill step (Pitfall 2) — verify with
  `ps aux` on the target host, not just that the UI stops showing "Building".
- [ ] **"No orphan containers after failed deploy" (roadmap §7.8):** Often verified only for the
  *build* failure path — verify separately for a container that fails its healthcheck *after*
  starting, and for a cancel mid-`docker run`, not just mid-`docker build`.
- [ ] **Build logs available (roadmap §7.8):** Often works for a fast fixture build but silently
  drops or truncates lines under sustained high-volume output — verify against a fixture that
  logs continuously for minutes (Pitfall 4), not just the three official small fixtures at default
  size.
- [ ] **Service ownership never crosses projects (roadmap §7.8):** Often verified only at the
  database/authorization layer — verify separately that container *names* on the shared server
  can't collide across projects (Pitfall 10), which is a different failure mode than an
  authorization bypass.
- [ ] **"20 deployments consecutive" / "20 create/delete cycles" (roadmap §7.8):** Often run once,
  locally, with a manual `docker system prune` beforehand — verify it passes twice in a row with
  no manual cleanup between runs, and verify disk usage before/after, not just pass/fail count.
- [ ] **Private repo / private image support:** Often demoed only against the one already-working
  test credential — verify the specific failure mode of an *expired* or *revoked* credential
  produces the right error code (Pitfall 7, Pitfall 9), not just that a valid one works.
- [ ] **Theme override persistence (target feature 3):** Often verified as "eventually correct
  after page load" — verify no flash of the wrong theme occurs on the *first* paint (Pitfall 17).
- [ ] **Docs/landing accuracy:** Often verified once by a human read-through at write time — verify
  there is a standing, automated test (Pitfall 18), not a one-time manual check that will drift.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|-----------------|--------------------|
| Orphaned resources already accumulated on a real server (Pitfall 1) | LOW | A manual/scheduled `docker system prune` reachable from Noodara itself (extend the existing hardening backlog item already tracking log rotation/`.env.bak-*` pruning in `docs/releases/v0.1-gate.md`'s known debt, rather than inventing a separate mechanism) |
| A wedged `DEPLOYING` service after an API/worker crash mid-deploy (Pitfall 6's failure mode without the fix) | MEDIUM | Reuse `failInFlightConnection`'s exact shape for `Server`/`CONNECTING`: a startup sweep that resolves any service stuck past a bounded age back to a terminal `ERROR`/`FAILED` state, writing one activity event, idempotently |
| Docs/landing drift discovered after launch (Pitfall 18) | LOW | Retrofit the accuracy-test pattern against the already-shipped copy — cheap because the pattern (extract from source of truth, diff against docs) doesn't require rewriting the docs themselves, only adding the test |
| A secret already leaked into a build log or `docker inspect` output before the fix lands (Pitfall 3) | HIGH | Treat exactly like any other credential compromise per `noodara-security`'s existing posture: rotate the leaked secret, and — mirroring the real incident already handled once in this project (masking two ephemeral setup-token values in `gate-logs/` before making the repo public, per `docs/releases/v0.1-gate.md`'s Notes) — audit and redact any already-persisted logs/activity history before any public exposure |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|--------------------|-----------------|
| 1. Orphaned containers/images/networks/cache, disk exhaustion | Deploy engine | Roadmap §7.8's 20-cycle test with `docker system df` measured before/after, run twice with no manual cleanup |
| 2. Zombie SSH exec channels on cancel | Deploy engine | Integration test asserting the remote process is gone (`ps`), not just that the local promise rejected |
| 3. Secrets via build args / inspect / git URLs / logs | Deploy engine | Extended `pnpm security:scan-leaks` canary covering build-arg, git-URL-token, and container-env vectors |
| 4. Log streaming memory/Redis blowup | Deploy engine | Load test against a sustained high-line-rate fixture; bounded Redis/API memory asserted |
| 5. Stale container state in UI | Deploy engine | Snapshot/event-race integration test mirroring Phase 5's `reconcileDetailSnapshot` proof |
| 6. Concurrent-deploy race | Deploy engine | Double-deploy integration test mirroring Phase 3's `editServer` row-lock tests |
| 7. Git edge cases | Deploy engine | Integration tests against real fixture repos for renamed branch + expired token; LFS/submodules explicitly rejected with a named error |
| 8. Dockerfile edge cases | Deploy engine | Build-context-size and multi-stage-target tests against the three official fixtures |
| 9. Registry auth | Deploy engine | Private-image deploy test against the dedicated remote-Docker fixture (Pitfall 12), not a public image |
| 10. Name/port collisions | Deploy engine | Roadmap §7.4's "resource naming collisions"/"container naming" unit tests, written before the naming scheme |
| 11. Long builds vs. fixed timeouts | Deploy engine | A fixture build engineered to run past 30s, asserting it succeeds under the new progress-aware timeout |
| 12. DinD/Testcontainers fixture mismatch | Deploy engine (test infrastructure, before feature code) | A dedicated sshd+Docker fixture exists and is used by every Docker-operations integration test, not the reused install-DinD fixture |
| 13. Contrast regression from new materials | UI redesign | `contrast.ts` measurements re-run for every surface touched by `--shadow-floating`/vibrancy, both themes |
| 14. Animation on keyboard actions | UI redesign | E2E assertion that `Esc`/`Tab` dismissal has no measurable transition duration |
| 15. `backdrop-filter` jank | UI redesign | Worst-case simultaneous-surface count measured against the documented 3–5 budget; real mobile hardware check |
| 16. Breaking the 93 E2E tests | UI redesign | Full `pnpm test:e2e` (and the nightly 20x repeat) green as an explicit phase-exit gate |
| 17. Theme-override flicker | Settings-editable | First-paint (no-flash) reload test against the new Settings write path |
| 18. Docs/landing drift and unbacked claims | Landing + docs site (initial); Deploy engine (extension) | Automated accuracy test extending `install-docs-accuracy.test.ts`'s pattern to CLI/deploy surface and to landing feature claims vs. `PROJECT.md`'s "Out of Scope" |

## Sources

- This repository: `packages/ssh/src/exec-with-timeout.ts` + `.test.ts`, `packages/ssh/src/
  commands/allowlist.ts`, `packages/ssh/src/commands/docker.ts`, `packages/ssh/src/error-
  classifier.ts`, `.planning/PROJECT.md`, `.planning/MILESTONES.md`, `.planning/STATE.md`
  ("Deferred Items"), `docs/releases/v0.1-gate.md`, `docs/ui-build-prompt.md`, `.claude/skills/
  noodara-security/SKILL.md`, `docs/roadmap-v0.1-v0.5.md` §7, `tests/unit/docs/install-docs-
  accuracy.test.ts`, `tests/integration/helpers/installer-dind.ts`, `docker-compose.yml`'s known
  debt notes (Redis password argv, no `logging:` config, `.env.bak-*` accumulation) — HIGH
  confidence, verified by direct read.
- [Docker Build Secrets Guide: Secure Container Image Development — DataCamp](https://www.datacamp.com/tutorial/docker-build-secrets-guide) — MEDIUM confidence, external verification of BuildKit `--secret` mount vs. `--build-arg` leak behavior.
- [Build secrets — Docker official docs](https://docs.docker.com/build/building/secrets.md) — MEDIUM confidence, official source for BuildKit secret-mount availability (default since Docker 23.0+).
- [Don't leak your Docker image's build secrets — pythonspeed.com](https://pythonspeed.com/articles/docker-build-secrets/) — MEDIUM confidence, independent confirmation of the `--build-arg`/`docker history` leak vector.
- ["box1 is out of disk: every deploy now fails with 'no space left on device' and rolls back" — lekky/landit#452](https://github.com/lekky/landit/issues/452) — MEDIUM confidence, real-world disk-exhaustion-from-failed-deploys incident in this product category.
- ["[Bug]: Orphan error when recreate and opening publicly containers" — coollabsio/coolify#2547](https://github.com/coollabsio/coolify/issues/2547) — MEDIUM confidence, direct precedent for orphaned-resource bugs in a directly comparable PaaS.
- ["[Bug]: Deployment failing due to helper container name being already in use" — coollabsio/coolify#7566](https://github.com/coollabsio/coolify/issues/7566) — MEDIUM confidence, direct precedent for the name-collision pitfall.
- [Git shallow clone: what it is, when to use it, and how — OpenReplay blog](https://blog.openreplay.com/git-shallow-clone/) — MEDIUM confidence, general shallow-clone limitations.
- [Git Submodule Errors: A Complete Troubleshooting Guide — DeployHQ](https://www.deployhq.com/blog/using-submodules-in-deploy) — MEDIUM confidence, submodule/force-push/LFS-vs-submodule deploy pitfalls.

---
*Pitfalls research for: Noodara v0.2 Projects & Services (remote Docker/Git deploy engine + UI
redesign + public docs/landing)*
*Researched: 2026-09-22*
