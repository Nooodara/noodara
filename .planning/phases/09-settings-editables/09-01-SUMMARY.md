---
phase: 09-settings-editables
plan: 01
subsystem: domain
tags: [zod, preferences, activity-log, validators, cookie-codec]

requires: []
provides:
  - "Preferences schema, DEFAULT_PREFERENCES, resolveStoredPreferences, mergePreferences and the noodara-prefs cookie codec (packages/domain/src/preferences)"
  - "preferencesToRootAttributes for SSR data-theme/data-motion/data-density"
  - "validateName and validateAccountEmail (packages/domain/src/validators/identity.ts)"
  - "ACCOUNT_ACTIONS union with a per-action metadata allowlist enforced in buildActivityEvent"
  - "activity-copy.ts entries for account.name_changed, account.email_changed, account.password_changed"
affects: [09-02, 09-03, 09-04, 09-05]

tech-stack:
  added: []
  patterns:
    - "Preferences follow the same as-const tuple + z.enum + strict object idiom as activity-event.ts's action unions"
    - "Per-action metadata allowlist (ACCOUNT_ACTION_METADATA_KEYS) checked before the general forbidden-key walk in buildActivityEvent"
    - "parsePreferencesCookieValue defaults per-segment on tamper, but whole-value on structural corruption (wrong segment count or over-length)"

key-files:
  created:
    - packages/domain/src/preferences/preferences.ts
    - packages/domain/src/preferences/preferences.test.ts
    - packages/domain/src/preferences/index.ts
  modified:
    - packages/domain/src/index.ts
    - packages/domain/package.json
    - packages/domain/src/validators/identity.ts
    - packages/domain/src/validators/identity.test.ts
    - packages/domain/src/activity/activity-event.ts
    - packages/domain/src/activity/activity-event.test.ts
    - apps/web/src/lib/activity-copy.ts
    - apps/web/src/lib/activity-copy.test.ts

key-decisions:
  - "mergePreferences builds the result field-by-field (patch.field ?? current.field) instead of object-spreading the patch, since TypeScript's structural typing otherwise allows an explicit `undefined` from an optional patch key to overwrite a required Preferences field at the type level"
  - "CONTROL_CHARACTERS regex needs an eslint-disable-next-line for no-control-regex (deliberately matching C0/C1 ranges); Array.from(trimmed).length used instead of [...trimmed].length to avoid no-misused-spread on strings, matching how the codebase already avoids that rule elsewhere"

requirements-completed: [SET-02, SET-03, SET-04, SET-05]

duration: ~40min
completed: 2026-09-27
---

# Phase 9 Plan 01: Preferences, cookie codec, name/email validators and account.* activity actions Summary

**Pure domain layer for phase 9: `Preferences` zod schema + `noodara-prefs` cookie codec, `validateName`/`validateAccountEmail`, and three `account.*` activity actions with a metadata allowlist enforced at construction.**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-09-27T06:43:00Z
- **Completed:** 2026-09-27T06:50:26Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- `@noodara/domain/preferences` subpath exporting the `Preferences`/`PreferencesPatch` zod schemas, `DEFAULT_PREFERENCES`, `resolveStoredPreferences`, `mergePreferences`, the `noodara-prefs` cookie codec (`serializePreferencesCookieValue`/`parsePreferencesCookieValue`) and `preferencesToRootAttributes` for SSR `<html>` attributes
- `validateName` (1-80 code points, no control characters, trims) and `validateAccountEmail` (trim + existing `validateEmail`) in `packages/domain/src/validators/identity.ts`
- `ACCOUNT_ACTIONS` (`account.name_changed`, `account.email_changed`, `account.password_changed`) added to `ActivityAction`, with a structural per-action metadata allowlist that throws `SensitiveMetadataError` for any key outside `{ name }` / `{ email }` / `{ sessions_revoked }` respectively — this runs before the existing forbidden-key walk
- `apps/web/src/lib/activity-copy.ts` renders the three new actions with the exact D-08 sentences and curated details ("Name", "Email", "Other sessions signed out")

## Task Commits

Each task followed RED → GREEN:

1. **Task 1: Preferences schema, defaults and the noodara-prefs cookie codec**
   - `fa6a462` test(09-01): add failing tests for Preferences schema and cookie codec
   - `bb3f8af` feat(09-01): add Preferences schema, defaults and noodara-prefs cookie codec
2. **Task 2: validateName, validateAccountEmail and the account.* activity actions with a metadata allowlist**
   - `07e62f9` test(09-01): add failing tests for identity, account actions and activity copy
   - `20641db` feat(09-01): add validateName, validateAccountEmail and account.* activity actions

