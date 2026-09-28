---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 08
subsystem: docs-content
tags: [install-docs, d-07, mdx, single-source-of-truth]

requires:
  - phase: 10-05
    provides: "apps/site/src/lib/source.ts (Fumadocs loader), the five meta.json files already listing getting-started/{install,first-login,first-server}, operate/{upgrade,rollback,backups,troubleshooting} and reference/{variables,exit-codes,error-codes,scope}"
  - phase: 10-06
    provides: "apps/site/src/lib/content-rules.ts (forbidden-wording scan), apps/site/src/components/mdx/ScopeNote.tsx registered in mdx-components.tsx"
  - phase: 10-07
    provides: "apps/site/scripts/check-export.mjs post-build gate, apps/site/src/app/sitemap.ts"
provides:
  - "apps/site/content/docs/getting-started/install.mdx, first-login.mdx: the install command, requirements, what-gets-installed, plain-HTTP warning, firewall advisory and first-login/password-policy text, now the single source (D-07)"
  - "apps/site/content/docs/operate/{upgrade,rollback,backups,troubleshooting}.mdx: upgrade/rollback/backup behavior and the full exit-code table with remediation"
  - "apps/site/content/docs/reference/{variables,exit-codes}.mdx: the supported-variable table and a two-column exit-code reference"
  - "docs/install.md: a 13-line stub pointing at https://noodara.com/docs/getting-started/install, keeping README.md and install.sh's own links alive"
affects: [10-09, 10-10, 10-11, 10-12]

tech-stack:
  added: []
  patterns:
    - "install-docs-accuracy.test.ts's docsPage(rel)/allDocsPages() helpers replace the old single-file installDocs() reader: docsPage reads one MDX file by its content/docs-relative path, allDocsPages() concatenates every .mdx under the tree for assertions that must hold repo-wide (test-only variable names, :latest, planning ids, NOODARA_*= before curl)"
    - "Cross-page prose references ('see \"X\" above') are rewritten as Markdown links to the page X now lives on ([Supported variables](/docs/reference/variables), [Rollback](/docs/operate/rollback), etc.) instead of staying as bare prose, since 'above' is no longer literally true once the source text is split across pages"
    - "Future-tense TLS language ('HTTPS and automatic certificates arrive in a later release') is rewritten as a present-tense fact ('Noodara does not terminate TLS. To add TLS today:') per D-10 -- the site states what Noodara does not do today, never when it will"

key-files:
  created:
    - apps/site/content/docs/getting-started/install.mdx
    - apps/site/content/docs/getting-started/first-login.mdx
    - apps/site/content/docs/operate/upgrade.mdx
    - apps/site/content/docs/operate/rollback.mdx
    - apps/site/content/docs/operate/backups.mdx
    - apps/site/content/docs/operate/troubleshooting.mdx
    - apps/site/content/docs/reference/variables.mdx
    - apps/site/content/docs/reference/exit-codes.mdx
  modified:
    - tests/unit/docs/install-docs-accuracy.test.ts
    - docs/install.md

key-decisions:
  - "The exit-code table lives in full (Exit code | Reason | What to do) only on operate/troubleshooting.mdx; reference/exit-codes.mdx carries a two-column (Exit code | Reason) table plus one sentence linking to Troubleshooting for remediation, per the plan's interfaces map -- both tables are proven against install.sh's noodara_exit_code_for independently, by two separate it() blocks."
  - "rollback.mdx's closing sentence ('the one .env.bak-<timestamp> backup described above') was rewritten to link to Upgrade explicitly ('described in [Upgrade](/docs/operate/upgrade)') rather than kept as 'above', since Upgrade and Rollback are now separate pages and 'above' would be false on the Rollback page."
  - "docs/install.md's stub links to reference/variables and operate/troubleshooting in addition to the two install.sh-referenced anchors (#firewall, #plain-http-warning) required by the must_haves, kept at 13 lines (well under the 25-line ceiling) with no exit-code table."

requirements-completed: [DOCS-01, DOCS-02]

duration: 25min
completed: 2026-09-28
---

# Phase 10 Plan 08: Move install docs into the site, single-source the installer text Summary

**The installation, first-login, upgrade, rollback, backups, troubleshooting and variables/exit-codes text now lives only in `apps/site/content/docs` (D-07), moved sentence-for-sentence from the former `docs/install.md`, still proven accurate against `install.sh`'s own source by a re-pointed accuracy test; `docs/install.md` is now a 13-line stub keeping every existing link alive.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-09-28T00:08:00Z
- **Completed:** 2026-09-28T00:33:00Z
- **Tasks:** 2 completed
- **Files modified:** 10 (8 created, 2 modified)

## Accomplishments

