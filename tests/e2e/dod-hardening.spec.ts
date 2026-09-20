// 05-28-PLAN.md Task 3 (VERIFICATION gap 4, T-5G-28-02): the two environment conditions Noodara's
// own explicitly supported v0.1 deployment mode can hit in a real browser -- an insecure-context
// clipboard and blocked storage -- verified against the real stack, never a route-intercepted
// stand-in (both conditions are simulated purely client-side via `page.addInitScript`, before any
// app code runs, exactly like a genuine plain-HTTP origin or a locked-down storage profile would
// present itself).
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

test('@dod-hardening clicking a copy button with navigator.clipboard removed leaves the page functional and shows no confirmation', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // Runs before any app script on every navigation this test makes -- reproduces a plain-HTTP
  // (insecure-context) origin, where the real browser itself never defines `navigator.clipboard`.
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
  });

  await login(page);
  await page.goto('/settings');

  const copyButton = page.getByRole('button', { name: 'Copy Public URL' });
  await expect(copyButton).toBeVisible();

  await copyButton.click();

  // No "Copied" confirmation -- CopyButton.tsx's feature-detection returns before ever writing.
  await expect(page.getByText('Copied')).not.toBeVisible();
  // The rest of the screen is still there and interactive -- a synchronous TypeError inside
  // handleClick would have unmounted nothing here (React doesn't unmount on an event-handler
  // throw), but it would still have reached `pageerror`.
  await expect(page.getByTestId('settings-row-public-url')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

// Deliberately fixme: apps/web/src/app/(shell)/servers/[id]/page.tsx's own `window.localStorage`
// call site (shouldShowFirstTrustNotice) is NOT changed by 05-28-PLAN.md -- Task 3's own action
// section names plan 05-29 as the owner of that call-site swap to safeLocalStorage. This case
// documents the intended behaviour and handover; un-fixme-ing it is an explicit acceptance
// criterion of 05-29, not something to delete here.
test.fixme(
  '@dod-hardening the server detail screen still renders its facts when localStorage access throws (handover: 05-29)',
  async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });

    await login(page);
    // Left unimplemented until 05-29 wires safeLocalStorage into the detail page's call site --
    // today this would throw synchronously during render (D-02's shouldShowFirstTrustNotice
    // dereferencing window.localStorage directly), which is exactly the gap 05-29 closes.
    expect(pageErrors).toEqual([]);
  },
);
