// 29-03 (A2): runs the adversarial set through the real agent loop, read-only registry and
// redactor, then judges every case. Replay (CI default) answers each turn from a cassette and a
// miss fails the run. Live records the cassettes from the pinned model together with the baseline
// run and writes report.json; nothing else writes either.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AIProviderError,
  runAgent,
  type AgentEvent,
  type AgentRunResult,
  type AIChatRequest,
  type AIChatResponse,
  type AIProvider,
  type AIStreamRequest,
  type AIToolCallRequest,
} from '@noodara/ai';
import { revealSecret } from '@noodara/domain/security';
import { z } from 'zod';
import {
  CassetteMissError,
  cassetteDigest,
  cassettePath,
  cassetteProblems,
  createRecordingProvider,
  createReplayProvider,
  readCassette,
  writeCassette,
} from '../lib/cassette.js';
import {
  ADVERSARIAL_CASSETTES_DIR,
  judgeCase,
  loadAdversarialSet,
  loadCaseContext,
  modelDigest,
  type AdversarialCase,
  type AdversarialSet,
  type CaseObservation,
  type CaseVerdict,
} from '../lib/adversarial.js';
import { createLiveProvider, type EvalConfig, type EvalMode, type TemperatureState } from '../lib/live.js';

export interface CaseRun {
  readonly verdict: CaseVerdict;
  readonly observation: CaseObservation;
  readonly miss: { readonly turn: number; readonly key: string } | null;
  /** A failure outside the agent's named outcomes, redacted. */
  readonly error: string | null;
}

/** Captures what the agent sent and what the provider answered, before the loop handles it. */
function capture(provider: AIProvider): {
  provider: AIProvider;
  requests: unknown[];
  responses: AIChatResponse[];
  refusals: () => number;
} {
  const requests: unknown[] = [];
  const responses: AIChatResponse[] = [];
  let refusals = 0;
  const call = async (request: AIStreamRequest, send: () => Promise<AIChatResponse>): Promise<AIChatResponse> => {
    requests.push({ system: request.system, messages: request.messages, tools: request.tools });
    try {
      const response = await send();
      responses.push(response);
      return response;
    } catch (error) {
      if (error instanceof AIProviderError && error.reason === 'unexpected_tool') refusals += 1;
      throw error;
    }
  };
  return {
    requests,
    responses,
    refusals: () => refusals,
    provider: {
      id: provider.id,
      model: provider.model,
      chat: (request: AIChatRequest) => call(request, () => provider.chat(request)),
      toolCall: (request: AIToolCallRequest) => call(request, () => provider.toolCall(request)),
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

/** One case over any provider: the scripted hostile model, a cassette or the live model. */
export async function runCase(
  entry: AdversarialCase,
  set: AdversarialSet,
  makeProvider: (context: ReturnType<typeof loadCaseContext>) => AIProvider,
  extraSecrets: readonly string[] = [],
): Promise<CaseRun> {
  const context = loadCaseContext(entry, set);
  const secrets = [...context.secrets, ...extraSecrets];
  const { provider, requests, responses, refusals } = capture(makeProvider(context));
  const events: AgentEvent[] = [];
  const before = modelDigest(context.model);
  let result: AgentRunResult;
  let miss: CaseRun['miss'] = null;
  let error: string | null = null;
  try {
    result = await runAgent({
      provider,
      registry: context.registry,
      redactor: context.redactor,
      scope: context.scope,
      question: entry.question,
      evidence: [],
      now: () => context.nowMs,
      onEvent: (event) => events.push(event),
    });
  } catch (caught) {
    result = crashed();
    if (caught instanceof CassetteMissError) miss = { turn: caught.turn, key: caught.key };
    else error = context.redactor.redact(caught instanceof Error ? `${caught.name}: ${caught.message}` : 'non-error thrown');
  }
  const observation: CaseObservation = {
    entry,
    result,
    events,
    requests,
    responses,
    providerToolRefusals: refusals(),
    backendCalls: context.backendCalls,
    stateChanged: modelDigest(context.model) !== before,
    secrets,
  };
  return { verdict: judgeCase(observation), observation, miss, error };
}

// ---- suite ------------------------------------------------------------------------------------

export const AdversarialReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.literal('live'),
  provider: z.enum(['anthropic', 'openai']),
  model: z.string().min(1),
  setVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  date: z.iso.date(),
  temperature: z.literal(0).nullable(),
  cassetteDigest: z.string().regex(/^[0-9a-f]{64}$/),
  verdicts: z.array(
    z.strictObject({
      id: z.string(),
      status: z.enum(['answered', 'failed', 'aborted']),
      writeAttempts: z.int().nonnegative(),
      recordedAttempts: z.int().nonnegative(),
      failures: z.array(z.string()),
    }),
  ),
});
export type AdversarialReport = z.infer<typeof AdversarialReportSchema>;

export interface AdversarialSuiteResult {
  readonly mode: EvalMode;
  readonly model: string;
  readonly runs: readonly CaseRun[];
  /** Every reason the suite fails: misses, crashes, then each case's failures. */
  readonly failures: readonly string[];
}

export interface AdversarialSuiteOptions {
  readonly config: EvalConfig;
  readonly set?: AdversarialSet;
  readonly cassettesDir?: string;
  /** Test seam: the provider a live run records from, instead of the real one. */
  readonly liveProvider?: (config: EvalConfig, temperature: TemperatureState) => AIProvider;
  readonly today?: string;
}

export function adversarialReportPath(dir: string, provider: EvalConfig['provider']): string {
  return join(dir, provider, 'report.json');
}

export function readAdversarialReport(file: string): AdversarialReport | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return AdversarialReportSchema.parse(JSON.parse(text));
}

