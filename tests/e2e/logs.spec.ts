// 30-02: the unified logs view of a service in a real browser against the real stack. The service
// and its logs routes are intercepted with page.route (ADR-0005, same as metrics.spec.ts): the
// logs API itself is proven by its integration tests (27-04). Here the UI contract: sources,
// filters, search, follow, the explained states, inert rendering and virtualization.
import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const SERVER_ID = '5f000000-0000-4000-8000-000000000001';
const PROJECT_ID = '5f000000-0000-4000-8000-000000000002';
const ENVIRONMENT_ID = '5f000000-0000-4000-8000-000000000003';
const SERVICE_ID = '5f000000-0000-4000-8000-000000000004';
const STAMP = '2026-11-01T00:00:00.000Z';
const PROJECT_NAME = 'Logs E2E';
const SEARCH_MAX = 200;

type Source = 'build' | 'deploy' | 'runtime' | 'activity';

interface Entry {
  readonly source: Source;
  readonly timestamp: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly stream: 'stdout' | 'stderr' | null;
  readonly text: string;
  readonly truncated: boolean;
}

function entry(text: string, source: Source = 'runtime', extra: Partial<Entry> = {}): Entry {
  return {
    source,
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    level: 'info',
    stream: source === 'runtime' ? 'stdout' : null,
    text,
    truncated: false,
    ...extra,
  };
}

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

function isEntries(url: URL): boolean {
  return url.pathname === `/api/projects/${PROJECT_ID}/services/${SERVICE_ID}/logs/entries`;
}

function isFollow(url: URL): boolean {
  return url.pathname === `/api/projects/${PROJECT_ID}/services/${SERVICE_ID}/logs/entries/follow`;
}

interface PageFixture {
  readonly entries?: readonly Entry[];
  readonly truncated?: boolean;
  readonly unavailableSources?: readonly Source[];
  readonly status?: number;
}

