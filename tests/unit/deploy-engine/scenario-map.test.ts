// 20-01 A1/H1: the roadmap §8.8 integration matrix stays proven. A pure unit test (no containers):
// it reads docs/releases/v0.3-scenarios.md, the roadmap and the mapped test sources under
// tests/integration/deploy-engine/ (the it-deploy-engine-all suites). 20-06: it runs under pnpm test.
// 25-01: also docs/releases/v0.4-scenarios.md and the remote-state comparison the proxy suites call.
// 31-01: also docs/releases/v0.5-scenarios.md (roadmap §10.1-§10.3 and every supported diagnosis).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIAGNOSES, GRAPH_NODE_KINDS, GRAPH_RELATION_TYPES } from '@noodara/domain';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS } from '../../integration/helpers/deploy-engine.js';
import {
  checkMappedTest,
  checkScenarioMap,
  checkV04ScenarioMap,
  checkV05ScenarioMap,
  parseMappedRows,
  parseScenarioMap,
  readRoadmapChecklist,
  readRoadmapScenarios,
  readRoadmapSectionBlocks,
  readRoadmapSectionLines,
  REMOTE_STATE_ASSERTION,
  sectionOf,
  UBUNTU_VERSIONS,
  V04_E2E_FLOWS,
  V04_INTEGRATION_SCENARIOS,
  V04_SECTIONS,
  V05_SECTIONS,
  v05Expected,
  type V05Table,
} from '../../integration/deploy-engine/scenario-map.js';
import {
  compareProxyState,
  parseRouteHosts,
  type DatabaseProxyState,
  type RemoteProxyState,
} from '../../integration/proxy/remote-state.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAP_PATH = 'docs/releases/v0.3-scenarios.md';
const ROADMAP_PATH = 'docs/roadmap-v0.1-v0.5.md';
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');
// 31-07 (rc.1 F2): each check re-reads and re-parses every mapped integration source, so the
// v0.5 cases took ~0.4 s locally and hit Vitest's 5 s default on a loaded CI runner. Reads are
// cached (sources never change during a run) and the suites that walk real sources get an
// explicit budget; the assertions are unchanged.
const SOURCE_SUITE_TIMEOUT_MS = 30_000;
const sourceCache = new Map<string, string | undefined>();
const readSource = (file: string): string | undefined => {
  if (!sourceCache.has(file)) {
    const full = path.join(REPO_ROOT, file);
    sourceCache.set(file, existsSync(full) ? readFileSync(full, 'utf8') : undefined);
  }
  return sourceCache.get(file);
};

const IMPORT = "import { DEPLOY_ENGINE_UBUNTU_VERSIONS } from '../helpers/deploy-engine.js';\n";
const perVersion = (inner: string, table = 'DEPLOY_ENGINE_UBUNTU_VERSIONS', suite = 'describe.each'): string =>
  `${IMPORT}${suite}(${table})('suite %s', (ubuntu) => {\n${inner}\n});\n`;
const TITLE = 'deploys';

