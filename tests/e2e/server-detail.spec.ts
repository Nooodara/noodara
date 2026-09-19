// 05-14-PLAN.md Task 3: the server detail screen (DETL-01/DETL-02), verified in a real browser.
// Runs against the same real stack.ts stack smoke.spec.ts/auth.spec.ts/servers-list.spec.ts use
// (Postgres, Redis, the API, the worker, the built web app), with the preseeded E2E admin.
//
// `page.route('**/api/servers/<id>', ...)` interception (ADR-0005's established pattern, matching
// tests/e2e/servers-list.spec.ts's own precedent) produces the ERROR/CONNECTING/CONNECTED/
// UNSUPPORTED_OS states -- packages/domain/src/server/connection-result.ts's `applyConnectionResult`
// only ever sets `lastSeenAt`/facts after a genuinely successful SSH connection, which this
// harness has no reachable sshd fixture to produce (the exact limitation
// tests/e2e/servers-list.spec.ts's own populated-rows test already documents). A real, currently-
// unreachable sshd-backed CONNECTED case is deferred to Plan 05-20's critical-path E2E, which does
// stand up that fixture -- every behaviour this plan can prove without it is proven here instead.
// Only the PENDING/never-discovered case seeds through the real POST/GET /api/servers round trip.
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

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

// Same fixture shape/defaults as tests/e2e/servers-list.spec.ts's own `buildServerViewFixture` --
// no shared builder exists yet across e2e specs, matching that file's own documented precedent.
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

const DISCOVERED_FACTS = {
  hostname: 'srv-1.internal',
  osDistribution: 'Ubuntu',
  osVersion: '24.04',
  arch: 'x86_64',
  cpuCores: 4,
  ramMb: 8192,
  diskTotalMb: 40960,
  diskUsedMb: 18432,
  uptimeSeconds: 93784,
  dockerInstalled: true,
  dockerVersion: '27.3.1',
  dockerComposeVersion: 'v2.29.7',
  hostFingerprint: 'SHA256:abcdef1234567890',
  hostFingerprintCapturedAt: '2026-09-01T00:00:00.000Z',
  lastSeenAt: '2026-09-19T11:58:00.000Z',
} as const;

