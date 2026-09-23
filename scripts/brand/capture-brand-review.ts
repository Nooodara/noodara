// Captures each brand concept mounted in the REAL Noodara app (07-04-PLAN.md Task 2, D-14 /
// BRAND-03).
//
// WHY THIS EXISTS. D-14 is explicit that a brand board alone is not enough: the user approves a
// concept by seeing it in context -- the 64px rail, the expanded sidebar, /login and /setup -- in
// both themes. This script produces exactly those screenshots, for all three concepts, from one
// command, so an adjustment round is a re-run rather than a manual tour of the app.
//
// THIS IS A REVIEW TOOL, NOT A MOUNTING MECHANISM. The mark is put on screen by inserting
// `renderStaticSvg` markup into the live DOM at capture time. Nothing in apps/web or packages/ui
// knows this script exists, and nothing here may ever become the way the brand ships: mounting the
// real components in Sidebar.tsx and AuthCard.tsx is plan 07-07's job, with its own component
// tests. Injection was chosen over a `?brand=` query flag or an env switch precisely because those
// would require production code to read them -- a trace left behind for a review. The injected
// markup is the exact output of the components 07-07 will mount, it inherits the real theme tokens
// through `color: var(--ink)`, and it is gone the moment the page reloads.
//
// IT DOES NOT, AND CANNOT, CAPTURE THE BROWSER TAB. D-14 also lists "the favicon in the browser
// tab", and Playwright's screenshot API only ever sees page content, never the browser's own
// chrome (07-RESEARCH.md Common Pitfall 2). That surface stays a manual check by the human at
// approval time; the brand board's simulated tab strip says so in words. Do not "fix" this by
// adding a fake tab screenshot here.
//
// The npm script runs this under `--tsconfig packages/ui/tsconfig.json` for the same reason
// `render-boards.ts` does (see that file's header): the injected markup is rendered from the real
// `.tsx` components, which need their own package's `jsx: react-jsx` transform.
//
// CREDENTIALS ARE NEVER LOGGED, NEVER TYPED ON A CAPTURED SCREEN (T-07-09, T-07-10). /login and
// /setup are captured first, on a brand-new browser context, with every field still empty; sign-in
// happens afterwards and its values come straight from the stack fixture (or the operator's own
// environment) into Playwright's `fill`, never into a string this script builds, prints or writes.

import { chromium, type Browser, type Page } from '@playwright/test';
import { CONCEPT_IDS, type ConceptId } from '../../packages/ui/src/brand/geometry.js';
import { renderStaticSvg } from '../../packages/ui/src/brand/static-svg.js';
import { THEMES, reviewPngPath, type Theme } from './review-paths.js';
import { changedFiles, writeIfChanged } from './write-if-changed.js';

/** The three reference viewports tests/e2e/shell.spec.ts already uses for the shell's own
 *  breakpoints -- never a new number invented for this script. 1440x900 shows the sidebar with its
 *  labels; 1024x800 collapses it to the 64px icon rail. */
const EXPANDED_VIEWPORT = { width: 1440, height: 900 } as const;
const RAIL_VIEWPORT = { width: 1024, height: 800 } as const;
const DEVICE_SCALE_FACTOR = 2;

/** AuthCard.tsx renders `<main><div><h1>{title}</h1>…</div></main>`; the mark goes above the
 *  heading, which is where 07-07 will mount it for real. */
const AUTH_ANCHOR = 'main > div > h1';
/** Sidebar.tsx's `<nav data-testid="shell-sidebar">` opens with the nav `<ul>`; the mark goes
 *  above it. */
const SIDEBAR_SELECTOR = '[data-testid="shell-sidebar"]';
const SIDEBAR_ANCHOR = `${SIDEBAR_SELECTOR} > ul`;

/** Breathing room around the cropped sidebar shot, in CSS px. */
const CROP_PADDING = 24;

interface Target {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
}

