# Phase 10: Sitio de docs y landing pública - Pattern Map

**Mapped:** 2026-09-27
**Files analyzed:** ~30 (new `apps/site` scaffold + content + tests + CI wiring)
**Analogs found:** 26 / 30

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/site/package.json` | config | build | `apps/web/package.json` | role-match (different `build`/`output`, no `dev` proxy) |
| `apps/site/next.config.ts` | config | build/transform | `apps/web/next.config.ts` | role-match (export vs standalone, no rewrites) |
| `apps/site/tsconfig.json` | config | — | `apps/web/tsconfig.json` | exact (same bundler-moduleResolution override) |
| `apps/site/postcss.config.mjs` | config | — | `apps/web/postcss.config.mjs` | exact |
| `apps/site/app/layout.tsx` | provider/controller | request-response (build-time) | `apps/web/src/app/layout.tsx` | role-match (no `cookies()`, localStorage-only bootstrap) |
| `apps/site/src/lib/theme-script.ts` | utility | transform | `apps/web/src/lib/theme-script.ts` | exact (trim cookie branch) |
| `apps/site/app/page.tsx` (landing) | component | request-response (static) | `apps/web/src/app/page.tsx` | role-match (new content, same App Router shape) |
| `apps/site/app/sitemap.ts` | route | batch/transform | *(none in repo)* | no analog — use RESEARCH Pattern/Next.js `MetadataRoute.Sitemap` convention |
| `apps/site/app/robots.ts` | route | batch/transform | *(none in repo)* | no analog — Next.js file convention |
| `apps/site/app/not-found.tsx` | component | request-response | `apps/web/src/app/page.tsx` (App Router page shape) | partial |
| `apps/site/app/api/search/route.ts` | route | streaming/static-batch | *(none — first API route in a static-export app)* | no analog — Fumadocs `flexsearchFromSource` pattern (RESEARCH Pattern 3) |
| `apps/site/lib/source.ts` | service | transform | *(none — first Fumadocs source loader)* | no analog — Fumadocs `defineDocs`/`loader` macro (RESEARCH Pattern 2) |
| `apps/site/source.config.ts` | config | — | *(none)* | no analog — Fumadocs `defineConfig()` |
| `apps/site/app/docs/[[...slug]]/page.tsx` | route | request-response (SSG) | `apps/web/src/app/layout.tsx` (async layout reading structured data) shape only | partial |
| `apps/site/content/docs/**/*.mdx` | content | transform | `docs/install.md` | role-match (Markdown→MDX prose, same section headings) |
| `apps/site/content/docs/getting-started/install.mdx` | content | transform | `docs/install.md` (verbatim source of truth being moved) | exact |
| `docs/install.md` (rewritten to stub) | content | transform | itself, pre-edit version | exact (shrink to link-out stub) |
| `apps/site/src/components/InstallCommand.tsx` | component | request-response | `packages/ui/src/CopyButton.tsx` | role-match |
| `apps/site/src/components/SiteHeader.tsx` | component | request-response | `packages/ui/src/ThemeToggle.tsx` (`applyPreferences`/`STORAGE_KEY` pattern) | role-match |
| `apps/site/src/components/ScreenshotFrame.tsx` | component | request-response | *(none — first `<picture>` component)* | no analog — plain `<picture>` per D-17 |
| `apps/site/src/components/HowItWorksDiagram.tsx` | component | transform | `packages/ui/src/brand/geometry.ts` + `packages/ui/src/brand/Lockup.tsx` (SVG-from-geometry pattern) | role-match |
| `apps/site/src/components/Hero.tsx` | component | request-response | `packages/ui/src/brand/Lockup.tsx` (brand asset usage) + `apps/web` login hero (Fase 8 D-11, not directly readable this pass) | partial |
| `apps/site/public/CNAME` | config | — | *(none)* | no analog — static file, literal `noodara.com` |
| `tests/unit/docs/install-docs-accuracy.test.ts` (re-pointed) | test | file-I/O | itself, current version | exact (re-point `installDocs()` reader only) |
| `apps/site/content/**` claims/forbidden-words test (e.g. `tests/unit/site/landing-claims.test.ts`) | test | file-I/O | `tests/unit/scripts/check-workflow-pins.test.ts` (scan-real-files-on-disk pattern) | role-match |
| `apps/site/content/**` forbidden-words test | test | file-I/O | `tests/unit/docs/install-docs-accuracy.test.ts` (`not.toContain`/`not.toMatch` assertions) | exact pattern |
| Reference › Error codes MDX + its accuracy test | test + content | file-I/O | `apps/control-plane/src/routes/http-errors.ts` (`SERVICE_ERROR_STATUS`) as vocabulary source; test modeled on `install-docs-accuracy.test.ts` | role-match |
| `turbo.json` (`boundaries.tags` addition for `apps/site`) | config | — | existing `pure-domain`/`ssh-adapter`/`ui-components` tag blocks | exact (add a new tag block, same shape) |
| `apps/site` boundary test | test | file-I/O | `tests/unit/scripts/check-workflow-pins.test.ts` (structural, reads real config) | role-match |
| `.github/workflows/public-site.yml` | config (CI) | event-driven | `.github/workflows/ci.yml` (job shape, pinned actions, `permissions`, `timeout-minutes`) | role-match (new deploy job, Pages-specific) |
| `.github/workflows/ci.yml` (edit: add site build/tests to PR gate) | config (CI) | event-driven | its own `lint`/`typecheck`/`boundaries` jobs (same step shape) | exact |
| `docs/ui/APPROVAL.md` (new "Phase 10 — Public site" block) | content | transform | existing "Phase 9 — Settings editables" block | exact |

## Pattern Assignments

### `apps/site/package.json` / `next.config.ts` / `tsconfig.json` / `postcss.config.mjs`

**Analog:** `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/postcss.config.mjs`

**package.json scripts pattern** (`apps/web/package.json`):
```json
{
  "name": "@noodara/web",
  "type": "module",
  "scripts": {
    "dev": "node scripts/sync-brand-assets.mjs && next dev --port 3000",
    "build": "node scripts/sync-brand-assets.mjs && next build",
    "lint": "eslint --config ../../packages/config/eslint.config.js .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --root ../.. --project apps --project dom"
  }
}
```
For `@noodara/site`: same `lint`/`typecheck`/`test` script shape; `build` has no `NOODARA_API_ORIGIN` dependency and no `start`/`start:worker` (static export has no server, per D-13 "el sitio nunca aparece en docker-compose.yml").

**next.config.ts fail-fast/no-literal-fallback convention** (`apps/web/next.config.ts` lines 1-30):
```typescript
function readApiOrigin(): string {
  const value = process.env.NOODARA_API_ORIGIN;
  if (value === undefined || value.length === 0) {
    throw new Error('NOODARA_API_ORIGIN is required ...');
  }
  return value;
}
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  rewrites() { ... },
};
```
Copy the **shape** (typed `NextConfig`, computed at module scope from `import.meta.dirname`, explicit comments citing the decision IDs), not the content: `apps/site/next.config.ts` uses `output: 'export'` and the CNAME-gated `basePath`/`assetPrefix` from RESEARCH.md Pattern 1 instead of `rewrites()`/`headers()` (a static export has no request pipeline to attach headers to — CSP/X-Frame-Options belong to GitHub Pages' own static file serving, out of scope here).

**tsconfig.json override** (`apps/web/tsconfig.json`, full file) — copy verbatim except `paths`:
```json
{
  "extends": "@noodara/config/tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["es2023", "dom", "dom.iterable"],
    "types": ["node", "react", "react-dom"],
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "next-env.d.ts", "next.config.ts", "postcss.config.mjs"],
  "exclude": ["node_modules", ".next"]
}
```
Same "do not fix toward nodenext" comment applies verbatim to `apps/site`.

---

### `apps/site/app/layout.tsx` + theme bootstrap

**Analog:** `apps/web/src/app/layout.tsx` (full file read) + `apps/web/src/lib/theme-script.ts` (full file read)

**Root layout shape to copy** (`apps/web/src/app/layout.tsx`):
```tsx
export const metadata: Metadata = {
  title: 'Noodara',
  description: 'Your infrastructure, understood.',
  openGraph: { title: 'Noodara', description: '...', siteName: 'Noodara', type: 'website' },
  ...(publicUrl !== undefined && publicUrl.length > 0 ? { metadataBase: new URL(publicUrl) } : {}),
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning {...rootAttributes}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
```
For `apps/site`: **drop `async`/`cookies()` entirely** — static export cannot read request-scoped cookies (RESEARCH Anti-Pattern "Server Components reading `cookies()`/`headers()`"). `metadataBase` is a hard-coded `new URL('https://noodara.com')` per D-12/SEO contract, not env-derived. `rootAttributes` (`data-theme`) is omitted server-side entirely — the bootstrap script is the only thing that ever sets `data-theme`, matching D-15 "el sitio no tiene servidor". The `dangerouslySetInnerHTML` usage must stay a module-level string constant with zero interpolation (same T-5-29 discipline, same `check:ui-safety` gate reviewing exactly one occurrence per app).

**Theme bootstrap script to trim** (`apps/web/src/lib/theme-script.ts`, full 30-line file):
```javascript
export const THEME_BOOTSTRAP_SCRIPT = `(function () {
  try {
    if (document.documentElement.getAttribute('data-theme')) { return; }
    var hasPreferencesCookie = document.cookie.indexOf('noodara-prefs=') !== -1;
    var stored = hasPreferencesCookie ? null : localStorage.getItem('noodara-theme');
    var theme = stored === 'light' || stored === 'dark' ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {}
})();`;
```
For `apps/site`: delete the `hasPreferencesCookie`/cookie-branch entirely (no server ever sets `data-theme` first, so the "already present" early-return degenerates to always reading `localStorage` then falling back to `matchMedia`). Keep the try/catch-never-blocks-render discipline and the `noodara-theme` storage key name (reuse `packages/ui/src/ThemeToggle.tsx`'s exported `STORAGE_KEY` constant rather than re-declaring the literal, mirroring that file's own "exactly one place this key is spelled out" rule).

---

### `apps/site/src/components/SiteHeader.tsx` (theme toggle)

**Analog:** `packages/ui/src/ThemeToggle.tsx` (`applyPreferences`, `STORAGE_KEY`, `resolveSystemTheme` — lines 1-60 read)

```typescript
export const STORAGE_KEY = 'noodara-theme';
function resolveSystemTheme(): 'light' | 'dark' {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch { return 'light'; }
}
```
`apps/site`'s toggle reuses `STORAGE_KEY` and `resolveSystemTheme` (import from `@noodara/ui` if exported, or the same defensive try/catch idiom if not) but **must not** read/write the `noodara-prefs` cookie mirror (`readPreferencesMirror`/`PREFERENCES_COOKIE_NAME`) — D-15 is explicit "localStorage" only, no server exists to read a cookie back.

---

### `apps/site/lib/source.ts`, `source.config.ts`, `app/docs/[[...slug]]/page.tsx`, `app/api/search/route.ts`

**No repo analog** — first Fumadocs integration in this codebase. Use RESEARCH.md's verified snippets verbatim as the starting shape (Context7-sourced, HIGH confidence):

```typescript
// lib/source.ts
import { defineDocs } from 'fumadocs-mdx/macro';
import { loader } from 'fumadocs-core/source';
export const docs = defineDocs({ dir: 'content/docs' });
export const source = loader({ baseUrl: '/docs', source: docs.toFumadocsSource() });
```
```typescript
// app/docs/[[...slug]]/page.tsx
import { source } from '@/lib/source';
export function generateStaticParams() { return source.generateParams(); }
```
```typescript
// app/api/search/route.ts
import { source } from '@/lib/source';
import { flexsearchFromSource } from 'fumadocs-core/search/flexsearch';
export const revalidate = false;
export const { staticGET: GET } = flexsearchFromSource(source);
```
Follow this repo's own commenting convention (cite the decision ID / research section a choice traces back to, as every other config file in this repo does) rather than leaving these bare.

---

### `apps/site/next.config.ts` basePath/CNAME computation

**No repo analog for the CNAME-gating logic itself** — this repo's closest precedent is `apps/web/next.config.ts`'s `readApiOrigin()` fail-fast-from-env pattern (same "compute once at config time, never per-request, explicit not implicit" discipline). Use RESEARCH.md Pattern 1 verbatim:
```typescript
const hasCname = existsSync(path.join(import.meta.dirname, 'public', 'CNAME'));
const basePath = hasCname ? '' : '/noodara';
const nextConfig: NextConfig = {
  output: 'export',
  basePath,
  assetPrefix: basePath,
  images: { unoptimized: true },
  trailingSlash: false,
};
```

---

### `docs/install.md` → stub

**Analog:** itself, current content (Requirements/Install/What gets installed/.../Backups sections) — the *entire current file* is the "before" state.

**Pattern:** Collapse to a short stub per D-07: one or two sentences plus a link to `https://noodara.com/docs/getting-started/install`. Must **not** delete the file (Pitfall 1 in RESEARCH.md) — `README.md` and `install.sh` link to it. The content that moves becomes `apps/site/content/docs/getting-started/install.mdx`, byte-derived from the current `docs/install.md` prose (same section order: Requirements, Install, What gets installed, First login, Plain HTTP warning, Firewall, Supported variables, Upgrade, Rollback, Troubleshooting, Backups).

---

### `tests/unit/docs/install-docs-accuracy.test.ts` (re-pointed)

**Analog:** itself, current version (full file read — 9 top-level `it()` blocks under `describe('docs/install.md accuracy against install.sh')`, plus separate `README.md` and ADR describes).

**Exact one-line change per RESEARCH.md's own Code Examples section:**
```typescript
const installSh = () => readFileSync('install.sh', 'utf8');
// BEFORE: const installDocs = () => readFileSync('docs/install.md', 'utf8');
const installDocs = () => readFileSync('apps/site/content/docs/getting-started/install.mdx', 'utf8');
```
Every existing assertion (exit-code table regex against `## Troubleshooting\n...`, `noodara_check_ufw` wording, `NOODARA_` variable cross-check, `NOODARA_VERSION=` pipe-placement rules, admin-password-length cross-check, "First login" exit-53 section check) is regex-over-Markdown and MDX is a strict superset for all of them — **do not rewrite these regexes**, only the file path they read, per RESEARCH.md's own note ("verify at implementation time that Fumadocs frontmatter doesn't shift any line-relative regex" — none of the existing regexes are line-relative, all use `\n## ` section splitting, so frontmatter at the very top is safe as long as it appears before the first `## ` heading).

Add a **new** `describe` block for the error-codes vocabulary, modeled on the existing exit-code describe block:
```typescript
// modeled on: it('every exit code in noodara_exit_code_for appears in the troubleshooting
// table...') above — same "read the real source, diff against the docs table" shape.
import { SERVICE_ERROR_STATUS } from '../../../apps/control-plane/src/routes/http-errors';
// assert every key+status in SERVICE_ERROR_STATUS appears in the error-codes MDX table,
// and no extra code appears in the docs.
```

---

### New "doc can't lie" tests: forbidden words / claims / boundary

**Analog:** `tests/unit/scripts/check-workflow-pins.test.ts` (full file, first 80 lines read) — the "structural proof against the REAL files on disk, no network, no execution" pattern this repo already uses for CI pin enforcement:
```typescript
describe('release pipeline workflow files (structural, no GitHub Actions run required)', () => {
  const releaseYml = () => readFileSync('.github/workflows/release.yml', 'utf8');
  it('release.yml: every uses: is pinned to a 40-hex SHA ...', () => {
    expect(scanWorkflowPins(releaseYml())).toEqual([]);
  });
});
```
Apply the same shape for `apps/site`'s three new tests:
1. **Forbidden-words test** — glob `apps/site/content/**/*.mdx`, assert none matches `/\b(coming soon|soon|roadmap)\b/i` or a date-like pattern (`\b(19|20)\d{2}\b`), same `expect(...).not.toMatch(...)` idiom already used throughout `install-docs-accuracy.test.ts` (e.g. its `:latest` tag check, its internal-planning-id check).
2. **Claims-vs-out-of-scope test** — read `.planning/PROJECT.md`'s "Out of Scope" section and the "Scope of this release" MDX's "Not included" table; assert no landing claim (frontmatter `claims` list, per CONTEXT.md's Claude's Discretion) contradicts either list. Same file-reading, no-network discipline.
3. **Boundary test** — read `turbo.json`, assert an `apps/site` tag exists whose `dependencies.deny` (or narrower `allow` list) excludes `apps/control-plane` and `@noodara/domain` while permitting `@noodara/ui`. Modeled structurally on the existing `pure-domain`/`ssh-adapter`/`ui-components` blocks below.

---

### `turbo.json` — add `apps/site` boundary tag

**Analog:** existing `boundaries.tags` block (full block read, `turbo.json` lines 79-96):
```json
"boundaries": {
  "tags": {
    "pure-domain": { "dependencies": { "allow": ["pure-domain", "@noodara/config", "ssh-adapter", "ui-components"] } },
    "ssh-adapter": { "dependencies": { "allow": ["pure-domain", "@noodara/config"] } },
    "ui-components": { "dependencies": { "allow": ["ui-components", "@noodara/config", "pure-domain", "ssh-adapter"] } }
  }
}
```
Add a new tag (e.g. `"public-site"`) with an `allow` list of `["public-site", "@noodara/config", "ui-components"]` — explicitly omitting any control-plane/domain tag, which is what makes the import illegal by omission (this repo's `boundaries` config is allow-list style, not deny-list — confirm this at implementation time against Turborepo's actual boundaries semantics, since the existing three blocks are all `allow`, not `deny`). `apps/site/package.json` needs a matching `"turbo": { "tags": ["public-site"] }` block, mirroring `packages/ui/package.json`'s own `"turbo": { "tags": ["ui-components"] }`.

---

### `.github/workflows/public-site.yml`

**Analog:** `.github/workflows/ci.yml` (full file read) — copy its conventions exactly: pinned-SHA `uses:` with trailing version comment, explicit least-privilege `permissions:` per job, `timeout-minutes:` sized with a comment justifying the number, `concurrency` group, `NODE_VERSION: '22'` env var, `pnpm/action-setup` → `actions/setup-node` → `pnpm install --frozen-lockfile` step order:
```yaml
permissions:
  contents: read
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
env:
  NODE_VERSION: '22'
