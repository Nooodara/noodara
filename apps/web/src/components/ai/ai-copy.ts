// 30-04: fixed copy for the AI chat and settings. Model output never reaches these strings; they
// are chosen by code (diagnosis, error code, settings reason) only.
import type { Tone } from '@noodara/ui';
import { V05_ERROR_MESSAGES, type AiFailure, type Diagnosis, type V05ServiceErrorCode } from '../../lib/api/ai-api';

export const DIAGNOSIS_LABELS: Readonly<Record<Diagnosis, string>> = Object.freeze({
  container_stopped: 'Container stopped',
  crash_loop: 'Crash loop',
  out_of_memory: 'Out of memory',
  healthcheck_timeout: 'Healthcheck timeout',
  port_not_responding: 'Port not responding',
  failed_deployment: 'Failed deployment',
  high_memory: 'High memory',
  high_disk: 'High disk usage',
  server_unreachable: 'Server unreachable',
  unknown: 'Unknown',
});

export function diagnosisTone(diagnosis: Diagnosis): Tone {
  if (diagnosis === 'unknown') return 'idle';
  if (diagnosis === 'high_memory' || diagnosis === 'high_disk') return 'warn';
  return 'error';
}

export function confidenceLabel(confidence: number): string {
  const percent = Math.round(Math.min(1, Math.max(0, confidence)) * 100);
  const word = percent >= 75 ? 'High' : percent >= 40 ? 'Medium' : 'Low';
  return `${word} confidence · ${String(percent)}%`;
}

export type AiErrorAction = 'settings' | 'retry' | null;

export interface AiErrorCopy {
  readonly message: string;
  readonly action: AiErrorAction;
}

const V05_ACTIONS: Readonly<Record<V05ServiceErrorCode, AiErrorAction>> = Object.freeze({
  METRICS_UNAVAILABLE: 'retry',
  LOG_SOURCE_UNAVAILABLE: 'retry',
  LOG_QUERY_INVALID: null,
  AI_PROVIDER_NOT_CONFIGURED: 'settings',
  AI_PROVIDER_AUTH_FAILED: 'settings',
  AI_PROVIDER_UNAVAILABLE: 'retry',
  AI_PROVIDER_RATE_LIMITED: 'retry',
  AI_BUDGET_EXCEEDED: null,
  AI_TOOL_NOT_ALLOWED: null,
});

function isV05Code(code: string): code is V05ServiceErrorCode {
  return Object.prototype.hasOwnProperty.call(V05_ERROR_MESSAGES, code);
}

/** Copy for an error event's code (the stream) or 'INTERNAL_ERROR'. */
export function askErrorCopy(code: string): AiErrorCopy {
  if (isV05Code(code)) return { message: V05_ERROR_MESSAGES[code], action: V05_ACTIONS[code] };
  return { message: 'Something went wrong while answering. Try again.', action: 'retry' };
}

/** Copy for a failed request (the POST itself, before any stream). */
export function askFailureCopy(failure: AiFailure): AiErrorCopy {
  if (isV05Code(failure.code)) return askErrorCopy(failure.code);
  switch (failure.code) {
    case 'RATE_LIMITED':
      return { message: 'Too many questions. Wait a moment and try again.', action: 'retry' };
    case 'UNAUTHORIZED':
      return { message: 'Your session has ended. Sign in again to keep asking.', action: null };
    case 'NETWORK_ERROR':
      return { message: "Couldn't reach Noodara. Check your connection and try again.", action: 'retry' };
    default:
      // Named conversation errors (busy, not found) arrive with their own fixed server copy.
      return { message: failure.message, action: 'retry' };
  }
}

/** Copy for a failed key test (PUT /api/settings/ai). Never quotes the key. */
export function settingsFailureCopy(failure: AiFailure): string {
  switch (failure.reason) {
    case 'too_short':
      return 'This key is too short. Paste the whole key.';
    case 'too_long':
      return 'This key is too long. Paste only the key.';
    case 'invalid_characters':
      return 'This key has characters an API key cannot have. Paste it again.';
    case 'model_not_allowed':
      return 'This model is not available. Pick another one.';
    default:
      break;
  }
  switch (failure.code) {
    case 'AI_PROVIDER_AUTH_FAILED':
      return 'The provider rejected this key. Check that it is active and paste it again.';
    case 'AI_PROVIDER_UNAVAILABLE':
      return 'The provider is not responding, so the key could not be tested. Try again in a few minutes.';
    case 'AI_PROVIDER_RATE_LIMITED':
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a moment and test the key again.';
    case 'NETWORK_ERROR':
      return "Couldn't reach Noodara. Check your connection and try again.";
    case 'VALIDATION_FAILED':
      return 'Pick a provider and a model, and paste a key.';
    default:
      return 'The key could not be saved. Try again.';
  }
}
