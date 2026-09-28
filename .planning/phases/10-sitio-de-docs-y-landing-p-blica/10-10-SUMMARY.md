---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 10
subsystem: docs-content
tags: [error-codes, concepts, first-server, scope, d-08, d-09, d-10, docs-01, docs-02]

requires:
  - phase: 10-05
    provides: "apps/site/src/lib/source.ts (Fumadocs loader), the five meta.json files with the full D-08 sidebar lists"
  - phase: 10-06
    provides: "apps/site/src/lib/content-rules.ts (forbidden-wording/unsafe-markup scan), apps/site/src/content/scope.ts (DELIVERED_CAPABILITIES/SCOPE_EXCLUSIONS), ScopeNote/ScopeTable MDX components"
  - phase: 10-08
    provides: "install.mdx/first-login.mdx (linked from first-server.mdx), operate/troubleshooting.mdx and reference/exit-codes.mdx (linked from error-codes.mdx and first-server.mdx)"
provides:
  - "apps/site/content/docs/reference/error-codes.mdx: the HTTP API errors table, one row per SERVICE_ERROR_STATUS key, tested against the real vocabulary via an extensible ERROR_VOCABULARIES registry"
  - "apps/site/content/docs/getting-started/first-server.mdx: install -> first login -> add server -> trust the fingerprint -> discovery -> server detail, every bold UI label proven against apps/web/src"
  - "apps/site/content/docs/concepts/{server,project,environment,service,deployment}.mdx: the domain model as a model, statuses proven against packages/domain's SERVER_STATUSES + packages/ui's STATUS_WORDS, ScopeNotes on the not-yet-built entities"
  - "apps/site/content/docs/reference/scope.mdx: the Scope of this release page rendering ScopeTable from scope.ts"
  - "tests/unit/docs/error-codes-accuracy.test.ts and tests/unit/docs/concepts-accuracy.test.ts: the accuracy tests behind both pages"
affects: []

tech-stack:
  added: []
  patterns:
    - "ERROR_VOCABULARIES is an array of { heading, source, load() }, one entry today (HTTP API errors -> SERVICE_ERROR_STATUS); Phase 11 appends one entry per classification table (classifyGitError, classifyDockerError, deployment failure codes) with its own ## heading, and the 'no heading beyond the registry' test makes an undocumented-but-present heading a compile-visible test failure rather than a silent gap"
    - "concepts-accuracy.test.ts's bold-span check collapses hard line-wraps inside a `**...**` span to a single space before comparing against apps/web/src's own source text -- Markdown prose wrapping a label across two lines must not desync it from the verbatim label it is proving"
    - "concepts pages accept a narrow, explicit phrase ban ('in the panel you can', 'click', 'the UI lets', 'open the') instead of a broad heuristic, so 'the model, not the UI' rule (D-09) is enforced mechanically for exactly the four not-yet-built entities"

key-files:
  created:
    - tests/unit/docs/error-codes-accuracy.test.ts
    - apps/site/content/docs/reference/error-codes.mdx
    - tests/unit/docs/concepts-accuracy.test.ts
    - apps/site/content/docs/getting-started/first-server.mdx
    - apps/site/content/docs/concepts/server.mdx
    - apps/site/content/docs/concepts/project.mdx
    - apps/site/content/docs/concepts/environment.mdx
    - apps/site/content/docs/concepts/service.mdx
    - apps/site/content/docs/concepts/deployment.mdx
    - apps/site/content/docs/reference/scope.mdx
  modified:
    - apps/site/src/lib/docs-tree.test.ts

key-decisions:
  - "getting-started/meta.json, concepts/meta.json and reference/meta.json already carried the full D-08 lists (10-05's own key-decision confirmed Fumadocs silently drops meta.json entries with no matching file, so the full lists were safe to keep even before this plan's pages existed) -- no meta.json edit was needed; docs-tree.test.ts was instead tightened with a new assertion (every listed slug has an MDX file, every non-index MDX file is listed) so that guarantee is now proven, not just historically true."
  - "concepts/project.mdx has no ScopeNote (the plan's must_haves only name service/environment/deployment); its closing sentence states the same 'not created or deployed from the panel' fact in plain prose instead, keeping the page under the 40-line ceiling without inventing a fifth ScopeNote id."

