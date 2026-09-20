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

// 05-29-PLAN.md Task 3: closes the 05-28 handover above. servers/[id]/page.tsx's
// shouldShowFirstTrustNotice/dismissFirstTrustNotice call sites now go through safeLocalStorage()
// (T-5G-29-05), so a blocked/throwing localStorage accessor degrades to "show the notice" instead
// of throwing synchronously during render.
test('@dod-hardening the server detail screen still renders its facts when localStorage access throws', async ({
  page,
}) => {
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

  const name = `storage-blocked-${String(Date.now())}`;
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  await page.goto(`/servers/${id}`);

  await expect(page.getByText('Not discovered yet.')).toBeVisible();
  await expect(page.getByTestId('server-detail-primary-action')).toHaveText('Connect');
  expect(pageErrors).toEqual([]);
});
