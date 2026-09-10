---
phase: 01-dominio-persistencia-y-autenticacion
plan: 01
subsystem: infra
tags: [supply-chain, npm, provenance, security, vitest, commander, fastify, adr]

# Dependency graph
requires: []
provides:
  - "scripts/check-package-provenance.mjs — re-runnable, zero-dependency provenance gate for pinned npm packages"
  - "docs/adr/0000-package-legitimacy-approvals.md — dated, versioned record of the provenance verdict for vitest, commander, @fastify/type-provider-zod and fastify-type-provider-zod"
affects: [01-02, 01-03, phase-1-scaffold]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Supply-chain provenance gate: any npm package flagged [SUS]/[ASSUMED] by slopcheck must pass an automated repository.url check against a hardcoded expected owner/repo before install, with exact-match comparison (never .includes)"
    - "ADR-style dated record for package legitimacy decisions, cross-referenced back to the phase RESEARCH.md audit table"

key-files:
  created:
    - scripts/check-package-provenance.mjs
    - docs/adr/0000-package-legitimacy-approvals.md
  modified: []

key-decisions:
  - "vitest, commander, @fastify/type-provider-zod and fastify-type-provider-zod all verified: registry repository.url normalises to the expected GitHub owner/repo, confirming 01-RESEARCH.md's false-positive assessment of the two slopcheck [SUS] flags and the A1 assumption"
  - "Provenance resolution primary path is `npm view <pkg> repository.url`/`version` via execFileSync, falling back to a raw fetch against registry.npmjs.org's dist-tags/latest — zero third-party dependencies, since no package.json exists yet at this point in the phase"
  - "Comparison uses exact string equality on the normalised owner/repo after stripping git+/.git/protocol/github.com prefixes, not substring matching, so a typosquat URL containing the real org name as a substring cannot pass"

patterns-established:
  - "Pattern 1: npm supply-chain gate — before any flagged/assumed package is installed, add it to the EXPECTED_PACKAGES table in scripts/check-package-provenance.mjs and re-run the script; record the verdict in docs/adr/0000-package-legitimacy-approvals.md"

requirements-completed: [QA-01]

# Metrics
duration: 13min
completed: 2026-09-10
---

# Phase 1 Plan 1: Automated npm Package Provenance Check Summary

**Zero-dependency `scripts/check-package-provenance.mjs` verifies vitest, commander, @fastify/type-provider-zod and fastify-type-provider-zod against their expected GitHub repositories, with the verdict recorded in a dated ADR before any dependency is installed.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-09-10T18:22:52Z
- **Completed:** 2026-09-10T18:35:25Z
- **Tasks:** 1
- **Files modified:** 2 (both new)

## Accomplishments
- Built a re-runnable, zero-third-party-dependency provenance script that resolves each pinned package's registry `repository.url` (via `npm view`, with a `fetch`-based registry API fallback) and asserts exact-match `owner/repo` equality against a hardcoded, reviewable table.
- Verified all four packages flagged or caveated by `01-RESEARCH.md`'s slopcheck audit (`vitest` [SUS], `commander` [SUS], `@fastify/type-provider-zod` [OK]/A1, plus the unscoped `fastify-type-provider-zod` baseline) resolve to their expected GitHub orgs.
- Recorded the observed repository URLs, resolved versions, slopcheck verdicts and automated verdicts in `docs/adr/0000-package-legitimacy-approvals.md`, cross-linked back to `01-RESEARCH.md#package-legitimacy-audit`.
- Confirmed the check actually detects tampering (not just the happy path): temporarily changing the expected `vitest` org made the script exit 1 with `SUPPLY CHAIN CHECK FAILED`; reverted and re-confirmed exit 0.
- Confirmed no `package.json` or `pnpm-lock.yaml` exists anywhere in the repo — this gate precedes the first install by design.

## Task Commits

Each task was committed atomically:

1. **Task 1: Automated provenance check for the flagged npm packages** - `eacdfda` (feat)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `scripts/check-package-provenance.mjs` - Zero-dependency provenance script; resolves and exact-matches each pinned package's registry `repository.url` against a hardcoded expected `owner/repo` table, exits 1 with a review message on any mismatch/unresolvable/missing-repository case
- `docs/adr/0000-package-legitimacy-approvals.md` - Dated ADR table recording expected/observed repository, resolved version, slopcheck verdict and automated verdict for all four audited packages, with re-run instructions

## Decisions Made
- Used `npm view` as the primary resolution path (works with no local `package.json`) with a `fetch`-based `registry.npmjs.org` fallback, keeping the script at zero third-party dependencies as required at this point in the phase.
- Comparison logic strips `git+`, trailing `.git`, protocol prefixes and the `github.com` host, then does exact lowercase string equality — explicitly rejecting substring/`.includes()` matching per the plan's threat model (T-1-01), since a URL like `github.com/evil/vitest-dev-vitest` would pass an `.includes()` check.
- Included `fastify-type-provider-zod` (the unscoped alternative) in the audit table even though it was never `[SUS]`-flagged, so its provenance is on record for Plan 01-03's comparison against `@fastify/type-provider-zod`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Supply-chain gate is in place and passing for all four flagged/caveated packages; Plan 01-02 and later plans that install these dependencies can proceed without re-litigating package legitimacy.
- No `package.json` or lockfile exists yet — the next plan in this phase is the first one expected to introduce them.
- `scripts/check-package-provenance.mjs`'s `EXPECTED_PACKAGES` table should be extended whenever a future phase flags a new package as `[SUS]`/`[ASSUMED]`.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-10*
