// 20-01: checks docs/releases/v0.3-scenarios.md against the roadmap §8.8 list and the test sources.
// Every scenario maps to one named test that exists, is not skipped and runs once per Ubuntu
// version (inside `describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)`). Pure: sources are passed in.
// 25-01: also docs/releases/v0.4-scenarios.md (QA-15 integration, roadmap §9.8 unit, §9.10 E2E).
// 31-01: also docs/releases/v0.5-scenarios.md (roadmap §10.1-§10.3 and the §10.8 diagnoses).
import ts from 'typescript';

export const UBUNTU_VERSIONS = ['22.04', '24.04'] as const;
const VERSIONS_IDENTIFIER = 'DEPLOY_ENGINE_UBUNTU_VERSIONS';
const VERSIONS_MODULE = '../helpers/deploy-engine.js';
const SKIPPING_MODIFIERS = new Set(['skip', 'todo', 'skipIf', 'runIf', 'only', 'fails', 'fixme']);
const SELF_SKIPS = new Set(['skip', 'fixme']);
const TEST_BASES = new Set(['it', 'test']);
const SUITE_BASES = new Set(['describe', 'suite']);
/** Playwright members of `test` that are not test declarations. */
const NON_TEST_MODIFIERS = new Set(['describe', 'step', 'use', 'extend', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'info']);
/** The proxy suites call this to compare the server with the database after each scenario. */
export const REMOTE_STATE_ASSERTION = 'expectRemoteMatchesDatabase';
const PROXY_SUITES_DIR = 'tests/integration/proxy/';

export interface ScenarioMapRow {
  readonly index: number;
  readonly scenario: string;
  readonly file: string;
  readonly test: string;
  readonly ubuntu: readonly string[];
}

/** The body under `## <section> ` in the roadmap, up to the next `## ` heading; '' when absent. */
function roadmapSectionBody(roadmap: string, section: string): string {
  const heading = new RegExp(`\\n## ${section.replaceAll('.', '\\.')} [^\\n]*\\n([\\s\\S]*?)(?:\\n## |$)`);
  return heading.exec(roadmap)?.[1] ?? '';
}

const nonEmptyLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** The lines of the first ```text block under `## <section> ` in the roadmap. */
export function readRoadmapSectionLines(roadmap: string, section: string): string[] {
  return readRoadmapSectionBlocks(roadmap, section)[0] ?? [];
}

/** Every ```text block under `## <section> ` in the roadmap, as trimmed non-empty lines. */
export function readRoadmapSectionBlocks(roadmap: string, section: string): string[][] {
  return [...roadmapSectionBody(roadmap, section).matchAll(/```text\n([\s\S]*?)```/g)].map((match) => nonEmptyLines(match[1] ?? ''));
}

/** The `- [ ] Item.` checklist entries under `## <section> `, without the trailing `.` or `;`. */
export function readRoadmapChecklist(roadmap: string, section: string): string[] {
  return nonEmptyLines(roadmapSectionBody(roadmap, section)).flatMap((line) => {
    const item = /^- \[[ xX]\] (.+?)[.;]?$/.exec(line)?.[1];
    return item === undefined ? [] : [item.trim()];
  });
}

/** The scenario lines of the first code block under `## 8.8` in the roadmap. */
export function readRoadmapScenarios(roadmap: string): string[] {
  return readRoadmapSectionLines(roadmap, '8.8');
}

