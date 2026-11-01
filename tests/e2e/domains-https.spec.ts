// 24-04: deploy node-api -> add api.<run>.test in the Domains panel -> Check DNS (challtestsrv
// answer) -> the Certificate pill reaches Issued (Pebble) -> HTTPS GET /health from the runner
// with Pebble's root and the right SNI answers 200 through noodara-traefik, HTTP redirects (A1).
// Deleting the domain makes Traefik answer 404; deleting the service disconnects the proxy and
// removes the network; the proxy, Pebble and challtestsrv are gone at teardown (A3). A domain
// pointing elsewhere ends Failed with the DNS cause inside the shortened timeout (H1).
import { CERT_FAILURE_MESSAGES } from '@noodara/domain';
import type { Browser, Locator, Page } from '@playwright/test';
import { expect, test, type Acme } from './fixtures/acme.js';
import type { DeployHost } from './fixtures/deploy-host.js';
import {
  BASE_URL,
  Cleanup,
  ENGINE_TEST_TIMEOUT_MS,
  api,
  configureHealthcheck,
  connectServer,
  createGitService,
  createProject,
  deployViaApi,
  field,
  fixtureFiles,
  freePort,
  login,
  openService,
  removeServer,
  testRepo,
  uniqueSuffix,
  waitForStatus,
  type ConnectedServer,
  type EngineService,
} from './fixtures/engine.js';

const PROXY_TIMEOUT_MS = 4 * 60_000;
/** The stack checks certificates every 60 s and times a pending issuance out after 60 s. */
const CERT_TIMEOUT_MS = 5 * 60_000;
const ROUTE_TIMEOUT_MS = 60_000;
const ELSEWHERE_IP = '203.0.113.9';
const PROXY_CONTAINER = 'noodara-traefik';

interface DomainRow {
  readonly id: string;
  readonly hostname: string;
  readonly dnsStatus: string | null;
  readonly certStatus: string;
  readonly certErrorCode: string | null;
}

let server: ConnectedServer | null = null;
let cleanup = new Cleanup();

async function withPage(browser: Browser, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const page = await context.newPage();
    await login(page);
    await run(page);
  } finally {
    await context.close();
  }
}

function connected(): ConnectedServer {
  if (server === null) throw new Error('server not connected (beforeAll failed)');
  return server;
}

async function proxyStatus(page: Page, serverId: string): Promise<string> {
  return field((await api(page, 'GET', `/api/servers/${serverId}`)).body, 'proxyStatus');
}

async function listDomainRows(page: Page, service: EngineService): Promise<DomainRow[]> {
  const list = await api(page, 'GET', `/api/projects/${service.projectId}/services/${service.serviceId}/domains`);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return (list.body as { items: DomainRow[] }).items;
}

async function domainRow(page: Page, service: EngineService, hostname: string): Promise<DomainRow | undefined> {
  return (await listDomainRows(page, service)).find((row) => row.hostname === hostname);
}

async function proxyNetworks(host: DeployHost): Promise<string> {
  const inspected = await host.exec(['docker', 'inspect', '-f', '{{json .NetworkSettings.Networks}}', PROXY_CONTAINER]);
  expect(inspected.exitCode, inspected.stderr).toBe(0);
  return inspected.stdout;
}

/** Diagnostics for a certificate that never issues: the proxy's own ACME log lines. */
async function proxyLogTail(host: DeployHost): Promise<string> {
  const logs = await host.exec(['sh', '-c', `docker logs --tail 60 ${PROXY_CONTAINER} 2>&1`]);
  return `noodara-traefik log tail:\n${logs.stdout}`;
}

/** A git service on a fresh project; `deploy` builds and starts it to SUCCESS. */
async function serviceFor(
  page: Page,
  host: DeployHost,
  input: { readonly name: string; readonly deploy: boolean },
): Promise<EngineService> {
  const repo = testRepo(host, input.name);
  await repo.commit(fixtureFiles('node-api'), 'node-api');
  const { projectId, environmentId } = await createProject(page, cleanup, `${input.name}-project`);
  const service = await createGitService(page, host, {
    projectId,
    environmentId,
    serverId: connected().id,
    name: input.name,
    repoUrl: repo.url,
    publishedPort: freePort(),
  });
  await configureHealthcheck(page, service, false);
  if (input.deploy) {
    const deploymentId = await deployViaApi(page, cleanup, service.serviceId);
    expect(await waitForStatus(page, deploymentId, ['SUCCESS', 'FAILED', 'ROLLED_BACK'])).toBe('SUCCESS');
  }
  return service;
}

