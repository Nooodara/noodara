# ADR 0000: Package legitimacy approvals for flagged phase-1 dependencies

## Status

Accepted — 2026-09-10

## Context

`01-RESEARCH.md` ran `slopcheck --ecosystem npm` over the whole phase-1 dependency
set. Three entries did not come back clean:

- `vitest` — flagged `[SUS]` ("suspiciously close to 'vite', could be typosquat")
- `commander` — flagged `[SUS]` ("Only 65 downloads. Nobody uses this.")
- `@fastify/type-provider-zod` — approved with caveat under Assumption A1 (a
  6-major-version gap versus the unscoped `fastify-type-provider-zod` package
  that needed independent confirmation before locking)

The research author assessed all three as false positives with independent,
verifiable evidence (npm release history, Context7 docs, existing project
fixation on these exact tools). This ADR turns that one-time human judgment
into a recorded, dated verdict backed by an automated, re-runnable check —
`scripts/check-package-provenance.mjs` — instead of leaving it only in chat
history or research prose.

`fastify-type-provider-zod` (the unscoped alternative Plan 01-03 compares
against) is included here too, so its provenance is on record even though it
was never `[SUS]`-flagged, since Plan 01-03 needs it as a documented baseline.

Source: .planning/phases/01-dominio-persistencia-y-autenticaci-n/01-RESEARCH.md#package-legitimacy-audit

## Decision

For each package below, `scripts/check-package-provenance.mjs` resolved the
registry `repository.url` (via `npm view <pkg> repository.url`, falling back
to the public registry JSON API) and asserted it normalises to the exact
expected GitHub `owner/repo`. All four packages passed on 2026-09-10.

| Package | Expected repository | Observed repository | Resolved version | slopcheck verdict | Automated verdict | Date |
|---|---|---|---|---|---|---|
| vitest | vitest-dev/vitest | `git+https://github.com/vitest-dev/vitest.git` | 5.0.0 | `[SUS]` (typosquat suspicion vs. `vite`) | verified | 2026-09-10 |
| commander | tj/commander.js | `git+https://github.com/tj/commander.js.git` | 15.0.0 | `[SUS]` (stale/rate-limited download-count check) | verified | 2026-09-10 |
| @fastify/type-provider-zod | fastify/fastify-type-provider-zod | `git+https://github.com/fastify/fastify-type-provider-zod.git` | 1.0.0 | `[OK]` / Assumption A1 (approved with caveat) | verified | 2026-09-10 |
| fastify-type-provider-zod | turkerdev/fastify-type-provider-zod | `git+https://github.com/turkerdev/fastify-type-provider-zod.git` | 7.0.0 | `[OK]` | verified | 2026-09-10 |

All four packages are approved for installation in this repository under
their currently pinned versions.

## Re-running this check

This check must be re-run whenever one of these pins changes, or before
approving any newly flagged package in a future phase:

```bash
node scripts/check-package-provenance.mjs
```

Exit code 0 means every pinned package's registry `repository.url` still
resolves to its expected GitHub org. A non-zero exit means a mismatch was
found and prints `SUPPLY CHAIN CHECK FAILED - a human must review this
package on npmjs.com before it is installed` for the offending package(s) —
do not proceed to install until that is resolved.

## Consequences

- No `vitest`, `commander` or `@fastify/type-provider-zod` install may land
  in the lockfile without this script having exited 0 first.
- The expected `owner/repo` table lives as literals inside
  `scripts/check-package-provenance.mjs`; changing it is visible in code
  review (see `01-01-PLAN.md` threat register, T-1-02 — accepted risk, no
  further control in v0.1).
- This ADR intentionally precedes the creation of any root `package.json` or
  lockfile in this repository.
