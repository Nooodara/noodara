// 20-01 A1/H1: the roadmap §8.8 integration matrix stays proven. A pure unit test (no containers):
// it reads docs/releases/v0.3-scenarios.md, the roadmap and the mapped test sources. It lives here,
// not in tests/unit/, because it guards this directory and runs in its gate.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS } from '../helpers/deploy-engine.js';
import { checkMappedTest, checkScenarioMap, parseScenarioMap, readRoadmapScenarios, UBUNTU_VERSIONS } from './scenario-map.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAP_PATH = 'docs/releases/v0.3-scenarios.md';
const ROADMAP_PATH = 'docs/roadmap-v0.1-v0.5.md';
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const readSource = (file: string): string | undefined =>
  existsSync(path.join(REPO_ROOT, file)) ? readFileSync(path.join(REPO_ROOT, file), 'utf8') : undefined;

const IMPORT = "import { DEPLOY_ENGINE_UBUNTU_VERSIONS } from '../helpers/deploy-engine.js';\n";
const perVersion = (inner: string, table = 'DEPLOY_ENGINE_UBUNTU_VERSIONS', suite = 'describe.each'): string =>
  `${IMPORT}${suite}(${table})('suite %s', (ubuntu) => {\n${inner}\n});\n`;
const TITLE = 'deploys';

describe('scenario map checker (H1)', () => {
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

describe('docs/releases/v0.3-scenarios.md (A1)', () => {
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
