// 29-02 (A2, A3): runs the eval dataset through the real agent loop, read-only tool registry and
// redactor, then scores it. Replay (default) answers every provider turn from a cassette and treats
// a miss as a failure. Live re-records the cassettes from the pinned model, writes a report and
// refreshes baseline.json; nothing else ever writes either file.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  runAgent,
  type AgentEvent,
  type AgentRunResult,
  type AIChatRequest,
  type AIProvider,
  type AIStreamRequest,
  type AIToolCallRequest,
} from '@noodara/ai';
import { revealSecret } from '@noodara/domain/security';
import { z } from 'zod';
import {
  CassetteMissError,
  canonicalJson,
  cassetteDigest,
  cassettePath,
  cassetteProblems,
  createRecordingProvider,
  createReplayProvider,
  readCassette,
  writeCassette,
} from './lib/cassette.js';
import type { FixtureModel } from './lib/fixture-model.js';
import { createLiveProvider, type EvalConfig, type EvalMode, type TemperatureState } from './lib/live.js';
import { EVALS_ROOT, loadDataset, loadScenarioContext, type Dataset } from './lib/load.js';
import type { Scenario } from './lib/schema.js';
import { METRIC_NAMES, aggregate, scoreScenario, thresholdFailures, type LeakSurface, type ScenarioScore, type SuiteMetrics } from './lib/scorer.js';

export const CASSETTES_DIR = join(EVALS_ROOT, 'cassettes');
export const BASELINE_FILE = join(EVALS_ROOT, 'baseline.json');

export interface ScenarioRun {
  readonly id: string;
  readonly questionType: Scenario['questionType'];
  readonly score: ScenarioScore;
  readonly turns: number;
  readonly miss: { readonly turn: number; readonly key: string } | null;
  /** A failure outside the agent's named outcomes, redacted. */
  readonly error: string | null;
}

export interface EvalReport {
  readonly schemaVersion: 1;
  readonly mode: EvalMode;
  readonly provider: EvalConfig['provider'];
  readonly model: string;
  readonly datasetVersion: string;
  readonly date: string;
  readonly temperature: 0 | null;
  readonly metrics: SuiteMetrics;
  readonly thresholdFailures: readonly string[];
  readonly scenarios: readonly ScenarioRun[];
}

export interface SuiteOptions {
  readonly config: EvalConfig;
  readonly dataset?: Dataset;
  readonly cassettesDir?: string;
  readonly baselineFile?: string;
  /** Run only these scenario ids. */
  readonly only?: readonly string[];
  /** Test seam: the provider a live run records from, instead of the real one. */
  readonly liveProvider?: (config: EvalConfig, temperature: TemperatureState) => AIProvider;
  readonly today?: string;
}

function modelDigest(model: FixtureModel): string {
  const { servers, projects, environments, services, secrets } = model;
  return createHash('sha256').update(canonicalJson({ servers, projects, environments, services, secrets })).digest('hex');
}

function capture(provider: AIProvider): { provider: AIProvider; requests: AIStreamRequest[] } {
  const requests: AIStreamRequest[] = [];
  return {
    requests,
    provider: {
      id: provider.id,
      model: provider.model,
      chat: (request: AIChatRequest) => {
        requests.push(request);
        return provider.chat(request);
      },
      toolCall: (request: AIToolCallRequest) => {
        requests.push(request);
        return provider.toolCall(request);
      },
      stream: (request: AIStreamRequest) => provider.stream(request),
    },
  };
}

function crashed(): AgentRunResult {
  return {
    status: 'failed',
    errorCode: 'AI_PROVIDER_UNAVAILABLE',
    budget: null,
    iterations: 0,
    toolCalls: [],
    unauthorizedAttempts: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    historyDropped: 0,
    durationMs: 0,
  };
}

interface RunContext {
  readonly config: EvalConfig;
  readonly dataset: Dataset;
  readonly cassettesDir: string;
  readonly temperature: TemperatureState;
  readonly today: string;
  readonly liveProvider: (config: EvalConfig, temperature: TemperatureState) => AIProvider;
}

