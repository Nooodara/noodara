// Captures the full D-12 review matrix against the REAL Noodara app (08-01-PLAN.md Task 2,
// UI-12).
//
// WHY THIS EXISTS. D-12/D-13 require a baseline — every redesigned screen plus the overlay
// surfaces, in both themes, at four widths, against real fixture data — captured BEFORE a single
// line of CSS changes, so the human gates (G1/G2/G3) review something concrete rather than a
// description. This script produces that baseline (and every later re-capture) from one command.
// It mirrors `scripts/brand/capture-brand-review.ts`'s shape (07-04, the direct precedent named by
// 08-RESEARCH.md Pattern 7) almost verbatim: same attach-mode/real-stack split, same deterministic
// `setTheme`, same `writeIfChanged`-ledgered screenshot writes.
//
// REAL FIXTURE DATA, NEVER A STUB. Per D-12 the four fixture states are: a server connected
// against a real sshd Testcontainer with a completed discovery run, a server left in a genuine
// error state (real SSH auth rejected by the same real sshd container — never a stubbed status),
// a list entry with an 80-character name, and the servers list with no entries at all. The three
// servers are created through the app's own HTTP API (`page.request`), the same way
// `tests/e2e/servers-list.spec.ts`/`server-detail.spec.ts` seed their own fixtures — never a
// second, parallel creation path.
//
// CREDENTIALS ARE NEVER LOGGED, NEVER TYPED ON A CAPTURED SCREEN (T-08-02). `/setup` and `/login`
// are captured first, on a brand-new browser context, with every field still empty; sign-in
// happens afterward and its values come straight from the stack fixture object into Playwright's
// `fill`, never into a string this script builds, prints or writes. The one deliberately-wrong
// password used to produce the error-state server is an obviously-fake, hardcoded-wrong literal
// (never a real secret and never capable of succeeding), matching
// `tests/e2e/server-sheet.spec.ts`'s own `FAKE_PASSWORD` precedent.
//
// AN 80-CHARACTER NAME MAY NOT BE ACCEPTABLE. `packages/domain`'s `SERVER_NAME_PATTERN`
// (`validators/identity.ts`) caps a server name at 63 characters — a constraint that predates
// this phase and is out of this plan's scope to change. This script attempts the literal
// 80-character name D-12 names first; if the real API rejects it, it falls back to the longest
// name the validator actually accepts (63 chars) and logs why. See 08-01-SUMMARY.md for the
// resulting deviation record.

import { chromium, type Browser, type Page } from '@playwright/test';
import { changedFiles, writeIfChanged } from '../brand/write-if-changed.js';
import { alternateHostForSameEndpoint } from './fixture-host.js';
import { OVERLAYS, reviewPngPath, SCREENS, THEMES, WIDTHS, type Theme, type Width } from './review-paths.js';

/** Full-page screenshots ignore viewport height once `fullPage: true` is set, but a real height
 *  still matters for what `setViewportSize` itself renders before that flag kicks in (e.g. any
 *  `100vh` layout) — one representative height per D-12 width, never invented per-screen. */
const VIEWPORT_HEIGHT: Record<Width, number> = { 375: 812, 900: 900, 1280: 900, 1920: 1080 };

/** SSH user matching the sshd Testcontainers fixture's own non-root, no-sudo, no-docker-group
 *  account (`tests/integration/images/sshd-common/setup-users.sh`) — the same account
 *  `tests/e2e/discovery.spec.ts`'s `@ssh-live` test already uses for a real connect+discover run. */
const FIXTURE_SSH_USER = 'pwuser';

/** Deliberately wrong, obviously-fake — never a real secret, never capable of succeeding. Used
 *  only to produce a genuine `AUTH_FAILED` -> `ERROR` server against the same real sshd
 *  container the connected fixture uses, matching `server-sheet.spec.ts`'s own
 *  `FAKE_PASSWORD` precedent for "a password that must never work". */
const FIXTURE_WRONG_PASSWORD = 'ui-review-wrong-password-fixture-only';

/** D-12's literal target and, if the real validator rejects it, the fallback this script falls
 *  back to (see this file's own header comment). */
const LONG_NAME_TARGET_LENGTH = 80;
const LONG_NAME_FALLBACK_LENGTH = 63;

const POLL_INTERVAL_MS = 500;
const SETTLE_TIMEOUT_MS = 60_000;

interface Target {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
}

interface Session {
  readonly target: Target;
  readonly stop: () => Promise<void>;
}

