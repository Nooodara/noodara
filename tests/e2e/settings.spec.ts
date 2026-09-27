// 05-16-PLAN.md Task 3: the settings screen (SET-01), verified in a real browser. Runs against the
// same real stack.ts stack smoke.spec.ts/auth.spec.ts/servers-list.spec.ts/activity.spec.ts use
// (Postgres, Redis, the API, the worker, the built web app), with the preseeded E2E admin.
//
// The populated-rows tests hit the real, unstubbed `GET /api/config` -- unlike servers-list.spec.ts
// and activity.spec.ts, this endpoint's values are all either fixed (the three SSH timeouts and
// worker concurrency default to 10000/30000/60000/5 per apps/control-plane/src/env.ts's own
// `parseTuningInt` defaults, never overridden by tests/e2e/fixtures/stack.ts's shared env) or
// simply present without needing an exact value (the version string, the random-per-run master key
// fingerprint) -- there is no non-deterministic discovery-dependent field here the way
// servers-list.spec.ts's `lastSeenAt` is, so a real round trip is both possible and more honest
// than a stub. Only the error/loading states below use `page.route` interception (ADR-0005),
// matching every other spec's own established precedent for a screen-state assertion with no
// second backend.
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const INTERNAL_ERROR_COPY =
  "Couldn't load configuration. Something went wrong on our end. Try again, and check the server logs if it continues.";

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

test('@settings the Instance group shows the version and public URL with exactly one copy button, always expanded', async ({
  page,
}) => {
  await login(page);
  await page.goto('/settings');

  const main = page.getByRole('main');
  await expect(main.getByText('Version')).toBeVisible();
  await expect(main.getByText('Public URL')).toBeVisible();
  await expect(main.getByText('http://localhost:3000')).toBeVisible();
  await expect(main.getByRole('button', { name: /copy/i })).toHaveCount(1);
});

test('@settings the Advanced group is collapsed on load and expands to exactly five rows, each captioned', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  const main = page.getByRole('main');
  // Collapsed-by-default content is genuinely absent from the accessibility tree, not merely
  // hidden -- Disclosure's own unmount-while-collapsed contract (packages/ui/src/Disclosure.tsx).
  await expect(main.getByText('Master key fingerprint')).toHaveCount(0);
  await expect(main.getByText('Worker concurrency')).toHaveCount(0);

  await main.getByRole('button', { name: 'Advanced' }).click();

  await expect(main.getByText('Master key fingerprint')).toBeVisible();
  await expect(main.getByText('Connect timeout')).toBeVisible();
  await expect(main.getByText('Command timeout')).toBeVisible();
  await expect(main.getByText('Discovery timeout')).toBeVisible();
  await expect(main.getByText('Worker concurrency')).toBeVisible();
  await expect(main.getByText('Set by an environment variable')).toHaveCount(5);
});

test('@settings the master key fingerprint renders a short mono digest with no 44-character base64-looking string anywhere', async ({
  page,
}) => {
  await login(page);
  await page.goto('/settings');

  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Advanced' }).click();

  const fingerprintRow = page.getByTestId('settings-row-master-key-fingerprint');
  const fingerprintValue = fingerprintRow.locator('[data-mono="true"]');
  await expect(fingerprintValue).toBeVisible();
  const fingerprintText = (await fingerprintValue.textContent())?.trim() ?? '';
  expect(fingerprintText.length).toBeLessThanOrEqual(16);

  const pageText = await page.locator('body').innerText();
  expect(pageText).not.toMatch(/[A-Za-z0-9+/]{44}/);
});

test('@settings the SSH timeout rows render seconds, never a raw millisecond count', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Advanced' }).click();

  // env.ts's own parseTuningInt defaults (10000/30000/60000ms), unmodified by the shared E2E stack.
  await expect(main.getByText('10s', { exact: true })).toBeVisible();
  await expect(main.getByText('30s', { exact: true })).toBeVisible();
  await expect(main.getByText('60s', { exact: true })).toBeVisible();
  await expect(main.getByText('10000', { exact: true })).toHaveCount(0);
  await expect(main.getByText('30000', { exact: true })).toHaveCount(0);
  await expect(main.getByText('60000', { exact: true })).toHaveCount(0);
});

