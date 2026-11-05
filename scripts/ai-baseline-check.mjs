#!/usr/bin/env node
// 29-04: the AI eval baseline policy (docs/ai/evals.md).
//
//   guard            CI preflight: replay mode only (NOODARA_AI_EVAL_LIVE unset, no provider key in
//                    the environment) and every cassette directory present and committed.
//   replay           Replays the 50+ scenarios from the committed cassettes and fails on a miss, a
//                    crash, a threshold or any metric worse than tests/ai/evals/baseline.json.
//   update --base R  Compares baseline.json at revision R with the working tree and refuses a lowered
//                    metric unless tests/ai/evals/baseline-justifications/<cassetteDigest>.md
//                    explains every lowered metric.
//
// Options: --root <dir> (default: the repository holding this script). Only `replay` loads more
// than node builtins: it runs tests/ai/evals/runner.ts through the Vite that Vitest ships with.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BASELINE_PATH = 'tests/ai/evals/baseline.json';
export const JUSTIFICATIONS_DIR = 'tests/ai/evals/baseline-justifications';
export const MIN_SCENARIOS = 50;
export const PROVIDER_KEY_VARIABLES = Object.freeze(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NOODARA_AI_EVAL_API_KEY']);
const MIN_JUSTIFICATION_WORDS = 20;
const GIT_TIMEOUT_MS = 30_000;

/** +1: higher is better, -1: lower is better. Every metric baseline.json carries must be listed. */
export const METRIC_DIRECTIONS = Object.freeze({
  scenarios: 1,
  entitySelection: 1,
  evidenceGrounding: 1,
  diagnosisAccuracy: 1,
  hallucinatedResources: -1,
  secretLeakage: -1,
  unauthorizedWrites: -1,
});

/** The cassette directories the replay job needs, committed, with at least `min` recordings each. */
export function cassetteDirs(provider = 'anthropic') {
  return [
    { dir: `tests/ai/evals/cassettes/${provider}/scenarios`, min: MIN_SCENARIOS },
    { dir: `tests/ai/evals/adversarial/cassettes/${provider}/scenarios`, min: 1 },
  ];
}
const WATCHED_PATHS = ['tests/ai/evals/cassettes', 'tests/ai/evals/adversarial/cassettes', BASELINE_PATH];

// ---- metrics ------------------------------------------------------------------------------------

/** Every metric `after` makes worse than `before`, plus any metric `after` drops or nobody ranked. */
export function metricRegressions(before, after) {
  const regressions = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const direction = METRIC_DIRECTIONS[name];
    const was = before[name];
    const now = after[name];
    if (direction === undefined) regressions.push({ metric: name, before: was ?? null, after: now ?? null, reason: 'has no direction in METRIC_DIRECTIONS' });
    else if (was === undefined) continue;
    else if (typeof now !== 'number') regressions.push({ metric: name, before: was, after: null, reason: 'was removed' });
    else if ((now - was) * direction < 0) regressions.push({ metric: name, before: was, after: now, reason: direction > 0 ? 'dropped' : 'rose' });
  }
  return regressions;
}

const describeRegression = (r) => `${r.metric} ${r.reason} (${r.before ?? '-'} -> ${r.after ?? '-'})`;

const HEX64 = /^[0-9a-f]{64}$/;

/** The parts of baseline.json this policy reads; the full schema lives in tests/ai/evals/runner.ts. */
export function parseBaseline(text, label = BASELINE_PATH) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (value?.source === 'none') return value;
  const metrics = value?.metrics;
  const valid =
    value?.source === 'live' &&
    typeof value.cassetteDigest === 'string' &&
    HEX64.test(value.cassetteDigest) &&
    metrics !== null &&
    typeof metrics === 'object' &&
    Object.values(metrics).every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!valid) throw new Error(`${label} is neither a live baseline nor {"source":"none"}`);
  return value;
}

// ---- replay -------------------------------------------------------------------------------------

/** Why a replayed report fails the merge gate against the committed baseline. */
export function replayProblems(baseline, report) {
  const problems = [];
  const misses = report.scenarios.filter((entry) => entry.miss !== null).map((entry) => entry.id);
  if (misses.length > 0) problems.push(`${misses.length} cassette miss(es): ${misses.join(', ')}`);
  for (const entry of report.scenarios) if (entry.error !== null) problems.push(`${entry.id} crashed: ${entry.error}`);
  if (report.metrics.scenarios < MIN_SCENARIOS) problems.push(`only ${report.metrics.scenarios} scenarios replayed, needs ${MIN_SCENARIOS}+`);
  problems.push(...report.thresholdFailures.map((failure) => `threshold: ${failure}`));
  if (baseline.source !== 'live') problems.push('baseline.json has no live run to compare against');
  else for (const r of metricRegressions(baseline.metrics, report.metrics)) problems.push(`below baseline.json: ${describeRegression(r)}`);
  return problems;
}

