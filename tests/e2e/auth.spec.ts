// 05-11: E2E coverage for the two unauthenticated screens -- setup and login -- proving their
// empty/error states and that neither screen renders inside the authenticated shell or reveals
// whether an account/token exists (T-5-45/T-5-46). Runs against the same real stack.ts stack
// smoke.spec.ts uses (Postgres, Redis, the API, the worker, the built web app), with a preseeded
// admin (E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD) already present -- which is exactly what makes
// `/setup` a redeemable-token-vs-"an admin already exists" test double for free: this stack's own
// admin was preseeded via env vars (not a redeemed setup token), so `POST /api/setup` always hits
// the `adminExists()` 404 gate here, the same opaque path a stale/reused token would hit.
import { expect, test } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const SETUP_INVALID_MESSAGE = 'This setup link is no longer valid. Ask whoever installed Noodara for a new one.';
const LOGIN_INVALID_CREDENTIALS_MESSAGE = "That email or password isn't right.";

test('@auth /setup with no token renders an empty token field; /setup?token=... pre-fills it', async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByLabel('Token')).toHaveValue('');

  await page.goto('/setup?token=a-sample-setup-token');
  await expect(page.getByLabel('Token')).toHaveValue('a-sample-setup-token');
});

test('@auth submitting /setup on a stack that already has an admin renders the single opaque banner', async ({
  page,
}) => {
  await page.goto('/setup?token=whatever-token-value');
  await page.getByLabel('Email').fill('someone-else@noodara.test');
  await page.getByLabel('Password').fill('irrelevant-password-value');
  await page.getByRole('button', { name: 'Create admin account' }).click();

  await expect(page.getByTestId('setup-banner')).toHaveText(SETUP_INVALID_MESSAGE);
});

test('@auth a wrong password renders the exact invalid-credentials copy and never echoes the submitted email', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill('definitely-the-wrong-password');
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('login-banner')).toHaveText(LOGIN_INVALID_CREDENTIALS_MESSAGE);

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(E2E_ADMIN_EMAIL);
  expect(bodyText.toLowerCase()).not.toContain('no account');
});

test('@auth an invalid email on the login form renders an inline field error, not a banner', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('login-banner')).toHaveCount(0);
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
});

test("@auth both screens render without the authenticated shell's navigation landmark", async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByRole('navigation')).toHaveCount(0);

  await page.goto('/login');
  await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('@auth both screens render correctly in light and dark themes', async ({ page }) => {
  await page.goto('/login');

  const backgroundFor = (theme: 'light' | 'dark') =>
    page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
      return getComputedStyle(document.body).backgroundColor;
    }, theme);

  const loginLightBackground = await backgroundFor('light');
  const loginDarkBackground = await backgroundFor('dark');
  expect(loginLightBackground).not.toBe(loginDarkBackground);

  await page.goto('/setup');
  const setupLightBackground = await backgroundFor('light');
  const setupDarkBackground = await backgroundFor('dark');
  expect(setupLightBackground).not.toBe(setupDarkBackground);
});
