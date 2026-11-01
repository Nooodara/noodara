// 19-05: shared steps for the reliable-engine E2E specs (engine-happy, engine-failure,
// engine-rollback). A per-test git repository on the deploy host's git server, a service wired to
// it over the API, the push webhook enabled in the UI (payload URL and secret read from the panel)
// and a signed-delivery helper that signs the exact bytes it sends (H1).
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './stack.js';
import { expect, type DeployHost } from './deploy-host.js';

export const BASE_URL = 'http://localhost:3000';
export const WEBHOOK_PATH_PREFIX = `${BASE_URL}/webhooks/github/`;
/** Per test: several builds, a healthcheck window and cleanup, below the CI e2e job timeout. */
export const ENGINE_TEST_TIMEOUT_MS = 12 * 60_000;
export const DEPLOY_TIMEOUT_MS = 4 * 60_000;
const CLEANUP_TIMEOUT_MS = 90_000;
export const APP_PORT = 3000;

const FIXTURES_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../fixtures');

// ---- API ----

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

/** Session-authenticated call; mutations need the web origin (CSRF), /api/* is proxied. */
export async function api(page: Page, method: string, url: string, data?: unknown): Promise<ApiResult> {
  const response = await page.request.fetch(url, {
    method,
    headers: { origin: BASE_URL },
    ...(data === undefined ? {} : { data }),
    failOnStatusCode: false,
    timeout: 30_000,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status(), body };
}

export function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string') throw new Error(`response has no string '${key}'`);
  return value;
}

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

export function uniqueSuffix(): string {
  return randomInt(0, 0xffffff).toString(16).padStart(6, '0');
}

export function freePort(): number {
  return randomInt(20_000, 30_000);
}

// ---- shared server (one per spec file, connected over the API: not under test here) ----

export interface ConnectedServer {
  readonly id: string;
  readonly name: string;
}

/** `hostOverride`: e.g. '127.0.0.1', so the DNS check compares against an IP literal. */
export async function connectServer(page: Page, host: DeployHost, hostOverride?: string): Promise<ConnectedServer> {
  const name = `engine-${uniqueSuffix()}`;
  const created = await api(page, 'POST', '/api/servers', {
    name,
    host: hostOverride ?? host.ssh.host,
    sshPort: host.ssh.port,
    sshUser: host.ssh.user,
    credential: { type: 'ssh_private_key', privateKey: host.ssh.privateKey },
  });
  expect(created.status, 'create server').toBe(201);
  const id = field(created.body, 'id');
  const connect = await api(page, 'POST', `/api/servers/${id}/connect`);
  expect(connect.status, 'connect server').toBe(202);
  await expect
    .poll(async () => field((await api(page, 'GET', `/api/servers/${id}`)).body, 'status'), { timeout: 120_000 })
    .toBe('CONNECTED');
  return { id, name };
}

export async function removeServer(page: Page, server: ConnectedServer): Promise<void> {
  const removed = await api(page, 'DELETE', `/api/servers/${server.id}`, { confirmName: server.name });
  expect([200, 204, 404]).toContain(removed.status);
}

// ---- per-test cleanup ----

export class Cleanup {
  private readonly projects: { id: string; name: string }[] = [];
  private readonly deployments: string[] = [];

  project(id: string, name: string): void {
    this.projects.push({ id, name });
  }

  deployment(id: string): void {
    this.deployments.push(id);
  }

  async run(page: Page): Promise<void> {
    for (const id of this.deployments) await api(page, 'POST', `/api/deployments/${id}/cancel`).catch(() => undefined);
    for (const project of this.projects) {
      let last: ApiResult = { status: 0, body: null };
      try {
        await expect
          .poll(
            async () => {
              // Only an archived project can be deleted; archiving again is a no-op.
              await api(page, 'POST', `/api/projects/${project.id}/archive`);
              last = await api(page, 'DELETE', `/api/projects/${project.id}`, { confirmName: project.name });
              // 409 while a deployment still runs: retry until it settles.
              return last.status === 200 || last.status === 404;
            },
            { timeout: CLEANUP_TIMEOUT_MS, intervals: [1_000, 2_000, 5_000] },
          )
          .toBe(true);
      } catch {
        throw new Error(`cleanup: delete project ${project.name} answered ${String(last.status)} ${JSON.stringify(last.body)}`);
      }
    }
  }
}

// ---- git repository on the deploy host's git server ----

export type FixtureFiles = Readonly<Record<string, string>>;

export function fixtureFiles(name: 'node-api' | 'unhealthy-api' | 'env-api'): FixtureFiles {
  const dir = path.join(FIXTURES_DIR, name);
  return {
    Dockerfile: readFileSync(path.join(dir, 'Dockerfile'), 'utf8'),
    'package.json': readFileSync(path.join(dir, 'package.json'), 'utf8'),
    'server.js': readFileSync(path.join(dir, 'server.js'), 'utf8'),
  };
}

