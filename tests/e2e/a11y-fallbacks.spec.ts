// 08-06-PLAN.md Task 3 (UI-10, 08-UI-SPEC.md SS10): the reduced-motion alternative for Sheet,
// Dialog and RowMenu, proven in a real browser via `page.emulateMedia({ reducedMotion: 'reduce'
// })` -- jsdom cannot resolve `@media (prefers-reduced-motion: reduce)` at all, so this is the
// only honest way to prove the fallback actually renders instead of just being present as an
// unused class string. Runs against the same real stack.ts stack every other spec in this
// directory uses (Postgres, Redis, the API, the worker, the built web app), with the preseeded
// E2E admin.
//
// Deviation (Rule 1 -- a plan-stated assumption corrected by real execution, same category as
// 08-03-SUMMARY.md's backdrop-filter worst-case correction): a frame-by-frame sampling spike
// (kept out of the final file, see 08-06-SUMMARY.md) proved the Sheet's real DOM lifecycle never
// exposes a mid-flight, non-identity `transform` at all today, in either direction -- Radix mounts
// `DialogPrimitive.Content` already at `data-state="open"`/`translate-x-0` on first paint (no
// earlier "closed" value on screen to transition away from), and on close it unmounts the node
// synchronously (confirmed by `CredentialFields.tsx`'s own header comment: "the parent
// ServerSheet's Sheet unmounts this block's whole subtree on close") rather than keeping it
// mounted via Radix's `Presence` for the transition's own duration. Wiring that up is a real,
// separate piece of work -- exactly the "scale-from-trigger origin" / duration-table motion
// contract this task's own Action text names as 08-14's scope, not this one's. The honest,
// deterministic proof available today is therefore the CSS mechanism itself (`transitionProperty`)
// rather than a live animation frame: under reduced motion the transform-based transition is
// entirely absent (replaced by an opacity-only one); without emulation, the transform-based
// transition genuinely IS declared (so the reduced-motion test isn't just describing an
// always-inert component) -- the "positive control" the plan calls for is satisfied by proving the
// standard path uses a real, distinct mechanism, not by catching it mid-flight.
//
// 14-26: that no longer holds for the Sheet's exit. It is now a keyframe animation that Presence
// keeps the panel mounted for, so the Sheet tests below observe the real exit frame by frame.
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

// The shell's session store (apps/web/src/lib/session-user.ts `ensureLoaded`) loads the account
// preferences after login and, when no `noodara-prefs` mirror existed before that request, calls
// `applyPreferences(server)`, which rewrites `<html data-motion>`. A forced attribute set before
// that response lands is silently removed -- the race behind the reduced-motion flake (13-07).
// `applyPreferences` runs synchronously before the store emits, and the emit is what fills the
// account menu trigger with the user's name, so a non-empty trigger means the write already happened.
async function forceMotion(page: Page, value: 'reduce' | 'allow'): Promise<void> {
  await expect(page.getByTestId('shell-account-menu-trigger')).toHaveText(/\S/);
  await page.evaluate((motion) => {
    document.documentElement.setAttribute('data-motion', motion);
  }, value);
}

interface Matrix {
  readonly translateX: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/** Decomposes a CSS `matrix(a, b, c, d, tx, ty)` (or the literal `none`) computed transform into
 *  the two components every assertion below actually needs: horizontal translation and scale. */
function decomposeTransform(transform: string): Matrix {
  if (transform === 'none') {
    return { translateX: 0, scaleX: 1, scaleY: 1 };
  }
  const match = /matrix\(([^)]+)\)/.exec(transform);
  if (match?.[1] === undefined) {
    throw new Error(`unrecognised computed transform: ${transform}`);
  }
  const parts = match[1].split(',').map((part) => Number(part.trim()));
  const [a, b, c, d, tx] = parts;
  if (a === undefined || b === undefined || c === undefined || d === undefined || tx === undefined) {
    throw new Error(`unrecognised computed transform: ${transform}`);
  }
  return {
    translateX: tx,
    scaleX: Math.sqrt(a * a + b * b),
    scaleY: Math.sqrt(c * c + d * d),
  };
}

