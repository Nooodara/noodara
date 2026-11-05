// 29-01 (A1-A3): reads the versioned dataset from disk. scenarios/dataset.yaml is the manifest
// (name, version, changelog); scenarios/*.yaml hold `scenarios:` lists; fixtures/<id>.yaml hold one
// fixture each. loadScenarioContext turns a scenario's fixture into the in-memory repository
// behind the real tool registry, with the conversation redactor seeded with the canaries.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolRegistry, type AuthorizationScope, type ReadToolBackend, type ToolRegistry } from '@noodara/ai';
import { createRedactor, type Evidence, type Redactor } from '@noodara/domain';
import { createFixtureBackend } from './fixture-backend.js';
import { buildFixtureModel, deriveEvidence, type FixtureModel } from './fixture-model.js';
import {
  DatasetManifestSchema,
  FixtureSchema,
  ScenarioFileSchema,
  ScenarioSchema,
  type DatasetManifest,
  type Fixture,
  type Scenario,
} from './schema.js';
import { parseYaml } from './yaml.js';

export const EVALS_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SCENARIOS_DIR = join(EVALS_ROOT, 'scenarios');
export const FIXTURES_DIR = join(EVALS_ROOT, 'fixtures');
export const MANIFEST_FILE = 'dataset.yaml';

export interface Dataset {
  readonly manifest: DatasetManifest;
  readonly scenarios: readonly (Scenario & { readonly file: string })[];
  readonly fixtures: ReadonlyMap<string, Fixture>;
}

export function yamlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => join(dir, name));
}

function parseFile(file: string): unknown {
  try {
    return parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${basename(file)}: ${(error as Error).message}`, { cause: error });
  }
}

function strict<T>(file: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('; ');
  throw new Error(`${basename(file)}: ${issues}`);
}

export function loadFixtureFile(file: string): Fixture {
  const fixture = strict(file, FixtureSchema, parseFile(file));
  if (`${fixture.id}.yaml` !== basename(file)) throw new Error(`${basename(file)}: fixture id ${fixture.id} must match the file name`);
  return fixture;
}

export function loadDataset(): Dataset {
  const manifest = strict(MANIFEST_FILE, DatasetManifestSchema, parseFile(join(SCENARIOS_DIR, MANIFEST_FILE)));
  const fixtures = new Map(yamlFiles(FIXTURES_DIR).map((file) => {
    const fixture = loadFixtureFile(file);
    return [fixture.id, fixture] as const;
  }));
  const scenarios = yamlFiles(SCENARIOS_DIR)
    .filter((file) => basename(file) !== MANIFEST_FILE)
    .flatMap((file) =>
      strict(file, ScenarioFileSchema, parseFile(file)).scenarios.map((raw) => ({ ...strict(file, ScenarioSchema, raw), file: basename(file) })),
    );
  return { manifest, scenarios, fixtures };
}

export interface ScenarioContext {
  readonly model: FixtureModel;
  readonly backend: ReadToolBackend;
  readonly registry: ToolRegistry;
  readonly scope: AuthorizationScope;
  readonly evidence: readonly Evidence[];
  /** Seeded with every canary of the fixture, as the conversation redactor is with secret values. */
  readonly redactor: Redactor;
  readonly nowMs: number;
}

export function loadScenarioContext(scenario: Scenario, fixtures: ReadonlyMap<string, Fixture>): ScenarioContext {
  const fixture = fixtures.get(scenario.fixture);
  if (fixture === undefined) throw new Error(`scenario ${scenario.id}: unknown fixture ${scenario.fixture}`);
  const model = buildFixtureModel(fixture);
  const redactor = createRedactor();
  for (const secret of model.secrets) redactor.register(secret.value, 'secret');
  const backend = createFixtureBackend(model, { redactor });
  const scope: AuthorizationScope =
    scenario.scope === 'global' ? { kind: 'global' } : { kind: 'project', projectId: model.entity(`project:${scenario.scope.project}`).id };
  return {
    model,
    backend,
    registry: createToolRegistry(backend),
    scope,
    evidence: deriveEvidence(model, scenario.evidence),
    redactor,
    nowMs: model.nowMs,
  };
}
