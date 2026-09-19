// 05-18-PLAN.md Task 3: the Discovery section (DISC-02, D-05..D-08), verified in a real browser.
// Six `@discovery` behaviours use `page.route` interception (ADR-0005's established pattern,
// matching tests/e2e/server-detail.spec.ts's own precedent) since scripting a real multi-check
// discovery run's every intermediate state through the real backend is impractical to pin
// deterministically. A seventh, separately tagged test (`@ssh-live`, deliberately not matching a
// literal `--grep @discovery`, mirroring Plan 05-12's own `@sse-live` precedent) drives a real
// connect-and-discover run against a real sshd Testcontainers fixture end to end -- the one thing
// route interception cannot prove: that genuine, time-separated `server.discovery_progress` SSE
// frames reach a real, already-mounted browser page and it never needs a reload to reflect them.
import { expect, test, type Page, type Request } from '@playwright/test';
import { DISCOVERY_CHECK_IDS, type DiscoveryCheck, type DiscoveryCheckStatus } from '@noodara/domain/discovery';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';
import { startSshd, type SshdFixture } from '../integration/helpers/ssh.js';

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

// Same shape/defaults as tests/e2e/server-detail.spec.ts's own `buildServerViewFixture` -- no
// shared builder exists across e2e specs yet, matching that file's own documented precedent.
function buildServerViewFixture(overrides: ServerViewFixtureOverrides): ServerViewFixture {
  return {
    host: 'example.test',
    sshPort: 22,
    sshUser: 'deployer',
    status: 'CONNECTED',
    hostFingerprint: 'SHA256:abcdef1234567890',
    hostFingerprintCapturedAt: '2026-09-01T00:00:00.000Z',
    pendingFingerprint: null,
    pendingFingerprintSeenAt: null,
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
    lastSeenAt: '2026-09-19T11:58:00.000Z',
    lastErrorCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    credentialType: 'ssh_password',
    ...overrides,
  };
}