/** From the heading line containing `key` to the next heading of the same or a higher level; '' when absent. */
export function sectionOf(markdown: string, key: string): string {
  const lines = markdown.split('\n');
  const level = (line: string): number => /^(#+)\s/.exec(line)?.[1]?.length ?? 0;
  const start = lines.findIndex((line) => level(line) > 0 && line.includes(key));
  if (start < 0) return '';
  const depth = level(lines[start] ?? '');
  const end = lines.findIndex((line, i) => i > start && level(line) > 0 && level(line) <= depth);
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

const unquote = (cell: string): string => cell.trim().replace(/^`([\s\S]*)`$/, '$1');

/**
 * Rows of a `| # | Scenario | Test file | Test name | Ubuntu |` table (`cells` 4) or of a
 * `| # | Area | Test file | Test name |` table (`cells` 3, no Ubuntu column).
 */
export function parseMappedRows(markdown: string, cells: 3 | 4): ScenarioMapRow[] {
  const rows: ScenarioMapRow[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*(\d+)\s*\|(.*)\|\s*$/.exec(line.trim());
    if (!match) continue;
    const parts = (match[2] ?? '').split('|');
    if (parts.length !== cells) continue;
    const [scenario = '', file = '', test = '', ubuntu = ''] = parts.map(unquote);
    rows.push({
      index: Number(match[1]),
      scenario,
      file,
      test,
      ubuntu: ubuntu.split(',').map((version) => version.trim()).filter((version) => version.length > 0),
    });
  }
  return rows;
}

/** Rows of the `| # | Scenario | Test file | Test name | Ubuntu |` table. */
export function parseScenarioMap(markdown: string): ScenarioMapRow[] {
  return parseMappedRows(markdown, 4);
}

interface CallShape {
  readonly base: string;
  readonly modifiers: readonly string[];
  /** The `each(...)` / `skipIf(...)` argument lists, keyed by modifier. */
  readonly modifierArgs: ReadonlyMap<string, ts.NodeArray<ts.Expression>>;
}

/** `it`, `it.skip`, `it.each(t)`, `describe.skipIf(c)`, `it.skip.each(t)` ... as base + modifiers. */
function callShape(call: ts.CallExpression): CallShape | undefined {
  const modifiers: string[] = [];
  const modifierArgs = new Map<string, ts.NodeArray<ts.Expression>>();
  let callee: ts.Expression = call.expression;
  let pendingArgs: ts.NodeArray<ts.Expression> | undefined;
  for (;;) {
    if (ts.isCallExpression(callee)) {
      pendingArgs = callee.arguments;
      callee = callee.expression;
    } else if (ts.isPropertyAccessExpression(callee)) {
      modifiers.unshift(callee.name.text);
      if (pendingArgs !== undefined) modifierArgs.set(callee.name.text, pendingArgs);
      pendingArgs = undefined;
      callee = callee.expression;
    } else if (ts.isIdentifier(callee)) {
      return { base: callee.text, modifiers, modifierArgs };
    } else {
      return undefined;
    }
  }
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function callbackOf(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  return call.arguments.find((arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
}

function forEachDescendant(node: ts.Node, visit: (child: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    visit(child);
    forEachDescendant(child, visit);
  });
}

function mentions(node: ts.Node, identifier: string): boolean {
  let found = ts.isIdentifier(node) && node.text === identifier;
  forEachDescendant(node, (child) => {
    if (ts.isIdentifier(child) && child.text === identifier) found = true;
  });
  return found;
}

function returns(node: ts.Node): boolean {
  let found = ts.isReturnStatement(node);
  forEachDescendant(node, (child) => {
    if (ts.isReturnStatement(child)) found = true;
  });
  return found;
}

function importsVersions(source: ts.SourceFile): boolean {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      literalText(statement.moduleSpecifier) === VERSIONS_MODULE &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some((element) => element.name.text === VERSIONS_IDENTIFIER),
  );
}

const isSuite = (shape: CallShape): boolean => SUITE_BASES.has(shape.base) || shape.modifiers.includes('describe');
const isTestDeclaration = (shape: CallShape): boolean =>
  TEST_BASES.has(shape.base) && !shape.modifiers.some((modifier) => NON_TEST_MODIFIERS.has(modifier));

/** A `test.skip()` / `test.fixme(cond)` statement that skips every test of its scope (Playwright). */
function scopeSkip(statements: readonly ts.Statement[], file: ts.SourceFile): string | undefined {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    const shape = callShape(call);
    if (shape === undefined || !TEST_BASES.has(shape.base) || shape.modifiers.length !== 1) continue;
    if (!SELF_SKIPS.has(shape.modifiers[0] ?? '')) continue;
    const declaresTest = literalText(call.arguments[0]) !== undefined && callbackOf(call) !== undefined;
    if (!declaresTest) return call.getText(file);
  }
  return undefined;
}

function blockStatements(fn: ts.ArrowFunction | ts.FunctionExpression | undefined): readonly ts.Statement[] {
  return fn !== undefined && ts.isBlock(fn.body) ? fn.body.statements : [];
}

function callsIdentifier(node: ts.Node, identifier: string): boolean {
  let found = false;
  forEachDescendant(node, (child) => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === identifier) found = true;
  });
  return found;
}

export interface MappedTestOptions {
  /** The test must run once per Ubuntu version (default true). */
  readonly perUbuntu?: boolean;
  /** The test body must call {@link REMOTE_STATE_ASSERTION} (default false). */
  readonly remoteState?: boolean;
}