interface Session {
  readonly target: Target;
  readonly stop: () => Promise<void>;
}

/**
 * Attach mode (`BRAND_REVIEW_BASE_URL` pointing at an already-running `pnpm dev`) or, by default,
 * the real E2E stack from tests/e2e/fixtures/stack.ts -- Postgres, Redis, the API, the worker and
 * the built web app, with its own preseeded fixture admin.
 *
 * Every variable is read and checked explicitly; none has a literal fallback. A default base URL
 * would silently point a capture run at whatever happens to be listening on that port, and a
 * default credential would be a hardcoded secret.
 */
async function openSession(): Promise<Session> {
  const baseUrl = process.env.BRAND_REVIEW_BASE_URL;
  if (baseUrl !== undefined) {
    const email = process.env.BRAND_REVIEW_EMAIL;
    const password = process.env.BRAND_REVIEW_PASSWORD;
    if (email === undefined || password === undefined) {
      throw new Error(
        'capture-brand-review: BRAND_REVIEW_BASE_URL is set, so BRAND_REVIEW_EMAIL and BRAND_REVIEW_PASSWORD must be set too — attach mode has no fixture account of its own',
      );
    }
    console.log(`capture-brand-review: attaching to ${baseUrl}`);
    return { target: { baseUrl, email, password }, stop: () => Promise.resolve() };
  }

  // Imported lazily so attach mode never pulls Testcontainers (and therefore Docker) into the
  // process at all.
  const { startStack, stopStack } = await import('../../tests/e2e/fixtures/stack.js');
  console.log('capture-brand-review: booting the E2E stack (Docker required) — this takes a minute');
  const stack = await startStack();
  return {
    target: { baseUrl: stack.baseUrl, email: stack.adminEmail, password: stack.adminPassword },
    stop: () => stopStack(stack),
  };
}

function parseConcepts(argv: readonly string[]): readonly ConceptId[] {
  const index = argv.indexOf('--concept');
  if (index === -1) return CONCEPT_IDS;
  const value = argv[index + 1];
  if (value === undefined || !CONCEPT_IDS.includes(value as ConceptId)) {
    throw new Error(`capture-brand-review: --concept expects one of ${CONCEPT_IDS.join(', ')}`);
  }
  return [value as ConceptId];
}

function sidebarWrapper(svg: string): string {
  return `<div data-brand-review style="display:flex;align-items:center;height:44px;padding:0 12px;color:var(--ink)">${svg}</div>`;
}

function authWrapper(svg: string): string {
  return `<div data-brand-review style="display:flex;justify-content:flex-start;color:var(--ink)">${svg}</div>`;
}

/**
 * Inserts review-only markup next to an existing element. Throws when the anchor is missing rather
 * than capturing a screenshot with no mark on it — a silently mark-less capture is the one failure
 * mode that would waste the user's review round.
 */
async function inject(page: Page, selector: string, position: InsertPosition, html: string): Promise<void> {
  const inserted = await page.evaluate(
    (args: { selector: string; position: InsertPosition; html: string }) => {
      const anchor = document.querySelector(args.selector);
      if (anchor === null) return false;
      anchor.insertAdjacentHTML(args.position, args.html);
      return true;
    },
    { selector, position, html },
  );
  if (!inserted) {
    throw new Error(`capture-brand-review: nothing matched "${selector}" — the app's markup moved, so this capture would show no mark`);
  }
}

/** Deterministic: the attribute is set directly rather than by clicking the real toggle, so a
 *  capture never depends on which theme the previous one left behind in localStorage. */
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((value: Theme) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
}

async function shootPage(page: Page, file: string): Promise<void> {
  writeIfChanged(file, await page.screenshot({ fullPage: true, type: 'png' }));
}

