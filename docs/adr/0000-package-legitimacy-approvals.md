# ADR 0000: Package legitimacy approvals for flagged phase-1 dependencies

## Status

Accepted — 2026-09-10

## Context

`01-RESEARCH.md` ran `slopcheck --ecosystem npm` over the whole phase-1 dependency
set. Three entries did not come back clean:

- `vitest` — flagged `[SUS]` ("suspiciously close to 'vite', could be typosquat")
- `commander` — flagged `[SUS]` ("Only 65 downloads. Nobody uses this.")
- `@fastify/type-provider-zod` — approved with caveat under Assumption A1 (a
  6-major-version gap versus the unscoped `fastify-type-provider-zod` package
  that needed independent confirmation before locking)

The research author assessed all three as false positives with independent,
verifiable evidence (npm release history, Context7 docs, existing project
fixation on these exact tools). This ADR turns that one-time human judgment
into a recorded, dated verdict backed by an automated, re-runnable check —
`scripts/check-package-provenance.mjs` — instead of leaving it only in chat
history or research prose.

`fastify-type-provider-zod` (the unscoped alternative Plan 01-03 compares
against) is included here too, so its provenance is on record even though it
was never `[SUS]`-flagged, since Plan 01-03 needs it as a documented baseline.

Source: .planning/phases/01-dominio-persistencia-y-autenticaci-n/01-RESEARCH.md#package-legitimacy-audit

## Decision

For each package below, `scripts/check-package-provenance.mjs` resolved the
registry `repository.url` (via `npm view <pkg> repository.url`, falling back
to the public registry JSON API) and asserted it normalises to the exact
expected GitHub `owner/repo`. All four packages passed on 2026-09-10.

| Package | Expected repository | Observed repository | Resolved version | slopcheck verdict | Automated verdict | Date |
|---|---|---|---|---|---|---|
| vitest | vitest-dev/vitest | `git+https://github.com/vitest-dev/vitest.git` | 5.0.0 | `[SUS]` (typosquat suspicion vs. `vite`) | verified | 2026-09-10 |
| commander | tj/commander.js | `git+https://github.com/tj/commander.js.git` | 15.0.0 | `[SUS]` (stale/rate-limited download-count check) | verified | 2026-09-10 |
| @fastify/type-provider-zod | fastify/fastify-type-provider-zod | `git+https://github.com/fastify/fastify-type-provider-zod.git` | 1.0.0 | `[OK]` / Assumption A1 (approved with caveat) | verified | 2026-09-10 |
| fastify-type-provider-zod | turkerdev/fastify-type-provider-zod | `git+https://github.com/turkerdev/fastify-type-provider-zod.git` | 7.0.0 | `[OK]` | verified | 2026-09-10 |

All four packages are approved for installation in this repository under
their currently pinned versions.

### Phase 4 additions

`04-RESEARCH.md` ran its own package legitimacy audit for the three new
dependencies Phase 4 needs (BullMQ worker + Redis pub/sub SSE bridge +
Testcontainers Redis fixture). All three came back `[OK]` under slopcheck —
no `[SUS]`/`[ASSUMED]` human checkpoint was required for any of them.

| Package | Expected repository | Observed repository | Resolved version | slopcheck verdict | Automated verdict | Date |
|---|---|---|---|---|---|---|
| bullmq | taskforcesh/bullmq | `git+https://github.com/taskforcesh/bullmq.git` | 6.3.6 | `[OK]` | verified | 2026-09-17 |
| ioredis | redis/ioredis | `git+https://github.com/redis/ioredis.git` | 5.11.1 | `[OK]` | verified | 2026-09-17 |
| @testcontainers/redis | testcontainers/testcontainers-node | `git+https://github.com/testcontainers/testcontainers-node.git` | 12.1.0 | `[OK]` | verified | 2026-09-17 |

`ioredis@6.0.0` (the latest release on the registry at audit time) was
considered and rejected for this phase on compatibility grounds, not
legitimacy grounds: it switches its default wire protocol to RESP3 and
BullMQ 6.3.6 declares `ioredis` only as an optional peer (`>=5.0.0`) with no
recorded validation against RESP3-by-default behaviour. `ioredis@5.11.1`,
the last pre-RESP3 release, is pinned instead (04-RESEARCH.md Pitfall 2 /
Open Question 1). `concurrently` was also evaluated (as a way to run the API
and worker entrypoints together in `pnpm dev`) and was not installed — this
phase uses a second Turborepo `dev:worker` task instead, keeping the
zero-new-tooling-dependency posture this project has held since Phase 1.

