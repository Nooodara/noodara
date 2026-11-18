# SSH fixture timeouts — closed evidence record (35-03)

Status: **evidence record CLOSED; historical cause INCONCLUSIVE.** Closing this record is
closure of the evidence, not a fix or a waiver of the historical CI failures. Those
failures stay open and remain a distinct 35-02 blocker. Machine-readable index:
[evidence-index.json](evidence-index.json).

## Three separate claims

| Claim | Verdict | Basis |
| --- | --- | --- |
| Cause of the historical CI 42743060357 timeouts | **INCONCLUSIVE** | No discriminating build/start/readiness records exist for that run (see "Evidence absent"). |
| Current cancellation / late-resource gap | **DEMONSTRATED** | Controlled held-build Docker reproducer in `fixture-lifecycle.test.ts` (2 passed, 38.12 s) showed a container could be created after a simulated outer deadline. |
| Repaired cancellation contract | **VERIFIED** (35-04 only) | 35-04 RED/GREEN, actual caller wiring and real Docker lifecycle runs; see [cancellation-repair.md](cancellation-repair.md) and the A5 audit below. |

A successful diagnostic or repair run does not explain the past timeout. No proven
historical cause is required to close this record (explicit user replan); every unknown
below stays open and never becomes PASS.

## Historical CI 42743060357, attempt 1 (retained, A1)

Source documentation commit `b8b1c0422cfce18ecabcc2f4f572a3dcc37c8266`. The final job
snapshot records **12 jobs: 9 success, 3 failure, 0 skipped**, all completed
([ci-jobs.json](ci-jobs.json), [ci-run.json](ci-run.json), counts and the two published
artifact identities in [ci-summary.json](ci-summary.json)). Historical proof 50 is retained
unchanged and is not reinterpreted.

The three failures are recorded as **separate failures, not a proven common cause**:

- **E2E** (job 129588583228): 284 passed, 2 failed (timeouts), 0 skipped. Artifact
  13730449440 has the same SHA-256 as proof 50.
- **Installer** (job 129588583325): 1 file failed / 9 passed; 48 tests passed / 8 skipped.
  The `idempotent-rerun.test.ts` setup build of the Ubuntu 22.04 DinD fixture exceeded its
  300000 ms deadline, and its diagnostic rebuild exceeded 300000 ms as well. This proves the
  build deadline was hit, not its mechanism, and not any link to SSH fixtures.
- **Integration** (job 129588583307): 1 file failed / 107 passed / 3 skipped; 1304 tests
  passed / 13 skipped. `activity/canary-deploy.test.ts:356` `beforeAll` on Ubuntu 22.04
  exceeded 900000 ms. The hook starts several operations and the timeout alone does not
  identify which one was pending. The 3 skipped files are the opt-in `NOODARA_STRESS` suites.

Static jobs are not presented as tests. The installer and integration resource guards
reported green; that establishes neither a cause nor the absence of in-flight builds.

### Evidence absent

- Per-stage build / create / start / published-port / SSH-readiness records for the
  historical run (instrumentation did not exist then).
- Raw build output for the timed-out builds (not retained here, and intentionally never
  copied into evidence).
- The exact resolved base-image ID and platform used by the historical runner.
- Runner resource telemetry (CPU, memory, disk, network, DNS) and Docker daemon logs.

### Hypotheses (none proven)

- Cold base-image pull or layer build latency on hosted AMD64 runners.
- Docker daemon or disk contention on the runner.
- Package-archive / DNS resolution delays during image builds (observed in the later CI
  43043093057, see [cancellation-repair.md](cancellation-repair.md); not observed in
  42743060357).
- A stall in Testcontainers' start/port-inspection loop.

### Limits

Only the records listed in this directory and the retained CI job snapshots were examined.
This record does **not** claim that every possible external record (for example any logs
GitHub may still retain) was exhausted. A new diagnostic run is allowed only for a specified
new question, with a fresh independent prepublication review; none was run for this closure.

## Diagnostic code and test history (A2, honest RED record)

From [diagnostics-results.json](diagnostics-results.json) and
[supervisor-results.json](supervisor-results.json):

