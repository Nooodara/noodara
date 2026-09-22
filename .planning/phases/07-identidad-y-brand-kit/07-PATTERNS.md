# Phase 7: Identidad y brand kit - Pattern Map

**Mapped:** 2026-09-22
**Files analyzed:** 27
**Analogs found:** 22 / 27

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|-----------------|----------------|
| `packages/ui/src/brand/geometry.ts` | utility (pure module) | transform | `packages/ui/src/contrast.ts` | exact |
| `packages/ui/src/brand/geometry.test.ts` | test | transform | `packages/ui/src/contrast.test.ts` | exact |
| `packages/ui/src/brand/Logo.tsx` | component | request-response (render) | `packages/ui/src/ThemeToggle.tsx` + `packages/ui/src/Button.tsx` | role-match |
| `packages/ui/src/brand/Logo.test.tsx` | test | request-response | `packages/ui/src/ThemeToggle.test.tsx` | role-match |
| `packages/ui/src/brand/Wordmark.tsx` | component | request-response (render) | `packages/ui/src/brand/Logo.tsx` (sibling, same phase) | role-match |
| `packages/ui/src/brand/Wordmark.test.tsx` | test | request-response | `packages/ui/src/ThemeToggle.test.tsx` | role-match |
| `packages/ui/src/brand/Lockup.tsx` | component | request-response (render, composition) | `packages/ui/src/brand/Logo.tsx` + `Wordmark.tsx` (sibling) | role-match |
| `packages/ui/src/brand/Lockup.test.tsx` | test | request-response | `packages/ui/src/ThemeToggle.test.tsx` | role-match |
| `packages/ui/src/index.ts` (modify, add brand exports) | barrel/config | — | itself | exact |
| `packages/ui/package.json` (modify, `exports` map) | config | — | itself (`"./tokens.css"`/`"./theme.css"` entries) | exact |
| `scripts/generate-brand-assets.mjs` | utility (build script) | batch / file-I/O | `scripts/capture-discovery-fixtures.mjs` | exact |
| `scripts/capture-brand-review.mjs` | utility (Playwright automation) | batch / file-I/O | `scripts/capture-discovery-fixtures.mjs` (script shape) + `tests/e2e/shell.spec.ts` (Playwright/data-testid conventions) | role-match |
| `tests/unit/brand/brand-assets-accuracy.test.ts` | test | transform (exactness/drift) | `tests/unit/docs/install-docs-accuracy.test.ts` | exact |
| `tests/unit/brand/brand-kit-structure.test.ts` | test | transform (structural) | `tests/unit/docs/install-docs-accuracy.test.ts` (README section-presence checks) | exact |
| `tests/unit/brand/favicon-files-present.test.ts` | test | file-I/O (existence) | `tests/unit/docs/install-docs-accuracy.test.ts` (reads real files off disk) | role-match |
| `tests/unit/brand/package-exports-resolvable.test.ts` | test | file-I/O (resolution) | `tests/unit/scripts/check-package-provenance.test.ts` (imports the real module under test, asserts real resolution) | role-match |
| `apps/web/src/app/manifest.ts` | route / config (Next.js file convention) | request-response | *(none — new Next.js file convention, never used before in this repo)* | none |
| `apps/web/src/app/{icon.svg,apple-icon.png,opengraph-image.png,favicon.ico}` | generated static asset | file-I/O | *(none — binary/SVG output, no code pattern; generation source is `packages/ui/brand/*`)* | none |
| `apps/web/scripts/sync-brand-assets.mjs` | utility (copy script) | file-I/O | `scripts/capture-discovery-fixtures.mjs` (`writeIfChanged`/idempotent-copy discipline) | role-match |
| `apps/web/package.json` (modify, `predev`/`prebuild`) | config | — | itself | exact |
| `apps/web/src/app/layout.tsx` (modify, metadata) | route (root layout) | request-response | itself | exact |
| `apps/web/src/components/Sidebar.tsx` (modify) | component | request-response | itself | exact |
| `apps/web/src/components/AuthCard.tsx` (modify) | component | request-response | itself | exact |
| `apps/web/src/components/Sidebar.test.tsx` (new or extend) | test | request-response | `tests/e2e/shell.spec.ts` (data-testid conventions) — no existing `Sidebar.test.tsx` in repo today | role-match |
| `README.md` (modify) | docs | — | itself + `tests/unit/docs/install-docs-accuracy.test.ts`'s README assertions | exact |
| `docs/brand/BRAND.md` | docs | — | `docs/install.md` (heading structure: `## <Section>` per topic) | role-match |
| `docs/brand/APPROVAL.md` | docs | — | *(none — new record-of-decision doc type)* | none |
| `scripts/check-package-provenance.mjs` (modify, add `sharp`/`png-to-ico` entries) | config data (utility) | — | itself (`EXPECTED_PACKAGES` array) | exact |
| `package.json` (root, modify — no new deps here; `sharp`/`png-to-ico` go in `packages/ui`) | config | — | itself | exact |

