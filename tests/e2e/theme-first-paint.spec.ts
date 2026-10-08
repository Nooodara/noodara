// 09-07-PLAN.md Task 2 (D-09, D-11, SET-04/SET-05): proves the SSR root layout carries the user's
// theme/motion/density preferences on the very first byte of HTML, with zero flash, with or
// without JS. Runs against the same real stack.ts stack every other spec in this directory uses
// (Postgres, Redis, the API, the worker, the built web app).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const PREFERENCES_COOKIE_NAME = 'noodara-prefs';
// tokens.css's [data-theme="dark"] --canvas value (#161618), the color a real browser resolves
// `body`'s background to once the dark stylesheet rule applies -- checked as an rgb() triple since
// that is what getComputedStyle always returns, regardless of how the source CSS spelled the color.
const DARK_CANVAS_RGB = 'rgb(22, 22, 24)';

declare global {
  interface Window {
    /** Populated by the frame-sampling init script the "no theme flash" test installs below. */
    __themeFirstPaint?: { readonly frames: string[]; mutations: number };
  }
}

async function addPreferencesCookie(context: BrowserContext, value: string): Promise<void> {
  await context.addCookies([
    {
      name: PREFERENCES_COOKIE_NAME,
      value,
      url: 'http://localhost:3000',
    },
  ]);
}

function htmlTagOf(body: string): string {
  const match = /<html[^>]*>/.exec(body);
  if (match === null) {
    throw new Error('no <html> opening tag found in response body');
  }
  return match[0];
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

/** Installs the frame sampler + data-theme MutationObserver used by the "no theme flash" case,
 *  before any navigation -- `page.addInitScript` re-runs on every subsequent real navigation this
 *  context makes (a full page load/reload), which is exactly what each assertion below forces
 *  before reading a fresh sample, rather than a client-side-only route change (e.g. /login's
 *  post-submit `router.push`, which never re-triggers `addInitScript` on its own). */
async function installFrameSampler(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { frames: [] as string[], mutations: 0 };
    window.__themeFirstPaint = state;

    // Observes `document` itself (always a valid Node from the very first tick), not
    // `document.documentElement` -- an `addInitScript` callback fires before the parser has even
    // created the <html> element on a real navigation (`document.documentElement` is briefly
    // `null`, confirmed empirically), so `subtree: true` is what actually lets this observer catch
    // a mutation on <html> once it exists, rather than throwing at setup.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'data-theme') {
          state.mutations += 1;
        }
      }
    });
    observer.observe(document, { attributes: true, attributeFilter: ['data-theme'], subtree: true });

    function sample(): void {
      if (state.frames.length >= 10) {
        return;
      }
      // Same early-execution reality as above: `document.body` may not exist yet on the very
      // first few frames of a real navigation -- skip those ticks rather than throwing, and keep
      // scheduling until it does.
      if (document.body !== null) {
        state.frames.push(getComputedStyle(document.body).backgroundColor);
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
}

async function waitForFrameSample(page: Page): Promise<{ frames: string[]; mutations: number }> {
  await expect.poll(() => page.evaluate(() => window.__themeFirstPaint?.frames.length ?? 0)).toBeGreaterThanOrEqual(10);
  return readFrameSample(page);
}

async function readFrameSample(page: Page): Promise<{ frames: string[]; mutations: number }> {
  return page.evaluate(() => {
    const state = window.__themeFirstPaint;
    if (state === undefined) {
      throw new Error('frame sampler not installed');
    }
    return { frames: state.frames, mutations: state.mutations };
  });
}

test('@theme-first-paint GET /login with a dark/on/compact cookie renders data-theme, data-motion and data-density on <html> in the raw SSR HTML', async ({
  context,
}) => {
  await addPreferencesCookie(context, 'dark.on.compact');

  const response = await context.request.get('/login');
  const tag = htmlTagOf(await response.text());

  expect(tag).toContain('data-theme="dark"');
  expect(tag).toContain('data-motion="reduce"');
  expect(tag).toContain('data-density="compact"');
});

test('@theme-first-paint GET /login with a light/system/comfortable cookie renders data-theme="light" and omits data-motion/data-density', async ({
  context,
}) => {
  await addPreferencesCookie(context, 'light.system.comfortable');

  const response = await context.request.get('/login');
  const tag = htmlTagOf(await response.text());

  expect(tag).toContain('data-theme="light"');
  expect(tag).not.toContain('data-motion');
  expect(tag).not.toContain('data-density');
});

test('@theme-first-paint GET /login with no cookie omits data-theme from the raw SSR HTML; the bootstrap script resolves it before first paint', async ({
  context,
  page,
}) => {
  const response = await context.request.get('/login');
  const tag = htmlTagOf(await response.text());
  expect(tag).not.toContain('data-theme');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('@theme-first-paint GET /login with an auto cookie also omits data-theme from the raw SSR HTML', async ({
  context,
}) => {
  await addPreferencesCookie(context, 'auto.system.comfortable');

  const response = await context.request.get('/login');
  const tag = htmlTagOf(await response.text());
  expect(tag).not.toContain('data-theme');
});

test('@theme-first-paint a tampered noodara-prefs cookie never yields a data-theme attribute and is never echoed raw into the response body', async ({
  context,
}) => {
  const tamperedValue = '%3Cscript%3E';
  await addPreferencesCookie(context, tamperedValue);

  const response = await context.request.get('/login');
  const body = await response.text();

  expect(htmlTagOf(body)).not.toContain('data-theme');
  expect(body).not.toContain(tamperedValue);
  expect(body).not.toContain('<script>alert');
});

test.describe('with JavaScript disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('@theme-first-paint a dark cookie renders data-theme="dark" on <html> and a dark canvas background with JS disabled', async ({
    context,
    page,
  }) => {
    await addPreferencesCookie(context, 'dark.on.compact');

    await page.goto('/login');

    expect(htmlTagOf(await page.content())).toContain('data-theme="dark"');
    await expect(page.locator('body')).toHaveCSS('background-color', DARK_CANVAS_RGB);
  });
});

