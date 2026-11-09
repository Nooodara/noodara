# Phase 33 — Legacy runtime log secret redaction

Status: independently hardened, not implemented. Requirements: SEC-01, SEC-02, SEC-03.

## Objective

Close security finding M2 for `GET /api/projects/:projectId/services/:serviceId/logs`
and `/logs/follow`. Both endpoints must redact the application's registered secrets
before any output reaches HTTP, using the same scoped secret lease as unified logs.
Failure to open that lease must prevent log output. Preserve the existing response
contracts and bounded remote-process cleanup.

## Confirmed context

- `apps/control-plane/src/services/container-logs.ts` creates a bare redactor for
  both tail and follow. `app.ts` supplies `createRedactor`; no application-secret
  lookup occurs. Structural patterns alone cannot protect ordinary secret values.
- `observability/logs/log-sources.ts` already provides `findLogService` and
  `openServiceRedactor`, including project/environment/service scope and an
  idempotent release. Reuse this boundary rather than duplicating decryption.
- `routes/services.ts` already authenticates and checks project ownership before
  opening logs. Tail is bounded JSON; follow is bounded NDJSON, not global SSE.
- Follow may reconnect during remote kill confirmation. Its redactor must remain
  usable through that cleanup and the final SSH flush, not just the last HTTP write.
- Existing unit tests and `runtime-container-logs.test.ts` cover ordering, limits,
  remote cleanup and cancellation. The latter intentionally has no database and
  cannot alone prove production secret loading.
- `observability/logs-api.test.ts` demonstrates the real PostgreSQL plus SSH/Docker
  test pattern. `security:scan-leaks` already includes `canary-env-secrets.test.ts`.
- v0.5.1 and phase 32 are complete. This distinct legacy gap remains open in
  `docs/security/v0.5-review.md`; planning does not resolve it.

## Scope and assumptions

Use an asynchronous service-scoped redactor lease in the legacy reader, opened
inside the protected operation and held until its full cleanup. The exact helper
shape belongs to implementation; optional insecure production fallbacks are not
acceptable. `legacy-log-redactor.ts` and its unit test are reserved scope if a
small service lookup/wiring helper is needed. Preserve lazy application startup.

Keep the existing policy: currently visible secret-store values of at least
`MIN_REDACTABLE_SECRET_LENGTH` (8 characters) plus the shared structural patterns.
The lease is a request-open snapshot. Historical deleted/replaced values, secrets
created or rotated after opening, ordinary plaintext environment variables and
other services' secrets are not promised coverage by this phase. Record these
limits explicitly; changing this policy needs separately scoped work.

Assumptions: the current service row remains the authority for its scope chain,
and existing bounded request-open behavior is retained. Tests must challenge
missing/deleted/mismatched service references rather than trust caller-supplied
scope identifiers. Existing service/project checks must precede secret access.

There are no schema migrations, new environment variables or UI flows planned.
No release version, tag or publication task is included. Existing published tags
and historical release evidence stay intact.

## Tasks

1. **33-01 — Core, production wiring and unit regressions.** Record RED against
   the empty-redactor implementation, replace it with the scoped lease, preserve
   lazy startup and closed error codes. Verify exactly-once release for every
   tail/open/pump/teardown failure and normal end, including cancellation during
   open, shutdown of an unpumped follow, callback failure and reconnect. Preserve
   independent concurrent leases and existing wire contracts, ordering and caps.
2. **33-02 — Real integration proof.** New
   `tests/integration/deploy-engine/legacy-log-redaction.test.ts` exercises the
   default application resolver over HTTP, real encrypted PostgreSQL rows, SSH
   and Docker on Ubuntu 22.04 and 24.04. Prove scope, exact/encoded/split/final-line
   redaction, fail-closed opening, authorization and cleanup. Do not substitute
   an injected log reader or test-only preregistration for production wiring.
   Save bounded sanitized RED/GREEN evidence under
   `docs/security/legacy-runtime-log-redaction/`.
3. **33-03 — Canary and security closure.** Extend the existing application-secret
   canary to exercise both legacy endpoints when the app deliberately prints a
   synthetic secret. If `fixtures/env-api` needs an emission hook, require explicit
   test opt-in and retain/test its default digest-only behavior. Complete full
   verification, document the M2 fix and limitations, and obtain an independent
   tier-1 PASS before advancing the phase. Mark a successful change as fixed
   locally; do not claim it is distributed without a later release.

