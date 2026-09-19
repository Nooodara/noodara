// 05-19-PLAN.md Task 3: the TOFU surfaces (D-02 first-trust notice, D-03 HOST_KEY_CHANGED banner
// + trust-new-fingerprint dialog) verified in a real browser, plus the UI-level counterpart of
// 05-01-SUMMARY.md's UF-01 regression test (D-17). Five `@hostkey` behaviours use `page.route`
// interception (ADR-0005's established pattern, matching tests/e2e/server-detail.spec.ts's own
// precedent) for the rendering/interaction cases route interception can honestly prove; the sixth
// (UF-01 itself) drives a real, sequential pair of sshd Testcontainers fixtures on the same fixed
// host:port -- the whole point of that regression is that the server-side fix holds against a
// genuine identity edit, not a stubbed one.
import { expect, test, type Page, type Request } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';
import { startSshd, type SshdFixture } from '../integration/helpers/ssh.js';

// A high, unlikely port distinct from tests/integration/ssh/host-key-changed.test.ts's 42_522 and
// connection-loss.test.ts's 42_533 -- Playwright's own config pins `workers: 1`/`fullyParallel:
// false`, so nothing else in this test run can race this port.
const FIXED_HOST_PORT = 42_544;

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

// Same shape/defaults as tests/e2e/server-detail.spec.ts's/discovery.spec.ts's own
// `buildServerViewFixture` -- no shared builder exists across e2e specs yet, matching that
// established, already-repeated precedent.
function buildServerViewFixture(overrides: ServerViewFixtureOverrides): ServerViewFixture {
  return {
    host: 'example.test',
    sshPort: 22,
    sshUser: 'root',
    status: 'CONNECTED',
    hostFingerprint: null,
    hostFingerprintCapturedAt: null,
    pendingFingerprint: null,
    pendingFingerprintSeenAt: null,
    hostname: 'srv.internal',
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
    lastSeenAt: '2026-09-19T11:58:00.000Z',
    lastErrorCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    credentialType: 'ssh_password',
    ...overrides,
  };
}

async function stubServerGet(page: Page, fixture: ServerViewFixture): Promise<void> {
  await page.route(`**/api/servers/${fixture.id}`, (route) => {
    if (route.request().method() !== 'GET') {
      return route.fallback();
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
  });
}

const TRUSTED_FINGERPRINT = 'SHA256:trusted0000000000000000000000000000000000';
const OBSERVED_FINGERPRINT = 'SHA256:observed00000000000000000000000000000000';

test('@hostkey the first-trust notice shows with the fingerprint and the verification command; dismissing hides it, a reload keeps it hidden, and the permanent fingerprint row survives', async ({
  page,
}) => {
  const fixture = buildServerViewFixture({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'first-trust-srv',
    status: 'CONNECTED',
    hostFingerprint: TRUSTED_FINGERPRINT,
    hostFingerprintCapturedAt: '2026-09-01T00:00:00.000Z',
  });
  await stubServerGet(page, fixture);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  const notice = page.getByTestId('first-trust-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    "Noodara trusted this server's host key on first connection. Verify it matches what the server reports:",
  );
  await expect(notice).toContainText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
  await expect(notice).toContainText(TRUSTED_FINGERPRINT);

  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('first-trust-notice')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('first-trust-notice')).toHaveCount(0);
  // The permanent Connection-group row is unaffected by dismissal.
  await expect(page.getByText(TRUSTED_FINGERPRINT)).toBeVisible();
});

test('@hostkey a second server in the same browser still shows its own first-trust notice after the first was dismissed', async ({
  page,
}) => {
  const first = buildServerViewFixture({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'first-trust-a',
    hostFingerprint: TRUSTED_FINGERPRINT,
    hostFingerprintCapturedAt: '2026-09-01T00:00:00.000Z',
  });
  const second = buildServerViewFixture({
    id: '33333333-3333-4333-8333-333333333333',
    name: 'first-trust-b',
    hostFingerprint: 'SHA256:second00000000000000000000000000000000000',
    hostFingerprintCapturedAt: '2026-09-02T00:00:00.000Z',
  });
  await stubServerGet(page, first);
  await stubServerGet(page, second);

  await login(page);

  await page.goto(`/servers/${first.id}`);
  await page.getByTestId('first-trust-notice').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('first-trust-notice')).toHaveCount(0);

  await page.goto(`/servers/${second.id}`);
  await expect(page.getByTestId('first-trust-notice')).toBeVisible();
});