test('@theme-first-paint no theme flash on reload for dark and light, on /login and on /servers after login', async ({
  page,
  context,
}) => {
  await addPreferencesCookie(context, 'dark.on.compact');
  await installFrameSampler(page);

  await page.goto('/login');
  const loginResult = await waitForFrameSample(page);
  expect(loginResult.mutations).toBe(0);
  expect(new Set(loginResult.frames).size).toBe(1);
  expect(loginResult.frames[0]).toBe(DARK_CANVAS_RGB);

  await login(page);
  // 14-26: the shell's session store (apps/web/src/lib/session-user.ts `ensureLoaded`) reads
  // `GET /api/account/preferences` on mount. That response re-issues the mirror cookie, and the
  // store then calls `applyPreferences(server)`. If the PATCH below lands while that GET is in
  // flight, the GET's stale `auto` value rewrites the cookie after the PATCH did, and the reload
  // paints from it (nightly 37807942623). The store emits after both writes, and the emit fills
  // the account menu trigger, so a non-empty trigger means the load has settled (same signal as
  // a11y-fallbacks.spec.ts).
  await expect(page.getByTestId('shell-account-menu-trigger')).toHaveText(/\S/);
  // D-10 (09-10): once signed in, the shared session store reconciles the browser mirror with the
  // server's stored preferences and the SERVER wins. A cookie manufactured by this test is exactly
  // the divergence that reconciliation exists to correct (it would legitimately repaint /servers
  // back to the account's true value), so the account's stored preference must genuinely be
  // `dark.on.compact` before the no-flash assertion on /servers -- the same real PATCH the
  // Settings screen issues. The response also re-issues the mirror cookie server-side (D-09).
  const patched = await page.request.patch('/api/account/preferences', {
    headers: { origin: 'http://localhost:3000' },
    data: { theme: 'dark', reduceMotion: 'on', density: 'compact' },
  });
  expect(patched.ok()).toBe(true);
  try {
    // /login -> /servers is a client-side `router.push` (no real navigation) -- reload to force a
    // genuine SSR-driven paint of /servers too, re-arming the sampler via addInitScript.
    await page.reload();
    const serversResult = await waitForFrameSample(page);
    expect(serversResult.mutations).toBe(0);
    expect(new Set(serversResult.frames).size).toBe(1);
    expect(serversResult.frames[0]).toBe(DARK_CANVAS_RGB);
  } finally {
    // Restore the shared E2E admin's stored preferences so later specs start from the defaults.
    const restored = await page.request.patch('/api/account/preferences', {
      headers: { origin: 'http://localhost:3000' },
      data: { theme: 'auto', reduceMotion: 'system', density: 'comfortable' },
    });
    expect(restored.ok()).toBe(true);
  }
});

test('@theme-first-paint no theme flash for a light preference on /login', async ({ page, context }) => {

  await addPreferencesCookie(context, 'light.system.comfortable');
  await installFrameSampler(page);

  await page.goto('/login');
  const result = await waitForFrameSample(page);
  expect(result.mutations).toBe(0);
  expect(new Set(result.frames).size).toBe(1);
  expect(result.frames[0]).not.toBe(DARK_CANVAS_RGB);
});
