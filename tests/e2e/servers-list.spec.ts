// 05-13-PLAN.md Task 3: SERV-04's servers list screen, verified in a real browser -- all three
// states plus the row's own keyboard/menu interaction. Runs against the same real stack.ts stack
// smoke.spec.ts/auth.spec.ts/shell.spec.ts use (Postgres, Redis, the API, the worker, the built
// web app), with the preseeded E2E admin.
//
// Loading and error use `page.route('**/api/servers', ...)` interception, per ADR-0005's
// established pattern for a screen-state assertion with no second backend. The populated-rows
// test also uses interception rather than the real API: the domain only ever sets a server's
// `lastSeenAt` after a genuinely successful SSH connection (packages/domain/src/server/
// connection-result.ts's `applyConnectionResult`), which this harness has no reachable sshd
// fixture to produce -- a freshly `POST /api/servers`-registered server's `lastSeenAt` stays
// `null` forever in this environment, so it can never carry the ISO tooltip this test needs to
// prove. Two full `ServerView`-shaped fixtures make that assertion deterministic. The keyboard
// and row-menu tests below use the real API instead (seeding one server each through an
// authenticated request from the browser context), so this spec still proves data really flows
// from a real `POST`/`GET /api/servers` round trip through to the rendered row.
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const EMPTY_TITLE = 'No servers yet';
const EMPTY_SENTENCE = 'Connect your first Ubuntu server to let Noodara discover it.';
const INTERNAL_ERROR_COPY =
  "Couldn't load servers. Something went wrong on our end. Try again, and check the server logs if it continues.";

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

interface ServerViewFixture {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly status: string;
  readonly hostFingerprint: string | null;
  readonly hostFingerprintCapturedAt: string | null;
  readonly pendingFingerprint: string | null;
  readonly pendingFingerprintSeenAt: string | null;
  readonly hostname: string | null;
  readonly osDistribution: string | null;
  readonly osVersion: string | null;
  readonly arch: string | null;
  readonly cpuCores: number | null;
  readonly ramMb: number | null;
  readonly diskTotalMb: number | null;
  readonly diskUsedMb: number | null;
  readonly uptimeSeconds: number | null;
  readonly dockerInstalled: boolean | null;
  readonly dockerVersion: string | null;
  readonly dockerComposeVersion: string | null;
  readonly lastSeenAt: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly credentialType: string;
}

type ServerViewFixtureOverrides = Partial<ServerViewFixture> & Pick<ServerViewFixture, 'id' | 'name'>;

function buildServerViewFixture(overrides: ServerViewFixtureOverrides): ServerViewFixture {
  return {
    host: 'example.test',
    sshPort: 22,
    sshUser: 'root',
    status: 'PENDING',
    hostFingerprint: null,
    hostFingerprintCapturedAt: null,
    pendingFingerprint: null,
    pendingFingerprintSeenAt: null,
    hostname: null,
    osDistribution: null,
    osVersion: null,
    arch: null,
    cpuCores: null,
    ramMb: null,
    diskTotalMb: null,
    diskUsedMb: null,
    uptimeSeconds: null,
    dockerInstalled: null,
    dockerVersion: null,
    dockerComposeVersion: null,
    lastSeenAt: null,
    lastErrorCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    credentialType: 'ssh_password',
    ...overrides,
  };
}

test('@servers on a stack with no servers, the empty state renders its exact title, sentence and exactly one Add server action', async ({
  page,
}) => {
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );

  await login(page);

  await expect(page.getByText(EMPTY_TITLE)).toBeVisible();
  await expect(page.getByText(EMPTY_SENTENCE)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add server' })).toHaveCount(1);
});

test('@servers a never-resolving /api/servers response renders five skeleton rows and no spinner', async ({ page }) => {
  // Deliberately never fulfilled/aborted -- the request stays pending for the whole test, exactly
  // like a real, still-in-flight fetch. No `waitForTimeout`: the skeleton assertions below use
  // Playwright's own auto-retrying `expect`, waiting on the rendered state rather than a clock.
  await page.route('**/api/servers', () => undefined);

  await login(page);

  await expect(page.locator('[data-height="44"]')).toHaveCount(5);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0);
});

test('@servers a 500 INTERNAL_ERROR renders the banner message and mono code, and Retry re-issues the request', async ({
  page,
}) => {
  let requestCount = 0;
  await page.route('**/api/servers', (route) => {
    requestCount += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'A stubbed failure detail.' }),
    });
  });

  await login(page);

  await expect(page.getByText(INTERNAL_ERROR_COPY)).toBeVisible();
  await expect(page.getByText('INTERNAL_ERROR', { exact: true })).toBeVisible();

  const requestsBeforeRetry = requestCount;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => requestCount).toBeGreaterThan(requestsBeforeRetry);
});

