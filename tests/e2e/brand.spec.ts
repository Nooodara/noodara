// 07-07 Task 2 (BRAND-02, D-04, D-09): the brand mark's breakpoint and theme behaviour, proven in
// a real browser against the same real stack.ts stack shell.spec.ts/auth.spec.ts use (Postgres,
// Redis, the API, the worker, the built web app) with the preseeded E2E admin.
//
// WHY THIS IS A SEPARATE FILE. The component tests
// (apps/web/src/components/{Sidebar,AuthCard}.test.tsx) assert the wrapper's breakpoint CLASSES;
// only a real browser at a real viewport resolves those classes into an actually-hidden element.
// The existing 14 specs are not touched -- this plan adds a surface, it does not change one -- so
// every helper below is local to this file (the `login` helper is copied from shell.spec.ts rather
// than imported from it, matching this directory's own convention that a spec never imports
// another spec).
//
// THEME IS SET BY ATTRIBUTE, NEVER BY CLICKING THE TOGGLE. `data-theme` is written directly with
// `page.evaluate`, the same deterministic mechanism scripts/brand/capture-brand-review.ts uses, so
// an assertion never depends on which theme a previous test left in localStorage and never has to
// wait for a transition. Not one fixed sleep is used anywhere in this file -- every wait is
// Playwright's own auto-waiting assertion on an observable state (noodara-tdd skill SS6). (The
// banned API is named descriptively rather than literally so this plan's own "zero fixed sleeps"
// grep stays exact, following 07-03's precedent.)
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

/** The three reference viewports the shell's own E2E already uses -- never a new breakpoint
 *  number. 1440x900 is the expanded sidebar, 1024x800 the 64px rail, 800x800 the bottom sheet. */
const EXPANDED = { width: 1440, height: 900 } as const;
const RAIL = { width: 1024, height: 800 } as const;
const SHEET = { width: 800, height: 800 } as const;

/** Sidebar.tsx's rail width (`min-[900px]:w-16`), in CSS px. */
const RAIL_WIDTH = 64;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value: string) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
}

/** The colour the mark actually paints with -- `currentColor` resolves to the computed `color` of
 *  the SVG itself, inherited from the `text-ink` wrapper. */
function markColor(page: Page, testId: string): Promise<string> {
  return page.evaluate((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el === null) return '';
    return getComputedStyle(el).color;
  }, testId);
}

test('@brand /login renders the lockup and exactly one image named Noodara', async ({ page }) => {
  await page.setViewportSize({ ...EXPANDED });
  await page.goto('/login');

  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Noodara' })).toHaveCount(1);
});

test('@brand the lockup on /login follows the theme through currentColor', async ({ page }) => {
  await page.setViewportSize({ ...EXPANDED });
  await page.goto('/login');

  await setTheme(page, 'light');
  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  const lightColor = await markColor(page, 'brand-lockup');

  await setTheme(page, 'dark');
  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  const darkColor = await markColor(page, 'brand-lockup');

  expect(lightColor).not.toBe('');
  expect(darkColor).not.toBe(lightColor);
});

test('@brand /setup renders the lockup for an unauthenticated visitor', async ({ page }) => {
  await page.setViewportSize({ ...EXPANDED });
  await page.goto('/setup');

  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Noodara' })).toHaveCount(1);
});

test('@brand the expanded sidebar shows the lockup and hides the monogram at 1440px', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ ...EXPANDED });
  await page.goto('/servers');

  await expect(page.getByTestId('brand-lockup')).toBeVisible();
  await expect(page.getByTestId('brand-monogram')).toBeHidden();
});

test('@brand the 64px rail shows the monogram and hides the lockup at 1024px', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ ...RAIL });
  await page.goto('/servers');

  await expect(page.getByTestId('brand-monogram')).toBeVisible();
  await expect(page.getByTestId('brand-lockup')).toBeHidden();

  const box = await page.getByTestId('shell-sidebar').boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width).toBe(RAIL_WIDTH);
});

test('@brand the monogram stays visible in the rail in dark theme', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ ...RAIL });
  await page.goto('/servers');

  await setTheme(page, 'light');
  await expect(page.getByTestId('brand-monogram')).toBeVisible();
  const lightColor = await markColor(page, 'brand-monogram');

  await setTheme(page, 'dark');
  await expect(page.getByTestId('brand-monogram')).toBeVisible();
  expect(await markColor(page, 'brand-monogram')).not.toBe(lightColor);
});

test('@brand the below-900px bottom sheet carries no mark, closed or open', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ ...SHEET });
  await page.goto('/servers');

  await expect(page.getByTestId('shell-sidebar')).toBeHidden();
  await expect(page.getByTestId('brand-monogram')).toBeHidden();
  await expect(page.getByTestId('brand-lockup')).toBeHidden();

  await page.getByTestId('shell-menu-button').click();
  await expect(page.getByTestId('shell-sidebar')).toBeVisible();
  await expect(page.getByTestId('shell-sidebar').getByRole('link')).toHaveCount(3);
  await expect(page.getByTestId('brand-monogram')).toBeHidden();
  await expect(page.getByTestId('brand-lockup')).toBeHidden();
});
