# Approved UI captures

Twelve PNGs — one per redesigned screen (`setup`, `login`, `servers`, `server-detail`, `activity`,
`settings`) in each theme (`light`, `dark`) — captured at 1280px only, the state each of the three
human gates (G1/G2/G3, `docs/ui/APPROVAL.md`) was approved against.

Regenerate the full review matrix (all four widths, both themes, plus the overlay surfaces) with:

```sh
pnpm ui:review
```

Then copy the approved gate's 1280px screen captures from `docs/ui/review/` here — never captured
directly into this directory, so a rejected round never lands here. `tests/unit/ui/approval-record.test.ts`
pins this directory to exactly this set (plus this file); an extra or renamed file fails CI (T-08-06).
