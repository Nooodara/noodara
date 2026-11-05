// 30-01: server and service metrics and status in a real browser against the real stack. Server
// and service views are intercepted with page.route (ADR-0005, same as server-detail.spec.ts):
// producing real samples needs a connected host and minutes of collector ticks, which the
// collector's own integration tests already prove. Here the UI contract is proven: what each
// state says, which pills appear, and that the charts use the theme tokens in both themes.
import { expect, test, type Page, type Route } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const SERVER_ID = '5e000000-0000-4000-8000-000000000001';
const PROJECT_ID = '5e000000-0000-4000-8000-000000000002';
const ENVIRONMENT_ID = '5e000000-0000-4000-8000-000000000003';
const SERVICE_ID = '5e000000-0000-4000-8000-000000000004';
const DEPLOYMENT_ID = '5e000000-0000-4000-8000-000000000005';
const STAMP = '2026-11-01T00:00:00.000Z';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function series(scope: 'server' | 'service', entityId: string, metric: string, values: readonly (number | null)[]) {
  const end = Date.now();
  const start = end - values.length * 60_000;
  return {
    scope,
    entityId,
    metric,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    intervalSeconds: 60,
    points: values.map((v, index) => ({ t: new Date(start + index * 60_000).toISOString(), v })),
  };
}

function serverView(status: string) {
  return {
    id: SERVER_ID,
    name: 'metrics-e2e',
    host: 'example.test',
    sshPort: 22,
    sshUser: 'root',
    status,
    hostFingerprint: 'SHA256:abcdef1234567890',
    hostFingerprintCapturedAt: STAMP,
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
    lastSeenAt: new Date().toISOString(),
    lastErrorCode: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    credentialType: 'ssh_password',
  };
}

interface ServerMetricsFixture {
  readonly connectionState?: string;
  readonly series?: unknown[];
  readonly status?: number;
  readonly delayMs?: number;
}

const HEALTHY_SERVER_SERIES = [
  series('server', SERVER_ID, 'cpu_percent', [12, 18, null, 25, 22]),
  series('server', SERVER_ID, 'memory_percent', [80, 88, 91, 93, 94]),
  series('server', SERVER_ID, 'disk_used_percent', [90, 91, 92, 93, 95]),
];