// 09-12-PLAN.md Task 3 (SET-02/SET-03/SET-06, D-01/D-17): this assertion originally covered the
// whole screen when every group on /settings was read-only (Phase 5). It is now scoped to
// Instance/Advanced -- `SettingsRow`'s own SET-06 structural guarantee (see
// apps/web/src/lib/settings-rows.test.ts's @ts-expect-error proof) -- since Account is
// deliberately editable (Name/Email `Edit`, Password `Change`) and Appearance is deliberately a
// `SegmentedControl` (a `radio`-role control, not one of the roles this test bans).
test('@settings the Instance/Advanced groups have zero form controls and no save/apply/edit button', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  const instance = page.getByTestId('settings-instance-group');
  const advanced = page.getByTestId('settings-advanced-disclosure');
  await page.getByRole('main').getByRole('button', { name: 'Advanced' }).click();

  // Queried by role, not by tag name -- a custom component that merely behaves like an input
  // would still be caught (SET-01's read-only rule, T-5-70).
  for (const role of ['textbox', 'combobox', 'spinbutton', 'checkbox', 'switch', 'radio'] as const) {
    await expect(instance.getByRole(role)).toHaveCount(0);
    await expect(advanced.getByRole(role)).toHaveCount(0);
  }
  await expect(instance.getByRole('button', { name: /save|apply|edit|change/i })).toHaveCount(0);
  await expect(advanced.getByRole('button', { name: /save|apply|edit|change/i })).toHaveCount(0);
});

test('@settings a 500 shows the exact error banner with the code in mono, and Retry re-issues the request', async ({ page }) => {
  await login(page);

  let requestCount = 0;
  await page.route('**/api/config', (route) => {
    requestCount += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'A stubbed failure detail.' }),
    });
  });

  await page.goto('/settings');

  await expect(page.getByText(INTERNAL_ERROR_COPY)).toBeVisible();
  await expect(page.getByText('INTERNAL_ERROR', { exact: true })).toBeVisible();

  const requestsBeforeRetry = requestCount;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => requestCount).toBeGreaterThan(requestsBeforeRetry);
});

test('@settings the loading state shows skeleton rows and no spinner', async ({ page }) => {
  await login(page);

  // Deliberately never fulfilled/aborted -- the request stays pending for the whole assertion,
  // matching servers-list.spec.ts's/activity.spec.ts's own loading-state precedent. No fixed-delay
  // sleep: the skeleton assertions below use Playwright's own auto-retrying `expect`.
  await page.route('**/api/config', () => undefined);
  await page.goto('/settings');

  await expect(page.locator('[data-row="true"]').first()).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0);
});

// 09-13-PLAN.md: goal-backward E2E proof of the phase's five ROADMAP success criteria, through the
// real /settings UI built by 09-06..09-12. The E2E admin's bootstrap name is literally "Admin"
// (apps/control-plane/src/boot/bootstrap-admin.ts) -- every mutating test below restores it (and
// the password, and every Appearance control) in a `finally` block so later spec files in this
// same worker (workers: 1, fullyParallel: false) see the account back at its original state.

const ADMIN_ORIGINAL_NAME = 'Admin';
const RENAMED_ADMIN_NAME = 'E2E Admin Renamed';
// A deliberately fake, obviously-fixture temporary password (T-5-42) -- never reused by any other
// spec, only ever the account's real password for the brief window inside one try/finally.
const TEMP_ADMIN_PASSWORD = 'Noodara-E2E-Temp-Password-2026!';
const PASSWORD_NOTICE_PATTERN = /Password updated\. \d+ other sessions? (was|were) signed out\./;

test('@settings profile edit updates the account menu without reload', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  // A window-scoped marker only a real full-page navigation would ever clear -- proves D-04's
  // "no reload" contract is genuine, not just an unasserted implementation detail.
  await page.evaluate(() => {
    (window as unknown as { __noReloadMarker?: boolean }).__noReloadMarker = true;
  });

  try {
    await page.getByTestId('account-edit-name').click();
    await expect(page.getByTestId('account-name-sheet')).toBeVisible();
    await page.getByTestId('account-name-input').fill(RENAMED_ADMIN_NAME);
    await page.getByTestId('account-current-password-input').fill(E2E_ADMIN_PASSWORD);
    await page.getByTestId('account-name-save').click();

    await expect(page.getByTestId('account-name-sheet')).toBeHidden();
    await expect(page.getByTestId('shell-account-menu-trigger')).toContainText(RENAMED_ADMIN_NAME);

    await expect(page).toHaveURL(/\/settings$/);
    expect(await page.evaluate(() => (window as unknown as { __noReloadMarker?: boolean }).__noReloadMarker)).toBe(
      true,
    );

    await page.goto('/activity');
    await expect(
      page.getByTestId('activity-row').filter({ hasText: 'Admin changed their name' }).first(),
    ).toBeVisible();
  } finally {
    await page.goto('/settings');
    await page.getByTestId('account-edit-name').click();
    await expect(page.getByTestId('account-name-sheet')).toBeVisible();
    await page.getByTestId('account-name-input').fill(ADMIN_ORIGINAL_NAME);
    await page.getByTestId('account-current-password-input').fill(E2E_ADMIN_PASSWORD);
    await page.getByTestId('account-name-save').click();
    await expect(page.getByTestId('account-name-sheet')).toBeHidden();
    await expect(page.getByTestId('shell-account-menu-trigger')).toContainText(ADMIN_ORIGINAL_NAME);
  }
});

