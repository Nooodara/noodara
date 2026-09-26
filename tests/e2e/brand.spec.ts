// 07-07 Task 2 (BRAND-02, D-04, D-09): the brand mark's breakpoint and theme behaviour, proven in
// a real browser against the same real stack.ts stack shell.spec.ts/auth.spec.ts use (Postgres,
// Redis, the API, the worker, the built web app) with the preseeded E2E admin.
//
// WHY THIS IS A SEPARATE FILE. The component tests
// (apps/web/src/components/{Sidebar,AuthCard}.test.tsx) assert the wrapper's breakpoint CLASSES;
// only a real browser at a real viewport resolves those classes into an actually-hidden element.
// The existing 14 specs are not touched -- this plan adds a surface, it does not change one -- so
// every helper below is local to this file (the `login` helper is copied from shell.spec.ts rather
// than imported from it, matching this directory's own convention that a spec never imports
// another spec).
//
// THEME IS SET BY ATTRIBUTE, NEVER BY CLICKING THE TOGGLE. `data-theme` is written directly with
// `page.evaluate`, the same deterministic mechanism scripts/brand/capture-brand-review.ts uses, so
// an assertion never depends on which theme a previous test left in localStorage and never has to
// wait for a transition. Not one fixed sleep is used anywhere in this file -- every wait is
// Playwright's own auto-waiting assertion on an observable state (noodara-tdd skill SS6). (The
// banned API is named descriptively rather than literally so this plan's own "zero fixed sleeps"
// grep stays exact, following 07-03's precedent.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

/** The three reference viewports the shell's own E2E already uses -- never a new breakpoint
 *  number. 1440x900 is the expanded sidebar, 1024x800 the 64px rail, 800x800 the bottom sheet. */
const EXPANDED = { width: 1440, height: 900 } as const;
const RAIL = { width: 1024, height: 800 } as const;
const SHEET = { width: 800, height: 800 } as const;

/** Sidebar.tsx's rail width (`min-[900px]:w-16`), in CSS px. */
const RAIL_WIDTH = 64;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value: string) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
}

/** The colour the mark actually paints with -- `currentColor` resolves to the computed `color` of
 *  the SVG itself, inherited from the `text-ink` wrapper. */
function markColor(page: Page, testId: string): Promise<string> {
  return page.evaluate((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el === null) return '';
    return getComputedStyle(el).color;
  }, testId);
}

test('@brand /login renders the lockup and exactly one image named Noodara', async ({ page }) => {
  await page.setViewportSize({ ...EXPANDED });
  await page.goto('/login');

  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Noodara' })).toHaveCount(1);
});

test('@brand the lockup on /login follows the theme through currentColor', async ({ page }) => {
  await page.setViewportSize({ ...EXPANDED });
  await page.goto('/login');

  await setTheme(page, 'light');
  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  const lightColor = await markColor(page, 'brand-lockup');

  await setTheme(page, 'dark');
  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  const darkColor = await markColor(page, 'brand-lockup');

  expect(lightColor).not.toBe('');
  expect(darkColor).not.toBe(lightColor);
});

test('@brand /setup renders the lockup for an unauthenticated visitor', async ({ page }) => {
  await page.setViewportSize({ ...EXPANDED });
  await page.goto('/setup');

  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Noodara' })).toHaveCount(1);
});

test('@brand the expanded sidebar shows the lockup and hides the monogram at 1440px', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ ...EXPANDED });
  await page.goto('/servers');

  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  await expect(page.getByTestId('brand-monogram')).toBeHidden();
  // 08-08 (D-05): the account menu trigger replaces the old theme-toggle/sign-out cluster at the
  // sidebar's foot and stays visible at every breakpoint, alongside whichever brand mark is shown.
  await expect(page.getByTestId('shell-account-menu-trigger')).toBeVisible();
});

test('@brand the 64px rail shows the monogram and hides the lockup at 1024px', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ ...RAIL });
  await page.goto('/servers');

  await expect(page.getByTestId('brand-monogram')).toBeVisible();
  await expect(page.getByTestId('brand-lockup')).toBeHidden();
  await expect(page.getByTestId('shell-account-menu-trigger')).toBeVisible();

  const box = await page.getByTestId('shell-sidebar').boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width).toBe(RAIL_WIDTH);
});

test('@brand the monogram stays visible in the rail in dark theme', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ ...RAIL });
  await page.goto('/servers');

  await setTheme(page, 'light');
  await expect(page.getByTestId('brand-monogram')).toBeVisible();
  const lightColor = await markColor(page, 'brand-monogram');

  await setTheme(page, 'dark');
  await expect(page.getByTestId('brand-monogram')).toBeVisible();
  expect(await markColor(page, 'brand-monogram')).not.toBe(lightColor);
});

