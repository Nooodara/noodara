# Legacy runtime log secret redaction — phase 33

Phase 33 completed locally on 2026-11-09: regression/canary green, all eight authoritative
33-03 gates PASS, separate independent tier-1 phase PASS recorded, and advance successful.
SEC-01/02/03 and QA-22 complete locally; selected phases26–33 are 8/8 phases and44/44 plans done.
Prerequisite33-04 completed with five authoritative gates PASS (609239a8).
[Final gate/review/cleanup evidence](33-03-closure.md) records the closure; this index is not release approval.
M2 is distributed fixed in stable v0.5.2 (2026-11-10), exact approved source
`3a34f0daa0a045c48039b2edc882d5ba3bf90fba`. [Stable35-01 evidence](../../releases/v0.5.2-gate.md#final-stable-distribution-evidence--2026-11-10)
records Release/Latest, public multiarch artifacts, backup/restore and installed Lima HTTP/H2/auth
with data/BYOK preservation. v0.5.1 remains exposed on the legacy endpoints. This distribution
closure preserves the historical local phase33 closure below and the scoped snapshot/length limits.
No version, release or historical tag changes are part of phase 33.

## Code and tests

- [Scoped authorized opener](../../../apps/control-plane/src/services/legacy-log-redactor.ts)
  re-reads the service and verifies project/environment/server scope before loading secrets.
- [Legacy tail/follow lifecycle](../../../apps/control-plane/src/services/container-logs.ts)
  requires an asynchronous scoped lease before SSH, retaining it through final flush/teardown.
- [Unit regression](../../../apps/control-plane/src/services/container-logs.test.ts),
  [scope tests](../../../apps/control-plane/src/services/legacy-log-redactor.test.ts), and
  [secret-store tests](../../../apps/control-plane/src/secrets/secret-store.test.ts).
- [Real HTTP/encrypted PostgreSQL/SSH regression](../../../tests/integration/deploy-engine/legacy-log-redaction.test.ts),
  [existing runtime integration](../../../tests/integration/deploy-engine/runtime-container-logs.test.ts),
  and [RED/GREEN provenance and results](33-02-integration-evidence.md).
- [Application-secret canary](../../../tests/integration/activity/canary-env-secrets.test.ts)
  is already selected by `pnpm security:scan-leaks`. It deploys through the real API/worker,
  then enables the [fixture's explicit test-only emission hook](../../../fixtures/env-api/server.js).
  A real authenticated HTTP follow with tail=100 receives seeded output and a second live emission; a real
  tail must receive both markers. Exact/base64/URL forms must be absent from both responses,
  API logger/errors, worker/SSH captures, database, SSE, Redis and other existing canary surfaces.
  [Fixture tests](../../../tests/unit/fixtures/official-fixtures.test.ts) execute default and
  opt-in handlers, proving digest-only/no-emission behavior without opt-in.

## Scoped security review evidence

| Concern | Evidence and behavior |
|---|---|
| Authorization and scope | Existing route authorization precedes opening. Real integration proves 401/404 and exact selected secret IDs with poisoned unrelated rows; unit opener rejects stale/changed project/environment/server scope. |
| Fail closed | Real DB/key/decrypt faults return 502 for tail/follow before SSH, followed by successful recovery. Unit tests cover opening rejection, timeout, abort/shutdown, late leases and late rejection. No empty-redactor fallback exists. |
| Lifecycle | Unit tests establish exactly-once release after final flush/session cleanup, reconnect, timeout, callback failure, client abort and unpumped follow. Concurrent leases remain independent. |
| Resource cleanup | Real timeout, cancellation, capacity recovery and container exit prove zero sessions/follow slots/remote docker-logs processes/run directories; integration guards detect labelled container leaks. |
| Compatibility | Existing JSON tail/NDJSON follow, ordinary text/markers, multiline/final partial lines, 400/422 query contracts and 429 cap are covered. No-secret services remain usable; default app wiring stays lazy. |
| Transport and encryption | Authenticated default-app HTTP, AES-GCM encrypted PostgreSQL, real Redis, pinned SSH and dockerd on Ubuntu22.04/24.04. Received real SSH bytes are segmented before the production buffer; no fabricated output. |
| Snapshot limits | Only currently visible authorized secrets at request open, under the existing >=8-character policy (including eligible multiline components). Historical deleted/rotated values and later changes are not loaded. No guarantee for other services' secrets printed by a compromised app. Docker's original raw logs are not scrubbed. |
| No external spend/release | Synthetic ordinary per-run values; no provider calls, real secrets, provider-shaped fixtures, broad allowlists, version/tag changes or release publication. |

## Verification ownership and closure

- 33-01 and 33-02 handoffs retain their focused proofs and authoritative task-gate ownership.
- 33-02 RED6/GREEN30 and final scope2 results have separate sanitized records; provenance is
  explicitly distinguished rather than represented as one identical-tree run.
- 33-03 fixture test: **27/27 pass**. Extended Docker canary: **2/2 PASS**, Ubuntu22.04/24.04,138.07s; [sanitized evidence](33-03-canary-green.txt) and [source hashes](33-03-canary-source-proof.json).
- Authoritative `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`,
  `pnpm test:integration`, `pnpm --filter @noodara/site build`,
  `pnpm audit --audit-level=high`, and `pnpm security:scan-leaks`: **PASS**, unchanged original commands; [exact final output](33-03-authoritative-gates.txt).
- Separate tier-1 phase review: **PASS**, recorded at `2026-11-09T16:10:52.482Z`; phase advance succeeded. SEC-01/02/03 and QA-22 closed locally. See [closure record](33-03-closure.md).

Only after successful regression and canary proof may M2 be called **fixed locally**. Closure
requires all declared gates without skips and the separate independent PASS; distribution
is now proven separately by the stable35-01 evidence linked above. Historical AI hotfix evidence remains at
[the v0.5.1 gate](../../releases/v0.5.1-gate.md) and its gate-log directory; tags are unchanged.

Prerequisite [33-04 port evidence](ports/README.md) and [test port instructions](../../testing/e2e-ports.md)
retain focused28/browser25 and lifecycle proof. Run the unchanged original gates with
`NOODARA_TEST_PORT_OVERRIDE=33992 NOODARA_TEST_UBUNTU=all`
and `NOODARA_E2E_WEB_PORT=33993 NOODARA_E2E_API_PORT=33994` as appropriate.
Both Vitest and Playwright stages of unchanged `pnpm security:scan-leaks` passed in the
authoritative run; retained focused evidence remains separate from that full gate result.