async function stubService(page: Page, fixture: PageFixture = {}): Promise<URL[]> {
  const requests: URL[] = [];
  await page.route(`**/api/projects/${PROJECT_ID}`, (route) =>
    json(route, { id: PROJECT_ID, name: PROJECT_NAME, slug: 'logs-e2e', description: null, archivedAt: null, createdAt: STAMP, updatedAt: STAMP }),
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
  await page.route(`**/api/projects/${PROJECT_ID}/services/${SERVICE_ID}/metrics**`, (route) => json(route, { series: [] }));
  await page.route(`**/api/services/${SERVICE_ID}/deployments**`, (route) => json(route, { items: [], nextCursor: null }));
  await page.route(isEntries, async (route) => {
    requests.push(new URL(route.request().url()));
    if (fixture.status !== undefined && fixture.status !== 200) {
      await json(route, { error: 'LOG_SOURCE_UNAVAILABLE', message: 'raw server text' }, fixture.status);
      return;
    }
    await json(route, {
      entries: [...(fixture.entries ?? [])].reverse(),
      since: new Date(Date.now() - 15 * 60_000).toISOString(),
      until: new Date().toISOString(),
      nextUntil: null,
      unavailableSources: fixture.unavailableSources ?? [],
      nextCursor: null,
      truncated: fixture.truncated ?? false,
    });
  });
  return requests;
}

async function openService(page: Page): Promise<void> {
  await page.goto(`/projects/${PROJECT_ID}/services/${SERVICE_ID}`);
  await expect(page.getByTestId('service-logs-view')).toBeVisible();
}

function followBody(entries: readonly Entry[], end: string | null): string {
  const frames = entries.map((e) => JSON.stringify({ type: 'entry', entry: e }));
  if (end !== null) frames.push(JSON.stringify({ type: 'end', reason: end }));
  return frames.join('\n') + '\n';
}

test.describe('service logs', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('A1: source chips, window, level, search and mono timestamps; source on every line', async ({ page }) => {
    const requests = await stubService(page, {
      entries: [
        entry('docker build step 1/4', 'build'),
        entry('container started', 'deploy'),
        entry('GET /health 200', 'runtime'),
        entry('Service deployed by admin', 'activity', { level: 'warn' }),
      ],
    });
    await openService(page);

    const lines = page.getByTestId('log-line');
    await expect(lines).toHaveCount(4);
    await expect(page.getByTestId('log-line-source')).toHaveText(['Build', 'Deploy', 'Runtime', 'Activity']);
    const time = lines.first().getByTestId('log-line-time');
    await expect(time).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    const fonts = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="log-line-time"]');
      const probe = document.createElement('span');
      probe.style.fontFamily = 'var(--font-mono)';
      document.body.append(probe);
      const mono = getComputedStyle(probe).fontFamily;
      probe.remove();
      return { time: t === null ? '' : getComputedStyle(t).fontFamily, mono };
    });
    expect(fonts.time).toBe(fonts.mono);

    for (const source of ['build', 'deploy', 'runtime', 'activity']) {
      await expect(page.getByTestId(`log-source-${source}`)).toHaveAttribute('aria-pressed', 'true');
    }
    expect(requests.at(-1)?.searchParams.get('sources')).toBe('build,deploy,runtime,activity');

    await page.getByTestId('log-source-build').click();
    await expect(page.getByTestId('log-source-build')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => requests.at(-1)?.searchParams.get('sources')).toBe('deploy,runtime,activity');

    await page.getByTestId('log-level').getByRole('radio', { name: 'Warn' }).click();
    await expect.poll(() => requests.at(-1)?.searchParams.get('level')).toBe('warn');

    await page.getByTestId('log-window').getByRole('radio', { name: '6h' }).click();
    await expect
      .poll(() => {
        const since = requests.at(-1)?.searchParams.get('since');
        return since == null ? 0 : Date.now() - Date.parse(since);
      })
      .toBeGreaterThan(5 * 60 * 60_000);

    await page.getByTestId('log-search').fill('health');
    await expect.poll(() => requests.at(-1)?.searchParams.get('search')).toBe('health');
    await expect(page.getByTestId('log-follow')).toBeVisible();
  });

  test('A2: truncated, truncated-line and source-unavailable states are explained', async ({ page }) => {
    await stubService(page, {
      entries: [entry('x'.repeat(100), 'runtime', { truncated: true })],
      truncated: true,
      unavailableSources: ['runtime'],
    });
    await openService(page);
    await expect(page.getByTestId('log-truncated')).toContainText('Showing the newest lines only');
    await expect(page.getByTestId('log-unavailable')).toContainText('Runtime is unavailable right now');
    await expect(page.getByTestId('log-line-truncated')).toHaveText('Line truncated');
  });

  test('A2: every selected source unavailable is explained without server text', async ({ page }) => {
    await stubService(page, { status: 502 });
    await openService(page);
    await expect(page.getByTestId('log-all-unavailable')).toContainText("Noodara couldn't read any of the selected sources");
    await expect(page.getByTestId('service-logs-view')).not.toContainText('raw server text');
  });

  test('A2: follow appends, and closing the view leaves no open stream', async ({ page }) => {
    await page.addInitScript(() => {
      const signals: AbortSignal[] = [];
      (window as unknown as { __followSignals: AbortSignal[] }).__followSignals = signals;
      const original = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/logs/entries/follow') && init?.signal) signals.push(init.signal);
        return original(input, init);
      };
    });
    await stubService(page, { entries: [entry('before follow')] });
    let held: Route | null = null;
    await page.route(isFollow, (route) => {
      held = route;
    });
    const failed: Request[] = [];
    page.on('requestfailed', (request) => {
      if (isFollow(new URL(request.url()))) failed.push(request);
    });
    await openService(page);
    await expect(page.getByText('before follow')).toBeVisible();

    await page.getByRole('switch', { name: 'Follow' }).click();
    await expect.poll(() => held !== null).toBe(true);
    const openCount = () =>
      page.evaluate(() => (window as unknown as { __followSignals: AbortSignal[] }).__followSignals.filter((s) => !s.aborted).length);
    await expect.poll(openCount).toBe(1);

    // Close the view: navigate back to the project inside the app.
    await page.getByRole('link', { name: `← ${PROJECT_NAME}` }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}$`));
    await expect(page.getByTestId('service-logs-view')).toHaveCount(0);
    await expect.poll(openCount).toBe(0);
    await expect.poll(() => failed.length).toBe(1);
  });

  test('A2: a follow that ends on its own turns Follow off and says why', async ({ page }) => {
    await stubService(page, { entries: [] });
    await page.route(isFollow, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: followBody([entry('live line', 'runtime')], 'idle'),
      }),
    );
    await openService(page);
    await page.getByRole('switch', { name: 'Follow' }).click();
    await expect(page.getByText('live line')).toBeVisible();
    await expect(page.getByTestId('log-follow-notice')).toContainText('Follow stopped');
    await expect(page.getByRole('switch', { name: 'Follow' })).toHaveAttribute('aria-checked', 'false');
  });

  test('H1: hostile lines render inert, 10k lines stay virtualized, search is capped', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const hostile = [
      entry('<img src=x onerror="alert(1)">', 'runtime'),
      entry('\u001b[31mred\u001b[0m plain', 'runtime'),
      entry('click javascript:alert(2) now', 'runtime'),
    ];
    const requests = await stubService(page, { entries: hostile });
    // 3 hostile + 9,997 streamed = exactly the 10k buffer cap, so nothing is dropped.
    const many = Array.from({ length: 9_997 }, (_, i) => entry(`bulk line ${String(i)}`, 'runtime'));
    await page.route(isFollow, (route) =>
      route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: followBody(many, 'idle') }),
    );
    await openService(page);

    const logs = page.getByTestId('service-logs-view');
    await expect(page.getByTestId('log-line-text').first()).toHaveText('<img src=x onerror="alert(1)">');
    await expect(page.getByTestId('log-line-text').nth(1)).toHaveText('\u001b[31mred\u001b[0m plain');
    await expect(page.getByTestId('log-line-text').nth(2)).toHaveText('click javascript:alert(2) now');
    await expect(logs.locator('img')).toHaveCount(0);
    await expect(logs.locator('a')).toHaveCount(0);
    expect(dialogs).toEqual([]);

    await page.getByRole('switch', { name: 'Follow' }).click();
    await expect(page.getByTestId('log-list')).toHaveAttribute('data-count', '10000');
    await expect(page.getByText('bulk line 9996')).toBeVisible();
    expect(await page.getByTestId('log-line').count()).toBeLessThan(100);

    // Responsive: jumping to the top renders the first lines within a frame budget.
    const started = Date.now();
    await page.getByTestId('log-scroller').evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(page.getByTestId('log-line-text').first()).toHaveText('<img src=x onerror="alert(1)">');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await page.getByTestId('log-line').count()).toBeLessThan(100);

    const search = page.getByTestId('log-search');
    await expect(search).toHaveAttribute('maxlength', String(SEARCH_MAX));
    await search.fill('a'.repeat(SEARCH_MAX + 50));
    await expect(search).toHaveValue('a'.repeat(SEARCH_MAX));
    await expect.poll(() => requests.at(-1)?.searchParams.get('search')?.length).toBe(SEARCH_MAX);
    expect(dialogs).toEqual([]);
  });
});
