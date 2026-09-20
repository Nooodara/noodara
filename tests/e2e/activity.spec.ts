// 05-15-PLAN.md Task 3: the activity log screen (ACT-02), verified in a real browser. Runs against
// the same real stack.ts stack smoke.spec.ts/auth.spec.ts/servers-list.spec.ts/server-detail.spec.ts
// use (Postgres, Redis, the API, the worker, the built web app), with the preseeded E2E admin.
//
// Every test below authenticates through the real login flow (a real session cookie is required
// to reach `/activity` at all -- the shell's own client-side guard redirects otherwise) but
// intercepts `**/api/activity*` for determinism, matching tests/e2e/servers-list.spec.ts's and
// tests/e2e/server-detail.spec.ts's own established `page.route` precedent (ADR-0005). This
// includes the "only the admin's sign-in" case: the shared E2E stack boots with
// `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` set (tests/e2e/fixtures/stack.ts), which writes
// its own real `auth.admin_preseeded` activity event during boot, before any spec's own login --
// asserting "only the sign-in" against the raw, unstubbed backend would be false the moment a
// second spec file also exercises this same shared stack, regardless of which file happens to run
// first. Stubbing keeps this assertion deterministic and independent of suite-wide ordering.
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

interface ActivityItemFixture {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorType: 'user' | 'system';
  readonly actorId: string | null;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly action: string;
  readonly outcome: 'success' | 'failure';
  readonly errorCode: string | null;
  readonly metadata: unknown;
}

type ActivityItemFixtureOverrides = Partial<ActivityItemFixture> & Pick<ActivityItemFixture, 'id' | 'action'>;

function buildActivityItemFixture(overrides: ActivityItemFixtureOverrides): ActivityItemFixture {
  return {
    occurredAt: new Date().toISOString(),
    actorType: 'user',
    actorId: 'e2e-admin',
    entityType: 'server',
    entityId: null,
    outcome: 'success',
    errorCode: null,
    metadata: {},
    ...overrides,
  };
}

interface ActivityResponseFixture {
  readonly items: readonly ActivityItemFixture[];
  readonly nextCursor: string | null;
}

async function stubActivityOnce(page: Page, body: ActivityResponseFixture): Promise<void> {
  await page.route('**/api/activity*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

test('@activity a stack whose only activity is the admin sign-in shows one TODAY row and no Load older button', async ({
  page,
}) => {
  await login(page);
  await stubActivityOnce(page, {
    items: [
      buildActivityItemFixture({
        id: 'evt-signin',
        action: 'auth.login_succeeded',
        metadata: { email: E2E_ADMIN_EMAIL, ip: '127.0.0.1' },
      }),
    ],
    nextCursor: null,
  });

  await page.goto('/activity');

  await expect(page.getByText('TODAY')).toBeVisible();
  await expect(page.getByTestId('activity-row').filter({ hasText: 'Admin signed in' })).toBeVisible();
  await expect(page.getByTestId('activity-row')).toHaveCount(1);
  await expect(page.getByTestId('activity-load-older')).toHaveCount(0);
});

test('@activity Load older appends the next page while the previously loaded rows remain, in order', async ({ page }) => {
  await login(page);

  // Explicit, deliberately-ordered timestamps -- alpha newest, gamma oldest -- rather than
  // `new Date()` evaluated at each fixture's own construction time. Page 2's fixture is built
  // inside the route handler, which only runs *after* "Load older" is clicked (later in wall-clock
  // time than page 1's own fixtures); without an explicit older `occurredAt`, gamma would sort
  // newest-first ahead of alpha/beta -- a fixture-timing bug, not a production ordering bug
  // (`groupByDay` sorts strictly by `occurredAt`, matching a real backend's own newest-first pages).
  const now = Date.now();
  const alphaAt = new Date(now - 1_000).toISOString();
  const betaAt = new Date(now - 2_000).toISOString();
  const gammaAt = new Date(now - 3_000).toISOString();

  await page.route('**/api/activity*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('cursor')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            buildActivityItemFixture({
              id: 'evt-3',
              action: 'server.deleted',
              occurredAt: gammaAt,
              metadata: { name: 'server-gamma', host: 'gamma.example.test' },
            }),
          ],
          nextCursor: null,
        } satisfies ActivityResponseFixture),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          buildActivityItemFixture({
            id: 'evt-1',
            action: 'server.deleted',
            occurredAt: alphaAt,
            metadata: { name: 'server-alpha', host: 'alpha.example.test' },
          }),
          buildActivityItemFixture({
            id: 'evt-2',
            action: 'server.deleted',
            occurredAt: betaAt,
            metadata: { name: 'server-beta', host: 'beta.example.test' },
          }),
        ],
        nextCursor: 'opaque-page-2-cursor',
      } satisfies ActivityResponseFixture),
    });
  });

  await page.goto('/activity');

  await expect(page.getByText('Admin deleted server server-alpha')).toBeVisible();
  await expect(page.getByText('Admin deleted server server-beta')).toBeVisible();
  await expect(page.getByTestId('activity-row')).toHaveCount(2);

  await page.getByTestId('activity-load-older').click();

  await expect(page.getByText('Admin deleted server server-gamma')).toBeVisible();
  await expect(page.getByTestId('activity-row')).toHaveCount(3);
  // The previously loaded rows are still present and still ordered before the newly appended one.
  const rows = page.getByTestId('activity-row');
  await expect(rows.nth(0)).toContainText('server-alpha');
  await expect(rows.nth(1)).toContainText('server-beta');
  await expect(rows.nth(2)).toContainText('server-gamma');
  await expect(page.getByTestId('activity-load-older')).toHaveCount(0);
});