async function stubServer(page: Page, fixture: ServerViewFixture): Promise<void> {
  await page.route(`**/api/servers/${fixture.id}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }),
  );
}

test('@detail a PENDING server with no discovery shows the empty state, one Connect action and no error banner', async ({
  page,
}) => {
  await login(page);

  const name = `detail-pending-${String(Date.now())}`;
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  const { id } = (await created.json()) as { id: string };

  await page.goto(`/servers/${id}`);

  await expect(page.getByText('Not discovered yet.')).toBeVisible();
  await expect(page.getByTestId('server-detail-primary-action')).toHaveText('Connect');
  await expect(page.getByTestId('server-detail-error-banner')).toHaveCount(0);
});

test('@detail an AUTH_FAILED error with no history shows the SS5.1 copy, the mono code, Retry and the empty state below, with no stat tiles', async ({
  page,
}) => {
  const fixture = buildServerViewFixture({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'auth-failed-srv',
    status: 'ERROR',
    lastErrorCode: 'AUTH_FAILED',
  });
  await stubServer(page, fixture);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  await expect(
    page.getByText('Authentication failed. Check the SSH username and credential, then try again.'),
  ).toBeVisible();
  await expect(page.getByText('AUTH_FAILED', { exact: true })).toBeVisible();
  await expect(page.getByTestId('server-detail-primary-action')).toHaveText('Retry');
  await expect(page.getByText('Not discovered yet.')).toBeVisible();
  await expect(page.getByTestId('server-facts-tiles')).toHaveCount(0);
});

test('@detail a CONNECT_TIMEOUT error with a prior discovery shows the banner above stat tiles that stay present and visually dimmed', async ({
  page,
}) => {
  const dimmedFixture = buildServerViewFixture({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'connect-timeout-srv',
    status: 'ERROR',
    lastErrorCode: 'CONNECT_TIMEOUT',
    ...DISCOVERED_FACTS,
  });
  const plainFixture = buildServerViewFixture({
    id: '33333333-3333-4333-8333-333333333333',
    name: 'connected-plain-srv',
    status: 'CONNECTED',
    lastErrorCode: null,
    ...DISCOVERED_FACTS,
  });
  await stubServer(page, dimmedFixture);
  await stubServer(page, plainFixture);

  await login(page);

  await page.goto(`/servers/${dimmedFixture.id}`);
  await expect(
    page.getByText('Connection timed out. Check that port 22 is open on example.test.'),
  ).toBeVisible();
  await expect(page.getByText('CONNECT_TIMEOUT', { exact: true })).toBeVisible();
  await expect(page.getByTestId('server-fact-cpu-cores')).toBeVisible();
  await expect(page.getByTestId('server-fact-cpu-cores')).toContainText(/as of/);
  const dimmedColor = await page
    .getByTestId('server-fact-cpu-cores')
    .locator('[data-mono="true"]')
    .evaluate((el) => getComputedStyle(el).color);

  await page.goto(`/servers/${plainFixture.id}`);
  await expect(page.getByTestId('server-fact-cpu-cores')).toBeVisible();
  const plainColor = await page
    .getByTestId('server-fact-cpu-cores')
    .locator('[data-mono="true"]')
    .evaluate((el) => getComputedStyle(el).color);

  expect(dimmedColor).not.toBe(plainColor);
});

test('@detail a CONNECTED server shows four formatted stat tiles and the three label/value groups including the fingerprint copy button', async ({
  page,
}) => {
  const fixture = buildServerViewFixture({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'connected-srv',
    status: 'CONNECTED',
    ...DISCOVERED_FACTS,
  });
  await stubServer(page, fixture);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  await expect(page.getByTestId('server-fact-cpu-cores')).toContainText('4');
  await expect(page.getByTestId('server-fact-ram')).toContainText('GB');
  await expect(page.getByTestId('server-fact-disk')).toContainText('of');
  await expect(page.getByTestId('server-fact-uptime')).toContainText('day');

  await expect(page.getByText('srv-1.internal')).toBeVisible();
  await expect(page.getByText('Ubuntu 24.04')).toBeVisible();
  await expect(page.getByText('27.3.1')).toBeVisible();
  // Scoped to the permanent Connection-group row, not a bare page-wide getByText: this fixture's
  // own hostFingerprintCapturedAt (set by DISCOVERED_FACTS) also satisfies 05-19-PLAN.md's D-02
  // first-trust notice condition, so the same fingerprint string legitimately appears twice on
  // this screen once that notice exists (see tests/e2e/host-key.spec.ts for its own coverage).
  const connectionGroup = page.getByTestId('server-facts-connection');
  await expect(connectionGroup.getByText('SHA256:abcdef1234567890')).toBeVisible();
  await expect(connectionGroup.getByRole('button', { name: 'Copy Host fingerprint' })).toBeVisible();
});

test('@detail a CONNECTING server shows the primary action disabled', async ({ page }) => {
  const fixture = buildServerViewFixture({
    id: '55555555-5555-4555-8555-555555555555',
    name: 'connecting-srv',
    status: 'CONNECTING',
  });
  await stubServer(page, fixture);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  await expect(page.getByTestId('server-detail-primary-action')).toBeDisabled();
});

test('@detail a stubbed 404 shows the not-found copy with a working link back to Servers', async ({ page }) => {
  const missingId = '66666666-6666-4666-8666-666666666666';
  await page.route(`**/api/servers/${missingId}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'NOT_FOUND', message: `Server "${missingId}" not found` }),
    }),
  );

  await login(page);
  await page.goto(`/servers/${missingId}`);

  await expect(page.getByText('This server no longer exists.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to Servers' }).click();
  await expect(page).toHaveURL(/\/servers$/);
});

test('@detail a server with an UNSUPPORTED_OS warning shows the amber inline note and stays CONNECTED, with no error banner', async ({
  page,
}) => {
  const fixture = buildServerViewFixture({
    id: '77777777-7777-4777-8777-777777777777',
    name: 'unsupported-os-srv',
    status: 'CONNECTED',
    lastErrorCode: 'UNSUPPORTED_OS',
    ...DISCOVERED_FACTS,
    osDistribution: 'Debian',
    osVersion: '12',
  });
  await stubServer(page, fixture);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  await expect(
    page.getByText('Outside the supported matrix (Ubuntu 22.04/24.04). Some features may not work as expected.'),
  ).toBeVisible();
  await expect(page.getByTestId('status-pill')).toHaveAttribute('data-status', 'CONNECTED');
  await expect(page.getByTestId('server-detail-error-banner')).toHaveCount(0);
});