interface ExitSamples {
  readonly animations: readonly string[];
  readonly translateXs: readonly number[];
}

/** 14-26: closes the add-server Sheet with its Close button and samples the panel on every frame
 *  until it leaves the DOM: the CSS animations it ran and its computed transforms. Presence keeps
 *  the panel mounted while its exit animation runs, so at least one frame sees it. The sampler
 *  starts before the click (CDP messages run in order). */
async function closeSheetAndSampleExit(page: Page): Promise<ExitSamples> {
  const panel = page.getByTestId('server-sheet');
  const handle = await panel.elementHandle();
  const sampling = handle.evaluate(
    (el) =>
      new Promise<{ animations: string[]; transforms: string[] }>((resolve) => {
        const animations = new Set<string>();
        const transforms: string[] = [];
        const tick = (): void => {
          if (!el.isConnected) {
            resolve({ animations: [...animations], transforms });
            return;
          }
          for (const animation of el.getAnimations()) {
            if (animation instanceof CSSAnimation) animations.add(animation.animationName);
          }
          transforms.push(getComputedStyle(el).transform);
          requestAnimationFrame(tick);
        };
        tick();
      }),
  );
  await panel.getByRole('button', { name: 'Close' }).click();
  const { animations, transforms } = await sampling;
  return { animations, translateXs: transforms.map((t) => decomposeTransform(t).translateX) };
}

async function seedServer(page: Page, name: string): Promise<void> {
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  // A refused create must fail here, by name -- never later, disguised as a live event that was
  // lost.
  expect(created.status()).toBe(201);
}

test('@a11y-fallbacks with reduced motion emulated, the add-server Sheet opens and closes with no horizontal translation, via an opacity-only exit', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page);

  await page.getByRole('button', { name: 'Add server' }).click();
  await expect(page.getByTestId('server-sheet')).toBeVisible();

  const panel = page.getByTestId('server-sheet');
  const transform = await panel.evaluate((el) => getComputedStyle(el).transform);
  expect(decomposeTransform(transform).translateX).toBe(0);

  // The exit itself: the opacity fade runs, the slide never does, and no frame translates.
  const exit = await closeSheetAndSampleExit(page);
  expect(exit.animations).toEqual(['sheet-fade-exit']);
  expect(exit.translateXs.every((x) => x === 0)).toBe(true);
});

test('@a11y-fallbacks with reduced motion emulated, the delete Dialog opens with no scale -- its computed transform is the centering translate only', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page);

  const name = `a11y-dialog-${String(Date.now())}`;
  await seedServer(page, name);
  await page.reload();

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await row.hover();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByTestId('delete-server-dialog')).toBeVisible();

  const transform = await page
    .getByTestId('delete-server-dialog')
    .evaluate((el) => getComputedStyle(el).transform);
  const { scaleX, scaleY } = decomposeTransform(transform);
  expect(scaleX).toBe(1);
  expect(scaleY).toBe(1);
});

test('@a11y-fallbacks with reduced motion emulated, the RowMenu opens with no scale', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page);

  const name = `a11y-rowmenu-${String(Date.now())}`;
  await seedServer(page, name);
  await page.reload();

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await row.hover();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  const transform = await menu.evaluate((el) => getComputedStyle(el).transform);
  const { scaleX, scaleY } = decomposeTransform(transform);
  expect(scaleX).toBe(1);
  expect(scaleY).toBe(1);
});

// The positive control (08-06-PLAN.md Task 3's own "so the test cannot pass by the animation
// being broken outright"): without any emulation, closing the Sheet really runs its slide-out
// (14-26: a keyframe animation Presence waits for, observed live, not a declared transition that
// never played) -- so the reduced-motion tests are measuring a real alternative.
test('@a11y-fallbacks without emulation, closing the Sheet runs its slide-out animation (the positive control)', async ({
  page,
}) => {
  await login(page);

  await page.getByRole('button', { name: 'Add server' }).click();
  await expect(page.getByTestId('server-sheet')).toBeVisible();

  const exit = await closeSheetAndSampleExit(page);
  expect(exit.animations).toEqual(['sheet-exit']);
});