async function stubServer(page: Page, fixture: ServerViewFixture): Promise<void> {
  await page.route(`**/api/servers/${fixture.id}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }),
  );
}

type DiscoveryCheckOverrides = Partial<Record<(typeof DISCOVERY_CHECK_IDS)[number], Partial<DiscoveryCheck>>>;

/** Every one of the eleven checks, `pass` by default, in `DISCOVERY_CHECK_IDS` order -- the same
 *  order `discovery-progress.ts`'s own reducer assumes. */
function buildDiscoveryChecks(overrides: DiscoveryCheckOverrides = {}): DiscoveryCheck[] {
  return DISCOVERY_CHECK_IDS.map((id) => {
    const status: DiscoveryCheckStatus = 'pass';
    return { id, status, detail: `${id} ok`, durationMs: 8, ...overrides[id] };
  });
}

interface DiscoveryReadFixture {
  readonly collectedAt: string | null;
  readonly outcome: 'ok' | 'partial' | 'failed' | null;
  readonly checks: DiscoveryCheck[];
  readonly warnings: string[];
}

async function stubDiscoveryRead(page: Page, serverId: string, fixture: DiscoveryReadFixture): Promise<void> {
  await page.route(`**/api/servers/${serverId}/discovery`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }),
  );
}

const SETTLED_DISCOVERY: DiscoveryReadFixture = {
  collectedAt: '2026-09-19T12:00:00.000Z',
  outcome: 'ok',
  checks: buildDiscoveryChecks(),
  warnings: [],
};

test('@discovery a settled run renders the one-line summary that expands to six steps', async ({ page }) => {
  const fixture = buildServerViewFixture({ id: '88888888-8888-4888-8888-888888888881', name: 'settled-summary-srv' });
  await stubServer(page, fixture);
  await stubDiscoveryRead(page, fixture.id, SETTLED_DISCOVERY);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  const summary = page.getByTestId('discovery-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('Discovered');
  await expect(summary).toContainText('passed');

  for (const stepId of ['ssh_reachable', 'authenticated', 'os', 'resources', 'docker', 'access']) {
    await expect(page.getByTestId(`discovery-step-${stepId}`)).toHaveCount(0);
  }

  await summary.click();

  for (const stepId of ['ssh_reachable', 'authenticated', 'os', 'resources', 'docker', 'access']) {
    await expect(page.getByTestId(`discovery-step-${stepId}`)).toBeVisible();
  }
});

test('@discovery expanding a step reveals its checks with mono detail and durationMs', async ({ page }) => {
  const fixture = buildServerViewFixture({ id: '88888888-8888-4888-8888-888888888882', name: 'expand-step-srv' });
  await stubServer(page, fixture);
  await stubDiscoveryRead(page, fixture.id, SETTLED_DISCOVERY);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  await page.getByTestId('discovery-summary').click();

  const osStep = page.getByTestId('discovery-step-os');
  await expect(page.getByTestId('discovery-check-hostname')).toHaveCount(0);
  await osStep.getByRole('button').click();

  const hostnameCheck = page.getByTestId('discovery-check-hostname');
  await expect(hostnameCheck).toBeVisible();
  await expect(hostnameCheck.locator('[data-mono="true"]').last()).toContainText('8ms');
});

test('@discovery a mid-run page load shows all discovery steps pending/running, the in-progress caption, and none of the previous run', async ({
  page,
}) => {
  const fixture = buildServerViewFixture({
    id: '88888888-8888-4888-8888-888888888883',
    name: 'mid-run-srv',
    status: 'CONNECTING',
  });
  await stubServer(page, fixture);
  await stubDiscoveryRead(page, fixture.id, {
    collectedAt: '2026-09-19T10:00:00.000Z',
    outcome: 'ok',
    checks: buildDiscoveryChecks({ hostname: { detail: 'Hostname: STALE-PREVIOUS-RUN-VALUE' } }),
    warnings: [],
  });

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  await expect(page.getByText('A new discovery run is in progress')).toBeVisible();
  await expect(page.getByTestId('discovery-summary')).toHaveCount(0);
  await expect(page.getByText('STALE-PREVIOUS-RUN-VALUE')).toHaveCount(0);

  for (const stepId of ['os', 'resources', 'docker', 'access']) {
    const severity = await page.getByTestId(`discovery-step-${stepId}`).getAttribute('data-severity');
    expect(['pending', 'running']).toContain(severity);
  }
});

test('@discovery a run whose Docker check failed renders amber with the SS5.5 consequence copy, Connected stays, no error banner', async ({
  page,
}) => {
  const fixture = buildServerViewFixture({ id: '88888888-8888-4888-8888-888888888884', name: 'docker-warning-srv' });
  await stubServer(page, fixture);
  await stubDiscoveryRead(page, fixture.id, {
    collectedAt: '2026-09-19T12:00:00.000Z',
    outcome: 'partial',
    checks: buildDiscoveryChecks({
      docker_version: { status: 'fail', detail: 'Docker is not installed on this server.' },
      docker_compose_version: { status: 'skipped', detail: 'Skipped: Docker is not installed on this server.' },
    }),
    warnings: [],
  });

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  await expect(page.getByTestId('status-pill')).toHaveAttribute('data-status', 'CONNECTED');
  await expect(page.getByTestId('server-detail-error-banner')).toHaveCount(0);

  await page.getByTestId('discovery-summary').click();

  const dockerStep = page.getByTestId('discovery-step-docker');
  await expect(dockerStep).toHaveAttribute('data-severity', 'warning');
  await expect(
    page.getByText('Docker is not installed on this server. Install Docker to prepare it for future deployments.'),
  ).toBeVisible();
});

test('@discovery every step exposes its status word in text', async ({ page }) => {
  const fixture = buildServerViewFixture({ id: '88888888-8888-4888-8888-888888888885', name: 'status-words-srv' });
  await stubServer(page, fixture);
  await stubDiscoveryRead(page, fixture.id, SETTLED_DISCOVERY);

  await login(page);
  await page.goto(`/servers/${fixture.id}`);
  await page.getByTestId('discovery-summary').click();

  for (const stepId of ['ssh_reachable', 'authenticated', 'os', 'resources', 'docker', 'access']) {
    await expect(page.getByTestId(`discovery-step-${stepId}`)).toContainText('Pass');
  }
});

test('@discovery Re-run discovery issues POST /discover exactly once and never polls a job endpoint', async ({ page }) => {
  const fixture = buildServerViewFixture({ id: '88888888-8888-4888-8888-888888888886', name: 'rerun-srv' });
  await stubServer(page, fixture);
  await stubDiscoveryRead(page, fixture.id, SETTLED_DISCOVERY);

  const discoverRequests: Request[] = [];
  const jobRequests: Request[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/api/servers/${fixture.id}/discover`) && request.method() === 'POST') {
      discoverRequests.push(request);
    }
    if (request.url().includes('/jobs/')) {
      jobRequests.push(request);
    }
  });

  await page.route(`**/api/servers/${fixture.id}/discover`, (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ server: { ...fixture, status: 'CONNECTING' }, jobId: `connect-${fixture.id}` }),
    }),
  );

  await login(page);
  await page.goto(`/servers/${fixture.id}`);

  await page.getByTestId('discovery-rerun-button').click();

  await expect.poll(() => discoverRequests.length).toBe(1);
  expect(jobRequests).toHaveLength(0);
});

