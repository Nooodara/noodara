// 29-01 (A1-A3, H1): the eval dataset is data, so it is tested like code. Every scenario parses
// against the strict schema, its fixture loads into the in-memory repository behind the real tool
// registry, its expected diagnosis is what the domain classifier concludes from its evidence, its
// entities resolve and respect the conversation scope, and nothing in it is a real credential.
import { readFileSync } from 'node:fs';
import { DIAGNOSES, LOG_SOURCES, classifyEvidence } from '@noodara/domain';
import {
  DeploymentViewSchema,
  GraphViewSchema,
  LogEntryViewSchema,
  MetricSeriesResponseSchema,
  ServiceStatusSummarySchema,
} from '@noodara/domain/api-contract';
import { describe, expect, it } from 'vitest';
import { buildFixtureModel, type FixtureModel } from './lib/fixture-model.js';
import { FIXTURES_DIR, SCENARIOS_DIR, loadDataset, loadScenarioContext, yamlFiles, type ScenarioContext } from './lib/load.js';
import { CANARY_PATTERN, CANARY_PREFIX, ROADMAP_QUESTION_TYPES, type Scenario } from './lib/schema.js';
import { findRealSecrets } from './lib/secret-scan.js';

const dataset = loadDataset();
const { manifest, scenarios, fixtures } = dataset;
const models = new Map([...fixtures].map(([id, fixture]) => [id, buildFixtureModel(fixture)]));
const model = (id: string): FixtureModel => models.get(id) as FixtureModel;
const isScoped = (scenario: Scenario) => scenario.scope !== 'global';

const HOUR_MS = 3600 * 1000;

function session(context: ScenarioContext) {
  return context.registry.openSession({ scope: context.scope, redactor: context.redactor, maxCalls: 500, now: () => context.nowMs });
}

/** Whether `ref` is visible to the scenario's conversation, asked through the real tools. */
async function visible(context: ScenarioContext, ref: string): Promise<boolean> {
  const entity = context.model.entity(ref);
  const tools = session(context);
  const call = async (name: string, input: unknown) => {
    const execution = await tools.execute({ name, input });
    if (execution.status === 'ok') return execution.content;
    expect(execution.errorCode).toBe('NOT_FOUND');
    return null;
  };
  switch (entity.kind) {
    case 'Server':
      return (await call('get_server', { serverId: entity.id })) !== null;
    case 'Service':
      return (await call('get_service', { serviceId: entity.id })) !== null;
    case 'Deployment':
      return (await call('get_deployment', { deploymentId: entity.id })) !== null;
    case 'Project':
      return (await call('list_services', { projectId: entity.id })) !== null;
    case 'Environment':
      return (await call('list_services', { environmentId: entity.id })) !== null;
    case 'Domain':
      return ((await call('get_infrastructure_graph', {})) ?? '').includes(`"label":"${entity.label}"`);
  }
}

describe('dataset manifest (A3, H1)', () => {
  it('is versioned: the version is the last changelog entry and versions only grow', () => {
    const versions = manifest.changelog.map((entry) => entry.version);
    expect(manifest.version).toBe(versions.at(-1));
    const numeric = versions.map((v) => v.split('.').map(Number) as [number, number, number]);
    for (let i = 1; i < numeric.length; i += 1) {
      const [a, b] = [numeric[i - 1] as number[], numeric[i] as number[]];
      expect(a[0]! * 1e6 + a[1]! * 1e3 + a[2]! < b[0]! * 1e6 + b[1]! * 1e3 + b[2]!).toBe(true);
    }
  });

  it('scenario ids are unique across every file', () => {
    const ids = scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ids are stable: the live set is exactly what the changelog added minus what it retired, and a retired id never returns', () => {
    const added = manifest.changelog.flatMap((entry) => entry.added);
    const retired = manifest.changelog.flatMap((entry) => entry.retired);
    expect(new Set(added).size).toBe(added.length);
    expect(retired.every((id) => added.includes(id))).toBe(true);
    for (const [index, entry] of manifest.changelog.entries()) {
      const retiredBefore = manifest.changelog.slice(0, index).flatMap((e) => e.retired);
      expect(entry.added.filter((id) => retiredBefore.includes(id))).toEqual([]);
    }
    const live = added.filter((id) => !retired.includes(id)).sort();
    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual(live);
  });
});