test('@hostkey the HOST_KEY_CHANGED banner shows both fingerprints labelled Trusted/Observed with dates, the verification command and the mono error code, and the generic banner never appears for it', async ({
  page,
}) => {
  const fixture = buildServerViewFixture({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'host-key-changed-srv',
    status: 'ERROR',
    lastErrorCode: 'HOST_KEY_CHANGED',
    hostFingerprint: TRUSTED_FINGERPRINT,
    hostFingerprintCapturedAt: '2026-09-01T00:00:00.000Z',
    pendingFingerprint: OBSERVED_FINGERPRINT,
    pendingFingerprintSeenAt: '2026-09-19T11:00:00.000Z',
  });
  await stubServerGet(page, fixture);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  const banner = page.getByTestId('host-key-changed-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    "This server's host key changed since it was last trusted. This can mean the server was reinstalled, or that something is intercepting the connection. Verify the fingerprint on the server itself before continuing:",
  );
  await expect(banner).toContainText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
  await expect(banner).toContainText(`Trusted: ${TRUSTED_FINGERPRINT}`);
  await expect(banner).toContainText(`Observed: ${OBSERVED_FINGERPRINT}`);
  await expect(banner).toContainText('HOST_KEY_CHANGED');

  // The generic DETL-02 banner never renders alongside/instead of this one.
  await expect(page.getByTestId('server-detail-error-banner')).toHaveCount(0);
});

test('@hostkey the trust-new-fingerprint dialog keeps its confirm button disabled until the exact server name is typed, and a near-miss leaves it disabled', async ({
  page,
}) => {
  const fixture = buildServerViewFixture({
    id: '55555555-5555-4555-8555-555555555555',
    name: 'confirm-gate-srv',
    status: 'ERROR',
    lastErrorCode: 'HOST_KEY_CHANGED',
    hostFingerprint: TRUSTED_FINGERPRINT,
    hostFingerprintCapturedAt: '2026-09-01T00:00:00.000Z',
    pendingFingerprint: OBSERVED_FINGERPRINT,
    pendingFingerprintSeenAt: '2026-09-19T11:00:00.000Z',
  });
  await stubServerGet(page, fixture);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  await page.getByTestId('host-key-changed-banner').getByRole('button', { name: 'Trust new fingerprint' }).click();

  const dialog = page.getByTestId('trust-fingerprint-dialog');
  await expect(dialog).toBeVisible();
  const confirmButton = dialog.getByRole('button', { name: 'Trust new fingerprint' });
  const input = dialog.getByRole('textbox');

  await expect(confirmButton).toBeDisabled();

  await input.fill('confirm-gate-sr'); // a near-miss: one character short
  await expect(confirmButton).toBeDisabled();

  await input.fill('confirm-gate-srv');
  await expect(confirmButton).toBeEnabled();
});

