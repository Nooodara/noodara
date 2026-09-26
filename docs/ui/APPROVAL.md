# UI redesign approval record

Per UI-12 (D-13), the phase's rediscovery of `docs/ui-build-prompt.md`'s Apple-grade surface
craft — floating elevation, materials, movement with purpose, the two authored moments — is
reviewed by a human at three blocking gates before it is considered done, each against the six
redesigned screens plus the `Sheet`/`Dialog`/`RowMenu`/`AccountMenu` overlays, in both themes, at
375/900/1280/1920px, captured by `pnpm ui:review` against real fixture data (D-12).

- **G1 — Baseline**: the six screens plus overlays, captured before a single line of CSS changes.
  Gives the before/after; the user's notes on this baseline feed the surfaces plans that follow.
- **G2 — Direction**: after P0, `InsetGroup` and the shell (floating elevation, `RowMenu` fixed,
  accessibility fallbacks, `AccountMenu`, `NavTree`, the `@inspector` slot). The visual direction
  is approved here, before any further investment in motion. Includes a real screen-reader pass
  and a live drag-feel review for whatever is already built (D-14).
- **G3 — Final**: after P1/P2 and the authored moments (Sheet drag-to-dismiss, the Viewfinder ring,
  `Fingerprint` diff, the full motion table), tested live in the running app.

Each gate allows up to two adjustment rounds (D-13, mirroring Phase 7's D-16 ceiling). Until a
gate is actually approved, its block below carries `pending` in the Date/Rounds used/Approver
cells — `tests/unit/ui/approval-record.test.ts` only requires the rows to exist and be
well-formed, never that they are filled, so this record is green from this plan onward and stays
green as the gate plans (08-02, 08-11, 08-19) fill each block in.

## G1 — Baseline

| Field | Value |
| --- | --- |
| Gate | G1 — Baseline |
| Date | pending |
| Rounds used | pending |
| Approver | pending |
| Evidence | docs/ui/approved/ — the six screens plus overlays, both themes, at 1280px |

### Adjustment log

- **Round 1: none yet.**
- **Round 2: none yet.**

## G2 — Direction

| Field | Value |
| --- | --- |
| Gate | G2 — Direction |
| Date | pending |
| Rounds used | pending |
| Approver | pending |
| Evidence | docs/ui/approved/ — the six screens plus overlays, both themes, at 1280px |

### Adjustment log

- **Round 1: none yet.**
- **Round 2: none yet.**

## G3 — Final

| Field | Value |
| --- | --- |
| Gate | G3 — Final |
| Date | pending |
| Rounds used | pending |
| Approver | pending |
| Evidence | docs/ui/approved/ — the six screens plus overlays, both themes, at 1280px |

### Adjustment log

- **Round 1: none yet.**
- **Round 2: none yet.**

## What this record gates

D-13: no gate's own wave of work is considered complete until its block above is filled in with a
real date, approver and rounds count, and `tests/unit/ui/approval-record.test.ts` keeps this file
and the real `docs/ui/approved/` contents in agreement. `docs/ui/review/` is regenerated scratch
by `pnpm ui:review` and is gitignored.
