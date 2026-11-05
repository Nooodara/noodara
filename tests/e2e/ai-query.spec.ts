// 30-05 (A1): connect a server, deploy node-api, add a domain in the UI, then ask "where does it
// run?" from the inspector chat against the real stack. The answer names the right server and
// service, and the stored tool records prove the facts came from get_infrastructure_graph and
// get_service. CI answers with the replay provider (a deterministic agent over the real tool
// results); NOODARA_AI_EVAL_LIVE=1 runs the same flow against the live vendor (A4).
import { expect, test } from './fixtures/deploy-host.js';
import {
  createGitService,
  createProject,
  deployViaApi,
  fixtureFiles,
  freePort,
  openService,
  testRepo,
  uniqueSuffix,
  waitForStatus,
} from './fixtures/engine.js';
import { AI_LIVE, aiSuite, askInUi, toolsConsulted, whereRunsPolicy } from './helpers/ai-flow.js';

test.describe('@e2e-ai where does a service run', () => {
  const suite = aiSuite();

  test('A1: the answer names the server and service, from get_service and get_infrastructure_graph', async ({
    page,
    deployHost,
  }) => {
    const server = suite.server();
    const name = `aiq-${uniqueSuffix()}`;
    const repo = testRepo(deployHost, name);
    await repo.commit(fixtureFiles('node-api'), 'node-api');
    const { projectId, environmentId } = await createProject(page, suite.cleanup(), `${name}-project`);
    const service = await createGitService(page, deployHost, {
      projectId,
      environmentId,
      serverId: server.id,
      name,
      repoUrl: repo.url,
      publishedPort: freePort(),
    });
    const deploymentId = await deployViaApi(page, suite.cleanup(), service.serviceId);
    expect(await waitForStatus(page, deploymentId, ['SUCCESS', 'FAILED', 'ROLLED_BACK'])).toBe('SUCCESS');

    // The domain, from the service page (no proxy here: it stays pending, the graph still has it).
    const hostname = `${name}.r${uniqueSuffix()}.test`;
    await openService(page, service);
    const domains = page.getByTestId('domains-panel');
    await domains.getByTestId('domain-add-input').fill(hostname);
    await domains.getByTestId('domain-add-submit').click();
    await expect(domains.locator('[data-testid^="domain-row-"]').filter({ hasText: hostname })).toBeVisible();

    suite.replay()?.use(whereRunsPolicy);
    const result = await askInUi(page, `Where does the service ${name} run?`);

    // The UI: the answer names both, and the tools consulted are listed.
    const answerText = page.getByTestId('ai-turn').last().getByTestId('ai-answer-text');
    await expect(answerText).toContainText(name);
    await expect(answerText).toContainText(server.name);
    const consulted = await toolsConsulted(page);

    // The stored conversation: same answer, entities grounded on the real ids.
    const stored = result.assistant;
    expect(stored.status).toBe('complete');
    expect(stored.answer?.answer).toContain(name);
    expect(stored.answer?.answer).toContain(server.name);
    const entities = stored.answer?.entities ?? [];
    if (!AI_LIVE) {
      expect(entities).toEqual(
        expect.arrayContaining([
          { kind: 'Service', id: service.serviceId, label: name },
          { kind: 'Server', id: server.id, label: server.name },
        ]),
      );
      expect(stored.answer?.answer).toContain(hostname);
    }

    // Provenance: the tool records show where the facts came from.
    const names = stored.toolCalls.filter((call) => call.status === 'ok').map((call) => call.name);
    if (AI_LIVE) {
      expect(names.some((tool) => tool === 'get_service' || tool === 'get_infrastructure_graph'), names.join(',')).toBe(true);
    } else {
      expect(names).toEqual(['get_infrastructure_graph', 'get_service']);
      expect(consulted).toContain('get_infrastructure_graph');
      expect(consulted).toContain('get_service');
      // The replay only learned the server name from what the control plane's tools returned.
      const replay = suite.replay();
      expect(replay?.toolCallsIssued).toEqual(['get_infrastructure_graph', 'get_service']);
      expect(replay?.transcript()).toContain(server.name);
    }
  });
});