test('@hostkey confirming with the exact name posts to trust-fingerprint exactly once; success reflects PENDING with only Connect, and issues no automatic connect request', async ({
  page,
}) => {
  let current = buildServerViewFixture({
    id: '66666666-6666-4666-8666-666666666666',
    name: 'trust-success-srv',
    status: 'ERROR',
    lastErrorCode: 'HOST_KEY_CHANGED',
    hostFingerprint: TRUSTED_FINGERPRINT,
    hostFingerprintCapturedAt: '2026-09-01T00:00:00.000Z',
    pendingFingerprint: OBSERVED_FINGERPRINT,
    pendingFingerprintSeenAt: '2026-09-19T11:00:00.000Z',
  });

  await page.route(`**/api/servers/${current.id}`, (route) => {
    if (route.request().method() !== 'GET') {
      return route.fallback();
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
  });

  const trustRequests: Request[] = [];
  const connectRequests: Request[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/servers/${current.id}/trust-fingerprint`) && request.method() === 'POST') {
      trustRequests.push(request);
    }
    if (request.url().endsWith(`/api/servers/${current.id}/connect`) && request.method() === 'POST') {
      connectRequests.push(request);
    }
  });

  await page.route(`**/api/servers/${current.id}/trust-fingerprint`, (route) => {
    current = {
      ...current,
      status: 'PENDING',
      lastErrorCode: null,
      hostFingerprint: current.pendingFingerprint,
      hostFingerprintCapturedAt: new Date().toISOString(),
      pendingFingerprint: null,
      pendingFingerprintSeenAt: null,
    };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
  });

  await login(page);
  await page.goto(`/servers/${current.id}`);

  await page.getByTestId('host-key-changed-banner').getByRole('button', { name: 'Trust new fingerprint' }).click();
  const dialog = page.getByTestId('trust-fingerprint-dialog');
  await dialog.getByRole('textbox').fill('trust-success-srv');
  await dialog.getByRole('button', { name: 'Trust new fingerprint' }).click();

  await expect(page.getByTestId('trust-fingerprint-dialog')).toHaveCount(0);
  await expect(page.getByTestId('status-pill')).toHaveAttribute('data-status', 'PENDING');
  await expect(page.getByTestId('server-detail-primary-action')).toHaveText('Connect');

  await expect.poll(() => trustRequests.length).toBe(1);
  expect(connectRequests).toHaveLength(0);
});

test('@hostkey UF-01 regression: editing the host while ERROR/HOST_KEY_CHANGED clears the pending fingerprint, so the trust affordance disappears and the trusted fingerprint stays unchanged', async ({
  page,
}) => {
  test.setTimeout(180_000);

  let sshdA: SshdFixture | undefined;
  let sshdB: SshdFixture | undefined;

  try {
    sshdA = await startSshd({ ubuntu: '24.04', hostPort: FIXED_HOST_PORT });

    await login(page);
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page.getByTestId('server-sheet')).toBeVisible();

    // Deliberately avoids the substring "host" (case-insensitive) anywhere in the name --
    // Playwright's `getByLabel('Host')` does a loose substring match by default, and the edit
    // sheet's own dialog title ("Edit {name}") would otherwise become a second, ambiguous match
    // against the very same accessible name as the Host input itself.
    const name = `uf01-regression-${String(Date.now())}`;
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Host').fill(sshdA.host);
    await page.getByLabel('SSH port').fill(String(sshdA.port));
    await page.getByLabel('SSH user').fill('pwuser');
    await page.getByTestId('server-sheet-credential-type').getByRole('radio', { name: 'Password' }).click();
    await page.getByLabel('Password').fill(sshdA.password);

    await page.getByTestId('server-sheet-save-connect').click();
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/);
    await expect(page.getByTestId('status-pill')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 45_000 });

    const serverId = page.url().split('/').pop();
    if (serverId === undefined) throw new Error('could not read server id from the URL');

    const beforeEdit = await page.request.get(`/api/servers/${serverId}`);
    const beforeEditBody = (await beforeEdit.json()) as { hostFingerprint: string | null };
    const originalFingerprint = beforeEditBody.hostFingerprint;
    expect(originalFingerprint).not.toBeNull();

    // A real host-key change: stop the first container and start a second, fresh-keyed one on the
    // exact same host:port (the fixture's own entrypoint regenerates host keys every start).
    await sshdA.stop();
    sshdA = undefined;
    sshdB = await startSshd({ ubuntu: '24.04', hostPort: FIXED_HOST_PORT });

    // Re-run discovery re-verifies the SSH session end to end (connect-and-discover.ts always
    // drives a fresh handshake) -- this genuinely fails with HOST_KEY_CHANGED against the new key.
    await page.getByTestId('server-detail-primary-action').click();
    await expect(page.getByTestId('host-key-changed-banner')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('button', { name: 'Trust new fingerprint' })).toBeVisible();

    // Edit the host through the real sheet -- the identity-changing edit UF-01's own fix guards.
    await page.goto('/servers');
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(page.getByTestId('server-sheet')).toBeVisible();
    await page.getByLabel('Host').fill(`renamed-${String(Date.now())}.example.test`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('server-sheet')).toHaveCount(0);

    await page.goto(`/servers/${serverId}`);

    // The refusal: no trust affordance survives the edit -- the backend cleared
    // pendingFingerprint, so there is structurally nothing left to trust.
    await expect(page.getByTestId('host-key-changed-banner')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Trust new fingerprint' })).toHaveCount(0);
    await expect(page.getByTestId('host-key-changed-banner')).toContainText('Observed: not available');

    const afterEdit = await page.request.get(`/api/servers/${serverId}`);
    const afterEditBody = (await afterEdit.json()) as {
      hostFingerprint: string | null;
      pendingFingerprint: string | null;
    };
    // The trusted fingerprint is untouched -- only the *pending* one was ever at risk of being
    // promoted against the wrong identity, and it is now gone rather than silently promotable.
    expect(afterEditBody.hostFingerprint).toBe(originalFingerprint);
    expect(afterEditBody.pendingFingerprint).toBeNull();
  } finally {
    await sshdA?.stop();
    await sshdB?.stop();
  }
});
