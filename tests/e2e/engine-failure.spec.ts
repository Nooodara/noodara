// 19-05 (A2): a push of the unhealthy fixture fails its healthcheck and ends ROLLED_BACK; the good
// version answers on the published port at every sample except one contiguous replacement window
// (docs/deploy-engine.md, ADR 0010: stop -> rename to -prev -> start new -> check -> restore -prev),
// during which a sample may find nothing listening or the new, unhealthy container.
import { expect, test } from './fixtures/deploy-host.js';
import {
  BASE_URL,
  Cleanup,
  ENGINE_TEST_TIMEOUT_MS,
  configureHealthcheck,
  connectServer,
  createGitService,
  createProject,
  deliverPush,
  enableWebhookInUi,
  expectRowStatus,
  expectSubsequence,
  fixtureFiles,
  freePort,
  listDeployments,
  login,
  nodeApiVersion,
  openService,
  recordRowStatuses,
  removeServer,
  rowStatuses,
  samplePublishedPort,
  testRepo,
  uniqueSuffix,
  versionBody,
  type ConnectedServer,
} from './fixtures/engine.js';

const UNHEALTHY_BODY = JSON.stringify({ service: 'unhealthy-api', ok: true });
/** Upper bound for the sampler: the failed deploy, its rollback and the settle samples. */
const SAMPLER_MAX_MS = 6 * 60_000;
/** Good samples required after the window, so the restore is shown to hold. */
const SETTLE_SAMPLES = 10;

let server: ConnectedServer | null = null;
let cleanup = new Cleanup();

/** Indices of samples that are not the good version, which must form one contiguous run. */
function replacementWindow(samples: readonly string[], good: string): { start: number; end: number } {
  const bad = samples.flatMap((sample, index) => (sample === good ? [] : [index]));
  expect(bad.length, 'the swap was observed (stop-then-start leaves a window)').toBeGreaterThan(0);
  const start = bad[0] ?? 0;
  const end = bad[bad.length - 1] ?? 0;
  expect(end - start + 1, `one contiguous window, samples: ${samples.join(' | ')}`).toBe(bad.length);
  return { start, end };
}

test.describe('@e2e-engine webhook failure path', () => {
  test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 });

  test.beforeAll(async ({ browser, deployHost }) => {
    test.setTimeout(5 * 60_000);
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      server = await connectServer(page, deployHost);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (server === null) return;
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      await removeServer(page, server);
    } finally {
      await context.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(ENGINE_TEST_TIMEOUT_MS);
    cleanup = new Cleanup();
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanup.run(page);
  });

  test('an unhealthy push ends ROLLED_BACK and the good version keeps answering outside the swap window', async ({
    page,
    request,
    deployHost,
  }) => {
    const suffix = uniqueSuffix();
    const goodMarker = `good-${suffix}`;
    const good = versionBody(goodMarker);
    const repo = testRepo(deployHost, `failure-${suffix}`);
    const goodSha = await repo.commit(nodeApiVersion(goodMarker), 'good version');
    const { projectId, environmentId } = await createProject(page, cleanup, `Engine failure ${suffix}`);
    const service = await createGitService(page, deployHost, {
      projectId,
      environmentId,
      serverId: server?.id ?? '',
      name: 'api',
      repoUrl: repo.url,
      publishedPort: freePort(),
    });
    await configureHealthcheck(page, service, true);
    const hook = await enableWebhookInUi(page, service);
    await recordRowStatuses(page);

    const first = await deliverPush(request, hook, repo, goodSha, null, cleanup);
    await expectRowStatus(page, first.deploymentId, 'SUCCESS');
    expect((await deployHost.curlPublishedPort(service.publishedPort, '/')).body).toBe(good);

    // Sample the published port for the whole failed attempt.
    const sampler = samplePublishedPort(deployHost, service.publishedPort, SAMPLER_MAX_MS);
    let samples: string[] = [];
    let badId = '';
    try {
      await expect.poll(async () => (await deployHost.curlPublishedPort(service.publishedPort, '/')).body).toBe(good);
      const badSha = await repo.commit(fixtureFiles('unhealthy-api'), 'unhealthy version');
      const bad = await deliverPush(request, hook, repo, badSha, goodSha, cleanup);
      badId = bad.deploymentId;

      await expectRowStatus(page, bad.deploymentId, 'ROLLED_BACK');
      expectSubsequence(await rowStatuses(page, bad.deploymentId), ['HEALTHCHECK', 'ROLLING_BACK', 'ROLLED_BACK']);
      const rows = await listDeployments(page, service.serviceId);
      expect(rows.find((row) => row.id === bad.deploymentId)).toMatchObject({ status: 'ROLLED_BACK', commitSha: badSha });
      expect(rows.find((row) => row.id === first.deploymentId)).toMatchObject({ status: 'SUCCESS', commitSha: goodSha });

      // Let the restored container answer a run of samples before stopping.
      await expect
        .poll(async () => {
          const answers: string[] = [];
          for (let i = 0; i < 3; i += 1) answers.push((await deployHost.curlPublishedPort(service.publishedPort, '/')).body);
          return answers.every((body) => body === good);
        })
        .toBe(true);
      await page.waitForTimeout(SETTLE_SAMPLES * 300);
    } finally {
      samples = await sampler.stop();
    }

    // A2: good before the window, good after it, and the window is one contiguous run of samples
    // that found nothing or the unhealthy container (never anything else).
    expect(samples[0], 'good version answers before the swap').toBe(good);
    const window = replacementWindow(samples, good);
    expect(samples.length - 1 - window.end, 'good samples after the restore').toBeGreaterThanOrEqual(SETTLE_SAMPLES);
    for (const sample of samples.slice(window.start, window.end + 1)) {
      expect(['DOWN', UNHEALTHY_BODY]).toContain(sample);
    }

    // The UI shows the failed attempt as rolled back, the good one still the running version.
    await openService(page, service);
    await expect(page.getByTestId(`deployment-row-${badId}`)).toHaveAttribute('data-status', 'ROLLED_BACK');
    await expect(page.getByTestId(`deployment-row-${first.deploymentId}`)).toHaveAttribute('data-status', 'SUCCESS');
    expect((await deployHost.curlPublishedPort(service.publishedPort, '/')).body).toBe(good);
  });
});