/** node-api whose `GET /` answers `{ service: <marker>, ok: true }`: a version you can see. */
export function nodeApiVersion(marker: string): FixtureFiles {
  if (!/^[a-z0-9-]+$/.test(marker)) throw new Error(`invalid version marker '${marker}'`);
  const files = fixtureFiles('node-api');
  const server = files['server.js'] ?? '';
  const replaced = server.replace("service: 'node-api'", `service: '${marker}'`);
  if (replaced === server) throw new Error('node-api fixture no longer carries its service marker');
  return { ...files, 'server.js': replaced };
}

/** Body `GET /` of a node-api version answers. */
export function versionBody(marker: string): string {
  return JSON.stringify({ service: marker, ok: true });
}

const COMMIT_SCRIPT = `set -eu
name=$1; message=$2; shift 2
bare=/srv/git/$name.git
[ -d "$bare" ] || git init -q --bare -b main "$bare"
work=$(mktemp -d)
cd "$work"
git init -q -b main .
if git --git-dir="$bare" rev-parse -q --verify refs/heads/main >/dev/null; then
  git fetch -q "$bare" main
  git reset -q --hard FETCH_HEAD
fi
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
while [ $# -gt 1 ]; do printf '%s' "$2" | base64 -d > "$1"; shift 2; done
git add -A
git -c user.name='Noodara E2E' -c user.email=e2e@noodara.invalid -c commit.gpgsign=false commit -q -m "$message"
git push -q "$bare" HEAD:refs/heads/main
git rev-parse HEAD
cd /
rm -rf "$work"
`;

export interface TestRepo {
  readonly name: string;
  readonly url: string;
  /** Commits `files` as the whole tree on `main`, pushes it, returns the new 40-hex SHA. */
  commit(files: FixtureFiles, message: string): Promise<string>;
}

