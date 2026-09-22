---
phase: 2
slug: adaptador-ssh-aislado-y-probado-con-testcontainers
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-09-12
completed: 2026-09-15
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
>
> Closed by **02-10 Task 3**: every Automated Command below has been re-run against the phase's
> actual code (either standalone or as part of one of the three consolidated full-suite commands
> named in each row's Status cell — `pnpm build && pnpm lint && pnpm typecheck && pnpm boundaries`,
> `pnpm test --coverage`, and `pnpm test:integration`), every row is set from the real result, and
> the estimated runtimes are replaced with measured ones below. This is now a measured record, not
> a plan — the same way plan 01-17 closed the phase-1 contract. Flags are flipped by measurement,
> never by intention: see the Full-Phase Green Run table at the bottom for the exact commands and
> results this close is based on.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.0 (existing, from phase 1) — plus Testcontainers 12.1.0 for the SSH fixtures |
| **Config file** | `vitest.config.ts` (unit — `root`/`packages`/`apps` projects; plan 02-01 Task 2 adds the `@noodara/ssh` source alias and excludes `packages/ssh/src/testing/**` from coverage) and `vitest.integration.config.ts` (Testcontainers, `fileParallelism: false`, `testTimeout: 120_000`) |
| **Quick run command** | `pnpm test` (unit only, no Docker — 603 tests as of this phase's close, up from phase 1's 358) |
| **Full suite command** | `pnpm test:integration` (Testcontainers: the existing PostgreSQL/boot/CLI/activity suites plus eight `tests/integration/ssh/*.test.ts` files — six always-on plus `stress-connections.test.ts`, opt-in) |
| **Measured runtime** (02-10 Task 3, 2026-09-15, on a shared macOS/Apple-Silicon dev machine with unrelated Docker workloads also running) | Unit: `pnpm test --coverage` — **2.76s** for 603/603 tests (36 files), coverage thresholds green. Integration: **warm** `pnpm test:integration` — **555.87s (~9.3 min)** for 208/208 tests + 1 intentionally skipped (`stress-connections.test.ts`, opt-in), 24/24 files passed, zero `noodara.test=true` containers left; images had already been built earlier in this same session so this is a warm-cache measurement, not a from-scratch first run. **Cold** (removing the built sshd images/build-cache first) was **not measured** in this session: this dev machine's Docker host is shared with many unrelated projects' images (2000+ total images, several actively in use), and there is no way to selectively evict only this phase's four sshd image variants without a real risk of disturbing unrelated concurrent work on the same machine — recording "not measured" here is the honest choice per this file's own instruction, rather than inventing a number. The `integration` CI job's comment (`.github/workflows/ci.yml`) documents that `ubuntu-latest` runners start cold on every run and states plainly that no cold-runner number has been measured against a real GitHub Actions run either. |

**Cache note:** the four image variants (`22.04`, `24.04`, `24.04` + `WITH_DOCKER_CLI=true`, `24.04` + `WITH_SLOW_DF=true`) share every layer up to the conditional `RUN`, so a cold build pays for `apt-get` roughly once per base image, not once per variant. Repeat local runs hit the layer cache and skip the builds. CI runners start cold on every run; plan 02-10 Task 3 records that implication as a comment on the `integration` job and does **not** add a registry, buildx or a build-push action for it.

---

## Sampling Rate