test('@settings wrong current password shows the field error', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  await expect(page.getByTestId('settings-account-group')).toContainText(E2E_ADMIN_EMAIL);

  await page.getByTestId('account-edit-email').click();
  await expect(page.getByTestId('account-email-sheet')).toBeVisible();
  await page.getByTestId('account-current-password-input').fill('definitely-the-wrong-password');
  await page.getByTestId('account-email-save').click();

  await expect(page.getByText('Current password is incorrect.')).toBeVisible();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('account-email-sheet')).toBeHidden();
  await expect(page.getByTestId('settings-account-group')).toContainText(E2E_ADMIN_EMAIL);
});

test('@settings password change revokes other sessions and keeps this one', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto('/settings');

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();

  try {
    // Another browser context, `pageB` -- signed in with the same admin, before the password
    // change, so it holds a session the change below must revoke.
    await login(pageB);
    await expect(pageB).toHaveURL(/\/servers$/);

    await page.getByTestId('account-edit-password').click();
    await expect(page.getByTestId('account-password-sheet')).toBeVisible();
    await page.getByTestId('account-current-password-input').fill(E2E_ADMIN_PASSWORD);
    await page.getByTestId('account-new-password-input').fill(TEMP_ADMIN_PASSWORD);
    await page.getByTestId('account-confirm-password-input').fill(TEMP_ADMIN_PASSWORD);
    await page.getByTestId('account-password-save').click();

    await expect(page.getByTestId('account-password-sheet')).toBeHidden();
    const notice = page.getByTestId('account-password-notice');
    await expect(notice).toBeVisible();
    const noticeText = (await notice.textContent()) ?? '';
    expect(noticeText).toMatch(PASSWORD_NOTICE_PATTERN);

    // The current tab (A) stays signed in -- it can keep navigating the app.
    await page.goto('/servers');
    await expect(page).toHaveURL(/\/servers$/);

    // No page.reload() on pageB anywhere here -- the redirect must happen on its own, once the
    // heartbeat notices the revoked session (require-session.ts's reason-aware redirect).
    await expect(pageB).toHaveURL(/\/login\?.*reason=password-changed/, { timeout: 60_000 });
    await expect(pageB.getByTestId('login-password-changed-notice')).toBeVisible();
  } finally {
    await page.goto('/settings');
    await page.getByTestId('account-edit-password').click();
    await expect(page.getByTestId('account-password-sheet')).toBeVisible();
    await page.getByTestId('account-current-password-input').fill(TEMP_ADMIN_PASSWORD);
    await page.getByTestId('account-new-password-input').fill(E2E_ADMIN_PASSWORD);
    await page.getByTestId('account-confirm-password-input').fill(E2E_ADMIN_PASSWORD);
    await page.getByTestId('account-password-save').click();
    await expect(page.getByTestId('account-password-sheet')).toBeHidden();
    await expect(page.getByTestId('account-password-notice')).toBeVisible();

    await contextB.close();
  }
});

test('@settings Instance and Advanced stay read-only', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  const instance = page.getByTestId('settings-instance-group');
  const advanced = page.getByTestId('settings-advanced-disclosure');
  await page.getByRole('main').getByRole('button', { name: 'Advanced' }).click();

  for (const tag of ['input', 'select', 'textarea']) {
    await expect(instance.locator(tag)).toHaveCount(0);
    await expect(advanced.locator(tag)).toHaveCount(0);
  }

  // Instance's only button is the Public URL row's CopyButton; Advanced's only button is its own
  // Disclosure trigger (the "Advanced" toggle itself lives inside this testid, D-16) -- neither
  // group ever gets a second, form-shaped button.
  const instanceButtons = instance.getByRole('button');
  await expect(instanceButtons).toHaveCount(1);
  await expect(instanceButtons.first()).toHaveAccessibleName(/copy/i);

  const advancedButtons = advanced.getByRole('button');
  await expect(advancedButtons).toHaveCount(1);
  await expect(advancedButtons.first()).toHaveAccessibleName('Advanced');

  await expect(advanced.getByText('Set by an environment variable')).toHaveCount(5);
});

