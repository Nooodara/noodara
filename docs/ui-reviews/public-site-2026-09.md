# UX Review — Public site (Phase 10, Plan 12)

Fecha: 2026-09-28 · Commit: 09803de · Modo: screenshots + código

Alcance: `apps/site` — landing en `/` (Hero, three pillars, positioning, How it works, "What it
does not do yet", footer) y docs en `/docs` (Install, First login/First server sidebar entries,
Concepts › Server, Reference › Scope of this release), más la página 404. Capturas:
`pnpm ui:review:site`'s full matrix (both themes, 375/900/1280/1920px, plus a reduced-motion
landing capture) in `docs/ui/review/site/` — 50 files, zero third-party requests, zero console
errors (script exits 0).

Veredicto global: **PASS**

| Dimensión | Verdicto | Evidencia |
|---|---|---|
| 1. Tokens | PASS | `check:ui-safety`: zero hex/rgb literals outside `packages/ui/tokens.css` (count=0 both, repo-wide). `apps/site` imports `packages/ui/tokens.css`/`theme.css` directly (`apps/site/src/app/global.css`), never redeclares a color. Single accent confirmed visually (`landing-{light,dark}-1280.png`): "Read the docs", inline links ("Download, read, run", "See full scope"), the docs active sidebar item and the focus ring are the only `--accent`/`--accent-fill` uses; "View on GitHub" is a ghost/secondary button, the "How it works" diagram strokes are `currentColor` (code: `apps/site/src/components/landing/HowItWorksDiagram.tsx`), never accent. |
| 2. Superficie y elevación | PASS | `check:ui-safety`: zero shadows outside Sheet/Dialog/RowMenu/AccountMenu (repo-wide count=0; `apps/site` has none of those overlays). Pillar cards and screenshot frames use hairline borders + `--r-lg`, no `box-shadow`, confirmed visually in every `landing-*.png` capture — matches the UI-SPEC `ScreenshotFrame`/`PillarCard` contract verbatim. |
| 3. Tipografía y jerarquía | PASS | Weights 400/600 only (system font stack, no `font-weight: 500/700` in `apps/site/src`, grep confirmed no literal weight outside the token classes). Mono used for the install command and every docs code block (`docs-install-{light,dark}-1280.png`). Docs prose column stays well under 75ch at 1280/1920px (visually confirmed, Fumadocs' default reading column already clamped per 10-02's token map). |
| 4. Color (temas) | PASS | Both themes captured and visually verified at all four widths for landing and four docs pages plus 404 (`docs/ui/review/site/*-{light,dark}-*.png`). Dark landing/docs show no stray light bands, no flash-prone literal color; `SiteThemeToggle` writes `data-theme` synchronously via the same no-flash bootstrap pattern as `apps/web` (`apps/site/src/lib/theme-script.ts`, reviewed under Security below for its one `dangerouslySetInnerHTML`). Fumadocs `--color-fd-*` mapping verified green by `tests/unit/site/fumadocs-token-map.test.ts` (57/57 passing together with `packages/ui/src/contrast.test.ts` in the same run) — no Fumadocs variable left at its own default palette. |
| 5. Layout y espaciado | PASS | Landing content column capped, 96px desktop section rhythm visible between major sections at 1280px, mobile (375px) stacks pillars/steps vertically with no horizontal overflow (`landing-dark-375.png`). Docs sidebar groups appear in D-08 order: Getting started (Install/First login/Your first server) → Concepts → Operate → Reference (`docs-install-light-1280.png` left rail). |
| 6. Componentes | PASS | `InstallCommand` renders `INSTALL_COMMAND` once with a "Copy install command" accessible button (`apps/site/src/components/landing/InstallCommand.tsx:24`, asserted by `Landing.test.tsx`/`landing-parts.test.tsx`). `HowItWorksDiagram` has an `aria-label` on its SVG (`HowItWorksDiagram.tsx:103`). `SiteThemeToggle` has an `aria-label` (`SiteThemeToggle.tsx:76`). No third-party icon glyphs anywhere in `apps/site` (hand-drawn SVG only, per D-05). |
| 7. Estados / 404 | PASS | 404 page shows the wordmark, "Page not found" heading, and links to `docs`/`homepage` in both themes at every width (`not-found-{light,dark}-*.png`), matching the copy contract verbatim. |
| 8. Progressive disclosure | PASS | Landing leads with the install command and a real product screenshot above the fold; docs detail is one click away from the sidebar; "What it does not do yet" is a short, present-tense fact list with a single "See full scope" link rather than an expanded table on the landing itself. |
| 9. Copy | PASS | `tests/unit/site/forbidden-words.test.ts` and `tests/unit/site/content-rules.test.ts`/`content-rules.ts` enforce zero "coming soon"/"soon"/"roadmap"/date-pattern occurrences under `apps/site/content/**` (part of the 3231/3231 green unit run). Visually every scope-block bullet reads as a present-tense fact ("Noodara does not manage domains, TLS certificates or a reverse proxy."), no promises, no dates. |
| 10. Accesibilidad | PASS | Focus rings use `--accent` (same treatment as the app, confirmed in code — `apps/site` imports the same focus-visible utility classes from `packages/ui`). Keyboard order in the rendered DOM is header (wordmark → Docs → GitHub → theme toggle) → hero (install-command copy button → "Read the docs" → "View on GitHub") → main content (pillars → How it works → scope block) → footer — a natural consequence of DOM source order with no `tabIndex` overrides anywhere in `apps/site/src` (grep confirmed). Docs search: Fumadocs' Orama-backed static search index covers all MDX content including `first-server.mdx`, `server.mdx` and `error-codes.mdx`, all three of which contain "fingerprint" (grep confirmed), so a search for "fingerprint" returns results by construction — verified via source content, not a live query (no dev server running for this review round; the built `/api/search` static handler is present in the build output, `check-export.test.ts` confirms it does not leak into the client-only export improperly). |
| 11. Motion / reduced-motion | PASS | `landing-reduced-motion-{light,dark}-1280.png` show the Viewfinder monogram in its final, at-rest state (the small centered dot/ring inside the "N" mark in "How it works" — compare to the one-shot animated state implied by the same mark elsewhere), never mid-animation and never a blank/loading frame — matches D-18's "never removed silently, an intentional fallback" requirement. |
| 12. Registry safety | PASS (not applicable) | No shadcn/registry used anywhere in this phase (10-UI-SPEC.md §Registry Safety already records this); Fumadocs UI and its dependencies verified by `node scripts/check-package-provenance.mjs` (60/60 locked direct dependencies, includes `fumadocs-*`/`flexsearch`/`@types/mdx`). |

