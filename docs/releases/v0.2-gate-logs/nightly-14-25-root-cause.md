# Nightly deploy-engine 22.04: exec-streaming slow-build flake (14-25)

Failure (nightly 37781972328, `nightly-37781972328-deploy-engine-2204.log`): "slow build: killSupervisedOperation runs while the stream is open..." failed at `exec-streaming.test.ts:389`, `expect(await sleepAlive()).toBe(true)`. An unhandled `SshExecFailure { errorCode: 'CONNECTION_LOST' }` followed.

Root cause: a test race. `packages/ssh` is not involved.
- The test waited for `watched.text().includes('NOODARA_SLOW_BUILD_STARTED')`. The BuildKit step header `#5 [2/2] RUN echo NOODARA_SLOW_BUILD_STARTED && sleep 300` already contains that text. BuildKit prints the header when it schedules the step, before the step's container starts.
- On an idle host the header and the output line `#5 0.1xx NOODARA_SLOW_BUILD_STARTED` arrive in one chunk, so the race never showed. On a loaded runner the header arrives alone. `pgrep -f 'sleep 300'` then ran before `sh -c` existed.
- `killSupervisedOperation` never ran. The test failed one line before it. So the kill on the same connection did not cause the failure, and neither did 14-09's stdin release.
- `CONNECTION_LOST` is a side effect. The failed test left its `stream()` promise unawaited. `afterAll` then called `session.close()`, and the adapter's `'close'` handler rejected that still-open op (`failInFlight`). That is the right behavior for an explicit close.

Proof:
- RED: a probe in the test logged the marker lines at the moment of the check. Idle host: 10/10 passed, and the header and output line came in the same chunk every time. Under CPU load (28 busy-loop containers on 14 vCPUs) it failed 5/5 with the nightly's exact signature. In those runs only the header line had arrived and `alive: false`.
- GREEN: the test now waits for the RUN output line (`SLOW_STARTED_OUTPUT_LINE`, same form as `READY_OUTPUT_LINE`). Under the same load: 5/5 passed. Idle host: 20/20 passed on 22.04 and 20/20 on 24.04. Full file, `NOODARA_TEST_UBUNTU=all`: 8/8 passed.
- Hygiene: `void streaming.catch(() => undefined)` keeps an early assertion failure from surfacing again as a misleading unhandled `CONNECTION_LOST`. The happy path still awaits `streaming`.