async function runScenario(scenario: Scenario, run: RunContext): Promise<ScenarioRun> {
  const { config } = run;
  const context = loadScenarioContext(scenario, run.dataset.fixtures);
  const secrets = context.model.secrets.map((secret) => secret.value);
  // The key is registered with the conversation redactor, so no surface can carry it.
  if (config.apiKey !== null) secrets.push(revealSecret(config.apiKey, context.redactor));

  const file = cassettePath(run.cassettesDir, config.provider, scenario.id);
  const recorder = config.mode === 'live' ? createRecordingProvider(run.liveProvider(config, run.temperature), context.redactor) : null;
  const inner =
    recorder ??
    createReplayProvider({ provider: config.provider, model: config.model, scenarioId: scenario.id, cassette: readCassette(file), redactor: context.redactor });
  const { provider, requests } = capture(inner);

  const events: AgentEvent[] = [];
  const before = modelDigest(context.model);
  let result: AgentRunResult;
  let miss: ScenarioRun['miss'] = null;
  let error: string | null = null;
  try {
    result = await runAgent({
      provider,
      registry: context.registry,
      redactor: context.redactor,
      scope: context.scope,
      question: scenario.question,
      evidence: context.evidence,
      // The fixture clock: tool windows and every timestamp a request carries stay reproducible.
      now: () => context.nowMs,
      onEvent: (event) => events.push(event),
    });
  } catch (caught) {
    result = crashed();
    if (caught instanceof CassetteMissError) miss = { turn: caught.turn, key: caught.key };
    else error = context.redactor.redact(caught instanceof Error ? `${caught.name}: ${caught.message}` : 'non-error thrown');
  }

  if (recorder !== null) {
    writeCassette(
      file,
      {
        schemaVersion: 1,
        source: 'live',
        provider: config.provider,
        model: config.model,
        scenarioId: scenario.id,
        datasetVersion: run.dataset.manifest.version,
        recordedOn: run.today,
        temperature: run.temperature.temperature,
        interactions: [...recorder.interactions],
      },
      secrets,
    );
  }

  const surfaces: LeakSurface[] = [
    ...requests.map((request, index) => ({ label: `request#${index + 1}`, value: { system: request.system, messages: request.messages, tools: request.tools } })),
    ...events.map((event, index) => ({ label: `event#${index + 1}`, value: event })),
    { label: 'result', value: result },
    ...(error === null ? [] : [{ label: 'error', value: error }]),
  ];
  const entityRefs = new Map([...context.model.entities.values()].map((entity) => [entity.id.toLowerCase(), entity.ref]));
  const score = scoreScenario({ scenario, result, entityRefs, surfaces, secrets, stateChanged: modelDigest(context.model) !== before });
  return { id: scenario.id, questionType: scenario.questionType, score, turns: requests.length, miss, error };
}

async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function runEvalSuite(options: SuiteOptions): Promise<EvalReport> {
  const { config } = options;
  const dataset = options.dataset ?? loadDataset();
  const scenarios = options.only === undefined ? dataset.scenarios : dataset.scenarios.filter((scenario) => options.only?.includes(scenario.id));
  const run: RunContext = {
    config,
    dataset,
    cassettesDir: options.cassettesDir ?? CASSETTES_DIR,
    temperature: { temperature: 0 },
    today: options.today ?? new Date().toISOString().slice(0, 10),
    liveProvider: options.liveProvider ?? ((cfg, temperature) => createLiveProvider(cfg, temperature)),
  };
  const runs = await pool(scenarios, config.concurrency, (scenario) => runScenario(scenario, run));
  const metrics = aggregate(runs.map((entry) => entry.score));
  const cassetteTemperatures = config.mode === 'live' ? [run.temperature.temperature] : scenarios.map((s) => readCassetteTemperature(run.cassettesDir, config, s.id));
  const report: EvalReport = {
    schemaVersion: 1,
    mode: config.mode,
    provider: config.provider,
    model: config.model,
    datasetVersion: dataset.manifest.version,
    date: run.today,
    temperature: cassetteTemperatures.every((value) => value === 0) ? 0 : null,
    metrics,
    thresholdFailures: thresholdFailures(metrics),
    scenarios: runs,
  };
  if (config.mode === 'live') persistLiveRun(report, run.cassettesDir, options.baselineFile ?? BASELINE_FILE, scenarios.map((s) => s.id));
  return report;
}

