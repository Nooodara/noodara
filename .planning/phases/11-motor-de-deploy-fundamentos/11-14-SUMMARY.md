---
phase: 11-motor-de-deploy-fundamentos
plan: 14
subsystem: ssh
tags: [ssh, streaming, remote-kill, security, tdd]
requires: ["11-13"]
provides:
  - "execStreaming: line chunks redacted per line, per-line and total caps, max/idle timeouts, abort, secret stdin"
  - "SshDeploySession.stream on the ssh2 adapter; streams and execs run concurrently on one connection"
  - "killSupervisedOperation (ADR 0008 G2): confirmed only when process.group_alive exits 1, never throws"
  - "Public deploy surface in @noodara/ssh (builders, classifiers, streaming, kill); factory and renderer stay internal"
affects: [11-15, 12]
tech-stack:
  added: []
  patterns: ["in-flight op set per connection", "usage errors pass through unclassified", "measurements via NOODARA_MEASUREMENTS_FILE"]
key-files:
  created:
    - packages/ssh/src/exec-streaming.ts
    - packages/ssh/src/remote-kill.ts
    - tests/integration/deploy-engine/exec-streaming.test.ts
  modified:
    - packages/ssh/src/ssh-port.ts
    - packages/ssh/src/ssh2-adapter.ts
    - packages/ssh/src/index.ts
    - packages/ssh/src/run-discovery.test.ts
    - packages/ssh/src/ssh2-adapter.test.ts
decisions:
  - "ADR 0008 wins over the plan text (see ADR overrides)"
  - "DEFAULT_MAX_LINE_BYTES 16384 and DEFAULT_TAIL_BYTES 8192 kept after measurement"
  - "buildContainer is null for BuildKit builds: no container exists during a RUN step (ADR 0008)"
metrics:
  completed: 2026-10-01
  tasks: 3
---

# 11-14 Summary: streaming exec and confirmed remote kill

## Done

- Task 1 (fe9c033 RED, ebf9052 GREEN): `execStreaming` with per-line redaction, UTF-8-safe line
  cap with 4 KiB redaction lookahead, total cap, `completed`/`timed_out`/`idle_timeout`/`aborted`,
  secret stdin written once then EOF, `registerSecretForStreaming` for multi-line secrets.
- Task 2 (1cd4728 RED, b24f7fb GREEN):
  - `killSupervisedOperation`: `process.kill_group`, poll `process.group_alive` every
    `pollIntervalMs`, `docker.kill` once if a container is given and the group is alive after 2 s,
    confirmed only on a completed `group_alive` with exit 1. Every step is bounded by the remaining
    budget; failures end as `confirmed: false` with nothing remote in the result.
  - Adapter: the single in-flight slot became a set, so a transport loss rejects every open exec
    and stream. Without it, a kill running next to a stream left the stream hanging on loss.
    `stream` after `close()` rejects with the same classified `SshExecFailure`; usage errors
    (`RangeError`/`TypeError`) are not reported as `CONNECTION_LOST`.
  - `createSsh2Adapter` returns `SshPort<SshDeploySession>`; `ConnectOutcome`/`SshPort` keep the
    `SshSession` default, so existing fakes compile unchanged (`service-fixture.ts` untouched).
  - `index.ts` exports exactly the plan list; `createRemoteCommand`, `renderRemoteCommand`,
    `SHELL_SCRIPTS`, `escapeShellArg` stay internal. `EXPECTED_RUNTIME_EXPORTS` updated.
- Task 3 (13b38ad): real fixture, Ubuntu 22.04 and 24.04, through `createSsh2Adapter` only.
  - G1: `secrets.write_file` via stream stdin, mode 600, sha256 matches.
  - Noisy build streamed with a 1 MiB cap: first chunk long before the build ends, the canary only
    as `[REDACTED`, `truncated` true, no line over 16384 bytes, tails hold lines past the cap.
    After abort the build is still alive (G2: closing the channel stops nothing);
    `killSupervisedOperation` confirms, root `pgrep -f "sleep 300"` and `docker build` are empty.
  - Slow build: kill runs on the same connection while the stream is open, confirms, and the
    stream then completes with exit 130.
  - SEC: no canary or stdin secret line in any chunk or tail.

## Measured defaults

Gate run (`NOODARA_TEST_UBUNTU=all`), numbers from `NOODARA_MEASUREMENTS_FILE`:

| Ubuntu | Scenario | First chunk | Chunks/s | Delivered B/s | Largest chunk | Max line | Kill to absence | Steps |
|---|---|---|---|---|---|---|---|---|
| 22.04 | noisy | 240 ms | 117 | 92 864 | 16 416 B | 16 384 B | 264 ms | kill_group |
| 22.04 | slow | 161 ms | n/a | n/a | n/a | n/a | 259 ms | kill_group |
| 24.04 | noisy | 235 ms | 121 | 92 840 | 16 385 B | 16 384 B | 522 ms | kill_group |
| 24.04 | slow | 65 ms | n/a | n/a | n/a | n/a | 266 ms | kill_group |

Total cap 1 MiB: delivered 1 048 531 B of 1 278 684 raw B on both. `docker.kill` was never needed.

- `DEFAULT_MAX_LINE_BYTES = 16384` kept: the only line above it was the test's 40 KB line.
- `DEFAULT_TAIL_BYTES = 8192` kept: enough for the last ~170 build lines.
- Kill budget: absence in under 0.6 s with a 250 ms poll; callers can use a 30 s confirm timeout.
- BuildKit: a step that printed ~1.5 MB in 0.07 s stopped streaming at ~250 KB raw (no further
  output for 240 s). Printed in bursts (~100 KB/s) it streams in full. Phase 12 should not rely on
  seeing all output of a very fast-printing step.

## ADR overrides

ADR 0008 wins where the plan text differs:

| Plan text | Implemented (ADR 0008) |
|---|---|
| `kill -TERM -- "-$pgid"` | `kill -s TERM -- "-$pgid"` (built in 11-13, used by the kill) |
| `setsid sh -c ...` | `setsid -w sh -c ...` |
| `docker ps` without size flag | `--size=false` (not touched here) |
| git exit codes per failure | classified by text, exit 128 always (classifiers exported as is) |
| group absent = "non-zero exit of group_alive" | only exit 1 of a completed probe; exit 2 (pidfile unreadable), timeout or no exit code are unknown |

Other deviations:

- No `fixtures/noisy-build/Dockerfile`: the Dockerfile is written per run so the canary is a
  fresh `randomBytes` value; it reuses the digest-pinned `FROM` of `fixtures/slow-build`.
- `~3 MB` of output became ~1.3 MB in bursts, to stay under BuildKit's 2 MiB step clip and its
  fast-output stall (above).
- `run-discovery.test.ts` and `ssh2-adapter.test.ts` (outside the envelope scope, inside the GSD
  plan) changed: export list, `FakeExecChannel.write/end`, stream tests.
- `exec-streaming.ts` stdin usage errors are now `TypeError` so the adapter can tell them apart.

## Open items

- ADR 0008 is still `Proposed` (OPEN_QUESTIONS 2).
- The secret registered for stream stdin is never released (documented in `exec-streaming.ts`);
  the caller owns the redactor's lifetime.
