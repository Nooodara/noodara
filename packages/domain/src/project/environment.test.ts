import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ENVIRONMENT_NAME_SUGGESTIONS,
  type EnvironmentName,
  isSuggestedEnvironmentName,
  validateEnvironmentCreateInput,
  validateEnvironmentName,
} from './environment.js';

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

describe('ENVIRONMENT_NAME_SUGGESTIONS', () => {
  it('suggests production, staging and development in that order', () => {
    expect(ENVIRONMENT_NAME_SUGGESTIONS).toEqual(['production', 'staging', 'development']);
  });
});

describe('validateEnvironmentName', () => {
  it.each([...ENVIRONMENT_NAME_SUGGESTIONS, 'qa', 'preview-42', 'eu-west-1', '0', 'x'.repeat(63)])(
    'accepts %j',
    (name) => {
      expect(validateEnvironmentName(name)).toEqual({ ok: true, value: name });
    },
  );

  it.each([
    '',
    'Production',
    '-staging',
    'staging-',
    'a b',
    'a_b',
    'a/b',
    '../prod',
    'prod\n',
    'prod\u0000',
    'x'.repeat(64),
    42,
    null,
  ])('rejects %j with ENVIRONMENT_NAME_INVALID', (name) => {
    expect(codeOf(validateEnvironmentName(name))).toBe('ENVIRONMENT_NAME_INVALID');
  });

  it('keeps the name free text: the branded type is a string, not a union of suggestions (D23)', () => {
    expectTypeOf<EnvironmentName>().toExtend<string>();
    expectTypeOf<'qa'>().not.toExtend<(typeof ENVIRONMENT_NAME_SUGGESTIONS)[number]>();
    const result = validateEnvironmentName('qa');

    expect(result.ok).toBe(true);
  });
});

describe('isSuggestedEnvironmentName', () => {
  it('is true only for the three suggestions', () => {
    expect(ENVIRONMENT_NAME_SUGGESTIONS.every(isSuggestedEnvironmentName)).toBe(true);
    expect(isSuggestedEnvironmentName('qa')).toBe(false);
    expect(isSuggestedEnvironmentName('Production')).toBe(false);
  });
});

describe('validateEnvironmentCreateInput', () => {
  it('returns the validated name', () => {
    expect(validateEnvironmentCreateInput({ name: 'staging' })).toEqual({
      ok: true,
      value: { name: 'staging' },
    });
  });

  it.each([null, 'staging', [], 3])('rejects %j with ENVIRONMENT_INPUT_INVALID', (input) => {
    expect(codeOf(validateEnvironmentCreateInput(input))).toBe('ENVIRONMENT_INPUT_INVALID');
  });

  it.each(['kind', 'projectId', 'env', 'variables'])(
    'rejects the unsupported field %s by name',
    (key) => {
      const result = validateEnvironmentCreateInput({ name: 'qa', [key]: 'x' });

      expect(codeOf(result)).toBe('ENVIRONMENT_INPUT_UNSUPPORTED_FIELD');
      expect(!result.ok && result.message).toContain(key);
    },
  );

  it('passes the name validator code through', () => {
    expect(codeOf(validateEnvironmentCreateInput({ name: 'QA' }))).toBe('ENVIRONMENT_NAME_INVALID');
    expect(codeOf(validateEnvironmentCreateInput({}))).toBe('ENVIRONMENT_NAME_INVALID');
  });
});
