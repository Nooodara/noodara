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

test('@settings the screen has zero form controls anywhere in the main region', async ({ page }) => {
  await login(page);
  await page.goto('/settings');

  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Advanced' }).click();

  // Queried by role, not by tag name -- a custom component that merely behaves like an input
  // would still be caught (SET-01's read-only rule, T-5-70).
  for (const role of ['textbox', 'combobox', 'spinbutton', 'checkbox', 'switch'] as const) {
    await expect(main.getByRole(role)).toHaveCount(0);
  }
  await expect(main.getByRole('button', { name: /save|apply|edit/i })).toHaveCount(0);
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

  await expect(page.locator('[data-height="44"]').first()).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0);
});
