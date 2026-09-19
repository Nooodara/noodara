// QA-04: the first real Playwright spec, proving `pnpm test:e2e` drives an actually-booted stack
// (tests/e2e/fixtures/stack.ts) rather than the `echo ... && exit 0` placeholder it replaces.
//
// GREEN: the first two behaviours are in this plan's own scope (apps/web/src/middleware.ts's
// minimal redirect + the control plane's pre-existing 401 guard) and pass for real. The three
// login-dependent behaviours are written against the login screen and servers screen Plans
// 05-11/05-12 build — `test.fixme` here, per this plan's own instruction; 05-11's first task
// removes these markers. See 05-10-SUMMARY.md for the RED observation this spec's first commit
// recorded before the redirect existed.
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

test.fixme(
  '@smoke the login form exposes accessible Email/Password fields and a login-submit control',
  async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeVisible();
  },
);

test.fixme('@smoke signing in with the preseeded admin ends on /servers', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
});

test.fixme('@smoke a wrong password never reveals whether the account exists', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill('definitely-the-wrong-password');
  await page.getByTestId('login-submit').click();

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain(E2E_ADMIN_EMAIL);
  expect(bodyText.toLowerCase()).not.toContain('no account');
});