test('@brand the below-900px bottom sheet carries no mark, closed or open', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ ...SHEET });
  await page.goto('/servers');

  await expect(page.getByTestId('shell-sidebar')).toBeHidden();
  await expect(page.getByTestId('brand-monogram')).toBeHidden();
  await expect(page.getByTestId('brand-lockup')).toBeHidden();

  await page.getByTestId('shell-menu-button').click();
  await expect(page.getByTestId('shell-sidebar')).toBeVisible();
  await expect(page.getByTestId('shell-sidebar').getByRole('link')).toHaveCount(3);
  await expect(page.getByTestId('brand-monogram')).toBeHidden();
  await expect(page.getByTestId('brand-lockup')).toBeHidden();
  // 08-08 (D-05): the account menu trigger is still the shell's one identity affordance inside
  // the mobile sheet, not just at the two wider breakpoints above.
  await expect(page.getByTestId('shell-account-menu-trigger')).toBeVisible();
});

// 07-09-PLAN.md Task 3 (BRAND-02, D-11/D-12): proves every icon/manifest URL Next.js actually
// emits in the served `<head>` is really served, from the built app -- not just that the file
// convention wired something up. The expected `theme_color` is read from the real committed
// `packages/ui/brand/brand-colors.json` rather than typed as a literal, so this spec cannot drift
// from the single source of truth 07-06's generator owns.
const BRAND_COLORS_PATH = fileURLToPath(new URL('../../packages/ui/brand/brand-colors.json', import.meta.url));
const BRAND_COLORS = JSON.parse(readFileSync(BRAND_COLORS_PATH, 'utf8')) as {
  themeColor: string;
  backgroundColor: string;
};

/** Reads a PNG's declared pixel width straight out of its IHDR chunk (bytes 16-19, big-endian) --
 *  the same decode-by-shape discipline `scripts/brand/raster.ts`'s own `pngMetadata` uses,
 *  reimplemented here with zero dependency since this file runs under Playwright's own test
 *  runner, not Vitest. */
function pngWidthFromIhdr(png: Buffer): number {
  return png.readUInt32BE(16);
}

async function fetchOk(request: APIRequestContext, url: string): Promise<Buffer> {
  const response = await request.get(url);
  expect(response.status(), `GET ${url}`).toBe(200);
  return Buffer.from(await response.body());
}

test.describe('brand icons', () => {
  test('@brand /login serves the favicon, apple-touch-icon, manifest and OG head tags', async ({ page }) => {
    await page.goto('/login');

    const iconHref = await page.locator('link[rel="icon"]').first().getAttribute('href');
    expect(iconHref).not.toBeNull();
    expect(iconHref).toMatch(/\.(svg|ico)(\?.*)?$/);

    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(1);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Noodara');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Your infrastructure, understood.',
    );
  });

  test('@brand every icon, apple-touch-icon, manifest href and og:image are served with 200', async ({
    page,
    request,
  }) => {
    await page.goto('/login');

    // Every assertion below checks BOTH status 200 AND a real image/manifest content-type --
    // status alone is not enough evidence: an unauthenticated request that gets redirected to
    // /login still resolves 200, just as `text/html` (the exact bug 07-09 Task 3's own RED run
    // caught in apps/web/src/proxy.ts's matcher, fixed in this same commit).
    const iconHrefs = await page.locator('link[rel="icon"]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href')).filter((href): href is string => href !== null),
    );
    expect(iconHrefs.length).toBeGreaterThan(0);
    for (const href of iconHrefs) {
      const response = await request.get(href);
      expect(response.status(), `GET ${href}`).toBe(200);
      expect(response.headers()['content-type'], `GET ${href}`).toMatch(/^image\//);
      expect((await response.body()).length).toBeGreaterThan(0);
    }

    const appleTouchHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    expect(appleTouchHref).not.toBeNull();
    if (appleTouchHref !== null) {
      const response = await request.get(appleTouchHref);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toMatch(/^image\//);
    }

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).not.toBeNull();
    if (manifestHref !== null) {
      const response = await request.get(manifestHref);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toMatch(/^application\/manifest\+json|^application\/json/);
    }

    const ogImageContent = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(ogImageContent).not.toBeNull();
    if (ogImageContent !== null) {
      const response = await request.get(ogImageContent);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toMatch(/^image\//);
    }
  });

  test('@brand GET /favicon.ico is served with an ico content-type', async ({ request }) => {
    const response = await request.get('/favicon.ico');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/^image\/(x-icon|vnd\.microsoft\.icon)$/);
  });

  test('@brand the manifest JSON parses, carries the real theme colour and every icon src resolves to a correctly-sized PNG', async ({
    page,
    request,
  }) => {
    await page.goto('/login');
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).not.toBeNull();
    if (manifestHref === null) return;

    const manifestResponse = await request.get(manifestHref);
    expect(manifestResponse.status()).toBe(200);
    const manifest = (await manifestResponse.json()) as {
      theme_color: string;
      background_color: string;
      icons: ReadonlyArray<{ src: string; sizes: string; type: string }>;
    };

    expect(manifest.theme_color).toBe(BRAND_COLORS.themeColor);
    expect(manifest.background_color).toBe(BRAND_COLORS.backgroundColor);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const declaredWidth = Number(icon.sizes.split('x')[0]);
      const png = await fetchOk(request, icon.src);
      expect(pngWidthFromIhdr(png)).toBe(declaredWidth);
    }
  });
});
