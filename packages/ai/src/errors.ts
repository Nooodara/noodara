import { V05_ERROR_MESSAGES, type V05ServiceErrorCode } from '@noodara/domain/api-contract';

// Normalized provider errors. Messages are the fixed product copy: a vendor message, body,
// header or URL is never copied in (it can quote the key or a prompt), and there is no `cause`.

export type AIProviderErrorCode = Extract<
  V05ServiceErrorCode,
  'AI_PROVIDER_AUTH_FAILED' | 'AI_PROVIDER_RATE_LIMITED' | 'AI_PROVIDER_UNAVAILABLE'
>;

export type AIProviderFailureReason =
  | 'auth'
  | 'forbidden'
  | 'rate_limited'
  | 'server_error'
  | 'bad_request'
  | 'timeout'
  | 'idle_timeout'
  | 'aborted'
  | 'connection'
  | 'malformed'
  | 'too_large'
  | 'unexpected_response'
  | 'unexpected_tool'
  | 'host_mismatch';

export interface AIProviderErrorDetails {
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export class AIProviderError extends Error {
  readonly code: AIProviderErrorCode;
  readonly reason: AIProviderFailureReason;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: AIProviderErrorCode, reason: AIProviderFailureReason, details: AIProviderErrorDetails = {}) {
    super(V05_ERROR_MESSAGES[code]);
    this.name = 'AIProviderError';
    this.code = code;
    this.reason = reason;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** Retried by the call scope: rate limits, 5xx and dropped connections. Never 401/403. */
  get retryable(): boolean {
    return this.reason === 'rate_limited' || this.reason === 'server_error' || this.reason === 'connection';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      reason: this.reason,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      message: this.message,
    };
  }
}

export function unavailable(reason: AIProviderFailureReason, details: AIProviderErrorDetails = {}): AIProviderError {
  return new AIProviderError('AI_PROVIDER_UNAVAILABLE', reason, details);
}

/** Maps an HTTP status from the vendor to a normalized error. */
export function errorForStatus(status: number, retryAfterMs?: number): AIProviderError {
  if (status === 401) return new AIProviderError('AI_PROVIDER_AUTH_FAILED', 'auth', { status });
  if (status === 403) return new AIProviderError('AI_PROVIDER_AUTH_FAILED', 'forbidden', { status });
  if (status === 429) {
    return new AIProviderError(
      'AI_PROVIDER_RATE_LIMITED',
      'rate_limited',
      retryAfterMs === undefined ? { status } : { status, retryAfterMs },
    );
  }
  if (status >= 500) return unavailable('server_error', { status });
  return unavailable('bad_request', { status });
}

export type AIProviderConfigReason =
  | 'unknown_provider'
  | 'not_implemented'
  | 'invalid_base_url'
  | 'base_url_not_allowed'
  | 'invalid_model'
  | 'invalid_request';

/** Misconfiguration found before any network call. Never echoes the offending URL or key. */
export class AIProviderConfigError extends Error {
  readonly code = 'AI_PROVIDER_NOT_CONFIGURED' as const;
  readonly reason: AIProviderConfigReason;

  constructor(reason: AIProviderConfigReason) {
    super(V05_ERROR_MESSAGES.AI_PROVIDER_NOT_CONFIGURED);
    this.name = 'AIProviderConfigError';
    this.reason = reason;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, reason: this.reason, message: this.message };
  }
}
