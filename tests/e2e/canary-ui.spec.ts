// 05-21-PLAN.md Task 1 (QA-05): the browser-side half of the secrets canary. Every backend surface
// (success/error bodies, a forced 500, SSE frames, logs, activity_events.metadata,
// discovery_snapshots.payload) is already proven leak-free by
// tests/integration/activity/canary-http.test.ts (Plan 04's canary, extended by Plan 05-05 for the
// discovery read endpoint and the server.discovery_progress SSE frame) -- see this plan's own
// SUMMARY for why that file is extended rather than duplicated by a second integration suite. This
// spec adds the four surfaces only a real browser has: rendered HTML, `console`, both Web Storages,
// and the URL/navigation history.
//
// Per-run random canaries only (noodara-security skill SS9) -- never a committed literal. The one
// documented exception (05-UI-SPEC.md SS2.1, INST-04) is the setup token, which legitimately
// pre-fills from the initial `/setup?token=...` URL by design; this spec proves that token reaches
// no OTHER surface (not even a later history entry, not console, not storage, not a response body)
// rather than whitelisting it broadly.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

function randomCanary(label: string): string {
  return `noodara-canary-${label}-${randomBytes(16).toString('hex')}`;
}

/** A real, genuinely passphrase-locked ed25519 key generated fresh for this run only (never a
 *  committed literal) -- `credential-store.ts`'s `encodePrivateKey` genuinely parses/decrypts the
 *  key with the submitted passphrase before persisting it, matching
 *  `tests/integration/activity/canary-http.test.ts`'s own `generateLockedEd25519Key`. */
function generateLockedEd25519Key(passphrase: string): { readonly privateKey: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'noodara-canary-ui-key-'));
  execFileSync('ssh-keygen', ['-q', '-N', passphrase, '-t', 'ed25519', '-f', join(dir, 'key')], { stdio: 'ignore' });
  const privateKey = readFileSync(join(dir, 'key'), 'utf8');
  return { privateKey, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

async function readStorageValues(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const values: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) values.push(localStorage.getItem(key) ?? '');
    }
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key !== null) values.push(sessionStorage.getItem(key) ?? '');
    }
    return values;
  });
}

