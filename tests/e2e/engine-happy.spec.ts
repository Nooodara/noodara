// 19-05: a signed GitHub push posted to the payload URL the webhook panel shows drives a real
// deployment through QUEUED ... HEALTHCHECK -> SUCCESS in the history (A1); redelivering the same
// X-GitHub-Delivery adds no row (A4); a wrong signature is a 401 and a ping is recorded, neither
// adds a row (H1). Deliveries carry no session: the HMAC over the exact bytes sent is the auth.
import { expect, test } from './fixtures/deploy-host.js';
import {
  BASE_URL,
  Cleanup,
  ENGINE_TEST_TIMEOUT_MS,
  api,
  configureHealthcheck,
  connectServer,
  createGitService,
  createProject,
  deliverPush,
  deployViaApi,
  enableWebhookInUi,
  expectRowStatus,
  expectSubsequence,
  freePort,
  historyRowIds,
  listDeployments,
  login,
  nodeApiVersion,
  openService,
  pingPayload,
  postDelivery,
  pushPayload,
  recordRowStatuses,
  removeServer,
  rowStatuses,
  testRepo,
  uniqueSuffix,
  versionBody,
  waitForStatus,
  wrongKey,
  type ConnectedServer,
} from './fixtures/engine.js';

let server: ConnectedServer | null = null;
let cleanup = new Cleanup();

test.describe('@e2e-engine webhook happy path', () => {
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

  test('a signed push deploys QUEUED ... HEALTHCHECK -> SUCCESS and a redelivery adds no row', async ({
    page,
    request,
    deployHost,
  }) => {
    const suffix = uniqueSuffix();
    const marker = `happy-${suffix}`;
    const repo = testRepo(deployHost, `happy-${suffix}`);
    const sha = await repo.commit(nodeApiVersion(marker), 'happy v1');
    const { projectId, environmentId } = await createProject(page, cleanup, `Engine happy ${suffix}`);
    const serverId = server?.id ?? '';
    const service = await createGitService(page, deployHost, {
      projectId,
      environmentId,
      serverId,
      name: 'api',
      repoUrl: repo.url,
      publishedPort: freePort(),
    });
    await configureHealthcheck(page, service, true);
    // One deploy slot (NOODARA_DEPLOY_CONCURRENCY=1): a slow build elsewhere keeps the pushed
    // deployment QUEUED long enough to see it, deterministically.
    const blocker = await createGitService(page, deployHost, {
      projectId,
      environmentId,
      serverId,
      name: 'blocker',
      repoUrl: deployHost.repos.slowBuild,
      publishedPort: freePort(),
    });

    const hook = await enableWebhookInUi(page, service);
    await recordRowStatuses(page);
    const blockerId = await deployViaApi(page, cleanup, blocker.serviceId);
    await waitForStatus(page, blockerId, ['BUILDING']);

    // A1: the push lands through the web origin and queues a deployment of the pushed commit.
    const delivery = await deliverPush(request, hook, repo, sha, null, cleanup);
    await expectRowStatus(page, delivery.deploymentId, 'QUEUED');
    const cancel = await api(page, 'POST', `/api/deployments/${blockerId}/cancel`);
    expect([200, 202], JSON.stringify(cancel.body)).toContain(cancel.status);

    await expectRowStatus(page, delivery.deploymentId, 'SUCCESS');
    expectSubsequence(await rowStatuses(page, delivery.deploymentId), ['QUEUED', 'HEALTHCHECK', 'SUCCESS']);
    const rows = await listDeployments(page, service.serviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: delivery.deploymentId, status: 'SUCCESS', trigger: 'webhook', commitSha: sha });

    // ...and the published port answers with the pushed version.
    const answer = await deployHost.curlPublishedPort(service.publishedPort, '/');
    expect(answer.status).toBe(200);
    expect(answer.body).toBe(versionBody(marker));

    // A4: the same X-GitHub-Delivery again is a duplicate pointing at the same deployment.
    const again = await postDelivery(request, hook, {
      event: 'push',
      payload: pushPayload(repo, sha, null),
      deliveryId: delivery.deliveryId,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect(again.body).toMatchObject({ duplicate: true, deploymentId: delivery.deploymentId });
    expect(await listDeployments(page, service.serviceId)).toHaveLength(1);
    await openService(page, service);
    await expect(page.getByTestId(`deployment-row-${delivery.deploymentId}`)).toBeVisible();
    expect(await historyRowIds(page)).toEqual([delivery.deploymentId]);
  });

  test('a wrong signature is a 401 and a ping is recorded; neither adds a history row', async ({
    page,
    request,
    deployHost,
  }) => {
    const suffix = uniqueSuffix();
    const repo = testRepo(deployHost, `auth-${suffix}`);
    const sha = await repo.commit(nodeApiVersion(`auth-${suffix}`), 'auth v1');
    const { projectId, environmentId } = await createProject(page, cleanup, `Engine auth ${suffix}`);
    const service = await createGitService(page, deployHost, {
      projectId,
      environmentId,
      serverId: server?.id ?? '',
      name: 'api',
      repoUrl: repo.url,
      publishedPort: freePort(),
    });
    const hook = await enableWebhookInUi(page, service);
    const payload = pushPayload(repo, sha, null);

    // H1: signed with another key -> 401, nothing deployed.
    const forged = await postDelivery(request, hook, { event: 'push', payload, signWith: wrongKey() });
    expect(forged.status, JSON.stringify(forged.body)).toBe(401);
    expect(forged.body).toMatchObject({ error: 'UNAUTHORIZED' });
    expect(forged.body).not.toHaveProperty('deploymentId');

    // H1: the right key over different bytes than the ones sent -> 401 (the signature covers the
    // exact body, not its parsed JSON).
    const reformatted = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const tampered = await postDelivery(request, hook, { event: 'push', payload, sendBytes: reformatted });
    expect(tampered.status, JSON.stringify(tampered.body)).toBe(401);

    // H1: a correctly signed ping is accepted and recorded as a ping.
    const ping = await postDelivery(request, hook, { event: 'ping', payload: pingPayload() });
    expect(ping.status, JSON.stringify(ping.body)).toBe(200);
    expect(ping.body).toMatchObject({ outcome: 'ping' });
    expect(ping.body).not.toHaveProperty('deploymentId');

    expect(await listDeployments(page, service.serviceId)).toEqual([]);
    await openService(page, service);
    await expect(page.getByTestId('deployment-history-empty')).toBeVisible();
    expect(await historyRowIds(page)).toEqual([]);
  });
});
