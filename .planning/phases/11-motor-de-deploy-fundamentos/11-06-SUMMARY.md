---
phase: 11-motor-de-deploy-fundamentos
plan: 06
subsystem: testing
tags: [ssh, secrets, kill, buildkit, git, contracts, spikes]
requires: ["11-03"]
provides:
  - "tests/integration/deploy-engine/contracts-g1-g2.test.ts: permanent G1/G2 contract tests (D-02)"
  - "packages/ssh/src/fixtures/deploy-errors/: real git clone failure outputs per Ubuntu version (for 11-11)"
  - "tests/integration/deploy-engine/fixtures/slow-build/Dockerfile"
affects: [11-09, 11-11, 11-13, 11-14]
tech-stack:
  added: []
  patterns: ["measurements appended to NOODARA_MEASUREMENTS_FILE (Vitest hides console of passing tests)", "remote absence checked with pgrep as root, never inferred"]
key-files:
  created:
    - tests/integration/deploy-engine/contracts-g1-g2.test.ts
    - tests/integration/deploy-engine/fixtures/slow-build/Dockerfile
    - packages/ssh/src/fixtures/deploy-errors/README.md
    - packages/ssh/src/fixtures/deploy-errors/ubuntu-22.04/*.txt (4)
    - packages/ssh/src/fixtures/deploy-errors/ubuntu-24.04/*.txt (4)
  modified: []
decisions:
  - "G1: secrets go over exec stdin to `sh -c 'umask 077 && cat > \"$0\"'`; SFTP works too but is not adopted (second subsystem, and its raw open is subject to umask 002)"
  - "G1: docker login always with `--config <ws>/secrets/docker` and `--password-stdin`; credentials land in <ws>/secrets/docker/config.json (0600, dir 0700), never in ~/.docker"
  - "G2: the kill form is `kill -s TERM -- \"-$pgid\"`; dash rejects `kill -TERM -- \"-$pgid\"` (exit 2, kills nothing)"
  - "G2: launch with `setsid -w`; plain setsid forks under sshd and reports exit 0 immediately, losing the real status"
  - "G2: `docker kill` has no target during a BuildKit RUN step (docker ps empty); cancelling the CLI cancels the step in <200 ms, so the D-04 docker-kill branch was never taken"
metrics:
  duration: "~45 min"
  completed: 2026-09-29
  tasks: 2
  files: 12
---

# Phase 11 Plan 06: G1/G2 contract spikes Summary

G1 and G2 are measured against the real sshd + dockerd fixture on Ubuntu 22.04 and 24.04 and kept as 36 permanent contract tests. Four results contradict what the plan or research assumed: dash rejects the planned `kill -TERM -- "-$pgid"`, plain `setsid` loses the exit status, `docker kill` has nothing to kill during a BuildKit build, and `channel.signal()` does work (research assumption A1 had doubted it).

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1. G1 secret transfer + git captures | 177c042 | 8 tests per Ubuntu; 8 fixture files + README |
| 2. G2 confirmed remote kill | 296d4bc | 10 tests per Ubuntu; slow-build Dockerfile |

Evidence-only plan (no production code), so there is no RED/GREEN split. Each task is one `test(11-06)` commit.

## Verification

- `NOODARA_TEST_UBUNTU=all ... contracts-g1-g2.test.ts` (whole file): **36/36 passed, 250.4 s** (18 per Ubuntu, one stack per describe, 4 stack starts).
- `-t "G1"` all versions: 16/16, 130.5 s. `-t "G2"` 24.04 only: 10/10, 96.8 s.
- `pnpm typecheck` exit 0; `pnpm test` 209 files / 3821 tests passed.
- `grep -rn BEGIN packages/ssh/src/fixtures/deploy-errors/`: no match. The slow-build Dockerfile has no `${` and its FROM is digest-pinned.
- After the last run, no container, network, volume or image with `noodara.test=true` was left. Each G2 test's afterEach also asserts that no `sleep 30x` process and no `noodara-test/slow` image remain.

## Measurements

Versions: 22.04 has OpenSSH_8.9p1 Ubuntu-3ubuntu0.17, git 2.34.1 and util-linux setsid 2.37.2. 24.04 has OpenSSH_9.6p1 Ubuntu-3ubuntu13.19, git 2.43.0 and setsid 2.39.3. Both run Docker server 29.8.1 and buildx v0.37.1. Host: macOS arm64, Docker Desktop, 2026-09-29.

### G1: secret transfer without argv

| Candidate | Ubuntu | Bytes (sha256) | Mode / owner | In ps args | In /proc/*/environ | In sshd log |
|---|---|---|---|---|---|---|
| stdin to `umask 077 && cat > <path>` (channel held open during scan) | 22.04 | identical | 600 deployer | no | no | no |
| same | 24.04 | identical | 600 deployer | no | no | no |
| SFTP `createWriteStream({ mode: 0o600 })` | 22.04 | identical | 600 after open, 600 after close | no | n/a | no |
| same | 24.04 | identical | 600 after open, 600 after close | no | n/a | no |
| SFTP raw `open(mode 0o666)` (umask probe) | 22.04 / 24.04 | n/a | **664**: sftp-server umask is 002 | n/a | n/a | n/a |