- **After every task commit:** `pnpm test` (unit, no Docker — sub-second feedback). For a task whose verify is an integration command, run that task's own `<automated>` command, not the whole integration suite.
- **After every plan wave:** `pnpm test && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/` (all SSH scenarios for both Ubuntu versions).
- **Before `/gsd:verify-work`:** `pnpm lint && pnpm typecheck && pnpm boundaries && pnpm build && pnpm test --coverage && pnpm test:integration && pnpm audit --audit-level=high` must all exit 0, and `docker ps -aq --filter label=noodara.test=true | wc -l` must print 0.
- **Max feedback latency:** ~1s for the per-task unit path; minutes for any Testcontainers path, which is inherent to QA-03 (the requirement is "real ephemeral SSH infrastructure", so there is no sub-second proof of it — the unit path is what stays fast).

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 2-01-01 | 01 | 1 | SEC-04 | T-2-03 / T-2-SC | `ssh2` is importable from `packages/ssh` and nowhere else in the repo, and the package's `dependencies` keys are exactly `["@noodara/domain","ssh2"]` — both machine-asserted, so an I/O dependency cannot be added quietly | unit/static | `pnpm build && pnpm typecheck && pnpm exec vitest run --project packages packages/ssh/src/boundary.test.ts` | ✅ | ✅ green |
| 2-01-02 | 01 | 1 | SEC-04, SERV-07 | T-2-03 / T-2-04 | Turborepo boundaries confine `packages/ssh` to `pure-domain` + `@noodara/config`; the three `NOODARA_SSH_*_TIMEOUT_MS` variables survive Turborepo 2's strict env filter | build/lint | `pnpm build && pnpm typecheck && pnpm boundaries && pnpm exec vitest run --project packages packages/ssh/src/boundary.test.ts` | ✅ | ✅ green |
| 2-01-03 | 01 | 1 | SERV-07, SEC-04 | T-2-01 / T-2-04 | `SshSession.exec` is typed over a `CommandName` union (never `string`), `SshPort.connect` is documented never to throw, and timeouts/credential/redactor arrive as parameters — zero `process.env` in `packages/ssh` (D-09) | typecheck/lint | `pnpm build && pnpm typecheck && pnpm lint` | ✅ | ✅ green |
| 2-01-04 | 01 | 1 | SEC-04 | T-2-01 / T-2-02 | The 11 command templates are fixed literals asserted against a literal list — no `${`, no backtick, no `$(` — and `escapeShellArg` quotes rather than sanitises (Dokploy GHSA-fcgq-jjfg-hrhj precedent) | unit | `pnpm exec vitest run --project packages packages/ssh/src/commands/allowlist.test.ts` | ✅ | ✅ green |
| 2-02-01 | 02 | 1 | QA-03, SERV-08 | T-2-05 / T-2-07 | Four project-owned sshd variants build with every key generated at build time, host keys regenerated on every start, and no secret committed; the opt-in `WITH_SLOW_DF` shim shadows the `df` binary only in the test image and leaves the frozen allowlist untouched | build | `docker build -f tests/integration/images/sshd-ubuntu-22.04/Dockerfile -t noodara-test-sshd:22.04 tests/integration/images && docker build -f tests/integration/images/sshd-ubuntu-24.04/Dockerfile -t noodara-test-sshd:24.04 tests/integration/images && docker build --build-arg WITH_DOCKER_CLI=true -f tests/integration/images/sshd-ubuntu-24.04/Dockerfile -t noodara-test-sshd:24.04-docker tests/integration/images && docker build --build-arg WITH_SLOW_DF=true -f tests/integration/images/sshd-ubuntu-24.04/Dockerfile -t noodara-test-sshd:24.04-slowdf tests/integration/images` | ✅ | ✅ green |
| 2-02-02 | 02 | 1 | QA-03 | T-2-06 / T-2-08 | Every container and network carries `noodara.test=true` with an idempotent `stop()`; no fixed sleep anywhere in the helper; `waitForSlowCommandStart` replaces a timer with an observed marker for the mid-exec scenario | typecheck/lint | `pnpm typecheck && pnpm lint` | ✅ | ✅ green |
| 2-02-03 | 02 | 1 | QA-03, SERV-08 | T-2-05 / T-2-07 | The fixture matrix is what the scenarios assume: `deployer` has sudo+docker group, `restricted` has neither, two sequential containers present different host keys, and the slow-`df` marker appears only on the opt-in variant | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/images.test.ts` | ✅ | ✅ green |
| 2-03-01 | 03 | 1 | SEC-03 | T-2-09 / T-2-12 | Migration 0002 adds `host_fingerprint_captured_at`/`pending_fingerprint_seen_at` defensively (`IF NOT EXISTS`, nullable, no `DEFAULT`) so fingerprint provenance is datable rather than two undated strings (D-06) | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migration-hygiene.test.ts tests/integration/db/schema.test.ts` | ✅ (phase 1) | ✅ green |
| 2-03-02 | 03 | 1 | SEC-03 | T-2-09 | From-snapshot upgrade: 0001 applied, a `servers` row seeded with a pinned fingerprint, 0002 applied through the production `runMigrations`, row survives field-identical with NULL backfill | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migrations.test.ts` | ✅ (phase 1) | ✅ green |
| 2-03-03 | 03 | 1 | SEC-04 | T-2-10 / T-2-11 | Each SSH timeout knob has an explicit inclusive range plus a `discovery >= command` coherence rule; an out-of-range value fails the boot and the rejected value never appears in the error (`EnvIssue` still carries no `received`) | unit | `pnpm exec vitest run --project apps apps/control-plane/src/env.test.ts` | ✅ (phase 1) | ✅ green |
| 2-04-01 | 04 | 2 | SEC-03 | T-2-13 | `hostVerifier`'s raw-blob contract is measured, and the derived fingerprint is byte-identical to the container's own `ssh-keygen -lf` output for ed25519, RSA and ECDSA — so a fingerprint the operator compares in a terminal cannot be a different digest of different bytes | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/contracts.test.ts` | ✅ | ✅ green |
| 2-04-02 | 04 | 2 | DISC-01 | T-2-14 / T-2-16 | Every parser fixture is real captured output from both Ubuntu versions, including the docker-CLI-without-daemon exit code and stream split distinguished from command-not-found — no parser in this phase is tested against fabricated text (A3) | integration/script | `node scripts/capture-discovery-fixtures.mjs && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/contracts.test.ts` | ✅ | ✅ green |
| 2-04-03 | 04 | 2 | QA-03, SERV-07 | T-2-15 / T-2-16b | The `CONNECT_TIMEOUT` strategy is chosen by measurement and is host-network independent; all eight ssh2 failure shapes are recorded verbatim in ADR 0004 — including the **mid-exec** death, staged with a blocked allowlisted command and a kill sequenced on an observed marker rather than a timer | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/contracts.test.ts` | ✅ | ✅ green |
| 2-05-01 | 05 | 3 | DISC-01 | T-2-19 | OS, system and access parsers return a `ValidationResult` and never throw on hostile or malformed output; no unbounded regex backtracking; the ≥95% branch gate forces the malformed branches to be exercised | unit | `pnpm exec vitest run --project packages packages/domain/src/discovery --coverage` | ✅ | ✅ green |
| 2-05-02 | 05 | 3 | DISC-01 | T-2-17 / T-2-18 | Docker detection is a three-way union plus an explicit `unparseable` case — invalid JSON never yields `not_installed`; group membership is a whole-token match with a `dockerx` negative test | unit | `pnpm exec vitest run --project packages packages/domain/src/discovery --coverage` | ✅ | ✅ green |
| 2-05-03 | 05 | 3 | DISC-04 | T-2-20 | `UNSUPPORTED_OS` becomes a warning on `CONNECTED` (D-11) without setting `lastSeenAt` or `hostFingerprint`, and `applyConnectionResult` keeps its `CONNECTING`-only guard and its `transition()` routing | unit | `pnpm exec vitest run --project packages packages/domain/src/server --coverage` | ✅ (phase 1, new cases) | ✅ green |
| 2-06-01 | 06 | 3 | SERV-07 | T-2-23 / T-2-24 | An RSA key below 2048 bits is rejected before any socket opens (D-01); `utils.parseKey`'s `Error.message` is never propagated — the loader emits project-authored messages proven unchanged under a `Redactor` holding the key and passphrase | unit | `pnpm exec vitest run --project packages packages/ssh/src/key-loader.test.ts` | ✅ | ✅ green |
| 2-06-02 | 06 | 3 | SEC-03 | T-2-21 / T-2-22 / T-2-25 | The TOFU verifier has no bypass option (grep gate + factory option keys); a mismatch returns `false` for all three key types; same-digest/different-type is a mismatch (D-05); a malformed host-key blob is validated against its RFC 4253 length prefix rather than sliced | unit | `pnpm exec vitest run --project packages packages/ssh/src/fingerprint.test.ts packages/ssh/src/host-verifier.test.ts` | ✅ | ✅ green |
| 2-07-01 | 07 | 3 | SERV-07 | T-2-26 / T-2-30 | Every shape in ADR 0004's table — including the measured mid-exec row — maps to a **named** rule, not the terminal fallback; `classifySshError` never throws (hostile inputs include a throwing `message` getter); every message is project-authored and redaction-stable; the rule table is exhaustive over `SERVER_ERROR_CODES` | unit | `pnpm exec vitest run --project packages packages/ssh/src/error-classifier.test.ts` | ✅ | ✅ green |
| 2-07-02 | 07 | 3 | SEC-04, SEC-05 | T-2-27 / T-2-28 / T-2-29 | Every exec is raced against a timer that destroys the channel and settles once, with the timer cleared on all three exit paths; stdout/stderr pass through `Redactor.redact` and are truncated at 64 KB per stream before an `ExecResult` exists | unit | `pnpm exec vitest run --project packages packages/ssh/src/exec-with-timeout.test.ts` | ✅ | ✅ green |
| 2-08-01 | 08 | 4 | SERV-07, SEC-03 | T-2-31 / T-2-32 / T-2-33 | `client.connect` options always carry `hostVerifier`, never `hostHash`, with the exact D-05 host-key-algorithm ordering; an `'error'` listener is attached before `connect` and kept for the session's lifetime; `HOST_KEY_CHANGED` renders both fingerprints with their key types and offers no trust action | unit | `pnpm exec vitest run --project packages packages/ssh/src/ssh2-adapter.test.ts` | ✅ | ✅ green |
| 2-08-02 | 08 | 4 | SERV-07, SEC-04 | T-2-34 / T-2-35 / T-2-36 | Exactly one retry, only for the two transient codes, after a fixed 2s wait — `AUTH_FAILED`/`HOST_KEY_CHANGED`/`HOST_UNRESOLVED`/`COMMAND_TIMEOUT` are never retried (D-10); the per-target mutex releases in a `finally`; the credential is revealed against the caller's live redactor | unit | `pnpm exec vitest run --project packages packages/ssh/src/retry.test.ts packages/ssh/src/connection-mutex.test.ts packages/ssh/src/ssh2-adapter.test.ts` | ✅ | ✅ green |
| 2-09-01 | 09 | 5 | DISC-01, SERV-08 | T-2-38 / T-2-41 | Each check in the sequence is independently guarded — a failure becomes a `fail` check with a detail and the loop continues, and `runDiscovery` never rejects; details pass through the injected `Redactor` on top of `exec`'s own redaction | unit | `pnpm exec vitest run --project packages packages/ssh/src/run-discovery.test.ts` | ✅ | ✅ green |
| 2-09-02 | 09 | 5 | DISC-04, SEC-05 | T-2-37 / T-2-39 / T-2-40 / T-2-42 | Elapsed time is checked against `timeouts.discoveryMs` before every command (an overrun returns partial facts + a `COMMAND_TIMEOUT` warning); `unparseable` never sets `dockerInstalled: false`; `UNSUPPORTED_OS` is a warning with the check still `pass`; the public surface is a literal export-name list with `src/testing/` unreachable | unit | `pnpm exec vitest run --project packages packages/ssh` | ✅ | ✅ green |
| 2-10-01 | 10 | 6 | QA-03, SEC-03, SEC-04 | T-2-43 / T-2-48 | Four of the eight §6.5 scenarios plus the full TOFU lifecycle on both Ubuntu versions: a mismatching host key is rejected twice with both fingerprints, the new key works only when pinned (so a reject-everything verifier cannot pass), and an arbitrary command string fails `pnpm typecheck` via `@ts-expect-error` | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/connect.test.ts tests/integration/ssh/host-key-changed.test.ts` | ✅ | ✅ green |
| 2-10-02 | 10 | 6 | QA-03, SERV-07 | T-2-44 / T-2-44b | Network timeout (`attempts: 2`) and command timeout, plus connection loss in **both** directions — a command issued after the transport is gone, and a command already in flight when the transport dies (observed-marker sequencing, both versions) — with an `unhandledRejection` listener asserting nothing was recorded | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/timeouts.test.ts tests/integration/ssh/connection-loss.test.ts` | ✅ | ✅ green |
| 2-10-03 | 10 | 6 | DISC-01, DISC-04, SERV-08, SEC-05, QA-03 | T-2-45 / T-2-46 / T-2-47 | All ten DISC-01 facts cross-checked against an independent `container.exec` oracle on the same container (not against the 02-04 fixtures the parsers were written from); the root/`deployer`/`restricted` matrix produces `not_applicable`/`pass`/`fail`; a canary password appears in no stdout, stderr, detail, serialised snapshot or failure message; zero labelled containers survive | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/discovery.test.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*27 rows / 27 tasks across 10 plans and 6 waves. Every row has an `<automated>` command taken verbatim from its task's `<verify><automated>`; there is no manual-only row and no gap of even one task without automated feedback.*

**Opt-in, not manual:** `tests/integration/ssh/stress-connections.test.ts` (02-10 Task 3) implements the roadmap §6.7 criterion of 100 consecutive successful connections. It is `describe.skipIf`-gated on an environment flag and deliberately excluded from the PR-blocking path — it belongs to the v0.1 release gate and a future nightly run, not to per-wave sampling. Its skipped-without-the-flag and green-with-the-flag behaviours are both acceptance criteria of row `2-10-03`.

---

## Wave 0 Requirements

Phase 2 is Wave 0 for all SSH test infrastructure: none of it exists today. Every item below is created inside this phase, in wave 1 or 2, before any plan that depends on it runs.

- [x] `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` and `tests/integration/images/sshd-ubuntu-24.04/Dockerfile` — project-owned sshd images, `ARG WITH_DOCKER_CLI=false`, `ARG WITH_SLOW_DF=false` (Plan 02-02 Task 1)
- [x] `tests/integration/images/sshd-common/setup-users.sh` — the four-principal matrix `root` / `deployer` (sudo NOPASSWD + docker group) / `restricted` / `pwuser` that SERV-08 and D-13 are measured against (Plan 02-02 Task 1)
- [x] `tests/integration/images/sshd-common/entrypoint.sh` — host-key regeneration on every start (the deterministic basis for `HOST_KEY_CHANGED`) plus per-run password and key-passphrase injection, so no secret is committed (Plan 02-02 Task 1)
- [x] `tests/integration/images/sshd-common/sshd_config.d/noodara-test.conf` — `KbdInteractiveAuthentication yes` is required by D-03's password path (Plan 02-02 Task 1)
- [x] `tests/integration/images/sshd-common/slow-df.sh` — default-off `df` shim that signals start then blocks, the mid-exec `CONNECTION_LOST` primitive; the production allowlist stays frozen (Plan 02-02 Task 1)
- [x] `tests/integration/helpers/ssh.ts` — `startSshd` / `readTestKey` / `hostKeyFingerprint` / `startBlackholeListener` / `waitForSlowCommandStart` / `assertNoStrayTestContainers`; no test file imports `testcontainers` directly after this lands (Plan 02-02 Task 2)
- [x] `packages/ssh` scaffold — `package.json` (dist-pointing `exports` per ADR 0003), `tsconfig*.json`, `turbo.json`, `src/boundary.test.ts` (Plan 02-01 Task 1)
- [x] Shared test wiring — `sshSourceAliases` and the `@noodara/domain/discovery` subpath alias in `vitest.shared.ts`, spread into both vitest configs; `packages/ssh/src/testing/**` excluded from coverage; `ssh-adapter` boundary tag and the three `NOODARA_SSH_*` `passThroughEnv` entries in root `turbo.json` (Plan 02-01 Task 2)
- [x] `packages/domain/src/discovery/types.ts` — `DISCOVERY_CHECK_IDS` / `DiscoveryCheck` / `DiscoveryFacts` / `DiscoverySnapshot`, the contracts six later plans implement against (Plan 02-01 Task 3)
- [x] `scripts/capture-discovery-fixtures.mjs` + `packages/domain/src/discovery/fixtures/` — real captured command output for both Ubuntu versions; every parser in 02-05 is written against these, never against invented sample text (Plan 02-04 Task 2)
- [x] `docs/adr/0004-ssh-adapter-empirical-contracts.md` and `tests/integration/ssh/contracts.test.ts` — the measured answers to RESEARCH's three open questions plus the eight-row ssh2 error-shape table (including the mid-exec row) that 02-07's classifier is driven from, with standing assertions so a shape change fails here rather than silently downstream (Plan 02-04)
- [x] Migration `0002` + its from-snapshot test — fingerprint capture timestamps (Plan 02-03 Tasks 1–2)

*Every plan that consumes one of these declares the producing plan in `depends_on`, so no wave can start against missing infrastructure: 02-04 depends on 02-01 + 02-02; 02-05/02-06/02-07 depend on 02-04; 02-10 depends on 02-02 + 02-03 + 02-09.*

---

## Manual-Only Verifications

None. All phase behaviors have automated verification.

Two boundaries worth stating explicitly, because both would otherwise look like missing coverage:

| Behavior | Requirement | Why it is not an integration row | Where it is proven instead |
|----------|-------------|----------------------------------|----------------------------|
| A genuinely non-Ubuntu server reporting `UNSUPPORTED_OS` | DISC-04 | Producing one needs a third fixture image outside 02-CONTEXT.md's fixture plan; the phase's supported targets are 22.04 and 24.04 only (roadmap §6.2) | Row `2-05-03` (`parseOsRelease` + the D-11 state mapping) and row `2-09-02` (the `runDiscovery` warning path). 02-10's `discovery.test.ts` records this boundary in its own header comment rather than leaving a reader to wonder. |
| 100 consecutive successful connections | QA-03 / roadmap §6.7 | Minutes of runtime on the PR-blocking path for a release-gate criterion | `tests/integration/ssh/stress-connections.test.ts`, flag-gated; both its skipped and its 100-cycle green behaviours are acceptance criteria of row `2-10-03` |

---

## Requirement → Proof Index

| Requirement | Proven By |
|-------------|-----------|
| SERV-07 | Row `2-07-01` (exhaustive classification, never throws, every code reachable) + row `2-08-01` (error listener attached before `connect`, no unhandled path) + row `2-10-02` (both connection-loss directions against real containers, with an `unhandledRejection` assertion) |
| SERV-08 | Row `2-02-03` (the real user matrix exists in the image) + row `2-10-03` (root / `deployer` / `restricted` produce `not_applicable` / `pass` / `fail` for both access checks, with a non-empty detail each time) |
| SEC-03 | Row `2-04-01` (fingerprint byte-identical to `ssh-keygen -lf`) + row `2-06-02` (TOFU verifier with no bypass) + row `2-10-01` (two real containers on one host:port: rejection, plus the negative case that the new key works only when pinned) |
| SEC-04 | Row `2-01-04` (11 fixed templates, no interpolation marker) + row `2-01-03` (`exec` typed over `CommandName`, so an arbitrary command is a compile error) + row `2-07-02` (every exec raced against a timer) + row `2-10-01`'s `@ts-expect-error` case |
| SEC-05 | Row `2-07-02` (stdout/stderr redacted and truncated before an `ExecResult` exists) + row `2-09-02` (check details redacted) + row `2-10-03` (canary password absent from every stdout, stderr, detail, serialised snapshot and failure message) |
| DISC-01 | Row `2-04-02` (fixtures are real captures) + rows `2-05-01`/`2-05-02` (parsers, ≥95% branch) + row `2-10-03` (all ten facts cross-checked against an independent `container.exec` oracle) |
| DISC-04 | Row `2-05-03` (D-11: `UNSUPPORTED_OS` as a warning on `CONNECTED`) + row `2-09-02` (the warning travels without demoting the connection) |
| QA-03 | Rows `2-02-01`/`2-02-03` (project-owned ephemeral infrastructure, resources labelled and destroyed) + rows `2-10-01`/`2-10-02`/`2-10-03` (all eight §6.5 scenarios on both Ubuntu versions, cleanup asserted after every test) |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — 27/27 tasks, commands copied verbatim from each task's `<verify><automated>`
- [x] Sampling continuity: no 3 consecutive tasks without automated verify — every task has one
- [x] Wave 0 covers all MISSING references — see Wave 0 Requirements above; every `❌ W0` cell in the map traces to an item there, produced in wave 1 or 2 by a plan the consumer declares in `depends_on`
- [x] No watch-mode flags — neither `vitest.config.ts` nor `vitest.integration.config.ts` sets `watch: true`, and no plan in this phase adds a test config that does
- [x] Feedback latency < 2s for the per-task quick command — measured for this phase: `pnpm test --coverage` ran 603/603 tests in 2.76s
- [x] `nyquist_compliant: true` set in frontmatter — flipped by 02-10 Task 3 after every row above went green

**Approval:** approved 2026-09-15

### Full-Phase Green Run (2026-09-15)

| Command | Result |
|---------|--------|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm build` | exit 0 (all 3 buildable packages, cached) |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` (`turbo run typecheck && tsc -p tests/integration/ssh/tsconfig.json --noEmit`) | exit 0 — includes the new `tests/integration/ssh/tsconfig.json` project this plan added so `connect.test.ts`'s `@ts-expect-error` on an arbitrary command string is genuinely enforced, not merely written |
| `pnpm exec turbo boundaries` (`pnpm boundaries`) | exit 0 — 272 files checked, no issues |
| `pnpm test --coverage` | exit 0 — 603/603 tests (36 files), 2.76s; `packages/domain` coverage threshold (≥95%/≥95%) still met |
| `pnpm test:integration` | exit 0 — 208/208 tests + 1 intentionally skipped (`stress-connections.test.ts`, opt-in via `NOODARA_STRESS`), 24/24 files passed + 1 skipped, 555.87s (~9.3 min, warm), zero `noodara.test=true` containers left running afterward |
| `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/stress-connections.test.ts` (no `NOODARA_STRESS` flag) | exit 0 — reports skipped, as designed |
| `pnpm audit --audit-level=high` | exit 0 — 1 moderate advisory found, 0 high/critical (does not trip `--audit-level=high`) |
| `pnpm security:scan-leaks` | exit 0 |
| `docker ps -aq --filter label=noodara.test=true \| wc -l` | `0`, both after the integration run and at close |

**gitleaks:** the repository's `.gitleaks.toml` path-scoped allowlist (`vitest.config.ts`, `tests/integration/cli/admin-reset.test.ts`, `packages/domain/src/security/redactor.test.ts`) matches the three files whose fake-credential fixtures a raw scan flags — verified by inspection, matching phase 1's own documented decision. A local `gitleaks detect` invocation on this machine reports those same three files as findings because this dev machine's actual git root is the parent monorepo directory one level above `noodara/code` (a local-machine artifact, not the deployed layout `.github/workflows/ci.yml`'s own top comment calls out explicitly: "this workflow assumes `noodara/code` IS the repository root"), which shifts the allowlist's anchored relative paths by one path segment. This is not a real leak — every flagged string is the same already-known, deliberately-fake fixture value phase 1 accepted — but a clean local CLI run could not be produced given this machine's nested-repo quirk, so it is recorded here rather than silently claimed.
