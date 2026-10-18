// 20-01: checks docs/releases/v0.3-scenarios.md against the roadmap §8.8 list and the test sources.
// Every scenario maps to one named test that exists, is not skipped and runs once per Ubuntu
// version (inside `describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)`). Pure: sources are passed in.
import ts from 'typescript';

export const UBUNTU_VERSIONS = ['22.04', '24.04'] as const;
const VERSIONS_IDENTIFIER = 'DEPLOY_ENGINE_UBUNTU_VERSIONS';
const VERSIONS_MODULE = '../helpers/deploy-engine.js';
const SKIPPING_MODIFIERS = new Set(['skip', 'todo', 'skipIf', 'runIf', 'only', 'fails']);
const TEST_BASES = new Set(['it', 'test']);
const SUITE_BASES = new Set(['describe', 'suite']);

export interface ScenarioMapRow {
  readonly index: number;
  readonly scenario: string;
  readonly file: string;
  readonly test: string;
  readonly ubuntu: readonly string[];
}

/** The scenario lines of the first code block under `## 8.8` in the roadmap. */
export function readRoadmapScenarios(roadmap: string): string[] {
  const section = /\n## 8\.8 [^\n]*\n([\s\S]*?)(?:\n## |$)/.exec(roadmap)?.[1] ?? '';
  const block = /```text\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const unquote = (cell: string): string => cell.trim().replace(/^`([\s\S]*)`$/, '$1');

/** Rows of the `| # | Scenario | Test file | Test name | Ubuntu |` table. */
export function parseScenarioMap(markdown: string): ScenarioMapRow[] {
  const rows: ScenarioMapRow[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*(\d+)\s*\|(.*)\|\s*$/.exec(line.trim());
    if (!match) continue;
    const cells = (match[2] ?? '').split('|');
    if (cells.length !== 4) continue;
    const [scenario = '', file = '', test = '', ubuntu = ''] = cells.map(unquote);
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

/** Problems that keep `title` in `source` from proving its scenario on both Ubuntu versions. */
export function checkMappedTest(source: string, fileName: string, title: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches: ts.CallExpression[] = [];
  forEachDescendant(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const shape = callShape(node);
    if (shape !== undefined && TEST_BASES.has(shape.base) && literalText(node.arguments[0]) === title) matches.push(node);
  });
  if (matches.length === 0) return [`test not found: '${title}'`];
  if (matches.length > 1) return [`test name is ambiguous (${String(matches.length)} matches): '${title}'`];
  const [call] = matches as [ts.CallExpression];
  const problems: string[] = [];

  const skipped = (callShape(call)?.modifiers ?? []).filter((modifier) => SKIPPING_MODIFIERS.has(modifier));
  if (skipped.length > 0) problems.push(`test is skipped (it.${skipped.join('.')}): '${title}'`);

  let versionParam: string | undefined;
  for (let node: ts.Node | undefined = call.parent; node !== undefined; node = node.parent) {
    if (!ts.isCallExpression(node)) continue;
    const shape = callShape(node);
    if (shape === undefined || !SUITE_BASES.has(shape.base)) continue;
    const suiteSkips = shape.modifiers.filter((modifier) => SKIPPING_MODIFIERS.has(modifier));
    if (suiteSkips.length > 0) problems.push(`enclosing suite is skipped (describe.${suiteSkips.join('.')}): '${title}'`);
    const table = shape.modifierArgs.get('each')?.[0];
    if (table !== undefined && ts.isIdentifier(table) && table.text === VERSIONS_IDENTIFIER) {
      const param = callbackOf(node)?.parameters[0]?.name;
      versionParam = param !== undefined && ts.isIdentifier(param) ? param.text : '';
    }
  }
  if (versionParam === undefined) {
    problems.push(`test does not run per Ubuntu version (not inside describe.each(${VERSIONS_IDENTIFIER})): '${title}'`);
  } else if (!importsVersions(file)) {
    problems.push(`${VERSIONS_IDENTIFIER} is not imported from ${VERSIONS_MODULE} in ${fileName}`);
  }

  const body = callbackOf(call);
  if (body === undefined) {
    problems.push(`test has no body: '${title}'`);
    return problems;
  }
  forEachDescendant(body, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'skip') {
      problems.push(`test body skips itself (${node.expression.getText(file)}()): '${title}'`);
    }
    if (versionParam !== undefined && versionParam !== '' && ts.isIfStatement(node) && mentions(node.expression, versionParam) && returns(node.thenStatement)) {
      problems.push(`test returns early on an Ubuntu version (${node.expression.getText(file)}): '${title}'`);
    }
  });
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