/** Adds `hostname` in the Domains panel and returns its row locator. */
async function addDomainInUi(page: Page, service: EngineService, hostname: string): Promise<Locator> {
  await openService(page, service);
  const panel = page.getByTestId('domains-panel');
  await panel.getByTestId('domain-add-input').fill(hostname);
  await panel.getByTestId('domain-add-submit').click();
  const row = panel.locator('[data-testid^="domain-row-"]').filter({ hasText: hostname });
  await expect(row).toBeVisible();
  return row;
}

async function waitForCert(page: Page, service: EngineService, hostname: string, status: string): Promise<DomainRow> {
  let last: DomainRow | undefined;
  await expect
    .poll(
      async () => {
        last = await domainRow(page, service, hostname);
        return last?.certStatus;
      },
      { timeout: CERT_TIMEOUT_MS, intervals: [2_000, 5_000] },
    )
    .toBe(status);
  if (last === undefined) throw new Error(`domain ${hostname} vanished`);
  return last;
}

test.describe('@e2e-domains domain -> DNS -> certificate -> HTTPS', () => {
  test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 });

  test.beforeAll(async ({ browser, deployHost, acme }) => {
    test.setTimeout(PROXY_TIMEOUT_MS + 3 * 60_000);
    expect(acme.deployHostIp).toMatch(/^\d/);
    await withPage(browser, async (page) => {
      // 127.0.0.1: the API's DNS check compares the challtestsrv answer against an IP literal.
      server = await connectServer(page, deployHost, '127.0.0.1');
      const install = await api(page, 'POST', `/api/servers/${server.id}/proxy`, { acmeEmail: 'ops@example.com' });
      expect(install.status, JSON.stringify(install.body)).toBe(202);
      const serverId = server.id;
      await expect
        .poll(() => proxyStatus(page, serverId), { timeout: PROXY_TIMEOUT_MS, intervals: [2_000, 5_000] })
        .toBe('RUNNING');
    });
  });

  test.afterAll(async ({ browser, deployHost }) => {
    test.setTimeout(3 * 60_000);
    if (server === null) return;
    const current = server;
    await withPage(browser, async (page) => {
      const removed = await api(page, 'POST', `/api/servers/${current.id}/proxy/remove`);
      expect([200, 409], JSON.stringify(removed.body)).toContain(removed.status);
      await expect
        .poll(async () => (await deployHost.listContainers()).includes(PROXY_CONTAINER), { timeout: 90_000 })
        .toBe(false);
      await removeServer(page, current);
    });
  });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(ENGINE_TEST_TIMEOUT_MS);
    cleanup = new Cleanup();
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanup.run(page);
  });

  test('a deployed service gets a Pebble certificate and answers HTTPS /health; removal cleans the proxy', async ({
    page,
    deployHost,
    acme,
  }) => {
    const suffix = uniqueSuffix();
    const service = await serviceFor(page, deployHost, { name: `domains-${suffix}`, deploy: true });
    const hostname = `api.r${suffix}.test`;
    await acme.pointAtServer(hostname);

    // A1: add, Check DNS -> Resolves (the challtestsrv answer reaches the API through the seam).
    const row = await addDomainInUi(page, service, hostname);
    await row.getByTestId('domain-check-dns').click();
    await expect(row.getByTestId('domain-dns-pill')).toHaveText(/Resolves/);

    // A1: Traefik obtains the certificate from Pebble; the reconciler records it as Issued.
    try {
      await waitForCert(page, service, hostname, 'ISSUED');
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${await proxyLogTail(deployHost)}`);
    }
    await page.reload();
    const issuedRow = page.getByTestId('domains-panel').locator('[data-testid^="domain-row-"]').filter({ hasText: hostname });
    await expect(issuedRow.getByTestId('domain-cert-pill')).toHaveText(/Issued/);

    // A1: real HTTPS from the runner: Pebble's issuance root, SNI = hostname, through the proxy.
    const root = await acme.issuanceRoot();
    await expectHttps(acme, hostname, root);
    const plain = await acme.httpGet(hostname, '/health');
    expect([301, 302, 307, 308], `HTTP answered ${String(plain.status)}`).toContain(plain.status);
    expect(plain.location ?? '').toMatch(new RegExp(`^https://${hostname.replaceAll('.', '\\.')}`));

    // A3: removing the domain drops its route: Traefik answers 404 for the host.
    await issuedRow.getByTestId('domain-remove').click();
    const dialog = page.getByTestId('domain-remove-confirm');
    await dialog.getByRole('button', { name: 'Remove domain' }).click();
    await expect(issuedRow).toHaveCount(0);
    expect(await domainRow(page, service, hostname)).toBeUndefined();
    await expect
      .poll(async () => (await acme.httpGet(hostname, '/health')).status, { timeout: ROUTE_TIMEOUT_MS })
      .toBe(404);

    // The last domain gone, the proxy leaves the service network.
    const network = `noodara-net-${service.serviceId}`;
    await expect
      .poll(async () => (await proxyNetworks(deployHost)).includes(network), { timeout: ROUTE_TIMEOUT_MS })
      .toBe(false);

    // A3: with a domain routed again, deleting the service disconnects the proxy and removes the network.
    const second = `www.r${suffix}.test`;
    await acme.pointAtServer(second);
    await addDomainInUi(page, service, second);
    await expect
      .poll(async () => (await proxyNetworks(deployHost)).includes(network), { timeout: ROUTE_TIMEOUT_MS })
      .toBe(true);
    const deleted = await api(page, 'DELETE', `/api/projects/${service.projectId}/services/${service.serviceId}`, {
      confirmName: `domains-${suffix}`,
    });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    await expect
      .poll(async () => (await proxyNetworks(deployHost)).includes(network), { timeout: ROUTE_TIMEOUT_MS })
      .toBe(false);
    await expect
      .poll(async () => (await deployHost.listNetworks()).includes(network), { timeout: ROUTE_TIMEOUT_MS })
      .toBe(false);
    expect(await deployHost.listContainers()).toContain(PROXY_CONTAINER);
    await acme.pebble.clearARecord(hostname);
    await acme.pebble.clearARecord(second);
  });

  test('a domain pointing elsewhere ends Failed with the DNS cause', async ({ page, deployHost, acme }) => {
    const suffix = uniqueSuffix();
    const service = await serviceFor(page, deployHost, { name: `elsewhere-${suffix}`, deploy: false });
    const hostname = `elsewhere.r${suffix}.test`;
    await acme.pointAt(hostname, ELSEWHERE_IP);

    const row = await addDomainInUi(page, service, hostname);
    await row.getByTestId('domain-check-dns').click();
    await expect(row.getByTestId('domain-dns-pill')).toHaveText(/Mismatch/);

    // H1: the pending issuance times out (60 s in the e2e stack) with the DNS cause, not a CA one.
    const failed = await waitForCert(page, service, hostname, 'FAILED');
    expect(failed.certErrorCode).toBe('CERT_DNS_MISMATCH');
    await page.reload();
    const failedRow = page.getByTestId('domains-panel').locator('[data-testid^="domain-row-"]').filter({ hasText: hostname });
    await expect(failedRow.getByTestId('domain-cert-pill')).toHaveText(/Failed/);
    await failedRow.getByTestId('domain-details').getByRole('button', { name: 'Details' }).click();
    await expect(failedRow.getByTestId('domain-cert-failure')).toHaveText(CERT_FAILURE_MESSAGES.CERT_DNS_MISMATCH);
    await acme.pebble.clearARecord(hostname);
  });
});

/** Traefik may serve its default certificate for a moment after the route lands: retry. */
async function expectHttps(acme: Acme, hostname: string, root: string): Promise<void> {
  let last = '';
  try {
    await expect
      .poll(
        async () => {
          try {
            const answer = await acme.httpsGet(hostname, '/health', root);
            last = `${String(answer.status)} ${answer.body.slice(0, 80)}`;
            return answer.status;
          } catch (error) {
            last = error instanceof Error ? error.message : String(error);
            return 0;
          }
        },
        { timeout: ROUTE_TIMEOUT_MS, intervals: [1_000, 2_000] },
      )
      .toBe(200);
  } catch {
    throw new Error(`HTTPS GET https://${hostname}/health never answered 200; last: ${last}`);
  }
}
