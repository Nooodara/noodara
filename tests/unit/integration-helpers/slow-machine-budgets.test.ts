// 36-02 H4 / A4: no budget in the slow-machine scope becomes unbounded or silently unscaled.
// Static scan (TypeScript AST) of the files 36-02 touched: every it/test timeout, every hook
// timeout and every bare setTimeout delay must be `scaled(<named constant>)` or one of the few
// deliberately unscaled, named bounds below. A literal, 0, Infinity or an unscaled name fails.
// readyTimeout values in contracts.test.ts are ssh2 contract inputs (what the test measures),
// not test budgets, so they are outside this scan by construction (object properties, not args).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { scaleTimeout } from '../../support/timeout-scale';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SCOPE_FILES = [
  'apps/control-plane/src/services/legacy-log-redactor.test.ts',
  'tests/integration/ssh/contracts.test.ts',
  'tests/integration/ssh/fixture-lifecycle.test.ts',
  'tests/integration/helpers/leak-guard-setup.ts',
  'tests/integration/helpers/test-resources.ts',
  'tests/integration/helpers/test-resources.test.ts',
  'tests/integration/helpers/ssh.ts',
] as const;

/** Unscaled on purpose, each a named and documented bound:
 *  - LIFECYCLE_STOP_SETTLE_CAP_MS: stop() fail-closed cap delivered by 35-04 (semantics untouched);
 *  - budgetMs: the reap deadline, already resolved through scaled(SSH_FIXTURE_REAP_BUDGET_MS);
 *  - options.settleMs: leak-guard settle time, unchanged (A3 forbids lengthening it). */
const UNSCALED_ALLOWLIST = new Set(['LIFECYCLE_STOP_SETTLE_CAP_MS', 'budgetMs', 'options.settleMs']);

const TEST_CALLEES = new Set(['it', 'test']);
const HOOK_CALLEES = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);

function isNamedReference(node: ts.Expression): node is ts.Identifier | ts.PropertyAccessExpression {
  return (ts.isIdentifier(node) && node.text !== 'Infinity' && node.text !== 'undefined')
    || ts.isPropertyAccessExpression(node);
}

function calleeBase(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  // it.concurrent(...), test.sequential(...) and similar modifiers keep the same argument layout.
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) return callee.expression.text;
  return undefined;
}

function isScaledCall(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const named = (ts.isIdentifier(callee) && callee.text === 'scaled')
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'scaled');
  const [arg] = node.arguments;
  return named && node.arguments.length === 1 && arg !== undefined && isNamedReference(arg);
}

function budgetProblem(node: ts.Expression, source: ts.SourceFile): string | undefined {
  if (isScaledCall(node)) return undefined;
  if (isNamedReference(node) && UNSCALED_ALLOWLIST.has(node.getText(source))) return undefined;
  return node.getText(source);
}

function timeoutOf(options: ts.ObjectLiteralExpression): ts.Expression | undefined {
  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === 'timeout') return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'timeout') return property.name;
  }
  return undefined;
}

