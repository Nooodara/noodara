# ADR 0010: Reliable deploy contracts (healthcheck probes, `-prev` container, worker retry, state machine)

## Status

Accepted — 2026-10-14

## Context

v0.3 adds healthchecks, automatic and manual rollback, and crash recovery to the v0.2 engine
(ADR 0008). Before Phase 16 fixes the domain and schema, four questions need evidence: how the
server probes a container (A1, H1, H2), whether a stopped previous container can be kept and
restored (A2), what is safe to re-run after a worker crash (A3), and the shape and time budget of
the state machine (A4). User decisions #14-#19 (`.planning/DECISIONS.md`, 2026-10-14) already
fixed stop-then-start, the `-prev` rename and `ROLLED_BACK` as the end of the failed attempt.

Each measurement is a permanent contract test in
`tests/integration/deploy-engine/contracts-v03.test.ts` (gate `it-contracts-v03`, 28 tests,
green on 22.04 and 24.04). Titles start with `HC`, `PREV` or `RETRY / ADR 0010`. Raw numbers are
regenerated with `NOODARA_MEASUREMENTS_FILE=<file>`.

Environment: same fixture as ADR 0008 (`sshd-dockerd-ubuntu-{22.04,24.04}`, Docker 29.8.1),
macOS arm64 Docker Desktop, 2026-10-14. Bases: `node:22-alpine`, `nginx:1.31-alpine` (digest-pinned).

## A1: probe mechanism

### Decision

- The probe runs **on the server host** over SSH and connects to the **container IP on
  `noodara-net-<serviceId>`**, on the container port. The IP is read with `docker inspect` before
  every probe; an empty IP means the container is not running and the probe reports `exited`
  (no stale address is ever probed).
- HTTP probe: bash `/dev/tcp`, one HTTP/1.0 request, only the status line is read (≤ 64 bytes).
  TCP probe: `/dev/tcp` connect only. A `container` check (inspect `.State`) accompanies both.
- Every probe is wrapped as
  `env -i PATH=/usr/bin:/bin timeout -k 1 <s> bash --noprofile --norc -c '<constant script>' _ <ip> <port> [<path>]`.
  Output is one line: `NOODARA_PROBE http <code>|open|refused|empty|malformed|error`.
- No image is pulled and no container is started by a probe. curl is not used, so a server
  without curl needs no fallback.

Enforced by: `HC / ADR 0010 / A1: the host reaches the container IP on noodara-net-<serviceId> on an unpublished port; HTTP and TCP probes pull no image and start no container`,
`HC / ADR 0010 / A1: a stopped container has no IP on its network ...`, and the availability tests below.

### Measured

| Check | 22.04 | 24.04 |
|---|---|---|
| Stock `ubuntu` image: curl / wget / nc | absent | absent |
| Stock `ubuntu` image: bash with `/dev/tcp`, `timeout` | 5.1.16, yes | 5.2.21, yes |
| Deploy host curl | 7.81 (only because `install.sh` installs it) | 8.5 |
| `node:22-alpine` | no bash, no curl, busybox wget | same |
| `nginx:1.31-alpine` | curl + wget, no bash | same |
| Host → container IP, unpublished port | reachable | reachable |

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| curl on the host | Not on stock Ubuntu; measured: drains a streaming body until the timeout (exit 28 at ~2010 ms) and `~/.curlrc` `location` makes it follow a 302 (witness hit) |
| `docker exec` inside the service | Base images have no bash; `node:22-alpine` has no curl; depends on the user's image |
| Probe container (`--network noodara-net-<sid>`) | Pulls/starts an image per probe; implicit pull forbidden |
| Published host port | Many services publish no port; probes the proxy path, not the container |

## H1/H2: probe safety and cost

### Decision

- No redirects: a 3xx is a status result compared against the expected statuses (default
  200-399). The `Location` target is never contacted.
- `http://` only, to the container IP chosen in A1. Fixed request: `Host`, `User-Agent:
  noodara-healthcheck/1`, `Accept: */*`, `Connection: close`. No cookies, credentials, cache
  headers, env or secrets; the path is a validated argument, never interpolated into the script.
- `env -i` + `--noprofile --norc` keep session env, `BASH_ENV`, `~/.bashrc` and proxy variables out.
- Caps: `probeTimeout` 1-30 s (default 5); SSH exec timeout = probeTimeout + 5 s; exec output
  capped at 1 KiB; the body is never read.

Enforced by: `HC / ADR 0010 / H1: probe cost ...`, `H1: a hung endpoint and an unanswered connect end at the timeout cap (exit 124) ...`,
`H1: output is one status line; a large or never-ending body is not read ...`,
`H2: a 3xx is a status result; the redirect target is never contacted`,
`H1 / H2: the request is fixed (Host, User-Agent, Accept, Connection over HTTP/1.0); session env, BASH_ENV and proxies never reach it`.

### Measured (median / max ms per SSH exec, 10 runs, both versions)

