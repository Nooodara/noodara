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