test('@servers two ServerView rows render name, host:port, a matching status pill and an ISO tooltip on the relative last-seen', async ({
  page,
}) => {
  const alphaLastSeenAt = '2026-01-01T08:30:00.000Z';
  const alpha = buildServerViewFixture({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Alpha',
    host: 'alpha.example.test',
    sshPort: 22,
    status: 'CONNECTED',
    lastSeenAt: alphaLastSeenAt,
  });
  const beta = buildServerViewFixture({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Beta',
    host: 'beta.example.test',
    sshPort: 2222,
    status: 'ERROR',
    lastSeenAt: '2026-01-02T09:00:00.000Z',
  });

  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [alpha, beta] }) }),
  );

  await login(page);

  const rows = page.getByTestId('servers-row');
  await expect(rows).toHaveCount(2);

  const alphaRow = rows.filter({ hasText: 'Alpha' });
  await expect(alphaRow.getByText('alpha.example.test:22')).toBeVisible();
  await expect(alphaRow.getByTestId('status-pill')).toHaveAttribute('data-status', 'CONNECTED');

  // `<time>` carries no `tabIndex`, so a real browser never focuses it via `.focus()` (that call
  // is a silent no-op on a non-focusable element) -- Radix's Tooltip trigger still opens on
  // pointer hover regardless, which is what a sighted mouse user actually does here.
  await alphaRow.locator('time').hover();
  await expect(page.getByRole('tooltip')).toContainText(alphaLastSeenAt);

  const betaRow = rows.filter({ hasText: 'Beta' });
  await expect(betaRow.getByText('beta.example.test:2222')).toBeVisible();
  await expect(betaRow.getByTestId('status-pill')).toHaveAttribute('data-status', 'ERROR');
});

test('@servers activating a row with the keyboard navigates to that server\'s detail URL', async ({ page }) => {
  await login(page);

  const name = `kbnav-${String(Date.now())}`;
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  // A refused create must fail here, by name -- never later, disguised as a live event that
  // was lost.
  expect(created.status()).toBe(201);

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await expect(row).toBeVisible();

  await row.getByRole('link').focus();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(new RegExp('/servers/[0-9a-f-]+$'));
});

test('@servers a row\'s actions menu is absent until opened, then exposes Edit and Delete', async ({ page }) => {
  await login(page);

  const name = `rowmenu-${String(Date.now())}`;
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  // A refused create must fail here, by name -- never later, disguised as a live event that
  // was lost.
  expect(created.status()).toBe(201);

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await expect(row).toBeVisible();

  await expect(page.getByRole('menuitem', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);

  await row.hover();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();

  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
});

// .planning/debug/sse-lost-event-race.md: the real-browser form of the snapshot/stream race. The
// two tests above create their server the instant the URL turns `/servers` -- i.e. while the
// list's mount GET and its resync-on-open GET are both still in flight -- and rely on the live
// `server.updated` event alone for the row. The list used to drop every event delivered during a
// fetch, so whenever both snapshots had been read before the insert committed, the row was lost
// for good (1 failure in 6 full-suite iterations). This test pins that exact interleaving instead
// of leaving it to timing: both snapshots are read from the real API *before* the server exists
// and held back until the event has provably crossed the real Redis -> SSE -> Next proxy path.
interface ObserverWindow {
  __noodaraObserver?: { readonly source: EventSource; readonly seen: Promise<void> };
}

test('@servers a server created while the list snapshots are still in flight still appears as a row', async ({ page }) => {
  const name = `midflight-${String(Date.now())}`;

  let snapshotsRead = 0;
  let signalBothSnapshotsRead: () => void = () => undefined;
  const bothSnapshotsRead = new Promise<void>((resolve) => {
    signalBothSnapshotsRead = resolve;
  });
  let releaseSnapshots: () => void = () => undefined;
  const snapshotsReleased = new Promise<void>((resolve) => {
    releaseSnapshots = resolve;
  });

  await page.route('**/api/servers', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch(); // the real snapshot, read right now
    snapshotsRead += 1;
    // A fresh login mounts the shell and the list together: one mount GET, plus one resync GET
    // when the shared stream opens.
    if (snapshotsRead === 2) signalBothSnapshotsRead();
    await snapshotsReleased;
    await route.fulfill({ response });
  });

  await login(page);
  await bothSnapshotsRead;

  // A second stream from the same page is the readiness signal: the broadcaster fans one message
  // out to every registered stream in a single pass, so once this observer has seen the event the
  // page's own shared stream has been handed it too.
  await page.evaluate((serverName) => {
    const source = new EventSource('/api/events');
    let markSeen: () => void = () => undefined;
    const seen = new Promise<void>((resolve) => {
      markSeen = resolve;
    });
    source.addEventListener('server.updated', (raw) => {
      if ((raw as MessageEvent<string>).data.includes(serverName)) markSeen();
    });
    (window as ObserverWindow).__noodaraObserver = { source, seen };
    return new Promise<void>((resolve) => {
      source.addEventListener('open', () => {
        resolve();
      });
    });
  }, name);

  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  // A refused create must fail here, by name -- never later, disguised as a live event that
  // was lost.
  expect(created.status()).toBe(201);

  await page.evaluate(async () => {
    const observer = (window as ObserverWindow).__noodaraObserver;
    if (observer === undefined) throw new Error('observer stream was never opened');
    await observer.seen;
    observer.source.close();
  });

  releaseSnapshots();

  await expect(page.getByTestId('servers-row').filter({ hasText: name })).toBeVisible();
});