| Probe | Cost |
|---|---|
| `docker inspect` (IP + state) | 10-11 / 13 |
| HTTP | 3 / 5 |
| TCP | 2-3 / 3 |
| Hung endpoint / unanswered connect, 2 s cap | exit 124 at 2006-2013 ms |
| `/big` and `/stream` bodies | one line in 8-64 ms; body canary never in output |

**Surprise:** under SSH a child bash ignores `BASH_ENV` but reads `~/.bashrc`
(`SSH_SOURCE_BASHRC`); without `SSH_CLIENT` it runs `BASH_ENV`. Only `env -i` plus `--norc`
closes both paths.

## A2: previous-container contract

### Decision

Deploy: `stop` current → `rename` to `noodara-<serviceId>-prev` → `create` + `start` new →
healthcheck. Rules:

- `rename` never overwrites: an existing `-prev` is handled explicitly first (reconcile/cleanup).
- **Never `start` `-prev` while the new container exists.**
- Restore order: `rm` new → `rename` `-prev` back → ensure network (`docker network connect`
  if detached) → `start` → `container` check.
- `-prev` keeps its labels; reconcile and cleanup recognise it explicitly. It is removed only
  after HEALTHCHECK passes.

Enforced by: `PREV / ADR 0010 / A2: a stopped container renamed to -prev frees the name and its published port; ...`
and `PREV / ADR 0010 / A2: starting -prev while the new container holds the port fails AND detaches -prev from its network; ...`.

### Measured (ms, both versions)

| Step | Cost |
|---|---|
| stop | 99-103 |
| rename | 11-12 |
| create + start | 89-103 |
| swap to first answer | 456-469 |
| restore | 392-397 |

Rename frees the name and the published port; the new container binds it; restoring `-prev`
brings the port back.

**Surprise:** `docker start <-prev>` while the new container holds the port fails **and detaches
`-prev` from its network**. A later start runs with no network, IP or port, and stop + start does
not repair it. Only `docker network connect` while stopped does. Hence the restore order above.

## A3: worker-retry rule

### Decision

- **No resume, no automatic re-enqueue**: BullMQ `attempts: 1`, `maxStalledCount: 0`.
- A job whose row is terminal exits without any remote command. `QUEUED` runs normally. Any other
  non-terminal row runs **crash recovery** (shared with the boot sweep): restore `-prev` if
  present, then end the row `FAILED` / `WORKER_CRASHED`. Recovery never removes the only version.

### Measured (why steps are not re-run)

| Step re-run after a crash | Result |
|---|---|
| `git clone` into the existing workspace | exit 128 |
| Rebuild with the same tag (cached) | **new** image id; the first id is dropped (containerd store, not dangling) |
| `docker create` on an existing name | Conflict, exit **1** (not 125) |
| `docker start` on a running container | exit 0 (silent no-op) |

Enforced by: `RETRY / ADR 0010 / A3: clone into an existing workspace fails, a same-tag rebuild yields a new image id ...`.

Rejected: resume from the last step (each step above needs its own idempotency handling and a
silent `start` hides the real state); automatic re-enqueue (re-runs remote side effects after an
unknown partial state).

## A4: state machine

### Decision

- 10 states. Transition table as in the 16-02 baseline plus `PREPARING → DEPLOYING`, used only
  by the manual rollback trigger (a new row that skips BUILDING).
- Auto-rollback: a failed HEALTHCHECK goes to ROLLING_BACK and ends `ROLLED_BACK` (end of the
  failed attempt, #15) or `FAILED` if restore fails.
- Cancellability: DEPLOYING honours cancel only after the swap section; cancel in HEALTHCHECK
  restores `-prev`; ROLLING_BACK is not cancellable (`409 ROLLBACK_IN_PROGRESS`).
- Budget inside `NOODARA_DEPLOY_MAX_MS`: healthcheck ≤ min(600 s, deployMax / 2); rollback a
  fixed 180 s inside `DEPLOY_CLEANUP_ALLOWANCE_MS` (300 s).

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Rollback as a separate row for auto-rollback | Splits one failed attempt across two rows; #15 ends it in `ROLLED_BACK` |
| Keep `DEPLOYING → SUCCESS` | Would skip the healthcheck |
| Manual rollback through BUILDING | Rebuild yields a new image id (A3); rollback must reuse the known image |
| Cancellable ROLLING_BACK | A half restore can leave no running version (A2 surprise) |
| Blue-green (both running) | Port held by the new container breaks `-prev` (A2); out of v0.3 scope (#14) |

## Consequences

- 16-02 (domain): states, transitions and the rollback edges above; budget derived from
  `NOODARA_DEPLOY_MAX_MS`.
- Phase 16 schema: healthcheck config with `probeTimeout` 1-30 s, expected statuses 200-399,
  `http://` path only.
- Engine: probe scripts and the `env -i` wrapper frozen in the allowlist as written in the
  contract test; IP read before each probe; restore order of A2; `-prev` handled by reconcile
  and cleanup.
- Worker: `attempts: 1`, `maxStalledCount: 0`; crash recovery shared with the boot sweep.
- No curl dependency is added to `install.sh` for probes.
