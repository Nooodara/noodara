// 19-06 (A3): screenshots of the phase-19 screens (service history with rollback, rollback dialog,
// healthcheck settings in the service sheet, webhook panel) at 375 and 1280 px, dark and light.
// Real data from the e2e deploy host: two good pushes, then an unhealthy one.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../tests/e2e/fixtures/deploy-host.js';
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
  login,
  nodeApiVersion,
  openService,
  removeServer,
  testRepo,
  uniqueSuffix,
} from '../../../tests/e2e/fixtures/engine.js';

const DIR = path.resolve('docs/ui-review/phase-19');
const WIDTHS = [375, 1280] as const;
const THEMES = ['dark', 'light'] as const;

async function shoot(page: Page, name: string, prepare: (page: Page) => Promise<void>): Promise<void> {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await prepare(page);
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
      await page.waitForTimeout(1200);
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: path.join(DIR, `${name}-${width}-${theme}.png`), animations: 'disabled' });
    }
  }
}

test('phase-19 screens', async ({ browser, page, request, deployHost }) => {
  test.setTimeout(ENGINE_TEST_TIMEOUT_MS * 2);
  const cleanup = new Cleanup();
  const context = await browser.newContext({ baseURL: BASE_URL });
  const setup = await context.newPage();
  await login(setup);
  const server = await connectServer(setup, deployHost);
  try {
    const suffix = uniqueSuffix();
    const repo = testRepo(deployHost, `capture-${suffix}`);
    const { projectId, environmentId } = await createProject(setup, cleanup, `Capture ${suffix}`);
    const service = await createGitService(setup, deployHost, {
      projectId,
      environmentId,
      serverId: server.id,
      name: 'api',
      repoUrl: repo.url,
      publishedPort: freePort(),
    });
    await configureHealthcheck(setup, service, true);
    const hook = await enableWebhookInUi(setup, service);
    const sha1 = await repo.commit(nodeApiVersion(`v1-${suffix}`), 'v1');
    const first = await deliverPush(request, hook, repo, sha1, null, cleanup);
    await expectRowStatus(setup, first.deploymentId, 'SUCCESS');
    const sha2 = await repo.commit(nodeApiVersion(`v2-${suffix}`), 'v2');
    const second = await deliverPush(request, hook, repo, sha2, sha1, cleanup);
    await expectRowStatus(setup, second.deploymentId, 'SUCCESS');
    const badSha = await repo.commit(fixtureFiles('unhealthy-api'), 'unhealthy');
    const bad = await deliverPush(request, hook, repo, badSha, sha2, cleanup);
    await expect(setup.getByTestId(`deployment-row-${bad.deploymentId}`)).toHaveAttribute('data-status', /^(FAILED|ROLLED_BACK)$/, {
      timeout: 4 * 60_000,
    });

    await login(page);
    await shoot(page, 'service-history', async (p) => {
      await openService(p, service);
      await p.getByTestId('deployment-history').scrollIntoViewIfNeeded().catch(() => undefined);
    });
    await shoot(page, 'rollback-dialog', async (p) => {
      await openService(p, service);
      await p.getByTestId(`deployment-rollback-${first.deploymentId}`).click();
      await expect(p.getByTestId('rollback-dialog')).toBeVisible();
    });
    await shoot(page, 'service-sheet-healthcheck', async (p) => {
      await openService(p, service);
      const direct = p.getByRole('button', { name: 'Edit', exact: true });
      if (await direct.isVisible()) {
        await direct.click();
      } else {
        await p.getByRole('button', { name: 'Actions for api' }).click();
        await p.getByRole('menuitem', { name: 'Edit' }).click();
      }
      await expect(p.getByTestId('service-sheet')).toBeVisible();
      await p.getByTestId('service-sheet').getByText('Healthcheck', { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    });
    await shoot(page, 'webhook-panel', async (p) => {
      await openService(p, service, '?webhook=1');
      await expect(p.getByTestId('webhook-panel')).toBeVisible();
      await expect(p.getByTestId('webhook-deliveries')).toBeVisible();
    });
  } finally {
    await cleanup.run(setup).catch(() => undefined);
    await removeServer(setup, server).catch(() => undefined);
    await context.close();
  }
});