### Phase 5 additions

`05-RESEARCH.md` ran `slopcheck scan --pkg npm <name> --json` for 14 of the 22 net-new
packages this phase needs (the Next.js/React/Tailwind/Radix/lucide/Playwright stack). All
14 came back `[OK]`. The remaining 8 packages — 3 build/type packages
(`@tailwindcss/postcss`, `@types/react`, `@types/react-dom`) and the 5-package Vitest
component-test DOM stack (`jsdom`, `@testing-library/dom`, `@testing-library/react`,
`@testing-library/jest-dom`, `@testing-library/user-event`) — were not covered by that
research pass and went through `05-03-PLAN.md` Task 1's blocking `checkpoint:human-verify`.
The user (Pablo Gutierrez) explicitly approved all eight on 2026-09-19, with evidence
gathered from npm registry metadata (repository link, weekly downloads) and a `slopcheck`
status check for each — not a manual per-page inspection, and the publisher account was
not checked separately.

The five component-test packages are `devDependencies` of the workspace root only and
never reach a browser bundle. `@vitejs/plugin-react` was considered and declined: Vite's
esbuild transform already honours `jsx: "react-jsx"` from `packages/ui/tsconfig.json`, so no
separate React transform plugin is needed for a Vitest test run.

| Package | Expected repository | Observed repository | Resolved version | slopcheck verdict | Automated verdict | Date |
|---|---|---|---|---|---|---|
| next | vercel/next.js | `git+https://github.com/vercel/next.js.git` | 16.3.5 | `[OK]` | verified | 2026-09-19 |
| react | react/react | `git+https://github.com/react/react.git` | 19.3.0 | `[OK]` | verified | 2026-09-19 |
| react-dom | react/react | `git+https://github.com/react/react.git` | 19.3.0 | `[OK]` | verified | 2026-09-19 |
| tailwindcss | tailwindlabs/tailwindcss | `https://github.com/tailwindlabs/tailwindcss.git` | 4.3.3 | `[OK]` | verified | 2026-09-19 |
| @tailwindcss/postcss | tailwindlabs/tailwindcss | `https://github.com/tailwindlabs/tailwindcss.git` | 4.3.3 | `[OK]`, user-approved at checkpoint | verified | 2026-09-19 |
| @types/react | DefinitelyTyped/DefinitelyTyped | `https://github.com/DefinitelyTyped/DefinitelyTyped.git` | 19.3.0 | `[OK]`, user-approved at checkpoint | verified | 2026-09-19 |
| @types/react-dom | DefinitelyTyped/DefinitelyTyped | `https://github.com/DefinitelyTyped/DefinitelyTyped.git` | 19.3.0 | `[OK]`, user-approved at checkpoint | verified | 2026-09-19 |
| lucide-react | lucide-icons/lucide | `https://github.com/lucide-icons/lucide.git` | 1.47.0 | `[OK]` | verified | 2026-09-19 |
| playwright | microsoft/playwright | `git+https://github.com/microsoft/playwright.git` | 1.63.0 | `[OK]` | verified | 2026-09-19 |
| @playwright/test | microsoft/playwright | `git+https://github.com/microsoft/playwright.git` | 1.63.0 | `[OK]` | verified | 2026-09-19 |
| @radix-ui/react-dialog | radix-ui/primitives | `git+https://github.com/radix-ui/primitives.git` | 1.1.23 | `[OK]` | verified | 2026-09-19 |
| @radix-ui/react-tooltip | radix-ui/primitives | `git+https://github.com/radix-ui/primitives.git` | 1.2.16 | `[OK]` | verified | 2026-09-19 |
| @radix-ui/react-collapsible | radix-ui/primitives | `git+https://github.com/radix-ui/primitives.git` | 1.1.20 | `[OK]` | verified | 2026-09-19 |
| @radix-ui/react-radio-group | radix-ui/primitives | `git+https://github.com/radix-ui/primitives.git` | 1.4.7 | `[OK]` | verified | 2026-09-19 |
| @radix-ui/react-scroll-area | radix-ui/primitives | `git+https://github.com/radix-ui/primitives.git` | 1.2.18 | `[OK]` | verified | 2026-09-19 |
| @radix-ui/react-visually-hidden | radix-ui/primitives | `git+https://github.com/radix-ui/primitives.git` | 1.2.11 | `[OK]` | verified | 2026-09-19 |
| @radix-ui/react-checkbox | radix-ui/primitives | `git+https://github.com/radix-ui/primitives.git` | 1.3.11 | `[OK]` | verified | 2026-09-19 |
| jsdom | jsdom/jsdom | `git+https://github.com/jsdom/jsdom.git` | 30.1.0 | `[OK]`, user-approved at checkpoint | verified | 2026-09-19 |
| @testing-library/dom | testing-library/dom-testing-library | `git+https://github.com/testing-library/dom-testing-library.git` | 10.4.2 | `[OK]`, user-approved at checkpoint | verified | 2026-09-19 |
| @testing-library/react | testing-library/react-testing-library | `git+https://github.com/testing-library/react-testing-library.git` | 16.3.3 | `[OK]`, user-approved at checkpoint | verified | 2026-09-19 |
| @testing-library/jest-dom | testing-library/jest-dom | `git+https://github.com/testing-library/jest-dom.git` | 7.0.1 | `[OK]`, user-approved at checkpoint | verified | 2026-09-19 |
| @testing-library/user-event | testing-library/user-event | `git+https://github.com/testing-library/user-event.git` | 14.6.7 | `[OK]`, user-approved at checkpoint | verified | 2026-09-19 |

