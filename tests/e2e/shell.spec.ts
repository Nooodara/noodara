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
    return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? null;
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
