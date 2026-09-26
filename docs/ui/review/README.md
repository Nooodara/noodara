# UI review captures

This directory is throwaway output of `pnpm ui:review` (`scripts/ui/capture-ui-review.ts`). It is
regenerated on demand and is gitignored except this file.

It holds every screen and overlay capture at all four review widths (375/900/1280/1920px) and both
themes — the full baseline plus every later re-capture round for the three human gates (G1/G2/G3,
`08-CONTEXT.md` D-13).

Only the 1280px set the user explicitly approves at a gate is ever committed, into
`docs/ui/approved/` — copying it there is each gate plan's own job, never this script's.