// D-13 (09-04-PLAN.md Task 1): a forced `data-motion="reduce"` on `<html>` must drive the exact
// same fallback as the OS `prefers-reduced-motion: reduce` media query above -- no OS emulation at
// all here, only the attribute the Settings preference control (09-12) will eventually write.
test('@a11y-fallbacks forced reduce motion preference: Sheet opens and closes opacity-only without OS emulation', async ({
  page,
}) => {
  await login(page);
  await forceMotion(page, 'reduce');

  await page.getByRole('button', { name: 'Add server' }).click();
  await expect(page.getByTestId('server-sheet')).toBeVisible();

  const panel = page.getByTestId('server-sheet');
  const transform = await panel.evaluate((el) => getComputedStyle(el).transform);
  expect(decomposeTransform(transform).translateX).toBe(0);

  const exit = await closeSheetAndSampleExit(page);
  expect(exit.animations).toEqual(['sheet-fade-exit']);
  expect(exit.translateXs.every((x) => x === 0)).toBe(true);
});

test('@a11y-fallbacks forced reduce motion preference: Dialog opens without scale', async ({ page }) => {
  await login(page);
  await forceMotion(page, 'reduce');

  const name = `a11y-dialog-forced-${String(Date.now())}`;
  await seedServer(page, name);
  await page.reload();
  await forceMotion(page, 'reduce');

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await row.hover();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByTestId('delete-server-dialog')).toBeVisible();

  const transform = await page
    .getByTestId('delete-server-dialog')
    .evaluate((el) => getComputedStyle(el).transform);
  const { scaleX, scaleY } = decomposeTransform(transform);
  expect(scaleX).toBe(1);
  expect(scaleY).toBe(1);
});

// The positive control for the override direction itself: OS reduce is emulated, but the forced
// `data-motion="allow"` attribute must win, restoring the real slide-out. (14-26: observed as the
// live exit animation; the panel no longer declares a transition, which Presence never waited for.)
test('@a11y-fallbacks allow motion preference overrides OS reduce: closing the Sheet runs its slide-out animation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page);
  await forceMotion(page, 'allow');

  await page.getByRole('button', { name: 'Add server' }).click();
  await expect(page.getByTestId('server-sheet')).toBeVisible();

  const exit = await closeSheetAndSampleExit(page);
  expect(exit.animations).toEqual(['sheet-exit']);
});

// D-13 (09-04-PLAN.md Task 2): the Sheet's JS gesture check (not just the CSS fallback) must
// respect a forced preference -- no OS emulation here, only the attribute.
test('@a11y-fallbacks forced reduce motion preference: Sheet drag surface does not move', async ({ page }) => {
  await login(page);
  await forceMotion(page, 'reduce');

  await page.getByRole('button', { name: 'Add server' }).click();
  await expect(page.getByTestId('server-sheet')).toBeVisible();

  const dragSurface = page.getByTestId('server-sheet-drag-surface');

  // The drag surface's own entry-settle spring (Sheet.tsx's `ENTRY_SETTLE_OFFSET_PX` effect,
  // unrelated to reduced motion -- it runs on every open) must finish before the gesture starts,
  // or its own tail end could be mistaken for drag movement.
  await expect
    .poll(async () => decomposeTransform(await dragSurface.evaluate((el) => getComputedStyle(el).transform)).translateX)
    .toBe(0);

  const box = await dragSurface.boundingBox();
  if (box === null) {
    throw new Error('server-sheet-drag-surface has no bounding box');
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + 20;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 200, startY, { steps: 10 });
  await page.mouse.up();

  const transform = await dragSurface.evaluate((el) => getComputedStyle(el).transform);
  expect(decomposeTransform(transform).translateX).toBe(0);
});
