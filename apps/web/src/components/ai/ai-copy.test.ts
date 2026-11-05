import { describe, expect, it } from 'vitest';
import { askErrorCopy, askFailureCopy, confidenceLabel, diagnosisTone, settingsFailureCopy } from './ai-copy';
import type { AiFailure } from '../../lib/api/ai-api';

const failure = (code: string, reason?: string): AiFailure =>
  ({ ok: false, code, message: 'server text', ...(reason === undefined ? {} : { reason }) }) as unknown as AiFailure;

describe('ai-copy', () => {
  it('maps diagnoses to tones', () => {
    expect(diagnosisTone('unknown')).toBe('idle');
    expect(diagnosisTone('high_disk')).toBe('warn');
    expect(diagnosisTone('crash_loop')).toBe('error');
  });

  it('labels confidence with a clamped percent', () => {
    expect(confidenceLabel(0.82)).toBe('High confidence · 82%');
    expect(confidenceLabel(0.5)).toBe('Medium confidence · 50%');
    expect(confidenceLabel(-3)).toBe('Low confidence · 0%');
    expect(confidenceLabel(7)).toBe('High confidence · 100%');
  });

  it('points provider key errors at Settings and transient ones at retry', () => {
    expect(askErrorCopy('AI_PROVIDER_NOT_CONFIGURED').action).toBe('settings');
    expect(askErrorCopy('AI_PROVIDER_AUTH_FAILED').action).toBe('settings');
    expect(askErrorCopy('AI_PROVIDER_UNAVAILABLE').action).toBe('retry');
    expect(askErrorCopy('AI_BUDGET_EXCEEDED').action).toBeNull();
    expect(askErrorCopy('SOMETHING_ELSE')).toEqual({ message: 'Something went wrong while answering. Try again.', action: 'retry' });
  });

  it('gives request failures actionable copy', () => {
    expect(askFailureCopy(failure('AI_PROVIDER_NOT_CONFIGURED')).action).toBe('settings');
    expect(askFailureCopy(failure('RATE_LIMITED')).action).toBe('retry');
    expect(askFailureCopy(failure('UNAUTHORIZED')).action).toBeNull();
    expect(askFailureCopy(failure('NETWORK_ERROR')).message).toMatch(/connection/);
    expect(askFailureCopy(failure('CONVERSATION_BUSY'))).toEqual({ message: 'server text', action: 'retry' });
  });

  it('explains a failed key test by reason, then code, never with server text', () => {
    expect(settingsFailureCopy(failure('VALIDATION_FAILED', 'too_short'))).toMatch(/too short/);
    expect(settingsFailureCopy(failure('VALIDATION_FAILED', 'too_long'))).toMatch(/too long/);
    expect(settingsFailureCopy(failure('VALIDATION_FAILED', 'invalid_characters'))).toMatch(/characters/);
    expect(settingsFailureCopy(failure('VALIDATION_FAILED', 'model_not_allowed'))).toMatch(/model/);
    expect(settingsFailureCopy(failure('AI_PROVIDER_AUTH_FAILED'))).toMatch(/rejected this key/);
    expect(settingsFailureCopy(failure('AI_PROVIDER_UNAVAILABLE'))).toMatch(/not responding/);
    expect(settingsFailureCopy(failure('AI_PROVIDER_RATE_LIMITED'))).toMatch(/Too many/);
    expect(settingsFailureCopy(failure('RATE_LIMITED'))).toMatch(/Too many/);
    expect(settingsFailureCopy(failure('NETWORK_ERROR'))).toMatch(/connection/);
    expect(settingsFailureCopy(failure('VALIDATION_FAILED'))).toMatch(/paste a key/);
    expect(settingsFailureCopy(failure('INTERNAL_ERROR'))).toBe('The key could not be saved. Try again.');
  });
});