async function shootElement(page: Page, selector: string, file: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`capture-brand-review: "${selector}" has no box to crop — it is not visible at this viewport`);
  }
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error('capture-brand-review: the page has no viewport to clamp the crop against');
  }
  const x = Math.max(0, box.x - CROP_PADDING);
  const y = Math.max(0, box.y - CROP_PADDING);
  const clip = {
    x,
    y,
    width: Math.min(box.width + 2 * CROP_PADDING, viewport.width - x),
    height: Math.min(box.height + 2 * CROP_PADDING, viewport.height - y),
  };
  writeIfChanged(file, await page.screenshot({ type: 'png', clip }));
}

async function signIn(page: Page, target: Target): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(target.email);
  await page.getByLabel('Password').fill(target.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/servers$/, { timeout: 60_000 });
}

/**
 * One concept, both themes, all four surfaces, on its own browser context — a fresh context is
 * what guarantees /login and /setup are genuinely unauthenticated for every concept, not just the
 * first one.
 */
async function captureConcept(browser: Browser, target: Target, concept: ConceptId, mounted: boolean): Promise<void> {
  const lockup = renderStaticSvg({ kind: 'lockup', concept, color: 'currentColor' });
  const monogram = renderStaticSvg({ kind: 'monogram', concept, color: 'currentColor' });

  const context = await browser.newContext({
    baseURL: target.baseUrl,
    viewport: { ...EXPANDED_VIEWPORT },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  try {
    const page = await context.newPage();

    // Unauthenticated first, with every field untouched (T-07-09).
    for (const surface of ['login', 'setup'] as const) {
      for (const theme of THEMES) {
        await page.goto(`/${surface}`, { waitUntil: 'load' });
        await setTheme(page, theme);
        if (!mounted) await inject(page, AUTH_ANCHOR, 'beforebegin', authWrapper(lockup));
        await shootPage(page, reviewPngPath(concept, surface, theme));
      }
    }

    await signIn(page, target);

    for (const theme of THEMES) {
      await page.setViewportSize({ ...EXPANDED_VIEWPORT });
      await page.goto('/servers', { waitUntil: 'load' });
      await setTheme(page, theme);
      if (!mounted) await inject(page, SIDEBAR_ANCHOR, 'beforebegin', sidebarWrapper(lockup));
      await shootPage(page, reviewPngPath(concept, 'sidebar-expanded', theme));
      await shootElement(page, SIDEBAR_SELECTOR, reviewPngPath(concept, 'sidebar-expanded', theme, 'crop'));

      // Reload rather than re-inject on top: the rail is the same nav at a narrower viewport, and
      // a reload is what guarantees the previous surface's injected node is gone.
      await page.setViewportSize({ ...RAIL_VIEWPORT });
      await page.reload({ waitUntil: 'load' });
      await setTheme(page, theme);
      if (!mounted) await inject(page, SIDEBAR_ANCHOR, 'beforebegin', sidebarWrapper(monogram));
      await shootPage(page, reviewPngPath(concept, 'sidebar-rail', theme));
      await shootElement(page, SIDEBAR_SELECTOR, reviewPngPath(concept, 'sidebar-rail', theme, 'crop'));
    }
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const concepts = parseConcepts(argv);
  // `--mounted` skips the injection entirely: once 07-07 mounts the real components, the same
  // command produces the same file set from the app's own markup.
  const mounted = argv.includes('--mounted');

  const session = await openSession();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    for (const concept of concepts) {
      await captureConcept(browser, session.target, concept, mounted);
    }
  } finally {
    await browser?.close();
    await session.stop();
  }

  if (changedFiles.length === 0) {
    console.log('capture-brand-review: no files changed (fully idempotent run).');
    return;
  }
  console.log(`capture-brand-review: ${String(changedFiles.length)} file(s) changed:`);
  for (const file of changedFiles) {
    console.log(`  ${file}`);
  }
}

main().catch((err: unknown) => {
  console.error('capture-brand-review: FATAL', err);
  process.exit(1);
});