`react`/`react-dom` legitimately resolve to `react/react`, not `facebook/react`: GitHub
redirects the renamed `facebook/react` org to `react/react` (confirmed live via
`curl -I https://github.com/facebook/react` -> 301 -> `github.com/react/react`;
05-RESEARCH.md's own audit table records the same finding). `ioredis` resolves to
`6.0.0`'s repository at the time this script last ran in this section — the project's own
pin stays at `5.11.1` per the Phase 4 RESP3 decision above; this script only verifies
repository provenance, not version pins.

### Phase 7 additions

`07-RESEARCH.md`'s Package Legitimacy Audit tagged `sharp` and `png-to-ico` (the
raster pipeline for generating favicon/apple-icon/PWA/OG assets from the brand
geometry module) as `[ASSUMED]`: both names came from training/WebSearch
rather than a Context7 or official-docs lookup that session, even though
`slopcheck scan --pkg npm <name> --json` returned `"status": "OK"` with zero
flags for both. Per the Package Legitimacy Gate protocol, an `[ASSUMED]`
package may not be installed without a human confirming the registry page —
`07-02-PLAN.md` Task 1 staged that checkpoint before any install.

The user (Pablo Gutierrez) replied "approved (Recommended)" — both packages
approved for install at their exact pinned versions — on 2026-09-22, after
the orchestrator's `npm view` evidence below was presented (gathered before
either package was installed).

| Package | Expected repository | Observed repository | Resolved version | slopcheck verdict | Automated verdict | Date |
|---|---|---|---|---|---|---|
| sharp | lovell/sharp | `git+https://github.com/lovell/sharp.git` | 0.35.4 | `[OK]`, `[ASSUMED]` provenance tag, user-approved at checkpoint | verified | 2026-09-22 |
| png-to-ico | steambap/png-to-ico | `git+https://github.com/steambap/png-to-ico.git` | 3.0.2 | `[OK]`, `[ASSUMED]` provenance tag, user-approved at checkpoint | verified | 2026-09-22 |

Neither package's `scripts` object declares a `preinstall`/`install`/
`postinstall` lifecycle hook. `sharp@0.35.4`'s `scripts` object does contain a
`build` key (`node install/build.js`) — a manually-invoked maintainer script
whose target lives in a directory literally named `install/`; this is not a
lifecycle hook (npm only ever auto-runs `preinstall`/`install`/`postinstall`/
`prepare` by name) and must not be treated as one. `png-to-ico@3.0.2`'s
`scripts` object contains only `test` and `lint`.

### Phase 8 additions

`08-RESEARCH.md`'s Package Legitimacy Audit evaluated two new packages for the redesign's
motion/menu work. Only one was installed.