/** Problems that keep `title` in `source` from proving its scenario (on both Ubuntu versions unless `perUbuntu` is false). */
export function checkMappedTest(source: string, fileName: string, title: string, options: MappedTestOptions = {}): string[] {
  const perUbuntu = options.perUbuntu ?? true;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches: ts.CallExpression[] = [];
  forEachDescendant(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const shape = callShape(node);
    if (shape !== undefined && isTestDeclaration(shape) && literalText(node.arguments[0]) === title) matches.push(node);
  });
  if (matches.length === 0) return [`test not found: '${title}'`];
  if (matches.length > 1) return [`test name is ambiguous (${String(matches.length)} matches): '${title}'`];
  const [call] = matches as [ts.CallExpression];
  const problems: string[] = [];

  const skipped = (callShape(call)?.modifiers ?? []).filter((modifier) => SKIPPING_MODIFIERS.has(modifier));
  if (skipped.length > 0) problems.push(`test is skipped (${callShape(call)?.base ?? 'it'}.${skipped.join('.')}): '${title}'`);

  const fileSkip = scopeSkip(file.statements, file);
  if (fileSkip !== undefined) problems.push(`the file skips its tests (${fileSkip}): '${title}'`);

  let versionParam: string | undefined;
  for (let node: ts.Node | undefined = call.parent; node !== undefined; node = node.parent) {
    if (!ts.isCallExpression(node)) continue;
    const shape = callShape(node);
    if (shape === undefined || !isSuite(shape)) continue;
    const suiteSkips = shape.modifiers.filter((modifier) => SKIPPING_MODIFIERS.has(modifier));
    if (suiteSkips.length > 0) problems.push(`enclosing suite is skipped (describe.${suiteSkips.join('.')}): '${title}'`);
    const suiteSkip = scopeSkip(blockStatements(callbackOf(node)), file);
    if (suiteSkip !== undefined) problems.push(`enclosing suite skips its tests (${suiteSkip}): '${title}'`);
    const table = shape.modifierArgs.get('each')?.[0];
    if (table !== undefined && ts.isIdentifier(table) && table.text === VERSIONS_IDENTIFIER) {
      const param = callbackOf(node)?.parameters[0]?.name;
      versionParam = param !== undefined && ts.isIdentifier(param) ? param.text : '';
    }
  }
  if (perUbuntu) {
    if (versionParam === undefined) {
      problems.push(`test does not run per Ubuntu version (not inside describe.each(${VERSIONS_IDENTIFIER})): '${title}'`);
    } else if (!importsVersions(file)) {
      problems.push(`${VERSIONS_IDENTIFIER} is not imported from ${VERSIONS_MODULE} in ${fileName}`);
    }
  }

  const body = callbackOf(call);
  if (body === undefined) {
    problems.push(`test has no body: '${title}'`);
    return problems;
  }
  forEachDescendant(body, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && SELF_SKIPS.has(node.expression.name.text)) {
      problems.push(`test body skips itself (${node.expression.getText(file)}()): '${title}'`);
    }
    if (versionParam !== undefined && versionParam !== '' && ts.isIfStatement(node) && mentions(node.expression, versionParam) && returns(node.thenStatement)) {
      problems.push(`test returns early on an Ubuntu version (${node.expression.getText(file)}): '${title}'`);
    }
  });
  if (options.remoteState === true && !callsIdentifier(body, REMOTE_STATE_ASSERTION)) {
    problems.push(`test does not assert the remote state against the database (${REMOTE_STATE_ASSERTION}): '${title}'`);
  }
  return problems;
}

export interface ScenarioMapInput {
  readonly roadmap: string;
  readonly map: string;
  /** Repo-relative path -> source text, or undefined when the file does not exist. */
  readonly readSource: (file: string) => string | undefined;
}