requirements-completed: [DOCS-01, DOCS-02, SITE-01]

duration: 55min
completed: 2026-09-28
---

# Phase 10 Plan 10: Error codes, concepts pages, your first server guide, scope of this release Summary

Completed DOCS-01/DOCS-02's remaining content: the error-code reference (tested against `SERVICE_ERROR_STATUS` through an extensible vocabulary registry Phase 11 appends to), the "Your first server" guide (every bold UI label proven verbatim against `apps/web/src`), the five Concepts pages (Server's statuses proven against the domain state machine, the other four scoped with `ScopeNote`/a phrase ban instead of claiming unbuilt UI), and the Scope of this release reference page. All fifteen D-08 docs pages now exist and export.

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-09-28
- **Tasks:** 3/3 completed
- **Files modified:** 11 (10 created, 1 modified)

## Accomplishments

- `tests/unit/docs/error-codes-accuracy.test.ts` defines `ERROR_VOCABULARIES` (today: one entry, `{ heading: 'HTTP API errors', source: 'apps/control-plane/src/routes/http-errors.ts', load: () => SERVICE_ERROR_STATUS }`) and proves, per vocabulary: exact row count, every code present with its exact status, no extra code, and no `##` heading in the page beyond a registered vocabulary. `apps/site/content/docs/reference/error-codes.mdx` documents all 21 `SERVICE_ERROR_STATUS` codes with a one-sentence, present-tense meaning grepped from where each code is actually thrown in `apps/control-plane/src/services`/`routes`.
- `tests/unit/docs/concepts-accuracy.test.ts` proves: every `**bold**` span on `first-server.mdx` occurs verbatim under `apps/web/src` (non-test files); the guide covers install → first login → **Add server** → **Trust new fingerprint** → Discovery → server detail in that order; `concepts/server.mdx`'s `## Statuses` table lists exactly `SERVER_STATUSES.map(s => STATUS_WORDS[s])`; `service.mdx`/`environment.mdx`/`deployment.mdx` carry their D-09/D-10 `ScopeNote`s; and none of `project`/`environment`/`service`/`deployment.mdx` uses "in the panel you can", "click", "the UI lets" or "open the".
- `first-server.mdx` walks the real flow against the real UI: `ServerSheet.tsx`'s exact field labels (Name, Host, SSH port, SSH user, Password/Private key) and button labels (Add server, Save and connect, Save without connecting), `TrustFingerprintDialog.tsx`'s "Trust new fingerprint" confirm label and blocks-of-four fingerprint rendering, `DiscoverySection.tsx`'s six-step sequence (SSH reachable, Authenticated, OS, Resources, Docker, Access), and states plainly that no agent is installed on the server.
- The five Concepts pages (`server`, `project`, `environment`, `service`, `deployment`, each ≤40 lines) define the entity and its relations (`Project → Environment → Service → Deployment`, `Server ↔ Service`), matching `packages/domain/src/server/server-state.ts`'s six statuses and the domain skill's Project/Environment/Service/Deployment model, without claiming this release's panel manages the last four.
- `apps/site/content/docs/reference/scope.mdx` renders `<ScopeTable />` from `apps/site/src/content/scope.ts`, the one typed source `10-06` built.
- `apps/site/src/lib/docs-tree.test.ts` gained a new assertion proving every `meta.json`-listed slug has a matching MDX file and every non-index MDX file is listed somewhere — the "restore the full list, then prove it" step the plan called for, since the full lists (D-08) were already in place from `10-05`.
- Real `pnpm --filter @noodara/site build` produces 16 static docs HTML files (>= 15 required), including `getting-started/first-server.html`, `concepts/deployment.html` and `reference/scope.html`; `check-export.mjs` reports 21 files, zero third-party assets.

## Task Commits

1. **Task 1: Error codes reference, tested against the real vocabulary** — RED `5caa998` → GREEN `93a3a68`
2. **Task 2: Your first server, the five Concepts pages, and their accuracy test** — RED `e3b2651` → GREEN `406c714`
3. **Task 3: Scope of this release page, docs-tree tightening, full docs build** — `0997447`

