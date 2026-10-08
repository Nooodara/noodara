# Nightly e2e-repeat flakes: root causes (14-24)

| Failure | Root cause | Fix |
|---|---|---|
| `discovery.spec.ts:364` docker step `pending`, expected `pass` (nightly 37741127947 a2, it. 5) | The detail page cleared its live checks when the **first** snapshot arrived as `CONNECTING` (`null → CONNECTING` counted as entering a run). Checks dispatched while `GET /api/servers/:id` was still in flight were wiped. | `shouldResetLiveChecks` (`apps/web/src/lib/detail-sync.ts`): only an observed transition resets. |
| `settings.spec.ts:531` `boundingBox()` returned `null` (nightly 37759024967, it. 5) | `ServersPage.fetchServers` set `loading` on every call, including the resync on stream `open`. If the mount GET landed first, the row was visible, then disappeared until the resync GET landed. | A resync over a `ready` list keeps it on screen (`servers/page.tsx`). |
| `host-key.spec.ts:486` `failed to bind host port for 0.0.0.0:42544 ... address already in use` (nightly 37741127947 a1, it. 1) | Code cause, not a runner glitch. Fixed ports 42544/42545 sit inside Linux's ephemeral range (32768-60999; macOS starts at 49152, so it never showed locally). The test failed after 4.9 s: the first container start, through all 5 retries. Something else held the port the whole time. It was not the stop/start release race that `port-binding-retry.ts` covers. | `pickFixedHostPort()` (`tests/integration/helpers/fixed-host-port.ts`): a probed-free port in 30000-32767. |

Proof:
- RED: unit tests in `servers/page.test.tsx` and `detail-sync.test.ts`, plus a deterministic e2e (`discovery.spec.ts`, "checks received while the first server snapshot is in flight"). With the old reset rule, that e2e failed with the nightly's exact signature (`Expected "pass"`, `Received "pending"`).
- GREEN: the five affected tests ran with `--repeat-each=20`: 100/100 passed locally.

Still open: `tests/integration/ssh/host-key-changed.test.ts` (42522) and `connection-loss.test.ts` (42533) use the same kind of fixed ephemeral-range port. They are outside this task's scope.
