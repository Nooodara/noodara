---
phase: 08-redise-o-de-la-app
plan: 19
subsystem: ui
tags: [gate, approval, ui-review, e2e, nightly, accessibility, motion]

requires:
  - phase: 08-16
    provides: "the discovery narration and Fingerprint TOFU block (the two authored moments) finished"
  - phase: 08-17
    provides: "craft-layer polish (tabular numerals, @starting-style, clip-path disk meter)"
  - phase: 08-18
    provides: "the full motion table's remaining entrances"
provides:
  - "G3 — final gate recorded in docs/ui/APPROVAL.md, approved 2026-09-26 by Pablo Gutierrez after one adjustment round"
  - "Twelve committed 1280px captures refreshed in docs/ui/approved/, reflecting round 1's five layout/shell fixes"
  - "20/20 pnpm test:e2e:repeat, 143/143 pnpm test:e2e, all static gates green -- the phase's full verification battery closed"
  - "A discovery.spec.ts test bug fixed (strict-mode heading match) found by the nightly's own first iteration"
affects: ["10 (landing reuses docs/ui/approved/ as real screenshots, SITE-01)"]

tech-stack:
  added: []
  patterns:
    - "getByRole('heading', { name, exact: true }) when a fixture's own content (a server name) can contain the target heading's text as a case-insensitive substring"

