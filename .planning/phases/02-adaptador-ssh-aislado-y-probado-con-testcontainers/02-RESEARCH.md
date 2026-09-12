# Phase 2: Adaptador SSH aislado y probado con Testcontainers - Research

**Researched:** 2026-09-12
**Domain:** SSH client adapter (ssh2), remote discovery over shell, Testcontainers-based sshd integration testing
**Confidence:** HIGH for `ssh2`/Testcontainers API shape (Context7, official docs), MEDIUM for exact Node/ssh2 error strings and Docker Desktop network-timeout behavior (cross-referenced but not executed in this session), LOW/ASSUMED for exact `/etc/os-release` and `docker version` sample byte-for-byte output (training-knowledge shape, not fetched from a live 22.04/24.04 box this session).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Credenciales SSH**
- D-01: OpenSSH and PEM private keys, ed25519/ECDSA/RSA (RSA min 2048 bits). UI recommends ed25519 (phase 5); adapter validates format/type and returns a clear validation error before attempting to connect.
- D-02: Encrypted private keys with passphrase accepted. Passphrase is an additional credential field, encrypted in the same AES-256-GCM envelope, delivered to the adapter as `SecretValue`. Wrong passphrase classifies as `AUTH_FAILED` without revealing more.
- D-03: For password credentials, try `password` and `keyboard-interactive` with the same password, answering only password prompts, no other prompts; any other prompt aborts with `AUTH_FAILED`.

**Host fingerprint (TOFU)**
- D-04: Fingerprint computed/stored as `SHA256:<base64 no padding>` over the host public key, matching `ssh-keygen -lf`, so the admin can compare it in their terminal.
- D-05: Accept ed25519, ECDSA, RSA host keys, negotiating ed25519 first. Store the type alongside the fingerprint (`ssh-ed25519 SHA256:...`); a key-type change counts as a host key change and produces `HOST_KEY_CHANGED`.
- D-06: On `HOST_KEY_CHANGED`, keep both fingerprints with their dates: `host_fingerprint` + `host_fingerprint_captured_at` (trusted) and `pending_fingerprint` + `pending_fingerprint_seen_at` (observed). This phase adds the two date columns by migration. The error message includes both fingerprints with type so the admin can verify before "Trust new fingerprint" (endpoint phase 4, UI phase 5).
- D-07: Never auto-accept a host key different from the pinned one; no "insecure" mode. On first successful connection (no previous fingerprint) it is captured and returned in the result for the application layer (phase 3) to persist.

**Timeouts and retries**
- D-08: Default timeouts: connect 10s, each command 30s, discovery total 60s. Independent: exceeding the first produces `CONNECT_TIMEOUT`, the second `COMMAND_TIMEOUT`, the third aborts discovery returning what was already collected plus `COMMAND_TIMEOUT` on the check in flight.
- D-09: Configurable only via global env vars validated in `env.ts` with sane ranges: `NOODARA_SSH_CONNECT_TIMEOUT_MS`, `NOODARA_SSH_COMMAND_TIMEOUT_MS`, `NOODARA_SSH_DISCOVERY_TIMEOUT_MS`. No per-server tuning in v0.1. The adapter receives values by parameter; it never reads `process.env`.
- D-10: A single automatic retry after a 2s wait, only for `CONNECT_TIMEOUT` and `CONNECTION_LOST`. `AUTH_FAILED`, `HOST_KEY_CHANGED`, `HOST_UNRESOLVED` and `COMMAND_TIMEOUT` are never retried. The result records `attempts` (1 or 2) for the activity log.

**Discovery under partial failures**
- D-11: A server with an OS other than Ubuntu 22.04/24.04 that connects successfully lands in `CONNECTED` with the `UNSUPPORTED_OS` warning and discovery completes anyway. This changes phase 1's mapping (`statusForErrorCode('UNSUPPORTED_OS')` returned `ERROR`): phase 2 updates the table in `packages/domain/src/server/connection-result.ts` (`UNSUPPORTED_OS → CONNECTED`), its tests, and the mirror `docs/domain/server-state-transitions.md`. `UNSUPPORTED_OS` becomes a warning code: stored in `last_error_code` for detail display, but does not block `CONNECTED`. v0.2 will block deploy on servers with this warning.
- D-12: Missing Docker is a warning, not a failure: `docker_installed = false`, null version, status `CONNECTED`. Detection uses `docker version --format '{{json .}}'` (never free-text parsing) and, if present, `docker compose version --short`. Installing Docker is out of scope for v0.1.
- D-13: Sudo and docker-group checks (SERV-08) run only for non-root users; for root they report `not_applicable`. For non-root: `sudo -n true` (pass/fail) and `docker` group membership via `id -nG` (pass/fail). A failed check is a warning with detail, not `ERROR`, in v0.1. Each discovery check is reported separately with `status: pass | fail | skipped | not_applicable`, `detail` and duration, feeding phase 5's step-by-step narrative (DISC-02).

