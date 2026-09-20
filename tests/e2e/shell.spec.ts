// 05-12-PLAN.md Task 3: UI-01's keyboard, theme and responsive requirements, verified in a real
// browser. Runs against the same real stack.ts stack smoke.spec.ts/auth.spec.ts use (Postgres,
// Redis, the API, the worker, the built web app) with the preseeded E2E admin.
//
// Only `/servers` (this plan's own minimal placeholder page, apps/web/src/app/(shell)/servers)
// renders the shell for real -- `/activity`/`/settings` have no page yet (Plan 05-12's own
// files_modified never listed them; later screen plans add them) -- so every assertion here that
// needs the shell's own chrome navigates back to `/servers` first, and a click/Enter on Activity
// or Settings is only ever asserted by URL, exactly like tests/e2e/smoke.spec.ts's own
// "the URL updates correctly, no page exists yet" precedent for `/servers` before Plan 05-12.
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

declare global {
  interface Window {
    /** Bridged in by `page.exposeFunction` in the `@sse-live` test below -- declared here
     *  (rather than an `unknown` cast at the call site) so the in-page code stays fully typed. */
    __notifyStreamOpen?: () => Promise<void>;
  }
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

function focusedAccessibleName(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return null;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null) return ariaLabel;
    return el.textContent.trim();
  });
}

function focusedTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

test('@shell pressing Tab from page load moves through the skip link, the three sidebar items, the theme toggle, then sign out', async ({
  page,
}) => {
  await login(page);

  await page.keyboard.press('Tab');
  expect(await focusedAccessibleName(page)).toBe('Skip to content');

  await page.keyboard.press('Tab');
  expect(await focusedAccessibleName(page)).toBe('Servers');

  await page.keyboard.press('Tab');
  expect(await focusedAccessibleName(page)).toBe('Activity');

  await page.keyboard.press('Tab');
  expect(await focusedAccessibleName(page)).toBe('Settings');

  await page.keyboard.press('Tab');
  const themeToggleName = await focusedAccessibleName(page);
  expect(themeToggleName).toMatch(/^Theme:/);

  await page.keyboard.press('Tab');
  expect(await focusedAccessibleName(page)).toBe('Sign out');
});

test('@shell every focused sidebar item shows a visible, non-zero focus outline', async ({ page }) => {
  await login(page);

  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.press('Tab');
  }
  // 4th Tab stop is the Settings sidebar item (skip link, Servers, Activity, Settings).
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return null;
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, outlineStyle: style.outlineStyle };
  });
  expect(outline).not.toBeNull();
  expect(outline?.width).not.toBe('0px');
  expect(outline?.outlineStyle).not.toBe('none');
});