export function testRepo(host: DeployHost, name: string): TestRepo {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid repo name '${name}'`);
  return {
    name,
    url: host.gitRepoUrl(name),
    async commit(files, message) {
      const args = Object.entries(files).flatMap(([file, content]) => {
        if (!/^[A-Za-z0-9._-]+$/.test(file)) throw new Error(`invalid fixture file name '${file}'`);
        return [file, Buffer.from(content, 'utf8').toString('base64')];
      });
      const result = await host.exec(['sh', '-c', COMMIT_SCRIPT, 'sh', name, message, ...args], { user: 'git' });
      expect(result.exitCode, `commit to ${name}: ${result.stderr}`).toBe(0);
      const sha = result.stdout.trim().split('\n').pop() ?? '';
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      return sha;
    },
  };
}

// ---- project, environment and git service over the API ----

export interface EngineService {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly publishedPort: number;
}

export async function createProject(page: Page, cleanup: Cleanup, name: string): Promise<{ projectId: string; environmentId: string }> {
  const project = await api(page, 'POST', '/api/projects', { name });
  expect(project.status, JSON.stringify(project.body)).toBe(201);
  const projectId = field(project.body, 'id');
  cleanup.project(projectId, name);
  const environment = await api(page, 'POST', `/api/projects/${projectId}/environments`, { name: 'production' });
  expect(environment.status, JSON.stringify(environment.body)).toBe(201);
  return { projectId, environmentId: field(environment.body, 'id') };
}

/** A git service on `main` of `repoUrl`, with a deploy key the git host accepts. */
export async function createGitService(
  page: Page,
  host: DeployHost,
  input: { projectId: string; environmentId: string; serverId: string; name: string; repoUrl: string; publishedPort: number },
): Promise<EngineService> {
  const service = await api(page, 'POST', `/api/projects/${input.projectId}/services`, {
    environmentId: input.environmentId,
    serverId: input.serverId,
    name: input.name,
    source: { kind: 'git', repositoryUrl: input.repoUrl, branch: 'main' },
    internalPort: APP_PORT,
    publishedPort: input.publishedPort,
  });
  expect(service.status, JSON.stringify(service.body)).toBe(201);
  const serviceId = field(service.body, 'id');
  const key = await api(page, 'PUT', `/api/projects/${input.projectId}/services/${serviceId}/credentials/repository`, {
    kind: 'deploy_key',
  });
  expect(key.status, JSON.stringify(key.body)).toBe(200);
  const repository = (key.body as { repository?: { publicKey?: unknown } | null }).repository;
  expect(typeof repository?.publicKey).toBe('string');
  await host.authorizeGitKey(String(repository?.publicKey));
  return { projectId: input.projectId, environmentId: input.environmentId, serviceId, publishedPort: input.publishedPort };
}

/** HTTP healthcheck on node-api's `/health` (unhealthy-api answers 404 there) and auto-rollback. */
export async function configureHealthcheck(page: Page, service: EngineService, autoRollback: boolean): Promise<void> {
  const patched = await api(page, 'PATCH', `/api/projects/${service.projectId}/services/${service.serviceId}`, {
    healthcheck: {
      type: 'http',
      path: '/health',
      port: APP_PORT,
      expectedStatuses: [200],
      probeTimeoutS: 2,
      intervalS: 1,
      retries: 3,
      startPeriodS: 5,
    },
    autoRollback,
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
}

// ---- deployments ----

export interface DeploymentRow {
  readonly id: string;
  readonly status: string;
  readonly trigger: string;
  readonly commitSha: string | null;
}

export async function listDeployments(page: Page, serviceId: string): Promise<DeploymentRow[]> {
  const list = await api(page, 'GET', `/api/services/${serviceId}/deployments?limit=50`);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return ((list.body as { items: DeploymentRow[] }).items ?? []).map((row) => ({
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    commitSha: row.commitSha,
  }));
}

export async function deploymentStatus(page: Page, deploymentId: string): Promise<string> {
  return field((await api(page, 'GET', `/api/deployments/${deploymentId}`)).body, 'status');
}

/** Manual deploy over the API; returns the new deployment id. */
export async function deployViaApi(page: Page, cleanup: Cleanup, serviceId: string): Promise<string> {
  const deployed = await api(page, 'POST', `/api/services/${serviceId}/deploy`, {});
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(201);
  const id = field(deployed.body, 'id');
  cleanup.deployment(id);
  return id;
}

export async function waitForStatus(page: Page, deploymentId: string, statuses: readonly string[]): Promise<string> {
  let last = '';
  await expect
    .poll(
      async () => {
        last = await deploymentStatus(page, deploymentId);
        return statuses.includes(last);
      },
      { timeout: DEPLOY_TIMEOUT_MS, intervals: [1_000, 2_000] },
    )
    .toBe(true);
  return last;
}

// ---- service page in the UI ----

export async function openService(page: Page, service: EngineService, query = ''): Promise<void> {
  await page.goto(`/projects/${service.projectId}/services/${service.serviceId}${query}`);
  await expect(page.getByTestId('service-toolbar')).toBeVisible();
}

export async function historyRowIds(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="deployment-row-"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid') ?? ''));
  return ids.map((testId) => testId.replace('deployment-row-', ''));
}

export async function expectRowStatus(page: Page, deploymentId: string, status: string): Promise<void> {
  await expect(page.getByTestId(`deployment-row-${deploymentId}`)).toHaveAttribute('data-status', status, {
    timeout: DEPLOY_TIMEOUT_MS,
  });
}

/**
 * Records every `data-status` each history row shows, in order, from now on (the page must not
 * reload). Mutation records carry the old value, so a value replaced before the callback ran is
 * still recorded.
 */
export async function recordRowStatuses(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __rowStatuses?: Record<string, string[]> };
    if (w.__rowStatuses !== undefined) return;
    const log: Record<string, string[]> = {};
    w.__rowStatuses = log;
    const prefix = 'deployment-row-';
    const push = (id: string, status: string | null): void => {
      if (status === null || status === '') return;
      const list = (log[id] ??= []);
      if (list[list.length - 1] !== status) list.push(status);
    };
    const scan = (): void => {
      for (const row of document.querySelectorAll(`[data-testid^="${prefix}"]`)) {
        push((row.getAttribute('data-testid') ?? '').slice(prefix.length), row.getAttribute('data-status'));
      }
    };
    scan();
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (record.type === 'attributes' && target instanceof Element && record.attributeName === 'data-status') {
          const testId = target.getAttribute('data-testid') ?? '';
          if (testId.startsWith(prefix)) push(testId.slice(prefix.length), record.oldValue);
        }
      }
      scan();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-status'] });
  });
}

export async function rowStatuses(page: Page, deploymentId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window as unknown as { __rowStatuses?: Record<string, string[]> }).__rowStatuses?.[id] ?? [],
    deploymentId,
  );
}

/** `expected` appears in `actual` in order (other statuses may sit between). */
export function expectSubsequence(actual: readonly string[], expected: readonly string[]): void {
  let at = 0;
  for (const status of actual) if (status === expected[at]) at += 1;
  expect(at, `statuses ${actual.join(' -> ')} contain ${expected.join(' ... ')}`).toBe(expected.length);
}

// ---- push webhook ----

export interface Hook {
  readonly url: string;
  readonly secret: string;
}

const seenSecrets = new Set<string>();

/** Enables the webhook from the service's panel and reads the payload URL and the one-time secret. */
export async function enableWebhookInUi(page: Page, service: EngineService): Promise<Hook> {
  await openService(page, service, '?webhook=1');
  const panel = page.getByTestId('webhook-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Enable webhook' }).click();
  const secretField = page.getByTestId('webhook-secret');
  await expect(secretField).toBeVisible();
  const secret = (await secretField.locator('code').innerText()).trim();
  const url = (await panel.locator('code').first().innerText()).trim();
  // The payload URL is the web origin: GitHub posts to exactly what the panel shows.
  expect(url.startsWith(WEBHOOK_PATH_PREFIX), `payload URL ${url}`).toBe(true);
  // H1: a random per-enable secret, never one this run saw before.
  expect(secret.length).toBeGreaterThanOrEqual(32);
  expect(seenSecrets.has(secret), 'webhook secret is fresh').toBe(false);
  seenSecrets.add(secret);
  return { url, secret };
}

export interface Delivery {
  readonly event: 'push' | 'ping';
  readonly payload: unknown;
  /** Reuse one to redeliver; a fresh GUID otherwise. */
  readonly deliveryId?: string;
  /** Signs with this key instead of the hook's secret (negative path). */
  readonly signWith?: string;
  /** Sends these bytes instead of the signed ones (signature over bytes that were not sent). */
  readonly sendBytes?: Buffer;
}

export interface DeliveryResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly deliveryId: string;
}

export function sign(secret: string, bytes: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
}

/** Wrong key for the negative path: random per call, never the hook's secret. */
export function wrongKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Posts a GitHub-shaped delivery the way GitHub does: no session, JSON body, and an HMAC-SHA256
 * signature computed over the exact bytes sent (H1).
 */
export async function postDelivery(request: APIRequestContext, hook: Hook, delivery: Delivery): Promise<DeliveryResult> {
  const bytes = Buffer.from(JSON.stringify(delivery.payload), 'utf8');
  const deliveryId = delivery.deliveryId ?? randomUUID();
  const response = await request.fetch(hook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/e2e',
      'x-github-event': delivery.event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': sign(delivery.signWith ?? hook.secret, bytes),
    },
    data: delivery.sendBytes ?? bytes,
    failOnStatusCode: false,
    maxRedirects: 0,
    timeout: 30_000,
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status(), body, deliveryId };
}

export function pushPayload(repo: TestRepo, sha: string, before: string | null): Record<string, unknown> {
  return {
    ref: 'refs/heads/main',
    before: before ?? '0'.repeat(40),
    after: sha,
    deleted: false,
    repository: {
      clone_url: `https://git.noodara-test.internal/srv/git/${repo.name}.git`,
      ssh_url: repo.url,
    },
    commits: [{ id: sha }],
    head_commit: { id: sha },
  };
}

