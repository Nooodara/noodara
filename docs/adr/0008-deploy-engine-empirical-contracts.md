# ADR 0008: Deploy engine empirical contracts (G1-G4, G7)

## Status

Accepted — 2026-10-04

## Context

QA-10 requires four questions to be answered with evidence before the deploy engine is built
(11-CONTEXT D-01): how a secret reaches the server without argv (G1), how a remote build is
killed with confirmation (G2), whether the Docker that `install.sh` provisions builds with
BuildKit (G3), and whether `docker ps --format '{{json .}}'` is stable across Ubuntu versions
(G4). G7 is how the test harness gets base images without Docker Hub rate limits.

Reasoning alone was not enough: research made assumptions (A1, A3, the `docker kill` target)
and the plan fixed a kill command, and measurement contradicted several of them. Each spike is
kept as a permanent contract test (D-02) that fails if OpenSSH, git or Docker change behaviour:

| File | Covers |
|---|---|
| `tests/integration/deploy-engine/contracts-g1-g2.test.ts` | G1, G2 (18 tests per Ubuntu) |
| `tests/integration/deploy-engine/contracts-g3-g4.test.ts` | G3, G4 (22 tests total) |
| `tests/integration/deploy-engine/fixtures.test.ts` | QA-07 fixtures, D-10 registry auth (7 per Ubuntu) |
| `tests/integration/deploy-engine/harness.test.ts` | G7 fixture supply (6 per Ubuntu) |

Test titles below are quoted from these files. Evidence and raw numbers are in
`.planning/phases/11-motor-de-deploy-fundamentos/11-03..11-08-SUMMARY.md`.

### Environment measured

| | Ubuntu 22.04 | Ubuntu 24.04 |
|---|---|---|
| OpenSSH | 8.9p1 Ubuntu-3ubuntu0.17 | 9.6p1 Ubuntu-3ubuntu13.19 |
| git | 2.34.1 | 2.43.0 |
| util-linux `setsid` | 2.37.2 | 2.39.3 |
| Docker server / API | 29.8.1 / 1.56 | 29.8.1 / 1.56 |
| buildx / BuildKit | v0.37.1 / v0.33.0 | v0.37.1 / v0.33.0 |
| `/bin/sh` | dash | dash |