// 09-13-PLAN.md Task 2: Appearance flows (SET-04/SET-05, D-09/D-12/D-13/D-14/D-15). Reuses
// tests/e2e/theme-first-paint.spec.ts's own frame-sampler/SSR-HTML technique and
// tests/e2e/a11y-fallbacks.spec.ts's transform-decomposition technique, copied rather than
// imported (each spec file owns its own helpers, matching this directory's existing precedent).

// tokens.css's [data-theme="dark"] --canvas value (#161618) -- the color a real browser resolves
// body's background to once the dark stylesheet rule applies.
const SETTINGS_DARK_CANVAS_RGB = 'rgb(22, 22, 24)';

declare global {
  interface Window {
    /** Populated by installFrameSampler below -- a distinct name from theme-first-paint.spec.ts's
     *  own window global so the two files' init scripts never collide within the same page. */
    __settingsFramePaint?: { readonly frames: string[]; mutations: number };
  }
}

function htmlTagOf(body: string): string {
  const match = /<html[^>]*>/.exec(body);
  if (match === null) {
    throw new Error('no <html> opening tag found in response body');
  }
  return match[0];
}

async function installFrameSampler(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { frames: [] as string[], mutations: 0 };
    window.__settingsFramePaint = state;

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'data-theme') {
          state.mutations += 1;
        }
      }
    });
    observer.observe(document, { attributes: true, attributeFilter: ['data-theme'], subtree: true });

    function sample(): void {
      if (state.frames.length >= 10) return;
      if (document.body !== null) {
        state.frames.push(getComputedStyle(document.body).backgroundColor);
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
}

async function waitForFrameSample(page: Page): Promise<{ frames: string[]; mutations: number }> {
  await expect
    .poll(() => page.evaluate(() => window.__settingsFramePaint?.frames.length ?? 0))
    .toBeGreaterThanOrEqual(10);
  return page.evaluate(() => {
    const state = window.__settingsFramePaint;
    if (state === undefined) {
      throw new Error('frame sampler not installed');
    }
    return { frames: state.frames, mutations: state.mutations };
  });
}

interface TransformMatrix {
  readonly translateX: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

function decomposeTransform(transform: string): TransformMatrix {
  if (transform === 'none') {
    return { translateX: 0, scaleX: 1, scaleY: 1 };
  }
  const match = /matrix\(([^)]+)\)/.exec(transform);
  if (match?.[1] === undefined) {
    throw new Error(`unrecognised computed transform: ${transform}`);
  }
  const parts = match[1].split(',').map((part) => Number(part.trim()));
  const [a, b, c, d, tx] = parts;
  if (a === undefined || b === undefined || c === undefined || d === undefined || tx === undefined) {
    throw new Error(`unrecognised computed transform: ${transform}`);
  }
  return { translateX: tx, scaleX: Math.sqrt(a * a + b * b), scaleY: Math.sqrt(c * c + d * d) };
}

/** Clicks a `SegmentedControl` segment and waits for the real `PATCH /api/account/preferences`
 *  round trip `updateAppearancePreference` issues -- a no-op (already-selected) segment never
 *  fires a change event, so this checks `data-state` first rather than waiting on a response that
 *  would never arrive. Used both to drive the test's own action and to reset every control back to
 *  its default in `finally`, per this task's own behavior bullet. */
async function setSegment(page: Page, testId: string, label: string): Promise<void> {
  const radio = page.getByTestId(testId).getByRole('radio', { name: label });
  const alreadyChecked = (await radio.getAttribute('data-state')) === 'checked';
  if (alreadyChecked) return;

  const patched = page.waitForResponse(
    (response) => response.url().includes('/api/account/preferences') && response.request().method() === 'PATCH',
  );
  await radio.click();
  await patched;
  await expect(radio).toHaveAttribute('data-state', 'checked');
}

async function resetAppearance(page: Page): Promise<void> {
  await page.goto('/settings');
  await setSegment(page, 'settings-theme-control', 'Auto');
  await setSegment(page, 'settings-reduce-motion-control', 'System');
  await setSegment(page, 'settings-density-control', 'Comfortable');
}

test('@settings theme choice persists with no theme flash on reload', async ({ page, context }) => {
  await login(page);
  await page.goto('/settings');

  try {
    await setSegment(page, 'settings-theme-control', 'Dark');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('dark');

    await installFrameSampler(page);
    await page.reload();
    const sample = await waitForFrameSample(page);
    expect(sample.mutations).toBe(0);
    expect(new Set(sample.frames).size).toBe(1);
    expect(sample.frames[0]).toBe(SETTINGS_DARK_CANVAS_RGB);

    const ssrResponse = await context.request.get('/settings');
    expect(htmlTagOf(await ssrResponse.text())).toContain('data-theme="dark"');
  } finally {
    await resetAppearance(page);
  }
});

test('@settings manual theme override wins over the OS', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await page.goto('/settings');

  try {
    await setSegment(page, 'settings-theme-control', 'Light');
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('light');
  } finally {
    await resetAppearance(page);
  }
});

