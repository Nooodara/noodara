# ADR 0002: CLI library — `commander`

## Status

Accepted — 2026-09-12

## Context

`01-RESEARCH.md` (Open Question 2) left open whether the `noodara` operator
CLI (`admin reset`, `secrets rotate`) should be built on `commander`
(tj/commander.js, 2011–present) or `citty` (unjs's modern TypeScript-first
CLI kit). Both are legitimate, currently-maintained packages. `commander`
was already provenance-verified in Plan 01-01
(`docs/adr/0000-package-legitimacy-approvals.md`: `commander` resolves to
`tj/commander.js` at version `15.0.0`, flagged `[SUS]` by the automated
`slopcheck` pass purely on a stale/rate-limited download-count heuristic,
independently confirmed as a false positive) — no further legitimacy check
is required before installing it here.

There is no existing project precedent (greenfield) for either ecosystem's
conventions, so this is Claude's Discretion territory per
`01-CONTEXT.md`, not a blocking question — RESEARCH's own recommendation is
followed.

## Decision

Adopt **`commander@15.0.0`** for both `noodara admin reset` and
`noodara secrets rotate`.

Rejected alternative: **`citty`** (unjs).

Rationale:

- `commander` has an exceptionally long track record (2011–present) for
  exactly this class of command — a small, security-sensitive operator CLI
  with a handful of subcommands and no need for citty's more elaborate
  feature set (auto-generated usage from a schema, nested plugin system).
- These two commands run with full database access and both master keys in
  the environment (see this plan's own threat register) — the maturity and
  wide auditing of `commander`'s argument-parsing code counts for more here
  than `citty`'s more modern API ergonomics.
- `commander` was already independently verified as legitimate and current
  in Plan 01-01's automated provenance check, so adopting it introduces zero
  additional supply-chain verification burden beyond what this repo already
  requires for every dependency.
- `citty` remains a documented, viable alternative if a future phase needs a
  CLI with a materially larger surface (structured sub-command trees,
  generated help from a Zod-like schema) that would benefit from its design.

## Consequence

`apps/control-plane/src/cli/index.ts` builds its `program` on `commander`'s
`Command` class; `admin reset` and `secrets rotate` are registered as
subcommands there. `apps/control-plane/package.json` gains a `bin.noodara`
entry pointing at the built `dist/cli/index.js`. `citty` must never appear
in `package.json` alongside `commander` for this CLI — introducing a second
CLI-parsing library for the same command tree would be pure duplication.