/** Returns one `file:line kind budget` entry per unbounded or unscaled budget. */
function findUnscaledBudgets(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const report = (kind: string, node: ts.Expression): void => {
    const problem = budgetProblem(node, source);
    if (problem === undefined) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    problems.push(`${fileName}:${String(line + 1)} ${kind} budget ${problem}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const base = calleeBase(node.expression);
      const args = node.arguments;
      if (base !== undefined && TEST_CALLEES.has(base)) {
        for (const index of [1, 2]) {
          const arg = args[index];
          if (arg === undefined || ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) continue;
          if (ts.isObjectLiteralExpression(arg)) {
            const timeout = timeoutOf(arg);
            if (timeout !== undefined) report(base, timeout);
          } else if (index === 2) report(base, arg);
        }
      } else if (base !== undefined && HOOK_CALLEES.has(base) && ts.isIdentifier(node.expression)) {
        const arg = args[1];
        if (arg !== undefined) report(base, arg);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'setTimeout') {
        const arg = args[1];
        if (arg !== undefined) report('setTimeout', arg);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/** Unscaled numeric value of a top-level `const NAME = <number>` (keeps test files unimported). */
function constantValue(file: string, name: string): number | undefined {
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  let value: number | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
      && node.initializer !== undefined && ts.isNumericLiteral(node.initializer)) {
      value = Number(node.initializer.text.replaceAll('_', ''));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return value;
}

describe('slow-machine budgets (36-02 H4)', () => {
  it.each(SCOPE_FILES)('%s routes every explicit test/hook/timer budget through scaled()', (file) => {
    expect(findUnscaledBudgets(file, readFileSync(path.join(root, file), 'utf8'))).toEqual([]);
  });

  it('the scan is not vacuous: it sees the scaled budgets the scope files declare', () => {
    const scaledSites = SCOPE_FILES.flatMap((file) => {
      const text = readFileSync(path.join(root, file), 'utf8');
      return [...text.matchAll(/scaled\((?:[A-Z_]+_MS)\)/g)].map(() => file);
    });
    expect(scaledSites).toEqual(expect.arrayContaining([
      'apps/control-plane/src/services/legacy-log-redactor.test.ts',
      'tests/integration/ssh/contracts.test.ts',
      'tests/integration/helpers/leak-guard-setup.ts',
      'tests/integration/helpers/ssh.ts',
    ]));
  });

  it.each([
    ['test timeout literal', "it('x', async () => {}, 120_000);", 'it budget 120_000'],
    ['test timeout of 0', "it('x', async () => {}, 0);", 'it budget 0'],
    ['test timeout of Infinity', "test('x', async () => {}, Infinity);", 'test budget Infinity'],
    ['test timeout as an unscaled name', "const BUDGET_MS = 5;\nit('x', async () => {}, BUDGET_MS);", 'it budget BUDGET_MS'],
    ['options-object timeout', "it('x', { timeout: 5000 }, async () => {});", 'it budget 5000'],
    ['trailing options-object timeout', "it('x', async () => {}, { timeout: Infinity });", 'it budget Infinity'],
    ['scaled() of a literal', "beforeAll(async () => {}, scaled(30_000));", 'beforeAll budget scaled(30_000)'],
    ['hook literal', "afterEach(async () => {}, 90_000);", 'afterEach budget 90_000'],
    ['bare setTimeout literal', "setTimeout(() => {}, 10_000);", 'setTimeout budget 10_000'],
    ['concurrent modifier literal', "it.concurrent('x', async () => {}, 1);", 'it budget 1'],
  ])('flags a %s', (_label, snippet, expected) => {
    const problems = findUnscaledBudgets('snippet.ts', snippet);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(expected);
  });

  it.each([
    "it('x', async () => {});",
    "it('x', async () => {}, scaled(BUDGET_MS));",
    "beforeAll(async () => {}, resolveRunnerTimeoutScale('vitest').scaled(HOOK_BUDGET_MS));",
    'setTimeout(resolve, options.settleMs);',
    'setTimeout(() => {}, LIFECYCLE_STOP_SETTLE_CAP_MS);',
    'socket.setTimeout(1000, () => {});',
  ])('accepts %s', (snippet) => {
    expect(findUnscaledBudgets('snippet.ts', snippet)).toEqual([]);
  });

  it.each([
    ['apps/control-plane/src/services/legacy-log-redactor.test.ts', 'PRODUCTION_WIRING_COLD_IMPORT_BUDGET_MS', 30_000],
    ['tests/integration/ssh/contracts.test.ts', 'CHANNEL_CLOSE_WAIT_MS', 10_000],
    ['tests/integration/helpers/leak-guard-setup.ts', 'LEAK_GUARD_HOOK_BUDGET_MS', 180_000],
    ['tests/integration/helpers/ssh.ts', 'SSH_FIXTURE_REAP_BUDGET_MS', 90_000],
    ['tests/integration/helpers/ssh.ts', 'LIFECYCLE_STOP_SETTLE_CAP_MS', 30_000],
  ] as const)('%s keeps %s at its unscaled %d ms, identical with the scale unset', (file, name, ms) => {
    const value = constantValue(file, name);
    expect(value).toBe(ms);
    expect(scaleTimeout(ms, 1)).toBe(ms);
  });
});