describe('scenario map checker (H1)', { timeout: SOURCE_SUITE_TIMEOUT_MS }, () => {
  it('accepts a test that runs inside describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)', () => {
    expect(checkMappedTest(perVersion(`  it('${TITLE}', async () => { expect(ubuntu).toBeTruthy(); });`), 'a.test.ts', TITLE)).toEqual([]);
    expect(checkMappedTest(perVersion(`  it.each(['A', 'B'])('${TITLE}', async (s) => { void s; });`), 'a.test.ts', TITLE)).toEqual([]);
    expect(
      checkMappedTest(perVersion(`  describe('nested', () => { it('${TITLE}', () => {}); });`), 'a.test.ts', TITLE),
    ).toEqual([]);
  });

  it('fails when the mapped test name is missing or ambiguous', () => {
    expect(checkMappedTest(perVersion(`  it('renamed', () => {});`), 'a.test.ts', TITLE)).toEqual([`test not found: '${TITLE}'`]);
    expect(checkMappedTest(perVersion(`  it('${TITLE}', () => {});\n  it('${TITLE}', () => {});`), 'a.test.ts', TITLE)[0]).toMatch(
      /ambiguous/,
    );
  });

  it.each([
    ['it.skip', `  it.skip('${TITLE}', () => {});`],
    ['it.todo', `  it.todo('${TITLE}');`],
    ['it.skipIf', `  it.skipIf(true)('${TITLE}', () => {});`],
    ['it.runIf', `  it.runIf(false)('${TITLE}', () => {});`],
    ['it.skip.each', `  it.skip.each([1])('${TITLE}', () => {});`],
    ['describe.skip', `  describe.skip('inner', () => { it('${TITLE}', () => {}); });`],
    ['describe.skipIf', `  describe.skipIf(true)('inner', () => { it('${TITLE}', () => {}); });`],
    ['context.skip()', `  it('${TITLE}', (context) => { context.skip(); });`],
  ])('fails when the mapped test is skipped (%s)', (_label, inner) => {
    expect(checkMappedTest(perVersion(inner), 'a.test.ts', TITLE).join('\n')).toMatch(/skip|no body/);
  });

  it('fails when the test does not run on both Ubuntu versions', () => {
    const plain = `${IMPORT}describe('suite', () => {\n  it('${TITLE}', () => {});\n});\n`;
    expect(checkMappedTest(plain, 'a.test.ts', TITLE).join('\n')).toMatch(/does not run per Ubuntu version/);
    expect(checkMappedTest(perVersion(`  it('${TITLE}', () => {});`, "['24.04']"), 'a.test.ts', TITLE).join('\n')).toMatch(
      /does not run per Ubuntu version/,
    );
    expect(checkMappedTest(perVersion(`  it('${TITLE}', () => {});`, 'DEPLOY_ENGINE_UBUNTU_VERSIONS', 'describe.skip.each'), 'a.test.ts', TITLE).join('\n')).toMatch(
      /enclosing suite is skipped/,
    );
    const local = `const DEPLOY_ENGINE_UBUNTU_VERSIONS = ['24.04'];\ndescribe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('s %s', (ubuntu) => {\n  it('${TITLE}', () => {});\n});\n`;
    expect(checkMappedTest(local, 'a.test.ts', TITLE).join('\n')).toMatch(/is not imported/);
    const early = perVersion(`  it('${TITLE}', () => {\n    if (ubuntu === '22.04') return;\n  });`);
    expect(checkMappedTest(early, 'a.test.ts', TITLE).join('\n')).toMatch(/returns early on an Ubuntu version/);
  });

  it('fails when a scenario is unmapped, mapped to a missing test or lacks an Ubuntu version', () => {
    const roadmap = read(ROADMAP_PATH);
    const map = read(MAP_PATH);
    const firstRow = map.split('\n').find((line) => /^\|\s*1\s*\|/.test(line)) ?? '';
    expect(firstRow).not.toBe('');
    const firstScenario = parseScenarioMap(firstRow)[0];
    if (firstScenario === undefined) throw new Error('first row did not parse');

    expect(checkScenarioMap({ roadmap, map: map.replace(firstRow, ''), readSource })).toContain(
      `scenario not mapped: '${firstScenario.scenario}'`,
    );
    const renamed = map.replace(firstRow, firstRow.replace(firstScenario.test, `${firstScenario.test} (renamed)`));
    expect(checkScenarioMap({ roadmap, map: renamed, readSource }).join('\n')).toMatch(/test not found/);
    const oneVersion = map.replace(firstRow, firstRow.replace(/22\.04,\s*24\.04/, '24.04'));
    expect(checkScenarioMap({ roadmap, map: oneVersion, readSource })).toContain(
      `scenario '${firstScenario.scenario}' lacks Ubuntu 22.04`,
    );
    const skipped = (file: string): string | undefined =>
      file === firstScenario.file ? readSource(file)?.replace(`it('${firstScenario.test}'`, `it.skip('${firstScenario.test}'`) : readSource(file);
    expect(checkScenarioMap({ roadmap, map, readSource: skipped }).join('\n')).toMatch(/test is skipped/);
  });
});