## Bloqueantes

None.

## Correcciones sugeridas

None outstanding — zero FLAG or BLOCK found in this audit round.

## Notes for the human approver (not defects, not fixed)

1. **Hero and pillar screenshots show fixture server names.** The Servers capture
   (`docs/ui/approved/servers-{light,dark}.png`) and the Discover/Understand pillar screenshots
   are the real, user-approved captures from Phase 8's UI review pipeline — they show fixture
   data (`ui-review-connected`, `ui-review-error`, and one deliberately-long `axxxxxxxx…` hostname
   used to test truncation in that pipeline's own review round). This is exactly what D-01/D-02/
   D-17 specify: "la captura real de Servers... **nunca capturas nuevas sin aprobar**" — the
   landing is contractually required to show the approved capture as-is, not a hand-curated demo
   dataset, and no new, unapproved screenshot may be substituted. Flagging for the reviewer's own
   judgment on whether the fixture-flavored names are acceptable on a public marketing page;
   changing this would mean either accepting it or re-approving a new Servers capture with
   cleaner fixture data (an architectural/process change beyond this plan's scope — Rule 4).
2. **Footer shows "v0.1.0" while the in-progress milestone is v0.2.** `apps/site/site-config.mjs`
   reads the version from the latest `v*` git tag, falling back to `apps/site/package.json`'s
   `"version": "0.1.0"` when no tag exists (verified: `git tag --list` is empty on this tree, so
   the fallback is active). This is D-06's build-time-read contract working exactly as specified
   — the string is never hand-typed — but it does mean the published footer will read "v0.1.0"
   until either a `v0.2.0`-shaped tag exists or `apps/site/package.json`'s version is bumped, both
   of which are project-wide release-process decisions outside this plan's `files_modified`.
3. **The hero's Servers screenshot has a lot of empty panel space below the three fixture rows.**
   Per D-17 ("la captura tal cual... nunca capturas nuevas sin aprobar") the approved capture is
   shown unmodified — the empty space is inherent to the source screenshot (a 1280×900 full-page
   capture with only three server rows), not a bug introduced by this phase's layout code.
   Cropping or re-capturing would require a new approval round (Rule 4), so it is left as-is and
   surfaced here for the reviewer's own call.

## Lo que está bien

- Zero new npm dependency drift (`brand:check` clean, `check-package-provenance.mjs` 60/60), zero
  new hex/shadow/gradient literal anywhere in `apps/site` (`check:ui-safety` repo-wide gates all
  green).
- `pnpm ui:review:site` itself fails the build on any third-party request or console error
  (D-16/T-10-05) — this round: 50 captures, zero third-party requests, exit 0.
- The one `dangerouslySetInnerHTML` in `apps/site` (the no-flash theme bootstrap script,
  `apps/site/src/app/layout.tsx:51`) is the same reviewed, constant-string pattern `apps/web`
  already uses — `check:ui-safety`'s "exactly one reviewed dangerouslySetInnerHTML per app root
  layout" gate counts 2 across the whole repo (one per app), confirming neither app has a second,
  unreviewed occurrence.
- 404 page and every docs page carry the same wordmark/lockup, never redrawn — confirmed by
  identical SVG markup reused from `packages/ui/brand/`.

## Security review (noodara-security checklist)

- **Workflows SHA-pinned and least-privilege**: `node scripts/check-workflow-pins.mjs` — clean.
  `.github/workflows/public-site.yml`'s `build` job has `permissions: { contents: read }` only;
  `deploy` has `{ pages: write, id-token: write }` only (top-level `permissions: {}` denies
  everything else by default). Every `uses:` step is pinned to a 40-char commit SHA with a
  human-readable version comment.
- **No `secrets.` in public-site.yml**: grep confirms zero occurrences of `secrets.` in the file
  — it needs none (Pages deploy auth is via the `id-token: write` OIDC permission, not a PAT).
- **check-export leak scan green**: `tests/unit/site/check-export.test.ts` — 20/20 passing;
  `apps/site/scripts/check-export.mjs` (run as part of `pnpm site:build`) reported "21 files,
  zero third-party assets" on this build.
- **No credential in any capture or in `docs/ui/`**: `tests/unit/ui/approval-record.test.ts`'s
  two credential/attribution-scan `describe` blocks (which recursively scan every file under
  `docs/ui/`, including the gitignored `docs/ui/review/` tree when present on disk) pass —
  0/0 offenders for both the fixture admin credential and any Claude/Anthropic/co-authored-by
  string, re-run after generating this round's 50 site captures.
- **External links carry `rel`**: every `<a href={GITHUB_URL}>` in `apps/site` (`SiteFooter.tsx`,
  `Hero.tsx`, `SiteHeader.tsx`) carries `rel="noopener noreferrer"` (grep confirmed, 3/3).
- **One reviewed `dangerouslySetInnerHTML` per app**: confirmed above under "Lo que está bien" —
  `check:ui-safety`'s dedicated gate holds (count=2, one per app, both reviewed).
- **Security-focused runtime canary**: `pnpm security:scan-leaks` — 4/4 Vitest canary files plus
  the `@canary` Playwright spec, all green, exit 0 (this phase adds no new secret-bearing surface;
  `apps/site` is fully static and has no server, no form, no credential of any kind).

No new threat surface introduced beyond the phase's own `<threat_model>` (T-10-03, T-10-05,
T-10-13, T-10-SC) — all four are mitigated by the checks above plus the provenance/audit gates in
the Gate summary.

## Gate summary (tree at commit `09803de`, plus this round's uncommitted report/APPROVAL.md edits)

- `pnpm vitest run tests/unit/site/site-approval-record.test.ts tests/unit/ui/approval-record.test.ts` — 25/25 passed
- `pnpm site:build` — "check-export: 21 files, zero third-party assets"
- `pnpm ui:review:site` — 50 captures, zero third-party requests, exit 0
- `pnpm lint` — clean (turbo, all packages including `@noodara/site`)
- `pnpm typecheck` — clean (all packages including `@noodara/site`, plus `tests/e2e`, integration/installer, `scripts/brand`, `scripts/ui`)
- `pnpm test --coverage` — 197 files / 3231 tests passed
- `pnpm boundaries` — 829 files, 0 issues
- `pnpm check:ui-safety` — all 12 repo-wide static gates hold
- `pnpm brand:check` — no drift
- `node scripts/check-package-provenance.mjs` — 60/60 locked direct dependencies verified
- `pnpm audit --audit-level=high` — 1 vulnerability found, **moderate** severity (below the
  `--audit-level=high` threshold the command itself enforces; command still reports it but its
  exit reflects "no high/critical" — pre-existing, not introduced by this plan, no `apps/site`
  dependency involved per `check-package-provenance.mjs`'s own 60/60 direct-dependency list above)
- `pnpm site:build` (re-run, root filter proof) — same 21-file, zero-third-party result
- `NOODARA_API_ORIGIN=http://localhost:3100 pnpm build` — 5/5 tasks successful, confirms the root
  `build`/`dev` filter from 10-01 (`--filter=!@noodara/site`) leaves `apps/control-plane`/
  `apps/web`/`packages/*` untouched (the env var is CI's own `ci.yml` value, required by
  `apps/web`'s pre-existing build-time check, unrelated to this phase — Rule 3, not a code change)
- `pnpm test:boot` — 7/7 passed
- `pnpm test:e2e` — 174/175 passed, one flaky failure
  (`tests/e2e/servers-list.spec.ts:277`, `@rowmenu` mobile row-menu geometry) reproduced twice in
  the full 175-spec run but green in isolation (1/1) — confirmed pre-existing, unrelated to any
  Phase 10 file (`apps/web`/`RowMenu.tsx`/the spec itself untouched since phase 09-14, commit
  `461245d`), logged to `deferred-items.md`, not fixed here per the scope-boundary rule
- `pnpm security:scan-leaks` — 4/4 Vitest canaries + 1/1 Playwright `@canary` spec, exit 0
