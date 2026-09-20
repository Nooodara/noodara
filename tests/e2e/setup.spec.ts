// 05-30-PLAN.md Task 2/3: the setup-token URL hardening todo
// (.planning/todos/pending/2026-09-19-setup-token-url-hardening.md) plus the three-way failure
// distinction gap (05-VERIFICATION.md's UI-02 truth) -- both land on the same screen so they share
// this spec. Runs against the same real stack.ts stack auth.spec.ts/smoke.spec.ts use (Postgres,
// Redis, the API, the worker, the built web app), with a preseeded E2E admin -- which is exactly
// what makes every real (non-stubbed) `POST /api/setup` here hit the `adminExists()` 404 gate, the
// same door-closing NOT_FOUND path auth.spec.ts already exercises. The failure-type-distinguishing
// cases below therefore stub the route directly rather than relying on the real backend, since this
// harness has no reachable "genuinely fresh, no-admin-yet" stack to produce a real TOKEN_INVALID/
// EXPIRED/ALREADY_USED response.
//
// The token values used anywhere in this file are obviously-synthetic fixture strings, never a
// real credential -- and are never written to a log, a `data-*` attribute or an assertion message
// (T-5G-30-05).
import { expect, test } from '@playwright/test';

test('@setup every response carries Referrer-Policy: no-referrer (setup-token-url-hardening todo item 2)', async ({
  page,
}) => {
  const response = await page.goto('/setup');
  expect(response).not.toBeNull();
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
});

const SYNTHETIC_TOKEN = 'e2e-fixture-setup-token-not-a-real-secret';
const INVALID_TOKEN_MESSAGE = 'This setup link is no longer valid. Ask whoever installed Noodara for a new one.';
const GENERIC_INTERNAL_ERROR_MESSAGE =
  'Something went wrong on our end. Try again, and check the server logs if it continues.';
const NETWORK_UNREACHABLE_MESSAGE = 'Could not reach the server. Check your connection and try again.';

test('@setup /setup?token=... strips the token from the URL after mount while the field stays pre-filled', async ({
  page,
}) => {
  await page.goto(`/setup?token=${SYNTHETIC_TOKEN}`);

  await expect(page.getByLabel('Token')).toHaveValue(SYNTHETIC_TOKEN);
  await expect.poll(() => page.url()).not.toContain('token=');

  // The stripped URL must not blank the field on a later re-render (a failed submit re-renders
  // this same component) -- submit once and confirm the value survives.
  await page.getByLabel('Email').fill('someone@noodara.test');
  await page.getByLabel('Password').fill('irrelevant-password-value-12');
  await page.getByRole('button', { name: 'Create admin account' }).click();
  await expect(page.getByTestId('setup-banner')).toBeVisible();
  await expect(page.getByLabel('Token')).toHaveValue(SYNTHETIC_TOKEN);
  await expect.poll(() => page.url()).not.toContain('token=');
});

test('@setup a stubbed 500 from POST /api/setup never renders the invalid-link banner', async ({ page }) => {
  await page.route('**/api/setup', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Internal error' }) }),
  );

  await page.goto(`/setup?token=${SYNTHETIC_TOKEN}`);
  await page.getByLabel('Email').fill('someone@noodara.test');
  await page.getByLabel('Password').fill('irrelevant-password-value-12');
  await page.getByRole('button', { name: 'Create admin account' }).click();

  const banner = page.getByTestId('setup-banner');
  await expect(banner).toBeVisible();
  await expect(banner).not.toHaveText(INVALID_TOKEN_MESSAGE);
  await expect(banner).toHaveText(GENERIC_INTERNAL_ERROR_MESSAGE);
});

test('@setup a network failure on POST /api/setup renders the reachability message, never the invalid-link banner', async ({
  page,
}) => {
  await page.route('**/api/setup', (route) => route.abort('failed'));

  await page.goto(`/setup?token=${SYNTHETIC_TOKEN}`);
  await page.getByLabel('Email').fill('someone@noodara.test');
  await page.getByLabel('Password').fill('irrelevant-password-value-12');
  await page.getByRole('button', { name: 'Create admin account' }).click();

  const banner = page.getByTestId('setup-banner');
  await expect(banner).toBeVisible();
  await expect(banner).not.toHaveText(INVALID_TOKEN_MESSAGE);
  await expect(banner).toHaveText(NETWORK_UNREACHABLE_MESSAGE);
});

test('@setup a VALIDATION_FAILED body with a mappable issue renders an inline field error, not a banner', async ({
  page,
}) => {
  await page.route('**/api/setup', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'VALIDATION_FAILED',
        message: 'Request does not match the schema',
        issues: [{ path: '/email', message: 'Enter a valid email address.' }],
      }),
    }),
  );

  await page.goto(`/setup?token=${SYNTHETIC_TOKEN}`);
  await page.getByLabel('Email').fill('someone@noodara.test');
  await page.getByLabel('Password').fill('irrelevant-password-value-12');
  await page.getByRole('button', { name: 'Create admin account' }).click();

  await expect(page.getByTestId('setup-banner')).toHaveCount(0);
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
});