## Files Created/Modified
- `packages/domain/src/preferences/preferences.ts` - Preferences schema, defaults, resolver, merge, cookie codec, root-attribute mapper
- `packages/domain/src/preferences/preferences.test.ts` - 39 tests covering every behavior bullet including the two branch-coverage gap-fillers added during GREEN
- `packages/domain/src/preferences/index.ts` - subpath barrel
- `packages/domain/src/index.ts` - re-exports `./preferences/index.js`
- `packages/domain/package.json` - adds `"./preferences"` to `exports`
- `packages/domain/src/validators/identity.ts` - `validateName`, `validateAccountEmail`
- `packages/domain/src/validators/identity.test.ts` - name/email edit tests, including code-point-length emoji cases
- `packages/domain/src/activity/activity-event.ts` - `ACCOUNT_ACTIONS`, `AccountAction`, `ACCOUNT_ACTION_METADATA_KEYS`, allowlist enforcement in `buildActivityEvent`
- `packages/domain/src/activity/activity-event.test.ts` - account action construction and `SensitiveMetadataError` tests
- `apps/web/src/lib/activity-copy.ts` - `nameEntry`, `sessionsRevokedEntry`, three new `ACTIVITY_COPY` entries, widened `KNOWN_ACTIONS`
- `apps/web/src/lib/activity-copy.test.ts` - sentence/detail tests for the three account actions

## Decisions Made
- `mergePreferences` avoids `{ ...current, ...patch }` in favor of an explicit per-field `??` merge — TypeScript's optional-key spread otherwise types the result as possibly containing `undefined` for a required field
- Two lint fixes required for `identity.ts`: `eslint-disable-next-line no-control-regex` on `CONTROL_CHARACTERS` (deliberately a C0/C1 control-character class) and `Array.from(trimmed).length` instead of a string spread (`no-misused-spread`), while still counting Unicode code points rather than UTF-16 code units

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed a TypeScript build error in mergePreferences**
- **Found during:** Task 1 (`pnpm --filter @noodara/domain build`)
- **Issue:** `{ ...current, ...patch }` typed as possibly assigning `undefined` to a required `Preferences` field, since `PreferencesPatch`'s keys are all optional
- **Fix:** Rewrote as an explicit field-by-field `patch.field ?? current.field` merge
- **Files modified:** packages/domain/src/preferences/preferences.ts
- **Verification:** `pnpm --filter @noodara/domain build` exits 0; all 39 preferences tests still pass
- **Committed in:** bb3f8af (Task 1 GREEN commit)

**2. [Rule 3 - Blocking] Fixed two ESLint errors in identity.ts**
- **Found during:** Task 2 (`pnpm lint`)
- **Issue:** `no-control-regex` flagged the deliberate C0/C1 control-character regex; `@typescript-eslint/no-misused-spread` flagged `[...trimmed].length` for code-point counting
- **Fix:** Added a scoped `eslint-disable-next-line no-control-regex` comment; switched to `Array.from(trimmed).length` (still code-point-accurate, not spread syntax)
- **Files modified:** packages/domain/src/validators/identity.ts
- **Verification:** `pnpm --filter @noodara/domain lint` exits 0; identity tests (including the 80/81-emoji code-point cases) still pass
- **Committed in:** 20641db (Task 2 GREEN commit)

**3. [Rule 2 - Missing Critical] Added two branch-coverage tests during GREEN**
- **Found during:** Task 1 (`pnpm exec vitest run --coverage packages/domain/src/preferences` showed 88.57% branch, below the 95% acceptance gate)
- **Issue:** `resolveStoredPreferences`'s invalid-`reduceMotion` branch and `parsePreferencesCookieValue`'s invalid-theme/invalid-density segment branches were untested
- **Fix:** Added `defaults an invalid reduceMotion field...`, `defaults an invalid theme segment...` and `defaults an invalid density segment...` test cases
- **Files modified:** packages/domain/src/preferences/preferences.test.ts
- **Verification:** coverage rose to 100% statements / 97.14% branches for preferences.ts
- **Committed in:** bb3f8af (Task 1 GREEN commit, tests added before the commit)

---

**Total deviations:** 3 auto-fixed (2 blocking build/lint failures, 1 missing coverage)
**Impact on plan:** All three are required for the plan's own acceptance criteria (build, lint, ≥95% branch coverage). No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `@noodara/domain/preferences`, `validateName`/`validateAccountEmail` and `ACCOUNT_ACTIONS` are importable and fully tested; plans 09-02 (migration/endpoints), SSR first paint and the Settings UI can now consume these contracts without redefining them.
- No blockers identified for the next plan in the wave.

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*