| Step | Observed | Classification |
| --- | --- | --- |
| First collector attempt via pnpm | blocked by package-manager download/verification | not a RED; no credit |
| Collector missing export | seen only after temporarily restoring the baseline | **retroactive** RED, not RED-first |
| Stage milestones | 2 failed / 0 passed before implementation | strict RED-first |
| Runtime allowlist | 1 failed / 9 passed before implementation | strict RED-first |
| Startup cleanup events | 1 failed / 5 passed before implementation | strict RED-first |
| Focused GREEN | 16 passed / 0 failed / 0 skipped (2 files) | GREEN |
| Real lifecycle first run | 1 passed / 1 failed: truncated vs full Docker IDs | harness defect, not a behavioral RED |
| Real lifecycle verified | 2 passed / 0 failed / 0 skipped, 38.12 s | gap reproducer |
| Supervisor RED | 9 of 13, then force-kill 1 of 14, owner cap 1 of 15 failed | strict RED-first |
| Supervisor GREEN | 17 passed / 0 failed / 0 skipped | GREEN |

Diagnostics are allowlisted, bounded and monotonic: owner / stage / outcome / elapsed ms /
category only, at most 64 events per fixture, never exception messages, causes, inspect
output, environment, build logs, keys, passwords, cookies or tokens. Ownership IDs and
fixture credentials come from `node:crypto` `randomUUID` (never `Math.random`).

**Overlapping hooks.** Testcontainers' `containerStarting` hook fires only after both
`Docker.start` and its published-port inspection loop. The `container_start` and
`published_port` intervals therefore overlap deliberately; these records cannot attribute
time between Docker start and port inspection independently. Only build, container
creation, start-plus-port, and SSH readiness are measured as distinct stages.

### Regression tests carried by `pnpm test` (35-03)

- `tests/unit/integration-helpers/ssh-diagnostics.test.ts`: allowlist, monotonic time,
  64-event cap, sink isolation, no serialized exception data (unchanged).
- `tests/unit/integration-helpers/ssh-stage-events.test.ts`: H1 matrix added in 35-03.
  Five hostile sinks (throwing, closed stream, backpressured, never-settling, rejecting)
  times four paths: startup failure keeps the primary rejection and reaps the owner; a held
  build completing after cancellation never starts a container; a start succeeding after the
  deadline is reaped and rejects with the cancellation reason; `createSshdLifecycle`
  cancel rejects promptly, joins the late start and reaps. Plus a 100000-event flood that
  stays bounded while startup and cleanup complete. No raw error reaches stdout/stderr.
  These tests characterize behavior already implemented by 35-04, so they were GREEN on
  first run. Their power was shown by transient mutations of `ssh.ts`, then restored
  byte-identically: letting a sink exception escape failed 5 tests; skipping the
  post-deadline reap failed 10 tests.
- `tests/unit/integration-helpers/ssh-diagnostic-supervisor.test.ts`: replaces the
  former `runner-supervisor-process.test.mjs` (retained at `dabdd438`, SHA-256 prefix
  `302a13fe`; the root glob never collected `.mjs`). It runs the real `runner.mjs`
  entrypoint with Docker and the Vitest child replaced at the `node:child_process` import
  boundary. It covers exit 0/7, oversized (>2048 char) line rejection without emitting its
  bytes, multi-MB output without a newline bounded (runner output < 8 KiB), the 140-row cap,
  the two-owner cap, and dropping of non-v4 owners, unknown stages/outcomes, out-of-range
  elapsed values, foreign contexts and extra fields. Five transient mutations of
  `runner.mjs` (line cap, row cap, owner cap, raw fallback, unfiltered emit) each failed at
  least one test; the file was restored and its hash re-verified.
- `tests/unit/integration-helpers/ssh-fixture-timeouts-hygiene.test.ts`: no home paths,
  IPs, host or user names, tokens or full UUIDs anywhere in this directory, and the archived
  runner files keep their frozen hashes.

No HTTP endpoint or request handler is introduced by any of this.

## Archived observations (A3)

**Local isolated BuildKit** ([local-measurements.json](local-measurements.json)): Docker
29.8.1, Linux ARM64, a fresh BuildKit namespace (owner prefix `586ed50e`) with no cache
import, unchanged Dockerfiles and build arguments. Ubuntu 24.04 cold 15.653 s / warm
2.068 s; Ubuntu 22.04 cold 18.627 s / warm 2.383 s. Each image started, published its port
and reached the original SSH marker; create/start/port were separate Docker commands. All
owned containers, images and the builder were removed without any global prune. A first
24.04 attempt (19.795 s) ended on a harness unpack error after the build; its namespace was
removed and the measurement repeated; no lifecycle is credited to it.