## Pattern Assignments

### `packages/ui/src/brand/geometry.ts` (utility, transform)

**Analog:** `packages/ui/src/contrast.ts`

**Header/rationale-comment pattern** (lines 1-15 of the analog):
```typescript
// WCAG 2.x relative luminance and contrast-ratio computation (05-33-PLAN.md Task 1, T-5G-33-01,
// T-5G-33-02). No colour-library dependency (T-5-33-SC) -- the formula is ~80 lines of plain
// TypeScript, matching this repo's zero-new-dependency posture for small pure computations.
// ...
// This module does no file I/O of its own -- `parseTokensCss` takes a CSS string, never a path,
// so it stays trivially testable and so a caller ... decides whether that string came from
// `packages/ui/tokens.css` on disk or a fixture.
```
Apply the same discipline to `geometry.ts`: a module-level comment naming *why* this is pure (importable by both the React runtime and the Node generator script with zero I/O), plain exported constants (`export const GRID = 24`), and pure functions with no file/network access — never take a path, only take values, so both `Logo.tsx` and `scripts/generate-brand-assets.mjs` can call the exact same function.

**Exported-constant + pure-function shape** (lines 17-37, 84-110):
```typescript
export interface RgbColor { readonly r: number; readonly g: number; readonly b: number; }
const HEX6_RE = /^#([0-9a-fA-F]{6})$/;
// ...
const SRGB_LINEAR_THRESHOLD = 0.04045;
function linearizeChannel(channel255: number): number { /* pure math, no I/O */ }
export function relativeLuminance(color: string | RgbColor): number { /* ... */ }
```
`geometry.ts` mirrors this: `export const GRID`, `export const STROKE`, `export const APERTURE_RADIUS` as named constants (never inlined magic numbers), private regexes/helpers unexported, public path-builder functions (`monogramPath()`, `wordmarkPath()`) exported and fully typed, each documented with a one-line comment explaining the geometric intent (matching the analog's per-function doc-comments at lines 39, 94, 104, 112, 130, 139).

**`assertDefined` narrowing helper** (lines 31-37) — reuse verbatim if `geometry.ts`'s path builders do any regex/array destructuring under `noUncheckedIndexedAccess`:
```typescript
function assertDefined<T>(value: T | undefined): T {
  return value as T;
}
```

---

### `packages/ui/src/brand/geometry.test.ts` (test)

**Analog:** `packages/ui/src/contrast.test.ts`

**Reference-value pinning pattern** (lines 27-40):
```typescript
describe('relativeLuminance', () => {
  it('white is 1', () => {
    expect(relativeLuminance('#ffffff')).toBe(1);
  });
  it('black is 0', () => {
    expect(relativeLuminance('#000000')).toBe(0);
  });
});
```
Apply to `geometry.test.ts`: pin known reference values for the path builders (e.g. the generated path's bounding box stays within the 24-unit viewBox, the aperture radius constant matches `APERTURE_RADIUS`, a hand-computed coordinate on a specific arc). Read the real module under test with plain imports, no mocking — same style as `import { auditTheme, ... } from './contrast.js'` (lines 3-14).

**Real-file gate pattern** (lines 20-25, 342-349) — if `geometry.test.ts` needs to cross-check against `packages/ui/tokens.css` (e.g. `STROKE` matching a token-derived value), mirror:
```typescript
const TOKENS_CSS_PATH = new URL('../tokens.css', import.meta.url);
function readRealTokens() {
  return parseTokensCss(readFileSync(TOKENS_CSS_PATH, 'utf8'));
}
```

---

### `packages/ui/src/brand/Logo.tsx`, `Wordmark.tsx`, `Lockup.tsx` (component, request-response render)

**Analog:** `packages/ui/src/ThemeToggle.tsx` (props/testid/doc-comment shape) + `packages/ui/src/Button.tsx` (presentational styling shape)

**Props interface + `data-testid` convention** (ThemeToggle.tsx lines 56-58; Button.tsx lines 8-18):
```typescript
export interface ThemeToggleProps {
  readonly 'data-testid'?: string;
}
```
```typescript
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  readonly variant?: ButtonVariant;
  // Stable Playwright hook (05-UI-SPEC.md SS9), matching the same `'data-testid'?: string`
  // pattern every other packages/ui component already declares (Banner, Notice, CopyButton,
  // SegmentedControl, ...)
  readonly 'data-testid'?: string | undefined;
}
```
Every `packages/ui` component declares `readonly 'data-testid'?: string`. `Logo`/`Wordmark`/`Lockup` must do the same, defaulting to no test id when omitted, and CONTEXT.md's own testid names (`brand-monogram`, `brand-lockup`) should be the *default* `data-testid` value passed at each mount site (Sidebar rail, Sidebar expanded, AuthCard), not hardcoded inside the component itself — matches how `ThemeToggle` never hardcodes `shell-theme-toggle` internally; the caller (`Sidebar.tsx` line 99) supplies it: `<ThemeToggle data-testid="shell-theme-toggle" />`.

**`currentColor`/`aria-hidden` + optional `title` shape** — RESEARCH.md's own Pattern 1 code example (already verified against this repo's conventions) is the concrete target:
```tsx
export interface LogoProps {
  readonly 'aria-hidden'?: boolean;
  readonly title?: string; // only set when the mark stands alone with no adjacent visible text
  readonly 'data-testid'?: string;
}

export function Logo({ 'aria-hidden': ariaHidden, title, 'data-testid': testId }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" role={title ? 'img' : undefined} aria-hidden={ariaHidden} data-testid={testId}>
      {title ? <title>{title}</title> : null}
      <path d={monogramPath()} />
    </svg>
  );
}
```

**Doc-comment convention** (ThemeToggle.tsx lines 60-69) — a block comment above the component naming: the spec section it satisfies, the one other file it is coupled to, and any invariant a reviewer must not break. `Logo.tsx`/`Wordmark.tsx`/`Lockup.tsx` each need the equivalent: which decision ids they satisfy (D-03/D-05/D-08), that `geometry.ts` is the single source of truth (D-10), and that the component must never use `dangerouslySetInnerHTML` (the repo already holds exactly one reviewed occurrence — `layout.tsx`'s theme bootstrap script — see `check-ui-safety.mjs` gate below).

**Icon-sizing constant convention** (Sidebar.tsx line 26):
```typescript
const ICON_PROPS = { 'aria-hidden': true, size: 20, strokeWidth: 1.5 } as const;
```
Mirrors the general repo convention of naming icon-rendering props as an `as const` object at module scope rather than inlining them at each call site — `Lockup.tsx` should similarly name its internal spacing/sizing constants rather than inline magic numbers, consistent with `geometry.ts` owning the *shape* constants and the component owning only *layout* constants (gap between monogram and wordmark, etc.).

---

### `packages/ui/src/brand/Logo.test.tsx` / `Wordmark.test.tsx` / `Lockup.test.tsx` (test)

**Analog:** `packages/ui/src/ThemeToggle.test.tsx`

**Render-and-assert pattern via the shared harness** (lines 1-6, 37-51):
```typescript
import { renderUi, screen, userEvent } from './testing/render.js';
// ...
describe('ThemeToggle', () => {
  it('...', async () => {
    renderUi(<ThemeToggle />);
    const button = screen.getByRole('button');
    // ...
  });
});
```
`Logo`/`Wordmark`/`Lockup` tests should use the same `renderUi`/`screen` harness from `packages/ui/src/testing/render.js` (never `@testing-library/react` imported directly in a non-test file — that import path is gated by `check-ui-safety.mjs`'s "`@noodara/ui/testing` imported only from `*.test.tsx`/`*.test.ts`" rule, see Shared Patterns below). Assert: the rendered `<svg>` has `fill="currentColor"` (never a hardcoded hex), the `data-testid` prop is forwarded, `aria-hidden`/`role`/`title` behave per props (mirrors ThemeToggle's accessible-name test at lines 69-78), and (for `Lockup`) that both the monogram `<path>` and the wordmark `<path>` are present in one render.

**Server/client markup parity test** (lines 135-181) — if any brand component ever reads anything environment-dependent (it should not, being pure `currentColor` SVG with no state), the `renderToString` + `hydrateRoot` + `onRecoverableError` pattern in this file is the template for proving zero hydration mismatch. Likely unnecessary here since Logo/Wordmark/Lockup are fully static/stateless, but worth a one-line assertion that `renderToStaticMarkup(<Logo />)` is deterministic (same string twice) — this is also exactly what `brand-assets-accuracy.test.ts` depends on.

---

### `scripts/generate-brand-assets.mjs` (utility, build script, batch/file-I/O)

**Analog:** `scripts/capture-discovery-fixtures.mjs`

**Header/rationale comment convention** (lines 1-13):
```javascript
#!/usr/bin/env node
// Reproducible capture of real command output from the project-owned sshd fixture images
// (02-04-PLAN.md Task 2, open question 2, assumption A3). Every parser in this phase is tested
// against the files this script writes — nothing under packages/domain/src/discovery/fixtures/
// is hand-typed sample text. Re-run this script (never hand-edit a fixture) whenever a template
// in packages/ssh/src/commands changes.
```
`generate-brand-assets.mjs` needs the equivalent: name which decision (D-10 — "generados desde la misma fuente, nunca dibujados aparte") makes this the *only* legitimate way `packages/ui/brand/*` gets written, and that it must be re-run (never hand-edited) after any geometry or adjustment-round change.

**`writeIfChanged` idempotent-write discipline** (lines 66-79) — copy near-verbatim, this is the exact mechanism RESEARCH.md's own Pattern 1/Anti-Patterns section calls for:
```javascript
const changedFiles = [];

function writeIfChanged(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const previous = existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;
  if (previous !== content) {
    writeFileSync(filePath, content, 'utf8');
    changedFiles.push(path.relative(REPO_ROOT, filePath));
  }
}
```
For binary output (PNG/ICO from `sharp`/`png-to-ico`), use the same shape but compare `Buffer.equals()` instead of string equality before writing.

**Fail-loud dependency-missing guard** (lines 26-35):
```javascript
let ssh;
try {
  ssh = await import('@noodara/ssh');
} catch (err) {
  console.error(
    'Could not import "@noodara/ssh" — packages/ssh/dist is likely missing. Run `pnpm build` first.',
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
```
Apply the same shape if `generate-brand-assets.mjs` imports the built `@noodara/ui` output (or, more likely, imports `packages/ui/src/brand/*.tsx` directly via `tsx` per RESEARCH.md's Standard Stack — either way, fail with a clear one-line remediation message, never a raw stack trace, if the import fails).

**Idempotent summary + `main()` error handling** (lines 151-171):
```javascript
async function main() {
  // ...
  if (changedFiles.length === 0) {
    console.log('capture-discovery-fixtures: no files changed (fully idempotent run).');
  } else {
    console.log(`capture-discovery-fixtures: ${String(changedFiles.length)} file(s) changed:`);
    for (const file of changedFiles) console.log(`  ${file}`);
  }
}

main().catch((err) => {
  console.error('capture-discovery-fixtures: FATAL', err);
  process.exit(1);
});
```

---

### `scripts/capture-brand-review.mjs` (utility, Playwright automation, batch/file-I/O)

**Analog:** `scripts/capture-discovery-fixtures.mjs` (script shape/error handling) + `tests/e2e/shell.spec.ts` (Playwright + data-testid conventions, real-stack login)

**Real-stack login helper** (shell.spec.ts lines 22-28):
```typescript
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}
```
`capture-brand-review.mjs` boots against the same real dev/E2E stack (per RESEARCH.md's Environment Availability table — `tests/e2e/fixtures/stack.ts`) and reuses this exact login flow before navigating to `/servers` (sidebar expanded), resizing the viewport to the rail breakpoint (900-1279px, per Sidebar.tsx's own breakpoints), and visiting `/login`/`/setup` unauthenticated for the `AuthCard` monogram shot.

**Theme-switching for screenshots** (shell.spec.ts line 121, 41 — `shell-theme-toggle` test id and `focusedTheme` helper):
```typescript
await page.getByTestId('shell-theme-toggle').click();
```
Reuse `data-theme` toggling exactly this way (click the real toggle, or set `document.documentElement.dataset.theme` directly via `page.evaluate` for a deterministic screenshot pass) rather than inventing a new theme-switch mechanism — both themes must be captured for every surface per D-14/BRAND-03.

**Viewport-size convention** (shell.spec.ts lines 136, 139, 144):
```typescript
await page.setViewportSize({ width: 1440, height: 900 });
// ...
await page.setViewportSize({ width: 1024, height: 800 });
// ...
await page.setViewportSize({ width: 800, height: 800 });
```
Use these same three reference viewport sizes (expanded sidebar, rail, mobile bottom sheet) so the brand-review screenshots are captured at the exact breakpoints the shell's own E2E suite already exercises — never invent new breakpoint numbers for this script.

**Script summary + error handling** — same `writeIfChanged`/`main().catch()` shape as `generate-brand-assets.mjs` above (screenshots are binary PNGs; compare via `Buffer.equals()` before overwriting, or simply always overwrite since these are review artifacts, not committed source of truth — decide explicitly in the plan).

**Pitfall to encode directly in this script's own header comment:** per RESEARCH.md Common Pitfall #2, this script must NOT attempt to capture the favicon-in-browser-tab surface — that is a `checkpoint:human-verify` step, not a `page.screenshot()` call. Say so explicitly in the script's own top comment so a future editor does not "fix" this by adding a fake tab screenshot.

---

### `tests/unit/brand/brand-assets-accuracy.test.ts` (test, transform/exactness)

**Analog:** `tests/unit/docs/install-docs-accuracy.test.ts`

**"Read the real file, assert against the real source" pattern** (lines 1-14):
```typescript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Plan 06-14: docs/install.md and README.md are operator-facing documentation for a script
// (install.sh) that already exists ... The docs must describe the script that actually ships,
// not the one any single plan described in advance -- so accuracy here is tested against
// install.sh's own source, never asserted by hand.

const installSh = () => readFileSync('install.sh', 'utf8');
const installDocs = () => readFileSync('docs/install.md', 'utf8');
const readme = () => readFileSync('README.md', 'utf8');
```
`brand-assets-accuracy.test.ts` mirrors this exactly: read `packages/ui/brand/monogram-light.svg` etc. off disk, regenerate the same content in-memory via `renderToStaticMarkup(<Logo color="..." />)` (RESEARCH.md's own Code Examples section already has this concrete test written — use it verbatim as the starting shape), and `expect(committed.trim()).toBe(regenerated.trim())`. No path-relative-to-`import.meta.url` needed if the test runs with `cwd` at repo root, same as this analog's plain relative `readFileSync('install.sh', ...)` calls.

**Assertion granularity convention** (lines 17-35, 104-107) — one `it()` per independently-nameable invariant, each with a clear failure message naming the two things being compared, e.g.:
```typescript
it('the literal :latest image tag never appears in docs/install.md or README.md', () => {
  expect(installDocs()).not.toContain(':latest');
  expect(readme()).not.toContain(':latest');
});
```
Apply the same one-assertion-one-named-invariant style for each generated asset (one `it()` per SVG/PNG file, not one giant loop with a single assertion — a failure must name exactly which file drifted).

---

### `tests/unit/brand/brand-kit-structure.test.ts` (test, transform/structural)

**Analog:** `tests/unit/docs/install-docs-accuracy.test.ts` (README section-presence checks, lines 202-227)

**Section-presence assertion pattern**:
```typescript
describe('README.md', () => {
  it('has an Install section that links to docs/install.md', () => {
    const rm = readme();
    expect(rm).toContain('## Install');
    expect(rm).toContain('docs/install.md');
  });

  it('every command in the Development section exists as a script in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const rm = readme();
    const devMatch = rm.match(/## Development\n([\s\S]*?)(\n## |$)/);
    // ...
  });
});
```
`docs/brand/BRAND.md`'s required sections (meaning, construction, clear space, misuse, palette, typography, per RESEARCH.md's Recommended Project Structure) should each get one `it('has a ## <Section> heading')` assertion following this exact `expect(doc).toContain('## <Section>')` / `docMatch = doc.match(/## <Section>\n([\s\S]*?)(\n## |$)/)` idiom. `docs/install.md`'s real heading list (`## Requirements`, `## Install`, `## First login`, ... — confirmed via grep this session) is the concrete precedent for how many top-level `##` sections a brand-kit doc of this shape typically has.

---

### `tests/unit/brand/favicon-files-present.test.ts` (test, file-I/O existence)

**Analog:** `tests/unit/docs/install-docs-accuracy.test.ts` (reads real files, asserts on their content/shape — same technique, applied to binary existence + non-zero size instead of text content)

```typescript
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('apps/web favicon/icon file-convention presence', () => {
  it('favicon.ico exists under apps/web/src/app and is non-empty', () => {
    const stat = statSync('apps/web/src/app/favicon.ico');
    expect(stat.size).toBeGreaterThan(0);
  });
  // one it() per reserved filename: icon.svg, apple-icon.png, opengraph-image.png
});
```

---

### `tests/unit/brand/package-exports-resolvable.test.ts` (test, file-I/O resolution)

**Analog:** `tests/unit/scripts/check-package-provenance.test.ts` (imports the real module/function under test directly, asserts against real resolution rather than a mock) — read this file if deeper detail is needed; not re-read in full this session since `check-package-provenance.mjs` itself (already excerpted below) makes the intended pattern (`export { enumerateLockedDependencies, ... }` guarded by `isMainModule`, lines 431-436, 447) clear: the script's real logic is exported and testable without triggering its network side effects. `package-exports-resolvable.test.ts` should resolve `@noodara/ui/brand/lockup-dark.svg` via Node's real module resolution (`import.meta.resolve` or `require.resolve`, per RESEARCH.md's Validation Architecture table) from a location outside `packages/ui` (e.g. `apps/web`'s own dependency graph), proving the `package.json` `"exports"` map entry actually works end-to-end, not just that the file exists on disk.

---

### `packages/ui/package.json` (config, modify)

**Analog:** itself — existing `"./tokens.css"`/`"./theme.css"` entries

**Exports-map extension pattern** (lines 11-22, already read in full):
```jsonc
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./tokens.css": "./tokens.css",
    "./theme.css": "./theme.css",
    "./testing": { "types": "./dist/testing/render.d.ts", "default": "./dist/testing/render.js" }
  }
}
```
Add `"./brand/*": "./brand/*"` in the same flat-string-value style as `tokens.css`/`theme.css` (never a `{types, default}` object — those static files have no `.d.ts` companion). Add `sharp`/`png-to-ico` to this package's own `devDependencies` (not the root `package.json`), matching how Radix/testing-library packages are scoped to `packages/ui`'s own manifest rather than hoisted to root.

---

### `scripts/check-package-provenance.mjs` (config data, modify)

**Analog:** itself — `EXPECTED_PACKAGES` array (lines 57-193, already read in full)

**Entry-addition pattern** (e.g. lines 162-168, the 05-36 gap-closure additions):
```javascript
{ name: 'ssh2', expectedOwnerRepo: 'mscdex/ssh2' },
{ name: 'argon2', expectedOwnerRepo: 'ranisalt/node-argon2' },
```
Add two entries in this exact `{ name, expectedOwnerRepo }` shape for `sharp` (→ `lovell/sharp`) and `png-to-ico` (→ `steambap/png-to-ico`), each with a one-line comment above naming which phase/plan added them and citing the `npm view <pkg>@<locked-version> repository.url` verification, matching every other addition's comment style in this file. This is a hard gate per RESEARCH.md's Package Legitimacy Audit section — `main()`'s own fail-closed behavior (lines 356-365) means an enumerated-but-unlisted package fails CI, not silently passes.

---

### `apps/web/scripts/sync-brand-assets.mjs` (utility, copy script, file-I/O)

**Analog:** `scripts/capture-discovery-fixtures.mjs` (`writeIfChanged` discipline) — RESEARCH.md's own Code Examples section already has the concrete target shape:
```javascript
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const BRAND_SRC = path.resolve(import.meta.dirname, '../../../packages/ui/brand');
const APP_DIR = path.resolve(import.meta.dirname, '../src/app');

const FILES = {
  'favicon.ico': 'favicon.ico',
  'icon.svg': 'favicon.svg',
  'apple-icon.png': 'apple-touch-icon.png',
  'opengraph-image.png': 'og-image.png',
};

mkdirSync(APP_DIR, { recursive: true });
for (const [dest, src] of Object.entries(FILES)) {
  copyFileSync(path.join(BRAND_SRC, src), path.join(APP_DIR, dest));
}
```
Wire it into `apps/web/package.json`'s `predev`/`prebuild` scripts (RESEARCH.md's Common Pitfall #3 — this must be a repeatable script, never a one-off manual `cp`, and per that same pitfall a Vitest test should byte-compare the synced copies against `packages/ui/brand/*` so drift fails CI even if the script was not re-run locally).

---

### `apps/web/src/app/layout.tsx` (route, modify)

**Analog:** itself (already read in full, lines 1-33)

**`metadata` object convention** (lines 6-8):
```typescript
export const metadata: Metadata = {
  title: 'Noodara',
};
```
Per RESEARCH.md's Pattern 3, do NOT add a hand-written `metadata.icons` object here — the file-convention filenames (`icon.svg`, `apple-icon.png`, `favicon.ico`, `manifest.ts`) under `apps/web/src/app/` are auto-discovered by Next.js. Only `metadata.title`/`metadata.description`/OG-related fields belong in this object; icon wiring stays purely file-convention based, keeping this file's diff minimal.

**Single-reviewed-`dangerouslySetInnerHTML`-occurrence constraint** (lines 16-27) — this file already holds the repo's one legitimate `dangerouslySetInnerHTML` (the theme bootstrap script). No brand component may ever add a second occurrence — see `check-ui-safety.mjs` gate in Shared Patterns.

---

### `apps/web/src/components/Sidebar.tsx` (component, modify)

**Analog:** itself (already read in full, lines 1-106)

**Icon + label mount pattern to extend for the brand monogram/lockup** (lines 10, 22-26, 44-53, 98-101):
```tsx
import { History, Server, Settings } from 'lucide-react';
// ...
const LABEL_CLASSES = 'hidden min-[1280px]:inline';
const ICON_PROPS = { 'aria-hidden': true, size: 20, strokeWidth: 1.5 } as const;
// ...
<nav aria-label="Primary" data-testid="shell-sidebar" className={cn(/* responsive classes */)}>
  <ul className="flex flex-col gap-1">{/* ...nav items... */}</ul>
  <div className="mt-auto flex flex-col gap-1 border-t border-hairline pt-3">
    <ThemeToggle data-testid="shell-theme-toggle" />
    <SignOutButton />
  </div>
</nav>
```
The brand slot (per BRAND-02 / D-04) mounts above the `<ul>` nav list: `Logo` alone at the rail breakpoint (900-1279px, matching `LABEL_CLASSES`'s own `min-[1280px]` breakpoint inverted), `Lockup` at ≥1280px. Import from `@noodara/ui` exactly like `ThemeToggle` is imported (line 14: `import { ThemeToggle } from '@noodara/ui';`), and pass `data-testid="brand-monogram"`/`data-testid="brand-lockup"` at the call site here — never hardcoded inside the brand components themselves (see Logo.tsx pattern above).

---

### `apps/web/src/components/AuthCard.tsx` (component, modify)

**Analog:** itself (already read in full, lines 1-23)

**Centered-card shell to extend with a monogram slot above the title** (lines 13-22):
```tsx
export function AuthCard({ title, children }: AuthCardProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8">
      <div className="flex w-full max-w-[400px] flex-col gap-5 rounded-lg bg-surface-1 p-8">
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        {children}
      </div>
    </main>
  );
}
```
Insert `<Logo aria-hidden data-testid="brand-monogram" />` (or `Lockup`, per D-04's decision on which lockup belongs on `/login`/`/setup`) immediately before the `<h1>`, imported from `@noodara/ui` the same way every other `packages/ui` component is already imported into `apps/web`.

---

### `README.md` (docs, modify)

**Analog:** itself + `tests/unit/docs/install-docs-accuracy.test.ts`'s README assertions (lines 202-227, already excerpted above)

**`<picture>` dark/light SVG pattern** — RESEARCH.md's own Pattern 2 code example is the concrete target, positioned at the top of the file, replacing or accompanying the current `# Noodara` heading (line 1) + lema (line 3):
```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/ui/brand/lockup-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="packages/ui/brand/lockup-light.svg">
  <img alt="Noodara" src="packages/ui/brand/lockup-light.svg" width="220">
</picture>
```
Must not break the existing `install-docs-accuracy.test.ts` assertions: `## Install` section still links `docs/install.md` (line 205), `## Status` line still names `v0.1` (lines 209-212), no `:latest` tag (lines 104-107), no internal planning id pattern (`0[1-6]-\d{2}`, `T-0\d-\d+`, `D-\d{2}` — lines 109-116) anywhere in the added markup or alt text, and every `pnpm <cmd>` mentioned in `## Development` still resolves to a real root `package.json` script (lines 215-226).

---

### `docs/brand/BRAND.md` (docs, new)

**Analog:** `docs/install.md` (heading/section shape — confirmed via grep this session: `## Requirements`, `## Install`, `## Install without piping to a shell`, `## What gets installed`, `## First login`, `## Plain HTTP warning`, `## Firewall`, `## Supported variables`, `## Upgrade`, `## Rollback`, `## Troubleshooting`, `## Backups`)

Follow the same flat `## <Topic>` heading structure (no deep nesting), English per CONTEXT.md's D-Claude's-discretion note ("Idioma del brand kit ... en inglés, como `docs/install.md`"), with the required sections named in RESEARCH.md's Recommended Project Structure: meaning, construction (the grid/stroke/radius sheet), clear space, misuse, palette (tokens referenced by name, never literal hex — same `check-ui-safety.mjs`-adjacent discipline), typography. `brand-kit-structure.test.ts` (above) enforces each heading exists, mirroring how `install-docs-accuracy.test.ts` enforces `docs/install.md`'s own sections.

---

## Shared Patterns

### Zero hex/rgb literals outside `packages/ui/tokens.css`
**Source:** `scripts/check-ui-safety.mjs` lines 82-120 (`TSX_GLOBS`, `HEX_RGB_SCAN_FILES`, the hex/rgb gates)
**Apply to:** every `.ts`/`.tsx`/`.css` file this phase adds or touches under `apps/web/src` and `packages/ui/src` — i.e. `geometry.ts`, `Logo.tsx`, `Wordmark.tsx`, `Lockup.tsx`, `Sidebar.tsx`, `AuthCard.tsx`, `layout.tsx`. The favicon's `#0071e3` tile (D-11) must live ONLY in a generated `.svg`/`.png`/`.ico` file under `packages/ui/brand/` or `apps/web/src/app/`, never inlined as a hex literal in any `.tsx`/`.ts`/`.css` source file — confirmed this gate's glob never scans `.svg`/`.ico`/`.png`, so no gate edit is needed as long as this rule is followed.
```javascript
const HEX_RGB_SCAN_FILES = NON_TEST_SOURCE_FILES.filter((f) => f !== path.join('packages', 'ui', 'tokens.css'));
// ...
runCountGate({
  name: 'zero hex colour literals outside packages/ui/tokens.css',
  files: HEX_RGB_SCAN_FILES,
  pattern: /#[0-9a-fA-F]{3,8}\b/g,
  expected: 0,
  comparator: (total, expected) => total === expected,
}),
```
**Open item to verify at implementation time (per RESEARCH.md Assumption A4):** `apps/web/src/app/manifest.ts` matches this gate's `.ts` glob and legitimately needs literal hex values (`theme_color`, `background_color` — the Web App Manifest spec has no CSS custom-property concept). Run `pnpm check:ui-safety` after adding `manifest.ts` and decide then whether it needs a scoped exclusion (same pattern as `tokens.css`'s own exclusion at line 90) — do not assume either outcome without running the gate.

### Exactly one reviewed `dangerouslySetInnerHTML` occurrence
**Source:** `scripts/check-ui-safety.mjs` lines 92-99; the one existing occurrence is `apps/web/src/app/layout.tsx` lines 16-27 (the theme bootstrap script)
**Apply to:** every brand component (`Logo`, `Wordmark`, `Lockup`) — must render SVG via real JSX (`<svg><path d={...} /></svg>`), never via `dangerouslySetInnerHTML` with a raw SVG string, even though the generator script (`generate-brand-assets.mjs`) itself produces raw SVG strings for static export. The in-app components and the static-export strings are two different code paths from the same `geometry.ts` source — only the generator touches raw strings; the React components never do.

### `data-testid` prop convention, never hardcoded internally
**Source:** every `packages/ui` component (`ThemeToggle.tsx` line 57, `Button.tsx` line 18, and per its own comment "matching the same `'data-testid'?: string` pattern every other packages/ui component already declares")
**Apply to:** `Logo`, `Wordmark`, `Lockup` — declare `readonly 'data-testid'?: string` and forward it to the root `<svg>`; the specific values (`brand-monogram`, `brand-lockup`, per CONTEXT.md's Established Patterns section) are supplied by the call sites in `Sidebar.tsx`/`AuthCard.tsx`, never baked into the component.

### `@noodara/ui/testing` import restricted to test files
**Source:** `scripts/check-ui-safety.mjs` lines 151-157
```javascript
runCountGate({
  name: '@noodara/ui/testing imported only from *.test.tsx/*.test.ts files (ADR-0005, T-5-103)',
  files: NON_TEST_SOURCE_FILES,
  pattern: /@noodara\/ui\/testing/g,
  expected: 0,
  comparator: (total, expected) => total === expected,
}),
```
**Apply to:** `Logo.test.tsx`/`Wordmark.test.tsx`/`Lockup.test.tsx` — import `renderUi`/`screen`/`userEvent` from `./testing/render.js` (relative, within `packages/ui/src`) exactly as `ThemeToggle.test.tsx` does (line 6), never from the public `@noodara/ui/testing` subpath inside a non-test file.

### Idempotent, comment-documented Node scripts with `writeIfChanged` + `main().catch()`
**Source:** `scripts/capture-discovery-fixtures.mjs` (full file, lines 1-171) and `scripts/check-package-provenance.mjs`'s `isMainModule` guard (lines 431-447)
**Apply to:** `scripts/generate-brand-assets.mjs`, `scripts/capture-brand-review.mjs`, `apps/web/scripts/sync-brand-assets.mjs` — every one of these three new scripts should: open with a header comment naming which decision/requirement makes it the single legitimate way to produce its output; use `writeIfChanged`-style idempotent writes so a no-op re-run reports "no files changed" instead of always touching mtimes; wrap `main()` in `.catch((err) => { console.error(...); process.exit(1); })`; and (for scripts whose logic is worth unit-testing, like `sync-brand-assets.mjs`'s file-list mapping) export the pure parts guarded by an `isMainModule` check, matching `check-package-provenance.mjs`'s `export { enumerateLockedDependencies, ... }` + `if (isMainModule) { main()... }` shape.

### Real-stack Playwright conventions (login, data-testid, viewport breakpoints)
**Source:** `tests/e2e/shell.spec.ts` (full file read this session)
**Apply to:** `scripts/capture-brand-review.mjs` and any new/extended E2E spec covering the brand mount points — reuse the exact `login()` helper shape (lines 22-28), the `data-testid` values already established (`shell-sidebar`, `shell-theme-toggle`, `shell-menu-button`, `login-submit`), and the three reference viewport sizes (1440×900 expanded, 1024×800 rail, 800×800 mobile sheet, lines 136-148) rather than introducing new breakpoint numbers.

## No Analog Found

Files with no close match in the codebase (planner should use RESEARCH.md's own Code Examples/Architecture Patterns sections instead):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/web/src/app/manifest.ts` | route/config | request-response | First `manifest.ts` in this repo — no prior Next.js file-convention manifest exists. RESEARCH.md's Pattern 3 already gives a Context7-verified concrete example (`MetadataRoute.Manifest` shape); use that directly. |
| `apps/web/src/app/{icon.svg,apple-icon.png,opengraph-image.png,favicon.ico}` | generated static asset | file-I/O | Binary/SVG output with no prior in-repo icon convention (`apps/web/public/` is empty per RESEARCH.md's Code Context). Generation source is `packages/ui/brand/*`; no code pattern to copy, only the `sync-brand-assets.mjs` script pattern above. |
| `docs/brand/APPROVAL.md` | docs (record-of-decision) | — | No existing "signed approval record" doc type in this repo. Keep it minimal and structured per D-17: date, concept chosen, adjustment rounds used — a short Markdown table or definition list, not prose. |

## Metadata

**Analog search scope:** `packages/ui/src/`, `packages/ui/package.json`, `apps/web/src/components/`, `apps/web/src/app/`, `apps/web/package.json`, `scripts/`, `tests/unit/docs/`, `tests/unit/scripts/`, `tests/e2e/`, `README.md`, `docs/install.md`, root `package.json`
**Files scanned:** ~20 read in full (ThemeToggle.tsx/.test.tsx, contrast.ts/.test.ts, Button.tsx, index.ts, package.json ×3, Sidebar.tsx, AuthCard.tsx, layout.tsx, check-ui-safety.mjs, check-package-provenance.mjs, capture-discovery-fixtures.mjs, install-docs-accuracy.test.ts, shell.spec.ts, README.md, docs/install.md headings) plus directory listings of `packages/ui/src`, `apps/web/src/components`, `apps/web/src/app`, `scripts`, `tests/unit`, `tests/e2e`
**Pattern extraction date:** 2026-09-22