_TDD: Tasks 1 and 2 followed RED (failing test committed first) → GREEN (content, including test-bug fixes discovered while verifying, committed second). Task 3 has no new behavior to test-first — it composes existing tested primitives (`ScopeTable`) and tightens an existing test._

## Files Created/Modified

- `tests/unit/docs/error-codes-accuracy.test.ts` — `ERROR_VOCABULARIES` registry, table-diff proof, heading-exhaustiveness check, stack/cause body-example ban
- `apps/site/content/docs/reference/error-codes.mdx` — 21-row HTTP API errors table
- `tests/unit/docs/concepts-accuracy.test.ts` — bold-span-in-UI check, ordered-steps check, Statuses-table check, ScopeNote checks, no-unbuilt-UI phrase ban
- `apps/site/content/docs/getting-started/first-server.mdx` — install → first login → add server → trust fingerprint → discovery → server detail
- `apps/site/content/docs/concepts/{server,project,environment,service,deployment}.mdx` — the domain model, statuses, relations
- `apps/site/content/docs/reference/scope.mdx` — `<ScopeTable />` page
- `apps/site/src/lib/docs-tree.test.ts` — added the every-slug-has-a-file / every-file-is-listed assertion

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] `concepts-accuracy.test.ts`'s own bold-span regex broke on a prose-wrapped label**
- **Found during:** Task 2's first GREEN verify run
- **Issue:** `first-server.mdx`'s Markdown source wraps "Save without connecting" across two lines inside its `**...**` span; the test's original `/\*\*([^*]+)\*\*/g` regex (where `[^*]` also matches `\n`) captured `"Save without\nconnecting"` — a string that, correctly, does not occur verbatim anywhere in `apps/web/src` — and failed.
- **Fix:** `boldSpans()` now collapses internal whitespace/newlines inside each matched span to a single space before extracting it, so a label wrapped across a hard line break still matches its unwrapped source string.
- **Files modified:** `tests/unit/docs/concepts-accuracy.test.ts`
- **Verification:** re-ran `pnpm vitest run tests/unit/docs/concepts-accuracy.test.ts` — the bold-span assertion passed.
- **Committed in:** `406c714` (Task 2 GREEN commit)

**2. [Rule 1 — Bug] `concepts-accuracy.test.ts`'s Statuses-table regex counted the header row as a status word**
- **Found during:** Task 2's first GREEN verify run
- **Issue:** The original regex matched any `| <word> |`-shaped line under `## Statuses`, including the table's own `| Status | Meaning |` header row, so the extracted word set always contained the extra literal `"Status"` and never equaled `SERVER_STATUSES.map(s => STATUS_WORDS[s])`.
- **Fix:** The test now slices the section to start at the `\n|---` separator line before matching, so only table body rows are read.
- **Files modified:** `tests/unit/docs/concepts-accuracy.test.ts`
- **Verification:** re-ran the same test — the Statuses assertion passed with the exact 6-word set.
- **Committed in:** `406c714` (Task 2 GREEN commit)

**3. [Rule 1 — Bug] `error-codes.mdx`'s own intro sentence tripped its own "no stack trace" test**
- **Found during:** Task 1's first GREEN verify run
- **Issue:** The page's intro prose said the body "never carries a stack trace or any other internal detail" — the word "stack" in that sentence matched the test's own `/\bstack\b/i` ban, which exists to catch a real documented stack trace, not a sentence describing the absence of one.
- **Fix:** Reworded to "nothing else is ever attached to it" — same meaning, no longer self-matching.
- **Files modified:** `apps/site/content/docs/reference/error-codes.mdx`
- **Verification:** re-ran `pnpm vitest run tests/unit/docs/error-codes-accuracy.test.ts` — passed.
- **Committed in:** `93a3a68` (Task 1 GREEN commit)

---

**Total deviations:** 3 auto-fixed bugs, all in test code discovered while verifying the content it tests, all fixed before that task's GREEN commit landed.

## Acceptance-Criteria Demonstrations (recorded, then reverted)