- `tests/unit/docs/install-docs-accuracy.test.ts` re-pointed at `apps/site/content/docs` via `docsPage(rel)`/`allDocsPages()` helpers; every one of the 15 original assertions kept its exact expected value (same URL derivation from `install.sh`'s `NOODARA_REPO_OWNER`/`NAME` defaults, same `noodara_exit_code_for`/`noodara_check_ufw` extraction, same admin-password-length cross-check, same First-login/exit-53 check), plus a new `it()` proving `reference/exit-codes.mdx`'s table against the same exit-code source and a new `docs/install.md` stub describe block. Run for real: RED (12/24 failing, ENOENT on the not-yet-created MDX pages and the still-long stub) before Task 2, GREEN (24/24) after.
- Eight MDX pages now hold the installer text, split per the plan's section-to-page map: `getting-started/install.mdx` (Requirements, Install, Install without piping, What gets installed, Plain HTTP warning, Firewall), `getting-started/first-login.mdx`, `operate/{upgrade,rollback,backups,troubleshooting}.mdx`, `reference/{variables,exit-codes}.mdx`. Every pinned fact (the `curl | sh` command, the ufw advisory verbatim, the `NOODARA_ADMIN_PASSWORD_MIN_LENGTH`-derived "at least 12 characters", the exit-code table, the rollback pipe placement) is unchanged prose -- only structure, links and one future-tense sentence changed.
- Six prior "see 'X' above/below" cross-references that now point across pages were converted to real Markdown links (`[Supported variables](/docs/reference/variables)`, `[First login](/docs/getting-started/first-login)`, `[Rollback](/docs/operate/rollback)`, `[Upgrade](/docs/operate/upgrade)`, `[Install](/docs/getting-started/install)`, `[What gets installed](/docs/getting-started/install#what-gets-installed)`); references that stayed within the same page (e.g. "the topology above" inside `What gets installed`) were left as prose.
- The Plain HTTP warning's "HTTPS and automatic certificates arrive in a later release. Until then, if you want TLS today:" was rewritten to "Noodara does not terminate TLS. To add TLS today:" -- a present-tense fact instead of a future/roadmap claim, per D-10 and the plan's own worked example. `install.mdx`'s "What gets installed" section ends with `<ScopeNote id="domains-tls" />` (D-10 in-context note).
- `docs/install.md` shrank from 353 lines to 13: an H1, one sentence pointing at `https://noodara.com/docs/getting-started/install`, the one-line install command, and short links to `#firewall`, `#plain-http-warning`, Supported variables and Troubleshooting on the site. `README.md` and `install.sh`'s own references to `docs/install.md` (7 occurrences total, unchanged from before this plan) keep resolving.
- Real `pnpm --filter @noodara/site build` produces `● /docs/getting-started/install`, `● /docs/getting-started/first-login` and 6 more static docs routes; `apps/site/out/sitemap.xml` now lists 8 `https://noodara.com/docs/...` URLs including `getting-started/install`, `operate/troubleshooting`, `reference/exit-codes` and `reference/variables` -- the gap `10-07-SUMMARY.md` flagged as expected (`grep -c` returning 0 because no nested docs existed yet) is resolved by this plan's content. `check-export.mjs` passed (`13 files, zero third-party assets`).
- `pnpm --filter @noodara/site typecheck`, `lint`, `pnpm check:ui-safety`, `pnpm boundaries`, and the full repo `pnpm vitest run` (191 files / 3177 tests) all pass after this plan.

## Task Commits

1. **Task 1: Re-point install-docs-accuracy.test.ts at the MDX pages (RED)** -- `c0c8919` (test, 12/24 failing as expected)
2. **Task 2: Move the install text into eight MDX pages, shrink the stub (GREEN)** -- `00f745b` (docs, 24/24 passing)

## Files Created/Modified

- `tests/unit/docs/install-docs-accuracy.test.ts` -- re-pointed at `docsPage`/`allDocsPages`, added the exit-codes-page and stub describe blocks
- `apps/site/content/docs/getting-started/install.mdx` -- Requirements, Install, Install without piping, What gets installed (+ ScopeNote), Plain HTTP warning (rewritten present-tense), Firewall
- `apps/site/content/docs/getting-started/first-login.mdx` -- setup token, admin-password checks, common-password/exit-53 explanation
- `apps/site/content/docs/operate/upgrade.mdx`, `rollback.mdx`, `backups.mdx`, `troubleshooting.mdx` -- upgrade paths, rollback commands, backup guidance, full exit-code table + diagnostic commands
- `apps/site/content/docs/reference/variables.mdx` -- supported-variable table, `.env`-apply guidance
- `apps/site/content/docs/reference/exit-codes.mdx` -- new two-column exit-code reference, links to Troubleshooting
- `docs/install.md` -- collapsed to a 13-line stub

## Decisions Made

See `key-decisions` in frontmatter: the exit-codes-table split (full table on Troubleshooting, two-column on the Reference page), the Rollback page's explicit link to Upgrade instead of a stale "above", and the stub's extra links beyond the two required anchors.

## Deviations from Plan

None -- plan executed exactly as written (TDD RED->GREEN for the accuracy test, every section moved per the interfaces map, the stub kept under the 25-line ceiling, every acceptance-criteria grep passed).

## Self-Check: PASSED

- All 8 created MDX pages and the modified `docs/install.md`/`tests/unit/docs/install-docs-accuracy.test.ts` confirmed present on disk.
- Both task commit hashes (`c0c8919`, `00f745b`) confirmed present in `git log --oneline`.
- `pnpm vitest run tests/unit/docs/install-docs-accuracy.test.ts tests/unit/site/forbidden-words.test.ts apps/site/src/lib/docs-tree.test.ts` -- 33/33 passed.
- `pnpm --filter @noodara/site build` -- succeeded, `check-export: 13 files, zero third-party assets`.
- `apps/site/out/docs/getting-started/install.html` and `apps/site/out/docs/reference/exit-codes.html` both exist.
- `pnpm --filter @noodara/site typecheck`, `lint`, `pnpm check:ui-safety`, `pnpm boundaries` -- all exit 0.
- Full `pnpm vitest run` -- 191 files / 3177 tests passed.
- `pnpm ui:review:site` was not run for this plan: this plan is docs-content-only (no new component beyond the already-reviewed `ScopeNote` from 10-06), so a visual capture pass was not run; a future plan touching the docs page chrome should still exercise it.

---
*Phase: 10-sitio-de-docs-y-landing-p-blica*
*Completed: 2026-09-28*
