// 28-02 (A1, A2, H1): the bounded validation call made before a key is stored. One plain turn
// with a fixed prompt, no retries and an explicit deadline. Any failure collapses to a closed
// code: a provider message, status or body never leaves this module.
//
// `@noodara/ai` (and so both vendor SDKs) is loaded on the first validation, not at boot.
import type { AICallLimits } from '@noodara/ai';
import type { AiProvider } from '@noodara/domain/api-contract';
import type { SecretValue } from '@noodara/domain/security';

export type KeyValidationFailureCode = 'AI_PROVIDER_AUTH_FAILED' | 'AI_PROVIDER_RATE_LIMITED' | 'AI_PROVIDER_UNAVAILABLE';

export type KeyValidationOutcome = { readonly ok: true } | { readonly ok: false; readonly code: KeyValidationFailureCode };

export interface KeyValidationInput {
  readonly provider: AiProvider;
  readonly model: string;
  readonly apiKey: SecretValue;
}

export type ProviderKeyValidator = (input: KeyValidationInput) => Promise<KeyValidationOutcome>;

export const VALIDATION_CALL_LIMITS: Readonly<Partial<AICallLimits>> = Object.freeze({
  timeoutMs: 15_000,
  idleTimeoutMs: 10_000,
  maxResponseBytes: 256 * 1024,
  maxRetries: 0,
});

const VALIDATION_PROMPT = 'Reply with the single word OK.';
const VALIDATION_MAX_TOKENS = 256;

export interface ProviderKeyValidatorOptions {
  readonly limits?: Partial<AICallLimits>;
  /** Test seam: the transport under the provider's guarded fetch. */
  readonly fetch?: typeof fetch;
}

const PASSTHROUGH_CODES: ReadonlySet<string> = new Set(['AI_PROVIDER_AUTH_FAILED', 'AI_PROVIDER_RATE_LIMITED']);

/** Structural on `code`, so a second module instance of `@noodara/ai` still classifies. */
export function classifyValidationError(error: unknown): KeyValidationFailureCode {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && PASSTHROUGH_CODES.has(code)
    ? (code as KeyValidationFailureCode)
    : 'AI_PROVIDER_UNAVAILABLE';
}

export function createProviderKeyValidator(options: ProviderKeyValidatorOptions = {}): ProviderKeyValidator {
  return async (input) => {
    try {
      const { createAIProvider } = await import('@noodara/ai');
      const provider = createAIProvider({
        id: input.provider,
        apiKey: input.apiKey,
        model: input.model,
        limits: { ...VALIDATION_CALL_LIMITS, ...options.limits },
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      await provider.chat({
        messages: [{ role: 'user', content: VALIDATION_PROMPT }],
        maxTokens: VALIDATION_MAX_TOKENS,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: classifyValidationError(error) };
    }
  };
}
