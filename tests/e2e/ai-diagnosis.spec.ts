// 30-05 (A2): a deployed service is constrained (`docker update --memory 64m`) and made to allocate
// until the kernel OOM-kills it; a marker in its writable layer keeps every restart allocating, so
// Docker reports OOMKilled while the container waits to restart. Once the collector has written
// its out_of_memory observation to the activity log, the question "why did it restart?" asked in
// the inspector chat is answered `out_of_memory` with OOMKilled evidence from that observation.
import { expect, test } from './fixtures/deploy-host.js';
import {
  api,
  createGitService,
  createProject,
  deployViaApi,
  fixtureFiles,
  freePort,
  testRepo,
  uniqueSuffix,
  waitForStatus,
  type EngineService,
  type FixtureFiles,
} from './fixtures/engine.js';
import { AI_LIVE, aiSuite, askInUi, whyRestartedPolicy } from './helpers/ai-flow.js';

const MEMORY_LIMIT = '64m';
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** The collector samples every 60 s (env default); two samples and the write fit well inside this. */
const OOM_OBSERVED_TIMEOUT_MS = 4 * 60_000;
const OOM_ACTIVITY = /: out_of_memory$/;

// node-api plus `GET /oom`: it drops a marker, then allocates (capped at 256 MiB so a missing limit
// cannot hurt the host). On start the marker makes every restart allocate again.
const OOM_SERVER = `import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 3000;
const MARKER = '/tmp/noodara-e2e-oom';
const held = [];

function exhaust() {
  for (let i = 0; i < 32; i += 1) held.push(Buffer.alloc(8 * 1024 * 1024, 1));
  console.log('noodara-e2e-oom survived');
}

if (existsSync(MARKER)) exhaust();

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method === 'GET' && req.url === '/oom') {
    writeFileSync(MARKER, '1');
    res.writeHead(202, { 'content-type': 'text/plain' });
    res.end('allocating');
    setTimeout(exhaust, 50);
    return;
  }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'oom-api', ok: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT);

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
`;

function oomApiFiles(): FixtureFiles {
  return { ...fixtureFiles('node-api'), 'server.js': OOM_SERVER };
}

async function activityTexts(page: Parameters<typeof api>[0], service: EngineService): Promise<string[]> {
  const url = `/api/projects/${service.projectId}/services/${service.serviceId}/logs/entries?sources=activity`;
  const result = await api(page, 'GET', url);
  if (result.status !== 200) return [];
  const entries = (result.body as { entries?: { text?: unknown }[] }).entries ?? [];
  return entries.map((entry) => String(entry.text));
}

test.describe('@e2e-ai why did a service restart', () => {
  const suite = aiSuite();

  test('A2: an OOM-killed container is diagnosed out_of_memory with OOMKilled evidence', async ({ page, deployHost }) => {
    const name = `aid-${uniqueSuffix()}`;
    const repo = testRepo(deployHost, name);
    await repo.commit(oomApiFiles(), 'oom-api');
    const { projectId, environmentId } = await createProject(page, suite.cleanup(), `${name}-project`);
    const service = await createGitService(page, deployHost, {
      projectId,
      environmentId,
      serverId: suite.server().id,
      name,
      repoUrl: repo.url,
      publishedPort: freePort(),
    });
    const deploymentId = await deployViaApi(page, suite.cleanup(), service.serviceId);
    expect(await waitForStatus(page, deploymentId, ['SUCCESS', 'FAILED', 'ROLLED_BACK'])).toBe('SUCCESS');

    // Constrain the running container, then make it allocate past the limit.
    const ps = await deployHost.exec(['docker', 'ps', '-q', '--filter', `label=noodara.service_id=${service.serviceId}`]);
    const container = ps.stdout.trim().split('\n')[0] ?? '';
    expect(container, `container of ${name}: ${ps.stderr}`).toMatch(/^[0-9a-f]{12,64}$/);
    const update = await deployHost.exec(['docker', 'update', '--memory', MEMORY_LIMIT, '--memory-swap', MEMORY_LIMIT, container]);
    expect(update.exitCode, `docker update: ${update.stderr}`).toBe(0);
    const limit = await deployHost.exec(['docker', 'inspect', '-f', '{{.HostConfig.Memory}}', container]);
    expect(limit.stdout.trim()).toBe(String(MEMORY_LIMIT_BYTES));
    const trigger = await deployHost.curlPublishedPort(service.publishedPort, '/oom');
    expect(trigger.status).toBe(202);

    // The real observation: Docker says OOMKilled, then the collector records it.
    await expect
      .poll(async () => (await deployHost.exec(['docker', 'inspect', '-f', '{{.State.OOMKilled}} {{.RestartCount}}', container])).stdout.trim(), {
        timeout: 60_000,
        intervals: [1_000, 2_000],
      })
      .toMatch(/^true [1-9]\d*$/);
    await expect
      .poll(async () => (await activityTexts(page, service)).some((text) => OOM_ACTIVITY.test(text)), {
        timeout: OOM_OBSERVED_TIMEOUT_MS,
        intervals: [5_000],
      })
      .toBe(true);

    suite.replay()?.use(whyRestartedPolicy);
    const result = await askInUi(page, `Why did the service ${name} restart?`);

    const view = page.getByTestId('ai-turn').last().getByTestId('ai-answer');
    await expect(view.getByTestId('ai-diagnosis')).toContainText('Out of memory');
    const stored = result.assistant;
    expect(stored.status).toBe('complete');
    expect(stored.answer?.diagnosis).toBe('out_of_memory');
    const evidence = stored.answer?.evidence ?? [];
    expect(evidence.length, 'grounded evidence').toBeGreaterThan(0);

    if (!AI_LIVE) {
      // The evidence cites the real get_logs call and the collector's observation, not a script.
      expect(evidence[0]?.note).toMatch(/^OOMKilled observed: "service\.container_changed: out_of_memory" at /);
      await view.getByTestId('ai-evidence').getByRole('button').click();
      await expect(view.getByTestId('ai-evidence')).toContainText('OOMKilled observed');
      const names = stored.toolCalls.filter((call) => call.status === 'ok').map((call) => call.name);
      expect(names).toEqual(['get_infrastructure_graph', 'get_logs', 'get_health']);
      expect(suite.replay()?.transcript()).toContain('service.container_changed: out_of_memory');
    }
  });
});