async function stubServer(page: Page, fixture: ServerMetricsFixture = {}): Promise<void> {
  const connectionState = fixture.connectionState ?? 'CONNECTED';
  await page.route(`**/api/servers/${SERVER_ID}`, (route) => json(route, serverView(connectionState)));
  await page.route(`**/api/servers/${SERVER_ID}/metrics**`, async (route) => {
    if (fixture.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
    if (fixture.status !== undefined && fixture.status !== 200) {
      await json(route, { error: 'INTERNAL_ERROR', message: 'boom' }, fixture.status);
      return;
    }
    await json(route, {
      series: fixture.series ?? HEALTHY_SERVER_SERIES,
      server: {
        serverId: SERVER_ID,
        connectionState,
        lastSeenAt: new Date().toISOString(),
        uptimeSeconds: 93_784,
        sampledAt: new Date().toISOString(),
      },
    });
  });
}

async function openServer(page: Page): Promise<void> {
  await page.goto(`/servers/${SERVER_ID}`);
  await expect(page.getByTestId('server-metrics')).toBeVisible();
}

async function lineStroke(page: Page, testId: string): Promise<string> {
  return page
    .getByTestId(testId)
    .locator('path')
    .first()
    .evaluate((path) => getComputedStyle(path).stroke);
}

test.describe('server metrics', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('shows connection state, uptime and CPU, memory and disk charts with threshold pills', async ({ page }) => {
    await stubServer(page);
    await openServer(page);

    await expect(page.getByTestId('server-metrics-connection')).toHaveText('Connected');
    await expect(page.getByTestId('server-metrics-uptime')).toHaveText('1 day, 2 hours');
    await expect(page.getByTestId('server-metric-cpu-latest')).toHaveText('22%');
    await expect(page.getByTestId('server-metric-memory-latest')).toHaveText('94%');
    await expect(page.getByTestId('server-metric-disk-latest')).toHaveText('95%');

    // A gap breaks the CPU line in two; it is never interpolated.
    await expect(page.getByTestId('server-metric-cpu').locator('path')).toHaveCount(2);

    // High memory and high disk: a worded warn pill, and the line itself stays the accent colour.
    await expect(page.getByTestId('server-metric-memory-alert')).toHaveText('High memory');
    await expect(page.getByTestId('server-metric-memory-alert')).toHaveAttribute('data-tone', 'warn');
    await expect(page.getByTestId('server-metric-disk-alert')).toHaveText('High disk');
    await expect(page.getByTestId('server-metric-cpu-alert')).toHaveCount(0);
    expect(await lineStroke(page, 'server-metric-memory')).toBe(await lineStroke(page, 'server-metric-cpu'));

    // Hover: crosshair and tooltip with the value under the pointer.
    const svg = page.getByTestId('server-metric-cpu').locator('svg');
    const box = await svg.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
    await expect(page.getByTestId('server-metric-cpu-tooltip')).toContainText('22%');
    await expect(page.getByTestId('server-metric-cpu-crosshair')).toHaveCount(1);

    // Screen readers get the same data as a table.
    await expect(page.getByRole('table', { name: 'CPU' }).locator('tbody tr')).toHaveCount(4);
  });

  test('the chart line follows the accent token in light and dark themes', async ({ page }) => {
    await stubServer(page);
    await openServer(page);
    await expect(page.getByTestId('server-metric-cpu').locator('path').first()).toBeVisible();

    const read = () =>
      page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--accent)';
        document.body.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const path = document.querySelector('[data-testid="server-metric-cpu"] path');
        return { accent, stroke: path === null ? '' : getComputedStyle(path).stroke };
      });

    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });
    const light = await read();
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    const dark = await read();

    expect(light.stroke).toBe(light.accent);
    expect(dark.stroke).toBe(dark.accent);
    expect(dark.stroke).not.toBe(light.stroke);
  });

  test('says when there are no samples yet', async ({ page }) => {
    await stubServer(page, { series: [series('server', SERVER_ID, 'cpu_percent', [null, null])] });
    await openServer(page);
    await expect(page.getByTestId('server-metrics-empty')).toContainText('No metrics yet.');
    await expect(page.getByTestId('server-metrics-empty')).toContainText('Noodara collects a sample every minute');
  });

  test('keeps the last samples and says when the server is unreachable', async ({ page }) => {
    await stubServer(page, { connectionState: 'UNREACHABLE' });
    await openServer(page);
    await expect(page.getByTestId('server-metrics-unreachable')).toHaveText(
      "Noodara can't reach this server right now. The charts show the last samples it collected.",
    );
    await expect(page.getByTestId('server-metric-cpu')).toBeVisible();
  });

  test('says when a range was downsampled', async ({ page }) => {
    await stubServer(page, {
      series: [series('server', SERVER_ID, 'cpu_percent', Array.from({ length: 500 }, (_, index) => index % 100))],
    });
    await openServer(page);
    await expect(page.getByTestId('server-metrics-truncated')).toHaveText(
      'This range has more samples than fit on a chart, so they are averaged into 500 points.',
    );
  });

  test('shows a skeleton while loading, then fixed copy when the read fails', async ({ page }) => {
    await stubServer(page, { status: 500, delayMs: 1_500 });
    await page.goto(`/servers/${SERVER_ID}`);
    await expect(page.getByTestId('server-metrics-loading')).toBeVisible();
    await expect(page.getByTestId('server-metrics-error')).toContainText(
      "Couldn't load metrics. Check your connection and try again.",
    );
    await expect(page.getByTestId('server-metrics-error')).not.toContainText('boom');
  });
});

interface ServiceFixture {
  readonly status: Record<string, unknown>;
  readonly series: unknown[];
}

