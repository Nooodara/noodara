// 19-05 (A3): two good pushes, then a bad one that ends FAILED or ROLLED_BACK; a manual rollback
// from the history to the earlier good version ends SUCCESS and that commit answers healthy on the
// published port. (The newest SUCCESS is the running version and is never offered a rollback, so
// the target is the version before it.)
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
  fixtureFiles,
  freePort,
  historyRowIds,
  listDeployments,
  login,
  nodeApiVersion,
  openService,
  removeServer,
  testRepo,
  uniqueSuffix,
  versionBody,
  type ConnectedServer,
} from './fixtures/engine.js';

let server: ConnectedServer | null = null;
let cleanup = new Cleanup();

test.describe('@e2e-engine manual rollback path', () => {
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

  test('after a bad deployment, rolling back from the history to an earlier version ends SUCCESS', async ({
    page,
    request,
    deployHost,
  }) => {
    const suffix = uniqueSuffix();
    const v1 = `v1-${suffix}`;
    const v2 = `v2-${suffix}`;
    const repo = testRepo(deployHost, `rollback-${suffix}`);
    const { projectId, environmentId } = await createProject(page, cleanup, `Engine rollback ${suffix}`);
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
    const answer = async (): Promise<string> => (await deployHost.curlPublishedPort(service.publishedPort, '/')).body;

    const sha1 = await repo.commit(nodeApiVersion(v1), 'v1');
    const first = await deliverPush(request, hook, repo, sha1, null, cleanup);
    await expectRowStatus(page, first.deploymentId, 'SUCCESS');
    expect(await answer()).toBe(versionBody(v1));

    const sha2 = await repo.commit(nodeApiVersion(v2), 'v2');
    const second = await deliverPush(request, hook, repo, sha2, sha1, cleanup);
    await expectRowStatus(page, second.deploymentId, 'SUCCESS');
    expect(await answer()).toBe(versionBody(v2));

    // A bad deployment: the unhealthy fixture fails its healthcheck.
    const badSha = await repo.commit(fixtureFiles('unhealthy-api'), 'unhealthy');
    const bad = await deliverPush(request, hook, repo, badSha, sha2, cleanup);
    const badRow = page.getByTestId(`deployment-row-${bad.deploymentId}`);
    await expect(badRow).toHaveAttribute('data-status', /^(FAILED|ROLLED_BACK)$/, { timeout: 4 * 60_000 });

    // Manual rollback from the history to v1.
    await openService(page, service);
    const before = new Set(await historyRowIds(page));
    const rollback = page.getByTestId(`deployment-rollback-${first.deploymentId}`);
    await expect(rollback).toBeEnabled();
    await rollback.click();
    const dialog = page.getByTestId('rollback-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(sha1.slice(0, 7));
    await page.getByTestId('rollback-confirm').click();
    await expect(dialog).toBeHidden();

    let rollbackId = '';
    await expect
      .poll(async () => {
        rollbackId = (await historyRowIds(page)).find((id) => !before.has(id)) ?? '';
        return rollbackId;
      })
      .not.toBe('');
    cleanup.deployment(rollbackId);
    await expectRowStatus(page, rollbackId, 'SUCCESS');

    // The previous commit is the one running, and it is healthy.
    const rows = await listDeployments(page, service.serviceId);
    expect(rows.find((row) => row.id === rollbackId)).toMatchObject({ status: 'SUCCESS', trigger: 'rollback', commitSha: sha1 });
    expect(rows.find((row) => row.id === bad.deploymentId)?.status).toMatch(/^(FAILED|ROLLED_BACK)$/);
    expect(await answer()).toBe(versionBody(v1));
    const health = await deployHost.curlPublishedPort(service.publishedPort, '/health');
    expect(health.status).toBe(200);
  });
});
