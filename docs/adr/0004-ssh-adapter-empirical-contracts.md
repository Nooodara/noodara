# ADR 0004: SSH adapter empirical contracts (Wave 0 spikes)

## Status

Accepted — 2026-09-14

## Context

02-RESEARCH.md flagged three open questions as unverified assumptions
(A1/A3/A4/A5 in its Assumptions Log) that later phase-2 plans — the TOFU
fingerprint capture (02-06), the discovery parsers (02-05), and the error
classifier (02-07) — cannot be written against without guessing:

1. What `ssh2`'s `hostVerifier` actually hands the caller when `hostHash`
   is omitted, and whether `utils.parseKey` can extract the host key's
   algorithm name from that same value.
2. The exact structured shape of `docker version --format '{{json .}}'`
   when the `docker` binary is absent versus when it is present but the
   daemon is unreachable.
3. Which `CONNECT_TIMEOUT` simulation strategy is genuinely deterministic,
   and the real `ssh2` error shape (`level`/`code`/`errno`/`syscall`/
   `message`) for every failure mode SERV-07's classifier must map to one
   of the seven `ServerErrorCode`s.

This plan (02-04) answers all three by measurement against the real
Ubuntu 22.04/24.04 sshd fixtures built in plans 02-01/02-02, using a raw
`ssh2.Client` (re-exported test-only from `packages/ssh/src/testing/raw-ssh2.ts`
as `@noodara/ssh/testing`, since `packages/ssh/src/boundary.test.ts`
forbids importing `ssh2` itself from any file outside `packages/ssh`) —
the adapter itself does not exist until plan 02-06. `tests/integration/ssh/contracts.test.ts`
is a permanent, standing test file: every fact recorded below has a
corresponding assertion that fails if a future `ssh2` upgrade changes it.

All measurements below were taken on macOS (Apple Silicon, arm64) running
Docker Desktop — every place this matters for reproducing the same
measurement on GitHub `ubuntu-latest` (a native-Linux, x86_64 runner) is
called out explicitly rather than silently assumed to generalize.

## Open Question 1: hostVerifier's raw-key contract and TOFU fingerprint (D-04/D-05, A1/A2)

### Decision

`ssh2`'s `hostVerifier` (when `hostHash` is omitted from `connect()`) is
called with the **raw SSH wire-format host key blob as a `Buffer`** — not
a string, not a pre-hashed value. Measured for an ed25519 host key: `typeof`
is `'object'`, `Buffer.isBuffer(...)` is `true`, and the buffer is exactly
51 bytes (4-byte length prefix + 11-byte `"ssh-ed25519"` + 4-byte length
prefix + 32-byte public key — RFC 4253 §6.6's own layout, confirmed byte
for byte).

**Both candidate techniques for extracting the algorithm name work,
and 02-RESEARCH.md's recommended technique (a) is the one plan 02-06 must
use:**

- **(a) `utils.parseKey(rawArgument).type`** — measured to return a real
  `ParsedKey` with `.type === 'ssh-ed25519'` (and `'ssh-rsa'` /
  `'ecdsa-sha2-nistp256'` for the other two types below), **not** an
  `Error`. This was the open question: `parseKey`'s own source
  (`node_modules/ssh2/lib/protocol/keyParser.js`) tries every
  printable-string key format first (PEM, OpenSSH, PPK, RFC4716) — all of
  which fail against binary wire-format data — before falling back to a
  binary-format branch that reads a length-prefixed type string then hands
  the remainder to `parseDER(data, type, ...)`. RFC 4253's host-key-blob
  layout happens to satisfy exactly that binary branch's expectations, so
  `parseKey` accepts the raw `hostVerifier` argument directly with no
  wrapping or reformatting.
- **(b) manual RFC 4253 decode** (`buf.readUInt32BE(0)` for the
  length, then `buf.subarray(4, 4 + length).toString('ascii')`) — also
  measured to work, and is what `contracts.test.ts`'s first test asserts
  directly (independent of `parseKey`, as a second, simpler oracle).

