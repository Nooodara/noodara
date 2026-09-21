// 05-19-PLAN.md Task 3: the TOFU surfaces (D-02 first-trust notice, D-03 HOST_KEY_CHANGED banner
// + trust-new-fingerprint dialog) verified in a real browser, plus the UI-level counterpart of
// 05-01-SUMMARY.md's UF-01 regression test (D-17). Most `@hostkey` behaviours use `page.route`
// interception (ADR-0005's established pattern, matching tests/e2e/server-detail.spec.ts's own
// precedent) for the rendering/interaction cases route interception can honestly prove.
//
// 05-31-PLAN.md (gap 6 / T-5G-27, .planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md
// item 3) adds two more real-backend cases on top of UF-01's own sequential-sshd-fixtures
// technique -- the whole point of a real fixture is that the server-side fix holds against a
// genuine identity edit or a genuine trust POST, not a stubbed one -- plus a stubbed mid-review
// fingerprint-swap regression (installSyntheticServerEvents/dispatchServerUpdated below, the same
// technique tests/e2e/discovery.spec.ts already uses to dispatch synthetic SSE frames onto the
// app's own real EventSource instance).
import { expect, test, type Page, type Request } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';
import { startSshd, type SshdFixture } from '../integration/helpers/ssh.js';

// A high, unlikely port distinct from tests/integration/ssh/host-key-changed.test.ts's 42_522 and
// connection-loss.test.ts's 42_533 -- Playwright's own config pins `workers: 1`/`fullyParallel:
// false`, so nothing else in this test run can race this port.
const FIXED_HOST_PORT = 42_544;
// A second fixed port, distinct from FIXED_HOST_PORT above, for 05-31-PLAN.md's own real-backend
// trust-flow test -- both tests stop their containers in a `finally` block before the next test
// starts (workers: 1/fullyParallel: false), but a dedicated port keeps each test's intent legible
// on its own and avoids any accidental cross-test coupling through a shared constant.
const REAL_TRUST_FLOW_HOST_PORT = 42_545;

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

// 05-31-PLAN.md Task 3: the same synthetic-EventSource technique tests/e2e/discovery.spec.ts's own
// `installSyntheticServerEvents`/`dispatchServerUpdated` already established, duplicated here per
// this file's own precedent of not sharing helpers across e2e specs (see `buildServerViewFixture`
// above). Dispatches byte-shaped `server.updated` frames on the real `EventSource` instance the
// app's own `useServerEvents` hook is listening on -- a stub, not the real backend, named as such.
async function installSyntheticServerEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const instances: EventSource[] = [];

    class InstrumentedEventSource extends NativeEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict);
        instances.push(this);
      }
    }

    (window as unknown as { __dispatchServerEvent: (type: string, data: unknown) => void }).__dispatchServerEvent = (
      type,
      data,
    ) => {
      const payload = JSON.stringify(data);
      for (const instance of instances) {
        instance.dispatchEvent(new MessageEvent(type, { data: payload }));
      }
    };

    window.EventSource = InstrumentedEventSource;
  });
}

async function dispatchServerUpdated(page: Page, server: ServerViewFixture): Promise<void> {
  await page.evaluate((server) => {
    (window as unknown as { __dispatchServerEvent: (type: string, data: unknown) => void }).__dispatchServerEvent(
      'server.updated',
      { type: 'server.updated', server },
    );
  }, server);
}

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

