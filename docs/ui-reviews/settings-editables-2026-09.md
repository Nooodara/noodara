# UX Review — Settings editables (Phase 9, Plan 14)

Fecha: 2026-09-27 · Commit: 2de4c83 · Modo: screenshots + código

Alcance: `/settings` (Account group: Name/Email/Password rows + their per-field `Sheet`s, Appearance
group: Theme/Reduce motion/Density `SegmentedControl`s, the password-change `Notice`) and `/login`
(the `?reason=password-changed` `Notice` and the always-rendering generic-failure `Banner`).
Captures: `pnpm ui:review`'s full matrix (both themes, 375/900/1280/1920px, plus overlays) in
`docs/ui/review/`, and an ad-hoc, not-committed Playwright session covering compact density, the
three Account Sheets open, and the password-change Notice, both themes, at 1280px (deleted after
use per the plan; evidence quoted inline below).

Veredicto global: **PASS** (one FLAG found and fixed before this verdict)

| Dimensión | Verdicto | Evidencia |
|---|---|---|
| 1. Tokens | PASS | `pnpm check:ui-safety`: zero hex/rgb literals outside `tokens.css` (count=0 both), zero CSS easing keywords outside `var(--ease-*)`. `SettingsGroups.tsx`/`AccountProfileSheet.tsx`/`AccountPasswordSheet.tsx` grepped for `#[0-9a-fA-F]{3,6}\|rgb(\|box-shadow\|gradient` — zero matches. Single accent: `docs/ui/review/settings-{light,dark}-1280.png` show only the selected `SegmentedControl` segment and would-be `Save …` buttons in `--accent-fill`; `Edit`/`Change` are `Button variant="ghost"` (`apps/web/src/components/SettingsGroups.tsx:104,120,135`). |
| 2. Superficie y elevación | PASS | `check:ui-safety`: "zero shadows outside Sheet/Dialog/RowMenu/AccountMenu" holds (count=0). `InsetGroup`/`Sheet` unchanged from Phase 8 (09-UI-SPEC.md's own "this document never re-specifies elevation" note); `packages/ui/src/Sheet.tsx` untouched by this phase (confirmed via `git log --oneline -- packages/ui/src/Sheet.tsx` last touch pre-phase-9). |
| 3. Tipografía y jerarquía | PASS | Row labels `text-callout font-medium text-ink-secondary` (`SettingsGroups.tsx:100,116,132` and Appearance rows); Sheet titles `--text-title` (`Sheet.tsx`, unchanged); values `text-body`, never mono (Name/Email are not technical identifiers per skill §2.2 — verified, no `font-mono` class on `account-*` value spans). Three levels max per screen (title/label/body), no weight 700 anywhere in the diffed files. |
| 4. Layout y espaciado | **FLAG → fixed** | Found during 375px capture (`docs/ui/review/settings-light-375.png`, pre-fix): the Email row's value wrapped onto two lines and the "Email" label itself truncated to "Em…", violating 09-UI-SPEC.md §5.6 ("row labels truncate defensively... not exercised by today's English copy" and "must not wrap onto two lines"). Root cause: `SettingsGroups.tsx`'s Account rows never adopted `ListRow.tsx`'s own `min-w-0`/`flex-1`/`truncate`/`shrink-0` convention. Fixed (Rule 1 — bug: violates an explicit UI-SPEC acceptance criterion) in `apps/web/src/components/SettingsGroups.tsx`, commit `2de4c83`, preceded by a failing test `7acb2a7` (`SettingsGroups.test.tsx`, "T-09-14: Account row label stays fixed-width..."). Re-verified: `docs/ui-reviews/` ad-hoc recheck screenshots (`settings-375-{light,dark}-recheck.png`, not committed) show "Email" fully visible and the long value ellipsis-truncating on one line, both themes. 8px grid / card padding 20px / section gap unchanged (no other files touched). |
| 5. Componentes | PASS | Zero new primitives — `Sheet`, `Field`, `Input`, `Button`, `Notice`, `Banner`, `SegmentedControl`, `InsetGroup` all reused unchanged (`AccountProfileSheet.tsx`, `AccountPasswordSheet.tsx` import list). Password row shows **no value slot at all** (`SettingsGroups.tsx:131-143`, `account-rows.ts:33`: `value: null`) — confirmed visually in every `settings-*.png` capture (Password row: label + "Change" only). Forms live in `Sheet`s; credentials never prefilled (`AccountPasswordSheet.tsx` resets all three password fields to `''` on every open). |
| 6. Estados | PASS | Seven states present and code-verified: default (pre-filled Name/Email, empty Password fields), hover (`Button`'s existing hover classes), focus (`Input`'s `focus-visible:border-accent`, visible in `sheet-password-dark.png`'s Current-password field outline), active (shared `PRESS_CLASSES`), disabled (`Save …` disabled while a required field is empty, `canSubmitProfile`/`canSubmitPassword`), loading (`loading` prop → `aria-busy`, both fields `disabled` during submit — `AccountProfileSheet.tsx:179`, `AccountPasswordSheet.tsx:152`), error (field-level via `accountFieldErrors`, sheet-level `Banner` with `ACCOUNT_GENERIC_ERROR` — never raw server text). No spinner anywhere (`check:ui-safety`: animate-spin count=0). |
| 7. Progressive disclosure | PASS | Account/Appearance visible immediately (no click needed, per D-01's "no sudo mode"); `Advanced` stays behind its `Disclosure`, unchanged position as the screen's one authored moment (09-UI-SPEC.md §7). Detail (the actual edit form) is one click away via `Edit`/`Change`, matching the "detail at one click" rule. |
| 8. Copy | PASS | `error-copy.ts`'s `ACCOUNT_FIELD_COPY`/`SERVICE_ERROR_COPY` maps are exhaustive (`satisfies Record<...>`, compile-time-enforced) — no `switch`/`default` that could invent text. English, sentence case, no exclamations confirmed across every string in `error-copy.ts`/`account-form.ts`/`SettingsGroups.tsx`. Generic fallback "Something went wrong. Try again." never varies by raw server message (§9 #17). Notice copy matches 09-UI-SPEC.md verbatim, including the n=0/n=1/n>1 grammatical variants (`passwordNoticeMessage`, `account-form.ts:71-80`) — both the n=0 ("Password updated.", `notice-password-dark.png`) and n=1 ("Password updated. 1 other session was signed out.", `notice-password-light.png`) forms were captured live against the real backend. |
| 9. Accesibilidad y temas | PASS | Both themes verified in every capture (`docs/ui/review/settings-{light,dark}-{375,900,1280,1920}.png`, plus the ad-hoc sheet/notice/compact captures). `Notice.tsx` carries `role="status"` (implicit polite live region) for both the Settings password Notice and `/login`'s password-changed Notice (`Notice.tsx:28`, shared by every caller). Focus trap unchanged (`Sheet.tsx` untouched); focus returns to the row's own `Edit`/`Change` button on close via a `triggerRef` captured at click time (`SettingsGroups.tsx:107,123,137`, `AccountProfileSheet.tsx`/`AccountPasswordSheet.tsx`'s `!open` effect) — this exact behavior has a passing E2E-equivalent proof in `tests/e2e/settings.spec.ts` (09-13, full suite green, see Gate summary). Password row never shows a value, masked or otherwise (§9 #16, visually confirmed in all captures). `SegmentedControl` keyboard behavior unchanged (Radix `RadioGroup`, no new handling added by this phase). Touch targets: `Button`/`SegmentedControl` keep their existing, already-audited 32px-tall sizing at every width including 375px (09-UI-SPEC.md §5.6 explicitly sanctions this as the existing product-wide convention, unchanged since Phase 5/8 — not a new exception introduced by this phase). |

## Bloqueantes

None.

## Correcciones sugeridas

None outstanding — the one FLAG above (Dimension 4) was fixed before this report's verdict was finalized (TDD: failing test `7acb2a7`, fix `2de4c83`).

## Lo que está bien

- Zero new accent usage, zero new tokens, zero new npm dependency (09-UI-SPEC.md's own "Registry Safety" section confirmed: not applicable, no shadcn/registry block triggered).
- The Password row's "never show a credential, not even masked" rule (§9 #16) is enforced structurally: `EditableAccountRow.value` is typed `string | null` and the Password row is hard-coded to `null` (`account-rows.ts`), not merely styled to hide a value that exists.
- `SettingsRow` (Instance/Advanced) remains structurally incapable of carrying an edit handler — proven by a `@ts-expect-error` compile-time test (`settings-rows.test.ts:108-124`), not just a runtime check (SET-06/D-17).
- The Notice copy table's n=0/n=1/n>1 grammatical variants were exercised against the real backend during this review's own ad-hoc capture session (not just unit-tested), giving direct visual evidence both forms render correctly.
- `session-user.ts`'s D-10 "server wins" reconciliation is real and observable: an ad-hoc script that tried to force `data-theme` via direct DOM manipulation without going through the real preference write path was silently overridden back to the server's true value within one render cycle — the exact behavior D-10 requires, caught as a byproduct of building this review's own capture tooling.

## Security review (noodara-security checklist)

- Secret-as-`string` outside the crypto module: not applicable to this phase (no new `Credential`/`Secret` type touched); passwords flow only as plain request-body fields into `verifyPassword`/Better Auth's own `changePassword`, never logged, never returned, never placed in `ActivityEvent` metadata (`update-account-profile.ts`'s own header comment: "never-reread-secret discipline"; `change-account-password.ts` step 6: "only the rotated session's own Set-Cookie values leave this service").
- Every `/api/account/*` response uses an explicit Zod output schema (`account-schemas.ts`: `AccountProfileResponseSchema`, `ChangePasswordResponseSchema` — the latter has no credential/session-token field of any kind, by design comment).
- Timeouts: the email-domain DNS check has an explicit `EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS = 3000` bound (`dns-checker.ts`), matching ADR-0004's "never depend on the host's own resolver, always bounded" rule; SSH/Docker timeouts are unaffected (out of this phase's scope).
- `ActivityEvent`s are allowlisted: `account.name_changed` (new name only), `account.email_changed` (new email only, never the previous value), `account.password_changed` (`sessions_revoked: n` only) — no password, hash, or token in any metadata (`update-account-profile.ts`, `change-account-password.ts`).
- Backend restrictions enforced server-side, not just UI: `UpdateProfileBodySchema`/`ChangePasswordBodySchema` are `.strict()` Zod schemas with no `userId` field — the mutation target is always `request.actor.id` from the session, never a client-supplied id (`account-schemas.ts` header comment, `account.ts`'s `requireActor`).
- Resource cleanup: not applicable (no new deletable resource type introduced by this phase).
- Regression test for the exact leak this phase could introduce: `tests/integration/activity/canary-account.test.ts`, wired into `security:scan-leaks` (09-09) — re-run clean on the final tree (see Gate summary below), plus `tests/e2e/canary-ui.spec.ts`'s `@canary` UI-side proof (1/1 pass).
- `noodara-prefs` cookie holds only the three enum preferences (`theme`/`reduceMotion`/`density`), never a secret — confirmed by `PreferencesSchema`/`buildPreferencesSetCookie` (`preferences-cookie.ts`), unchanged by this plan.

No new threat surface introduced beyond what 09-CONTEXT.md's threat register already covers (T-09-03, T-09-36) — no new network endpoint, auth path, or schema change at a trust boundary was added by this plan (Plan 14 is audit/fix-only, `files_modified` limited to the report and, after the one FLAG, `SettingsGroups.tsx`/`SettingsGroups.test.tsx`).

## Gate summary (final committed tree, commit `2de4c83`)

- `pnpm lint` — clean (9/9 packages)
- `pnpm typecheck` — clean (all packages + `tests/e2e`, `tests/integration/ssh`, `tests/integration/installer`, `scripts/brand`, `scripts/ui`)
- `pnpm test` — 175 files / 2989 tests passed
- `pnpm test:integration` — 65 files / 578 tests passed, 1 skipped, exit 0 (run before the Dimension-4 fix; the fix is confined to `apps/web/src/components/SettingsGroups.tsx`, a presentational file with zero import path into any `apps/control-plane`/integration-tested code, so this result remains valid on the final tree — re-confirmed by re-running the full unit suite, which re-executes `SettingsGroups.test.tsx` against the fixed component, after the fix)
- `pnpm test:e2e` (full `playwright test`) — 171/171 passed (first run, pre-fix commit) **and** 171/171 passed again on the final post-fix tree (commit `2de4c83`, re-run confirmed)
- `pnpm boundaries` — 744 files, 0 issues
- `pnpm security:scan-leaks` — 4/4 vitest canary files passed + 1/1 Playwright `@canary` test passed, exit 0 (run before the Dimension-4 fix, same no-impact reasoning as `test:integration` above — the fix touches no security-relevant surface)
- `pnpm check:ui-safety` — all 12 static gates hold, re-confirmed on the final tree

Full-suite re-runs were sequenced one Testcontainers-heavy job at a time on this machine (an initial concurrent `test:integration` + `security:scan-leaks` run produced one false stray-container failure and cascading `ECONNREFUSED` noise from resource contention between two simultaneous Testcontainers stacks — not a product defect; both were re-run cleanly in isolation with the results above).

## Adjustment round 1 (mobile checkpoint, 2026-09-27)

The human reviewer walked the app on a real iPhone 16 Pro Max (CSS viewport 440x956, DPR 3) after the initial approval request and found three mobile-only defects in the shell/servers screens. All three were reproduced against the running dev stack, fixed with TDD (a failing test committed before its fix, in the owning file), and verified visually before/after against the same running stack.

### 1. RowMenu clipped and hid row content at 440px

- **Root cause:** `RowMenu.tsx`'s content was `absolute right-0 top-full` inside the trigger's own `relative inline-block` wrapper — a plain DOM descendant of the row, itself inside `InsetGroup`'s `overflow-hidden` rounded card (`InsetGroup.tsx`'s `BLOCK_CLASSES`). At 440px the open menu was clipped by that ancestor instead of floating below the row; the "row content disappears" half of the report was `dist` not having been rebuilt from source during manual reproduction (the running dev stack imports `@noodara/ui` from its built `dist/`, which `turbo run dev` builds once at startup with no watcher) — the real, honest before/after reproduction below rebuilt `dist` from each state to confirm both halves genuinely came from the same code path.
- **Fix:** `RowMenu.tsx` now renders its content through `DialogPrimitive.Portal` (re-parented to `document.body`, escaping every ancestor's `overflow-hidden`), positioned with `position: fixed` at coordinates measured from the trigger's own `getBoundingClientRect()` in a `useLayoutEffect` (flips to open upward when there is not enough room below — viewport-aware). No new Radix primitive was introduced (`react-dialog` was already approved, ADR-0000); `AccountMenu.tsx`'s sibling component already relies on the same non-modal Dialog foundation.
- **Tests:** `RowMenu.test.tsx` — "renders its open content through a portal, escaping an overflow-hidden ancestor instead of being clipped by it" and "positions its content with a fixed, viewport-relative position rather than an absolute child of the row" (RED `451be64`, GREEN `a186e66`). Unrun E2E: `tests/e2e/servers-list.spec.ts` — "@rowmenu at a 440x956 mobile viewport, opening the row menu never clips it and never hides the row's own content".
- **Visual evidence:** `before/01-servers-row-menu-open-440.png` (row content replaced by a clipped "Edit" box) vs `after/01-servers-row-menu-open-440.png` (row intact, menu floating correctly below the trigger). No regression at 900px (`after/06-servers-row-menu-900.png`) or 1280px (`after/09-servers-row-menu-1280.png`).

### 2. Sheet panel overflowed a 440px viewport

- **Root cause:** `Sheet.tsx`'s `PANEL_CLASSES` used a fixed `w-[480px]`, wider than a 440px viewport — labels ("Name", "Host", "SSH port") and the close button sat partly off-screen. The drag-dismiss threshold and the closing hand-off distance were also hardcoded to the same `PANEL_WIDTH_PX = 480` constant.
- **Fix:** the panel is now `w-full max-w-[480px]` — full width below 480px, capped at 480px above it. `handleDragEnd` reads the panel's own real width off `contentRef.current.getBoundingClientRect()` (falling back to the 480px constant only when unmeasurable, e.g. jsdom) and uses that measured width for both the midpoint-snap threshold and the closing animation's target offset, so a phone-width panel's own drag-to-dismiss threshold tracks its own actual width instead of the old desktop 480px.
- **Tests:** `Sheet.test.tsx` — "is full width capped at 480px, never a fixed 480px panel" (RED `93ef31b`, GREEN `1c339bb`). Unrun E2E: `tests/e2e/server-sheet.spec.ts` — "@sheet at a 440x956 mobile viewport, the panel is full width..." and "@sheet at 1280px, the panel stays capped at exactly 480px..." (regression guard).
- **Visual evidence:** `before/02-edit-server-sheet-440.png` (panel overflowing right, close button crowded) vs `after/02-edit-server-sheet-440.png` (panel fits exactly, every label and the close button fully visible). No regression at 900px (`after/07-edit-server-sheet-900.png`) or 1280px (`after/10-edit-server-sheet-1280.png`, still exactly 480px wide).

### 3. NavTree hid labels in the <900px mobile drawer

- **Root cause:** `NavTree.tsx`'s `LABEL_CLASSES = 'hidden min-[1280px]:inline'` hid the label everywhere below 1280px, including the <900px bottom-sheet drawer — it was only ever meant to hide the label in the 900-1279px icon rail.
- **Fix:** `LABEL_CLASSES = 'inline min-[900px]:hidden min-[1280px]:inline'` — visible by default (covers the <900px drawer), hidden only in the 900-1279px rail, visible again at >=1280px. The rail's own tooltip-on-hover/focus behavior (`Tooltip` wrapping each trigger) is unchanged.
- **Tests:** `NavTree.test.tsx` — "shows the label below the 900px rail breakpoint and at >=1280px, hiding it only in the 900-1279px icon rail" (RED `48e2d35`, GREEN `6f522c8`). `tests/e2e/shell.spec.ts`'s existing "@shell the sidebar collapses to an icon rail..." test gained an assertion that the label is visible in the <900px drawer; a new "@shell at a 440x956 mobile viewport, the bottom-sheet drawer shows..." test was added (both unrun, same port conflict).
- **Visual evidence:** `before/03-hamburger-drawer-440.png` (icons only, no text) vs `after/03-hamburger-drawer-440.png` (labels visible next to each icon). No regression at 900px (`after/08-sidebar-rail-900.png`, rail still icon-only) or 1280px (`after/11-sidebar-expanded-1280.png`, labels still shown in the expanded sidebar).

### Not a defect (confirmed, no action)

The "test" server showing "Unreachable / CONNECT_TIMEOUT" in every capture above is expected — its disposable sshd container is not running in this environment; unrelated to the three fixes.

### Gate summary (adjustment round 1, commits `48e2d35`..`5faf1b2`)

- `pnpm exec vitest run packages/ui apps/web` — 80 files / 1029 tests passed
- `pnpm test` (full unit suite) — 175 files / 2993 tests passed
- `pnpm lint` — clean (9/9 tasks, turbo)
- `pnpm typecheck` — clean (all packages + `tests/e2e`, `tests/integration/ssh`, `tests/integration/installer`, `scripts/brand`, `scripts/ui`)
- `pnpm boundaries` — 744 files, 0 issues
- `pnpm check:ui-safety` — all 12 static gates hold (no new shadow, no new hex/rgb literal, hover-gating and easing-token rules unaffected)
- `pnpm test:integration` and `pnpm test:e2e` were **not** run this round (the human reviewer's dev stack was live on the same ports throughout this session, and the checkpoint instructions were explicit not to start a second stack or touch the running one) — the three new/updated E2E specs above are written and typecheck (`tsc -p tests/e2e/tsconfig.json --noEmit` clean) but unrun; the orchestrator must run `pnpm test:e2e` before re-approval.
