// 30-03: the project Infrastructure Graph view in a real browser against the real stack. The graph
// route is intercepted with page.route (ADR-0005, same as metrics.spec.ts and logs.spec.ts): the
// graph API itself is proven by its integration tests (27-05). Here the UI contract: the §10.3
// shape, links to detail pages, the narrow tree, 30+ services, keyboard reach and inert names.
import { expect, test, type Page, type Route } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const PROJECT_ID = '6a000000-0000-4000-8000-000000000001';
const PROD_ID = '6a000000-0000-4000-8000-000000000002';
const STAGING_ID = '6a000000-0000-4000-8000-000000000003';
const SRV1_ID = '6a000000-0000-4000-8000-000000000004';
const SRV2_ID = '6a000000-0000-4000-8000-000000000005';
const API_ID = '6a000000-0000-4000-8000-000000000006';
const WORKER_ID = '6a000000-0000-4000-8000-000000000007';
const DOMAIN_ID = '6a000000-0000-4000-8000-000000000008';

type Kind = 'Server' | 'Project' | 'Environment' | 'Service' | 'Domain';
type RelationType = 'RUNS_ON' | 'BELONGS_TO' | 'EXPOSED_BY' | 'DEPENDS_ON';

interface Node {
  readonly id: string;
  readonly entityId: string;
  readonly label: string;
  readonly kind: Kind;
  readonly [key: string]: string;
}

interface Relation {
  readonly id: string;
  readonly type: RelationType;
  readonly from: string;
  readonly to: string;
}

interface Graph {
  readonly nodes: Node[];
  readonly relations: Relation[];
  readonly omitted: never[];
  readonly truncated: boolean;
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

const nid = (kind: Kind, id: string): string => `${kind.toLowerCase()}:${id}`;

function rel(type: RelationType, from: string, to: string): Relation {
  return { id: `${type}:${from}->${to}`, type, from, to };
}

function project(label = 'Graph E2E'): Node {
  return { id: nid('Project', PROJECT_ID), entityId: PROJECT_ID, label, kind: 'Project' };
}
function environment(id: string, label: string): Node {
  return { id: nid('Environment', id), entityId: id, label, kind: 'Environment', projectId: PROJECT_ID };
}
function server(id: string, label: string): Node {
  return { id: nid('Server', id), entityId: id, label, kind: 'Server' };
}
function service(id: string, label: string, environmentId: string, serverId: string): Node {
  return { id: nid('Service', id), entityId: id, label, kind: 'Service', projectId: PROJECT_ID, environmentId, serverId };
}
function domain(id: string, hostname: string, environmentId: string, serviceId: string): Node {
  return {
    id: nid('Domain', id),
    entityId: id,
    label: hostname,
    kind: 'Domain',
    projectId: PROJECT_ID,
    environmentId,
    serviceId,
  };
}

function placed(svc: Node): Relation[] {
  return [
    rel('BELONGS_TO', svc.id, nid('Environment', svc.environmentId ?? '')),
    rel('RUNS_ON', svc.id, nid('Server', svc.serverId ?? '')),
  ];
}

/** The roadmap §10.3 example: Production -> API (Server-01, api.example.com), Worker (Server-02). */
function exampleGraph(labels: { api?: string; host?: string } = {}): Graph {
  const api = service(API_ID, labels.api ?? 'API', PROD_ID, SRV1_ID);
  const worker = service(WORKER_ID, 'Worker', PROD_ID, SRV2_ID);
  const host = domain(DOMAIN_ID, labels.host ?? 'api.example.com', PROD_ID, API_ID);
  return {
    nodes: [
      project(),
      environment(PROD_ID, 'Production'),
      environment(STAGING_ID, 'Staging'),
      server(SRV1_ID, 'Server-01'),
      server(SRV2_ID, 'Server-02'),
      api,
      worker,
      host,
    ],
    relations: [
      rel('BELONGS_TO', nid('Environment', PROD_ID), nid('Project', PROJECT_ID)),
      rel('BELONGS_TO', nid('Environment', STAGING_ID), nid('Project', PROJECT_ID)),
      ...placed(api),
      ...placed(worker),
      rel('EXPOSED_BY', api.id, host.id),
      rel('DEPENDS_ON', worker.id, api.id),
    ],
    omitted: [],
    truncated: false,
  };
}

function largeGraph(count: number): Graph {
  const services: Node[] = [];
  const relations: Relation[] = [rel('BELONGS_TO', nid('Environment', PROD_ID), nid('Project', PROJECT_ID))];
  for (let index = 0; index < count; index += 1) {
    const id = `6a000000-0000-4000-8000-1${String(index).padStart(11, '0')}`;
    const svc = service(id, `service-${String(index).padStart(2, '0')}-with-a-rather-long-name`, PROD_ID, SRV1_ID);
    services.push(svc);
    relations.push(...placed(svc));
    if (index > 0) relations.push(rel('DEPENDS_ON', svc.id, services[0]?.id ?? ''));
  }
  return {
    nodes: [project(), environment(PROD_ID, 'Production'), server(SRV1_ID, 'Server-01'), ...services],
    relations,
    omitted: [],
    truncated: false,
  };
}

async function openGraph(page: Page, graph: Graph): Promise<void> {
  await page.route(`**/api/projects/${PROJECT_ID}/graph**`, (route) => json(route, graph));
  await page.goto(`/projects/${PROJECT_ID}/graph`);
  await expect(page.getByTestId('infrastructure-graph')).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.describe('Infrastructure Graph view', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('A1: Environment -> Service with RUNS_ON, EXPOSED_BY and DEPENDS_ON; nodes link to detail pages', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openGraph(page, exampleGraph());
    const graph = page.getByTestId('infrastructure-graph');
    await expect(graph).toHaveAttribute('data-layout', 'graph');

    const production = page.getByTestId(`graph-environment-${nid('Environment', PROD_ID)}`);
    await expect(production.getByTestId(`graph-node-${nid('Environment', PROD_ID)}`)).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}#environment-${PROD_ID}`,
    );
    await expect(production.getByTestId(`graph-node-${nid('Service', API_ID)}`).first()).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/services/${API_ID}`,
    );
    const apiRelations = production.getByRole('list', { name: 'Relations of API' });
    await expect(apiRelations.locator('[data-edge="RUNS_ON"]')).toContainText('Server-01');
    await expect(apiRelations.locator('[data-edge="EXPOSED_BY"]')).toContainText('api.example.com');
    const workerRelations = production.getByRole('list', { name: 'Relations of Worker' });
    await expect(workerRelations.locator('[data-edge="RUNS_ON"]')).toContainText('Server-02');
    await expect(workerRelations.locator('[data-edge="DEPENDS_ON"]')).toContainText('API');
    await expect(page.getByTestId(`graph-node-${nid('Server', SRV1_ID)}`).first()).toHaveAttribute('href', `/servers/${SRV1_ID}`);
    await expect(page.getByTestId(`graph-domain-settings-${nid('Domain', DOMAIN_ID)}`)).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/services/${API_ID}`,
    );
    await expect(page.getByTestId(`graph-environment-${nid('Environment', STAGING_ID)}`)).toContainText('No services');