test('@activity a failed background refresh keeps every already-loaded row on screen (WR-B-04)', async ({ page }) => {
  await login(page);

  const now = Date.now();
  const alphaAt = new Date(now - 1_000).toISOString();
  const betaAt = new Date(now - 2_000).toISOString();
  const gammaAt = new Date(now - 3_000).toISOString();

  let refreshShouldFail = false;
  let backgroundRefreshFailureCount = 0;

  await page.route('**/api/activity*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('cursor')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            buildActivityItemFixture({
              id: 'evt-refresh-fail-gamma',
              action: 'server.deleted',
              occurredAt: gammaAt,
              metadata: { name: 'refresh-fail-gamma', host: 'gamma.example.test' },
            }),
          ],
          nextCursor: null,
        } satisfies ActivityResponseFixture),
      });
    }
    if (refreshShouldFail) {
      backgroundRefreshFailureCount += 1;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'stubbed background refresh failure' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          buildActivityItemFixture({
            id: 'evt-refresh-fail-alpha',
            action: 'server.deleted',
            occurredAt: alphaAt,
            metadata: { name: 'refresh-fail-alpha', host: 'alpha.example.test' },
          }),
          buildActivityItemFixture({
            id: 'evt-refresh-fail-beta',
            action: 'server.deleted',
            occurredAt: betaAt,
            metadata: { name: 'refresh-fail-beta', host: 'beta.example.test' },
          }),
        ],
        nextCursor: 'opaque-page-2-cursor',
      } satisfies ActivityResponseFixture),
    });
  });

  await page.goto('/activity');
  await expect(page.getByTestId('activity-row')).toHaveCount(2);

  await page.getByTestId('activity-load-older').click();
  await expect(page.getByTestId('activity-row')).toHaveCount(3);

  refreshShouldFail = true;

  // Drive a real `server.updated` SSE event through the real backend/worker/SSE stack -- exactly
  // the trigger `scheduleRefresh` listens for -- rather than relying on `visibilitychange`, whose
  // firing is not guaranteed under a headless runner.
  const name = `activity-refresh-fail-${String(now)}`;
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  expect(created.status()).toBe(201);
  const createdBody = (await created.json()) as { id: string };
  const patched = await page.request.patch(`/api/servers/${createdBody.id}`, {
    data: { name: `${name}-renamed` },
  });
  expect(patched.status()).toBe(200);

  await expect.poll(() => backgroundRefreshFailureCount).toBeGreaterThan(0);

  // The previously-loaded list, including the older page, must still be on screen -- no
  // full-screen error banner ever replaces it for a background refresh failure.
  await expect(page.getByTestId('activity-error-banner')).toHaveCount(0);
  await expect(page.getByTestId('activity-row')).toHaveCount(3);
  await expect(page.getByText('refresh-fail-alpha')).toBeVisible();
  await expect(page.getByText('refresh-fail-beta')).toBeVisible();
  await expect(page.getByText('refresh-fail-gamma')).toBeVisible();
});