describe('docs/releases/v0.3-scenarios.md (A1)', { timeout: SOURCE_SUITE_TIMEOUT_MS }, () => {
  it('maps each of the twelve roadmap §8.8 scenarios, in order, to one named test per Ubuntu version', () => {
    const scenarios = readRoadmapScenarios(read(ROADMAP_PATH));
    expect(scenarios).toHaveLength(12);
    const rows = parseScenarioMap(read(MAP_PATH));
    expect(rows.map((row) => row.scenario)).toEqual(scenarios);
    expect(checkScenarioMap({ roadmap: read(ROADMAP_PATH), map: read(MAP_PATH), readSource })).toEqual([]);
  });

  it('a full run (NOODARA_TEST_UBUNTU=all or unset) selects both Ubuntu versions', () => {
    const selected = process.env['NOODARA_TEST_UBUNTU'];
    const expected = selected === undefined || selected === '' || selected === 'all' ? [...UBUNTU_VERSIONS] : [selected];
    expect(DEPLOY_ENGINE_UBUNTU_VERSIONS).toEqual(expected);
  });
});

// 25-01 A1: the v0.4 matrix (QA-15 integration scenarios, roadmap §9.8 unit areas, §9.10 E2E flows).
const V04_MAP_PATH = 'docs/releases/v0.4-scenarios.md';