test('@settings theme preference follows the account to a second browser', async ({ page, browser }) => {
  await login(page);
  await page.goto('/settings');

  try {
    await setSegment(page, 'settings-theme-control', 'Dark');

    // A fresh, unauthenticated browser context, with no cookies of its own -- the theme it ends up
    // with can only have come from the account's own stored preference (D-09/D-10), not this
    // context's browser mirror.
    const contextC = await browser.newContext();
    try {
      const pageC = await contextC.newPage();
      await login(pageC);

      await expect
        .poll(() => pageC.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('dark');

      const ssrResponse = await contextC.request.get('/servers');
      expect(htmlTagOf(await ssrResponse.text())).toContain('data-theme="dark"');
    } finally {
      await contextC.close();
    }
  } finally {
    await resetAppearance(page);
  }
});

test('@settings reduce motion On forces the Sheet fallback', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  try {
    await setSegment(page, 'settings-reduce-motion-control', 'On');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-motion')))
      .toBe('reduce');

    await page.goto('/servers');
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page.getByTestId('server-sheet')).toBeVisible();

    const panel = page.getByTestId('server-sheet');
    const panelTransform = await panel.evaluate((el) => getComputedStyle(el).transform);
    expect(decomposeTransform(panelTransform).translateX).toBe(0);

    const dragSurface = page.getByTestId('server-sheet-drag-surface');
    // The drag surface's own entry-settle spring must finish before the gesture starts, or its
    // own tail end could be mistaken for drag movement (a11y-fallbacks.spec.ts's own precedent).
    await expect
      .poll(async () =>
        decomposeTransform(await dragSurface.evaluate((el) => getComputedStyle(el).transform)).translateX,
      )
      .toBe(0);

    const box = await dragSurface.boundingBox();
    if (box === null) {
      throw new Error('server-sheet-drag-surface has no bounding box');
    }
    const startX = box.x + box.width / 2;
    const startY = box.y + 20;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 200, startY, { steps: 10 });
    await page.mouse.up();

    const afterTransform = await dragSurface.evaluate((el) => getComputedStyle(el).transform);
    expect(decomposeTransform(afterTransform).translateX).toBe(0);
  } finally {
    await resetAppearance(page);
  }
});

test('@settings density Compact shrinks rows app-wide', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  try {
    const name = `settings-density-${String(Date.now())}`;
    const created = await page.request.post('/api/servers', {
      data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
    });
    expect(created.status()).toBe(201);

    await page.goto('/servers');
    const row = page.getByTestId('servers-row').filter({ hasText: name }).locator('[data-row="true"]');
    await expect(row).toBeVisible();
    const comfortableBox = await row.boundingBox();
    expect(comfortableBox?.height).toBeCloseTo(44, 0);
    const fontBefore = await row.getByText(name, { exact: true }).evaluate((el) => getComputedStyle(el).fontSize);

    await page.goto('/settings');
    await setSegment(page, 'settings-density-control', 'Compact');

    await page.goto('/servers');
    const rowAfter = page.getByTestId('servers-row').filter({ hasText: name }).locator('[data-row="true"]');
    await expect(rowAfter).toBeVisible();
    const compactBox = await rowAfter.boundingBox();
    expect(compactBox?.height).toBeCloseTo(36, 0);
    const fontAfter = await rowAfter
      .getByText(name, { exact: true })
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(fontAfter).toBe(fontBefore);
  } finally {
    await resetAppearance(page);
  }
});
