// 08-20-PLAN.md Task 3 (UI-05/§9 #10, pitfall P14): the one motion rule that is easiest to
// regress silently -- "ninguna acción iniciada por teclado se anima" -- measured for real, in a
// real browser, across all four overlays this codebase has (Sheet, Dialog, RowMenu, AccountMenu).
// Runs against the same real stack.ts stack every other spec in this directory uses (Postgres,
// Redis, the API, the worker, the built web app), with the preseeded E2E admin.
//
// Measurement technique: wall-clock time from the closing action to the overlay actually leaving
// the accessibility tree, not a class-name assertion (jsdom already covers the class-composition
// contract at the component level -- Dialog.test.tsx/RowMenu.test.tsx/AccountMenu.test.tsx/
// Sheet.test.tsx -- this spec proves the *rendered* result a real browser's CSS engine produces,
// which no jsdom assertion can). A keyboard-initiated close carries the zero-duration override
// (`!duration-0`, packages/ui/src/{Dialog,RowMenu,AccountMenu}.tsx / Sheet.tsx's own
// `INSTANT_CLOSE_CLASS`) and must disappear near-instantly; a pointer-initiated close must not.
//
// Honest scope note (see this plan's own SUMMARY.md "Rules not satisfied"): only `Sheet` (08-12)
// has a real, non-zero exit transition today, so only its pair of tests below is a genuine
// positive/negative control. `Dialog`/`RowMenu`/`AccountMenu` gain their real scale-from-trigger
// exit transition in 08-14 (UI-07) -- which depends on this very plan (08-20) landing first, per
// its own frontmatter -- so as of this plan neither of their close paths animates yet. Their tests
// below measure the current, honest truth (both paths close near-instantly) and exist so that the
// moment 08-14 lands a real transition, the pointer-close assertion needs only its threshold
// raised, never a new mechanism: the `!duration-0` override this plan builds already gates it
// correctly, it has simply had nothing to override yet.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

async function createServer(page: Page, name: string): Promise<void> {
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  // A refused create must fail here, by name -- never later, disguised as a live event that was
  // lost.
  expect(created.status()).toBe(201);
  await page.reload();
}

/** Wall-clock time from `act()` starting to `locator` actually leaving the accessibility tree --
 *  the "assert on the rendered result rather than a class name" technique this task's own
 *  `<action>` names, generalized to a plain timing comparison rather than a transient
 *  `getComputedStyle` sample (which a real close's own synchronous Presence-unmount decision can
 *  race and lose before `page.evaluate` ever gets to read it). */
async function msUntilGone(locator: Locator, act: () => Promise<void>): Promise<number> {
  const start = Date.now();
  await act();
  await expect(locator).toHaveCount(0, { timeout: 5000 });
  return Date.now() - start;
}

// A keyboard-initiated close must be indistinguishable, timing-wise, from a synchronous DOM
// removal -- well under any real CSS transition's duration (the shortest token in this codebase,
// --duration-micro, is 120ms; a generous ceiling well below that catches a real regression
// without being flaky on a loaded CI runner).
const INSTANT_CLOSE_CEILING_MS = 150;

test.describe('@keyboard-no-animation Sheet (UI-06/UI-05, real transition -- genuine positive/negative control)', () => {
  test('@keyboard-no-animation Escape closes the add-server Sheet near-instantly, with no animated frame', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('button', { name: 'Add server' }).click();
    const sheet = page.getByTestId('server-sheet');
    await expect(sheet).toBeVisible();

    const elapsedMs = await msUntilGone(sheet, () => page.keyboard.press('Escape'));

    expect(elapsedMs).toBeLessThan(INSTANT_CLOSE_CEILING_MS);
  });

  test('@keyboard-no-animation clicking the close button plays the real, non-zero exit transition (positive control)', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('button', { name: 'Add server' }).click();
    const sheet = page.getByTestId('server-sheet');
    await expect(sheet).toBeVisible();

    const elapsedMs = await msUntilGone(sheet, () => page.getByRole('button', { name: 'Close' }).click());

    // --duration-sheet is 320ms (packages/ui/tokens.css) -- comfortably above the instant-close
    // ceiling, with headroom for CI scheduling jitter on either side.
    expect(elapsedMs).toBeGreaterThan(INSTANT_CLOSE_CEILING_MS);
  });
});

