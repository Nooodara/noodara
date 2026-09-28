// Captures the SITE-03 review matrix against the built public site (`apps/site/out`,
// 10-04-PLAN.md Task 2). Mirrors `capture-ui-review.ts`'s own shape (VIEWPORT_HEIGHT,
// `writeIfChanged`-ledgered screenshots, a final changed-files report) but serves the static
// export from `static-site-server.ts` instead of attaching to a running app -- the site has no
// server of its own, and D-16 requires the capture run itself to prove zero third-party requests
// rather than merely assert it in prose.
//
// WHY THE RUN FAILS ON A THIRD-PARTY REQUEST OR A CONSOLE ERROR (T-10-05). This is the one place
// in the whole review pipeline that actually loads the site's real, built HTML/CSS/JS in a real
// browser and watches every network request it makes. Assertions in a unit test can check the
// site's *source* never references a third-party origin; only a run like this one can catch a
// third-party request a dependency introduces indirectly (a font, an analytics beacon, a CDN
// fallback) that no grep would find.

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { changedFiles, writeIfChanged } from '../brand/write-if-changed.js';
import { SITE_PAGES, siteReviewPngPath, THEMES, WIDTHS, type SiteSurface, type Theme, type Width } from './review-paths.js';
import { isThirdPartyRequest, startStaticSiteServer } from './static-site-server.js';

/** Same discipline as `capture-ui-review.ts`'s own table: `fullPage: true` ignores the viewport's
 *  height once set, but a real height still matters for what renders before that flag applies. */
const VIEWPORT_HEIGHT: Record<Width, number> = { 375: 812, 900: 900, 1280: 900, 1920: 1080 };

const REDUCED_MOTION_WIDTH: Width = 1280;

/** Chromium's own generic network-failure console message (never application code -- the browser
 *  emits it for ANY resource, including the top-level document itself, that resolves with a
 *  non-2xx status). The `not-found` surface (SITE_PAGES) deliberately navigates to a path that
 *  returns 404 -- that is the whole point of capturing it -- so this exact message is expected
 *  there and must not be treated as a D-16 console-error violation. It is still recorded (and
 *  still fails the run) for every other surface, where a 404 means a real broken resource. */
const RESOURCE_LOAD_FAILURE_PATTERN = /^Failed to load resource: the server responded with a status of \d+/;

interface Violation {
  readonly kind: 'third-party-request' | 'console-error';
  readonly detail: string;
  readonly surface: string;
  readonly theme: Theme;
}

async function captureSurface(
  context: BrowserContext,
  origin: string,
  surface: SiteSurface,
  urlPath: string,
  theme: Theme,
  width: Width,
  reducedMotion: boolean,
  violations: Violation[],
): Promise<void> {
  const page: Page = await context.newPage();
  page.on('request', (request) => {
    const url = request.url();
    if (isThirdPartyRequest(url, origin)) {
      violations.push({ kind: 'third-party-request', detail: url, surface, theme });
    }
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') {
      return;
    }
    if (surface === 'not-found' && RESOURCE_LOAD_FAILURE_PATTERN.test(message.text())) {
      return;
    }
    violations.push({ kind: 'console-error', detail: message.text(), surface, theme });
  });

  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT[width] });
  await page.goto(origin + urlPath, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);

  const fileName = reducedMotion ? 'landing-reduced-motion' : surface;
  writeIfChanged(siteReviewPngPath(fileName, theme, width), await page.screenshot({ fullPage: true, type: 'png' }));

  await page.close();
}

async function captureThemeMatrix(
  browser: Browser,
  origin: string,
  theme: Theme,
  violations: Violation[],
): Promise<void> {
  const context = await browser.newContext({ colorScheme: theme, reducedMotion: 'no-preference' });
  try {
    for (const width of WIDTHS) {
      for (const surfacePage of SITE_PAGES) {
        await captureSurface(context, origin, surfacePage.id, surfacePage.path, theme, width, false, violations);
      }
    }
  } finally {
    await context.close();
  }

  const reducedContext = await browser.newContext({ colorScheme: theme, reducedMotion: 'reduce' });
  try {
    await captureSurface(reducedContext, origin, 'landing-reduced-motion', '/', theme, REDUCED_MOTION_WIDTH, true, violations);
  } finally {
    await reducedContext.close();
  }
}

async function main(): Promise<void> {
  const outDir = path.resolve(import.meta.dirname, '../../apps/site/out');
  if (!existsSync(path.join(outDir, 'index.html'))) {
    console.error('capture-site-review: apps/site/out/index.html not found — run `pnpm site:build` first');
    process.exit(1);
    return;
  }

  const server = await startStaticSiteServer(outDir);
  let browser: Browser | undefined;
  const violations: Violation[] = [];

  try {
    browser = await chromium.launch();
    for (const theme of THEMES) {
      await captureThemeMatrix(browser, server.origin, theme, violations);
    }
  } finally {
    await browser?.close();
    await server.close();
  }

  if (violations.length > 0) {
    console.error(`capture-site-review: ${String(violations.length)} violation(s) found:`);
    for (const violation of violations) {
      console.error(`  [${violation.kind}] ${violation.surface}/${violation.theme}: ${violation.detail}`);
    }
    process.exit(1);
    return;
  }

  if (changedFiles.length === 0) {
    console.log('capture-site-review: no files changed (fully idempotent run).');
  } else {
    console.log(`capture-site-review: ${String(changedFiles.length)} file(s) changed:`);
    for (const file of changedFiles) {
      console.log(`  ${file}`);
    }
  }
  console.log(`capture-site-review: ${String(SITE_PAGES.length * THEMES.length * WIDTHS.length + THEMES.length)} captures, zero third-party requests`);
}

main().catch((err: unknown) => {
  console.error('capture-site-review: FATAL', err);
  process.exit(1);
});