async function stubService(page: Page, fixture: ServiceFixture): Promise<void> {
  await page.route(`**/api/projects/${PROJECT_ID}`, (route) =>
    json(route, { id: PROJECT_ID, name: 'Metrics', slug: 'metrics', description: null, archivedAt: null, createdAt: STAMP, updatedAt: STAMP }),
  );
  await page.route(`**/api/projects/${PROJECT_ID}/services/${SERVICE_ID}`, (route) =>
    json(route, {
      id: SERVICE_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serverId: SERVER_ID,
      name: 'api',
      sourceType: 'image',
      repositoryUrl: null,
      branch: null,
      buildContext: null,
      dockerfilePath: null,
      buildTarget: null,
      imageRef: 'nginx:1.27',
      internalPort: 80,
      publishedPort: 8080,
      status: 'RUNNING',
      createdAt: STAMP,
      updatedAt: STAMP,
    }),
  );
  await page.route(`**/api/projects/${PROJECT_ID}/services/${SERVICE_ID}/status`, (route) => json(route, fixture.status));
  await page.route(`**/api/projects/${PROJECT_ID}/services/${SERVICE_ID}/metrics**`, (route) =>
    json(route, { series: fixture.series }),
  );
  await page.route(`**/api/services/${SERVICE_ID}/deployments**`, (route) => json(route, { items: [], nextCursor: null }));
}

function serviceStatus(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: SERVICE_ID,
    runtimeStatus: 'RUNNING',
    container: { state: 'running', restartCount: 4, healthcheck: 'healthy', observedAt: new Date().toISOString() },
    lastDeployment: { id: DEPLOYMENT_ID, status: 'SUCCESS', commitSha: 'abcdef1234567', finishedAt: new Date().toISOString() },
    flags: { highMemory: true, highDisk: false },
    ...overrides,
  };
}

test.describe('service status and metrics', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('shows container state, restarts, health, last deployment, runtime status and charts', async ({ page }) => {
    await stubService(page, {
      status: serviceStatus(),
      series: [
        series('service', SERVICE_ID, 'cpu_percent', [3, 4, 5]),
        series('service', SERVICE_ID, 'memory_percent', [91, 92, 93]),
        series('service', SERVICE_ID, 'restart_count', [2, 3, 4]),
      ],
    });
    await page.goto(`/projects/${PROJECT_ID}/services/${SERVICE_ID}`);

    await expect(page.getByTestId('service-status-runtime')).toHaveText('Running');
    await expect(page.getByTestId('service-status-container')).toHaveText('Running');
    await expect(page.getByTestId('service-status-restarts')).toHaveText('4');
    await expect(page.getByTestId('service-status-health')).toHaveText('Healthy');
    await expect(page.getByTestId('service-status-last-deployment')).toContainText('Success');
    await expect(page.getByTestId('service-status-last-deployment')).toContainText('abcdef1');
    await expect(page.getByTestId('service-metric-restarts-latest')).toHaveText('4');
    await expect(page.getByTestId('service-metric-memory-alert')).toHaveText('High memory');
    await expect(page.getByTestId('service-metric-memory-alert')).toHaveAttribute('data-tone', 'warn');
    await expect(page.getByTestId('service-status-high-disk')).toHaveCount(0);
  });

  test('explains a service that was never deployed', async ({ page }) => {
    await stubService(page, {
      status: serviceStatus({
        runtimeStatus: 'NEVER_DEPLOYED',
        container: null,
        lastDeployment: null,
        flags: { highMemory: false, highDisk: false },
      }),
      series: [],
    });
    await page.goto(`/projects/${PROJECT_ID}/services/${SERVICE_ID}`);

    await expect(page.getByTestId('service-status-container')).toHaveText('No container');
    await expect(page.getByTestId('service-status-last-deployment')).toHaveText('None yet');
    await expect(page.getByTestId('service-metrics-empty')).toContainText('No metrics yet.');
  });
});