test.describe('@keyboard-no-animation Dialog (UI-05, pre-08-14: no real transition to gate yet)', () => {
  async function openDeleteDialog(page: Page, name: string): Promise<Locator> {
    const row = page.getByTestId('servers-row').filter({ hasText: name });
    await row.hover();
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByTestId('delete-server-dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('@keyboard-no-animation Escape closes the delete Dialog near-instantly, with no animated frame', async ({
    page,
  }) => {
    await login(page);
    const name = `kbmotion-dialog-esc-${String(Date.now())}`;
    await createServer(page, name);
    const dialog = await openDeleteDialog(page, name);

    const elapsedMs = await msUntilGone(dialog, () => page.keyboard.press('Escape'));

    expect(elapsedMs).toBeLessThan(INSTANT_CLOSE_CEILING_MS);
  });

  test('@keyboard-no-animation clicking Cancel also closes the delete Dialog near-instantly (08-14 adds its real exit transition later)', async ({
    page,
  }) => {
    await login(page);
    const name = `kbmotion-dialog-cancel-${String(Date.now())}`;
    await createServer(page, name);
    const dialog = await openDeleteDialog(page, name);

    const elapsedMs = await msUntilGone(dialog, () => dialog.getByRole('button', { name: 'Cancel' }).click());

    expect(elapsedMs).toBeLessThan(INSTANT_CLOSE_CEILING_MS);
  });
});

test.describe('@keyboard-no-animation RowMenu (UI-05, pre-08-14: no real transition to gate yet)', () => {
  async function openRowMenu(page: Page, name: string): Promise<Locator> {
    const row = page.getByTestId('servers-row').filter({ hasText: name });
    await row.hover();
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    return menu;
  }

  test('@keyboard-no-animation Escape closes RowMenu near-instantly, with no animated frame', async ({ page }) => {
    await login(page);
    const name = `kbmotion-rowmenu-esc-${String(Date.now())}`;
    await createServer(page, name);
    const menu = await openRowMenu(page, name);

    const elapsedMs = await msUntilGone(menu, () => page.keyboard.press('Escape'));

    expect(elapsedMs).toBeLessThan(INSTANT_CLOSE_CEILING_MS);
  });

  test('@keyboard-no-animation an outside pointer click also closes RowMenu near-instantly (08-14 adds its real exit transition later)', async ({
    page,
  }) => {
    await login(page);
    const name = `kbmotion-rowmenu-outside-${String(Date.now())}`;
    await createServer(page, name);
    const menu = await openRowMenu(page, name);

    const elapsedMs = await msUntilGone(menu, () => page.getByRole('heading', { name: 'Servers' }).click());

    expect(elapsedMs).toBeLessThan(INSTANT_CLOSE_CEILING_MS);
  });
});

test.describe('@keyboard-no-animation AccountMenu (UI-05, pre-08-14: no real transition to gate yet)', () => {
  async function openAccountMenu(page: Page): Promise<Locator> {
    await page.getByTestId('shell-account-menu-trigger').click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    return menu;
  }

  test('@keyboard-no-animation Escape closes AccountMenu near-instantly, with no animated frame', async ({ page }) => {
    await login(page);
    const menu = await openAccountMenu(page);

    const elapsedMs = await msUntilGone(menu, () => page.keyboard.press('Escape'));

    expect(elapsedMs).toBeLessThan(INSTANT_CLOSE_CEILING_MS);
  });

  test('@keyboard-no-animation an outside pointer click also closes AccountMenu near-instantly (08-14 adds its real exit transition later)', async ({
    page,
  }) => {
    await login(page);
    const menu = await openAccountMenu(page);

    const elapsedMs = await msUntilGone(menu, () => page.getByRole('heading', { name: 'Servers' }).click());

    expect(elapsedMs).toBeLessThan(INSTANT_CLOSE_CEILING_MS);
  });
});