    await page.getByTestId(`graph-node-${nid('Server', SRV2_ID)}`).first().click();
    await expect(page).toHaveURL(new RegExp(`/servers/${SRV2_ID}$`));
    await page.goBack();
    await expect(graph).toBeVisible();
    await workerRelations.getByRole('link', { name: 'API' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/services/${API_ID}$`));
  });

  test('A2: tree fallback at 375 px with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openGraph(page, exampleGraph());
    await expect(page.getByTestId('infrastructure-graph')).toHaveAttribute('data-layout', 'tree');
    await expect(page.getByRole('link', { name: 'Production' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Server-01' })).toBeVisible();
    await expect(page.getByText('api.example.com')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('A2: 30+ services stay readable and every node is reachable by keyboard', async ({ page }) => {
    const count = 32;
    await page.setViewportSize({ width: 1280, height: 900 });
    await openGraph(page, largeGraph(count));
    const serviceLinks = page.locator('[data-testid="infrastructure-graph"] a[data-node-kind="Service"]');
    // Each service: its own node plus a DEPENDS_ON link to service-00 (all but service-00).
    await expect(serviceLinks).toHaveCount(count + count - 1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    const last = page.getByRole('link', { name: `service-${String(count - 1)}-with-a-rather-long-name`, exact: true });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();

    const expected = await page
      .locator('[data-testid="infrastructure-graph"] a')
      .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('data-testid') ?? a.getAttribute('aria-label') ?? ''));
    await page.getByTestId(`graph-node-${nid('Environment', PROD_ID)}`).focus();
    const reached = new Set<string>();
    for (let step = 0; step < expected.length + 5; step += 1) {
      const current = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active.closest('[data-testid="infrastructure-graph"]') === null) return null;
        return active.getAttribute('data-testid') ?? active.getAttribute('aria-label') ?? '';
      });
      if (current === null) break;
      reached.add(current);
      await page.keyboard.press('Tab');
    }
    expect([...new Set(expected)].filter((id) => !reached.has(id))).toEqual([]);

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByTestId('infrastructure-graph')).toHaveAttribute('data-layout', 'tree');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('H1: links come only from validated ids; hostile names and hostnames stay inert text', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const graph = exampleGraph({ api: 'javascript:alert(1)', host: 'data:text/html,<script>alert(1)</script>' });
    // A node whose id is not a UUID is dropped, never linked.
    graph.nodes.push({ id: 'server:evil', entityId: 'javascript:alert(2)', label: 'Evil server', kind: 'Server' });
    graph.relations.push(rel('RUNS_ON', nid('Service', WORKER_ID), 'server:evil'));
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await openGraph(page, graph);

    const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') ?? ''));
    for (const href of hrefs) {
      expect(href.toLowerCase()).not.toMatch(/^\s*(javascript|data|vbscript):/);
    }
    const apiNode = page.getByTestId(`graph-node-${nid('Service', API_ID)}`).first();
    await expect(apiNode).toHaveText('javascript:alert(1)');
    await expect(apiNode).toHaveAttribute('href', `/projects/${PROJECT_ID}/services/${API_ID}`);

    const hostname = page.getByTestId('graph-domain-hostname');
    await expect(hostname).toHaveText('data:text/html,<script>alert(1)</script>');
    expect(await hostname.evaluate((el) => el.closest('a') === null && el.tagName === 'SPAN')).toBe(true);
    await expect(page.getByRole('link', { name: 'data:text/html,<script>alert(1)</script>', exact: true })).toHaveCount(0);

    await expect(page.getByText('Evil server')).toHaveCount(0);
    await apiNode.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/services/${API_ID}$`));
    expect(dialogs).toEqual([]);
  });
});