**Recommendation for plan 02-06: use technique (a), `utils.parseKey`.** It
is one call with no hand-rolled byte offsets, and `contracts.test.ts`
proves it produces the identical algorithm name technique (b) does, for
all three accepted host key types.

**Default negotiation already picks ed25519 first, no override needed.**
`ssh2`'s `lib/protocol/constants.js` unshifts `'ssh-ed25519'` onto the
front of `DEFAULT_SERVER_HOST_KEY` whenever the Node runtime's own
`eddsaSupported` flag is set (true on every Node version this project
targets). A connection against a fixture offering all three host key
types, with no `algorithms.serverHostKey` override, negotiates
`ssh-ed25519`. D-05's "negotiate ed25519 first" requirement is therefore
satisfied by `ssh2`'s own default — plan 02-06 does not need to pass an
explicit `algorithms.serverHostKey` list unless it wants to *restrict*
accepted types, which D-05 does not ask for (it asks to accept all three).

**The fingerprint equivalence (D-04) holds byte-for-byte, no tolerance,
for all three accepted host key types:**

```
SHA256:<base64(sha256(rawHostVerifierBuffer)), padding stripped>
  === the "SHA256:..." field of `ssh-keygen -lf` on the same container's host key
```

Measured and asserted in `contracts.test.ts` for ed25519, RSA (forcing
`algorithms.serverHostKey: ['rsa-sha2-512']`) and ECDSA (forcing
`['ecdsa-sha2-nistp256']`). One RSA-specific wrinkle, itself measured
rather than assumed: forcing the legacy `'ssh-rsa'` (SHA-1) algorithm name
produced a **fatal handshake error, `"Handshake failed: no matching host
key format"`** — this fixture's OpenSSH server does not offer plain
`ssh-rsa` for host-key signing at all (modern OpenSSH disables SHA-1 host
key signatures by default). `'rsa-sha2-512'` must be used to reach the RSA
host key; the wire-format blob itself still reports its stored type as
`ssh-rsa` (`ssh2`'s own kex.js has an explicit exception for exactly this:
`hostPubKeyType === 'ssh-rsa'` is accepted when the negotiated algorithm
was `rsa-sha2-256`/`rsa-sha2-512`), which is why `parseKey(...).type` and
the manual decode both report `'ssh-rsa'` even though the connection asked
for `'rsa-sha2-512'`.

### A2: passphrase-protected key parse errors (wrong passphrase vs. malformed key)