test('@shell activating a sidebar item by keyboard navigates to its route', async ({ page }) => {
  await login(page);

  await page.getByRole('link', { name: 'Activity' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/activity$/);

  await page.goto('/servers');
  await page.getByRole('link', { name: 'Settings' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings$/);

  await page.goto('/servers');
  await page.getByRole('link', { name: 'Servers' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/servers$/);
});

test('@shell the theme toggle cycles data-theme and the choice survives a reload', async ({ page }) => {
  await login(page);

  await page.getByTestId('shell-theme-toggle').click();
  const afterFirstClick = await focusedTheme(page);

  await page.getByTestId('shell-theme-toggle').click();
  const afterSecondClick = await focusedTheme(page);

  expect(afterSecondClick).not.toBe(afterFirstClick);

  await page.reload();
  await expect.poll(() => focusedTheme(page)).toBe(afterSecondClick);
});

test('@shell the sidebar collapses to an icon rail at 1024px and a bottom sheet below 900px', async ({ page }) => {
  await login(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('link', { name: 'Servers' }).locator('span')).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(page.getByRole('link', { name: 'Servers' }).locator('span')).toBeHidden();
  await page.getByRole('link', { name: 'Servers' }).focus();
  await expect(page.getByRole('tooltip')).toHaveText('Servers');

  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.getByTestId('shell-sidebar')).toBeHidden();
  await page.getByTestId('shell-menu-button').click();
  await expect(page.getByTestId('shell-sidebar')).toBeVisible();
});

test('@shell signing out returns to /login, and a subsequent direct visit to /servers redirects to /login again', async ({
  page,
}) => {
  await login(page);

  await page.getByTestId('shell-sign-out').click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/servers');
  await expect(page).toHaveURL(/\/login$/);
});

// Not one of the plan's six documented @shell behaviours -- a deliberately different tag (never
// containing the substring "@shell", so `--grep @shell` still selects exactly six tests) for
// permanent regression coverage of a real bug this plan's own security review found:
// `next.config.ts`'s generic `rewrites()` proxy buffers a long-lived SSE response instead of
// streaming it (confirmed empirically -- a real event published while the stream was open through
// the rewrite never reached the browser, even after 8s). `apps/web/src/app/api/events/route.ts`'s
// dedicated streaming Route Handler fixes this; this test proves a real `server.updated` frame --
// produced by a real `POST /api/servers` call, not a synthetic one -- actually reaches the browser
// while the connection stays open.
test('@sse-live a real SSE frame published mid-connection reaches the browser through the same-origin proxy', async ({
  page,
}) => {
  await login(page);

  // Signals back to this test (via Playwright's exposeFunction bridge) the moment the in-page
  // fetch has actually received its first bytes -- an observable state to wait on instead of a
  // fixed sleep, so the mutation below is only ever triggered once the stream is genuinely open.
  let notifyStreamOpen: () => void = () => undefined;
  const streamOpened = new Promise<void>((resolve) => {
    notifyStreamOpen = resolve;
  });
  await page.exposeFunction('__notifyStreamOpen', () => {
    notifyStreamOpen();
  });

  const evalPromise = page.evaluate(async () => {
    const chunks: string[] = [];
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 8000);
    const response = await fetch('/api/events', { signal: controller.signal });
    const body = response.body;
    if (body === null) {
      throw new Error('response.body is null');
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let notified = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      chunks.push(buf);
      if (!notified && buf.includes('retry: 5000')) {
        notified = true;
        await window.__notifyStreamOpen?.();
      }
      if (buf.includes('server.updated')) break;
    }
    await reader.cancel().catch(() => undefined);
    return chunks;
  });

  await streamOpened;
  const name = `probe-${String(Date.now())}`;
  const created = await page.request.post('/api/servers', {
    data: {
      name,
      host: `${name}.example.test`,
      credential: { type: 'ssh_password', password: 'diagnostic-only' },
    },
  });
  // A refused create must fail here, by name -- never later, disguised as a live event that
  // was lost.
  expect(created.status()).toBe(201);

  const chunks = await evalPromise;
  expect(chunks.some((chunk) => chunk.includes('retry: 5000'))).toBe(true);
  expect(chunks.some((chunk) => chunk.includes('server.updated'))).toBe(true);
});

// Permanent regression coverage for a real product bug (debug session sse-lost-event-race, round
// 2): the streaming proxy never tore down its upstream control-plane stream when the browser went
// away -- under `next start` it was released only whenever the Next process next happened to
// garbage-collect the abandoned response. Every closed tab, reload or navigation therefore kept
// holding one of the control plane's capped SSE slots (D-07, 32 by default), and once they were
// all held every new page got `503 SSE_LIMIT_REACHED` and no live updates at all.
//
// Opens and abandons more streams than the cap allows through the real same-origin proxy, then
// asserts a fresh stream still opens. Node's own `fetch` (never `page.request`, which buffers a
// whole body and would never return for a stream) with the real session cookie of a real login.
test('@sse-slots abandoned event streams release their control-plane slot instead of exhausting the cap', async ({
  page,
  context,
  baseURL,
}) => {
  await login(page);
  // Leave the shell so this page's own shared EventSource is closed and cannot mask (or be
  // starved by) what this test measures.
  await page.goto('about:blank');
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const eventsUrl = `${baseURL ?? ''}/api/events`;

  async function openThenAbandon(): Promise<number> {
    const controller = new AbortController();
    try {
      const response = await fetch(eventsUrl, { headers: { cookie }, signal: controller.signal });
      if (response.status === 200) {
        // Only abandon a stream that is genuinely open (its first bytes arrived).
        await response.body?.getReader().read();
      }
      return response.status;
    } finally {
      controller.abort();
    }
  }

  const ABOVE_DEFAULT_CAP = 40;
  for (let i = 0; i < ABOVE_DEFAULT_CAP; i += 1) {
    await openThenAbandon();
  }

  // Release is asynchronous (browser -> Next -> control plane), so this waits on the observable
  // outcome with a bound -- never a fixed sleep. Before the fix the slots stayed held for as long
  // as the Next process did not garbage-collect (observed: 60s+).
  await expect(async () => {
    expect(await openThenAbandon()).toBe(200);
  }).toPass({ timeout: 5000 });
});

// Second half of the same debug session: a real browser never retries an EventSource whose request
// was answered with a non-200 status (HTML spec -- the connection is failed for good, one `error`,
// readyState CLOSED). The shared hook only began its own backoff after three `error` events, which
// therefore never came: one `503 SSE_LIMIT_REACHED` at page load left the shell on "Reconnecting…"
// with no live updates until a manual reload, long after capacity had returned.
//
// Holds every SSE slot, loads the shell into the 503, releases the slots, and asserts the page
// recovers on its own.
test('@sse-recover the shell reconnects on its own after its event stream was refused at the connection cap', async ({
  page,
  context,
  baseURL,
}) => {
  await login(page);
  await page.goto('about:blank');
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const eventsUrl = `${baseURL ?? ''}/api/events`;

  // Responses are kept referenced on purpose: an unreferenced fetch body is cancelled whenever
  // this process garbage-collects, which would silently release a held slot mid-test.
  const held: { readonly controller: AbortController; readonly response: Response }[] = [];
  try {
    const FAR_ABOVE_DEFAULT_CAP = 64;
    let capReached = false;
    for (let i = 0; i < FAR_ABOVE_DEFAULT_CAP && !capReached; i += 1) {
      const controller = new AbortController();
      const response = await fetch(eventsUrl, { headers: { cookie }, signal: controller.signal });
      if (response.status === 200) {
        held.push({ controller, response });
      } else {
        expect(response.status).toBe(503);
        controller.abort();
        capReached = true;
      }
    }
    expect(capReached).toBe(true);

    await page.goto('/servers');
    await expect(page.getByTestId('shell-stream-status')).toBeVisible();
  } finally {
    for (const { controller } of held) controller.abort();
  }

  await expect(page.getByTestId('shell-stream-status')).toBeHidden();
});
