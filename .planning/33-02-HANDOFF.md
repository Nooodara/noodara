# 33-02 executor handoff

Implementation/evidence are ready for orchestrator gates and independent review. No commit or
advance performed. No production source changed; pre-existing artifacts/processes preserved.

## Changed paths

- `tests/integration/deploy-engine/legacy-log-redaction.test.ts`: real authenticated HTTP through
  the default `buildApp` container-log resolver; encrypted migrated PostgreSQL and real Redis;
  pinned real SSH+dockerd on Ubuntu22.04/24.04. No injected `containerLogs`, test redactor or
  application-secret preregistration. Real received SSH channel data is segmented into seven-byte
  events to guarantee secret splits before the production line buffer, with an observed counter.
- `docs/security/legacy-runtime-log-redaction/`: compact sanitized RED/GREEN evidence, baseline
  source/test hash provenance, runner explanation and coverage/limitations.
- `.planning/STATE.md`: 33-01 complete/ad2ab5b8 with authoritative five-gate PASS; 33-02 active;
  phase/M2 still open. `.memory/events.jsonl`: append-only task evidence note; `.memory/errors.jsonl`: module-reset
  private-field identity pitfall and fix.

The `it-legacy-log-redaction` gate is already configured for both files with
`NOODARA_TEST_UBUNTU=all`; no configuration mutation was needed.

## Regression coverage

Project, environment and service ordinary unique secrets and exact/base64/URL forms; ordinary
multiline CRLF secret with eligible components; final unterminated stdout/stderr; readable
ordinary text and markers; zero canary representations in tail, follow, errors and captured
application logs. Exact selected secret IDs plus poisoned sibling-service/staging-environment/
foreign-project envelopes exercise scope selection separately. A no-secret service succeeds.

Both endpoints fail502 before SSH on DB/key/decrypt opening faults and recover afterwards.
Real auth401, wrong-project/missing404, malformed-query400, existing numeric-tail422 and
follow-cap429 have no secret-opening/connection side effects. Real timeout, client cancellation,
capacity recovery and container exit leave no sessions/slots/docker-logs processes/run dirs.
Unit exactly-once lease and reconnect proof remains in 33-01 tests. Startup/teardown budgets
remain bounded and partial PostgreSQL/Redis startup handles are retained.

## Focused evidence

- Actual old baseline `09387d5d`: six selected regressions fail only boolean leak assertions
  across both Ubuntu versions (tail/follow/multiline), 139.88s; no canaries printed. Ten other
  tests were unselected by CLI pattern, not code skips. Source copy and dependency links removed
  after clean teardown. Current production source was never mutated.
- New regression initially passed16/16 on both Ubuntu versions, 150.48s. Existing runtime file
  passed14/14 in the first combined attempt (new fixture then failed on module identity; fixed by
  dynamically importing security after `vi.resetModules`).
- Final combined GREEN: **30/30**, 245.31s, no skips/cleanup failures. Final third-project
  scope refinement: **2/2**, 123.72s (14 CLI-unselected), clean teardown; bounded evidence saved. The third-project poison was added after the recorded RED/test hash
  and combined run started; its separate focused proof is explicit. Assertions/emitted values
  are unchanged. Do not misrepresent provenance as one identical final-tree full-matrix run.
- Focused integration `tsc`, scoped ESLint and `git diff --check`: PASS.

Authoritative `test`, `typecheck`, `lint`, `it-legacy-log-redaction` and `it-logs` belong to the
orchestrator. Use the supported `NOODARA_TEST_PORT_OVERRIDE=33992` if port3000 remains occupied;
leave the existing process alone. Phase33/M2/SEC closure remains pending33-03 and independent
review. Existing secret snapshot/minimum-length limits remain unchanged.
