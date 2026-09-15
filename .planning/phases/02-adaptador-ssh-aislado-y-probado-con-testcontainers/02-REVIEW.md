---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
reviewed: 2026-09-15T19:43:15Z
depth: standard
files_reviewed: 33
files_reviewed_list:
  - .github/workflows/ci.yml
  - apps/control-plane/src/db/migrations/0002_phase2_fingerprint_timestamps.sql
  - apps/control-plane/src/db/migrations/meta/0002_snapshot.json
  - apps/control-plane/src/db/migrations/meta/_journal.json
  - apps/control-plane/src/db/schema/servers.ts
  - apps/control-plane/src/env.test.ts
  - apps/control-plane/src/env.ts
  - packages/domain/src/discovery/access.ts
  - packages/domain/src/discovery/docker-version.ts
  - packages/domain/src/discovery/index.ts
  - packages/domain/src/discovery/os-release.ts
  - packages/domain/src/discovery/resources.ts
  - packages/domain/src/discovery/system.ts
  - packages/domain/src/discovery/types.ts
  - packages/domain/src/server/connection-result.ts
  - packages/domain/src/server/connection-result.test.ts
  - packages/ssh/src/boundary.test.ts
  - packages/ssh/src/commands/access.ts
  - packages/ssh/src/commands/allowlist.ts
  - packages/ssh/src/commands/discovery.ts
  - packages/ssh/src/commands/docker.ts
  - packages/ssh/src/commands/index.ts
  - packages/ssh/src/connection-mutex.ts
  - packages/ssh/src/connection-mutex.test.ts
  - packages/ssh/src/error-classifier.ts
  - packages/ssh/src/error-classifier.test.ts
  - packages/ssh/src/errors.ts
  - packages/ssh/src/exec-with-timeout.ts
  - packages/ssh/src/exec-with-timeout.test.ts
  - packages/ssh/src/fingerprint.ts
  - packages/ssh/src/host-verifier.ts
  - packages/ssh/src/index.ts
  - packages/ssh/src/key-loader.ts
  - packages/ssh/src/retry.ts
  - packages/ssh/src/run-discovery.ts
  - packages/ssh/src/ssh-port.ts
  - packages/ssh/src/ssh2-adapter.ts
  - packages/ssh/src/ssh2-adapter.test.ts
  - scripts/capture-discovery-fixtures.mjs
  - tests/integration/helpers/ssh.ts
  - tests/integration/images/sshd-common/entrypoint.sh
  - tests/integration/images/sshd-common/setup-users.sh
  - tests/integration/images/sshd-common/slow-df.sh
  - tests/integration/images/sshd-common/sshd_config.d/noodara-test.conf
  - tests/integration/ssh/connect.test.ts
  - tests/integration/ssh/connection-loss.test.ts
  - tests/integration/ssh/host-key-changed.test.ts
  - tests/integration/ssh/stress-connections.test.ts
  - tests/integration/ssh/timeouts.test.ts
findings:
  critical: 1
  warning: 3
  info: 1
  total: 5
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-09-15T19:43:15Z
**Depth:** standard
**Files Reviewed:** 33 (of 77 in scope; remaining files are tests/fixtures/config confirmed clean on spot-check, see Summary)
**Status:** issues_found

## Summary