function writeReport(file: string, report: AdversarialReport, forbidden: readonly string[]): void {
  const text = `${JSON.stringify(AdversarialReportSchema.parse(report), null, 2)}\n`;
  const problems = cassetteProblems(text, forbidden);
  if (problems.length > 0) throw new Error(`${file} not written: ${problems.join(', ')}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

export function suiteFailures(runs: readonly CaseRun[]): string[] {
  return runs.flatMap((run) => [
    ...(run.miss === null ? [] : [`${run.verdict.id}: cassette miss at turn ${run.miss.turn}`]),
    ...(run.error === null ? [] : [`${run.verdict.id}: ${run.error}`]),
    ...run.verdict.failures.map((failure) => `${run.verdict.id}: ${failure}`),
  ]);
}

export async function runAdversarialSuite(options: AdversarialSuiteOptions): Promise<AdversarialSuiteResult> {
  const { config } = options;
  const set = options.set ?? loadAdversarialSet();
  const dir = options.cassettesDir ?? ADVERSARIAL_CASSETTES_DIR;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const temperature: TemperatureState = { temperature: 0 };
  const liveProvider = options.liveProvider ?? ((cfg, state) => createLiveProvider(cfg, state));
  const key = config.apiKey === null ? [] : [revealSecret(config.apiKey)];

  const runs: CaseRun[] = [];
  // Sequential: a live provider sees one adversarial conversation at a time.
  for (const entry of set.cases) {
    const file = cassettePath(dir, config.provider, entry.id);
    let recorder: ReturnType<typeof createRecordingProvider> | null = null;
    const run = await runCase(
      entry,
      set,
      (context) => {
        if (config.mode === 'live') {
          recorder = createRecordingProvider(liveProvider(config, temperature), context.redactor);
          return recorder;
        }
        return createReplayProvider({
          provider: config.provider,
          model: config.model,
          scenarioId: entry.id,
          cassette: readCassette(file),
          redactor: context.redactor,
        });
      },
      key,
    );
    const recorded = recorder as ReturnType<typeof createRecordingProvider> | null;
    if (recorded !== null) {
      writeCassette(
        file,
        {
          schemaVersion: 1,
          source: 'live',
          provider: config.provider,
          model: config.model,
          scenarioId: entry.id,
          datasetVersion: set.version,
          recordedOn: today,
          temperature: temperature.temperature,
          interactions: [...recorded.interactions],
        },
        [...run.observation.secrets],
      );
    }
    runs.push(run);
  }

  if (config.mode === 'live') {
    writeReport(
      adversarialReportPath(dir, config.provider),
      {
        schemaVersion: 1,
        source: 'live',
        provider: config.provider,
        model: config.model,
        setVersion: set.version,
        date: today,
        temperature: temperature.temperature,
        cassetteDigest: cassetteDigest(
          dir,
          config.provider,
          set.cases.map((entry) => entry.id),
        ),
        verdicts: runs.map((run) => ({ ...run.verdict, failures: [...run.verdict.failures] })),
      },
      key,
    );
  }
  return { mode: config.mode, model: config.model, runs, failures: suiteFailures(runs) };
}

/** Replay: the cassettes must come from a live run of the pinned model, recorded with the baseline. */
export function reportProblems(
  report: AdversarialReport | null,
  context: { readonly provider: EvalConfig['provider']; readonly model: string; readonly setVersion: string; readonly digest: string; readonly baselineDate: string | null },
): string[] {
  if (report === null) return [`no live adversarial report for ${context.provider}: record it with the baseline run`];
  const problems: string[] = [];
  if (report.provider !== context.provider) problems.push(`report provider ${report.provider} is not ${context.provider}`);
  if (report.model !== context.model) problems.push(`report model ${report.model} is not the pinned ${context.model}`);
  if (report.setVersion !== context.setVersion) problems.push(`report set ${report.setVersion} is not the current ${context.setVersion}`);
  if (report.cassetteDigest !== context.digest) problems.push('the cassettes differ from the live run that wrote report.json');
  if (context.baselineDate !== null && report.date !== context.baselineDate)
    problems.push(`adversarial run ${report.date} was not recorded with the baseline run ${context.baselineDate}`);
  return problems;
}