test('@activity a background refresh that returns a full page with no overlap resets to the fresh page instead of showing an unmarked gap (WR-B-05)', async ({
  page,
}) => {
  await login(page);

  const oldAt = new Date(Date.now() - 100_000).toISOString();
  let refreshed = false;

  await page.route('**/api/activity*', (route) => {
    if (!refreshed) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            buildActivityItemFixture({
              id: 'evt-gap-old-1',
              action: 'server.deleted',
              occurredAt: oldAt,
              metadata: { name: 'gap-old-1', host: 'gap-old-1.example.test' },
            }),
            buildActivityItemFixture({
              id: 'evt-gap-old-2',
              action: 'server.deleted',
              occurredAt: oldAt,
              metadata: { name: 'gap-old-2', host: 'gap-old-2.example.test' },
            }),
          ],
          nextCursor: null,
        } satisfies ActivityResponseFixture),
      });
    }

    const freshItems = Array.from({ length: 50 }, (_, index) =>
      buildActivityItemFixture({
        id: `evt-gap-fresh-${String(index)}`,
        action: 'auth.login_failed',
        occurredAt: new Date(Date.now() - index * 1_000).toISOString(),
        entityType: 'session',
        outcome: 'failure',
        errorCode: 'INVALID_CREDENTIALS',
        metadata: { email: 'unknown@example.test', ip: '10.0.0.1' },
      }),
    );
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: freshItems, nextCursor: 'opaque-fresh-cursor' } satisfies ActivityResponseFixture),
    });
  });

  await page.goto('/activity');
  await expect(page.getByTestId('activity-row')).toHaveCount(2);

  refreshed = true;

  const name = `activity-refresh-gap-${String(Date.now())}`;
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  expect(created.status()).toBe(201);
  const createdBody = (await created.json()) as { id: string };
  const patched = await page.request.patch(`/api/servers/${createdBody.id}`, {
    data: { name: `${name}-renamed` },
  });
  expect(patched.status()).toBe(200);

  // No gap-detection affordance is defined by 05-UI-SPEC.md -- the fix resets to the fresh page
  // rather than stitching two non-contiguous runs together silently (see 05-32-SUMMARY.md).
  await expect(page.getByTestId('activity-row')).toHaveCount(50);
  await expect(page.getByText('gap-old-1')).toHaveCount(0);
  await expect(page.getByText('gap-old-2')).toHaveCount(0);
});

test('@activity expanding a server.created row shows exactly the curated pairs and never an unknown metadata key', async ({
  page,
}) => {
  await login(page);
  await stubActivityOnce(page, {
    items: [
      buildActivityItemFixture({
        id: 'evt-created',
        action: 'server.created',
        entityId: 'srv-canary-0000',
        metadata: {
          host: 'db.internal.example.test',
          sshPort: 22,
          sshUser: 'root',
          credentialType: 'ssh_private_key',
          privateKey: 'CANARY-SECRET-VALUE-SHOULD-NEVER-RENDER',
        },
      }),
    ],
    nextCursor: null,
  });

  await page.goto('/activity');

  const row = page.getByTestId('activity-row').filter({ hasText: 'added server' });
  await row.getByRole('button').click();

  await expect(row.getByText('db.internal.example.test:22')).toBeVisible();
  await expect(row.getByText('root')).toBeVisible();
  await expect(row.getByText('Private key')).toBeVisible();

  const pageText = await page.locator('body').innerText();
  expect(pageText).not.toContain('privateKey');
  expect(pageText).not.toContain('CANARY-SECRET-VALUE-SHOULD-NEVER-RENDER');
});

test('@activity a failure item renders its errorCode in a mono element and a success item renders none', async ({ page }) => {
  await login(page);
  await stubActivityOnce(page, {
    items: [
      buildActivityItemFixture({
        id: 'evt-fail',
        action: 'server.connection_attempted',
        outcome: 'failure',
        errorCode: 'CONNECT_TIMEOUT',
        entityId: 'srv-fail-0000',
        metadata: { attempts: 2, durationMs: 5000 },
      }),
      buildActivityItemFixture({
        id: 'evt-success',
        action: 'server.connection_attempted',
        outcome: 'success',
        entityId: 'srv-ok-0000',
        metadata: { attempts: 1, durationMs: 300 },
      }),
    ],
    nextCursor: null,
  });

  await page.goto('/activity');

  const failureRow = page.getByTestId('activity-row').filter({ hasText: 'Connection to' });
  await expect(failureRow.locator('[data-mono="true"]', { hasText: 'CONNECT_TIMEOUT' })).toBeVisible();

  const successRow = page.getByTestId('activity-row').filter({ hasText: 'Admin connected' });
  await expect(successRow.locator('[data-mono="true"]')).toHaveCount(0);
});