jobs:
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
        with: { node-version: ${{ env.NODE_VERSION }}, cache: pnpm }
      - run: pnpm install --frozen-lockfile
```
Use RESEARCH.md's Pattern 5 for the Pages-specific `build`/`deploy` job pair (its SHAs for `actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages` — verify these against `tests/unit/scripts/check-workflow-pins.test.ts`'s `scanWorkflowPins` gate, which will fail the PR if any `uses:` isn't a 40-hex SHA). `public-site.yml` triggers on `push: branches: [main]` only (no `pull_request:` — D-13 says the sitio publishes on push and is *gated* on PR via `ci.yml`, not via its own PR trigger).

---

### `.github/workflows/ci.yml` edit — add site gate to PR

**Analog:** the existing `boundaries` job in the same file (exact step shape to copy for a new `site` job or an addition to an existing job):
```yaml
boundaries:
  name: boundaries
  runs-on: ubuntu-latest
  timeout-minutes: 10
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
    - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
    - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
      with: { node-version: ${{ env.NODE_VERSION }}, cache: pnpm }
    - run: pnpm install --frozen-lockfile
    - run: pnpm boundaries
```
D-13 requires this new job/step to run: `pnpm --filter @noodara/site build` (with `apps/site/public/CNAME` present, per RESEARCH.md Pitfall 4 — the PR build must exercise the *production* root-basePath shape, not the subpath preview shape), the re-pointed accuracy test, the claims test, and the boundary test — either as one new `site` job (preferred, matches the one-job-per-concern shape every other job in `ci.yml` already follows) or folded into `unit`. Follow the existing per-job comment convention explaining *why* the timeout number was chosen.

---

### `docs/ui/APPROVAL.md` new gate block

**Analog:** the existing "## Phase 9 — Settings editables" block (full block read, tail of file):
```markdown
## Phase 9 — Settings editables