test('@hostkey confirming with the exact name posts to trust-fingerprint exactly once, carrying the exact fingerprint the dialog displayed; success reflects PENDING with only Connect, and issues no automatic connect request', async ({
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
  // 05-31-PLAN.md hard rule 8a / gap 6: the POST must carry exactly the fingerprint this dialog
  // displayed -- never no body at all (the pre-05-31 contract) and never a different value.
  expect(trustRequests[0]?.postDataJSON()).toEqual({ fingerprint: OBSERVED_FINGERPRINT });
});

// 05-31-PLAN.md Task 2/3 (gap 6 / T-5G-27): the key regression this plan closes. A live
// `server.updated` SSE event swaps the pending fingerprint while the dialog is open for review --
// the dialog must keep showing (and sending) the value it displayed at open time, the backend's
// atomic conditional UPDATE (trust-fingerprint.ts, real behaviour proven by
// tests/integration/http/trust-fingerprint.test.ts and the real-backend test below, not by this
// stub) then genuinely refuses the stale value, and the dialog must close and re-render the banner
// with the new value rather than silently retrying or accepting it.
test('@hostkey a live server.updated event mid-review swaps the pending fingerprint; the dialog still sends what it displayed, a FINGERPRINT_MISMATCH closes it, and the banner re-renders with the new value', async ({
  page,
}) => {
  const SWAPPED_FINGERPRINT = 'SHA256:swapped0000000000000000000000000000000000';

  let current = buildServerViewFixture({
    id: '77777777-7777-4777-8777-777777777777',
    name: 'mid-review-swap-srv',
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
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/servers/${current.id}/trust-fingerprint`) && request.method() === 'POST') {
      trustRequests.push(request);
    }
  });

  // Stubbed 409 -- the real atomic conditional UPDATE that produces this response for a genuinely
  // stale value is proven against a real Postgres row by the real-backend test below and by
  // apps/control-plane's own trust-fingerprint integration coverage, not by this file. This test's
  // job is the client-side contract: what gets sent, and what the UI does with the response.
  await page.route(`**/api/servers/${current.id}/trust-fingerprint`, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'FINGERPRINT_MISMATCH',
        message: 'Submitted fingerprint no longer matches the server’s pending fingerprint',
      }),
    }),
  );

  await installSyntheticServerEvents(page);
  await login(page);
  await page.goto(`/servers/${current.id}`);
  await expect(page.getByTestId('shell-stream-status')).toHaveCount(0);

  await page.getByTestId('host-key-changed-banner').getByRole('button', { name: 'Trust new fingerprint' }).click();
  const dialog = page.getByTestId('trust-fingerprint-dialog');
  await expect(dialog).toContainText(`Observed: ${OBSERVED_FINGERPRINT}`);

  // The live swap: a real second HOST_KEY_CHANGED connect attempt landing mid-review would look
  // exactly like this from the browser's point of view.
  current = { ...current, pendingFingerprint: SWAPPED_FINGERPRINT, pendingFingerprintSeenAt: '2026-09-19T11:30:00.000Z' };
  await dispatchServerUpdated(page, current);

  // The dialog must keep showing what it displayed at open time, not the live swap.
  await expect(dialog).toContainText(`Observed: ${OBSERVED_FINGERPRINT}`);
  await expect(dialog).not.toContainText(SWAPPED_FINGERPRINT);

  await dialog.getByRole('textbox').fill('mid-review-swap-srv');
  await dialog.getByRole('button', { name: 'Trust new fingerprint' }).click();

  await expect.poll(() => trustRequests.length).toBe(1);
  // The POST must carry the snapshotted (stale) value, never the swapped live one.
  expect(trustRequests[0]?.postDataJSON()).toEqual({ fingerprint: OBSERVED_FINGERPRINT });

  // The dialog closes and the banner re-renders with the swapped value (onSettled's refetch) --
  // the admin must review the new value and re-type the name from scratch, never a silent retry.
  await expect(page.getByTestId('trust-fingerprint-dialog')).toHaveCount(0);
  await expect(page.getByTestId('host-key-changed-banner')).toContainText(`Observed: ${SWAPPED_FINGERPRINT}`);
  // Nothing was promoted -- the trusted fingerprint the banner shows is unchanged.
  await expect(page.getByTestId('host-key-changed-banner')).toContainText(`Trusted: ${TRUSTED_FINGERPRINT}`);
});

test('@hostkey UF-01/GR-02 regression: editing the host while ERROR/HOST_KEY_CHANGED clears the pending fingerprint AND the old host\'s trusted fingerprint, so the trust affordance disappears and nothing stale is left to promote', async ({
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
    // The pending fingerprint is gone rather than silently promotable (UF-01), and -- since
    // 05-40's GR-02 fix -- so is the trusted one: it was captured from the OLD host, and the row
    // now points at a different host identity, so keeping it would make the next connect a
    // spurious HOST_KEY_CHANGED instead of a clean TOFU first capture. This test used to pin
    // `hostFingerprint` as unchanged; edit-server.ts's `hostIdentityChanged` clear is the
    // deliberate replacement (tests/integration/services/edit-server.test.ts pins both halves).
    expect(afterEditBody.hostFingerprint).toBeNull();
    expect(afterEditBody.pendingFingerprint).toBeNull();
  } finally {
    await sshdA?.stop();
    await sshdB?.stop();
  }
});

// 05-31-PLAN.md Task 3 item (c): the one test in this file that proves the actual production bug
// this plan fixes is gone -- before this plan, `TrustFingerprintDialog.tsx` posted no body at all,
// so `POST /api/servers/:id/trust-fingerprint` (which plan 05-27 made require `{ fingerprint }`)
// rejected EVERY real trust attempt with 400 VALIDATION_FAILED, even though
// `tests/e2e/host-key.spec.ts`'s own "success" test above stayed green throughout (it stubs the
// POST and never inspected what the page actually sent). This test drives the whole flow --
// register, connect, a genuine host-key change, trust -- against the real control plane, worker
// and a real sshd Testcontainers fixture, with no stub anywhere on the trust-fingerprint route.
test('@hostkey the real trust-fingerprint POST succeeds end to end against the real backend, carrying the exact fingerprint the dialog displayed', async ({
  page,
}) => {
  test.setTimeout(180_000);

  let sshdA: SshdFixture | undefined;
  let sshdB: SshdFixture | undefined;

  try {
    sshdA = await startSshd({ ubuntu: '24.04', hostPort: REAL_TRUST_FLOW_HOST_PORT });

    await login(page);
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page.getByTestId('server-sheet')).toBeVisible();

    const name = `real-trust-flow-${String(Date.now())}`;
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

    const before = await page.request.get(`/api/servers/${serverId}`);
    const beforeBody = (await before.json()) as { hostFingerprint: string | null };
    const originalFingerprint = beforeBody.hostFingerprint;
    expect(originalFingerprint).not.toBeNull();

    // A real host-key change, the same technique the UF-01 test above uses: stop the first
    // container and start a second, fresh-keyed one on the exact same host:port.
    await sshdA.stop();
    sshdA = undefined;
    sshdB = await startSshd({ ubuntu: '24.04', hostPort: REAL_TRUST_FLOW_HOST_PORT });

    await page.getByTestId('server-detail-primary-action').click();
    const banner = page.getByTestId('host-key-changed-banner');
    await expect(banner).toBeVisible({ timeout: 45_000 });

    // Read the real pending fingerprint straight from the API rather than scraping the banner's
    // rendered text -- a real fingerprint carries an `ssh-ed25519 SHA256:...` algorithm prefix
    // (unlike this file's other, synthetic `SHA256:...`-only fixtures), and the banner interleaves
    // it with a "Copy" button and a relative-time label with no reliable text boundary to parse.
    // This is exactly the same value the dialog itself reads and displays (`server.pendingFingerprint`,
    // TrustFingerprintDialog.tsx), so asserting against it is equivalent to asserting against what
    // was shown on screen -- `toContainText` just below proves the banner rendered it too.
    const midway = await page.request.get(`/api/servers/${serverId}`);
    const midwayBody = (await midway.json()) as { pendingFingerprint: string | null };
    const observedFingerprint = midwayBody.pendingFingerprint;
    if (observedFingerprint === null) throw new Error('server has no pendingFingerprint after the host-key change');
    expect(observedFingerprint).not.toBe(originalFingerprint);
    await expect(banner).toContainText(observedFingerprint);

    const trustRequests: Request[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith(`/api/servers/${serverId}/trust-fingerprint`) && request.method() === 'POST') {
        trustRequests.push(request);
      }
    });

    await banner.getByRole('button', { name: 'Trust new fingerprint' }).click();
    const dialog = page.getByTestId('trust-fingerprint-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').fill(name);
    await dialog.getByRole('button', { name: 'Trust new fingerprint' }).click();

    // No stub anywhere on this route in this test -- a 400/409 here means the real backend
    // genuinely rejected the request, which fails the assertions below, never a false green.
    await expect(page.getByTestId('trust-fingerprint-dialog')).toHaveCount(0);
    await expect(page.getByTestId('status-pill')).toHaveAttribute('data-status', 'PENDING', { timeout: 15_000 });

    expect(trustRequests).toHaveLength(1);
    expect(trustRequests[0]?.postDataJSON()).toEqual({ fingerprint: observedFingerprint });

    const after = await page.request.get(`/api/servers/${serverId}`);
    const afterBody = (await after.json()) as {
      status: string;
      hostFingerprint: string | null;
      pendingFingerprint: string | null;
    };
    expect(afterBody.status).toBe('PENDING');
    expect(afterBody.hostFingerprint).toBe(observedFingerprint);
    expect(afterBody.pendingFingerprint).toBeNull();
  } finally {
    await sshdA?.stop();
    await sshdB?.stop();
  }
});
