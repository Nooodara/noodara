import type { SecretValue } from '@noodara/domain/security';
import { resolveBaseUrl } from './base-url.js';
import { resolveLimits, type AICallLimits } from './call.js';
import { AIProviderConfigError } from './errors.js';
import { resolveModel } from './provider-kit.js';
import { createAnthropicProvider } from './providers/anthropic/index.js';
import { createOpenAIProvider } from './providers/openai/index.js';
import { AI_PROVIDER_IDS, isImplementedAIProviderId, type AIProvider } from './types.js';

export * from './types.js';
export { AIProviderError, AIProviderConfigError } from './errors.js';
export type { AIProviderErrorCode, AIProviderFailureReason, AIProviderConfigReason } from './errors.js';
export { PINNED_BASE_URLS, resolveBaseUrl } from './base-url.js';
export { DEFAULT_CALL_LIMITS, parseRetryAfter } from './call.js';
export type { AICallLimits, Sleep } from './call.js';

export interface CreateAIProviderOptions {
  readonly id: string;
  readonly apiKey: SecretValue;
  readonly model?: string;
  readonly limits?: Partial<AICallLimits>;
  /** Test seam / future openai-compatible endpoint; validated by resolveBaseUrl (H2). */
  readonly baseUrl?: string;
  readonly allowInsecureTestSeam?: boolean;
  /** Test seam: the transport under the guarded fetch. */
  readonly fetch?: typeof fetch;
}

/** Builds an AIProvider. Only anthropic and openai are implemented; others are known but rejected. */
export function createAIProvider(options: CreateAIProviderOptions): AIProvider {
  const { id } = options;
  if (!(AI_PROVIDER_IDS as readonly string[]).includes(id)) throw new AIProviderConfigError('unknown_provider');
  if (!isImplementedAIProviderId(id)) throw new AIProviderConfigError('not_implemented');
  const config = {
    apiKey: options.apiKey,
    model: resolveModel(id, options.model),
    baseUrl: resolveBaseUrl(id, options.baseUrl, { allowInsecureTestSeam: options.allowInsecureTestSeam === true }),
    limits: resolveLimits(options.limits),
    fetchImpl: options.fetch,
  };
  return id === 'anthropic' ? createAnthropicProvider(config) : createOpenAIProvider(config);
}