The independent hardening pass added three criteria: 33-01 H1 bounds stalled
lookup/key/lease opening, including late success/rejection after abort or shutdown;
33-01 H2 rejects service disappearance or changed scope between authorization and
opening; 33-02 H1 proves multiline secret redaction across CRLF and final partial
lines. The existing `leaseSecrets` registers a whole value, while SSH delivery is
line-oriented: 33-01 therefore explicitly includes `secret-store.ts` and its unit
tests if shared lease registration/release needs adjustment. Preserve the existing
minimum-length rule, exact lifetime/reference accounting and shared consumers;
33-02 must not need an out-of-scope production fix to satisfy its multiline test.

Full scoped acceptance criteria and gates live in `.agent-flow/plan.json`.
Waves are sequential (1 → 2 → 3); overlapping production/test scopes cannot run
in parallel. Every task is deep because it handles secret lifetimes or security
proof. The final phase review is independent of the executor.

## Risks and checks

- A lease opened outside a protected block, or released before teardown, can leak
  registrations or plaintext. Instrument release count and resource counts in
  unit tests; check real remote processes/directories after follow timeout/abort.
- An empty-redactor fallback on DB/key failure reintroduces M2. Expect the existing
  fixed `RUNTIME_LOGS_FAILED`/502 before any remote log output; never echo exception
  text. A service with no applicable secrets remains a valid successful case.
- Scope resolution can be wrong even with successful redaction. Test the actual
  project/environment/service selection and unrelated rows separately from output.
- Fake sessions may bypass SSH redaction and miss packet boundaries. Keep unit
  lifecycle proof separate from real SSH output/canary proof.
- Fixtures must not print real credentials. Use ordinary random synthetic canaries
  rather than provider-shaped tokens, keep evidence sanitized and avoid new broad
  gitleaks allowlists. Preserve scan coverage and assertion strength.
- Existing integration gates require Docker, available test ports and bounded
  teardown. Use supported test-port overrides when necessary; never kill unrelated
  processes or prune host Docker resources.

## Verification

Planning checks: `agent-flow plan validate`, `agent-flow plan render`, and
`git diff --check`. No implementation tests are claimed by planning.

Implementation gates:

- 33-01: `test`, `typecheck`, `lint`, `boundaries`, `build`.
- 33-02: `test`, `typecheck`, `lint`, `it-legacy-log-redaction`, `it-logs`.
- 33-03: `test`, `typecheck`, `lint`, `boundaries`, `it-full`, `site-build`,
  `audit`, `security-leaks`; then independent phase review.

The new gate is registered now so strict execution cannot silently skip it:

```sh
NOODARA_TEST_UBUNTU=all pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/legacy-log-redaction.test.ts tests/integration/deploy-engine/runtime-container-logs.test.ts
```

The first test file is an implementation deliverable; this command is not expected
to pass before 33-02 exists. Full `it-full` also checks unified logs alongside
legacy behavior. No external AI provider call is needed.

Pitfall-pack waivers for this phase are narrow: GET body caps do not apply because
these handlers consume only existing validated path/query schemas; no request body
is introduced. Atomic file writes and missing-file startup checks do not apply to
33-01 because it adds no persistence or files (lazy startup is explicitly tested).
33-02 adds tests, not a user URL-fetch surface. 33-03 adds canary/docs work, not
production HTTP input handling. Existing query validation and URL policy remain
covered by the unchanged contracts and regression tests. The multiline criterion makes
the deterministic matcher also flag persistence on 33-02. Its PostgreSQL writes
are isolated test-fixture setup through existing storage APIs, with unique fixture
IDs and bounded teardown; it introduces no production write path, shared writable
file or startup file. Atomic-write, concurrent-write and missing-file-boot pack
checks are consciously waived for that test-only task; real DB behavior remains
part of its integration acceptance.

## Continuity

Append concise planning/completion events to `.memory/events.jsonl`; update
requirements, STATE and the M2 review status only as evidence supports them.
Do not edit prior memory entries, reopen phase 32 or mark SEC requirements complete
while only planned. Leave unrelated SSH collector/UI backlog outside this phase.

Recommended next commands:

```text
/flow-harden
/flow-orchestrate
```

Implementation clarification (33-02): existing RUNTIME_LOG_TAIL_INVALID maps to
HTTP422, confirmed by the current runtime regression. The earlier invalid-tail400
wording was a planning mistake; A3 now requires numeric-tail422 and a separate
malformed-query400 case, preserving the existing response contract.

## Alternate-port prerequisite amendment

User requested safe alternate Playwright ports after the existing listener3000
blocked the exact33-03 gate. Add33-04 at wave3 before pending33-03 at wave4;
33-01/33-02 remain done and33-03 WIP/evidence is preserved.
See `33-playwright-alternate-ports.md` for QA-22, scopes, acceptance and exact
verification. The original33-03 gate list and required independent phase review
remain unchanged. Implementation of this prerequisite has not started.