Fixture: `tests/integration/images/sshd-dockerd-ubuntu-{22.04,24.04}` (sshd + nested dockerd with
`install.sh`'s package set, D-12). Host: macOS arm64, Docker Desktop, 2026-09-29/30. Not yet
measured on an amd64 Linux runner (see Open items).

## G1: secret transfer without argv

### Decision

| Secret | Mechanism |
|---|---|
| Any secret file (deploy key, known_hosts, token) | exec stdin to `sh -c 'umask 077 && cat > "$0"' <path>`; path is a positional parameter, content never in argv |
| Registry credentials | `docker --config <ws>/secrets/docker login --username <u> --password-stdin <registry>`; per-deployment config dir, never `~/.docker` |
| Workspace | `sh -c 'umask 077 && mkdir -p "$0/secrets" "$0/run"' /opt/noodara-deploy/<deploymentId>`; removed with `rm -rf` after the deployment |

Enforced by: `G1 / ADR 0008: stdin to \`umask 077 && cat > <path>\` lands byte-identical, 0600, ...`,
`G1 / ADR 0008: a deploy key delivered over stdin clones through GIT_SSH_COMMAND ...`,
`G1 / ADR 0008: \`docker --config <ws>/secrets/docker login --password-stdin\` keeps the credential inside the workspace ...`
(contracts-g1-g2.test.ts) and `QA-07 / D-10 / G1: pull through the htpasswd registry ...` (fixtures.test.ts).

### Measured

| Check | 22.04 | 24.04 |
|---|---|---|
| stdin `cat`: bytes (sha256) / mode / owner | identical / 600 / deployer | identical / 600 / deployer |
| Canary in `ps` args, `/proc/*/environ`, sshd log (scanned as root while `cat` was alive) | absent | absent |
| Deploy key over stdin, `git clone` via `GIT_SSH_COMMAND="ssh -i <ws>/secrets/deploy_key ..."` | exit 0; `.git/config` has no key or path | same |
| `docker login --password-stdin` with `--config <ws>/secrets/docker` | exit 0; `config.json` 600, dir 700, no `credsStore`; `~/.docker/config.json` sha256 unchanged | same |
| After `rm -rf <ws>`: `grep -rlF` of the password over /home/deployer, /root, /tmp, /opt/noodara-deploy | nothing (exit 1) | nothing |
| git clone failures (auth, repo missing, branch missing, host unresolved) | all exit **128** | all exit **128** |

**Surprise:** SFTP raw `open(mode 0o666)` lands at **664**: sftp-server runs with umask 002
(pam_umask, user-private groups). `createWriteStream({ mode: 0o600 })` only reaches 600 because
ssh2 follows the open with `fchmod`.

**Surprise:** git exits 128 for all four failure classes on both versions. `classifyGitError`
(11-11) must key on stderr markers (captured in `packages/ssh/src/fixtures/deploy-errors/`),
never on the exit code. Same for Docker: every captured failure exits 1 except a port clash (125).

### Rejected alternatives

| Alternative | Evidence | Why rejected |
|---|---|---|
| SFTP `createWriteStream({ mode: 0o600 })` | Measured: works (600 on both versions) | Second subsystem outside the exec mutex/timeouts in `packages/ssh`; any mode other than 0600 at open time is widened by umask 002 (measured 664) |
| Secret as env var over SSH (`setEnv`) | Not measured | Needs `AcceptEnv` in the user's sshd_config (Ubuntu default accepts only `LANG LC_*`); env is readable in `/proc/<pid>/environ` for the process lifetime |
| Secret in argv (`docker login -p`, key inline) | Not measured | Visible in `ps` to every local user; forbidden by `noodara-security` |
| Token embedded in URL (`https://user:token@host`) | Not measured | Lands in `.git/config`, process args and git error output; the D-05 validator already rejects embedded credentials |
| Default `~/.docker/config.json` | Measured: the per-workspace `--config` leaves it untouched | Credentials would outlive the deployment and be shared across services |

## G2: confirmed remote kill

### Decision

The combined D-04 mechanism is the implemented one, with the measured corrections to its
wording (`kill -s TERM`, `setsid -w`). Constant scripts (`contracts-g1-g2.test.ts`):

```sh
# launch (pidfile under <ws>/run/<op>.pid)
setsid -w sh -c 'echo $$ > "$0"; exec "$@"' <pidfile> <command...>
# kill the whole process group
sh -c 'read -r pgid < "$0" && kill -s TERM -- "-$pgid"' <pidfile>
```

Sequence: kill the group; if a `noodara.managed` container is still alive after 2 s,
`docker kill` it; report success only when `pgrep` on the remote finds nothing.

Enforced by: `G2 / ADR 0008 / D-04: combined sequence: setsid -w + pidfile + kill -s TERM -- "-$pgid", docker kill only if a container is still alive after 2 s, success only when the RUN step is absent in ps`
and `G2 / ADR 0008 / D-04: dash rejects \`kill -TERM -- "-$pgid"\` (Illegal number, exit 2) and the group survives`.

### Measured (each candidate in isolation; "killed" = absent in remote `pgrep` as root)

| Candidate | 22.04 killed / ms | 24.04 killed / ms | Notes |
|---|---|---|---|
| `channel.destroy()` (negative control) | **no** (alive after 3 s) | **no** | also survives `client.end()` |
| `channel.signal('TERM')`, single command | yes / 19 | yes / 14 | ssh2 reports `{code: null, signal: 'SIGTERM'}` |
| `channel.signal('KILL')`, single command | yes / 57 | yes / 13 | |
| `channel.signal('TERM')`, 3-process tree | yes / 34 | yes / 16 | whole tree gone |
| `channel.signal('TERM')` on `docker build` | yes: step 23, CLI 168 | yes: step 18, CLI 162 | `#5 CANCELED`, CLI exit 130 |
| `setsid` + pidfile + `kill -TERM -- "-$pgid"` (plan/D-04 form) | **no**: exit 2 | **no**: exit 2 | dash: `kill: Illegal number: -` |
| `setsid` + pidfile + `kill -s TERM -- "-$pgid"` | yes / 17 | yes / 21 | launch channel reported exit 0 **before** the kill |
| `setsid -w` + pidfile + `kill -s TERM -- "-$pgid"` | yes / 21 | yes / 25 | launch channel reports exit 15 after the kill |
| `docker kill` of the build container | no target | no target | `docker ps -a` empty during a RUN step |
| **Combined D-04** on `docker build` | yes / 180 | yes / 179 | docker-kill branch not taken (0 targets); CLI exit 130 |

**Surprise:** `kill -TERM -- "-$pgid"` fails under dash on both versions (`Illegal number: -`,
exit 2, nothing killed). Only `kill -s TERM -- "-$pgid"` works. Kept as a negative test.

**Surprise:** plain `setsid` forks when it is a process-group leader (always true under sshd), so
the exec channel reports exit 0 immediately and the real status is lost. The launcher must be
`setsid -w`.

**Surprise:** `docker ps` is empty during a BuildKit RUN step: the step runs under BuildKit's own
`runc` (child of dockerd) in its own process group. Research expected a visible build container.
Killing the `docker build` client is what cancels the step (dockerd cancels the solve in < 200 ms).

**Surprise:** `channel.signal()` works on OpenSSH 8.9 and 9.6 for no-pty exec sessions and
takes down the whole tree (research assumption A1 doubted it). D-04 still requires the combined
sequence; signal is recorded as a working isolated candidate only.

**Surprise:** closing the channel or the whole connection never kills the remote process. A kill
primitive is mandatory for cancel and timeout.

### Rejected alternatives

| Alternative | Evidence | Why rejected |
|---|---|---|
| `channel.destroy()` / `client.end()` | Measured: process survives | Leaves orphaned builds on the user's server |
| `channel.signal()` alone | Measured: works on both versions | D-04 forbids a single mechanism; depends on sshd honouring signals, and needs the original channel (lost if the control plane restarts) |
| `kill -TERM -- "-$pgid"` | Measured: exit 2 under dash | Broken on both versions |
| Plain `setsid` | Measured: exit 0 before the command ends | Hides real failures |
| `docker kill` alone | Measured: no target during build | Cannot stop a build or a `git clone` |

## G3: BuildKit active and detected

### Decision

- BuildKit is the default builder on both versions with `install.sh`'s packages. Noodara never
  sets `DOCKER_BUILDKIT`.
- Discovery check id `docker_buildkit` runs `docker build --help` (as the SSH user) and reads the
  first stdout line:

| First stdout line | Exit | stderr | Result |
|---|---|---|---|
| `Usage:  docker buildx build [OPTIONS] PATH \| URL \| -` | 0 | empty | pass (BuildKit active) |
| `Usage:  docker build [OPTIONS] PATH \| URL \| -` | 0 | `DEPRECATED ... Install the buildx component` | fail: plugin missing |
| `Usage:  docker build [OPTIONS] PATH \| URL \| -` | 0 | `DEPRECATED ... BuildKit is currently disabled` | fail: disabled by `DOCKER_BUILDKIT=0` |

- On fail, the actionable message names the package: install `docker-buildx-plugin`
  (`sudo apt-get install docker-buildx-plugin`). Phase 12 rejects Dockerfile services on that
  server (D-03); image services are not blocked. The fact is stored in
  `servers.docker_buildkit_available` (migration 0005).
- Only the first line, exit code and stderr are a contract; the help body changes with buildx
  releases. Captures: `packages/domain/src/discovery/fixtures/ubuntu-*/docker_buildkit*`.

Enforced by (contracts-g3-g4.test.ts): `G3 / ADR 0008 / D-03: the chosen check reports BuildKit active and matches the capture`,
`G3 / ADR 0008 / D-03: with DOCKER_BUILDKIT=0 the chosen check reports legacy while buildx version and docker info still report the plugin (their false positive)`,
`G3 / ADR 0008 / D-03: candidates without the plugin; the chosen check reports legacy and matches the capture`,
`G3 / ADR 0008 / D-03: install.sh does not mention DOCKER_BUILDKIT and installs docker-buildx-plugin`.

### Measured

| | 22.04 | 24.04 |
|---|---|---|
| Plain `docker build .` (no flags, no env) | BuildKit (`load build definition`), no `Step 1/`, exit 0, 755 ms | same, 613 ms |
| Same with `DOCKER_BUILDKIT=0` | legacy `Step 1/2`, exit 0, deprecation on stderr | same |
| Same after `apt-get remove docker-buildx-plugin` | legacy `Step 1/2`, **exit 0**, deprecation on stderr | same |
| `docker build --help` captures | byte-identical across versions, deterministic across two runs | same |

**Surprise:** without buildx, `docker build` silently falls back to the legacy builder with exit 0.
Without the D-03 check, a server missing the plugin would build with the wrong builder unnoticed.

**Surprise:** every structured candidate reports the plugin under `DOCKER_BUILDKIT=0` while the
real build uses the legacy builder. The chosen check is therefore help text, not JSON.

Manual probe, not kept as a test: `/etc/docker/daemon.json` `{"features":{"buildkit":false}}` +
dockerd restart (22.04) still built with BuildKit. That daemon flag does not switch builders on
Docker 29 with buildx.

### Rejected alternatives

| Candidate | Active | `DOCKER_BUILDKIT=0` | Plugin missing | Why rejected |
|---|---|---|---|---|
| `docker buildx version` | 0, version line | 0, version line | 1, unknown command | false positive under env=0 |
| `docker info --format '{{json .ClientInfo.Plugins}}'` | 0, has buildx | 0, has buildx | 0, compose only | false positive under env=0 |
| `docker buildx inspect` | 0, `Driver: docker` | 0 | 1, unknown command | false positive under env=0 |
| Infer from `docker_version` or package presence | n/a | n/a | n/a | D-03: detect, never infer |

## G4: `docker ps` output

### Decision

```sh
docker ps --all --no-trunc --size=false --filter label=noodara.managed=true --format '{{json .}}'
```

- Parse as NDJSON: one JSON object per line, never one array.
- `--size=false` is mandatory.
- Parser (11-10) must accept: `Platform` is an object (`architecture/os/variant`), every other
  field a string; `Ports` escapes `->` as `>` and lists IPv4 and IPv6 bindings, empty when not
  running; `Command` keeps its quotes; running container `FinishedAt` is `0001-01-01T00:00:00Z`.
- Container state detail comes from `docker inspect --type container --format '{{json .State}}'`.
- Captures: `packages/domain/src/deployment/fixtures/ubuntu-*/docker_ps.ndjson`, `docker_inspect_state_{running,exited}.json`.

Enforced by (contracts-g3-g4.test.ts): `G4 / ADR 0008: \`docker ps --all --no-trunc --size=false ...\` is NDJSON, one object per container, ...`,
`G4 / ADR 0008: \`{{json .}}\` computes Size unless \`--size=false\` is passed; ...`,
`G4 / ADR 0008: 22.04 and 24.04 docker ps captures have the same key set, each line valid JSON`.

### Measured

| | 22.04 | 24.04 |
|---|---|---|
| Lines / each `JSON.parse`-able | 3 / yes | 3 / yes |
| Key set | `Command CreatedAt HealthStatus ID Image Labels LocalVolumes Mounts Names Networks Platform Ports RunningFor Size State Status` | identical |
| `State` values seen | running, exited, created | same |
| `Size` with `--size=false` | `0B` | `0B` |
| `Size` with no size flag | computed (`4.1kB (virtual 173MB)`) | computed |
| Median remote wall time, 50k files in one writable layer: `--size=false` / no flag / `--size` | 34-37 / 109-130 / 126-127 ms | 25-27 / 95-130 / 95-130 ms |
| inspect `.State` keys | `Dead Error ExitCode FinishedAt OOMKilled Paused Pid Restarting Running StartedAt Status` | identical |

**Surprise:** omitting `--size` does not skip the size computation: `{{json .}}` references
`.Size`, so the CLI enables it by itself (research assumption A3 was wrong). Only `--size=false`
avoids it (3-4x faster on the churned container).

### Rejected alternatives

| Alternative | Evidence | Why rejected |
|---|---|---|
| No size flag | Measured: size computed | Cost grows with writable-layer size (docker/for-linux#1179) |
| `--size` | Measured: same as no flag | Same cost |
| Explicit field template (`{{.Names}}\t{{.State}}...`) | Not measured | `{{json .}}` is stable across both versions and escapes separators; a hand-rolled delimiter format would need its own escaping |
| Whole output as one JSON array | Measured: output is NDJSON | Would fail to parse |

## G7: fixture supply (test harness only)

### Decision

| Need | Mechanism |
|---|---|
| Authenticated pull / `docker login` (D-10) | `registry:2` with htpasswd on the Testcontainers network, preloaded with the digest-pinned bases |
| Base images for the nested dockerd | pull-through mirror (`registry:2` proxying `mirror.gcr.io`) set as `registry-mirrors`; falls back to `registry-1.docker.io` if `mirror.gcr.io` does not answer `/v2/` |
| Bases | `node:22-alpine@sha256:0a7108bf...e402`, `nginx:1.31-alpine@sha256:df221db8...eac2` |

**The mirror was selected by the orchestrator during an autonomous run (2026-09-29), not
confirmed by the user.** See Open items.

Enforced by: `tests/integration/deploy-engine/harness.test.ts` and `fixtures.test.ts`.

### Measured

| | 22.04 | 24.04 |
|---|---|---|
| Mirror upstream used | `mirror.gcr.io` every run, no fallback | same |
| `node:22-alpine` index digest via mirror | same as Docker Hub (`sha256:0a7108bf...`) | same |
| Unauthorised pull / wrong login / right login / authorised pull | exit 1 / 1 / 0 / 0 | same |
| Authorised pull time | 24-32 ms | 24-32 ms |
| Password in `ps` args during `docker login --password-stdin` | absent | absent |
| `.Id` equal after push + pull | **no** | **no** |
| `RootFS.Layers` equal after push + pull | yes | yes |

**Surprise:** under the containerd image store, `.Id` is the index/manifest digest and changes
after push + pull of a single-platform image. Image identity must be compared by registry digest
or `RootFS.Layers`, never `.Id`. This applies to the engine too (Phase 12 image deploys).

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Pull from Docker Hub directly | Anonymous rate limits make CI flaky |
| GHCR in tests | D-10: no external registry in tests |
| Preload only (no mirror) | Every new base would need a manual preload step; kept only for the htpasswd registry |

## Numbers measured

| Measurement | 22.04 | 24.04 | Source |
|---|---|---|---|
| Combined D-04 kill of `docker build`, to absence | 180 ms | 179 ms | 11-06 |
| `kill -s TERM` group kill (`setsid -w`), to absence | 21 ms | 25 ms | 11-06 |
| node-api: context / build / time-to-healthy | 1100 B / 414 ms / 176 ms | 1100 B / 387 ms / 186 ms | 11-08 |
| static-app: context / build / time-to-healthy | 231 B / 199 ms / 154 ms | 231 B / 233 ms / 145 ms | 11-08 |
| failing-build: context / build / result | 0 B / 184 ms / exit 1, `exit code: 42` | 0 B / 190 ms / same | 11-08 |
| `startDeployEngineStack` (layers cached) | 24.5-29.5 s | 25.0 s (one 88.5 s outlier) | 11-03 |
| Cold image build | 36 s | 33 s | 11-03 |
| `contracts-g1-g2.test.ts`, both versions | 36/36 in 250.4 s | | 11-06 |
| `contracts-g3-g4.test.ts`, both versions | 22/22 in 247.5 s | | 11-07 |
| `fixtures.test.ts` | 7/7 in 95.8 s | 7/7 in 34.5 s | 11-08 |

Builds are warm (bases preloaded). Secret transfer time was not measured separately.

## Open items (Accepted 2026-10-04)

Items 1–4 resolved by user approval on 2026-10-04:

| # | Item | Resolution |
|---|---|---|
| 1 | G7 mirror (`mirror.gcr.io` pull-through) was chosen by the orchestrator, not by the user | ✓ User confirms the mirror; pull-through mirror of mirror.gcr.io stays |
| 2 | D-04 text says `kill -- -pgid`; measured working form is `kill -s TERM -- "-$pgid"` launched with `setsid -w` | ✓ Accept as a wording correction of D-04, not a change of mechanism |
| 3 | D-04's `docker kill` branch has no target during `docker build` (0 in every run) | ✓ Keep it as a safety net; it does not claim to kill BuildKit builds |
| 4 | The HTTPS-token clone path (`https_token`, `git_https_token` credential) was not measured; only the deploy key was | ✓ Measured in 12-06 (see below) |

Item 4, measured 2026-10-04 by `contracts-https-token.test.ts` (git-http-backend behind nginx
basic auth, per-run CA trusted by the deploy host, per-run random token):

| Check | 22.04 | 24.04 |
|---|---|---|
| Clone with the right token via `GIT_ASKPASS=<ws>/secrets/askpass` (token read from `<ws>/secrets/https_token`) | exit 0, SHA = seeded `main` | same |
| Wrong token | exit 128, `Authentication failed for '...'` → `REPOSITORY_AUTH_FAILED` | same |
| Modes: askpass / https_token / secrets dir | 700 / 600 / 700, owner deployer | same |
| Token (raw and basic-auth base64) in `ps`, `/proc/*/cmdline`, `/proc/*/environ`, `.git/config`, the clone tree, `remote get-url`, every chunk/tail/message | absent | absent |
| User `credential.helper=store` set globally | not used (`-c credential.helper=` resets it); no `~/.git-credentials` | same |
| After `removeWorkspace` | askpass, token file and workspace gone | same |

The helper has its own `askpass` slot under `<ws>/secrets` (no longer the `known_hosts` slot). It
is 0700, not 0600: git executes `GIT_ASKPASS` directly, without a shell.

Remaining open items:

| # | Item | Status |
|---|---|---|
| 5 | G3 detection reads help text; a future Docker CLI could change the `Usage:` line | Accepted risk: the contract test and captures fail on any change |
| 6 | All measurements on macOS arm64 Docker Desktop; the amd64 `ubuntu-latest` CI run of these files is not cited here | Confirm one green `main`/nightly run of `tests/integration/deploy-engine` before Phase 12 |
| 7 | 11-06 saw one unexplained Testcontainers `Failed to build image` on 22.04 (re-run passed) | Watch in CI; no contract impact |
| 8 | D-13 names `nginx:alpine`; the fixture pins `nginx:1.31-alpine@sha256:...` | Accept (tag readable, digest authoritative) |

## Consequences

- **11-10** (parsers): `docker_buildkit` parser on the first help line + stderr; `docker ps`
  NDJSON parser against the captured key set and shapes above.
- **11-11** (classifiers): `classifyGitError` and `classifyDockerError` key on the captured
  stderr markers, never exit codes.
- **11-12** (discovery): adds the `docker_buildkit` check and writes
  `servers.docker_buildkit_available`.
- **11-13** (allowlist templates): freezes the G1 transfer/login/workspace scripts, the G2 launch
  and kill scripts and the G4 `docker ps` flags exactly as written here; secrets only under
  `<ws>/secrets` (mode 700).
- **11-14** (streaming exec, remote kill): implements the combined G2 sequence (success only on
  confirmed absence) and stdin writes for G1.
- Phase 12 compares images by registry digest or `RootFS.Layers`, not `.Id`.
- No Phase 12 plan may be written before this ADR is Accepted (D-01).

## Cancel and build cache (Phase 12)

Measured in 12-13 (`runtime-cancel.test.ts`): each build killed mid-`RUN` leaves one BuildKit
record (`mount / from exec /bin/sh -c ...`, Mutable false, Usage count 0, ~8 kB, parent = base
layer). Context and Dockerfile `source.local` records are reused. `docker system df` Build Cache
went `7 / 234MB` → `8 / 234.1MB`; Images, Containers and Local Volumes were unchanged.

Decision (2026-10-05, `.planning/DECISIONS.md`): cancel cleanup is checked against `docker system df`
Images/Containers/Local Volumes only. BuildKit cache records are excluded from that parity and only
checked for bounded growth (≤ 64 kB per cancel in the test). Build cache is BuildKit-owned; its
retention and pruning belong to Phase 14 (D11/D12). Stall/timeout kills presumably leave the same record.

## Phase 12 Measurements

Soak measured on Ubuntu 24.04 only (sshd+dockerd, macOS arm64 Docker Desktop); knob-level verification in `docs/deploy-engine.md`:

| Measurement | Result | Test |
|---|---|---|
| 20 consecutive node-api deploys (same service) | 20/20 SUCCESS; p50 4036 ms, p95 5554 ms | `soak.test.ts` A1 |
| 20 create → deploy → delete cycles | 20/20 SUCCESS; per-cycle deploy p50 4033 ms; full cycle p50 4373 ms | `soak.test.ts` A2 |
| Cleanup parity: docker system df (Images/Containers/Volumes) | Baseline = final (two settled checks, no prune) | `soak.test.ts` A2 |
| Build logs per node-api deploy | not measured; 16,384 B line cap and 65,536 B phase cap truncation asserted | `runtime-build-logs.test.ts` |
| Reconcile tick (`docker ps --size=false`) cost | 34–37 ms on 22.04, 25–27 ms on 24.04 (50k-file layer) | Phase 11 contract table above; Phase 12 `runtime-reconcile.test.ts` A1 only asserts one `docker ps` per server per 5 s tick |

**Defaults confirmed and no adjustments needed:**

- `NOODARA_DEPLOY_LOG_MAX_BYTES = 10 MiB` per phase (kept; truncation behaviour verified at scaled-down caps)
- `NOODARA_DEPLOY_LOG_FLUSH_MS = 250 ms`, `NOODARA_DEPLOY_LOG_FLUSH_BYTES = 16 KiB` (live SSE chunk size validated)
- `NOODARA_RECONCILE_INTERVAL_MS = 30 s` (cost 25–37 ms per tick per the Phase 11 contract table, negligible at 30 s)
- `NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS = 10 min` (configurable cap enforced)
- All timeouts and concurrency knobs validated against range constraints in `env.ts`

**Open items:**

Item 6 (amd64 CI run of tests/integration/deploy-engine) remains **pending, requires a green GitHub amd64 CI run that does not exist yet**. No contract changes anticipated from amd64 since all contract tests (G1–G4) passed on
both Ubuntu 22.04 and 24.04 in Phase 11.