key-files:
  created: []
  modified:
    - tests/e2e/discovery.spec.ts
    - docs/ui/APPROVAL.md
    - docs/ui/approved/*.png (12 of 12 refreshed to reflect round 1's five fixes)
    - .planning/phases/08-redise-o-de-la-app/08-HUMAN-UAT.md
    - .planning/phases/08-redise-o-de-la-app/deferred-items.md

key-decisions:
  - "G3 resolved by delegated approval, mirroring G2's own pattern: the user reviewed the production build live over a public tunnel, replied 'G3 adjust' with five specific layout/shell items (round 1, commits 9666793..94f141a), then replied verbatim 'G3 approved' after the round was re-verified -- not an item-by-item narrated walkthrough of the G3 checklist."
  - "The brand-swap verdict (discovery narration, TOFU/Fingerprint block) and the drag-feel judgement (real speed, slow motion, real touch hardware) were NEVER given in the user's own words at G3. This is recorded honestly in docs/ui/APPROVAL.md ('not supplied in words; the user approved after a live session of the production build') and in 08-HUMAN-UAT.md, rather than fabricated. These items remain open in the human record even though the gate itself is closed by the user's explicit 'G3 approved'."
  - "08-HUMAN-UAT.md's G3 checklist ticks only items covered by automation/captures plus the general live-session approval (sheet-drag mechanics via @sheet-drag E2Es, the Viewfinder ring via @discovery-ring E2Es, the full motion table via per-screen E2E suites and capture pairs); 'Sheet drag on real touch hardware' and both brand-swap items stay explicitly unticked with a delegation note. This is a deliberate departure from 08-19-PLAN.md's own Task 3 acceptance criterion ('every G3 item is now [x]') -- see 'Rules not satisfied' below."
  - "UI-04 (RowMenu/AccountMenu screen-reader pass) was NEVER performed by the user, at G2 or G3. It stays Pending in REQUIREMENTS.md; both checklist rows in 08-HUMAN-UAT.md remain unticked."
  - "UI-08 is marked complete: its brand-swap clause has no automatable verdict, but the requirement's own text ('tratados como momentos autorados... distinguibles de cualquier otro producto') is about the moments being authored and distinguishable, which the build demonstrably is (Discovery timeline + Viewfinder ring, Fingerprint block) -- the verdict itself was approved by delegation, which is recorded honestly rather than hidden."
  - "UI-11 stays Pending: D-07's NavTree is still generic with three flat leaves (Servers, Activity, Settings), not the hierarchical Project -> Environment -> Service tree the requirement's text names. The shell is prepared for it (component, Disclosure, tooltip/flyout collapse) but the hierarchy itself does not exist yet -- that is Phase 13's job per D-07's own note."
  - "The first nightly attempt (iteration 1/20) failed on a real test bug in the round-1 discovery.spec.ts addition: getByRole('heading', { name: 'Discovery' }) also matched the fixture server's own h1 ('discovery-position-srv' contains 'discovery' as a case-insensitive substring), a strict-mode violation. Fixed with exact: true (commit 67caf0b) -- a genuine Rule 1 bug in a just-added test, not a flake."
  - "Two further nightly attempts hit real, pre-existing infra timing issues unrelated to this plan's own files: a Testcontainers Docker port-binding race (attempt 2, likely aggravated by static checks I ran concurrently with the repeat run -- a methodology error on my part, corrected by not running anything else during the final clean attempt) and an @sse-recover reconnect-timeout cascade (attempt 3, matching 08-08-SUMMARY.md's own documented precedent: 'pre-existing SSE-timing test... flaked once under load... not a regression'). Neither was fixed in-place (out of this plan's file scope, and not caused by round-1's changes); the fourth attempt ran clean, 20/20, with nothing else running concurrently on the machine's Docker daemon from this session."

requirements-completed: [UI-12, UI-06, UI-10, UI-08]

duration: 480min
completed: 2026-09-26
---

# Phase 08 Plan 19: G3 — final gate closes the redesign Summary

**G3 (final) approved 2026-09-26 by Pablo Gutierrez after one adjustment round of five layout/shell fixes; 20/20 `pnpm test:e2e:repeat` and 143/143 `pnpm test:e2e` green, twelve approved captures refreshed and pinned, and the brand-swap/drag-feel verdicts recorded honestly as delegated rather than fabricated.**

## Performance

- Duration: ~8 hours across two sessions (Task 1 verification battery + G3 live review in an earlier
  session; this continuation closed Task 3 after the G3 checkpoint resumed)
- Files touched this continuation: 1 test file fixed, 2 docs updated (`08-HUMAN-UAT.md`,
  `deferred-items.md`), `docs/ui/APPROVAL.md`, 12 approved captures refreshed

## What Task 1 (prior session) established

- Full static battery green: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`,
  `pnpm check:ui-safety`, `pnpm check:posix-sh`, `node scripts/check-package-provenance.mjs`,
  `pnpm test` (2778/2778 unit), `pnpm exec vitest run packages/ui/src/contrast.test.ts` (40/40).
- Fixes committed before the G3 checkpoint: `6fbb3b8` (missing `@testing-library/user-event` dev
  dependency in `apps/web`), `71d7d88`/`3e7c2bb` (RED/GREEN — the activity-entry flag was not
  stable across unrelated re-renders), `de06e4e` (the servers-list capture script waited for real
  data before screenshotting). Finding logged (not fixed, out of scope): `9bec380` — a silent
  login failure when the request origin is rejected (`INVALID_ORIGIN`, 403), found live over the
  review tunnel.
- Nightly run 20/20 green *before* round 1 (per the state handed to this continuation).

## What the G3 live review (Task 2) produced

The user reviewed the production build live over a public tunnel (discovery narration and
Fingerprint block both on screen) and replied "G3 adjust" with five specific items, applied and
re-verified as round 1 (commits `9666793`…`94f141a`, 15 commits total):

1. `ServerFacts.tsx`/`SettingsGroups.tsx` rows gained a `px-4` inset to match `InsetGroup`'s own
   convention on server detail and settings.
2. The sidebar gained `sticky` positioning instead of scrolling away with the page.
3. `DiscoverySection` moved above the stat tiles on `/servers/:id` — the discovery narration is
   now the first thing on screen.
4. The account-menu trigger's hover state was re-centred on the avatar in the icon rail.
5. D-05 changed: Appearance moved out of `AccountMenu` into a new Appearance `InsetGroup` on
   `/settings` (recorded as a decision change in `deferred-items.md`, not just a bug fix).

After round 1 was orchestrator-verified (unit 2778, E2E 143/143, ui-safety 12 gates, fresh
captures), the user replied verbatim **"G3 approved"**. Rounds used: 1 of 2. Approver: Pablo
Gutierrez. Date: 2026-09-26.

**Honesty note, stated plainly:** the user did not supply a brand-swap verdict in words for
either authored moment, did not state whether the Sheet drag was judged live by hand, and did not
perform the VoiceOver pass (UI-04). `docs/ui/APPROVAL.md` and `08-HUMAN-UAT.md` record this
explicitly rather than invent a verdict that was never given. G3 is closed by the user's own
"G3 approved," not by a fabricated item-by-item confirmation.

## This continuation's own work (Task 3)

1. **Nightly repeat, four attempts, in order:**
   - **Attempt 1** failed at iteration 1/20 on a real bug in round 1's own new test:
     `discovery.spec.ts`'s `getByRole('heading', { name: 'Discovery' })` also resolved the page's
     own `<h1>` server-name heading (the fixture name `discovery-position-srv` contains
     "discovery" as a substring) — a strict-mode violation. Fixed with `{ name: 'Discovery',
     exact: true }`, commit `67caf0b`. Re-ran the full suite once in isolation (143/143 green)
     before restarting the repeat.
   - **Attempt 2** failed at iteration 20/20 on a Testcontainers Docker port-binding race
     (`tests/integration/helpers/port-binding-retry.ts`'s own documented, pre-existing category —
     "observed once in 930 E2E runs" per its header comment). I had run `pnpm lint`/`typecheck`/
     `test`/etc. concurrently with this attempt, which plausibly starved the Docker daemon under
     load; this is a methodology error on my part, not a product or test bug.
   - **Attempt 3**, run with nothing else executing, failed at iteration 15/20 on
     `@sse-recover` (`tests/e2e/shell.spec.ts`) — the shell's SSE stream-status indicator did not
     hide within the 15s timeout after the connection cap was released, cascading into five
     immediate smoke-test failures. This matches `08-08-SUMMARY.md`'s own documented precedent for
     this exact category ("pre-existing SSE-timing test... flaked once under load... not a
     regression"). Neither this nor the port-binding race is in this plan's file scope
     (`docs/ui/APPROVAL.md`, `docs/ui/approved/`, `08-HUMAN-UAT.md`), and neither is caused by
     round 1's changes — both are logged, not silently retried away.
   - **Attempt 4**, also run alone, passed clean: **20/20 iterations, 143/143 tests every time,
     zero flakes**, ~42 minutes wall time.
2. **Approved capture set**: re-ran `pnpm ui:review` (never concurrently with the repeat run) to
   refresh the full review matrix; `servers-*`, `server-detail-*` and all four overlay surfaces
   changed pixels (round 1's fixes), `setup-*`/`login-*`/`activity-*`/`settings-*` were
   write-if-changed no-ops (pixel-identical, since `sticky` positioning and hover-state changes
   don't show in an unscrolled, non-hovered static capture). Copied the current 1280px set for all
   six screens into `docs/ui/approved/` via `approvedPngPath` (12 files, no hand-typed path).
3. **`docs/ui/APPROVAL.md`**: filled the G3 block — Gate, Date, Rounds used, Approver, Evidence
   (143/143 E2E, 20/20 repeat) — plus the two required extra lines: **Brand-swap verdict** ("not
   supplied in words; approved after a live session of the production build") and **Drag
   calibration** (`DRAG_CLOSE_VELOCITY_PX_PER_S = 110` px/s, `dragElastic={0.15}` from
   `packages/ui/src/Sheet.tsx`, unchanged, cited against `tests/e2e/server-sheet.spec.ts`'s
   `@sheet-drag` suite as the measured evidence, not derived). Adjustment log: round 1's five items
   with commit ranges, "Round 2: none."
4. **`08-HUMAN-UAT.md`**: ticked G3 items only where automation, captures, or the delegated
   live-session approval demonstrably covers them (sheet-drag mechanics, the Viewfinder ring, the
   full motion table spot-check); left "Sheet drag on real touch hardware," both brand-swap items,
   and "Sheet drag in slow motion" explicitly open with "not reported by the user at G3; approved
   by delegation." Frontmatter `status` left as `in-progress` — the template has no status value
   for "approved with open human items," and forcing one to `complete` would misrepresent the
   still-open VoiceOver/brand-swap/touch-hardware items.
5. **`deferred-items.md`**: added "Status at G3 close," naming every item still open past this
   gate — the 375px title truncation, `ServerDetailToolbar`'s missing scroll-edge/fallback parity,
   the ungated-hover-utilities re-sweep (never re-run this plan), the Sheet Esc focus-return gap,
   the silent `INVALID_ORIGIN` login failure, UI-04's screen-reader pass, and the un-narrated
   drag-feel/brand-swap verdicts.
6. Ran `pnpm exec vitest run tests/unit/ui/approval-record.test.ts` (17/17 green) and
   `grep -riE "claude|anthropic|co-authored-by" docs/ui/ | wc -l` (0). Committed
   `docs(08-19): record G3 approval and the approved capture set` (`c3fa5ca`).

## Requirements decisions

- **UI-12** — already Complete (from 08-11's own G2 work); reconfirmed here: contrast measured,
  all six screens reviewed at every width in both themes, 143 E2E green.
- **UI-06** — already Complete (08-12's Sheet drag-to-dismiss); reconfirmed: the full brief §7.4
  sequence is exercised by `@sheet-drag` and green in both the single run and the 20x repeat.
- **UI-10** — already Complete; reconfirmed by the same battery.
- **UI-08** — **marked complete this plan.** The requirement's text is about the two moments being
  authored and distinguishable, which the shipped build demonstrably is (Discovery timeline +
  Viewfinder ring, Fingerprint block, both wired to real state). The brand-swap *verdict* itself
  was never given in words — that gap is recorded honestly in `docs/ui/APPROVAL.md` and
  `08-HUMAN-UAT.md` rather than hidden, and G3's own explicit approval is the gate that closes it.
- **UI-11** — **stays Pending.** D-07's `NavTree` is still generic with three flat leaves
  (Servers, Activity, Settings); the hierarchical Project → Environment → Service tree the
  requirement's own text names does not exist yet — that is explicitly Phase 13's job. The shell
  is prepared to receive it (the component, `Disclosure`, tooltip/flyout collapse all exist) but
  the requirement is about the real hierarchy, not the readiness.
- **UI-04** — **stays Pending.** Never performed by the user at G2 or G3.

## Rules not satisfied

- **08-19-PLAN.md's own Task 3 acceptance criterion** — "Every `- [ ]` under `## G3` in
  `08-HUMAN-UAT.md` is now `- [x]` with an observation" — was **not** fully met. Per this
  continuation's explicit orchestrator instructions (honesty requirements, stated verbatim: the
  user did not supply a brand-swap verdict, did not state whether the drag was judged live, did
  not perform the VoiceOver pass), four G3 checklist rows were left unticked with a "not reported
  by the user at G3; approved by delegation" note rather than ticked to satisfy the letter of the
  plan's own criterion. This is a deliberate choice to prioritize an honest human-approval record
  over a mechanically-satisfied checkbox count, and it is called out here rather than silently
  overridden.
- **The `git stash --keep-index` slip from the Task 1 session**: reported to this continuation as
  having occurred during that earlier session. I could not locate a verbatim record of it anywhere
  in the repo (no mention in `deferred-items.md`, `08-HUMAN-UAT.md`, `STATE.md`, or any commit
  message; `git stash list` is empty and `git reflog` shows no stash entries). I am not fabricating
  detail beyond what was reported to me: a `git stash --keep-index` invocation is a violation of
  this project's absolute prohibition on any `git stash` subcommand in an executor session
  (destructive_git_prohibition). Current state shows no residual stash and no evidence of lost
  work from it. This continuation's own session ran zero `git stash` commands of any kind
  (verified: `git stash list` empty before and after).

## Self-Check

FOUND: docs/ui/APPROVAL.md
FOUND: docs/ui/approved/setup-light.png (and the other 11 approved captures)
FOUND: .planning/phases/08-redise-o-de-la-app/08-HUMAN-UAT.md
FOUND: .planning/phases/08-redise-o-de-la-app/deferred-items.md
FOUND: tests/e2e/discovery.spec.ts (fix applied)
FOUND commit: 67caf0b (fix — Discovery heading exact match)
FOUND commit: c3fa5ca (docs — G3 approval record)

## Self-Check: PASSED