/**
 * Attach mode (`UI_REVIEW_BASE_URL` pointing at an already-running `pnpm dev`) or, by default, the
 * real E2E stack from `tests/e2e/fixtures/stack.ts` — Postgres, Redis, the API, the worker and the
 * built web app, with its own preseeded fixture admin.
 *
 * Every variable is read and checked explicitly; none has a literal fallback. A default base URL
 * would silently point a capture run at whatever happens to be listening on that port, and a
 * default credential would be a hardcoded secret.
 */
async function openSession(): Promise<Session> {
  const baseUrl = process.env.UI_REVIEW_BASE_URL;
  if (baseUrl !== undefined) {
    const email = process.env.UI_REVIEW_EMAIL;
    const password = process.env.UI_REVIEW_PASSWORD;
    if (email === undefined || password === undefined) {
      throw new Error(
        'capture-ui-review: UI_REVIEW_BASE_URL is set, so UI_REVIEW_EMAIL and UI_REVIEW_PASSWORD must be set too — attach mode has no fixture account of its own',
      );
    }
    console.log(`capture-ui-review: attaching to ${baseUrl}`);
    return { target: { baseUrl, email, password }, stop: () => Promise.resolve() };
  }

  // Imported lazily so attach mode never pulls Testcontainers (and therefore Docker) into the
  // process merely to boot a stack it does not need — the sshd fixture below is still imported
  // separately, and still requires Docker, in either mode (D-12 wants real fixture data
  // regardless of how the app itself is reached).
  const { startStack, stopStack } = await import('../../tests/e2e/fixtures/stack.js');
  console.log('capture-ui-review: booting the E2E stack (Docker required) — this takes a minute');
  const stack = await startStack();
  return {
    target: { baseUrl: stack.baseUrl, email: stack.adminEmail, password: stack.adminPassword },
    stop: () => stopStack(stack),
  };
}

/** Deterministic: the attribute is set directly rather than by clicking the real toggle, so a
 *  capture never depends on which theme the previous one left behind in localStorage. */
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((value: Theme) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
}

async function shootPage(page: Page, file: string): Promise<void> {
  writeIfChanged(file, await page.screenshot({ fullPage: true, type: 'png' }));
}

async function goto(page: Page, path: string, width: Width, theme: Theme): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT[width] });
  await page.goto(path, { waitUntil: 'load' });
  await setTheme(page, theme);
}

async function signIn(page: Page, target: Target): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(target.email);
  await page.getByLabel('Password').fill(target.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/servers$/, { timeout: 60_000 });
}

/** Every unauthenticated screen, both themes, all four widths, on a single fresh page — captured
 *  first and with every field left empty (T-08-02) so no credential is ever on screen. */
async function captureUnauthenticated(page: Page): Promise<void> {
  for (const surface of ['setup', 'login'] as const) {
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        await goto(page, `/${surface}`, width, theme);
        await shootPage(page, reviewPngPath(surface, theme, width));
      }
    }
  }
}

/** The throwaway "no servers yet" pass D-12 names as its own fixture state — captured once, right
 *  after sign-in and strictly before any server is seeded, since it is the one state that stops
 *  existing the moment the first fixture server is created. */
async function captureEmptyServersList(page: Page): Promise<void> {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      await goto(page, '/servers', width, theme);
      await shootPage(page, reviewPngPath('servers', theme, width));
    }
  }
}

interface CreatedServer {
  readonly id: string;
}

async function createServer(
  page: Page,
  body: {
    readonly name: string;
    readonly host: string;
    readonly sshPort: number;
    readonly sshUser: string;
    readonly credential: { readonly type: 'ssh_password'; readonly password: string };
  },
): Promise<{ readonly ok: boolean; readonly server: CreatedServer | undefined }> {
  const response = await page.request.post('/api/servers', { data: body });
  if (!response.ok()) {
    return { ok: false, server: undefined };
  }
  return { ok: true, server: (await response.json()) as CreatedServer };
}

async function connectServer(page: Page, id: string): Promise<void> {
  const response = await page.request.post(`/api/servers/${id}/connect`);
  if (response.status() !== 202) {
    throw new Error(`capture-ui-review: connect for ${id} returned ${String(response.status())}, expected 202`);
  }
}

/** Polls the real API until the server leaves PENDING/CONNECTING — a real settle, never a fixed
 *  sleep standing in for one. Bounded so a genuinely stuck fixture fails loudly instead of hanging
 *  the whole capture run. */