export function pingPayload(): Record<string, unknown> {
  return { zen: 'Keep it logically awesome.', hook_id: randomInt(1, 2 ** 31) };
}

/** Pushes and expects a deployment back; returns its id. */
export async function deliverPush(
  request: APIRequestContext,
  hook: Hook,
  repo: TestRepo,
  sha: string,
  before: string | null,
  cleanup: Cleanup,
): Promise<DeliveryResult & { deploymentId: string }> {
  const result = await postDelivery(request, hook, { event: 'push', payload: pushPayload(repo, sha, before) });
  expect(result.status, JSON.stringify(result.body)).toBe(202);
  expect(result.body['outcome']).toBe('deployed');
  const deploymentId = result.body['deploymentId'];
  expect(typeof deploymentId).toBe('string');
  cleanup.deployment(String(deploymentId));
  return { ...result, deploymentId: String(deploymentId) };
}

// ---- published port sampling (A2) ----

const SAMPLER_SCRIPT = `port=$1; stop=$2
while [ ! -e "$stop" ]; do
  out=$(curl -s -m 1 "http://127.0.0.1:$port/" 2>/dev/null) || out=''
  if [ -n "$out" ]; then printf '%s\\n' "$out"; else echo DOWN; fi
  sleep 0.2
done
rm -f "$stop"
`;

export interface PortSampler {
  /** Stops sampling and returns every sample in order (`DOWN` when nothing answered). */
  stop(): Promise<string[]>;
}

/** Samples `GET /` on the published port from inside the deploy host every ~200 ms. */
export function samplePublishedPort(host: DeployHost, port: number, maxMs: number): PortSampler {
  const stopFile = `/tmp/noodara-sampler-${uniqueSuffix()}`;
  const running = host.exec(['sh', '-c', SAMPLER_SCRIPT, 'sh', String(port), stopFile], { timeoutMs: maxMs });
  return {
    async stop() {
      const touched = await host.exec(['touch', stopFile]);
      expect(touched.exitCode).toBe(0);
      const result = await running;
      return result.stdout.split('\n').filter((line) => line.length > 0);
    },
  };
}