describe('fixtures (A1, A3)', () => {
  it('every fixture builds and is used by at least one scenario', () => {
    expect(fixtures.size).toBeGreaterThanOrEqual(5);
    for (const id of fixtures.keys()) expect(scenarios.some((scenario) => scenario.fixture === id), id).toBe(true);
  });

  it('includes multi-server and multi-project fixtures that scenarios use', () => {
    const multiServer = [...models.values()].filter((m) => new Set(m.services.map((s) => s.serverId)).size >= 3);
    const multiProject = [...models.values()].filter((m) => m.projects.length >= 2);
    expect(multiServer.length).toBeGreaterThanOrEqual(1);
    expect(multiProject.length).toBeGreaterThanOrEqual(1);
    for (const m of [...multiServer, ...multiProject]) {
      expect(scenarios.filter((scenario) => scenario.fixture === m.fixtureId).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('canary secrets carry the NOODARA_CANARY_ prefix and are unique across the dataset', () => {
    const values = [...models.values()].flatMap((m) => m.secrets.map((secret) => secret.value));
    for (const value of values) {
      expect(value.startsWith(CANARY_PREFIX)).toBe(true);
      expect(value).toMatch(CANARY_PATTERN);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it('some canaries reach raw log lines, so a leak through the tools is measurable', () => {
    const leaking = [...models.values()].flatMap((m) =>
      m.services.filter((service) => service.logs.some((log) => m.secrets.some((secret) => log.text.includes(secret.value)))),
    );
    expect(leaking.length).toBeGreaterThanOrEqual(2);
  });
});

describe('real credentials never enter the dataset (H1)', () => {
  const files = [...yamlFiles(SCENARIOS_DIR), ...yamlFiles(FIXTURES_DIR)];

  it('no scenario or fixture file holds a provider key, an AWS key or an SSH private key', () => {
    for (const file of files) expect(findRealSecrets(readFileSync(file, 'utf8')), file).toEqual([]);
  });

  it('every canary-looking string in the files is a well-formed canary', () => {
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/NOODARA_CANARY_\w*/g)) expect(match[0]).toMatch(CANARY_PATTERN);
    }
  });

  it('the scan detects each real shape and ignores look-alikes such as disk-', () => {
    const tail = 'Ab3dEf6hIj9kLm2nOp5qRs8t';
    expect(findRealSecrets(`key=${'sk-' + 'ant-'}api03-${tail}`)).toContain('anthropic-key');
    expect(findRealSecrets(`OPENAI=${'sk-' + 'proj-'}${tail}`)).toContain('openai-key');
    expect(findRealSecrets(`id ${'AK' + 'IA'}ABCDEFGHIJKLMNOP`)).toContain('aws-access-key');
    expect(findRealSecrets(`${'-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'}`)).toContain('ssh-private-key');
    expect(findRealSecrets(`${'-----BEGIN RSA ' + 'PRIVATE KEY-----'}`)).toContain('ssh-private-key');
    expect(findRealSecrets('disk-pressure-servers task-runner-0123456789abcdefghij NOODARA_CANARY_00ff')).toEqual([]);
  });
});

describe('coverage (A2)', () => {
  it('has at least 50 scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(50);
  });

  it.each(ROADMAP_QUESTION_TYPES)('covers question type %s of roadmap §10.7 with at least five scenarios', (type) => {
    expect(scenarios.filter((scenario) => scenario.questionType === type).length).toBeGreaterThanOrEqual(5);
  });

  it.each(DIAGNOSES)('a diagnose scenario expects %s', (diagnosis) => {
    expect(
      scenarios.some((s) => s.questionType === 'diagnose' && s.expected.outcome === 'answer' && s.expected.diagnosis === diagnosis),
    ).toBe(true);
  });

  it('has project-scoped NOT_FOUND cases across question types', () => {
    const scopedNotFound = scenarios.filter((s) => isScoped(s) && s.expected.outcome === 'not_found');
    expect(new Set(scopedNotFound.map((s) => s.questionType)).size).toBeGreaterThanOrEqual(5);
  });
});

describe.each(scenarios.map((scenario) => [scenario.id, scenario] as const))('scenario %s', (_id, scenario) => {
  const context = loadScenarioContext(scenario, fixtures);

  it('expects what the classifier concludes from its evidence', () => {
    expect(classifyEvidence(context.evidence)[0]?.diagnosis).toBe(scenario.expected.diagnosis);
  });

  it('cites entities that exist, never both expected and forbidden', () => {
    const expected = scenario.expected.entities;
    const forbidden = scenario.forbidden.entities;
    for (const ref of [...expected, ...forbidden]) expect(() => context.model.entity(ref)).not.toThrow();
    expect(expected.filter((ref) => forbidden.includes(ref))).toEqual([]);
    if (scenario.expected.outcome === 'not_found') expect(expected).toEqual([]);
  });

  it('expected entities are visible through the tools in its scope', async () => {
    for (const ref of scenario.expected.entities) expect(await visible(context, ref), ref).toBe(true);
  });

  it.runIf(isScoped(scenario))('entities of other projects it forbids are NOT_FOUND in its scope', async () => {
    const projectId = context.model.entity(`project:${(scenario.scope as { project: string }).project}`).id;
    const foreign = scenario.forbidden.entities.filter((ref) => {
      const entity = context.model.entity(ref);
      if (entity.kind === 'Project') return entity.id !== projectId;
      if (entity.kind === 'Service') return context.model.services.find((s) => s.id === entity.id)?.projectId !== projectId;
      if (entity.kind === 'Server') return !context.model.services.some((s) => s.serverId === entity.id && s.projectId === projectId);
      return true;
    });
    expect(foreign.length).toBeGreaterThan(0);
    for (const ref of foreign) expect(await visible(context, ref), ref).toBe(false);
  });
});

describe.each([...fixtures.keys()])('fixture %s through the real tools', (fixtureId) => {
  const probe = scenarios.find((scenario) => scenario.fixture === fixtureId && !isScoped(scenario)) as Scenario;
  const context = loadScenarioContext({ ...probe, evidence: probe.evidence }, fixtures);
  const m = model(fixtureId);
  const global = { kind: 'global' } as const;
  const logFilter = { sources: [...LOG_SOURCES], sinceMs: m.nowMs - 7 * 24 * HOUR_MS, untilMs: m.nowMs, level: null, search: null };

  it('answers views that match the API contract', async () => {
    for (const service of m.services) {
      for (const deployment of service.deployments) {
        const outcome = await context.backend.get_deployment({ deploymentId: deployment.id }, global);
        expect(outcome.ok && DeploymentViewSchema.safeParse(outcome.data).success).toBe(true);
      }
      const health = await context.backend.get_health({ serviceId: service.id }, global);
      expect(health.ok && ServiceStatusSummarySchema.safeParse(health.data).error).toBeUndefined();
      const metrics = await context.backend.get_metrics({ target: 'service', id: service.id, points: 60 }, global);
      expect(metrics.ok && MetricSeriesResponseSchema.safeParse(metrics.data).error).toBeUndefined();
      const logs = await context.backend.get_logs({ serviceId: service.id, filter: logFilter, limit: 200, maxBytes: 65_536 }, global);
      if (logs.ok) {
        const entries = (logs.data as { entries: unknown[] }).entries;
        for (const entry of entries) expect(LogEntryViewSchema.safeParse(entry).error).toBeUndefined();
      } else {
        expect(logs.code).toBe('LOG_SOURCE_UNAVAILABLE');
      }
    }
    for (const server of m.servers) {
      const metrics = await context.backend.get_metrics({ target: 'server', id: server.id, points: 60 }, global);
      const series = metrics.ok ? { series: (metrics.data as { series: unknown }).series } : null;
      expect(MetricSeriesResponseSchema.safeParse(series).error).toBeUndefined();
    }
    const graph = await context.backend.get_infrastructure_graph({ maxNodes: 5000 }, global);
    expect(graph.ok && GraphViewSchema.safeParse(graph.data).error).toBeUndefined();
  });

  it('never returns a canary value from any tool, logs included', async () => {
    const tools = session({ ...context, scope: global });
    const contents: string[] = [];
    const run = async (name: string, input: unknown) => contents.push((await tools.execute({ name, input })).content);
    await run('list_servers', {});
    await run('list_services', {});
    await run('get_infrastructure_graph', {});
    for (const server of m.servers) {
      await run('get_server', { serverId: server.id });
      await run('get_metrics', { target: 'server', id: server.id });
    }
    for (const service of m.services) {
      await run('get_service', { serviceId: service.id });
      await run('get_health', { serviceId: service.id });
      await run('list_deployments', { serviceId: service.id });
      await run('get_metrics', { target: 'service', id: service.id });
      await run('get_logs', { serviceId: service.id, since: new Date(m.nowMs - 3 * HOUR_MS).toISOString() });
    }
    const all = contents.join('\n');
    for (const secret of m.secrets) expect(all.includes(secret.value), secret.name).toBe(false);
    expect(all).not.toContain(CANARY_PREFIX);
  });
});