- **Setup:** `cat` was confirmed alive in `ps` while the scans ran, so the window was real. The canary was a PEM-armoured random hex string. The /proc and ps scans ran as root, and the search ran locally, so the needle was never on the remote.
- **SFTP note:** ssh2's WriteStream does `open(mode)` and then `fchmod(mode)`. The 0600 result comes from that fchmod, not from the open. Any mode other than 0600 at open time is widened by the 002 umask (Ubuntu pam_umask with user-private groups).
- **E2E clone:** the deploy key written over stdin cloned through `GIT_SSH_COMMAND="ssh -i <ws>/secrets/deploy_key ..."` with exit 0 on both versions. `.git/config` contains neither the key path nor any key material.
- **docker login:** `docker --config <ws>/secrets/docker login --password-stdin` exits 0 on both versions and was seen blocked in `ps` while stdin stayed open. Credentials land in `<ws>/secrets/docker/config.json` as base64 `user:password`, with no `credsStore`, file 600 and dir 700. `~/.docker/config.json` was unchanged (same sha256 before and after). The password and its base64 were absent from ps, environ, the sshd log and the dockerd log. After `rm -rf <ws>`, `grep -rlF` over /home/deployer, /root, /tmp and /opt/noodara-deploy found nothing (exit 1).
- **Recommendation:** stdin to `umask 077 && cat` (the research default), confirmed with no hidden defect. SFTP is not adopted.

### G1: git failure captures

Outputs are identical on both versions, and every case exits 128. Markers are listed in the fixture README. The fixture sshd prints `Permission denied (publickey,password,keyboard-interactive)` because it also offers password auth, so the marker is `/Permission denied \(publickey[,)]/`.

### G2: confirmed remote kill

Every "absent" below comes from `pgrep` on the remote, run as root. Times are measured from the kill action until the process was gone.

| Candidate | 22.04 killed / ms | 24.04 killed / ms | Notes |
|---|---|---|---|
| `channel.destroy()` (negative control) | **no** (survives 3 s) | **no** | also survives `client.end()` of the whole connection |
| `channel.signal('TERM')`, single command | yes / 19 | yes / 14 | ssh2 reports `exit: {code: null, signal: 'SIGTERM'}` |
| `channel.signal('KILL')`, single command | yes / 57 | yes / 13 | `signal: 'SIGKILL'` |
| `channel.signal('TERM')`, process tree (3 procs) | yes / 34 | yes / 16 | whole tree gone, consistent with sshd signalling the session's process group |
| `setsid` + pidfile + `kill -TERM -- "-$pgid"` (plan form) | **no**: exit 2 | **no**: exit 2 | dash: `kill: Illegal number: -`; group survives |
| `setsid` + pidfile + `kill -s TERM -- "-$pgid"` | yes / 17 | yes / 21 | the launch channel reported exit 0 *before* the kill (setsid forked) |
| `setsid -w` + pidfile + `kill -s TERM -- "-$pgid"` | yes / 21 | yes / 25 | the launch channel reports exit 15 (raw signal number) after the kill |
| `docker kill` of the build container | n/a | n/a | `docker ps -a` empty during RUN; the step's parent is BuildKit's `runc` (child of dockerd) in its own pgid |
| `channel.signal('TERM')` on a plain `docker build` | yes: step 23, CLI 168 | yes: step 18, CLI 162 | `#5 CANCELED`, CLI exit 130 |
| **Combined D-04** on `docker build`: `setsid -w` + pidfile + `kill -s TERM -- -pgid`, then docker kill if still alive after 2 s | yes / 180 | yes / 179 | docker-kill branch **not taken** (0 targets); `CANCELED`; exit 130 |

