# Phase 33-02 integration evidence

The regression exercises real authenticated HTTP through `buildApp()`'s default legacy
container-log resolver, a migrated PostgreSQL database containing AES-GCM encrypted project,
environment and service secrets, and pinned SSH to the Ubuntu sshd+dockerd fixture. It does
not inject `containerLogs` or register application canaries in a test redactor.

The SSH factory instrumentation delegates to the real adapter and real ssh2 client. It
re-segments received real channel bytes into seven-byte `data` events before the production
line buffer sees them. A counter confirms that an actual secret crossed those events. No
output is fabricated. Both stdout and stderr retain readable ordinary text and redaction
markers. Canary assertions use booleans so a failing assertion never prints a synthetic value.

Coverage includes ordinary unique application values and exact/base64/URL forms; an ordinary
CRLF multiline value with two eligible lines; final unterminated stdout and stderr; tail JSON
and follow NDJSON; and captured application logs. A separate scope test asserts the exact IDs
handed to the real decryptor, with malformed unrelated project/environment/service envelopes
that would fail if included. A service with no applicable secrets still reads its container.

Opening failure tests temporarily rename the real secret table, invalidate the loaded master
key, or corrupt a stored envelope. Both endpoints return 502 before any SSH connection; each
failure is followed by a successful valid request. Auth401, wrong-project/missing-service404,
malformed-query400, numeric-tail422 and follow-limit429 preserve existing contracts and do
not open secrets or SSH. Timeout and client abort must leave zero tracked sessions, follow
slots, remote `docker logs` processes or run directories. Unit lease/reconnect lifetime proof
is retained in the 33-01 `container-logs.test.ts` tests; these integration tests complement it.

Fixtures use the existing 900s hook, parallel pending-start settlement within 240s, 60s cleanup
steps, and a 300s stack stop. PostgreSQL/Redis partial startup handles are retained. Resources
are test-labelled, and the unchanged integration resource guards run before/after the suite.
The pre-existing listener on port3000 is preserved using `NOODARA_TEST_PORT_OVERRIDE=33992`.

## RED against actual previous source

Baseline: `09387d5d` (before 33-01). The isolated source copy has byte-identical production
files verified by `33-02-red-source-proof.json`. The exact RED regression SHA256 is recorded there. The final fixture adds one further
poisoned project-scope row in a third project; RED assertions and emitted values are unchanged. No current production file was modified.

Command in the isolated source copy:

```sh
NOODARA_TEST_PORT_OVERRIDE=33992 NOODARA_TEST_UBUNTU=all pnpm exec vitest run \
  --config vitest.red.config.ts \
  tests/integration/deploy-engine/legacy-log-redaction.test.ts \
  --testNamePattern='redacts project|redacts follow NDJSON|redacts CRLF' --reporter=verbose
```

The focused runner retains the integration config's source aliases, port/resource prechecks,
per-file leak guard and final resource teardown. It omits the unrelated compiled workspace
build: Next rejects the isolated checkout's external dependency symlinks. These tests consume
baseline TypeScript source, so no compiled app artifact substitutes for the previous code.
Name filtering selects three regression behaviors per Ubuntu; unselected tests are not code
skips. The temporary source copy and dependency links are removed after teardown.

Result: see bounded sanitized `33-02-red.txt`.

## GREEN against the current production resolver

```sh
NOODARA_TEST_PORT_OVERRIDE=33992 NOODARA_TEST_UBUNTU=all pnpm exec vitest run \
  --config vitest.integration.config.ts \
  tests/integration/deploy-engine/legacy-log-redaction.test.ts \
  tests/integration/deploy-engine/runtime-container-logs.test.ts --reporter=verbose
```

Result: **30/30 pass**, 245.31s, with no skips or cleanup failures; see bounded sanitized
`33-02-green.txt`. After adding the third-project poison fixture, its focused scope proof
passes **2/2** (123.72s); see `33-02-scope-green.txt`. Fourteen other cases are CLI-unselected
in that focused run, not code skips. The configured `it-legacy-log-redaction` gate
uses the same two files and `NOODARA_TEST_UBUNTU=all`; the port override is local-only.

Focused typecheck, scoped ESLint and `git diff --check` pass. Authoritative task gates,
including `it-logs`, remain the orchestrator's responsibility. Phase 33, M2 and SEC closure
remain open until the subsequent canary/security task and independent review complete.

The existing minimum-length policy remains eight characters per eligible multiline component.
This proof covers the currently visible service-secret snapshot; historical deleted/rotated
values, changes after lease opening, short components and unrelated scope remain outside it.