describe('docs/releases/v0.4-scenarios.md (25-01 A1)', { timeout: SOURCE_SUITE_TIMEOUT_MS }, () => {
  const roadmap = read(ROADMAP_PATH);
  const map = read(V04_MAP_PATH);
  const rowOf = (section: string, index: number): string => {
    const line = sectionOf(map, section)
      .split('\n')
      .find((candidate) => new RegExp(`^\\|\\s*${String(index)}\\s*\\|`).test(candidate));
    if (line === undefined) throw new Error(`row ${String(index)} missing in ${section}`);
    return line;
  };

  it('maps every QA-15 scenario, every §9.8 unit area and every §9.10 flow to a named, running test', () => {
    expect(readRoadmapSectionLines(roadmap, '9.8')).toHaveLength(10);
    expect(parseMappedRows(sectionOf(map, V04_SECTIONS.integration), 4).map((row) => row.scenario)).toEqual([...V04_INTEGRATION_SCENARIOS]);
    expect(parseMappedRows(sectionOf(map, V04_SECTIONS.unit), 3).map((row) => row.scenario)).toEqual(readRoadmapSectionLines(roadmap, '9.8'));
    expect(parseMappedRows(sectionOf(map, V04_SECTIONS.e2e), 3).map((row) => row.scenario)).toEqual([...V04_E2E_FLOWS]);
    expect(checkV04ScenarioMap({ roadmap, map, readSource })).toEqual([]);
  });

  it('fails on a missing, renamed or single-Ubuntu integration mapping', () => {
    const row = rowOf(V04_SECTIONS.integration, 1);
    const parsed = parseMappedRows(row, 4)[0];
    if (parsed === undefined) throw new Error('row did not parse');
    expect(checkV04ScenarioMap({ roadmap, map: map.replace(row, ''), readSource })).toContain(`scenario not mapped: '${parsed.scenario}'`);
    expect(checkV04ScenarioMap({ roadmap, map: map.replace(row, row.replace(parsed.test, `${parsed.test} (renamed)`)), readSource }).join('\n')).toMatch(
      /test not found/,
    );
    expect(checkV04ScenarioMap({ roadmap, map: map.replace(row, row.replace(/22\.04,\s*24\.04/, '24.04')), readSource })).toContain(
      `scenario '${parsed.scenario}' lacks Ubuntu 22.04`,
    );
  });

  it('fails when a mapped test is skipped, runs on one Ubuntu version or skips the remote-state check', () => {
    const parsed = parseMappedRows(rowOf(V04_SECTIONS.integration, 1), 4)[0];
    if (parsed === undefined) throw new Error('row did not parse');
    const patched =
      (edit: (source: string) => string) =>
      (file: string): string | undefined =>
        file === parsed.file ? edit(readSource(file) ?? '') : readSource(file);
    const title = JSON.stringify(parsed.test).slice(1, -1);
    const skipped = patched((source) => source.replace(/(\n\s*)it\((\s*)(["'])/g, '$1it.skip($2$3'));
    expect(checkV04ScenarioMap({ roadmap, map, readSource: skipped }).join('\n')).toMatch(/test is skipped/);
    const single = patched((source) => source.replaceAll('describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)', "describe.each(['24.04'])"));
    expect(checkV04ScenarioMap({ roadmap, map, readSource: single }).join('\n')).toMatch(/does not run per Ubuntu version/);
    const unchecked = patched((source) => source.replaceAll(`${REMOTE_STATE_ASSERTION}(`, 'void ('));
    expect(checkV04ScenarioMap({ roadmap, map, readSource: unchecked }).join('\n')).toContain(
      `scenario '${parsed.scenario}': test does not assert the remote state against the database (${REMOTE_STATE_ASSERTION}): '${title}'`,
    );
  });

  it('fails when a §9.8 area maps to a skipped or integration test, or a §9.10 flow to a skipped spec', () => {
    const unitRow = rowOf(V04_SECTIONS.unit, 1);
    const unit = parseMappedRows(unitRow, 3)[0];
    if (unit === undefined) throw new Error('unit row did not parse');
    const skippedUnit = (file: string): string | undefined =>
      file === unit.file ? readSource(file)?.replace(`it('${unit.test}'`, `it.skip('${unit.test}'`) : readSource(file);
    expect(checkV04ScenarioMap({ roadmap, map, readSource: skippedUnit }).join('\n')).toMatch(/test is skipped/);
    const asIntegration = map.replace(unitRow, unitRow.replace(unit.file, 'tests/integration/env/env-api.test.ts'));
    expect(checkV04ScenarioMap({ roadmap, map: asIntegration, readSource }).join('\n')).toMatch(/must be a unit test/);

    const e2e = parseMappedRows(rowOf(V04_SECTIONS.e2e, 1), 3)[0];
    if (e2e === undefined) throw new Error('e2e row did not parse');
    const skippedSpec = (file: string): string | undefined =>
      file === e2e.file ? readSource(file)?.replace(`test('${e2e.test}'`, `test.fixme('${e2e.test}'`) : readSource(file);
    expect(checkV04ScenarioMap({ roadmap, map, readSource: skippedSpec }).join('\n')).toMatch(/test is skipped/);
  });

  it('accepts Playwright tests inside test.describe and rejects test.describe.skip', () => {
    const spec = (suite: string) => `${suite}('flow', () => {\n  test.use({});\n  test('${TITLE}', async () => {});\n});\n`;
    expect(checkMappedTest(spec('test.describe'), 'a.spec.ts', TITLE, { perUbuntu: false })).toEqual([]);
    expect(checkMappedTest(spec('test.describe.skip'), 'a.spec.ts', TITLE, { perUbuntu: false }).join('\n')).toMatch(/enclosing suite is skipped/);
  });
});

describe('remote proxy state against the database (25-01 A2)', () => {
  const SVC = '11111111-1111-4111-8111-111111111111';
  const GONE = '22222222-2222-4222-8222-222222222222';
  const route = (hosts: readonly { hostname: string; redirect?: boolean }[]): string =>
    JSON.stringify({
      http: {
        routers: Object.fromEntries(
          hosts.flatMap((host, i) => [
            [`r${String(i)}-web`, { entryPoints: ['web'], rule: `Host(\`${host.hostname}\`)`, service: 's', ...(host.redirect === true ? { middlewares: ['m'] } : {}) }],
            [`r${String(i)}-websecure`, { entryPoints: ['websecure'], rule: `Host(\`${host.hostname}\`)`, service: 's', tls: {} }],
          ]),
        ),
      },
    });
  const remote = (over: Partial<RemoteProxyState> = {}): RemoteProxyState => ({
    proxy: 'running',
    dynamicEntries: ['noodara-api.yml', `${SVC}.yml`, `${SVC}.yml.prev`],
    routes: new Map([[SVC, parseRouteHosts(route([{ hostname: 'a.test' }]))]]),
    containers: ['noodara-traefik', `noodara-${SVC}`],
    networks: new Map([[`noodara-net-${SVC}`, ['noodara-traefik', `noodara-${SVC}`]]]),
    ...over,
  });
  const database = (over: Partial<DatabaseProxyState> = {}): DatabaseProxyState => ({
    proxyStatus: 'RUNNING',
    services: new Map([[SVC, [{ hostname: 'a.test', httpsRedirect: false, applyStatus: 'APPLIED' }]]]),
    ...over,
  });

  it('parses the web routers of a rendered dynamic file, and null when it is not one', () => {
    expect(parseRouteHosts(route([{ hostname: 'b.test', redirect: true }, { hostname: 'a.test' }]))).toEqual([
      { hostname: 'a.test', httpsRedirect: false },
      { hostname: 'b.test', httpsRedirect: true },
    ]);
    expect(parseRouteHosts('not json')).toBeNull();
    expect(parseRouteHosts('{"http":{}}')).toEqual([]);
  });

  it('accepts a remote state that matches the database', () => {
    expect(compareProxyState(remote(), database())).toEqual([]);
    const pending = new Map([[SVC, [{ hostname: 'a.test', httpsRedirect: false, applyStatus: 'APPLIED' }, { hostname: 'p.test', httpsRedirect: true, applyStatus: 'PENDING' }]]]);
    expect(compareProxyState(remote(), database({ services: pending }))).toEqual([]);
    expect(compareProxyState(remote({ proxy: 'absent', dynamicEntries: [], routes: new Map(), containers: [], networks: new Map() }), database({ proxyStatus: 'NOT_INSTALLED', services: new Map() }))).toEqual([]);
  });

  it('reports the proxy container against the proxy status', () => {
    expect(compareProxyState(remote({ proxy: 'stopped' }), database())).toEqual(['proxy status RUNNING but noodara-traefik is stopped']);
    expect(compareProxyState(remote({ dynamicEntries: [], routes: new Map(), networks: new Map() }), database({ proxyStatus: 'NOT_INSTALLED', services: new Map([[SVC, []]]) }))).toEqual([
      'proxy status NOT_INSTALLED but noodara-traefik is running',
    ]);
  });

  it('reports missing, stale and mismatched routes', () => {
    const missing = remote({ dynamicEntries: [], routes: new Map() });
    expect(compareProxyState(missing, database())).toContain(`service ${SVC}: APPLIED domain a.test has no route on the server`);
    const stale = remote({ routes: new Map([[SVC, parseRouteHosts(route([{ hostname: 'a.test' }, { hostname: 'old.test' }]))]]) });
    expect(compareProxyState(stale, database())).toEqual([`service ${SVC}: route for old.test has no domain row`]);
    const redirect = remote({ routes: new Map([[SVC, parseRouteHosts(route([{ hostname: 'a.test', redirect: true }]))]]) });
    expect(compareProxyState(redirect, database())).toEqual([`service ${SVC}: a.test httpsRedirect is true on the server, false in the database`]);
    expect(compareProxyState(remote({ routes: new Map([[SVC, null]]) }), database())).toContain(`service ${SVC}: the dynamic file is not a rendered route file`);
  });

  it('reports orphan files, temp files, containers and networks of deleted services', () => {
    const orphan = remote({
      dynamicEntries: ['noodara-api.yml', `${SVC}.yml`, `${GONE}.yml`, `${GONE}.yml.prev`, '.noodara-AbC123'],
      routes: new Map([[SVC, parseRouteHosts(route([{ hostname: 'a.test' }]))], [GONE, parseRouteHosts(route([{ hostname: 'g.test' }]))]]),
      containers: ['noodara-traefik', `noodara-${SVC}`, `noodara-${GONE}`, `noodara-${GONE}-prev`],
      networks: new Map([[`noodara-net-${SVC}`, ['noodara-traefik']], [`noodara-net-${GONE}`, []]]),
    });
    expect(compareProxyState(orphan, database()).sort()).toEqual(
      [
        `dynamic/${GONE}.yml belongs to no service with domains`,
        `dynamic/${GONE}.yml.prev belongs to no service with domains`,
        'dynamic/.noodara-AbC123 is a leftover temp file',
        `container noodara-${GONE} belongs to no service`,
        `container noodara-${GONE}-prev belongs to no service`,
        `network noodara-net-${GONE} belongs to no service`,
        `service ${GONE}: route for g.test has no domain row`,
      ].sort(),
    );
  });

  it('reports the proxy membership of a service network against its domains', () => {
    const detached = remote({ networks: new Map([[`noodara-net-${SVC}`, [`noodara-${SVC}`]]]) });
    expect(compareProxyState(detached, database())).toEqual([`service ${SVC}: noodara-traefik is not attached to noodara-net-${SVC} although it has APPLIED domains`]);
    const noDomains = remote({ dynamicEntries: ['noodara-api.yml'], routes: new Map() });
    expect(compareProxyState(noDomains, database({ services: new Map([[SVC, []]]) }))).toEqual([
      `service ${SVC}: noodara-traefik is still attached to noodara-net-${SVC} without domains`,
    ]);
  });
});

describe('docs/releases/v0.5-scenarios.md (31-01 A1)', { timeout: SOURCE_SUITE_TIMEOUT_MS }, () => {
  const roadmap = read(ROADMAP_PATH);
  const map = read('docs/releases/v0.5-scenarios.md');
  const check = (overrides: { map?: string; readSource?: (file: string) => string | undefined; diagnoses?: readonly string[] } = {}) =>
    checkV05ScenarioMap({ roadmap, map, readSource, diagnoses: DIAGNOSES, ...overrides });
  const rowOf = (table: V05Table, index: number): string => {
    const line = sectionOf(map, V05_SECTIONS[table])
      .split('\n')
      .find((candidate) => new RegExp(`^\\|\\s*${String(index)}\\s*\\|`).test(candidate));
    if (line === undefined) throw new Error(`row ${String(index)} missing in ${table}`);
    return line;
  };
  const parsedRow = (table: V05Table, index: number) => {
    const parsed = parseMappedRows(rowOf(table, index), 4)[0];
    if (parsed === undefined) throw new Error('row did not parse');
    return parsed;
  };

  it('reads the §10.1 checklist, the §10.2 sources and functions, the §10.3 nodes and relations and the diagnoses', () => {
    const expected = v05Expected(roadmap, DIAGNOSES);
    expect(expected.metrics).toEqual([
      'CPU',
      'RAM',
      'Disk',
      'Uptime',
      'Connection state',
      'Container state',
      'Restart count',
      'Healthcheck status',
      'Last deployment',
      'Runtime status',
    ]);
    expect(expected.logs).toEqual([
      'build logs',
      'deployment logs',
      'runtime/container logs',
      'agent activity',
      'stream',
      'filter',
      'basic search',
      'timestamps',
      'source identification',
    ]);
    // A graph node kind or relation type beyond the roadmap minimum must get its own row first.
    expect(expected.graph).toEqual([...GRAPH_NODE_KINDS, ...GRAPH_RELATION_TYPES]);
    expect(expected.diagnosis).toEqual(DIAGNOSES.filter((diagnosis) => diagnosis !== 'unknown'));
    expect(readRoadmapSectionLines(roadmap, '10.8')).toHaveLength(expected.diagnosis.length);
    expect(readRoadmapChecklist('\n## 1.0 x\n- [ ] One.\n- [x] two;\n- plain\n', '1.0')).toEqual(['One', 'two']);
    expect(readRoadmapSectionBlocks('\n## 1.0 x\n```text\na\n```\n```text\n b \n```\n## 2.0 y\n```text\nc\n```', '1.0')).toEqual([['a'], ['b']]);
  });

  it('maps every §10.1-§10.3 item and every supported diagnosis to a named test that runs on both Ubuntu versions', () => {
    for (const table of Object.keys(V05_SECTIONS) as V05Table[]) {
      expect(parseMappedRows(sectionOf(map, V05_SECTIONS[table]), 4).map((row) => row.scenario)).toEqual([
        ...v05Expected(roadmap, DIAGNOSES)[table],
      ]);
    }
    expect(check()).toEqual([]);
  });

  it.each(Object.keys(V05_SECTIONS) as V05Table[])('fails on a missing, renamed or single-Ubuntu row (%s)', (table) => {
    const row = rowOf(table, 1);
    const parsed = parsedRow(table, 1);
    expect(check({ map: map.replace(row, '') }).join('\n')).toContain(`not mapped: '${parsed.scenario}'`);
    expect(check({ map: map.replace(row, row.replace(parsed.test, `${parsed.test} (renamed)`)) }).join('\n')).toMatch(/test not found/);
    expect(check({ map: map.replace(row, row.replace(/22\.04,\s*24\.04/, '24.04')) }).join('\n')).toContain(
      `'${parsed.scenario}' lacks Ubuntu 22.04`,
    );
    expect(check({ map: map.replace(row, row.replace(parsed.file, 'tests/unit/deploy-engine/scenario-map.test.ts')) }).join('\n')).toMatch(
      /maps outside tests\/integration\//,
    );
  });

  it('fails when a mapped test is skipped or its suite runs on one Ubuntu version', () => {
    const parsed = parsedRow('diagnosis', 1);
    const patched =
      (edit: (source: string) => string) =>
      (file: string): string | undefined =>
        file === parsed.file ? edit(readSource(file) ?? '') : readSource(file);
    const title = JSON.stringify(parsed.test).slice(1, -1);
    const skipped = patched((source) => source.replace(`'${title}'`, `'${title}', () => undefined);\n  it.skip('${title}'`));
    expect(check({ readSource: skipped }).join('\n')).toMatch(/ambiguous|test is skipped/);
    const fixme = patched((source) => source.replace(/(\n\s*)it\((\s*)(["'])/g, '$1it.skip($2$3'));
    expect(check({ readSource: fixme }).join('\n')).toContain(`diagnosis '${parsed.scenario}': test is skipped (it.skip): '${title}'`);
    const single = patched((source) => source.replaceAll('describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)', "describe.each(['24.04'])"));
    expect(check({ readSource: single }).join('\n')).toMatch(/does not run per Ubuntu version/);
    const missingFile = (file: string): string | undefined => (file === parsed.file ? undefined : readSource(file));
    expect(check({ readSource: missingFile }).join('\n')).toContain(`maps to a missing file: ${parsed.file}`);
  });

  it('fails when the diagnosis vocabulary grows without a row, or a row names no supported diagnosis', () => {
    const grown = check({ diagnoses: [...DIAGNOSES, 'disk_full'] });
    expect(grown).toContain("diagnosis not mapped: 'disk_full'");
    expect(grown.join('\n')).toMatch(/roadmap §10\.8 lists 9 diagnosis cases, the vocabulary 10/);
    const shrunk = check({ diagnoses: DIAGNOSES.filter((diagnosis) => diagnosis !== 'high_disk') });
    expect(shrunk.join('\n')).toMatch(/under \(§10\.8\) is not expected: 'high_disk'/);
    expect(check({ map: map.replace(/## Diagnósticos[\s\S]*$/, '') })).toContain('no table headed (§10.8)');
  });
});