function readCassetteTemperature(dir: string, config: EvalConfig, id: string): 0 | null {
  try {
    return readCassette(cassettePath(dir, config.provider, id))?.temperature ?? null;
  } catch {
    return null;
  }
}

/** Every reason the suite fails: misses, crashes, then the metric gates. */
export function reportFailures(report: EvalReport): string[] {
  const misses = report.scenarios.filter((entry) => entry.miss !== null);
  const errors = report.scenarios.filter((entry) => entry.error !== null);
  return [
    ...(misses.length > 0 ? [`${misses.length} cassette miss(es): ${misses.map((entry) => `${entry.id}@turn${entry.miss?.turn ?? 0}`).join(', ')}`] : []),
    ...errors.map((entry) => `${entry.id}: ${entry.error ?? ''}`),
    ...report.thresholdFailures,
  ];
}

// ---- baseline ---------------------------------------------------------------------------------

const MetricsSchema = z.strictObject({
  scenarios: z.int().nonnegative(),
  ...(Object.fromEntries(METRIC_NAMES.map((name) => [name, z.number().nonnegative()])) as Record<(typeof METRIC_NAMES)[number], z.ZodNumber>),
});

export const BaselineSchema = z.discriminatedUnion('source', [
  z.strictObject({ schemaVersion: z.literal(1), source: z.literal('none'), note: z.string().min(1) }),
  z.strictObject({
    schemaVersion: z.literal(1),
    /** Written only by a live run; replay never writes it. */
    source: z.literal('live'),
    provider: z.enum(['anthropic', 'openai']),
    model: z.string().min(1),
    datasetVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    date: z.iso.date(),
    temperature: z.literal(0).nullable(),
    metrics: MetricsSchema,
    thresholdFailures: z.array(z.string()),
    /** cassetteDigest of the recording this run produced. */
    cassetteDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
export type Baseline = z.infer<typeof BaselineSchema>;

export function readBaseline(file: string = BASELINE_FILE): Baseline {
  return BaselineSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

function writeJson(file: string, value: unknown, forbidden: readonly string[]): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const problems = cassetteProblems(text, forbidden);
  if (problems.length > 0) throw new Error(`${file} not written: ${problems.join(', ')}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

export function reportPath(dir: string, provider: EvalConfig['provider']): string {
  return join(dir, provider, 'report.json');
}

function persistLiveRun(report: EvalReport, cassettesDir: string, baselineFile: string, scenarioIds: readonly string[]): void {
  writeJson(reportPath(cassettesDir, report.provider), report, []);
  const baseline: Baseline = {
    schemaVersion: 1,
    source: 'live',
    provider: report.provider,
    model: report.model,
    datasetVersion: report.datasetVersion,
    date: report.date,
    temperature: report.temperature,
    metrics: report.metrics,
    thresholdFailures: [...report.thresholdFailures],
    cassetteDigest: cassetteDigest(cassettesDir, report.provider, scenarioIds),
  };
  writeJson(baselineFile, BaselineSchema.parse(baseline), []);
}

/** Replay: the baseline must come from a live run of this model and dataset over these cassettes. */
export function baselineProblems(baseline: Baseline, report: EvalReport, digest: string): string[] {
  if (baseline.source === 'none') return [`baseline.json has no live run yet: ${baseline.note}`];
  if (baseline.provider !== report.provider) return [];
  const problems: string[] = [];
  if (baseline.model !== report.model) problems.push(`baseline model ${baseline.model} is not the pinned ${report.model}`);
  if (baseline.datasetVersion !== report.datasetVersion)
    problems.push(`baseline dataset ${baseline.datasetVersion} is not the current ${report.datasetVersion}`);
  if (baseline.cassetteDigest !== digest) problems.push('the cassettes differ from the live run that produced baseline.json');
  return problems;
}

export function hasBaseline(file: string = BASELINE_FILE): boolean {
  return existsSync(file);
}
