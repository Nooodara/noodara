# Server connection state machine — transition table

Versioned mirror of `.claude/skills/noodara-domain-model/SKILL.md` §2.1 (D-16: that skill table is
the source of truth; `.claude/` is gitignored, so this file is the committed record other
contributors and CI can read). Implemented in `packages/domain/src/server/server-state.ts`.

## States

```text
PENDING       registered, never attempted a connection
CONNECTING    connection attempt in flight
CONNECTED     last operation succeeded
DISCONNECTED  system-only: was CONNECTED and closed cleanly
UNREACHABLE   timeout / host does not resolve / port closed
ERROR         auth failed, host key changed, command failed
```

No state is terminal — every state can reach `CONNECTING` again.

## Allowed transitions

| Desde | Hacia permitidos |
|---|---|
| PENDING | CONNECTING |
| CONNECTING | CONNECTED, UNREACHABLE, ERROR |
| CONNECTED | CONNECTING, DISCONNECTED, UNREACHABLE, ERROR, PENDING |
| DISCONNECTED | CONNECTING |
| UNREACHABLE | CONNECTING |
| ERROR | CONNECTING, PENDING |

`CONNECTED → PENDING` and `ERROR → PENDING` are additions made in Plan 01-04 on top of the base
table from Plan 01-02's skeleton; see "Reason-gated edges" below for why they exist.

Any pair not listed above throws `InvalidTransitionError` — asserted for all 36 ordered pairs
(including the 6 self-transitions) in `server-state.test.ts`, generated mechanically from
`SERVER_STATUSES` so a widened table without a matching test update fails the suite (D-16).

## Reason-gated edges

Three edges cannot happen silently — each requires an explicit `TransitionReason` matching
exactly, or `transition()` throws `MissingTransitionReasonError`:

| Edge | Required reason | Decision | Why |
|---|---|---|---|
| `CONNECTED → PENDING` | `identity_changed` | **D-14** | Editing a `CONNECTED` server's host or port changes its identity: it goes back to `PENDING` and the host fingerprint is cleared. Editing only the SSH user or credential instead moves it to `DISCONNECTED` (fingerprint kept) — that edge has no reason gate because it isn't ambiguous. |
| `ERROR → PENDING` | `fingerprint_trusted` | **D-15** | A `HOST_KEY_CHANGED` connection failure parks the observed fingerprint in `pending_fingerprint` and leaves the server in `ERROR`. Only the explicit "Trust new fingerprint" action (which copies `pending_fingerprint` into `host_fingerprint`) may move it back to `PENDING`. |
| `CONNECTED → DISCONNECTED` | `clean_close` | **D-13** | There is no admin "Disconnect" action in v0.1 — every connect/discovery opens and closes its own SSH session. `DISCONNECTED` is assigned only by the system when a session that was `CONNECTED` closes cleanly, never by a user-requested action. |

## Session lifecycle and CONNECTED semantics (D-03, phase 3)

CONNECTED means the last operation succeeded, not that a session is open. There is no persistent
SSH session tied to a `CONNECTED` server between requests: every `connect`/`connectAndDiscover`
call opens its own connection and closes it before returning.

`connectAndDiscover` closes its SSH session at the end of every run and deliberately does NOT
transition to `DISCONNECTED`; it never uses the `clean_close` edge. The `CONNECTED -> DISCONNECTED`
(`clean_close`) edge is reserved for D-14 of phase 1 (editing the SSH user or replacing the
credential on a `CONNECTED` server) and future system shutdowns — it is not a byproduct of a
normal, successful discovery run.

D-02's post-connect discovery failures use a second, direct `transition()` call: `CONNECTED ->
ERROR` for `COMMAND_TIMEOUT` and `CONNECTED -> UNREACHABLE` for `CONNECTION_LOST`, never a second
`applyConnectionResult` (which throws once the status is already `CONNECTED` — see
"Connection-result mapping" below).

## Connection-result mapping

`packages/domain/src/server/connection-result.ts` maps each SSH connection outcome to exactly one
resulting status (tested as a table over every entry in `SERVER_ERROR_CODES`):

| Result | Resulting status |
|---|---|
| success | CONNECTED |
| `AUTH_FAILED` | ERROR |
| `COMMAND_TIMEOUT` | ERROR |
| `HOST_KEY_CHANGED` | ERROR (also sets `pending_fingerprint`, D-15) |
| `UNSUPPORTED_OS` | CONNECTED (warning code, D-11) |
| `HOST_UNRESOLVED` | UNREACHABLE |
| `CONNECT_TIMEOUT` | UNREACHABLE |
| `CONNECTION_LOST` | UNREACHABLE |

**D-11 (phase 2):** `UNSUPPORTED_OS` was `ERROR` in phase 1; phase 2 changes it to `CONNECTED`
because the connection and discovery both succeeded and the platform is simply outside the
supported matrix (Ubuntu 22.04/24.04) — the code is still recorded in `last_error_code` as a
warning for the detail view, and v0.2 will use that warning to block deploys rather than this
phase blocking the connection itself.

`applyConnectionResult` only accepts results while the server is `CONNECTING` (a result arriving
for any other status throws `InvalidTransitionError`), and routes every status change through
`transition()` — it never assigns a status literal.