- **Task 1:** Temporarily deleted the `VALIDATION_FAILED` row from `error-codes.mdx` and re-ran `pnpm vitest run tests/unit/docs/error-codes-accuracy.test.ts`: failed with `row count must equal key count for "HTTP API errors": expected 20 to be 21`. Restored the row from a backup copy; the full suite passed again (4/4) afterward.

## Known Stubs

None — every page renders real, sourced content (the real `SERVICE_ERROR_STATUS` vocabulary, real `apps/web/src` UI labels, the real `SERVER_STATUSES`/`STATUS_WORDS` domain mapping, and `scope.ts`'s own claims/limits). No hardcoded empty value, no "coming soon" placeholder.

## Threat Flags

None — all three threat register entries (T-10-12, T-10-04, T-10-03) are mitigated exactly as planned: `error-codes-accuracy`/`concepts-accuracy` hold exact code→status and statuses/labels equality against the real sources; the concepts pages carry `ScopeNote`s and are proven free of unbuilt-UI phrasing; the error body example shown is `{ "error": "<CODE>", "message": "<text>" }` only, proven free of `stack`/`"cause"`.

## Verification

- `pnpm vitest run tests/unit/docs/error-codes-accuracy.test.ts tests/unit/site/forbidden-words.test.ts` — 6 passed
- `pnpm vitest run tests/unit/docs/concepts-accuracy.test.ts tests/unit/site/forbidden-words.test.ts tests/unit/site/landing-claims.test.ts` — 21 passed
- `pnpm vitest run apps/site/src/lib/docs-tree.test.ts tests/unit/docs tests/unit/site` — 162 passed
- `pnpm vitest run` (full repo) — 195 files / 3210 tests passed
- `pnpm --filter @noodara/site build` — succeeded; route summary shows 17 static `/docs/...` paths; `check-export: 21 files, zero third-party assets`
- `find apps/site/out/docs -name '*.html' | wc -l` — 16 (>= 15 required); `getting-started/first-server.html`, `concepts/deployment.html`, `reference/scope.html` all present
- `grep -cE "^\| \`[A-Z_]+\` \| [0-9]{3} \|" apps/site/content/docs/reference/error-codes.mdx` — 21
- `grep -c "ScopeNote" apps/site/content/docs/concepts/service.mdx` — 2
- `for f in project environment service deployment; do wc -l < .../concepts/$f.mdx; done` — 18, 16, 17, 13 (all ≤ 40)
- `grep -c "ScopeTable" apps/site/content/docs/reference/scope.mdx` — 1
- `pnpm --filter @noodara/site typecheck` / `lint` — clean
- `pnpm typecheck` / `pnpm lint` (full repo) — clean
- `pnpm check:ui-safety` — all 12 gates OK
- `pnpm boundaries` — no issues
- `pnpm ui:review:site` — 50 captures generated (5 surfaces × light/dark × 4 breakpoints + 2 reduced-motion), zero third-party requests; all four new docs surfaces (`docs-install`, `docs-first-server`, `docs-concept-server`, `docs-scope`) rendered without error. Captures land in the gitignored `docs/ui/review/site/` and were not committed; no human-verify checkpoint was required by this plan (`10-12` owns the human screenshot-approval checkpoint).

## Self-Check: PASSED

- FOUND: tests/unit/docs/error-codes-accuracy.test.ts
- FOUND: apps/site/content/docs/reference/error-codes.mdx
- FOUND: tests/unit/docs/concepts-accuracy.test.ts
- FOUND: apps/site/content/docs/getting-started/first-server.mdx
- FOUND: apps/site/content/docs/concepts/server.mdx
- FOUND: apps/site/content/docs/concepts/project.mdx
- FOUND: apps/site/content/docs/concepts/environment.mdx
- FOUND: apps/site/content/docs/concepts/service.mdx
- FOUND: apps/site/content/docs/concepts/deployment.mdx
- FOUND: apps/site/content/docs/reference/scope.mdx
- FOUND: apps/site/src/lib/docs-tree.test.ts (modified)
- FOUND commits 5caa998, 93a3a68, e3b2651, 406c714, 0997447 in `git log --oneline`