test('@activity an auth.logout item shows no expand chevron', async ({ page }) => {
  await login(page);
  await stubActivityOnce(page, {
    items: [
      buildActivityItemFixture({
        id: 'evt-logout',
        action: 'auth.logout',
        entityType: 'session',
        metadata: { email: E2E_ADMIN_EMAIL },
      }),
    ],
    nextCursor: null,
  });

  await page.goto('/activity');

  const row = page.getByTestId('activity-row').filter({ hasText: 'Admin signed out' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button')).toHaveCount(0);
});

test('@activity an item referencing a deleted server renders the name as plain text with no link', async ({ page }) => {
  await login(page);
  await stubActivityOnce(page, {
    items: [
      buildActivityItemFixture({
        id: 'evt-deleted-ref',
        action: 'server.fingerprint_trusted',
        entityId: 'srv-long-gone-0000',
        metadata: { name: 'gone-server', previousFingerprint: 'SHA256:old', newFingerprint: 'SHA256:new' },
      }),
    ],
    nextCursor: null,
  });

  await page.goto('/activity');

  const row = page.getByTestId('activity-row');
  await expect(row.getByText('gone-server')).toBeVisible();
  await expect(row.getByRole('link')).toHaveCount(0);
});

test('@activity the loading state shows ten skeleton rows and no spinner; the error state shows the exact banner copy with a working Retry', async ({
  page,
}) => {
  await login(page);

  // Deliberately never fulfilled/aborted -- the request stays pending for the whole assertion,
  // exactly like servers-list.spec.ts's own loading-state precedent. No fixed-delay sleep: the
  // skeleton assertions below use Playwright's own auto-retrying `expect`.
  await page.route('**/api/activity*', () => undefined);
  await page.goto('/activity');

  await expect(page.locator('[data-height="44"]')).toHaveCount(10);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0);

  await page.unroute('**/api/activity*');
  let requestCount = 0;
  await page.route('**/api/activity*', (route) => {
    requestCount += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'A stubbed failure detail.' }),
    });
  });

  await page.reload();

  await expect(
    page.getByText("Couldn't load activity. Something went wrong on our end. Try again, and check the server logs if it continues."),
  ).toBeVisible();
  await expect(page.getByText('INTERNAL_ERROR', { exact: true })).toBeVisible();

  const requestsBeforeRetry = requestCount;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => requestCount).toBeGreaterThan(requestsBeforeRetry);
});

test('@activity no rendered text anywhere on the screen contains a raw JSON object signature', async ({ page }) => {
  await login(page);
  await stubActivityOnce(page, {
    items: [
      buildActivityItemFixture({
        id: 'evt-created',
        action: 'server.created',
        entityId: 'srv-canary-json',
        metadata: { host: 'db.internal.example.test', sshPort: 22, sshUser: 'root', credentialType: 'ssh_password', extraCanary: 'x' },
      }),
      buildActivityItemFixture({
        id: 'evt-logout',
        action: 'auth.logout',
        entityType: 'session',
      }),
      buildActivityItemFixture({
        id: 'evt-fail',
        action: 'server.discovery_completed',
        outcome: 'failure',
        errorCode: 'COMMAND_TIMEOUT',
        entityId: 'srv-fail-json',
        metadata: { checksFailed: ['cpu', 'memory'] },
      }),
    ],
    nextCursor: null,
  });

  await page.goto('/activity');
  await expect(page.getByTestId('activity-row')).toHaveCount(3);

  for (const button of await page.getByRole('button').all()) {
    const expanded = await button.getAttribute('aria-expanded');
    if (expanded === 'false') {
      await button.click();
    }
  }

  const pageText = await page.locator('body').innerText();
  expect(pageText).not.toMatch(/\{"/);
});
