// 13-16 (QA-09): the critical deploy path through the real UI against the e2e deploy host
// (fixtures/deploy-host.ts): project -> environment -> service -> deploy, failing build, cancel,
// ownership and secret hygiene. Every wait is on observable UI or host state, never a fixed sleep;
// each test cleans up its own projects in afterEach, even when it fails.
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BrowserContext, Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';
import { SLOW_BUILD_LINE_PREFIX, expect, test, type DeployHost } from './fixtures/deploy-host.js';

const BASE_URL = 'http://localhost:3000';
/** Per test; below the CI e2e job timeout, above one cold deploy plus a failed one. */
const TEST_TIMEOUT_MS = 8 * 60_000;
const DEPLOY_TIMEOUT_MS = 4 * 60_000;
const CLEANUP_TIMEOUT_MS = 90_000;
const NODE_API_PORT = 3000;

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

/** Mutations need the web origin (CSRF check); /api/* is proxied to the control plane. */
async function api(page: Page, method: string, url: string, data?: unknown): Promise<ApiResult> {
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

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string') throw new Error(`response has no string '${key}'`);
  return value;
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

function uniqueSuffix(): string {
  return randomInt(0, 0xffffff).toString(16).padStart(6, '0');
}

function freePort(): number {
  return randomInt(20_000, 30_000);
}

// ---- shared server (one per worker, connected over the API: not under test here) ----

let serverName = '';
let serverId = '';

async function connectServer(page: Page, host: DeployHost): Promise<void> {
  serverName = `deploy-${uniqueSuffix()}`;
  const created = await api(page, 'POST', '/api/servers', {
    name: serverName,
    host: host.ssh.host,
    sshPort: host.ssh.port,
    sshUser: host.ssh.user,
    credential: { type: 'ssh_private_key', privateKey: host.ssh.privateKey },
  });
  expect(created.status, 'create server').toBe(201);
  serverId = field(created.body, 'id');
  const connect = await api(page, 'POST', `/api/servers/${serverId}/connect`);
  expect(connect.status, 'connect server').toBe(202);
  await expect
    .poll(async () => field((await api(page, 'GET', `/api/servers/${serverId}`)).body, 'status'), {
      timeout: 120_000,
    })
    .toBe('CONNECTED');
}

// ---- per-test cleanup ----

interface Created {
  readonly projects: { id: string; name: string }[];
  readonly deployments: string[];
}
let created: Created = { projects: [], deployments: [] };

async function cleanup(page: Page): Promise<void> {
  for (const id of created.deployments) await api(page, 'POST', `/api/deployments/${id}/cancel`).catch(() => undefined);
  for (const project of created.projects) {
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
    const left = await api(page, 'GET', `/api/projects/${project.id}`);
    expect(left.status, `project ${project.name} removed by cleanup`).toBe(404);
  }
}

// ---- UI steps ----

async function createProjectInUi(page: Page, name: string): Promise<string> {
  await page.goto('/projects');
  // Toolbar button once projects exist, empty-state action before.
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByTestId('project-sheet-name').fill(name);
  await page.getByTestId('project-sheet-submit').click();
  await expect(page.getByTestId('project-sheet')).toBeHidden();
  // 13-21: creating navigates to the new project.
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop() ?? '';
  created.projects.push({ id, name });
  return id;
}

async function createEnvironmentInUi(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: 'New environment' }).first().click();
  await page.getByTestId('environment-sheet-name').fill(name);
  await page.getByTestId('environment-sheet-submit').click();
  await expect(page.getByTestId('environment-sheet')).toBeHidden();
  const section = page.locator('section[data-testid^="environment-section-"]').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
  await expect(section).toBeVisible();
  return ((await section.getAttribute('data-testid')) ?? '').replace('environment-section-', '');
}

type ServiceSource =
  | { readonly mode: 'git'; readonly repositoryUrl: string }
  | { readonly mode: 'image'; readonly imageRef: string };

