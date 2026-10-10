# 14-15 gate run: leaked containers (2026-10-09)

Session org.testcontainers.session-id=00436822fb1d. Ryuk did not reap them. Gate order: test, typecheck, lint, boundaries, build, it-full (FAIL 9 strays), e2e-full (pass), installer (FAIL 7), security-leaks (FAIL 7), ui-safety, it-soak.

```
localhost/37661cdc29de:63581c388849 | Created | 2026-10-09 16:33:56 -0600 CST | noodara-sshd-24.04-a0b7dd87-d8f3-4532-aa56-ffbd9ee30691
redis:7-alpine | Up 5 hours | 2026-10-09 15:42:18 -0600 CST | lucid_galois
postgres:17-alpine | Up 5 hours (healthy) | 2026-10-09 15:42:18 -0600 CST | xenodochial_gates
redis:7-alpine | Up 5 hours | 2026-10-09 15:41:37 -0600 CST | agitated_babbage
postgres:17-alpine | Up 5 hours (healthy) | 2026-10-09 15:41:36 -0600 CST | nifty_einstein
registry:2 | Up 6 hours | 2026-10-09 15:22:20 -0600 CST | noodara-registry-0a951f77-894d-4712-bbf6-5f477ee5f838
localhost/72173feef380:cb8a77b85e1a | Up 6 hours | 2026-10-09 15:22:17 -0600 CST | noodara-deploy-host-24.04-3ebec144-ff01-4b97-b58a-2e9b87e725e7
registry:2 | Up 6 hours | 2026-10-09 15:22:14 -0600 CST | noodara-mirror-b98d693d-ca45-43f3-8541-f43a8658ac1f
```

Ryuk containers present now:
```
testcontainers-ryuk-1ccc9d7195da Up 8 minutes desktop.docker.io/binds/0/Source=/var/run/docker.sock,desktop.docker.io/binds/0/SourceKind=dockerSocketProxied,desktop.docker.io/binds/0/Target=/var/run/d
```

## Root cause (14-27)

Source: **it-full**, not e2e. Its log (`.agent-flow/logs/2026-10-10T02-27-52-030Z-gate-it-full.log`) shows
start 15:04:16, duration 19414 s (5.4 h): Docker was overloaded and upstream registries unreachable.

| Leaked | Suite | Why teardown missed it |
|---|---|---|
| deploy-host 24.04, registry, mirror (15:22) | `deploy-engine/runtime-container-logs.test.ts` | afterAll timed out (900 s) in `app.close()` and never reached `stack.stop()`. Deterministic, not load: the test Fastify server waited on a connection its default `forceCloseConnections: 'idle'` never closes (bounded teardown named the step; fixed with `forceCloseConnections: true`) |
| 2 x postgres + redis (15:41, 15:42) | `deploy-engine/runtime-service-ops.test.ts` | `Promise.all([stack, postgres, redis])`: the stack start rejected (22.04 ready timeout, 24.04 upstream unreachable), so the started pg/redis were never assigned and never stopped |
| sshd 24.04, `Created` (16:33) | sshd fixture | start interrupted after `docker create`; no handle |

The deploy-host's labelled volume (`noodara-deploy-engine-docker-3ebec144-…`) was still present on 2026-10-10,
along with five older ones from earlier manual cleanups.

Why Ryuk did not reap (reproduced with probes):

- testcontainers 12 adopts any running Ryuk and its session id, so every process of a gate run (each vitest
  fork, then e2e) shares one Ryuk. It reaps only when all clients disconnect, never mid-run.
- Ryuk 0.14 exits without removing anything when its container list call exceeds its 10 s request timeout
  (probe with `RYUK_REQUEST_TIMEOUT=5ms`: "removed containers=0 … run error"). The overloaded daemon hit this.
- A client that connects while Ryuk prunes gets the dying session id; its containers are never reaped.

## Fix (14-27)

- Both suites: teardown runs bounded steps (`helpers/teardown.ts`): a hung or failed step no longer blocks
  the next, `stack.stop()` always runs, and the hook fails naming each failed step. service-ops uses
  `allSettled` and assigns every resource that started; a start still pending when beforeAll timed out is
  awaited briefly and stopped.
- Harness guard (`helpers/test-resources.ts`): per-file (`setupFiles`) and per-run (`globalSetup`) snapshots
  of `noodara.test` containers, networks and volumes; teardown removes what was added and fails naming it.
  vitest exits non-zero when the globalSetup teardown throws (checked). A precheck fails a run up front when
  an earlier run left resources. e2e teardown reaps by the same snapshot instead of a creation-time window.

Verification (2026-10-10): `pnpm test:integration` (4662 s, 991 passed) then `pnpm test:e2e` (244 passed, 5.4 min);
zero `noodara.test` containers, networks and volumes after each. The integration run failed one file on
purpose: `runtime-build-logs.test.ts` hit a transient image build failure and its `Promise.all` start leaked
postgres + redis; the guard removed them and failed the file naming them. The same pattern remains in
`runtime-build-logs`, `runtime-cancel`, `runtime-pipeline`, `runtime-reconcile`, `soak`, `activity/canary-deploy`
and `queue/deploy-queue` (follow-up).