test(
  '@canary a per-run password canary and a per-run passphrase canary never reach rendered HTML, ' +
    'console, storage, the URL/history, or any response body across the whole UI flow',
  async ({ page, context }, testInfo) => {
    // This spec deliberately walks the entire UI flow (setup attempt, login, two server
    // creates, an edit, four screens, a re-opened sheet, sign-out) in one continuous session so
    // every surface is checked against the exact same canaries -- comfortably longer than the
    // config's default 60s budget for an ordinary single-screen spec. On a genuinely idle
    // machine this whole flow completes in 2-12s; 120s is a generous multiple of that, not an
    // attempt to paper over the machine-load flakiness documented in this plan's own SUMMARY.
    testInfo.setTimeout(120_000);

    // ---- canary values -----------------------------------------------------------------------
    const passwordCanary = randomCanary('password');
    const passphraseCanary = randomCanary('passphrase');
    const invalidKeyCanary = randomCanary('invalidkey');
    const setupTokenCanary = randomCanary('setuptoken');
    const setupPasswordCanary = randomCanary('setuppassword');
    const lockedKey = generateLockedEd25519Key(passphraseCanary);

    // Every one of these must appear nowhere except the one legitimate surface that carries it
    // (the request body that submits it). setupTokenCanary is handled separately below since it
    // has one documented exception (the initial /setup URL).
    const secretCanaries = [passwordCanary, passphraseCanary, invalidKeyCanary, setupPasswordCanary, lockedKey.privateKey];

    // ---- collectors, registered before any navigation -----------------------------------------
    const consoleMessages: string[] = [];
    const pageErrorMessages: string[] = [];
    const visitedUrls: string[] = [];
    const responseCaptures: Promise<{ readonly url: string; readonly body: string } | null>[] = [];

    page.on('console', (message: ConsoleMessage) => {
      consoleMessages.push(message.text());
    });
    page.on('pageerror', (err) => {
      pageErrorMessages.push(err.message);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visitedUrls.push(frame.url());
    });
    // Bodies are read on `requestfinished`, never on `response`: that event fires only once the
    // whole body has arrived, so `.text()` resolves immediately. Reading on `response` hung this
    // spec for its full 120s timeout on roughly half its runs -- a request a navigation abandons
    // mid-flight (an RSC `?_rsc=` prefetch, an in-flight fetch) can leave `.text()` pending
    // forever, and step 11 awaits every capture. An abandoned request fires `requestfailed`
    // instead and has no complete body to inspect; the long-lived SSE stream never finishes, so it
    // is excluded by construction -- its frames are proven canary-free server-side by
    // canary-http.test.ts's own stream-chunk assertion.
    page.on('requestfinished', (request) => {
      responseCaptures.push(
        (async () => {
          try {
            const response = await request.response();
            if (response === null) return null;
            const body = await response.text();
            return { url: response.url(), body };
          } catch {
            return null; // a body with no text() support (e.g. a redirect)
          }
        })(),
      );
    });

    try {
      // ---- 1. Setup token surface: the one documented exception (initial URL only) ------------
      await page.goto(`/setup?token=${setupTokenCanary}`);
      await expect(page.getByLabel('Token')).toHaveValue(setupTokenCanary);
      await page.getByLabel('Email').fill('canary-setup-attempt@noodara.test');
      await page.getByLabel('Password').fill(setupPasswordCanary);
      await page.getByRole('button', { name: 'Create admin account' }).click();
      await expect(page.getByTestId('setup-banner')).toBeVisible();

      // ---- 2. Login with the real (non-canary) preseeded admin --------------------------------
      await page.goto('/login');
      await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
      await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
      await page.getByTestId('login-submit').click();
      await expect(page).toHaveURL(/\/servers$/);

      // ---- 2b. The session cookie is HttpOnly -- never readable from document.cookie ----------
      // Checked here, right after a fresh sign-in and before the flow's heavier navigations,
      // rather than at the very end of a long-running test.
      const cookiesAfterLogin = await context.cookies();
      const sessionCookies = cookiesAfterLogin.filter((cookie) => cookie.name.toLowerCase().includes('session'));
      expect(sessionCookies.length).toBeGreaterThan(0);
      for (const cookie of sessionCookies) {
        expect(cookie.httpOnly).toBe(true);
      }
      const docCookieAfterLogin = await page.evaluate(() => document.cookie);
      for (const cookie of cookiesAfterLogin) {
        if (cookie.httpOnly) {
          expect(docCookieAfterLogin).not.toContain(cookie.value);
        }
      }

      // ---- 3. Add server with a PASSWORD credential (passwordCanary) --------------------------
      const nameA = `canary-pw-${String(Date.now())}`;
      await page.getByRole('button', { name: 'Add server' }).click();
      await expect(page.getByTestId('server-sheet')).toBeVisible();
      await page.getByLabel('Name').fill(nameA);
      await page.getByLabel('Host').fill(`${nameA}.example.test`);
      await page.getByTestId('server-sheet-credential-type').getByRole('radio', { name: 'Password' }).click();
      await page.getByLabel('Password').fill(passwordCanary);
      await page.getByRole('button', { name: 'Save without connecting' }).click();
      await expect(page.getByTestId('server-sheet')).toHaveCount(0);

      // Immediately after the sheet closes -- the credential state must already be cleared, not
      // merely hidden behind a closed panel.
      const htmlRightAfterClose = await page.content();
      expect(htmlRightAfterClose).not.toContain(passwordCanary);

      // ---- 4. A deliberately failed operation: an unparseable private key -----------------------
      const nameB = `canary-invalid-${String(Date.now())}`;
      await page.getByRole('button', { name: 'Add server' }).click();
      await expect(page.getByTestId('server-sheet')).toBeVisible();
      await page.getByLabel('Name').fill(nameB);
      await page.getByLabel('Host').fill(`${nameB}.example.test`);
      // Private key is the segmented control's default selection.
      await page
        .getByLabel('Private key')
        .fill(`-----BEGIN OPENSSH PRIVATE KEY-----\n${invalidKeyCanary}\n-----END OPENSSH PRIVATE KEY-----`);
      await page.getByTestId('server-sheet-save-connect').click();
      // The error banner is a fixed, non-interpolated sentence (error-copy.ts's INVALID_CREDENTIAL
      // copy) -- proven here by an exact string match, which by construction cannot echo the raw
      // submitted value. (The still-open textarea legitimately keeps showing what the user just
      // typed, exactly like any other unsubmitted form field -- that is not a leak; the canary is
      // checked once the sheet is actually closed and its state discarded, immediately below.)
      await expect(
        page.getByText('This credential could not be parsed. Check the key format (or password) and try again.'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByTestId('server-sheet')).toHaveCount(0);
      const htmlAfterFailedSubmitCancelled = await page.content();
      expect(htmlAfterFailedSubmitCancelled).not.toContain(invalidKeyCanary);

      // ---- 5. Edit server A: replace the credential with the locked key + passphraseCanary -----
      const rowA = page.getByTestId('servers-row').filter({ hasText: nameA });
      await rowA.hover();
      await page.getByRole('button', { name: `Actions for ${nameA}` }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await expect(page.getByTestId('server-sheet')).toBeVisible();
      await page.getByRole('button', { name: 'Replace' }).click();
      await page.getByLabel('Private key').fill(lockedKey.privateKey);
      await page.getByLabel('Passphrase').fill(passphraseCanary);
      await page.getByTestId('server-sheet').getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByTestId('server-sheet')).toHaveCount(0);

      // ---- 6. Walk the four screens: list, detail, activity, settings -------------------------
      const screenHtmls: string[] = [await page.content()]; // servers list, right after the edit closed

      await rowA.click();
      await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/);
      screenHtmls.push(await page.content());

      await page.goto('/activity');
      screenHtmls.push(await page.content());

      await page.goto('/settings');
      screenHtmls.push(await page.content());

      for (const html of screenHtmls) {
        for (const canary of secretCanaries) {
          expect(html).not.toContain(canary);
        }
      }

      // ---- 7. Re-opening the same server's edit sheet shows no substring of either canary ------
      await page.goto('/servers');
      await rowA.hover();
      await page.getByRole('button', { name: `Actions for ${nameA}` }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await expect(page.getByTestId('server-sheet')).toBeVisible();
      const editHtml = await page.content();
      for (const canary of secretCanaries) {
        expect(editHtml).not.toContain(canary);
      }
      // Edit mode always collapses to dots + Replace -- never a live credential input.
      await expect(page.getByText('••••••••')).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByTestId('server-sheet')).toHaveCount(0);

      // ---- 8. Neither Web Storage ever held a canary -------------------------------------------
      const storedValues = await readStorageValues(page);
      for (const canary of secretCanaries) {
        expect(storedValues.some((value) => value.includes(canary))).toBe(false);
      }

      // ---- 9. No navigated URL (the browser's own history) carries a secret canary; the setup ---
      //         token is the one documented exception, and only on its very first appearance.
      for (const url of visitedUrls) {
        for (const canary of secretCanaries) {
          expect(url).not.toContain(canary);
        }
      }
      // Chromium's `framenavigated` can fire more than once for the exact same URL (e.g. an
      // initial document navigation plus a same-URL history event) -- dedupe before asserting
      // there is exactly one *distinct* URL carrying the token, and that it is the expected
      // initial `/setup` URL, never a later navigation.
      const distinctUrlsCarryingSetupToken = [...new Set(visitedUrls.filter((url) => url.includes(setupTokenCanary)))];
      expect(distinctUrlsCarryingSetupToken).toHaveLength(1);
      expect(distinctUrlsCarryingSetupToken[0]).toBe(`http://localhost:3000/setup?token=${setupTokenCanary}`);

      // ---- 10. console and uncaught page errors -------------------------------------------------
      const consoleText = consoleMessages.join('\n');
      const pageErrorText = pageErrorMessages.join('\n');
      for (const canary of [...secretCanaries, setupTokenCanary]) {
        expect(consoleText).not.toContain(canary);
        expect(pageErrorText).not.toContain(canary);
      }

      // ---- 11. Every response body the page received, across the whole flow ---------------------
      const responses = (await Promise.all(responseCaptures)).filter(
        (r): r is { readonly url: string; readonly body: string } => r !== null,
      );
      expect(responses.length).toBeGreaterThan(0); // non-vacuity: real responses were actually captured
      // Non-vacuity, by name: the responses to the very requests that carried a canary (the setup
      // attempt, the server creates and the credential replace) and the list the UI renders from
      // were each inspected -- not merely "some response somewhere".
      const inspectedPaths = new Set(responses.map(({ url }) => new URL(url).pathname));
      expect(inspectedPaths).toContain('/api/setup');
      expect(inspectedPaths).toContain('/api/servers');
      expect([...inspectedPaths].some((path) => /^\/api\/servers\/[0-9a-f-]+$/.test(path))).toBe(true);
      for (const { url, body } of responses) {
        for (const canary of [...secretCanaries, setupTokenCanary]) {
          expect(body, `response from ${url} leaked a canary`).not.toContain(canary);
        }
      }

      // ---- 12. Sign out -- no credential surfaces during or after -------------------------------
      await page.getByTestId('shell-sign-out').click();
      await expect(page).toHaveURL(/\/login$/);
      const htmlAfterSignOut = await page.content();
      for (const canary of secretCanaries) {
        expect(htmlAfterSignOut).not.toContain(canary);
      }
    } finally {
      lockedKey.cleanup();
    }
  },
);