async function waitForServerSettled(page: Page, id: string): Promise<string> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const response = await page.request.get(`/api/servers/${id}`);
    if (response.ok()) {
      const body = (await response.json()) as { status: string };
      if (body.status !== 'PENDING' && body.status !== 'CONNECTING') {
        return body.status;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`capture-ui-review: server ${id} never settled within ${String(SETTLE_TIMEOUT_MS)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** A valid slug of exactly `length` characters under `SERVER_NAME_PATTERN`
 *  (`[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`): starts and ends alphanumeric, filled with `x` between. */
function buildSlugOfLength(length: number): string {
  if (length < 2) {
    throw new Error(`capture-ui-review: buildSlugOfLength(${String(length)}) is below the pattern's own minimum`);
  }
  return `a${'x'.repeat(length - 2)}a`;
}

/** Creates the 80-character-name fixture server (D-12). Attempts the literal length D-12 names
 *  first; if the real validator rejects it, falls back to the longest name it accepts (63 chars)
 *  — see this file's own header comment for why 80 is not always reachable. */
async function createLongNameServer(page: Page, host: string): Promise<CreatedServer> {
  const targetName = buildSlugOfLength(LONG_NAME_TARGET_LENGTH);
  const attempt = await createServer(page, {
    name: targetName,
    host,
    sshPort: 22,
    sshUser: FIXTURE_SSH_USER,
    credential: { type: 'ssh_password', password: FIXTURE_WRONG_PASSWORD },
  });
  if (attempt.ok && attempt.server !== undefined) {
    return attempt.server;
  }

  console.warn(
    `capture-ui-review: a ${String(LONG_NAME_TARGET_LENGTH)}-char server name was rejected by the real validator ` +
      `(packages/domain's SERVER_NAME_PATTERN caps names at ${String(LONG_NAME_FALLBACK_LENGTH)} chars) — falling ` +
      `back to the longest name it accepts. See 08-01-SUMMARY.md.`,
  );
  const fallbackName = buildSlugOfLength(LONG_NAME_FALLBACK_LENGTH);
  const fallback = await createServer(page, {
    name: fallbackName,
    host,
    sshPort: 22,
    sshUser: FIXTURE_SSH_USER,
    credential: { type: 'ssh_password', password: FIXTURE_WRONG_PASSWORD },
  });
  if (!fallback.ok || fallback.server === undefined) {
    throw new Error(`capture-ui-review: even the ${String(LONG_NAME_FALLBACK_LENGTH)}-char fallback name was rejected`);
  }
  return fallback.server;
}

interface Fixtures {
  readonly connectedId: string;
}

/** Seeds the three server fixtures D-12 names, against a single real sshd Testcontainer (the
 *  error-state server reuses the same container with a wrong password — a genuine `AUTH_FAILED`
 *  against real infrastructure, never a stub, without paying for a second container). */
async function seedServerFixtures(page: Page): Promise<Fixtures> {
  // Imported lazily, same discipline as `openSession`'s own stack.js import above — this is the
  // one E2E fixture spec (05-20-PLAN.md, QA-04) whose own sshd handle exists specifically so a
  // caller outside a Playwright `test()` block (like this script) can still borrow it safely.
  const { startCriticalPathSshd, stopCriticalPathSshd } = await import('../../tests/e2e/fixtures/stack.js');

  console.log('capture-ui-review: starting the sshd fixture (Docker required) for the connected/error servers');
  const sshd = await startCriticalPathSshd();
  try {
    const connected = await createServer(page, {
      name: 'ui-review-connected',
      host: sshd.host,
      sshPort: sshd.port,
      sshUser: FIXTURE_SSH_USER,
      credential: { type: 'ssh_password', password: sshd.password },
    });
    if (!connected.ok || connected.server === undefined) {
      throw new Error('capture-ui-review: creating the connected fixture server failed');
    }
    await connectServer(page, connected.server.id);
    const connectedStatus = await waitForServerSettled(page, connected.server.id);
    if (connectedStatus !== 'CONNECTED') {
      throw new Error(`capture-ui-review: expected the connected fixture to settle CONNECTED, got ${connectedStatus}`);
    }

    // Same real container as `connected` above, addressed through the OS-equivalent alias
    // (`alternateHostForSameEndpoint`) so this row does not collide with the connected fixture's
    // own (host, port) under `servers_host_port_unique_idx` — see scripts/ui/fixture-host.ts.
    const errored = await createServer(page, {
      name: 'ui-review-error',
      host: alternateHostForSameEndpoint(sshd.host),
      sshPort: sshd.port,
      sshUser: FIXTURE_SSH_USER,
      credential: { type: 'ssh_password', password: FIXTURE_WRONG_PASSWORD },
    });
    if (!errored.ok || errored.server === undefined) {
      throw new Error('capture-ui-review: creating the error fixture server failed');
    }
    await connectServer(page, errored.server.id);
    const erroredStatus = await waitForServerSettled(page, errored.server.id);
    if (erroredStatus !== 'ERROR') {
      console.warn(`capture-ui-review: expected the error fixture to settle ERROR, got ${erroredStatus}`);
    }

    await createLongNameServer(page, sshd.host);

    return { connectedId: connected.server.id };
  } finally {
    await stopCriticalPathSshd();
  }
}

/** For each of the four already-authenticated screens, at every width and theme. `servers` and
 *  `server-detail` show the seeded fixtures (a populated list, and the connected server's own
 *  discovered detail); `activity`/`settings` need no server-specific fixture beyond sign-in. */
async function captureAuthenticatedScreens(page: Page, fixtures: Fixtures): Promise<void> {
  const paths: Record<'servers' | 'server-detail' | 'activity' | 'settings', string> = {
    servers: '/servers',
    'server-detail': `/servers/${fixtures.connectedId}`,
    activity: '/activity',
    settings: '/settings',
  };

  for (const screen of ['servers', 'server-detail', 'activity', 'settings'] as const) {
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        await goto(page, paths[screen], width, theme);
        await shootPage(page, reviewPngPath(screen, theme, width));
      }
    }
  }
}