async function replayReport(root, baseline) {
  const requireFromRoot = createRequire(join(root, 'package.json'));
  // vite is Vitest's own dependency, not a root one, so it resolves from vitest's install.
  const vitePath = createRequire(requireFromRoot.resolve('vitest/package.json')).resolve('vite');
  const { createServer } = await import(pathToFileURL(vitePath).href);
  const server = await createServer({
    root,
    configFile: join(root, 'vitest.ai-evals.config.ts'),
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { runEvalSuite } = await server.ssrLoadModule('/tests/ai/evals/runner.ts');
    const { resolveEvalConfig } = await server.ssrLoadModule('/tests/ai/evals/lib/live.ts');
    // Never live, whatever the environment says: only the provider name is taken from the baseline.
    const config = resolveEvalConfig({ NOODARA_AI_EVAL_PROVIDER: baseline.source === 'live' ? baseline.provider : 'anthropic' });
    return await runEvalSuite({ config });
  } finally {
    await server.close();
  }
}

// ---- update -------------------------------------------------------------------------------------

export function justificationPath(digest) {
  return `${JUSTIFICATIONS_DIR}/${digest}.md`;
}

/**
 * Refuses a baseline change that lowers any metric unless the change carries a justification
 * file, keyed by the new cassetteDigest, that names every lowered metric and explains it.
 * `readJustification(path)` returns the file text or null.
 */
export function baselineUpdateProblems(base, head, readJustification) {
  if (base === null || base.source !== 'live') return [];
  if (head.source !== 'live') return [`baseline.json drops the live baseline from ${base.date}; re-record it live instead`];
  const regressions = metricRegressions(base.metrics, head.metrics);
  if (regressions.length === 0) return [];
  const path = justificationPath(head.cassetteDigest);
  const listed = regressions.map(describeRegression).join('; ');
  const text = readJustification(path);
  if (text === null) return [`baseline.json lowers ${listed}; add ${path} explaining why`];
  const problems = [];
  const missing = regressions.filter((r) => !text.includes(r.metric)).map((r) => r.metric);
  if (missing.length > 0) problems.push(`${path} does not name ${missing.join(', ')}`);
  const words = text.split(/\s+/).filter((word) => /[a-z]/i.test(word)).length;
  if (words < MIN_JUSTIFICATION_WORDS) problems.push(`${path} needs at least ${MIN_JUSTIFICATION_WORDS} words of explanation, has ${words}`);
  return problems;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
}

function baselineAt(root, rev) {
  try {
    git(root, ['cat-file', '-e', `${rev}^{commit}`]);
  } catch {
    throw new Error(`base revision ${rev} is not in this clone (check out with fetch-depth: 0)`);
  }
  let text;
  try {
    text = git(root, ['show', `${rev}:${BASELINE_PATH}`]);
  } catch {
    return null; // no baseline at the base revision: nothing to lower
  }
  return parseBaseline(text, `${BASELINE_PATH}@${rev}`);
}

function readText(root, path) {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function updateCheck(root, rev) {
  if (rev === '' || /^0+$/.test(rev)) return { problems: [], note: 'no base revision; nothing to compare' };
  const base = baselineAt(root, rev);
  const headText = readText(root, BASELINE_PATH);
  if (headText === null) return { problems: base === null ? [] : [`${BASELINE_PATH} was deleted`], note: '' };
  const head = parseBaseline(headText);
  return { problems: baselineUpdateProblems(base, head, (path) => readText(root, path)), note: base === null ? `no baseline at ${rev}` : '' };
}

// ---- guard --------------------------------------------------------------------------------------

/** The replay job must not be able to reach a provider. */
export function envProblems(env) {
  const problems = [];
  if (env.NOODARA_AI_EVAL_LIVE !== undefined) problems.push('NOODARA_AI_EVAL_LIVE must be unset in the replay job');
  for (const name of PROVIDER_KEY_VARIABLES)
    if (env[name] !== undefined && env[name] !== '') problems.push(`${name} must not reach the replay job`);
  return problems;
}

export function cassetteProblems(root, provider = 'anthropic') {
  const problems = [];
  for (const { dir, min } of cassetteDirs(provider)) {
    if (!existsSync(join(root, dir))) {
      problems.push(`${dir} is missing`);
      continue;
    }
    const committed = git(root, ['ls-files', '-z', '--', dir]).split('\0').filter((file) => file.endsWith('.json')).length;
    if (committed < min) problems.push(`${dir} has ${committed} committed cassette(s), needs at least ${min}`);
  }
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...WATCHED_PATHS]).split('\n').filter(Boolean);
  const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...WATCHED_PATHS]).split('\n').filter(Boolean);
  for (const line of dirty) problems.push(`uncommitted: ${line.trim()}`);
  for (const file of ignored) problems.push(`ignored, never committed: ${file}`);
  return problems;
}

function baselineProvider(root) {
  const text = readText(root, BASELINE_PATH);
  if (text === null) return 'anthropic';
  const baseline = parseBaseline(text);
  return baseline.source === 'live' ? baseline.provider : 'anthropic';
}

// ---- cli ----------------------------------------------------------------------------------------

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command] = args;
  const root = option(args, '--root') ?? REPO_ROOT;
  let problems;
  let note = '';
  if (command === 'guard') {
    problems = [...envProblems(env), ...cassetteProblems(root, baselineProvider(root))];
  } else if (command === 'replay') {
    const baseline = parseBaseline(readText(root, BASELINE_PATH) ?? '');
    const report = await replayReport(root, baseline);
    problems = replayProblems(baseline, report);
    note = `${report.metrics.scenarios} scenarios replayed`;
  } else if (command === 'update') {
    const rev = option(args, '--base');
    if (rev === undefined) throw new Error('update needs --base <revision>');
    ({ problems, note } = updateCheck(root, rev));
  } else {
    throw new Error('usage: ai-baseline-check.mjs guard | replay | update --base <revision> [--root <dir>]');
  }
  for (const problem of problems) console.error(`ai-baseline-check ${command}: ${problem}`);
  if (problems.length > 0) return 1;
  console.log(`ai-baseline-check ${command}: ok${note === '' ? '' : ` (${note})`}`);
  return 0;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`ai-baseline-check: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
