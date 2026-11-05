// 29-02 (A3): how the suite runs. Replay is the default and needs no key. NOODARA_AI_EVAL_LIVE=1
// runs the same suite against the pinned model of the chosen provider with a real key, asks for
// temperature 0 and re-records the cassettes.
import { createAIProvider, type AIProvider, type ImplementedAIProviderId } from '@noodara/ai';
import { AI_PROVIDER_MODELS } from '@noodara/domain/api-contract';
import { secretValue, type SecretValue } from '@noodara/domain/security';

export type EvalMode = 'replay' | 'live';

export interface EvalConfig {
  readonly mode: EvalMode;
  readonly provider: ImplementedAIProviderId;
  /** The provider's pinned model (ADR 0012); never chosen per run. */
  readonly model: string;
  readonly apiKey: SecretValue | null;
  readonly concurrency: number;
}

export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalConfigError';
  }
}

const KEY_VARIABLES: Readonly<Record<ImplementedAIProviderId, string>> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

export function pinnedModel(provider: ImplementedAIProviderId): string {
  const model = AI_PROVIDER_MODELS[provider][0];
  if (model === undefined) throw new EvalConfigError(`no pinned model for ${provider}`);
  return model;
}

export function resolveEvalConfig(env: Readonly<Record<string, string | undefined>>): EvalConfig {
  const providerName = env.NOODARA_AI_EVAL_PROVIDER ?? 'anthropic';
  if (providerName !== 'anthropic' && providerName !== 'openai')
    throw new EvalConfigError(`NOODARA_AI_EVAL_PROVIDER must be anthropic or openai, got ${providerName}`);
  const provider: ImplementedAIProviderId = providerName;
  const live = env.NOODARA_AI_EVAL_LIVE === '1';
  const concurrency = Number.parseInt(env.NOODARA_AI_EVAL_CONCURRENCY ?? '4', 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new EvalConfigError('NOODARA_AI_EVAL_CONCURRENCY must be an integer from 1 to 16');

  let apiKey: SecretValue | null = null;
  if (live) {
    const raw = env.NOODARA_AI_EVAL_API_KEY ?? env[KEY_VARIABLES[provider]];
    if (raw === undefined || raw.trim() === '')
      throw new EvalConfigError(`NOODARA_AI_EVAL_LIVE=1 needs NOODARA_AI_EVAL_API_KEY or ${KEY_VARIABLES[provider]}`);
    apiKey = secretValue(raw.trim(), 'ai_provider_key');
  }
  return { mode: live ? 'live' : 'replay', provider, model: pinnedModel(provider), apiKey, concurrency };
}

export interface TemperatureState {
  /** 0 while the provider accepts it; null once the pinned model rejected a temperature. */
  temperature: 0 | null;
}

function mentionsTemperature(body: string): boolean {
  return /temperature/i.test(body);
}

/**
 * A transport that adds `temperature: 0` to every JSON request body. Reasoning models (adaptive
 * thinking, gpt-5) only sample at their default and answer 400 naming the parameter; then the
 * request is sent again without it, later requests skip it, and the state records null so the
 * report never claims a temperature the provider did not apply.
 */
export function createTemperatureFetch(base: typeof fetch, state: TemperatureState): typeof fetch {
  return async (input, init) => {
    if (state.temperature === null || typeof init?.body !== 'string') return base(input, init);
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return base(input, init);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return base(input, init);
    const response = await base(input, { ...init, body: JSON.stringify({ ...parsed, temperature: state.temperature }) });
    if (response.status !== 400) return response;
    const text = await response.clone().text();
    if (!mentionsTemperature(text)) return response;
    await response.body?.cancel();
    state.temperature = null;
    return base(input, init);
  };
}

export function createLiveProvider(config: EvalConfig, state: TemperatureState, transport: typeof fetch = fetch): AIProvider {
  if (config.apiKey === null) throw new EvalConfigError('live mode needs an API key');
  return createAIProvider({
    id: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    fetch: createTemperatureFetch(transport, state),
  });
}