**Real Linux AMD64 runner, legacy fixture** ([runner-observations.json](runner-observations.json)):
diagnostic commit `dabdd438463b876cce4702f524fbdac21aa90e30` (child of `b8b1c042`), run
42884716047 attempt 1, **2 jobs, both success**, published only to a task branch after
independent review; no rerun, no artifact upload. Docker 29.4.2; the second fixture call
reused that runner's build cache; each supervisor boundary suite 17 passed / 0 / 0.

| Ubuntu | Cold build | Warm build | Cold SSH ready, total | Warm SSH ready, total |
| --- | ---: | ---: | ---: | ---: |
| 22.04 | 21.521 s | 0.094 s | 22.265 s | 0.991 s |
| 24.04 | 30.197 s | 0.159 s | 31.110 s | 1.171 s |

All four calls finished well before the historical 60 s / 180 s deadlines; all four owned
containers were inventoried absent and all four owned image tags removed.

**Limitation.** Base-image manifest digests were observed separately and are mutable; they
are **not** the exact resolved historical platform/base-image ID, which is unavailable and is
not reconstructed. No equivalence is asserted between cold and warm, ARM64 and AMD64, or
BuildKit and the legacy build API.

## 35-04 repair audit (A5)

Recorded 35-04 source hashes are in `sourceSha256` of
[cancellation-repair-results.json](cancellation-repair-results.json); 35-04 closed with its
nine authoritative root gates PASS at `784ca1b6`. Later commits (phase 36 fixture reuse and
`ad14d854` dist-free fix) changed `ssh.ts`, `test-resources.ts`, `fixture-lifecycle.test.ts`,
`stack.ts` and `ssh-playwright-cancellation.test.ts`; `evidence-index.json` maps both the
recorded and the current committed hashes. The proof is carried by these tests:

| Required proof | Test(s) |
| --- | --- |
| Build / start / readiness failure keeps the primary error and verifies cleanup | `ssh-cancellation.test.ts` "preserves %s rejection and verifies cleanup" |
| Deadline / cancellation at every stage | `ssh-cancellation.test.ts` "SSH cancellation ownership Ubuntu %s" (build, create, start, ports, readiness, return); `ssh-playwright-cancellation.test.ts` actual Playwright outer timeout |
| Late success ownership and reaping | `fixture-lifecycle.test.ts` "reaps an actual late start handle after cancellation..."; `ssh-test-scope.test.ts` A3 cases; `ssh-stage-events.test.ts` H1 late-start cases |
| Primary plus cleanup failures | `ssh-cancellation.test.ts` "reports %s failure without exception details..."; `ssh-stage-events.test.ts` "records bounded cleanup failure..." |
| Repeated stop | `ssh-cancellation.test.ts` "keeps repeated failed stop rejected..."; `fixture-lifecycle.test.ts` "stops twice" |
| Foreign-resource survival | `fixture-lifecycle.test.ts` foreign listener / foreign container / concurrent owner; `ssh-test-scope.test.ts` H1 owner scoping |

35-04 RED/GREEN: original cancellation RED 2 failed / 6 passed; cache-preservation RED
24 passed / 1 failed; real Docker lifecycle 8 passed / 0 / 0 (331.57 s, 22.04 and 24.04);
budget-extension regression RED 1 / 1; dist-free unit RED from CI 43043093057 (2 failures).
Unrelated installer/integration failures do not falsify that isolated proof and remain a
distinct 35-02 blocker.

## Sanitization (A6)

Before publication of this record, committed evidence was sanitized in place: full UUIDs
were reduced to their 8-hex prefix (no prefix collision in any file), contributor home paths
became `<repo>`, the user Docker socket `<user-docker-socket>`, and the loopback address
`<loopback>`. Pre/post SHA-256 values are in `evidence-index.json`. Only identifiers changed;
no counts, timings, outcomes or hashes of source files were altered.

## Reserved for 35-02

REL-05, whole-CI and site acceptance, and the final independent phase 35 verdict. No
product, runtime or installer repair, tag move, same-version rebuild, UAT/provider call or
blanket rerun is part of this record.
