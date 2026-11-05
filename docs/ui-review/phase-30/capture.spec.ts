// 30-06 (A2): the Infrastructure Graph at the project's viewport width, ending on the graph itself
// (the graph e2e specs end on a detail page or force 375 px). API stubbed with page.route.
import { expect, test, type Route } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from '../../../tests/e2e/fixtures/stack.js';

const PROJECT_ID = '6a000000-0000-4000-8000-000000000001';
const PROD = '6a000000-0000-4000-8000-000000000002';
const STAGING = '6a000000-0000-4000-8000-000000000003';
const SRV1 = '6a000000-0000-4000-8000-000000000004';
const SRV2 = '6a000000-0000-4000-8000-000000000005';
const API = '6a000000-0000-4000-8000-000000000006';
const WORKER = '6a000000-0000-4000-8000-000000000007';
const HOST = '6a000000-0000-4000-8000-000000000008';

const n = (kind: string, id: string, label: string, extra: Record<string, string> = {}) => ({
  id: `${kind.toLowerCase()}:${id}`,
  entityId: id,
  label,
  kind,
  ...extra,
});
const r = (type: string, from: string, to: string) => ({ id: `${type}:${from}->${to}`, type, from, to });

const graph = {
  nodes: [
    n('Project', PROJECT_ID, 'Graph capture'),
    n('Environment', PROD, 'Production', { projectId: PROJECT_ID }),
    n('Environment', STAGING, 'Staging', { projectId: PROJECT_ID }),
    n('Server', SRV1, 'Server-01'),
    n('Server', SRV2, 'Server-02'),
    n('Service', API, 'API', { projectId: PROJECT_ID, environmentId: PROD, serverId: SRV1 }),
    n('Service', WORKER, 'Worker', { projectId: PROJECT_ID, environmentId: PROD, serverId: SRV2 }),
    n('Domain', HOST, 'api.example.com', { projectId: PROJECT_ID, environmentId: PROD, serviceId: API }),
  ],
  relations: [
    r('BELONGS_TO', `environment:${PROD}`, `project:${PROJECT_ID}`),
    r('BELONGS_TO', `environment:${STAGING}`, `project:${PROJECT_ID}`),
    r('BELONGS_TO', `service:${API}`, `environment:${PROD}`),
    r('RUNS_ON', `service:${API}`, `server:${SRV1}`),
    r('BELONGS_TO', `service:${WORKER}`, `environment:${PROD}`),
    r('RUNS_ON', `service:${WORKER}`, `server:${SRV2}`),
    r('EXPOSED_BY', `service:${API}`, `domain:${HOST}`),
    r('DEPENDS_ON', `service:${WORKER}`, `service:${API}`),
  ],
  omitted: [],
  truncated: false,
};

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test('graph capture', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
  await page.route(`**/api/projects/${PROJECT_ID}/graph**`, (route) => json(route, graph));
  await page.goto(`/projects/${PROJECT_ID}/graph`);
  await expect(page.getByTestId('infrastructure-graph')).toBeVisible();
  await expect(page.getByText('api.example.com')).toBeVisible();
});