test('@ssh-live a real connect-and-discover run against a real sshd fixture delivers live, time-separated per-check SSE progress into the already-mounted browser page, with no reload', async ({
  page,
}) => {
  const sshd: SshdFixture = await startSshd({ ubuntu: '24.04' });

  try {
    // A subclassed EventSource that adds its own independent `server.discovery_progress`
    // listener in its constructor, alongside (never replacing) whatever listener the app's own
    // `useServerEvents` hook registers on the same instance -- EventTarget supports any number of
    // independent listeners per type, so this purely observes, it never changes what the real app
    // receives or when. Proof the real SSE pipeline, not this test, produced these events.
    await page.addInitScript(() => {
      const events: { receivedAt: number; checkId: string }[] = [];
      (window as unknown as { __progressEvents: typeof events }).__progressEvents = events;
      const NativeEventSource = window.EventSource;

      class InstrumentedEventSource extends NativeEventSource {
        constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
          super(url, eventSourceInitDict);
          this.addEventListener('server.discovery_progress', (event) => {
            try {
              const data = JSON.parse((event as MessageEvent<string>).data) as { check?: { id?: string } };
              if (typeof data.check?.id === 'string') {
                events.push({ receivedAt: performance.now(), checkId: data.check.id });
              }
            } catch {
              // Malformed frame -- irrelevant to this instrumentation, the real parser handles it.
            }
          });
        }
      }

      window.EventSource = InstrumentedEventSource;
    });

    test.setTimeout(120_000);

    await login(page);
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page.getByTestId('server-sheet')).toBeVisible();

    const name = `ssh-live-${String(Date.now())}`;
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Host').fill(sshd.host);
    await page.getByLabel('SSH port').fill(String(sshd.port));
    await page.getByLabel('SSH user').fill('pwuser');
    await page.getByTestId('server-sheet-credential-type').getByRole('radio', { name: 'Password' }).click();
    await page.getByLabel('Password').fill(sshd.password);

    // The same, already-mounted page instance stays open from here through settlement -- no
    // reload anywhere in this test. If the live SSE pipeline were broken, this page would stay
    // stuck on its initial CONNECTING/pending render forever.
    await page.getByTestId('server-sheet-save-connect').click();
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/);

    await expect(page.getByTestId('status-pill')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 45_000 });
    await expect(page.getByTestId('discovery-summary')).toBeVisible();
    await expect(page.getByTestId('discovery-summary')).toContainText('Discovered');

    await page.getByTestId('discovery-summary').click();
    // pwuser is non-root with no sudoers entry and not in the docker group (tests/integration/
    // images/sshd-common/setup-users.sh) -- Access renders warning, proving this run's real,
    // per-check facts (not fabricated ones) reached the browser.
    await expect(page.getByTestId('discovery-step-access')).toHaveAttribute('data-severity', 'warning');
    await expect(page.getByTestId('discovery-step-os')).toHaveAttribute('data-severity', 'pass');

    const progressEvents = await page.evaluate(
      () => (window as unknown as { __progressEvents: { receivedAt: number; checkId: string }[] }).__progressEvents,
    );

    // Eleven distinct checks, in the real DISCOVERY_CHECK_IDS order, each a separate SSE frame --
    // never one atomic batch standing in for "live" progress.
    expect(progressEvents.map((e) => e.checkId)).toEqual([...DISCOVERY_CHECK_IDS]);
    // Genuinely time-separated arrivals (not all delivered in the same JS turn) -- real evidence
    // this was incremental, not a single settle payload replayed as if it were a stream.
    expect(new Set(progressEvents.map((e) => e.receivedAt)).size).toBeGreaterThan(1);
  } finally {
    await sshd.stop();
  }
});