Findings for 11-13/11-14 and ADR 0008:

1. Research assumption A1 does not hold on these versions. `channel.signal()` is honoured for no-pty exec sessions on OpenSSH 8.9 and 9.6, and it takes down the whole tree. D-04 still requires the combined sequence; the ADR should record that signal also works on its own.
2. The allowlisted kill script must use `kill -s TERM -- "-$pgid"`. `kill -TERM -- "-$pgid"` is broken under dash, and the contract test keeps that as a negative assertion.
3. The launcher must be `setsid -w`. Without `-w`, a real failure is reported as exit 0.
4. BuildKit RUN steps are invisible to `docker ps`, so "docker kill of the build container" has no target during `docker build`. Killing the CLI is enough: dockerd cancels the solve in under 200 ms. The docker-kill branch remains meaningful only for `docker run` containers, which is outside this spike.
5. Destroying a channel or ending the connection never kills the remote process. A kill primitive is required.

## Deviations from Plan

1. **[Rule 1 - Bug] The planned kill form does not work.** `kill -TERM -- "-$pgid"` fails under dash on both versions (`Illegal number: -`, exit 2, group intact). I verified it separately with `docker run ubuntu:{22.04,24.04}`. The contract test keeps it as a negative test (`KILL_GROUP_DASH_REJECTED`), and the working primitive uses `kill -s TERM -- "-$pgid"`. Commit 296d4bc.
2. **Extra G2 cases beyond the plan:** plain `setsid` vs `setsid -w` (exit-status loss), `channel.signal` on a process tree, `channel.signal` on `docker build`, and `client.end()` in the negative control. They are measurements that 11-13 needs.
3. **The docker-kill candidate is recorded as "no target"**, not run. There is no docker-visible container during a BuildKit RUN step. The test asserts `docker ps -a` is empty and that the step's parent is `runc` in its own pgid.
4. **The auth-failure marker was broadened** from `/Permission denied \(publickey\)/` (the plan's example) to `/Permission denied \(publickey[,)]/`, because the fixture sshd lists `publickey,password,keyboard-interactive`.
5. **SFTP was measured with `createWriteStream`** (as planned) plus a raw `sftp.open(0o666)` probe. The "mode right after open" reading happens after ssh2's own fchmod, so the probe is what exposes the 002 umask.
6. **`NOODARA_MEASUREMENTS_FILE`:** Vitest does not print console output of passing tests here, so `measure()` also appends JSON lines to that file when it is set. It is test-only.
7. **The SFTP type is derived from `Client['sftp']`** to avoid a bare `ssh2` import (boundary rule). `packages/ssh/src/testing/raw-ssh2.ts` is untouched.

## Issues

- **Unexplained one-off:** during one `NOODARA_TEST_UBUNTU=all -t G1` run, the 22.04 stack failed in `beforeAll` with Testcontainers `Failed to build image` (the 24.04 half passed). A direct `docker build` of the same Dockerfile right afterwards succeeded from cache. The immediate re-run with `DEBUG=testcontainers:build` passed 16/16, and the final full run passed 36/36. The cause was not captured. It is not a contract failure, but I cannot prove it was environmental.
- Root `tests/` is not covered by any ESLint config (`pnpm lint` runs per package), so only typecheck and Prettier (on my new files) apply to the test file.

## Known Stubs

None.

## Self-Check: PASSED

- Files: contracts-g1-g2.test.ts (937 lines), slow-build/Dockerfile, deploy-errors/README.md and the 8 .txt captures all exist.
- Commits 177c042 and 296d4bc are in `git log`.
