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

// 09-10-PLAN.md Task 3 (D-07): the tab a heartbeat's own reason-aware redirect (require-session.ts)
// sends here after a password change, per 09-UI-SPEC.md SS4.1/SS6.1's `login-password-changed-notice`
// testid.
test('@auth /login?reason=password-changed shows the password-changed Notice with role status', async ({
  page,
}) => {
  await page.goto('/login?reason=password-changed');

  const notice = page.getByTestId('login-password-changed-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText('Signed out because your password changed.');
  await expect(notice).toHaveAttribute('role', 'status');
});

test('@auth /login without the reason param shows no password-changed Notice; ?setup=success is unaffected', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByTestId('login-password-changed-notice')).toHaveCount(0);

  await page.goto('/login?setup=success');
  await expect(page.getByTestId('login-password-changed-notice')).toHaveCount(0);
  await expect(page.getByTestId('login-setup-notice')).toBeVisible();
});

// deferred-items.md "Login fails silently when the request origin is rejected" -- this is the fix
// this plan's Task 3 ships: any non-2xx/non-401/non-429 sign-in failure always renders the banner
// with the fixed generic copy, never the raw server text and never nothing at all.
test('@auth a 403 INVALID_ORIGIN sign-in failure renders the generic banner, never the raw server text', async ({
  page,
}) => {
  await page.route('**/api/auth/sign-in/email', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'INVALID_ORIGIN', message: 'Invalid origin' }),
    }),
  );

  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('login-banner')).toHaveText('Something went wrong. Try again.');
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('Invalid origin');
});

test('@auth a 500 with a non-JSON body also renders the generic banner', async ({ page }) => {
  await page.route('**/api/auth/sign-in/email', (route) =>
    route.fulfill({ status: 500, contentType: 'text/html', body: '<html>500 Internal Server Error</html>' }),
  );

  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('login-banner')).toHaveText('Something went wrong. Try again.');
});

test('@auth wrong credentials (401) and lockout (429) still show their own dedicated copy, not the generic fallback', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill('definitely-the-wrong-password');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-banner')).toHaveText(LOGIN_INVALID_CREDENTIALS_MESSAGE);

  await page.route('**/api/auth/sign-in/email', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'Retry-After': '30' },
      body: JSON.stringify({ error: 'REAUTH_LOCKED', message: 'Too many attempts' }),
    }),
  );
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-banner')).toHaveText('Too many attempts. Try again in 30 seconds.');
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
