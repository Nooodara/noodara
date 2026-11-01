import { describe, expect, it } from 'vitest';
import {
  checkSecretName,
  checkSecretValue,
  checkVariableInput,
  checkVariableValue,
  ENV_GENERIC_FAILURE_COPY,
  envErrorCopy,
  envFailureCopy,
  MAX_SECRET_VALUE_CHARS,
  scopeLabel,
  secretReference,
  secretRefName,
} from './env-form';

const failure = (code: string, reason?: string) =>
  ({ ok: false, code, message: 'raw server text', unauthorized: false, ...(reason === undefined ? {} : { reason }) }) as never;

describe('env-form', () => {
  it('labels known scopes and falls back for unknown ones', () => {
    expect(scopeLabel('project')).toBe('Project');
    expect(scopeLabel('environment')).toBe('Environment');
    expect(scopeLabel('service')).toBe('Service');
    expect(scopeLabel('organization')).toBe('Other');
    expect(scopeLabel('__proto__')).toBe('Other');
    expect(scopeLabel('')).toBe('Other');
  });

  it('checks a variable with the shared validators and trims the key', () => {
    expect(checkVariableInput('  DATABASE_URL ', 'postgres://x')).toEqual({ ok: true, key: 'DATABASE_URL', value: 'postgres://x' });
    expect(checkVariableInput('', 'x')).toMatchObject({ ok: false, field: 'key', message: 'Enter a variable name.' });
    expect(checkVariableInput('1BAD', 'x')).toMatchObject({ ok: false, field: 'key' });
    expect(checkVariableInput('lower', 'x')).toMatchObject({ ok: false, field: 'key' });
    expect(checkVariableInput('OK', 'a\nb')).toMatchObject({ ok: false, field: 'value', message: 'Values must be a single line.' });
    expect(checkVariableInput('OK', '<secret:Bad Name>')).toMatchObject({ ok: false, field: 'value' });
    expect(checkVariableInput('OK', '<secret:db_password>')).toEqual({ ok: true, key: 'OK', value: '<secret:db_password>' });
  });

  it('checks an edited value alone', () => {
    expect(checkVariableValue('plain')).toEqual({ ok: true, value: 'plain' });
    expect(checkVariableValue('a\r\nb')).toMatchObject({ ok: false, field: 'value' });
  });

  it('checks a secret name and value without echoing the value', () => {
    expect(checkSecretName(' db_password ')).toEqual({ ok: true, name: 'db_password' });
    expect(checkSecretName('')).toMatchObject({ ok: false, field: 'name' });
    expect(checkSecretName('Bad-Name')).toMatchObject({ ok: false, field: 'name' });
    expect(checkSecretValue('')).toMatchObject({ ok: false, field: 'value' });
    expect(checkSecretValue('s3cret')).toEqual({ ok: true, value: 's3cret' });
    const multi = checkSecretValue('CANARY\nline');
    expect(multi).toMatchObject({ ok: false, field: 'value' });
    expect(JSON.stringify(multi)).not.toContain('CANARY');
    expect(checkSecretValue('x'.repeat(MAX_SECRET_VALUE_CHARS + 1))).toMatchObject({ ok: false, field: 'value' });
  });

  it('reads secret references', () => {
    expect(secretRefName('<secret:db_password>')).toBe('db_password');
    expect(secretRefName('plain')).toBeNull();
    expect(secretRefName('<secret:Bad>')).toBeNull();
    expect(secretReference('db_password')).toBe('<secret:db_password>');
  });

  it('maps failures to fixed copy, never server text', () => {
    expect(envFailureCopy(failure('ENV_KEY_DUPLICATE'))).toBe('This scope already has a variable with this name.');
    expect(envFailureCopy(failure('SECRET_IN_USE'))).toContain('still referenced');
    expect(envFailureCopy(failure('VALIDATION_FAILED', 'ENV_KEY_INVALID'))).toBe(envErrorCopy('ENV_KEY_INVALID'));
    expect(envFailureCopy(failure('VALIDATION_FAILED', 'SOMETHING_ELSE'))).toBe(ENV_GENERIC_FAILURE_COPY);
    expect(envFailureCopy(failure('INTERNAL_ERROR'))).toBe(ENV_GENERIC_FAILURE_COPY);
    expect(envErrorCopy('toString')).toBeNull();
  });
});