Both failures come back from `utils.parseKey` as a plain `Error` — there
is no distinct subclass, `.name`, or other own property distinguishing
them (02-RESEARCH.md's own premise for A2 holds). **They are, however,
distinguishable by message text**, measured verbatim:

| Input | `utils.parseKey` result |
|---|---|
| Correct passphrase | Returns a real `ParsedKey` (`.type === 'ssh-ed25519'`), not an `Error`. |
| Wrong passphrase | `Error: OpenSSH key integrity check failed -- bad passphrase?` |
| Truncated/malformed key | `Error: Unsupported key format` |

**Plan 02-06's key loader may say "wrong passphrase" specifically**
(matching on the "bad passphrase?" substring, case-insensitively) and
fall back to a generic "unable to parse private key" message for every
other `parseKey` failure — never propagating either message verbatim to
an end user, per D-02's "classified as `AUTH_FAILED` without revealing
more."

## Open Question 2: Docker version detection shapes (D-12, A3)

### Decision

Three distinct, measured shapes, captured from the real fixture images
into `packages/domain/src/discovery/fixtures/ubuntu-{22.04,24.04}/`
(`README.md` in that directory documents which file is which, and which
shapes are captured versus explicitly out of reach for this fixture
matrix):

| Scenario | Command | Exit code | stdout | stderr |
|---|---|---|---|---|
| `docker` binary absent (plain image) | `docker version --format '{{json .}}'` | **127** | *(empty)* | `sh: 1: docker: not found` |
| `docker` binary absent (plain image) | `docker compose version --short` | **127** | *(empty)* | `sh: 1: docker: not found` |
| CLI present, daemon unreachable (`dockerCli: true` image) | `docker version --format '{{json .}}'` | **1** | Valid JSON: `{"Client":{...},"Server":null}` | `failed to connect to the docker API at unix:///var/run/docker.sock; ...` |
| CLI present, daemon unreachable (`dockerCli: true` image) | `docker compose version --short` | **0** | `5.5.1\n` | *(empty)* |

Measured identically for Ubuntu 22.04 and 24.04 (Docker's own apt
repository ships the same `docker-ce-cli`/`docker-compose-plugin` build
for both `jammy` and `noble` at capture time). **stderr never contaminates
stdout** in either failure case — `JSON.parse(stdout)` is safe to call
directly without stripping anything, and the "not found" case never
produces anything that looks like JSON on stdout at all. Both facts are
asserted directly in `contracts.test.ts` against the real fixture images
(not only recorded as static files), so a future Docker CLI release that
changes either shape fails a standing test rather than silently
invalidating the fixtures.

**D-12's parser must therefore branch on exit code, not on
`JSON.parse` success/failure alone:**

- Exit 127 (or any outcome where `stdout` is empty/non-JSON) →
  `docker_installed = false`.
- Exit 1 (or non-zero) **with valid JSON on stdout containing a `Client`
  key and a `null`/absent `Server` key** → `docker_installed = true`,
  version read from `Client.Version`, daemon status reported separately
  (out of DISC-01's v0.1 scope beyond the boolean split D-12 asks for).
- Valid JSON on stdout that fails to parse for any other reason (should
  not occur given the two shapes above, but Pitfall 2 forbids collapsing
  this into `docker_installed = false` silently) → a distinct
  parse-error path, never silently treated as "not installed".

The captured `Client.Arch` field reads `"arm64"` in every fixture in this
ADR, because the fixtures were built on an Apple Silicon host. **This is
expected to read `"amd64"` on GitHub `ubuntu-latest`** (an x86_64 runner)
— the parser must never assume a fixed `Arch` value; the fixtures'
`Version`/`ApiVersion`/`GitCommit` fields are similarly host-build-specific
and are captured as real examples of the shape, not as fields the parser
should assert exact values for.

**Not capturable from this fixture matrix:** the "Docker daemon present
and responding" shape (a populated, non-null `.Server` key). Building a
working Docker-in-Docker daemon inside the sshd fixture image is out of
scope for this phase's Testcontainers setup. Plan 02-05 must test that
branch against a **derived** fixture — hand-written from Docker's own
documented JSON schema and clearly labelled as derived, never saved
alongside the captured files in a way that could be mistaken for
measured reality (`packages/domain/src/discovery/fixtures/README.md`
states this explicitly).

## Open Question 3: CONNECT_TIMEOUT strategy and the ssh2 error-shape table (D-10, SERV-07, A4, A5)

### Decision: `startBlackholeListener` (candidate (a)), after fixing a real bug in it

**Candidate (a), the accept-then-silent TCP listener built in plan 02-02,
is the chosen strategy — but as originally implemented it did not
actually blackhole, and measurement caught this before any downstream
plan could inherit the bug.**

Plan 02-02's original `startBlackholeListener` ran
`while true; do nc -l -p 9000; done` (BusyBox `nc`, no `-e`). Measured
result: `ssh2` failed in **2ms**, not at the configured `readyTimeout`,
with `{ message: 'Connection lost before handshake', level: 'protocol' }`
— a completely different, non-timeout shape. Root cause (confirmed by
directly testing several `nc` invocations against a raw `ssh2.Client`):
plain BusyBox `nc -l` pipes the accepted socket to its own stdin/stdout;
the moment `ssh2`'s client writes its identification banner immediately
after connecting, that `nc` process's stdout write fails (nothing sane is
consuming it) and `nc` exits, resetting the connection. The `while true`
loop respawns a new `nc` for the *next* connection, but the one accepting
the current test's connection had already torn it down.

**Fix (applied to `tests/integration/helpers/ssh.ts` in this plan):**
`nc -lk -p 9000 -e /bin/sleep infinity`. `-e` hands the accepted socket's
stdin/stdout to `sleep infinity`, a process that never reads or writes
it — nothing is ever echoed back and nothing ever causes `nc` to exit —
and `-k` (BusyBox's own "persistent server" flag, documented as requiring
`-e`) lets one long-lived `nc` process accept every connection, removing
the shell-loop respawn race entirely. Re-measured after the fix: two
sequential connection attempts against the same listener both failed with
`{ message: 'Timed out while waiting for handshake', level: 'client-timeout' }`
at `2001ms` and `1501ms` against configured `readyTimeout`s of `2000ms`
and `1500ms` respectively — a clean, deterministic `readyTimeout`, exactly
as the candidate was always supposed to produce.

**Candidates (b) and (c) were also measured, on this machine, and
rejected:**

| Candidate | Setup | Measured result (macOS Docker Desktop) | Why rejected |
|---|---|---|---|
| (b) Docker-internal address, no route from host | The sshd fixture's own container-internal bridge IP (`fixture.container.getIpAddress('bridge')`, e.g. `172.17.0.4:22`), reached directly from the host, port unpublished | `Timed out while waiting for handshake` at `~2002ms` for a `2000ms` `readyTimeout` — a clean timeout, same shape as (a) | Docker Desktop's VM-per-container networking makes the container-internal bridge IP unroutable from the macOS host, producing this timeout — but on GitHub `ubuntu-latest` (native Linux Docker, no VM layer), the host **can** typically route directly to a container's bridge IP. This candidate's behaviour is Docker-networking-mode-dependent in a way (a) is not; not measured against `ubuntu-latest` in this session, and not chosen given (a) works once fixed. |
| (c) `10.255.255.1` (02-CONTEXT.md's original sketch) | Direct connection attempt to the fixed unroutable-range address | `Timed out while waiting for handshake` at `~2002ms` for a `2000ms` `readyTimeout` — also a clean timeout on this machine | 02-RESEARCH.md's own open question 3 flags that many Linux hosts return `ENETUNREACH` near-instantly for this address rather than hanging — behaviour this session's macOS host did not exhibit, but which was never measured against GitHub `ubuntu-latest` either. Given (a) is provably host-network-independent (TCP-level accept, no route lookup involved) once the `nc` invocation is fixed, there is no reason to depend on a host- or CI-runner-specific routing quirk. **This candidate's `ubuntu-latest` behaviour was not measured in this session — no CI-environment claim is made about it.** |

`startBlackholeListener` remains the chosen, already-built primitive for
every downstream CONNECT_TIMEOUT scenario in plans 02-05..02-10; no
change to its call signature was needed, only to the container command it
starts.

### ssh2 error-shape table (SERV-07, A5)

Measured verbatim against the real fixtures, one row per failure mode.
`err.level` is present and reliable everywhere except the plain-refused-port
case — the classifier should prefer `level` (and `code` where present)
over any message-string match, exactly as A5 flagged.

| # | Failure mode | `level` | `code` | `errno`/`syscall` | `message` (verbatim) | Elapsed |
|---|---|---|---|---|---|---|
| 1 | Wrong password (`pwuser`) | `client-authentication` | — | — | `All configured authentication methods failed` | ~2.3s (keyboard-interactive fallback round trip) |
| 2 | Valid-but-unauthorized key (`ed25519_unauthorized` against `deployer`) | `client-authentication` | — | — | `All configured authentication methods failed` | ~20ms |
| 3 | Correct key, wrong/nonexistent username | `client-authentication` | — | — | `All configured authentication methods failed` | ~24ms |
| 4 | Hostname under `.invalid` TLD (NXDOMAIN) | `client-timeout` | — | — | `Timed out while waiting for handshake` | full `readyTimeout` (measured 5002ms for a 5000ms configured timeout) |
| 5 | Host/port of a stopped container (refused) | `client-socket` | `ECONNREFUSED` | (Node socket-level `errno`/`syscall`, no `level`-specific extras beyond `code`) | *(empty string — Node's own `ECONNREFUSED` error carries no message text beyond what `code` already states)* | ~4ms |
| 6 | Blackhole listener (silent peer) | `client-timeout` | — | — | `Timed out while waiting for handshake` | full `readyTimeout` (measured 2001-2002ms for 2000ms configured) |
| 7 | Pinned fingerprint mismatch (`hostVerifier` returns `false`) | `handshake` | — | — | `Host denied (verification failed)` | ~11ms (`fatal: true` also set) |
| 8 | Mid-exec transport death (see below — separate from row 5: a channel already existed and had produced no output) | *(no error at all — see below)* | — | — | — | see below |

**Row 4 is a genuine, measured surprise worth flagging explicitly:** a
hostname under the `.invalid` TLD does **not** fail fast with `ENOTFOUND`
on this machine — it hangs for the full configured `readyTimeout` with
`level: 'client-timeout'`, the identical shape as the blackhole listener.
Reading `ssh2`'s own `lib/client.js`: when neither `forceIPv4` nor
`forceIPv6` is set (the default, and this repo's default), `ssh2` calls
plain `net.Socket.connect({ host, port })` and lets Node's own DNS
resolution happen inside that call; on this host/resolver configuration,
a `.invalid`-TLD lookup does not produce a fast synchronous-style
`ENOTFOUND` before the socket-connect timer starts — it stalls until
`readyTimeout` fires. **`HOST_UNRESOLVED` is therefore not reachable via
this exact scenario on every environment** — the classifier must still
have a `code === 'ENOTFOUND' || code === 'EAI_AGAIN'` branch mapping to
`HOST_UNRESOLVED` for the case where DNS resolution *does* fail fast (the
`client-socket`-level path `ssh2`'s own `sock.on('error', ...)` handler
sets up), but a real deployment's actual resolver behaviour determines
which of `HOST_UNRESOLVED` or `CONNECT_TIMEOUT` a bad hostname produces,
and both must be handled. `contracts.test.ts` asserts the shape actually
observed (`client-timeout`) rather than asserting an `ENOTFOUND` this
environment does not produce, and documents this divergence rather than
silently asserting a shape from documentation instead of measurement.

### Refused-port mapping decision

A refused port (row 5) and an unreachable network (rows 4/6) are **not**
distinct entries in `SERVER_ERROR_CODES` — `packages/domain`'s seven-code
union has no separate "refused" code. Both land on **`CONNECT_TIMEOUT`**
(the roadmap's state table already puts "port closed" under
`UNREACHABLE`, and `CONNECT_TIMEOUT` is the `UNREACHABLE`-landing code).
D-10's single retry for `CONNECT_TIMEOUT` is harmless for a refused port —
retrying a connection that was actively refused either fails identically
or succeeds if the remote service came up in the interim, never worse
than not retrying. **Rejected alternative: `CONNECTION_LOST`.** A refused
connection never established a session to lose — `CONNECTION_LOST` is
reserved for row 8 below, where a channel had already been opened and had
begun producing (or was about to produce) output before the transport
died. Conflating "never connected" with "was connected, then wasn't"
would make `CONNECTION_LOST`'s D-10 retry semantics (silently correct for
a transient mid-command drop) apply to a case — a hard refusal — where
retrying instantly is far more likely to be pointless.

### Mid-exec transport death (row 8) — measured, not assumed, for both Ubuntu versions

Using `startSshd({ ubuntu, slowDf: true })`, connecting for real, opening
an exec channel for the literal `df -P -k /` string (the same text the
frozen `discovery.disk` template holds), awaiting
`waitForSlowCommandStart(fixture)` so the remote command is provably
blocked with no output sent yet, then calling `fixture.stop()`:

**Neither the client nor the channel ever emits an `'error'` event.**
Testcontainers' `container.stop()` produces a **graceful** shutdown
(sshd receives SIGTERM and cleanly closes its client connections with a
proper TCP FIN before the container's network namespace is torn down),
not an abrupt reset — the ECONNRESET this project's own 02-CONTEXT.md
sketch anticipated for this scenario does not occur with
Testcontainers' default stop behaviour. Measured sequence, identical for
both Ubuntu 22.04 and 24.04, reproduced across six separate runs:

1. Client emits `'end'` (no arguments), reliably within Testcontainers'
   own `stop()` call — well before it resolves (measured well under its
   ~200-250ms typical duration for this fixture).
2. Client emits `'close'` (no arguments) immediately after.
3. Channel emits `'end'` (no arguments) — **but only once its readable
   side has been put into flowing mode.**
4. Channel emits `'close'` with **no arguments at all** — not even a
   `null` exit code. Reading `ssh2`'s own `lib/utils.js`
   (`onCHANNEL_CLOSE`): the non-SFTP, non-server branch emits
   `channel.emit('close', exit.code, exit.signal, exit.dump, exit.desc)`
   only when `exit.code === null` exactly; here `channel._exit.code` is
   `undefined` (the exec never received an `exit-status` message from the
   dying server), so the `!==null` branch fires instead:
   `channel.emit('close', exit.code)` — a single `undefined` argument,
   which is indistinguishable at the call site from "no arguments".

**A second, independent, and equally load-bearing finding surfaced while
building the standing test for the above:** a `ClientChannel` — like any
Node `Duplex` — starts in **paused mode**. `onCHANNEL_CLOSE` calls
`channel.push(null)` to signal EOF on the readable side, but a paused
stream only surfaces that as an `'end'` event once something drains it —
attaching a `'data'` listener or calling `.resume()`/`.pipe()`. **With
neither, `channel.push(null)` is silently buffered and `'end'`/`'close'`
never fire, not even after waiting 25+ seconds** — measured directly:
the identical scenario, differing only in whether `channel.resume()` and
`channel.stderr.resume()` were called right after `exec()`'s callback
returned the stream, produced a reliable `'end'`/`'close'` pair within a
few seconds in every run *with* the resume calls, and no channel-level
event at all within 25 seconds in every run *without* them. The client's
own `'end'`/`'close'` were unaffected either way — only the channel-level
pair depends on stream consumption. This is not a production gap: the
real adapter's `exec()` implementation always attaches a `'data'`
listener to accumulate stdout (Pattern 2, 02-RESEARCH.md's own
`execWithTimeout` sketch), so a real `SshSession.exec()` call is always
already in flowing mode by the time a transport dies mid-command. It is,
however, a real trap for exactly this kind of spike/test code, and for
any future debugging session that opens a raw channel without consuming
it and concludes "the channel silently hangs forever" — it doesn't hang,
it is simply never drained.

**Plan 02-07's classifier must map this scenario to `CONNECTION_LOST`
without ever seeing an `'error'` event.** The reliable signal — present
in 100% of measured runs regardless of stream mode — is the **client's**
`'end'`/`'close'` sequence. The channel-level `'end'`/`'close'` pair is
corroborating evidence when it arrives (confirming no exit code was ever
received), but a classifier or `SshSession.exec()` implementation that
already consumes its channel's `'data'` (as it must, to collect stdout)
will see both: the channel closing with `exitCode === null`/`undefined`
while a command was still outstanding is the direct signal to map to
`CONNECTION_LOST`, never derived from a caught error, since `ssh2` never
raises one in this path.

## Rejected alternatives

- **Trusting 02-RESEARCH.md's documented/training-knowledge shapes
  without live measurement.** Rejected by this plan's entire premise: two
  of the seven error-shape rows above (the `.invalid`-TLD timeout instead
  of a fast `ENOTFOUND`, and the mid-exec no-error-at-all sequence instead
  of an assumed `ECONNRESET`) contradict what a documentation-only read of
  `ssh2`'s behaviour would have produced, and the original
  `startBlackholeListener` bug would have shipped a permanently-broken
  CONNECT_TIMEOUT scenario into every one of plans 02-05 through 02-10 had
  it not been measured here first.
- **Toxiproxy for CONNECT_TIMEOUT simulation**, per 02-CONTEXT.md's own
  Deferred Ideas. Not needed: candidate (a), once its `nc` invocation bug
  is fixed, is a deterministic, host-network-independent TCP-level
  primitive with no observed instability across four measured runs.
  Remains the documented fallback if a future CI run proves otherwise.

## Consequences

- `tests/integration/helpers/ssh.ts`'s `startBlackholeListener` now starts
  `nc -lk -p 9000 -e /bin/sleep infinity` instead of the original
  `while true; do nc -l -p 9000; done` — every plan (02-05..02-10) that
  uses this helper for a `CONNECT_TIMEOUT` scenario now gets the
  behaviour its own docstring always promised.
- `packages/ssh/src/testing/raw-ssh2.ts` is a new, permanent,
  never-shipped (build-excluded) re-export of `ssh2`'s `Client`/`utils`
  surface, existing solely so integration tests can drive raw `ssh2`
  without violating `packages/ssh/src/boundary.test.ts`'s containment
  rule. Plan 02-06 does not need it — it implements `SshPort` itself,
  inside `packages/ssh`, where `ssh2` is already importable directly.
- Plan 02-06's TOFU implementation must use `utils.parseKey(rawArgument).type`
  (technique (a)) to extract the host key's algorithm name, and must
  compute the fingerprint as `SHA256:` + base64(sha256(rawArgument)) with
  padding stripped — both proven byte-identical to `ssh-keygen -lf` here.
- Plan 02-05's Docker-detection parser must branch on exit code (127 vs.
  non-zero-with-valid-JSON) rather than only on `JSON.parse` success, per
  the table above, and must never assume a fixed `Arch`/`Version` value.
- Plan 02-07's error classifier must: (a) treat a refused port and every
  other network-level failure as `CONNECT_TIMEOUT`, never a separate
  code; (b) handle `HOST_UNRESOLVED` via `code === 'ENOTFOUND' || code === 'EAI_AGAIN'`
  when that fast path does occur, while also tolerating a bad hostname
  producing the `client-timeout` shape instead, depending on the
  resolver's actual behaviour; (c) classify a channel that closes with no
  exit code while a command was outstanding as `CONNECTION_LOST` even
  though `ssh2` raises no `'error'` event for that case at all.
- `contracts.test.ts`'s shared `attemptConnect` helper always attaches a
  no-op `'error'` listener to the `Client` once the connection attempt
  has settled (success or failure), replacing the one-shot listener that
  produced the result: several failure-mode fixtures (the blackhole
  listener, a stopped container) are torn down in `afterEach` *after*
  their connection attempt has already failed, and the abandoned
  `Client`'s underlying socket can emit a second, later `'error'` when
  that teardown happens — an unhandled `'error'` event is a fatal,
  uncaught exception in Node, measured directly as a real crash before
  this fix was added.
- Any spike or debugging code that opens a raw `ClientChannel` and does
  not intend to read its output must still call `channel.resume()` (and
  `channel.stderr.resume()`) to observe `'end'`/`'close'` at all — see
  the mid-exec section above. `contracts.test.ts` does this explicitly.