/** Every reason the scenario map does not prove the roadmap §8.8 list; empty when it does. */
export function checkScenarioMap(input: ScenarioMapInput): string[] {
  const scenarios = readRoadmapScenarios(input.roadmap);
  const rows = parseScenarioMap(input.map);
  const problems: string[] = [];
  if (scenarios.length === 0) problems.push('roadmap §8.8 lists no scenarios');
  scenarios.forEach((scenario, i) => {
    const row = rows.find((candidate) => candidate.scenario === scenario);
    if (row === undefined) {
      problems.push(`scenario not mapped: '${scenario}'`);
      return;
    }
    if (row.index !== i + 1) problems.push(`scenario '${scenario}' is row ${String(row.index)}, expected ${String(i + 1)}`);
    const missing = UBUNTU_VERSIONS.filter((version) => !row.ubuntu.includes(version));
    if (missing.length > 0) problems.push(`scenario '${scenario}' lacks Ubuntu ${missing.join(', ')}`);
    if (!row.file.startsWith('tests/integration/')) problems.push(`scenario '${scenario}' maps outside tests/integration/: ${row.file}`);
    const source = input.readSource(row.file);
    if (source === undefined) {
      problems.push(`scenario '${scenario}' maps to a missing file: ${row.file}`);
      return;
    }
    for (const problem of checkMappedTest(source, row.file, row.test)) problems.push(`scenario '${scenario}': ${problem}`);
  });
  for (const row of rows) {
    if (!scenarios.includes(row.scenario)) problems.push(`row ${String(row.index)} is not a roadmap §8.8 scenario: '${row.scenario}'`);
  }
  return problems;
}

// 25-01: the v0.4 matrix. Three tables in docs/releases/v0.4-scenarios.md, found by their headings.
export const V04_SECTIONS = Object.freeze({ integration: '(QA-15)', unit: '(§9.8)', e2e: '(§9.10)' } as const);

/** QA-15: the integration scenarios of the v0.4 matrix, in table order. */
export const V04_INTEGRATION_SCENARIOS = Object.freeze([
  'proxy install',
  'port in use',
  'domain add with apply',
  'domain remove with apply',
  'apply revert on an invalid write',
  'certificate issuance',
  'DNS failure',
  'certificate renewal',
  'routing after replace',
  'routing after automatic rollback',
  'routing after manual rollback',
  'variable and secret injection',
  'unresolved secret reference',
  'service delete with domains',
] as const);

/** Roadmap §9.10: the two principal E2E flows. */
export const V04_E2E_FLOWS = Object.freeze([
  'Deploy API → add domain → validate DNS → issue certificate → route traffic → HTTPS /health returns 200',
  'Create secret → deploy service → service reads secret → UI/API/logs never expose plaintext',
] as const);

interface TableSpec {
  readonly label: string;
  readonly section: string;
  readonly cells: 3 | 4;
  readonly expected: readonly string[];
  /** A problem with the mapped file path, or undefined when it may hold this kind of test. */
  readonly fileProblem: (file: string) => string | undefined;
  readonly options: (file: string) => MappedTestOptions;
}

function checkTable(spec: TableSpec, map: string, readSource: (file: string) => string | undefined): string[] {
  const problems: string[] = [];
  const section = sectionOf(map, spec.section);
  if (section === '') return [`no table headed ${spec.section}`];
  const rows = parseMappedRows(section, spec.cells);
  spec.expected.forEach((name, i) => {
    const row = rows.find((candidate) => candidate.scenario === name);
    if (row === undefined) {
      problems.push(`${spec.label} not mapped: '${name}'`);
      return;
    }
    if (row.index !== i + 1) problems.push(`${spec.label} '${name}' is row ${String(row.index)}, expected ${String(i + 1)}`);
    if (spec.cells === 4) {
      const missing = UBUNTU_VERSIONS.filter((version) => !row.ubuntu.includes(version));
      if (missing.length > 0) problems.push(`${spec.label} '${name}' lacks Ubuntu ${missing.join(', ')}`);
    }
    const fileProblem = spec.fileProblem(row.file);
    if (fileProblem !== undefined) problems.push(`${spec.label} '${name}' ${fileProblem}: ${row.file}`);
    const source = readSource(row.file);
    if (source === undefined) {
      problems.push(`${spec.label} '${name}' maps to a missing file: ${row.file}`);
      return;
    }
    for (const problem of checkMappedTest(source, row.file, row.test, spec.options(row.file))) problems.push(`${spec.label} '${name}': ${problem}`);
  });
  for (const row of rows) {
    if (!spec.expected.includes(row.scenario)) problems.push(`row ${String(row.index)} under ${spec.section} is not expected: '${row.scenario}'`);
  }
  return problems;
}

