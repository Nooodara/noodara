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

### Phase 4 additions

`04-RESEARCH.md` ran its own package legitimacy audit for the three new
dependencies Phase 4 needs (BullMQ worker + Redis pub/sub SSE bridge +
Testcontainers Redis fixture). All three came back `[OK]` under slopcheck —
no `[SUS]`/`[ASSUMED]` human checkpoint was required for any of them.

| Package | Expected repository | Observed repository | Resolved version | slopcheck verdict | Automated verdict | Date |
|---|---|---|---|---|---|---|
| bullmq | taskforcesh/bullmq | `git+https://github.com/taskforcesh/bullmq.git` | 6.3.6 | `[OK]` | verified | 2026-09-17 |
| ioredis | redis/ioredis | `git+https://github.com/redis/ioredis.git` | 5.11.1 | `[OK]` | verified | 2026-09-17 |
| @testcontainers/redis | testcontainers/testcontainers-node | `git+https://github.com/testcontainers/testcontainers-node.git` | 12.1.0 | `[OK]` | verified | 2026-09-17 |

`ioredis@6.0.0` (the latest release on the registry at audit time) was
considered and rejected for this phase on compatibility grounds, not
legitimacy grounds: it switches its default wire protocol to RESP3 and
BullMQ 6.3.6 declares `ioredis` only as an optional peer (`>=5.0.0`) with no
recorded validation against RESP3-by-default behaviour. `ioredis@5.11.1`,
the last pre-RESP3 release, is pinned instead (04-RESEARCH.md Pitfall 2 /
Open Question 1). `concurrently` was also evaluated (as a way to run the API
and worker entrypoints together in `pnpm dev`) and was not installed — this
phase uses a second Turborepo `dev:worker` task instead, keeping the
zero-new-tooling-dependency posture this project has held since Phase 1.

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