const OVERLAY_WIDTH: Width = 1280;

/** The four overlay surfaces (D-12), at 1280px only, both themes — each opened fresh from a
 *  reload of `/servers` so one overlay's dismissal can never leak into the next capture. */
async function captureOverlays(page: Page, fixtures: Fixtures): Promise<void> {
  for (const theme of THEMES) {
    // sheet-open: the add-server Sheet.
    await goto(page, '/servers', OVERLAY_WIDTH, theme);
    await page.getByTestId('servers-add-button').click();
    await page.getByTestId('server-sheet').waitFor({ state: 'visible' });
    await shootPage(page, reviewPngPath('sheet-open', theme, OVERLAY_WIDTH));

    // row-menu-open: the seeded connected server's own RowMenu.
    await goto(page, '/servers', OVERLAY_WIDTH, theme);
    const row = page.getByTestId('servers-row').filter({ hasText: 'ui-review-connected' });
    await row.hover();
    await row.getByRole('button', { name: 'Actions for ui-review-connected' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).waitFor({ state: 'visible' });
    await shootPage(page, reviewPngPath('row-menu-open', theme, OVERLAY_WIDTH));

    // dialog-open: the delete-confirmation Dialog, opened from that same RowMenu.
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByTestId('delete-server-dialog').waitFor({ state: 'visible' });
    await shootPage(page, reviewPngPath('dialog-open', theme, OVERLAY_WIDTH));

    // account-menu-open: guarded — `AccountMenu` does not exist until 08-08-PLAN.md (D-05).
    await goto(page, '/servers', OVERLAY_WIDTH, theme);
    const accountTrigger = page.getByTestId('shell-account-menu-trigger');
    if ((await accountTrigger.count()) === 0) {
      console.log(
        `capture-ui-review: skipping account-menu-open/${theme} — shell-account-menu-trigger does not exist yet (ships in 08-08-PLAN.md, D-05)`,
      );
      continue;
    }
    await accountTrigger.click();
    await shootPage(page, reviewPngPath('account-menu-open', theme, OVERLAY_WIDTH));
  }
}

async function main(): Promise<void> {
  const session = await openSession();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: session.target.baseUrl });
    const page = await context.newPage();

    await captureUnauthenticated(page);
    await signIn(page, session.target);
    await captureEmptyServersList(page);

    const fixtures = await seedServerFixtures(page);

    await captureAuthenticatedScreens(page, fixtures);
    await captureOverlays(page, fixtures);

    await context.close();
  } finally {
    await browser?.close();
    await session.stop();
  }

  const expectedFileCount = (SCREENS.length + OVERLAYS.length) * THEMES.length * WIDTHS.length;
  console.log(
    `capture-ui-review: matrix target is ${String(expectedFileCount)} file(s) (SCREENS+OVERLAYS × THEMES × WIDTHS); ` +
      'account-menu-open is skipped until 08-08-PLAN.md ships AccountMenu.',
  );

  if (changedFiles.length === 0) {
    console.log('capture-ui-review: no files changed (fully idempotent run).');
    return;
  }
  console.log(`capture-ui-review: ${String(changedFiles.length)} file(s) changed:`);
  for (const file of changedFiles) {
    console.log(`  ${file}`);
  }
}

main().catch((err: unknown) => {
  console.error('capture-ui-review: FATAL', err);
  process.exit(1);
});