| Field | Value |
| --- | --- |
| Gate | Phase 9 — Settings editables |
| Date | 2026-09-27 |
| Rounds used | 1 |
| Approver | Pablo Gutierrez |
| Evidence | `docs/ui/review/` — ... |

### Adjustment log
- **Round 1: ...**
- **Round 2: none.**
```
Copy this table + "Adjustment log" shape verbatim for "## Phase 10 — Public site", citing `pnpm ui:review` output at 375/900/1280/1920 across both themes for landing + at least one docs page, per CONTEXT.md's Claude's Discretion note and UI-SPEC's Layout Contract breakpoints row.

---

## Shared Patterns

### Pinned, least-privilege GitHub Actions
**Source:** `.github/workflows/ci.yml` (every job)
**Apply to:** `public-site.yml`, the `ci.yml` edit
```yaml
- uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
permissions:
  contents: read
timeout-minutes: 10
```
Every new workflow file/job must pass `tests/unit/scripts/check-workflow-pins.test.ts`'s `scanWorkflowPins` (40-hex SHA or an explicit `TODO(...)` marker — never a bare tag).

### "Doc that can't lie" test discipline
**Source:** `tests/unit/docs/install-docs-accuracy.test.ts` (whole file)
**Apply to:** the re-pointed accuracy test, the new error-codes accuracy test, the forbidden-words test, the claims test
Pattern: read the real source file(s) from disk with `readFileSync`, extract ground truth with a regex/JSON parse, extract the documented claim the same way, `expect(...).toEqual(...)`/`not.toContain(...)` the two against each other — zero hand-typed expected values, zero network call, zero shell execution.

### No-flash theme bootstrap, localStorage-only
**Source:** `apps/web/src/lib/theme-script.ts`, `packages/ui/src/ThemeToggle.tsx`
**Apply to:** `apps/site/src/lib/theme-script.ts`, `apps/site/src/components/SiteHeader.tsx`
Try/catch around every `localStorage`/`matchMedia` call (privacy-mode safety), single `STORAGE_KEY` constant reused, `data-theme` attribute (never a `class`) — see RESEARCH.md Pitfall 5 for the Fumadocs-UI adapter concern this creates.

### Tokens imported, never copied
**Source:** `packages/ui/tokens.css`, `packages/ui/theme.css` (exported via `packages/ui/package.json`'s `"./tokens.css"`/`"./theme.css"` export map)
**Apply to:** `apps/site/app/global.css`
```css
@import '@noodara/ui/tokens.css';
@import '@noodara/ui/theme.css';
```
No new hex literals or `--color-fd-*` left unmapped anywhere in `apps/site` (`check:ui-safety`'s "zero literal colours outside tokens.css" spirit — RESEARCH.md's Open Question #1 flags whether the gate itself needs extending to `apps/site`; the plan should decide and, if yes, add `apps/site` to `scripts/check-ui-safety.mjs`'s scanned paths).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `apps/site/app/sitemap.ts` / `app/robots.ts` | route | batch | No prior Next.js file-convention route in this repo (`apps/web` has no sitemap/robots) — use Next.js's own `MetadataRoute.Sitemap`/`MetadataRoute.Robots` file convention directly, no local precedent to copy structure from. |
| `apps/site/app/api/search/route.ts` | route | static-batch | First API route inside a static-export app in this repo; `apps/control-plane`'s Fastify routes are a fundamentally different (server-resident) pattern — use RESEARCH.md's `flexsearchFromSource`/`staticGET` snippet as the sole source. |
| `apps/site/lib/source.ts`, `source.config.ts` | service/config | transform | First Fumadocs integration; no MDX loader exists anywhere in this repo today. |
| `apps/site/public/CNAME` | config | — | Static, one-line literal file; no analog needed. |
| `apps/site/src/components/ScreenshotFrame.tsx` | component | request-response | First plain `<picture>` component in this repo (`apps/web` never ships static PNG screenshots in-app) — build from the D-17 spec directly. |

## Metadata

**Analog search scope:** `apps/web/**`, `packages/ui/**`, `tests/unit/docs/**`, `tests/unit/scripts/**`, `.github/workflows/**`, `turbo.json`, `docs/ui/APPROVAL.md`, `apps/control-plane/src/routes/http-errors.ts`
**Files scanned:** ~35 (targeted, non-overlapping reads)
**Pattern extraction date:** 2026-09-27