async function createServiceInUi(
  page: Page,
  environmentId: string,
  input: { name: string; source: ServiceSource; internalPort: number; publishedPort: number },
): Promise<string> {
  await page.getByTestId(`new-service-${environmentId}`).click();
  const sheet = page.getByTestId('service-sheet');
  await expect(sheet).toBeVisible();
  await page.getByTestId('service-sheet-name').fill(input.name);
  await sheet.getByTestId('service-sheet-server').filter({ hasText: serverName }).getByRole('radio').check();
  if (input.source.mode === 'git') {
    await sheet.getByRole('radio', { name: 'Git' }).click();
    await page.getByTestId('source-repositoryUrl').fill(input.source.repositoryUrl);
  } else {
    await sheet.getByRole('radio', { name: 'Image' }).click();
    await page.getByTestId('source-imageRef').fill(input.source.imageRef);
  }
  await page.getByTestId('service-sheet-internal-port').fill(String(input.internalPort));
  await page.getByTestId('service-sheet-published-port').fill(String(input.publishedPort));
  await page.getByTestId('service-sheet-submit').click();
  await expect(sheet).toBeHidden();
  // 13-21: creating navigates to the new service.
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/services\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('service-toolbar')).toBeVisible();
  return new URL(page.url()).pathname.split('/').pop() ?? '';
}