/** Every reason docs/releases/v0.4-scenarios.md does not prove QA-15, §9.8 and §9.10; empty when it does. */
export function checkV04ScenarioMap(input: ScenarioMapInput): string[] {
  const areas = readRoadmapSectionLines(input.roadmap, '9.8');
  const problems: string[] = areas.length === 0 ? ['roadmap §9.8 lists no unit areas'] : [];
  const tables: TableSpec[] = [
    {
      label: 'scenario',
      section: V04_SECTIONS.integration,
      cells: 4,
      expected: V04_INTEGRATION_SCENARIOS,
      fileProblem: (file) => (file.startsWith('tests/integration/') && file.endsWith('.test.ts') ? undefined : 'maps outside tests/integration/'),
      options: (file) => ({ perUbuntu: true, remoteState: file.startsWith(PROXY_SUITES_DIR) }),
    },
    {
      label: 'area',
      section: V04_SECTIONS.unit,
      cells: 3,
      expected: areas,
      fileProblem: (file) =>
        /\.test\.tsx?$/.test(file) && !file.startsWith('tests/integration/') && !file.startsWith('tests/e2e/') ? undefined : 'must be a unit test',
      options: () => ({ perUbuntu: false }),
    },
    {
      label: 'flow',
      section: V04_SECTIONS.e2e,
      cells: 3,
      expected: V04_E2E_FLOWS,
      fileProblem: (file) => (file.startsWith('tests/e2e/') && file.endsWith('.spec.ts') ? undefined : 'must be a Playwright spec under tests/e2e/'),
      options: () => ({ perUbuntu: false }),
    },
  ];
  for (const spec of tables) problems.push(...checkTable(spec, input.map, input.readSource));
  return problems;
}

// 31-01: the v0.5 matrix. One table per roadmap section in docs/releases/v0.5-scenarios.md; every
// row is an integration test that runs once per Ubuntu version.
export const V05_SECTIONS = Object.freeze({
  metrics: '(§10.1)',
  logs: '(§10.2)',
  graph: '(§10.3)',
  diagnosis: '(§10.8)',
} as const);

export type V05Table = keyof typeof V05_SECTIONS;

/**
 * The rows each v0.5 table must hold, in order: the §10.1 checklist; the §10.2 sources and then its
 * checklist; the §10.3 minimal nodes and then its minimal relations; the supported diagnoses.
 */
export function v05Expected(roadmap: string, diagnoses: readonly string[]): Record<V05Table, readonly string[]> {
  const logBlocks = readRoadmapSectionBlocks(roadmap, '10.2');
  const graphBlocks = readRoadmapSectionBlocks(roadmap, '10.3');
  return {
    metrics: readRoadmapChecklist(roadmap, '10.1'),
    logs: [...(logBlocks[0] ?? []), ...readRoadmapChecklist(roadmap, '10.2')],
    // Block 1 lists the optional nodes, block 2 the minimal relations.
    graph: [...(graphBlocks[0] ?? []), ...(graphBlocks[2] ?? [])],
    diagnosis: diagnoses.filter((diagnosis) => diagnosis !== 'unknown'),
  };
}

export interface V05ScenarioMapInput extends ScenarioMapInput {
  /** The diagnosis vocabulary (`DIAGNOSES` of @noodara/domain); `unknown` is not a case. */
  readonly diagnoses: readonly string[];
}

const V05_LABELS: Record<V05Table, string> = { metrics: 'metric', logs: 'log item', graph: 'graph item', diagnosis: 'diagnosis' };

/** Every reason docs/releases/v0.5-scenarios.md does not prove §10.1-§10.3 and the diagnoses; empty when it does. */
export function checkV05ScenarioMap(input: V05ScenarioMapInput): string[] {
  const expected = v05Expected(input.roadmap, input.diagnoses);
  const problems: string[] = [];
  for (const table of Object.keys(V05_SECTIONS) as V05Table[]) {
    if (expected[table].length === 0) problems.push(`no ${V05_LABELS[table]} expected for ${V05_SECTIONS[table]}`);
  }
  const roadmapCases = readRoadmapSectionLines(input.roadmap, '10.8');
  if (roadmapCases.length !== expected.diagnosis.length) {
    problems.push(
      `roadmap §10.8 lists ${String(roadmapCases.length)} diagnosis cases, the vocabulary ${String(expected.diagnosis.length)}`,
    );
  }
  for (const table of Object.keys(V05_SECTIONS) as V05Table[]) {
    const spec: TableSpec = {
      label: V05_LABELS[table],
      section: V05_SECTIONS[table],
      cells: 4,
      expected: expected[table],
      fileProblem: (file) => (file.startsWith('tests/integration/') && file.endsWith('.test.ts') ? undefined : 'maps outside tests/integration/'),
      options: () => ({ perUbuntu: true }),
    };
    problems.push(...checkTable(spec, input.map, input.readSource));
  }
  return problems;
}
