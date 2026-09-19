// QA-04: the first real Playwright spec, proving `pnpm test:e2e` drives an actually-booted stack
// (tests/e2e/fixtures/stack.ts) rather than the `echo ... && exit 0` placeholder it replaces.
//
// RED (this commit): all five behaviours are written as real assertions against screens
// Plans 05-11/05-12 build — the three login-dependent ones fail because no /login page exists
// yet. See 05-10-SUMMARY.md for the recorded RED observation.
import { expect, test } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

test('@smoke an unauthenticated visit to /servers ends on /login', async ({ page }) => {
  await page.goto('/servers');
  await expect(page).toHaveURL(/\/login$/);
});

test('@smoke an unauthenticated GET /api/servers returns 401', async ({ page }) => {
  const response = await page.request.get('/api/servers');
  expect(response.status()).toBe(401);
});

test('@smoke the login form exposes accessible Email/Password fields and a login-submit control', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByTestId('login-submit')).toBeVisible();
});

test('@smoke signing in with the preseeded admin ends on /servers', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
});

test('@smoke a wrong password never reveals whether the account exists', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill('definitely-the-wrong-password');
  await page.getByTestId('login-submit').click();

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(E2E_ADMIN_EMAIL);
  expect(bodyText.toLowerCase()).not.toContain('no account');
});