async function openService(page: Page, projectId: string, serviceId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/services/${serviceId}`);
  await expect(page.getByTestId('service-toolbar')).toBeVisible();
}

/** Generates the write-only deploy key in the edit sheet and lets it read the git host. */
async function grantDeployKey(page: Page, host: DeployHost): Promise<void> {
  await page.getByTestId('service-edit').click();
  const sheet = page.getByTestId('service-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('credential-replace').click();
  const publicKey = (await sheet.getByTestId('deploy-key-public').innerText()).trim();
  await expect(sheet.getByTestId('credential-status')).toHaveText('Configured');
  await host.authorizeGitKey(publicKey);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
}

/** Clicks Deploy, opens the new deployment's build log in the inspector, returns its id. */
async function deploy(page: Page): Promise<string> {
  const before = new Set(await deploymentRowIds(page));
  await page.getByTestId('service-deploy').click();
  let id = '';
  await expect
    .poll(async () => {
      id = (await deploymentRowIds(page)).find((row) => !before.has(row)) ?? '';
      return id;
    })
    .not.toBe('');
  created.deployments.push(id);
  await page.getByTestId(`deployment-row-${id}`).click();
  await expect(page.getByTestId('build-log-panel')).toBeVisible();
  return id;
}

async function deploymentRowIds(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="deployment-row-"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid') ?? ''));
  return ids.map((testId) => testId.replace('deployment-row-', ''));
}

async function expectDeploymentStatus(page: Page, deploymentId: string, status: string): Promise<void> {
  await expect(page.getByTestId(`deployment-row-${deploymentId}`)).toHaveAttribute('data-status', status, {
    timeout: DEPLOY_TIMEOUT_MS,
  });
}

function buildLog(page: Page) {
  return page.getByRole('log', { name: 'Build log' });
}

async function containerId(host: DeployHost, name: string): Promise<string> {
  const result = await host.exec(['docker', 'inspect', '--format', '{{.Id}} {{.State.Running}}', name], { user: 'deployer' });
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

const execFileAsync = promisify(execFile);

/** Everything a page could leak a secret through: console, response bodies, SSE frames. */
interface LeakCapture {
  readonly console: string[];
  readonly responses: string[];
}

function captureLeaks(context: BrowserContext): LeakCapture {
  const capture: LeakCapture = { console: [], responses: [] };
  context.on('console', (message) => capture.console.push(message.text()));
  context.on('weberror', (error) => capture.console.push(String(error.error())));
  context.on('response', (response) => {
    // An SSE body never ends; its frames are recorded in the page (installSseRecorder).
    if ((response.headers()['content-type'] ?? '').includes('text/event-stream')) return;
    void response.text().then(
      (text) => capture.responses.push(text),
      () => undefined,
    );
  });
  return capture;
}

/** Records every EventSource frame the app receives, so SSE payloads can be checked too. */
async function installSseRecorder(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const frames: string[] = [];
    (window as unknown as { __sseFrames: string[] }).__sseFrames = frames;
    const Native = window.EventSource;
    class Recording extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        const original = this.dispatchEvent.bind(this);
        this.dispatchEvent = (event: Event): boolean => {
          if (event instanceof MessageEvent) frames.push(String(event.data));
          return original(event);
        };
      }
    }
    window.EventSource = Recording;
  });
}

async function sseFrames(page: Page): Promise<string> {
  return page.evaluate(() => ((window as unknown as { __sseFrames?: string[] }).__sseFrames ?? []).join('\n'));
}

/** Text of an artifact; zip archives (traces) are expanded entry by entry. */
async function artifactText(file: string): Promise<string> {
  if (!file.endsWith('.zip')) return readFileSync(file).toString('latin1');
  const { stdout } = await execFileAsync('unzip', ['-p', file], { maxBuffer: 512 * 1024 * 1024, encoding: 'latin1' });
  return stdout;
}

function filesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry);
    try {
      return readdirSync(full).length >= 0 ? filesUnder(full) : [];
    } catch {
      return [full];
    }
  });
}

/** A PEM header followed by key bytes (app bundles mention the header text in placeholders). */
const PRIVATE_KEY_MATERIAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40}/;

/** Set by the canary scenario; afterAll scans every artifact of this run for it. */
let canary = '';
let artifactsDir = '';

const SLOW_LINE = new RegExp(`${SLOW_BUILD_LINE_PREFIX}(\\d+)`, 'g');

/** Numbers of the slow build's lines in the rendered build log, in render order. */
async function slowLineNumbers(page: Page): Promise<number[]> {
  const text = await buildLog(page).innerText();
  return [...text.matchAll(SLOW_LINE)].map((match) => Number(match[1]));
}

function expectContiguousOnce(numbers: readonly number[]): void {
  // Each line exactly once and none missing: 1..n in order.
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_unused, index) => index + 1));
}

/** Command lines on the deploy host that belong to the slow build's RUN step. */
async function slowBuildProcesses(host: DeployHost): Promise<string[]> {
  const ps = await host.exec(['ps', '-eo', 'args']);
  expect(ps.exitCode, ps.stderr).toBe(0);
  return ps.stdout.split('\n').filter((line) => line.includes(SLOW_BUILD_LINE_PREFIX) || line.includes('sleep 613'));
}

test.describe('@e2e-deploy critical deploy path', () => {
  test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 });

  test.beforeAll(async ({ browser, deployHost }) => {
    test.setTimeout(5 * 60_000);
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      await connectServer(page, deployHost);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    // H1: no artifact this run wrote (screenshots, traces, HARs, error contexts) holds the canary.
    if (canary !== '' && artifactsDir !== '') {
      for (const file of filesUnder(artifactsDir)) {
        const text = await artifactText(file);
        expect(text.includes(canary), `canary leaked into ${path.relative(artifactsDir, file)}`).toBe(false);
      }
    }
    if (serverId === '') return;
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      const removed = await api(page, 'DELETE', `/api/servers/${serverId}`, { confirmName: serverName });
      expect([200, 204, 404]).toContain(removed.status);
    } finally {
      await context.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    created = { projects: [], deployments: [] };
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanup(page);
  });

  test('deploys node-api from the UI with live build logs, then a failing build leaves it untouched', async ({
    page,
    deployHost,
  }) => {
    const suffix = uniqueSuffix();
    const projectId = await createProjectInUi(page, `Deploy ${suffix}`);
    const environmentId = await createEnvironmentInUi(page, 'production');
    const apiPort = freePort();
    const apiId = await createServiceInUi(page, environmentId, {
      name: 'api',
      source: { mode: 'git', repositoryUrl: deployHost.repos.nodeApi },
      internalPort: NODE_API_PORT,
      publishedPort: apiPort,
    });

    // A1: deploy, build log streams into the inspector, all four steps succeed.
    await openService(page, projectId, apiId);
    await grantDeployKey(page, deployHost);
    const first = await deploy(page);
    await expect(buildLog(page)).toContainText('server.js', { timeout: DEPLOY_TIMEOUT_MS });
    await expectDeploymentStatus(page, first, 'SUCCESS');
    for (const step of ['clone', 'build', 'start', 'verify']) {
      await expect(page.getByTestId(`deployment-step-${step}`)).toHaveAttribute('data-severity', 'pass');
    }
    await expect(page.getByTestId('build-log-status')).toContainText(/succe/i);

    // A2: the service answers on its published port, from inside the deploy host.
    const answer = await deployHost.curlPublishedPort(apiPort, '/');
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ service: 'node-api', ok: true });
    const running = await containerId(deployHost, `noodara-${apiId}`);
    expect(running).toMatch(/ true$/);

    // A3: a failing build ends FAILED with the BUILD_FAILED copy and recovery.
    await page.goto(`/projects/${projectId}`);
    const brokenId = await createServiceInUi(page, environmentId, {
      name: 'broken',
      source: { mode: 'git', repositoryUrl: deployHost.repos.failingBuild },
      internalPort: NODE_API_PORT,
      publishedPort: freePort(),
    });
    await openService(page, projectId, brokenId);
    await grantDeployKey(page, deployHost);
    const failed = await deploy(page);
    await expectDeploymentStatus(page, failed, 'FAILED');
    const error = page.getByTestId('deployment-error');
    await expect(error).toContainText('Build failed');
    await expect(error).toContainText('Check the last lines of the build log, fix the Dockerfile or the code, then deploy again.');
    await expect(page.getByTestId('deployment-step-build')).toHaveAttribute('data-severity', 'fail');
    await expect(buildLog(page)).toContainText('NOODARA_FIXTURE_BUILD_FAILURE');

    // ...and the first service's container is the same one, still running and answering.
    expect(await containerId(deployHost, `noodara-${apiId}`)).toBe(running);
    expect((await deployHost.curlPublishedPort(apiPort, '/')).status).toBe(200);
  });

  test('cancels an in-progress build: CANCELLED, no build process and no leftovers on the host', async ({
    page,
    deployHost,
  }) => {
    const projectId = await createProjectInUi(page, `Cancel ${uniqueSuffix()}`);
    const environmentId = await createEnvironmentInUi(page, 'staging');
    const serviceId = await createServiceInUi(page, environmentId, {
      name: 'slow',
      source: { mode: 'git', repositoryUrl: deployHost.repos.slowBuild },
      internalPort: NODE_API_PORT,
      publishedPort: freePort(),
    });
    await openService(page, projectId, serviceId);
    await grantDeployKey(page, deployHost);
    const deploymentId = await deploy(page);

    // Live: lines keep arriving in the inspector while the deployment is BUILDING.
    await expect(buildLog(page)).toContainText(`${SLOW_BUILD_LINE_PREFIX}3`, { timeout: DEPLOY_TIMEOUT_MS });
    await expect(page.getByTestId(`deployment-row-${deploymentId}`)).toHaveAttribute('data-status', 'BUILDING');
    await expect(buildLog(page)).toContainText(`${SLOW_BUILD_LINE_PREFIX}6`);
    const beforeReload = await slowLineNumbers(page);
    expectContiguousOnce(beforeReload);

    // H3: a reload mid-build shows the same log, nothing duplicated or lost, and keeps streaming.
    await page.reload();
    await expect(page.getByTestId('build-log-panel')).toBeVisible();
    const last = beforeReload.length;
    await expect(buildLog(page)).toContainText(`${SLOW_BUILD_LINE_PREFIX}${String(last + 2)}`);
    const afterReload = await slowLineNumbers(page);
    expectContiguousOnce(afterReload);
    expect(afterReload.slice(0, last)).toEqual(beforeReload);

    // The RUN step is a live process on the host before the cancel (so the check below means something).
    expect(await slowBuildProcesses(deployHost)).not.toEqual([]);

    // A4: cancel ends CANCELLED.
    await page.getByTestId('service-cancel').click();
    await expectDeploymentStatus(page, deploymentId, 'CANCELLED');
    await expect(page.getByTestId('build-log-status')).toContainText(/cancel/i);

    // H3: the build process is gone; A4: no container, image, network or workspace is left for it.
    await expect.poll(() => slowBuildProcesses(deployHost), { timeout: 30_000 }).toEqual([]);
    const mine = (names: readonly string[]): string[] =>
      names.filter((name) => name.includes(serviceId) || name.includes(deploymentId));
    await expect.poll(async () => mine(await deployHost.listContainers()), { timeout: 30_000 }).toEqual([]);
    expect(mine(await deployHost.listImages())).toEqual([]);
    expect(mine(await deployHost.listNetworks())).toEqual([]);
    expect(mine(await deployHost.listWorkspaces())).toEqual([]);
  });

  test('a service of project A requested under project B is not found in the UI and the API', async ({ page, deployHost }) => {
    const suffix = uniqueSuffix();
    const createProject = async (name: string): Promise<string> => {
      const project = await api(page, 'POST', '/api/projects', { name });
      expect(project.status, JSON.stringify(project.body)).toBe(201);
      const id = field(project.body, 'id');
      created.projects.push({ id, name });
      return id;
    };
    const projectA = await createProject(`Owner A ${suffix}`);
    const projectB = await createProject(`Owner B ${suffix}`);
    const environment = await api(page, 'POST', `/api/projects/${projectA}/environments`, { name: 'production' });
    expect(environment.status, JSON.stringify(environment.body)).toBe(201);
    const nginx = deployHost.preloadedImages.find((ref) => ref.includes('/nginx'));
    expect(nginx, 'an nginx image is preloaded').toBeDefined();
    const service = await api(page, 'POST', `/api/projects/${projectA}/services`, {
      environmentId: field(environment.body, 'id'),
      serverId,
      name: 'web',
      source: { kind: 'image', imageRef: String(nginx) },
      internalPort: 80,
      publishedPort: null,
    });
    expect(service.status, JSON.stringify(service.body)).toBe(201);
    const serviceA = field(service.body, 'id');

    // Control: the right project finds it.
    expect((await api(page, 'GET', `/api/projects/${projectA}/services/${serviceA}`)).status).toBe(200);

    // API: every project-scoped read and write under B answers 404.
    const underB = `/api/projects/${projectB}/services/${serviceA}`;
    expect((await api(page, 'GET', underB)).status).toBe(404);
    expect((await api(page, 'PATCH', underB, { name: 'stolen' })).status).toBe(404);
    expect((await api(page, 'DELETE', underB, { confirmName: 'web' })).status).toBe(404);
    expect((await api(page, 'GET', `${underB}/logs`)).status).toBe(404);
    expect((await api(page, 'GET', `${underB}/credentials`)).status).toBe(404);
    expect((await api(page, 'GET', `/api/projects/${projectA}/services/${serviceA}`)).status).toBe(200);

    // UI: the service view under B shows not found and nothing of the service.
    await page.goto(`/projects/${projectB}/services/${serviceA}`);
    await expect(page.getByTestId('service-not-found')).toBeVisible();
    await expect(page.getByTestId('service-toolbar')).toHaveCount(0);
    await expect(page.getByTestId('service-deploy')).toHaveCount(0);
  });

  test('keeps a registry password entered in the service form out of the DOM, console, responses and artifacts', async ({
    page,
    browser,
    deployHost,
  }, testInfo) => {
    canary = deployHost.registry.password;
    artifactsDir = testInfo.project.outputDir;
    const entry = captureLeaks(page.context());
    await installSseRecorder(page.context());

    const projectId = await createProjectInUi(page, `Canary ${uniqueSuffix()}`);
    const environmentId = await createEnvironmentInUi(page, 'production');
    const nginx = deployHost.preloadedImages.find((ref) => ref.includes('/nginx'));
    expect(nginx, 'an nginx image is preloaded').toBeDefined();
    const port = freePort();
    const serviceId = await createServiceInUi(page, environmentId, {
      name: 'web',
      source: { mode: 'image', imageRef: String(nginx) },
      internalPort: 80,
      publishedPort: port,
    });
    await openService(page, projectId, serviceId);

    // Entered once, write-only, in the edit sheet.
    await page.getByTestId('service-edit').click();
    const sheet = page.getByTestId('service-sheet');
    await sheet.getByTestId('credential-replace').click();
    await sheet.getByTestId('credential-registry-username').fill(deployHost.registry.username);
    await sheet.getByTestId('credential-secret').fill(canary);
    await sheet.getByTestId('credential-save').click();
    await expect(sheet.getByTestId('credential-status')).toHaveText('Configured');
    await expect(sheet.getByTestId('credential-secret')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    const entryDom = await page.content();

    // Everything after entry runs in a context that records a trace and a HAR.
    const harPath = testInfo.outputPath('canary.har');
    const tracePath = testInfo.outputPath('canary-trace.zip');
    const context = await browser.newContext({
      baseURL: BASE_URL,
      storageState: await page.context().storageState(),
      recordHar: { path: harPath, content: 'embed' },
    });
    const recorded = captureLeaks(context);
    await installSseRecorder(context);
    await context.tracing.start({ snapshots: true, screenshots: false });
    let doms: string[] = [];
    let frames = '';
    try {
      const watched = await context.newPage();
      await openService(watched, projectId, serviceId);
      const deploymentId = await deploy(watched);
      await expectDeploymentStatus(watched, deploymentId, 'SUCCESS');
      await expect(watched.getByTestId('deployment-step-pull')).toHaveAttribute('data-severity', 'pass');
      // The pull logged in with the canary: the image runs and answers.
      expect((await deployHost.curlPublishedPort(port, '/')).status).toBe(200);
      await watched.getByTestId('service-edit').click();
      await expect(watched.getByTestId('credential-status')).toHaveText('Configured');
      doms.push(await watched.content());
      await watched.keyboard.press('Escape');
      await watched.reload();
      await expect(watched.getByTestId('build-log-panel')).toBeVisible();
      doms.push(await watched.content());
      frames = await sseFrames(watched);
      await watched.goto('about:blank');
    } finally {
      await context.tracing.stop({ path: tracePath });
      await context.close();
    }
    doms = [entryDom, ...doms];
    frames += await sseFrames(page);

    const surfaces: Record<string, string> = {
      dom: doms.join('\n'),
      console: [...entry.console, ...recorded.console].join('\n'),
      responses: [...entry.responses, ...recorded.responses].join('\n'),
      sse: frames,
      har: readFileSync(harPath, 'utf8'),
      trace: await artifactText(tracePath),
    };
    expect(surfaces['responses']?.length ?? 0, 'responses were captured').toBeGreaterThan(0);
    expect(surfaces['har'], 'the HAR recorded the deploy').toContain(`/api/services/${serviceId}/deploy`);
    for (const [surface, text] of Object.entries(surfaces)) {
      expect(text.includes(canary), `canary absent from ${surface}`).toBe(false);
      expect(PRIVATE_KEY_MATERIAL.test(text), `no private key material in ${surface}`).toBe(false);
    }
  });
});