### Claude's Discretion
- `packages/ssh` structure: client over `ssh2` with `SshPort` interface (`connect`, `exec(template, args)`, `close`) so a future agent can be an alternative adapter; no pool or persistent connections in v0.1 (phase 1's D-13).
- Command allowlist: fixed templates in `packages/ssh/src/commands/*.ts` (`discovery.hostname`, `discovery.os_release`, `discovery.cpu`, `discovery.memory`, `discovery.disk`, `discovery.uptime`, `docker.version`, `docker.compose_version`, `access.sudo`, `access.docker_group`). No user argument is ever interpolated into a shell string; if a template needs parameters, they are validated against a strict pattern and escaped via a tested function. A test asserts the template set is exactly this list and none contains `${`.
- Output parsers in `packages/domain` (pure, tested with real 22.04/24.04 fixtures): `/etc/os-release`, `nproc`, `/proc/meminfo`, `df -P` of root, `/proc/uptime`, `docker version` JSON.
- `ssh2` error classification to `ServerErrorCode`: explicit table in `packages/ssh` (ENOTFOUND/EAI_AGAIN → `HOST_UNRESOLVED`, ETIMEDOUT/handshake timeout → `CONNECT_TIMEOUT`, "All configured authentication methods failed" → `AUTH_FAILED`, host key mismatch → `HOST_KEY_CHANGED`, ECONNRESET/socket closed during exec → `CONNECTION_LOST`, exec with no response → `COMMAND_TIMEOUT`). Any unclassified error maps to `CONNECTION_LOST` with the redacted original message; never propagate an unhandled exception (SERV-07).
- Concurrency: one active connection per server inside the adapter (in-memory mutex); global limit lives in the worker (phase 4).
- Redaction: adapter returns stdout/stderr already passed through the Redactor with the credential registered; also truncates output to 64 KB per command.
- Test images: own Dockerfiles in `tests/integration/images/sshd-ubuntu-22.04/` and `sshd-ubuntu-24.04/` with `openssh-server`, a root user with key, a non-root sudo-NOPASSWD user and another without sudo, and `docker` CLI installed in one variant for the version check; built by Testcontainers from the Dockerfile with label `noodara.test=true`. Network scenarios: `HOST_UNRESOLVED` with a nonexistent name, `CONNECT_TIMEOUT` with an unroutable IP (`10.255.255.1`) and a short timeout, `CONNECTION_LOST` killing the container during a long command, `COMMAND_TIMEOUT` with a `sleep` longer than the timeout, `HOST_KEY_CHANGED` regenerating the container's host keys between connections, reconnection connecting again after a transient failure.
- Keepalive: `keepaliveInterval` 10s during discovery to detect connection loss before the command timeout.

### Deferred Ideas (OUT OF SCOPE)
- Per-server timeout tuning — post-v0.1 if the need appears.
- Auto-install Docker when missing — v2 (`SRVX-01`).
- SSH connection pool and installed agent — when continuous polling exists (v0.5) or the agent is decided.
- Blocking deploy on `UNSUPPORTED_OS` servers — v0.2.
- Network simulation with toxiproxy — only if the unroutable-IP and container-kill scenarios prove unstable.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SERV-07 | A connection failure produces a specific `error_code` (7 codes) with actionable message; the API never crashes | Error-classification table below (ssh2 error events → `ServerErrorCode`), "never throw unhandled" pattern in Code Examples, `applyConnectionResult` contract already in `packages/domain` |
| SERV-08 | Non-root SSH user with passwordless sudo is supported; validation checks `sudo -n` and docker group membership, reports each check | `access.sudo`/`access.docker_group` command templates, sample outputs, Pitfall 7 (TTY/sudo hang) mitigation |
| SEC-03 | Host fingerprint pinned on first successful connection (TOFU), shown to admin, later change fails with `HOST_KEY_CHANGED` until explicit re-confirmation | `hostVerifier`/`hostHash: 'sha256'` pattern, fingerprint format section, Pitfall 4 |
| SEC-04 | SSH commands come from an allowlist of templates without interpolating user input; every connection and command has an explicit timeout | Don't Hand-Roll section, per-exec timeout pattern (`Promise.race` + stream abort), Pitfall 9 |
| SEC-05 | stdout/stderr of remote commands pass through the redactor before being persisted or shown | Code Examples (`revealSecret`/`createRedactor` wiring), existing `packages/domain/src/security/redactor.ts` contract |
| DISC-01 | After CONNECTED, discover hostname, distro, OS version, arch, CPU cores, total RAM, total/used disk, uptime, Docker installed + version, using structured output and tested parsers | Discovery Commands table, sample fixtures, Pitfall 6 (fragile Docker detection) |
| DISC-04 | Unsupported OS reported as `UNSUPPORTED_OS` with a clear warning, without blocking the rest of the collected information | D-11 mapping change, `runDiscovery` partial-failure architecture |
| QA-03 | Integration suite uses Testcontainers with sshd for Ubuntu 22.04 and 24.04, covering: successful connection, invalid credentials, invalid host, network timeout, command timeout, connection loss, reconnect, safe command execution, cleaning up resources | Validation Architecture section, Testcontainers `fromDockerfile`/wait-strategy/`exec` patterns, Dockerfile skeletons |
</phase_requirements>

## Summary

This phase builds `packages/ssh`, a thin, allowlist-only adapter over `ssh2@1.17.0` (already the fixed choice in `.planning/research/STACK.md`) that turns "connect, run ~10 fixed command templates over one reused connection, disconnect" into a `ConnectionResult`/`DiscoverySnapshot` pair that `packages/domain` already knows how to consume (`applyConnectionResult`, `statusForErrorCode`). Nothing here is exploratory: `ssh2`'s `hostVerifier`+`hostHash: 'sha256'` gives TOFU almost for free (SEC-03), `ssh2` has no native per-exec timeout so every command must be wrapped in a `Promise.race` that also aborts the channel/connection (SEC-04, D-08), and Docker/sudo/group detection must use structured output (`--format '{{json .}}'`, `sudo -n`, `id -nG`) never free-text parsing (Pitfalls 6/7). The seven `ServerErrorCode` values are fixed in `packages/domain`; this phase's only job in that file is flipping `UNSUPPORTED_OS`'s landing status per D-11 and adding an explicit ssh2-error-to-code classification table that lives in `packages/ssh`, not `packages/domain` (domain stays I/O-free).

Testing is the other half of this phase's weight: QA-03 requires two real Ubuntu sshd containers (22.04, 24.04) built from project-owned Dockerfiles via Testcontainers' `GenericContainer.fromDockerfile()`, covering eight scenarios including a container-kill mid-command and a host-key regeneration between connections — none of which are mockable in a way that would actually de-risk the adapter, consistent with `.planning/research/ARCHITECTURE.md`'s explicit call to de-risk SSH early against real infrastructure. `ssh2` itself passed slopcheck `[OK]` this session (repo `github.com/mscdex/ssh2`, ~1.1MB unpacked, actively maintained); it needs no new npm command beyond what STACK.md already specified (`pnpm --filter @noodara/ssh add ssh2`), and ships its own TypeScript types (no separate `@types/ssh2` needed for v1.x).

**Primary recommendation:** Build `packages/ssh` as a pure adapter (`Ssh2Adapter implements SshPort`) with all command templates, timeout wrapping, and error classification internal to the package; keep parsers of command *output* in `packages/domain` (pure, fixture-tested) per the existing domain/ssh boundary; test exclusively against real Testcontainers-built sshd images, never a mocked `ssh2.Client`, for every QA-03 scenario.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| SSH transport, auth, TOFU fingerprint verification | `packages/ssh` (adapter, I/O) | — | Owns the only `ssh2.Client` in the codebase; nothing else may import `ssh2` directly (Turborepo boundaries) |
| Command allowlist templates + arg escaping | `packages/ssh` | — | Templates are shell text; building/escaping the string is inseparable from the exec call that sends it |
| ssh2-error → `ServerErrorCode` classification | `packages/ssh` | — | Depends on `ssh2`'s error shapes (`err.level`, `err.code`), which `packages/domain` must never import |
| Parsing of remote command *output* (`/etc/os-release`, `/proc/meminfo`, `docker version` JSON, ...) | `packages/domain` | — | Pure string→struct transforms with zero I/O; belongs where the ≥95% branch-coverage gate already lives |
| `ConnectionResult`/`ServerErrorCode`/`statusForErrorCode` contract | `packages/domain` (existing) | `packages/ssh` (consumer) | Already built in phase 1; this phase only edits the `UNSUPPORTED_OS` mapping row (D-11) |
| Migration `0002` (fingerprint capture timestamps) | `apps/control-plane` (Drizzle schema + SQL migration) | — | Only persistence artifact this phase touches, per the CONTEXT.md exception |
| Discovery orchestration (`runDiscovery`) | `packages/ssh` | — | Sequences the ~10 templates over one reused connection; still pure result-producing, no DB writes (phase 3 persists) |
| Per-server / global SSH concurrency limits | `packages/ssh` (per-server mutex) | `apps/control-plane` worker (global, phase 4) | This phase only needs the in-memory per-server guard; the BullMQ concurrency knob is phase 4 scope |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ssh2` | 1.17.0 `[VERIFIED: npm registry]` (confirmed via `npm view ssh2 version`; recommendation itself is `[CITED: .planning/research/STACK.md]`, already the fixed roadmap choice) | Raw SSH2 protocol client | Pure-JS, gives direct access to `hostVerifier`/`hostHash` (required for TOFU), no native exec timeout to fight around, stream-level stdout/stderr separation for redaction. De facto standard Node SSH library (Dokploy uses it directly per STACK.md). |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `testcontainers` + custom `GenericContainer.fromDockerfile()` images | 12.1.0 (already a root devDependency, confirmed installed) `[VERIFIED: npm registry]` | Ephemeral real sshd containers for QA-03 | Every integration test in this phase; no mocked `ssh2.Client` for connection-outcome scenarios |
| `@noodara/domain` (workspace) | workspace:* | `ServerErrorCode`, `SecretValue`/`revealSecret`, `createRedactor`, `validateHost`/`validateSshUser` | Every adapter call that needs a decrypted credential, a redactor, or an error-code union |

No new production dependency beyond `ssh2` itself — `ssh2` ships its own `.d.ts` (no `@types/ssh2` needed for the 1.x line; STACK.md's `pnpm add -D @types/ssh2` line is stale guidance from before this was confirmed `[VERIFIED: npm registry — ssh2's own package.json has no separate @types/ssh2 peer]`).

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `ssh2` (raw) | `node-ssh` (promise wrapper) | Simpler exec/SFTP API but hides `hostVerifier` fine-grained control and per-command stream access needed for TOFU + timeout-abort + redaction; STACK.md already rejected this for the same reason. |
| Project-owned Testcontainers `sshd` Dockerfiles | `linuxserver/openssh-server` prebuilt image | Prebuilt image doesn't let us pre-provision the exact non-root/sudo/docker-CLI user matrix D-13/QA-03 need without runtime `exec()` setup on every test run; a custom Dockerfile bakes the fixture once and is cached by Docker's layer cache across test runs. |
| Unroutable IP (`10.255.255.1`) for `CONNECT_TIMEOUT` | `toxiproxy` network-fault injection | CONTEXT.md's own Deferred Ideas defers toxiproxy "only if the unroutable-IP and container-kill scenarios prove unstable" — start simple, escalate only on observed CI flakiness. |

**Installation:**
```bash
pnpm --filter @noodara/ssh add ssh2
```
(No `@types/ssh2` — confirmed unnecessary for the pinned 1.17.0 line.)

**Version verification:** `npm view ssh2 version` → `1.17.0`, `time.modified` → `2026-05-13`, `repository.url` → `git+ssh://git@github.com/mscdex/ssh2.git` (matches the canonical `mscdex/ssh2` GitHub org used by Context7 — no typosquat risk).

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `ssh2` | npm | Long-established (`mscdex/ssh2`, pre-2015 origin per training data; latest 1.17.0 published 2026-05-13) | Very high (millions/week; de facto standard Node SSH lib) | `github.com/mscdex/ssh2` | `[OK]` | Approved |

**Packages removed due to slopcheck `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none.

slopcheck ran successfully this session (`pip install slopcheck --break-system-packages` succeeded, binary present at `/Library/Frameworks/Python.framework/Versions/3.14/bin/slopcheck`). `slopcheck install ssh2` returned `[OK]`. Note: slopcheck's own `install` subcommand attempted a real `npm install ssh2` as a side effect inside this monorepo working directory; it failed harmlessly on the `workspace:*` protocol used by this repo's other dependencies and produced **zero** filesystem changes (verified via `git status --porcelain` before/after — clean). Future invocations of `slopcheck install` in a pnpm-workspace repo should be run from a scratch/temp directory to avoid this side effect entirely, even though it was a no-op here.

## Architecture Patterns

### System Architecture Diagram

```text
Application service (phase 3, not built yet)
        │
        │  connect(target: SshTarget, credential: SecretValue)
        ▼
┌───────────────────────────────────────────────────────────┐
│ packages/ssh                                               │
│                                                              │
│  SshPort interface: connect / exec(template, args) / close  │
│         │                                                    │
│         ▼                                                    │
│  Ssh2Adapter (only ssh2.Client user in the codebase)         │
│         │                                                    │
│    ┌────┴─────────────────────────────────┐                 │
│    │ 1. client.connect({                  │                 │
│    │      host, port, username,           │                 │
│    │      privateKey|password,            │                 │
│    │      readyTimeout: connectTimeoutMs, │                 │
│    │      keepaliveInterval: 10_000,      │                 │
│    │      hostHash: 'sha256',             │                 │
│    │      hostVerifier,                   │  ◄── TOFU (SEC-03)
│    │      algorithms.serverHostKey: [     │                 │
│    │        'ssh-ed25519', 'ecdsa-...',   │                 │
│    │        'rsa-sha2-512', ...]          │                 │
│    │    })                                │                 │
│    └────┬─────────────────────────────────┘                 │
│         │ 'ready' event  ──────────────────► success path    │
│         │ 'error' event  ──────────────────► classify() ─────┼──► ServerErrorCode
│         │                                                    │
│         ▼                                                    │
│  exec(templateName, args) for each of ~10 discovery          │
│  commands, ONE reused connection, each wrapped in            │
│  Promise.race([execPromise, commandTimeoutTimer])            │
│  — on timeout: destroy the channel, do NOT destroy the       │
│  connection unless the whole discovery timeout fires         │
│         │                                                    │
│         ▼                                                    │
│  stdout/stderr → createRedactor().redact() → truncate 64KB   │
│         │                                                    │
│         ▼                                                    │
│  close() → client.end()                                      │
└───────────────────────────────────────────────────────────┘
         │
         ▼
  ConnectionResult | DiscoverySnapshot (pure data, phase 3 persists)
         │
         ▼
  packages/domain parsers (pure, fixture-tested):
  parseOsRelease / parseMeminfo / parseDf / parseUptime / parseDockerVersion
```

### Recommended Project Structure
```
packages/ssh/
├── src/
│   ├── ssh-port.ts              # SshPort interface (connect/exec/close)
│   ├── ssh2-adapter.ts          # Ssh2Adapter implements SshPort
│   ├── host-verifier.ts         # TOFU hostVerifier factory (SEC-03)
│   ├── fingerprint.ts           # SHA256:<base64 no padding> computation, key-type tagging
│   ├── error-classifier.ts      # ssh2 error → ServerErrorCode table (SERV-07)
│   ├── key-loader.ts            # OpenSSH/PEM parseKey wrapper, passphrase handling (D-01/D-02)
│   ├── exec-with-timeout.ts     # Promise.race + channel-abort wrapper (SEC-04, D-08)
│   ├── commands/
│   │   ├── index.ts             # frozen allowlist export + "no ${" test target
│   │   ├── discovery.ts         # discovery.hostname/os_release/cpu/memory/disk/uptime templates
│   │   ├── docker.ts            # docker.version / docker.compose_version templates
│   │   └── access.ts            # access.sudo / access.docker_group templates
│   ├── run-discovery.ts         # orchestrates all ~10 templates over one connection
│   └── index.ts                 # public exports
├── package.json                 # exports map to dist (ADR 0003 contract)
├── tsconfig.build.json
tests/integration/ssh/
├── connect.test.ts               # successful connection, invalid credentials, invalid host
├── timeouts.test.ts               # network timeout, command timeout
├── connection-loss.test.ts        # connection loss, reconnect
├── host-key-changed.test.ts       # HOST_KEY_CHANGED via container key regeneration
├── discovery.test.ts              # full runDiscovery against both Ubuntu versions
└── command-allowlist.test.ts      # safe command execution / injection rejection
tests/integration/images/
├── sshd-ubuntu-22.04/Dockerfile
└── sshd-ubuntu-24.04/Dockerfile
packages/domain/src/discovery/     # NEW subpath — pure parsers
├── os-release.ts / os-release.test.ts
├── meminfo.ts / meminfo.test.ts
├── disk.ts / disk.test.ts
├── uptime.ts / uptime.test.ts
├── docker-version.ts / docker-version.test.ts
└── fixtures/                       # real captured outputs, 22.04 + 24.04
```

### Pattern 1: TOFU host verification with `hostHash: 'sha256'`
**What:** `ssh2`'s `hostVerifier` receives the host key already reduced to a hex digest when `hostHash: 'sha256'` is set — not the raw key bytes, not the OpenSSH `SHA256:<base64>` string. This phase must independently obtain the raw host public key (to tag its type per D-05) and separately compute the OpenSSH-style base64 fingerprint (D-04), because `hostVerifier`'s hex digest is not directly usable for either.
**When to use:** Every `connect()` call, always — no "insecure" bypass path exists per D-07.
**Example:**
```typescript
// Source: Context7 /mscdex/ssh2 "Strict Host Key Verification" + README hostHash option
import { Client, type ParsedKey } from 'ssh2';
import { createHash } from 'node:crypto';

// hostHash:'sha256' makes hostVerifier's `key` arg a *hex string* of the digest, not the raw key.
// To get D-04's ssh-keygen -lf format (base64, no padding) AND D-05's key-type tag, verify
// against the raw key by omitting hostHash and hashing/parsing ourselves instead:
function computeFingerprint(rawHostKey: Buffer): string {
  const digest = createHash('sha256').update(rawHostKey).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`; // strip padding to match ssh-keygen -lf
}

client.connect({
  host,
  port,
  username,
  readyTimeout: connectTimeoutMs,
  // Omit hostHash — verify the *raw* key so we can both type-tag it (D-05) and compute the
  // ssh-keygen-compatible fingerprint (D-04) from the same bytes.
  hostVerifier: (rawHostKey: Buffer): boolean => {
    const observed = computeFingerprint(rawHostKey);
    const keyType = parseKey(rawHostKey).type; // e.g. 'ssh-ed25519'
    if (trustedFingerprint === null) {
      capturedFingerprint = `${keyType} ${observed}`; // D-07: first-connect capture
      return true;
    }
    return `${keyType} ${observed}` === trustedFingerprint; // false => ssh2 emits an 'error'
  },
  algorithms: { serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256'] }, // D-05: ed25519 first
});
```
`[CITED: github.com/mscdex/ssh2 configuration.md via Context7]` for the `hostVerifier`/`hostHash` shape; the "omit `hostHash` and hash the raw key ourselves" strategy is `[ASSUMED]` — Context7's docs confirm `hostHash: 'sha256'` pre-hashes for you but do not document the raw-key path in the same snippet, so this must be verified with a real Testcontainers connection during Wave 0 before relying on it (see Open Questions).

### Pattern 2: Per-command timeout (ssh2 has no native exec timeout)
**What:** Wrap every `client.exec()` in a `Promise.race` against a timer; on timeout, destroy the returned stream/channel (not necessarily the whole connection) and reject with a timeout-shaped error the classifier maps to `COMMAND_TIMEOUT`.
**When to use:** Every one of the ~10 discovery command templates (D-08, SEC-04).
**Example:**
```typescript
// Pattern synthesized from ARCHITECTURE.md §4 ("ssh2 has no native per-exec timeout; wrap each
// client.exec() call in a Promise.race against a timer that also kills the stream") — [CITED:
// .planning/research/ARCHITECTURE.md]. ssh2's own exec()/Channel API surface (on('data'),
// on('close'), stream.destroy()) is [CITED: Context7 /mscdex/ssh2 client.md].
function execWithTimeout(client: Client, command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream?.destroy(); // kill only this channel, not the whole connection
      reject(new CommandTimeoutError(command, timeoutMs));
    }, timeoutMs);

    let stream: import('ssh2').ClientChannel | undefined;
    client.exec(command, (err, s) => {
      if (err) { clearTimeout(timer); reject(err); return; }
      stream = s;
      let stdout = '', stderr = '';
      stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      });
    });
  });
}
```

### Pattern 3: Non-interactive sudo probe (never hangs on a TTY prompt)
**What:** `sudo -n true` fails immediately (non-zero exit, no prompt) instead of blocking on a nonexistent TTY when the user lacks NOPASSWD sudo — this is the entire fix for Pitfall 7.
**When to use:** `access.sudo` template, always `-n`, never bare `sudo`.
**Example:**
```bash
# access.sudo template — exit 0 => pass, exit 1 => fail (no password configured or wrong user),
# never hangs because -n refuses to read a TTY/password prompt.
sudo -n true
```
`[CITED: .planning/research/PITFALLS.md Pitfall 7]`, cross-referenced against standard `sudo(8)` manual behavior (`-n`/`--non-interactive`: "avoid prompting the user for input of any kind... if a password is required... exits with an error").

### Anti-Patterns to Avoid
- **String-concatenating any identifier into a command template:** Dokploy's GHSA-fcgq-jjfg-hrhj (CVSS 9.9) is the exact failure mode PITFALLS.md #9 documents — a `cleanAppName()` that only trimmed/lowercased let `appName` reach `execAsync` unescaped. This phase's templates take **zero** user-supplied identifiers in v0.1 (all ten commands are fully static strings); the escaping-function requirement in CONTEXT.md is forward-looking infrastructure for v0.2, not something v0.1's fixed templates currently need arguments for — but the allowlist-equals-exact-list test must still exist now.
- **Parsing `docker --version`'s free-text output:** rejected explicitly by both STACK.md ("What NOT to Use" — `systeminformation`, free-text Docker parsing) and Pitfall 6; use only `docker version --format '{{json .}}'`.
- **Using a persistent/pooled SSH connection:** ARCHITECTURE.md explicitly rejects this for v0.1's "connect, run ~10 commands, disconnect" workload — connect-per-job is correct here, not a shortcut.
- **Retrying `AUTH_FAILED` or `HOST_KEY_CHANGED`:** D-10 explicitly forbids it — these are not transient, and retrying them either wastes time or (for `HOST_KEY_CHANGED`) risks looking like an auto-accept.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SSH protocol implementation | A custom SSH2 wire-protocol client | `ssh2` | Already the fixed roadmap choice; implementing SSH2 framing/crypto from scratch is an enormous, security-critical undertaking with zero product value |
| Private key parsing (OpenSSH/PEM, ed25519/ECDSA/RSA, passphrase) | A custom ASN.1/OpenSSH-key-format parser | `ssh2`'s `utils.parseKey` | Handles OpenSSH, RFC4716, and PPK formats plus passphrase decryption already; a hand-rolled parser is exactly the kind of crypto code that gets subtly wrong |
| Remote system introspection | `systeminformation` npm package pointed at a remote host somehow | Plain shell commands over the existing SSH connection | `systeminformation` introspects the **local** process's machine — fundamentally the wrong tool for a **remote** target (STACK.md's own explicit rejection) |
| Docker version compatibility parsing | A regex against `docker --version`'s free-text banner | `docker version --format '{{json .}}'` structured output | Docker's free-text format has changed across versions (Pitfall 6, with real Coolify GitHub issues as evidence); JSON output is stable and distinguishes "not installed" from "unrecognized format" |
| Command-injection prevention | Ad-hoc `.replace()`/blocklist sanitization of any interpolated value | Strict allowlist regex validated *before* string construction, applied at the domain layer | Dokploy's real CVE (GHSA-fcgq-jjfg-hrhj) is the canonical proof that partial sanitization (trim + lowercase) is not sufflicient |

**Key insight:** Every "don't hand-roll" item above already has a documented real-world failure (a GitHub issue or a CVE) from Coolify or Dokploy — the two closest architectural precedents to Noodara. This phase's job is to apply the already-known fix, not to discover a new one.

## Common Pitfalls

### Pitfall 1: TOFU that silently downgrades to "accept anything" (PITFALLS.md #4)
**What goes wrong:** `hostVerifier` implemented to always return `true`, or a missing `hostVerifier` entirely (ssh2 accepts any host key by default if none is supplied).
**Why it happens:** Getting a first successful connection working is easier without host-key friction; the omission is easy to miss in a quick manual test since the connection just "works."
**How to avoid:** A unit test that asserts `hostVerifier` is always provided to every `client.connect()` call path (no code path omits it), plus the Testcontainers `HOST_KEY_CHANGED` scenario that regenerates the container's host key and asserts the *second* connection is rejected.
**Warning signs:** Any `connect()` call in the codebase without a `hostVerifier` key; a "quick test" script that hardcodes `verify(true)`.

### Pitfall 2: Fragile Docker version detection (PITFALLS.md #6)
**What goes wrong:** Treating a JSON-parse failure the same as "Docker not installed," or treating any non-zero exit code as "not installed" when it could mean "daemon not running but CLI present" (a distinct, useful signal per D-12's `docker_installed`/version split).
**Why it happens:** `docker version` without `--format` produces human-oriented free text whose shape has changed across Docker releases; a parser written against one version's output silently misclassifies another's.
**How to avoid:** Only ever call `docker version --format '{{json .}}'`; treat "binary not found" (shell reports command-not-found, distinguishable exit code/stderr) differently from "binary found, daemon unreachable" (Docker CLI itself reports this distinctly in its JSON `.Server` being absent/null vs. the whole call erroring) differently from "JSON parse failed" (should never silently collapse into `docker_installed = false`).
**Warning signs:** A single boolean derived from a try/catch around JSON.parse with no distinct log/code for "unexpected format."

### Pitfall 3: sudo/TTY hang (PITFALLS.md #7)
**What goes wrong:** A bare `sudo <command>` over a non-interactive `ssh2.exec()` channel (no PTY requested) blocks waiting for a password prompt that can never be answered, consuming the entire command timeout (or worse, hanging past it if the timeout wrapper itself has a bug).
**Why it happens:** ssh2's `exec()` does not allocate a PTY by default, and `sudo` without `-n`/`NOPASSWD` tries to read a password from a terminal that doesn't exist.
**How to avoid:** `access.sudo` template is always `sudo -n true`, never bare `sudo`; combined with the per-command timeout wrapper as a second line of defense, not the primary one.
**Warning signs:** A discovery run taking close to the full command-timeout budget in manual testing; any template containing `sudo` without `-n`.

### Pitfall 4: Connection-state flapping from single transient failures (PITFALLS.md #8)
**What goes wrong:** A single connect attempt lost to a brief network blip (or ssh/UFW rate-limiting) immediately and permanently marks the server `UNREACHABLE`, even though the very next attempt would succeed.
**Why it happens:** Treating every connection attempt as ground truth with no distinction between "transient" and "confirmed" failure.
**How to avoid:** D-10's single-retry-after-2s rule for `CONNECT_TIMEOUT`/`CONNECTION_LOST` is the v0.1-scoped mitigation (not the fuller "3 consecutive fast failures" scheme PITFALLS.md sketches for the state machine more broadly — that pattern is about *periodic health checks*, which don't exist yet in v0.1; this phase's scope is the single connect+discovery attempt with its one retry).
**Warning signs:** A CI run of the "100 consecutive successful connections" acceptance criterion (§6.7) showing occasional single-attempt failures that a retry would have masked.

### Pitfall 5: Command injection via template arguments (PITFALLS.md #9, Dokploy CVSS 9.9)
**What goes wrong:** Any future template parameter (v0.1 has none, but the allowlist infrastructure must not regress when v0.2 adds them) gets string-concatenated into a shell command with only partial sanitization (trim/lowercase), not a strict allowlist regex validated *before* string construction.
**Why it happens:** String concatenation is the path of least resistance; "sanitizing" post-hoc via `.replace()` never covers every shell metacharacter.
**How to avoid:** This phase's ten command templates are 100% static strings (verified: none takes a runtime-interpolated identifier) — the allowlist-exactness test (`no template contains '${'`) is the regression guard for the future, not a fix for a current vulnerability.
**Warning signs:** Any template string built with a template literal referencing a variable that isn't already one of the ten fixed template names.

## Code Examples

### Loading a private key with optional passphrase (D-01, D-02)
```typescript
// Source: Context7 /mscdex/ssh2 utils.md "parseKey()"
import { utils } from 'ssh2';

function loadPrivateKey(pem: string, passphrase?: string): ParsedKey {
  const result = utils.parseKey(pem, passphrase);
  if (result instanceof Error) {
    // Distinguish "wrong passphrase" from "malformed key" is NOT exposed as a distinct error
    // type by parseKey's return contract (both come back as a generic Error) — the adapter must
    // map both to a validation-error result (D-01) or AUTH_FAILED (D-02: wrong passphrase),
    // never propagate the raw parseKey Error message (may include partial key bytes/comment).
    throw new InvalidCredentialError('Unable to parse private key');
  }
  return result; // .type gives 'ssh-ed25519' | 'ecdsa-sha2-...' | 'ssh-rsa' for D-01's type check
}
```
`[CITED: github.com/mscdex/ssh2 utils.md via Context7]` for the parseKey signature and return shape; the "both wrong-passphrase and malformed-key return a generic Error" claim is `[ASSUMED]` from Context7's documented return type (`object|array|Error`, no distinct error subclasses documented) — verify empirically in Wave 0 unit tests with a real encrypted-key fixture and a deliberately wrong passphrase.

### Keyboard-interactive password auth restricted to password-only prompts (D-03)
```typescript
// Source: Context7 /mscdex/ssh2 configuration.md "Keyboard-Interactive Authentication"
client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
  const allPasswordPrompts = prompts.every((p) => /password/i.test(p.prompt));
  if (!allPasswordPrompts) {
    finish([]); // abort — D-03: any non-password prompt aborts with AUTH_FAILED
    return;
  }
  finish(prompts.map(() => revealSecret(credential))); // same password for every prompt
});
```

### Discovery command templates (fixed, static, no interpolation)
```typescript
// Source: STACK.md "SSH Discovery" table + ARCHITECTURE.md §4, cross-checked against
// standard Ubuntu 22.04/24.04 utilities (coreutils, procps) [ASSUMED exact byte-for-byte output
// shape — verify against the Testcontainers fixtures built in Wave 0]
export const DISCOVERY_COMMANDS = {
  'discovery.hostname': 'hostname',
  'discovery.os_release': 'cat /etc/os-release',
  'discovery.cpu': 'nproc',
  'discovery.memory': 'cat /proc/meminfo',
  'discovery.disk': 'df -P -k /',
  'discovery.uptime': 'cat /proc/uptime',
  'docker.version': 'docker version --format \'{{json .}}\'',
  'docker.compose_version': 'docker compose version --short',
  'access.sudo': 'sudo -n true',
  'access.docker_group': 'id -nG',
} as const satisfies Record<string, string>;

// Regression guard (CONTEXT.md's own required test):
for (const cmd of Object.values(DISCOVERY_COMMANDS)) {
  if (cmd.includes('${')) throw new Error('template contains interpolation marker');
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `docker version` free-text parsing | `docker version --format '{{json .}}'` | JSON format available since Docker 23.0.5+ (well before Ubuntu 22.04/24.04's shipped Docker versions) | Eliminates an entire class of version-drift parsing bugs (Pitfall 6) |
| `docker-compose` (v1 standalone binary) | `docker compose` (v2 plugin) | Docker Compose v1 deprecated; v2 is what both Coolify and Dokploy install | This phase's `docker.compose_version` template must use the v2 `docker compose version --short` subcommand form, not a `docker-compose --version` fallback |

**Deprecated/outdated:**
- `node-ssh` and similar promise-wrapper libraries: fine for simple exec/SFTP but insufficient for this phase's `hostVerifier`/timeout/redaction requirements — STACK.md already rejected this path.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Omitting `hostHash` and hashing the raw host key ourselves (rather than using `hostHash: 'sha256'`'s pre-hashed hex digest) is a valid, supported `ssh2` usage that still triggers `hostVerifier` correctly | Architecture Patterns → Pattern 1 | If wrong, TOFU fingerprint capture (D-04/D-05) needs a different code path (e.g., hashing the hex-digest string instead of raw bytes, which would NOT match `ssh-keygen -lf`'s output) — must be verified with a real Testcontainers connection in Wave 0 before other tasks depend on it |
| A2 | `utils.parseKey`'s wrong-passphrase and malformed-key failures are both a generic `Error` with no distinguishing subclass/code | Code Examples → Loading a private key | If wrong (e.g., a distinguishable error message/code exists), the adapter could give a more precise validation message than "unable to parse" for D-01 vs D-02's cases — not a correctness risk, only a UX-quality one |
| A3 | Exact `/etc/os-release`, `/proc/meminfo`, `df -P -k /`, `/proc/uptime`, and `docker version --format json` output shapes for Ubuntu 22.04/24.04 match training-data-typical formats | Code Examples, Discovery Commands, Don't Hand-Roll | If actual container output differs (e.g., a Docker daemon absent in the base image, or a `/proc/meminfo` field renamed), parser fixtures written from assumption instead of real captured output will pass tests against fabricated data and fail against a real server — Wave 0 MUST capture real output from the built Testcontainers images before writing final parser fixtures, not rely on this research's examples verbatim |
| A4 | An unroutable IP (`10.255.255.1`) plus a short `readyTimeout` reliably produces a TCP-connect-level timeout (not an immediate `ECONNREFUSED`/`ENETUNREACH`) on both macOS Docker Desktop and GitHub `ubuntu-latest` runners | Standard Stack → Alternatives Considered, Environment Availability | If the network stack returns an immediate unreachable error instead of hanging until `readyTimeout`, the `CONNECT_TIMEOUT` scenario needs a different simulation (e.g., a Docker network with a dropped route, or a firewalled port) — flagged explicitly for Wave 0 validation, with toxiproxy as CONTEXT.md's own documented fallback |
| A5 | `ssh2`'s "All configured authentication methods failed" is thrown as an `Error` on the `'error'` client event (not surfaced only via `'close'` with no error) with no `err.code`, only a message string, when both password and keyboard-interactive fail | Error classification (Don't Hand-Roll / Architecture) | If the error shape differs (e.g., a distinguishing `err.level === 'client-authentication'` field that IS present — some ssh2 error objects do carry a `level` field per Context7's own generic error-event docs), the classifier should prefer that structured field over message-string matching; Wave 0 unit/integration tests must assert the actual shape observed against a real Testcontainers sshd with wrong credentials before finalizing the classifier |

**If this table is empty:** N/A — five assumptions require Wave 0 empirical verification before the corresponding implementation tasks are considered safe to build on.

## Open Questions (DEFERRED TO 02-04 / ADR 0004)

Resolution of all three questions below is deferred by design to plan 02-04 (Wave 0 empirical spikes) and recorded in `docs/adr/0004-ssh-adapter-empirical-contracts.md`; no implementation plan in this phase may assume an answer before that ADR exists.

1. **Does `ssh2`'s `hostVerifier` fire with the raw key Buffer when `hostHash` is omitted, and does `utils.parseKey` accept that same raw Buffer to extract `.type`?**
   - What we know: Context7's docs confirm `hostHash: 'sha256'` pre-hashes the argument passed to `hostVerifier`; the README states "otherwise it is the raw host key in Buffer form" when `hostHash` is unset.
   - What's unclear: whether `utils.parseKey` (documented for private/public *key files*) also correctly parses the raw host-key-exchange blob `hostVerifier` receives, which may be in SSH wire format rather than a PEM/OpenSSH-file format `parseKey` expects.
   - Recommendation: First Wave-0 task should be a throwaway integration test against a Testcontainers sshd that logs the raw `hostVerifier` argument's shape and confirms `parseKey`(or a lower-level `ssh2` binding for parsing the wire-format host key) yields a usable `.type` and matches `ssh-keygen -lf`'s fingerprint output on the same container. If `parseKey` doesn't accept the wire-format blob, fall back to manually reading the SSH wire format's algorithm-name prefix string (first length-prefixed field of the key blob) for the type tag — SSH host key blobs always begin with a length-prefixed algorithm name per RFC 4253.

2. **Exact structured shape of `docker version --format '{{json .}}'` when the Docker daemon is unreachable vs. when the `docker` binary itself is absent.**
   - What we know: D-12 requires distinguishing "not installed" (no binary) from installed-but-daemon-down is out of scope (D-12 treats "Docker absent" as one boolean); the CLI-not-found case is a shell-level "command not found" (exit 127, no JSON at all) while an installed CLI with an unreachable daemon still emits a JSON `.Client` block with `.Server` null/absent and a non-zero exit code.
   - What's unclear: the exact non-zero exit code and whether stderr also contains non-JSON text that would break a naive `JSON.parse(stdout)`.
   - Recommendation: Capture this directly from the `sshd-ubuntu-22.04`/`24.04` Testcontainers image variant that has the `docker` CLI installed with no daemon (per CONTEXT.md's own test-image plan) during Wave 0, before finalizing `packages/domain`'s `docker-version.ts` parser and its fixtures.

3. **Whether GitHub Actions `ubuntu-latest` runners' Docker networking allows an unroutable-IP TCP connect attempt to hang (producing a real timeout) rather than failing fast with `ENETUNREACH`.**
   - What we know: On many Linux hosts, a `SYN` to an address like `10.255.255.1` with no matching route can return `ENETUNREACH` near-instantly rather than hanging; whether that's true inside a GitHub-hosted runner's specific network namespace/Docker bridge setup is unverified in this session (no live GHA run performed).
   - What's unclear: CI-specific network behavior differs from local macOS Docker Desktop, which was the environment implicitly assumed in CONTEXT.md's scenario description.
   - Recommendation: Wave 0 should run the `CONNECT_TIMEOUT` scenario test once in the actual CI environment (not just locally) before relying on it as a stable scenario; CONTEXT.md's own Deferred Ideas already names toxiproxy as the fallback if this proves unstable.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker daemon | Testcontainers (all of QA-03) | ✓ (assumed present per phase-1 precedent — `pnpm test:integration` already runs Testcontainers-based Postgres tests successfully in this repo) | — | none needed |
| `ssh2` npm package | `packages/ssh` adapter | ✓ | 1.17.0 (registry-confirmed) | — |
| Testcontainers `GenericContainer.fromDockerfile` | Building the two sshd images | ✓ (testcontainers 12.1.0 already a root devDependency, confirmed via `npm view` matching installed version) | 12.1.0 | — |

No missing dependencies identified for this phase; Docker daemon availability during actual execution (not just this research session) should still be spot-checked at the start of implementation, consistent with phase 1's own precedent (`pnpm test:integration` needing "a reachable Docker daemon").

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.0 (existing root config) |
| Config file | `vitest.config.ts` (unit), `vitest.integration.config.ts` (integration) — both existing |
| Quick run command | `pnpm test --filter @noodara/ssh` / `pnpm test --filter @noodara/domain` |
| Full suite command | `pnpm test && pnpm test:integration` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SERV-07 | Every `ssh2` error shape maps to exactly one of the 7 `ServerErrorCode`s, never throws unhandled | unit | `pnpm vitest run packages/ssh/src/error-classifier.test.ts` | ❌ Wave 0 |
| SERV-08 | `access.sudo`/`access.docker_group` report pass/fail/not_applicable correctly for root, sudo-NOPASSWD, and no-sudo users | integration | `pnpm test:integration -- tests/integration/ssh/discovery.test.ts` | ❌ Wave 0 |
| SEC-03 | First connect captures fingerprint; second connect with regenerated host key produces `HOST_KEY_CHANGED` with both fingerprints | integration | `pnpm test:integration -- tests/integration/ssh/host-key-changed.test.ts` | ❌ Wave 0 |
| SEC-04 | Command template set is exactly the allowlist, none contains `${`; every exec has a timeout that fires | unit + integration | `pnpm vitest run packages/ssh/src/commands/index.test.ts` + `pnpm test:integration -- tests/integration/ssh/timeouts.test.ts` | ❌ Wave 0 |
| SEC-05 | stdout/stderr redacted before being returned from `exec`/`runDiscovery` | unit | `pnpm vitest run packages/ssh/src/exec-with-timeout.test.ts` | ❌ Wave 0 |
| DISC-01 | Parsers correctly extract hostname/distro/version/arch/cpu/ram/disk/uptime/docker from real fixture output | unit | `pnpm vitest run packages/domain/src/discovery/*.test.ts` | ❌ Wave 0 |
| DISC-04 | `runDiscovery` against a non-Ubuntu (or unsupported-version) fixture still completes and reports `UNSUPPORTED_OS` as CONNECTED+warning | unit + integration | `pnpm vitest run packages/domain/src/server/connection-result.test.ts` (D-11 mapping) | Partial — file exists (phase 1), needs new case |
| QA-03 | All eight roadmap §6.5 scenarios pass against real Ubuntu 22.04 and 24.04 sshd containers, cleaning up resources | integration | `pnpm test:integration -- tests/integration/ssh/` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted `pnpm vitest run <changed-file>.test.ts` (unit) for domain parsers and the error classifier; a single scenario's integration test for adapter changes.
- **Per wave merge:** `pnpm test` (full unit) + `pnpm test:integration -- tests/integration/ssh/` (all eight QA-03 scenarios, both Ubuntu versions).
- **Phase gate:** Full `pnpm test && pnpm test:integration` green, plus a manual/CI check that no stray `noodara.test=true` containers remain (existing pattern from `tests/integration/helpers/postgres.ts`).

### Wave 0 Gaps
- [ ] `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` and `sshd-ubuntu-24.04/Dockerfile` — base images with `openssh-server`, root+key user, sudo-NOPASSWD non-root user, no-sudo non-root user; one variant per version also needs the `docker` CLI binary installed (no daemon) for the `docker.version`/`docker.compose_version` template tests.
- [ ] `tests/integration/helpers/ssh.ts` — a `startSshd()` Testcontainers helper mirroring `postgres.ts`'s pattern (`GenericContainer.fromDockerfile(...).withLabels({'noodara.test': 'true'}).withExposedPorts(22)`, appropriate `Wait` strategy for sshd readiness).
- [ ] `packages/ssh` package scaffold (`package.json`, `tsconfig.build.json`, `tsconfig.json`) following the exact ADR 0003 contract `packages/domain` already proves out (dist-pointing `exports`, `vitest.shared.ts` source-alias addition for in-process tests).
- [ ] Empirical verification of Open Questions #1–#3 (hostVerifier raw-key shape, Docker-no-daemon JSON shape, CI unroutable-IP timeout behavior) before finalizing the corresponding implementation tasks.
- [ ] Migration `0002` adding `host_fingerprint_captured_at`/`pending_fingerprint_seen_at` (timestamptz nullable) — needs a from-snapshot migration test extending phase 1's `01-08` pattern (previous snapshot = migration `0001`).
- [ ] `NOODARA_SSH_CONNECT_TIMEOUT_MS` / `NOODARA_SSH_COMMAND_TIMEOUT_MS` / `NOODARA_SSH_DISCOVERY_TIMEOUT_MS` additions to `apps/control-plane/src/env.ts` using the existing `parseTuningInt` helper (D-09) — the adapter itself takes these as parameters, never reading `process.env` directly (per CONTEXT.md).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | SSH key/password auth via `ssh2`; passphrase-protected keys via `utils.parseKey`; no credential logged (SecretValue/Redactor) |
| V3 Session Management | no | No SSH session persistence in v0.1 (connect-per-job, D-13 from phase 1) |
| V4 Access Control | partial | Non-root sudo/docker-group checks (SERV-08) are informational discovery checks, not an access-control enforcement boundary within this phase |
| V5 Input Validation | yes | Command allowlist + strict regex validation of any future template parameter (none in v0.1); `validateHost`/`validateSshUser` (existing `packages/domain` validators) |
| V6 Cryptography | yes | Host fingerprint via SHA-256 (`node:crypto`, never hand-rolled); private key parsing via `ssh2`'s own `utils.parseKey` (never a custom ASN.1 parser) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Command injection via template arguments | Tampering | Static command templates with zero interpolation in v0.1; strict allowlist regex + escape-before-construct for any future parameter (Dokploy GHSA-fcgq-jjfg-hrhj precedent) |
| TOFU bypass / silent host-key acceptance | Spoofing | `hostVerifier` mandatory on every `connect()`, never a hardcoded `true`; explicit `HOST_KEY_CHANGED` rejection with no auto-accept path (D-07) |
| Credential leakage in stdout/stderr/logs/exceptions | Information Disclosure | `SecretValue`/`revealSecret(secret, redactor)` registration before any command send; `createRedactor().redact()` applied to all exec output before it leaves `packages/ssh`; 64KB truncation to bound log volume |
| sudo/TTY hang causing worker resource exhaustion | Denial of Service | `sudo -n` (never interactive); per-command timeout wrapper as defense-in-depth; per-server connection mutex bounding concurrent SSH sessions per server |
| Docker version parsing producing false negatives/positives | Tampering (of trust in reported state) | Structured `--format '{{json .}}'` only, explicit `PARSE_ERROR` distinct from `NOT_INSTALLED` (never collapsed) |
| Rate-limited sshd causing false `UNREACHABLE` flapping | Denial of Service (self-inflicted) | D-10's single retry after 2s for transient error codes only |

## Sources

### Primary (HIGH confidence)
- Context7 `/mscdex/ssh2` — `hostVerifier`/`hostHash` configuration, `keyboard-interactive` event, `utils.parseKey`, `error` event shape, `client.exec()`/channel pattern.
- Context7 `/testcontainers/testcontainers-node` — `GenericContainer.fromDockerfile()` (`withBuildArgs`, `withTarget`, custom Dockerfile name, `withCache(false)`), `Wait.forLogMessage`/`Wait.forSuccessfulCommand`, `container.exec()`, `container.stop({timeout})`, `withExposedPorts`.
- `npm view ssh2` (registry query, this session) — version 1.17.0, `repository.url` = `git+ssh://git@github.com/mscdex/ssh2.git`, dependencies (`asn1`, `bcrypt-pbkdf`), last modified 2026-05-13.
- `npm view testcontainers version` / `npm view @testcontainers/postgresql version` (registry query, this session) — both 12.1.0, matching the already-installed root devDependency.
- `slopcheck install ssh2` (this session) — `[OK]` verdict.

### Secondary (MEDIUM confidence)
- `.planning/research/STACK.md` (this project's completed sibling research) — `ssh2` 1.17.0 selection rationale, SSH discovery command table, "what not to use" (`systeminformation`, free-text Docker parsing).
- `.planning/research/ARCHITECTURE.md` — `SshPort` interface design, connect-per-job rationale, per-exec-timeout `Promise.race` pattern, concurrency limits.
- `.planning/research/PITFALLS.md` — Pitfalls 4 (TOFU), 6 (Docker detection, with real Coolify GitHub issue numbers as evidence), 7 (sudo/TTY hang), 8 (flapping), 9 (command injection, with real Dokploy GHSA CVE as evidence).
- WebSearch (this session) — cross-referenced `hostVerifier` boolean-vs-callback return shape and "All configured authentication methods failed" as a known, common ssh2/ssh2-based-library error message (GitHub issues #604, #21 on related repos).

### Tertiary (LOW confidence — flagged in Assumptions Log)
- Exact `/etc/os-release`, `/proc/meminfo`, `df -P -k /`, `/proc/uptime`, `docker version --format json` byte-for-byte output shapes for Ubuntu 22.04/24.04 — standard/well-known Linux utility output shapes from training knowledge, not captured from a live container this session (A3).
- `ssh2`'s raw host-key Buffer format accepted by `utils.parseKey` when `hostHash` is omitted (A1) — Context7 confirms the two halves (hostHash behavior; parseKey's documented input of key *files*) but not their combination.
- GitHub Actions `ubuntu-latest` network behavior toward an unroutable IP (A4) — not verified against a live CI run this session.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `ssh2`/Testcontainers versions and core API shapes confirmed via Context7 + npm registry; no new dependency decisions needed (STACK.md already fixed the choice).
- Architecture: HIGH — `SshPort`/adapter boundary, connect-per-job, and package structure are directly inherited from `.planning/research/ARCHITECTURE.md`'s already-completed design work plus this repo's proven ADR 0003 build contract.
- Pitfalls: HIGH for the five documented pitfalls (each backed by a real Coolify/Dokploy GitHub issue or CVE) — MEDIUM for the exact runtime behaviors flagged in the Assumptions Log (A1–A5), which require Wave 0 empirical verification against real Testcontainers-built images before implementation proceeds past the first task.

**Research date:** 2026-09-12
**Valid until:** 2026-10-12 (30 days — `ssh2`/Testcontainers are stable, slow-moving libraries; the assumptions requiring live verification are time-boxed to Wave 0 of this phase, not to research staleness)