`motion` (D19's locked choice, `research/SUMMARY.md`) is the single JS animation library this
codebase allows, and only for `Sheet.tsx`'s drag-to-dismiss gesture (`08-12-PLAN.md`) — `LazyMotion`
`strict` mode makes any accidental `motion.*` import elsewhere in the tree throw at runtime, and
this ADR entry plus `scripts/check-package-provenance.mjs`'s `EXPECTED_PACKAGES` entry were added
*before* install, per the Package Legitimacy Gate protocol.

| Package | Expected repository | Observed repository | Resolved version | slopcheck verdict | Automated verdict | Date |
|---|---|---|---|---|---|---|
| motion | motiondivision/motion | `git+https://github.com/motiondivision/motion.git` | 13.4.1 | `[OK]` (`slopcheck scan --pkg npm motion --json` -> `status: OK`, no flags), `[VERIFIED: Context7 + npm registry]` | verified | 2026-09-26 |

`npm view motion@13.4.1 scripts --json` declares `dev`, `test`, `build`, `clean`, `prepack` and
`postpublish` — no `preinstall`/`install`/`postinstall` lifecycle hook, confirmed empty before
install. `motion` is a `dependencies` entry of `packages/ui` only — not of the workspace root, not
of `apps/web` — pinned exactly at `13.4.1` (no caret), matching this repo's exact-pin convention.

`@radix-ui/react-dropdown-menu@2.1.24` (`radix-ui/primitives`, the same trusted org as every other
Radix package above) was evaluated in the same research pass as an alternative foundation for the
`RowMenu`/`AccountMenu` migration path. It was **deliberately not installed**: its provenance tag
is `[ASSUMED]` (Assumption A1 in `08-RESEARCH.md` — general reputation, not a Context7-backed
lookup this session), and `08-11-PLAN.md`'s in-place fix to the existing hand-rolled `RowMenu`
(close-on-select, `aria-expanded`, stable item keys) made the migration unnecessary. This decision
is recorded here so a future reader does not re-litigate installing it without first re-running the
`[ASSUMED]`-package human checkpoint the Package Legitimacy Gate protocol requires.

### Phase 10 additions

`10-RESEARCH.md`'s Package Legitimacy Audit evaluated the five packages `apps/site` (the public
docs/landing site, 10-01-PLAN.md) needs: `fumadocs-core`, `fumadocs-ui`, `fumadocs-mdx`,
`flexsearch` and `@types/mdx`. All five ran through `slopcheck install fumadocs-core fumadocs-ui
fumadocs-mdx` (2026-09-27) and scored `[OK]` ("scanned 3 packages, 3 OK"); `flexsearch` and
`@types/mdx` (added by the planner as required peers of `fumadocs-core`/`fumadocs-mdx`/
`fumadocs-ui`) were each independently `slopcheck scan`ned the same day, also `[OK]`. No package
was removed or flagged suspicious.

| Package | Expected repository | Resolved version | slopcheck verdict | Date |
|---|---|---|---|---|
| fumadocs-core | fuma-nama/fumadocs | 16.15.15 | `[OK]` | 2026-09-27 |
| fumadocs-ui | fuma-nama/fumadocs | 16.15.15 | `[OK]` | 2026-09-27 |
| fumadocs-mdx | fuma-nama/fumadocs | 15.4.5 | `[OK]` | 2026-09-27 |
| flexsearch | nextapps-de/flexsearch | 0.8.212 | `[OK]` | 2026-09-27 |
| @types/mdx | DefinitelyTyped/DefinitelyTyped | 2.0.14 | `[OK]` | 2026-09-27 |
| @axe-core/playwright | dequelabs/axe-core-npm | 4.13.0 | `[OK]` | 2026-10-08 |

The docs search backend is `fumadocs-core/search/flexsearch`'s **static** client
(`flexsearchStaticClient`), not Orama -- `10-RESEARCH.md`'s "State of the Art" section corrects
`.planning/research/STACK.md`'s original "Orama" assumption: Orama's current Fumadocs integration
is server/API-route-based and does not work inside `output: 'export'`, while flexsearch's static
client runs entirely client-side against a build-time JSON index. D-08's intent -- static search,
zero third parties -- is unchanged; only the concrete library differs from the earlier research
pass.

## Re-running this check

This check must be re-run whenever one of these pins changes, or before
approving any newly flagged package in a future phase:

```bash
node scripts/check-package-provenance.mjs
```

Exit code 0 means every pinned package's registry `repository.url` still
resolves to its expected GitHub org. A non-zero exit means a mismatch was
found and prints `SUPPLY CHAIN CHECK FAILED - a human must review this
package on npmjs.com before it is installed` for the offending package(s) —
do not proceed to install until that is resolved.

## Consequences

- No `vitest`, `commander` or `@fastify/type-provider-zod` install may land
  in the lockfile without this script having exited 0 first.
- The expected `owner/repo` table lives as literals inside
  `scripts/check-package-provenance.mjs`; changing it is visible in code
  review (see `01-01-PLAN.md` threat register, T-1-02 — accepted risk, no
  further control in v0.1).
- This ADR intentionally precedes the creation of any root `package.json` or
  lockfile in this repository.
