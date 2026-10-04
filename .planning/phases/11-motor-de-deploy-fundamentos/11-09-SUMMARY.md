---
phase: 11-motor-de-deploy-fundamentos
plan: 09
subsystem: adr, acceptance
tags: [adr-0008, acceptance, g1-g7, deploy-engine]
requires: ["11-03", "11-04", "11-05", "11-06", "11-07", "11-08"]
provides:
  - "ADR 0008 Status: Accepted (2026-10-04), with user resolutions to G7, D-04 wording, docker kill branch, HTTPS token measurement"
affects: [12]
tech-stack:
  added: []
  patterns: []
key-files:
  created:
    - .planning/phases/11-motor-de-deploy-fundamentos/11-09-SUMMARY.md
  modified:
    - docs/adr/0008-deploy-engine-empirical-contracts.md
    - .planning/OPEN_QUESTIONS.md
decisions:
  - "G7: pull-through mirror of mirror.gcr.io confirmed and stays (user approval 2026-10-04)"
  - "D-04: `kill -s TERM -- \"-$pgid\"` launched with `setsid -w` accepted as wording fix"
  - "docker kill branch: kept as safety net; does not claim to kill BuildKit builds"
  - "HTTPS token clone: to be measured with contract test in Phase 12 before deploy keys deprecated"
metrics:
  duration: "~10 min"
  completed: 2026-10-04
  tasks: 3
  files: 2
---

# Phase 11 Plan 09: ADR 0008 Acceptance Summary

ADR 0008 (Deploy engine empirical contracts) is now Accepted as of 2026-10-04 with user approval of all four open items that blocked Phase 12 planning. The ADR freezes the empirical bases for G1–G7 (secret transfer, remote kill, BuildKit detection, docker ps stability, fixture supply) and lists their contract tests and consequences.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1. ADR finalized | 752f4f7 | G1–G7 contracts, measurements, open items logged |
| 2. Skill edited | on disk only | `.claude/skills/noodara-domain-model/SKILL.md` (gitignored) |
| 3. User acceptance recorded | 11-09-SUMMARY | G7, D-04 wording, docker kill branch, HTTPS token; OPEN_QUESTIONS cleaned |

## Resolutions

**G7 (mirror):** User confirms pull-through mirror of `mirror.gcr.io` as the base-image source for the test harness. No alternative path chosen.

**D-04 (kill wording):** `kill -s TERM -- "-$pgid"` launched with `setsid -w` accepted as the correct wording fix (not a mechanism change). Broken form (`kill -- -pgid`) documented as a negative test in contracts-g1-g2.test.ts.

**docker kill branch:** Kept as D-04 requires. It applies to `docker run` containers; never finds a target during BuildKit builds (documented in ADR and safe to skip for builds).

**HTTPS token clone:** Will be measured with a contract test in Phase 12, before deploy keys are marked deprecated. Only deploy keys guaranteed for v0.2.

## Status

ADR 0008 Status changed to "Accepted — 2026-10-04". Open items 1–4 marked resolved; items 5–8 remain open. .planning/OPEN_QUESTIONS.md cleaned: items 1–4 removed, item 5 (skill tracking) moved to the top. Phase 12 planning is now unblocked.

## Known Stubs

None.

## Self-Check: PASSED

- FOUND ADR Status: Accepted — 2026-10-04
- FOUND 4 open items marked resolved with user decisions
- FOUND .planning/OPEN_QUESTIONS.md cleaned (items 1-4 removed, item 5 kept)