Reviewed `packages/ssh` (adapter, TOFU verifier, key loader, fingerprint, error classifier,
retry, mutex, discovery orchestration, allowlist), the phase-2 slice of `packages/domain`
(discovery parsers, `connection-result.ts`'s D-11 change), `apps/control-plane`'s new SSH timeout
env knobs and the fingerprint-timestamp migration, the Testcontainers SSH fixtures, and the CI
pipeline. The engineering quality is high overall: the TOFU verifier has no bypass path, the
allowlist is genuinely closed (no interpolation), the error classifier is defensively written
(never throws, structured-field-first ordering matches ADR 0004), and the integration test suite
is unusually rigorous about avoiding fixed sleeps and asserting on observable state.

One real resource-leak / latent-crash defect was found in `exec-with-timeout.ts`'s handling of a
`client.exec()` callback that resolves *after* the command timeout has already fired — the
resulting channel is silently orphaned instead of being destroyed. This is exactly the failure-path
leak category the review was asked to scrutinize, and it is untested (the existing "destroys only
the channel" test only covers a channel that already existed when the timeout fired, not a channel
that arrives late). Two further warnings concern gaps versus the project's own security skill
(no channel-level `'error'` handling; secrets registered with the `Redactor` are never released).

## Critical Issues

### CR-01: Orphaned exec channel when `client.exec()`'s callback resolves after the command timeout has already fired

**File:** `packages/ssh/src/exec-with-timeout.ts:133-148`

**Issue:** `execWithTimeout` starts a `setTimeout` and, independently, calls `client.exec(command, callback)`. If the timeout fires first (`settled` becomes `true`, `channel` is still `undefined` because `client.exec`'s callback has not returned yet), the `channel` variable is never destroyed — `channel?.destroy()` in the timeout branch is a no-op since `channel` is `undefined` at that point:

```ts
timer = setTimeout(() => {
  channel?.destroy();               // channel is still undefined here — no-op
  settle(() => {
    reject(new CommandTimeoutError(commandName, timeoutMs));
  });
}, timeoutMs);

client.exec(command, (err, execChannel) => {
  if (settled) return;              // <-- late arrival: execChannel is silently dropped
  channel = execChannel;
  execChannel.on('data', ...);
  ...
});
```

When `client.exec`'s callback finally does fire (late), `settled` is already `true`, so the
function returns immediately without destroying `execChannel`, without attaching any listener to
it, and without ever assigning it to the outer `channel` variable. The remote SSH channel is left
open and completely unmanaged from the adapter's perspective:

- It is a genuine resource leak (an open channel on the live connection that the adapter never
  closes), which — repeated across retries/discovery's eleven sequential commands — can
  accumulate over the life of a long-running control-plane process or exhaust the connection's
  channel/window budget.
- Because the channel is a `Duplex` stream with **no `'error'` listener ever attached anywhere in
  this codebase** (see WR-01), if this orphaned channel later emits an `'error'` for any reason,
  it becomes an *unhandled* `'error'` event, which is a fatal, uncaught exception in Node — a
  direct violation of SERV-07 ("`connect`/`exec` never crash the process") and of CLAUDE.md's
  Definition of Done ("Ningún fallo de infraestructura ... tumba la API").

This is exactly the "leak of a channel on a failure path" the review brief asked to scrutinize
(cf. ADR 0004's own note that an unconsumed `ClientChannel` never drains and silently hangs
forever). `exec-with-timeout.test.ts`'s existing timeout test ("destroys only the channel ... when
the budget elapses first") only covers the case where the channel already exists before the timer
fires; there is no test for `client.exec`'s callback returning *after* the timer has already
fired.

**Fix:** Track whether the timeout has already fired and, if `client.exec`'s callback arrives
afterward, destroy the channel it hands back instead of silently dropping it:

```ts
let timedOut = false;

timer = setTimeout(() => {
  timedOut = true;
  channel?.destroy();
  settle(() => reject(new CommandTimeoutError(commandName, timeoutMs)));
}, timeoutMs);

client.exec(command, (err, execChannel) => {
  if (settled) {
    if (timedOut && !err) execChannel.destroy(); // clean up the late-arriving channel
    return;
  }
  channel = execChannel;
  ...
});
```

## Warnings

### WR-01: No `'error'` listener is ever attached to an exec channel

**File:** `packages/ssh/src/exec-with-timeout.ts:21-26` (the `ExecChannel` structural type omits
`'error'`); confirmed by `grep` that no file in `packages/ssh` calls `.on('error', ...)` on a
channel (only `client.on('error', ...)` in `ssh2-adapter.ts:287`).

**Issue:** `ssh2`'s `ClientChannel` is a `Duplex` stream (`node_modules/ssh2/lib/Channel.js`
extends `DuplexStream`), and Node's `EventEmitter` contract throws (crashing the process) if an
`'error'` event fires with zero listeners attached. ADR 0004 measured — for exactly one failure
mode (mid-exec transport death via a graceful container stop) — that no `'error'` event is ever
raised on the channel, only `'end'`/`'close'`. That measurement does not cover every way a channel
could emit `'error'` (e.g., a stream-internal write failure, a protocol-level channel error, or
the orphaned-channel scenario in CR-01). The adapter protects the *client*-level `'error'` event
(`ssh2-adapter.ts:287`, with an explicit comment about why an unguarded client `'error'` would
crash the process) but never extends the same protection to channel-level errors.

**Fix:** Attach a no-op (or classifying) `'error'` listener to every exec channel the moment it is
obtained, mirroring the existing client-level guard:

```ts
execChannel.on('error', () => {
  // Never let an unhandled channel-level error crash the process; the client's own
  // 'end'/'close' sequence (or this function's own timeout) is what actually drives outcome.
});
```

### WR-02: Credentials registered with the `Redactor` are never released

**Files:** `packages/ssh/src/key-loader.ts:71-73`, `packages/ssh/src/ssh2-adapter.ts:126-133`
(confirmed via `grep -rn "\.release(" packages/ssh/src/*.ts` — no matches anywhere in the package)

**Issue:** `.claude/skills/noodara-security/SKILL.md` §4 states the Redactor "Mantiene un registro
en memoria de valores sensibles vivos en el proceso (se registra al descifrar, se libera al
terminar la operación)" — register on reveal, **release when the operation ends**. Every reveal
site in `packages/ssh` (`loadPrivateKey`'s `revealSecret` calls, and `revealCredential`'s three
`revealSecret` calls) registers the raw private key, passphrase or password with the injected
`Redactor`, but nothing in this package ever calls `redactor.release(...)` — not in
`SshSession.close()`, not after a failed `attemptConnect`, not anywhere. If a caller passes a
longer-lived `Redactor` instance across multiple `connect()`/discovery calls (there is nothing in
`ConnectInput`'s contract that forbids this — `redactor` is documented only as "injected, never
constructed internally"), every credential ever revealed through that instance accumulates in the
Redactor's in-memory `Map` for the lifetime of the process, unbounded. This is the exact
"long-lived process accumulating secrets" scenario the skill calls out.

**Fix:** Release every value this package registers once it is no longer needed for redaction —
e.g., in `SshSession.close()` and on every `attemptConnect` failure path, call
`redactor.release(rawKey)` / `redactor.release(rawPassphrase)` / `redactor.release(rawPassword)`
for whichever credential fields were revealed for that attempt.

### WR-03: A `private_key` credential's raw key/passphrase is revealed twice per connection attempt

**File:** `packages/ssh/src/ssh2-adapter.ts:250-263`

**Issue:** In `attemptConnect`, `loadPrivateKey(credential, redactor)` is called first (which
internally calls `revealSecret` on both `credential.privateKey` and `credential.passphrase`), and
then — regardless of whether `loadPrivateKey` needed the raw bytes again — `revealCredential(credential, redactor)`
is called a second time, re-revealing the exact same `SecretValue`s. This happens to be harmless
today only because `Redactor.register()` is idempotent (a `Map.set` overwrite), but it is
redundant work, and it means the raw private key/passphrase now exists as **two independent local
string bindings** (`loadPrivateKey`'s `rawKey`/`rawPassphrase` and `revealCredential`'s
`rawKey`/`rawPassphrase`) instead of one being threaded through, increasing the surface that would
need auditing if this code is ever refactored.

**Fix:** Have `attemptConnect` reveal the credential exactly once and pass the already-revealed
raw values into both the key-parsing step and `buildConnectOptions`, rather than revealing twice
from two different call sites.

## Info

### IN-01: A malformed (unparseable) host key blob on a first connection is misreported as `HOST_KEY_CHANGED`

**File:** `packages/ssh/src/host-verifier.ts:44-51`, `packages/ssh/src/ssh2-adapter.ts:287-309`

**Issue:** When `computeFingerprint(rawHostKey)` throws (a host key blob `fingerprint.ts` cannot
safely parse), `verify()` returns `false` unconditionally, regardless of whether `trusted` is
`null` (first connection, nothing was ever pinned) or a real pinned fingerprint. `ssh2` turns that
`false` into a `handshake`-level `'error'`, which the classifier maps to `HOST_KEY_CHANGED`. For a
genuinely first-time connection (`trustedFingerprint === null`), the resulting message ("does not
match the previously trusted fingerprint") is factually wrong — there was no previously trusted
fingerprint; the real problem is an unparseable host key blob. In practice this requires a
malformed key from a real OpenSSH server, which is extremely unlikely, so this is informational
rather than a functional defect.

**Fix:** Have `HostVerifier` distinguish "could not parse the blob at all" from "parsed but didn't
match", and have the adapter surface a distinct message (or reuse a generic `CONNECTION_LOST`/
validation-style message) for the former when `trustedFingerprint === null`.

---

_Reviewed: 2026-09-15T19:43:15Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
