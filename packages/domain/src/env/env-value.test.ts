import { describe, expect, it } from 'vitest';
import {
  MAX_ENV_KEY_LENGTH,
  MAX_ENV_VALUE_BYTES,
  MAX_ENV_VARS_PER_SCOPE,
  MAX_SECRETS_PER_SCOPE,
  MAX_SECRET_NAME_LENGTH,
  parseEnvValue,
  utf8ByteLength,
  validateEnvKey,
  validateEnvValue,
  validateSecretName,
} from './env-value.js';

describe('env limits (A5)', () => {
  it('exports the per-scope caps and field limits', () => {
    expect(MAX_ENV_VARS_PER_SCOPE).toBe(200);
    expect(MAX_SECRETS_PER_SCOPE).toBe(100);
    expect(MAX_ENV_KEY_LENGTH).toBe(128);
    expect(MAX_ENV_VALUE_BYTES).toBe(32 * 1024);
    expect(MAX_SECRET_NAME_LENGTH).toBe(64);
  });
});

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes per code point', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('ñ')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    // A lone surrogate is counted as its U+FFFD replacement.
    expect(utf8ByteLength('\uD800')).toBe(3);
    expect(utf8ByteLength('\uDC00')).toBe(3);
    expect(utf8ByteLength('\uD800a')).toBe(4);
    expect(utf8ByteLength('\uD800\uE000')).toBe(6);
    expect(utf8ByteLength('a😀b')).toBe(6);
  });
});

describe('validateEnvKey (A1)', () => {
  it.each(['A', '_', 'DATABASE_URL', '_PRIVATE', 'A1_B2', 'X'.repeat(MAX_ENV_KEY_LENGTH)])(
    'accepts %s',
    (key) => {
      expect(validateEnvKey(key)).toEqual({ ok: true, value: key });
    },
  );

  it('rejects an empty key', () => {
    expect(validateEnvKey('')).toMatchObject({ ok: false, code: 'ENV_KEY_REQUIRED' });
  });

  it('rejects a key over 128 characters with its byte length', () => {
    const result = validateEnvKey('X'.repeat(MAX_ENV_KEY_LENGTH + 1));
    expect(result).toMatchObject({ ok: false, code: 'ENV_KEY_TOO_LONG', byteLength: 129 });
  });

  it.each([
    ['1ABC', 'leading_digit'],
    ['database_url', 'lowercase'],
    ['MY KEY', 'whitespace'],
    ['A\tB', 'whitespace'],
    ['A\u0001', 'control'],
    ['A=B', 'symbol'],
    ['A-B', 'symbol'],
    ['ÑAME', 'non_ascii'],
  ])('rejects %j as %s', (key, characterClass) => {
    expect(validateEnvKey(key)).toMatchObject({
      ok: false,
      code: 'ENV_KEY_INVALID',
      characterClass,
    });
  });
});

describe('validateEnvValue (A1)', () => {
  it.each(['', 'plain', '  spaced  ', 'a=b=c', '"quoted"', "'single'", 'a #b', 'tab\there', 'ñ€😀'])(
    'accepts %j',
    (value) => {
      expect(validateEnvValue(value)).toEqual({ ok: true, value });
    },
  );

  it.each([
    ['a\nb', 'newline'],
    ['a\rb', 'carriage_return'],
    ['a\r\nb', 'carriage_return'],
    ['a\u0000b', 'nul'],
  ])('rejects %j as ENV_VALUE_MULTILINE (%s) with the base64 hint', (value, characterClass) => {
    const result = validateEnvValue(value);
    expect(result).toMatchObject({ ok: false, code: 'ENV_VALUE_MULTILINE', characterClass });
    expect(result.ok ? '' : result.message).toMatch(/base64/);
  });

  it('rejects a lone surrogate that UTF-8 cannot carry', () => {
    expect(validateEnvValue('a\uD800b')).toMatchObject({
      ok: false,
      code: 'ENV_VALUE_INVALID_UTF8',
      characterClass: 'lone_surrogate',
    });
    expect(validateEnvValue('a\uDC00')).toMatchObject({ ok: false, code: 'ENV_VALUE_INVALID_UTF8' });
  });

  it('accepts exactly 32 KiB and rejects one byte more', () => {
    expect(validateEnvValue('a'.repeat(MAX_ENV_VALUE_BYTES)).ok).toBe(true);
    expect(validateEnvValue('a'.repeat(MAX_ENV_VALUE_BYTES + 1))).toMatchObject({
      ok: false,
      code: 'ENV_VALUE_TOO_LARGE',
      byteLength: MAX_ENV_VALUE_BYTES + 1,
    });
    // Multi-byte characters count by bytes, not UTF-16 units.
    expect(validateEnvValue('€'.repeat(11_000))).toMatchObject({ code: 'ENV_VALUE_TOO_LARGE' });
  });

  it('names the key when a valid one is given, and drops an invalid key', () => {
    expect(validateEnvValue('a\nb', 'DATABASE_URL')).toMatchObject({ key: 'DATABASE_URL' });
    const invalid = validateEnvValue('a\nb', 'not valid');
    expect(invalid).not.toHaveProperty('key');
  });
});

describe('validateSecretName (A1)', () => {
  it.each(['a', 'db_password', 'a1', 'a'.repeat(MAX_SECRET_NAME_LENGTH)])('accepts %s', (name) => {
    expect(validateSecretName(name)).toEqual({ ok: true, value: name });
  });

  it('rejects empty and over-long names', () => {
    expect(validateSecretName('')).toMatchObject({ ok: false, code: 'SECRET_NAME_REQUIRED' });
    expect(validateSecretName('a'.repeat(MAX_SECRET_NAME_LENGTH + 1))).toMatchObject({
      ok: false,
      code: 'SECRET_NAME_TOO_LONG',
      byteLength: 65,
    });
  });

  it.each([
    ['1abc', 'leading_non_letter'],
    ['_abc', 'leading_non_letter'],
    ['dbPassword', 'uppercase'],
    ['db password', 'whitespace'],
    ['db-password', 'symbol'],
    ['../x', 'leading_non_letter'],
    ['a/b', 'symbol'],
    ['añ', 'non_ascii'],
    ['a\u0007', 'control'],
  ])('rejects %j as %s', (name, characterClass) => {
    expect(validateSecretName(name)).toMatchObject({
      ok: false,
      code: 'SECRET_NAME_INVALID',
      characterClass,
    });
  });
});

describe('parseEnvValue (A1, H2)', () => {
  it('classifies the whole-string form <secret:name> as a reference', () => {
    expect(parseEnvValue('<secret:db_password>')).toEqual({
      ok: true,
      value: { kind: 'secret_ref', name: 'db_password' },
    });
  });

  it.each(['', 'plain', 'secret:db', '<notsecret>', 'a <b> c', '<secretx>', 'secret:db>'])(
    'classifies %j as plain',
    (value) => {
      expect(parseEnvValue(value)).toEqual({ ok: true, value: { kind: 'plain', value } });
    },
  );

  it.each([
    '<secret:>',
    '<secret:../x>',
    '<secret:Name>',
    '<secret: db>',
    '<secret:db >',
    ' <secret:db>',
    '<secret:db> ',
    '<secret:db>x',
    'postgres://u:<secret:pw>@host/db',
    '<secret:db',
    '<SECRET:db>',
    '<Secret:db>',
    '< secret:db>',
    '<secret :db>',
    `<secret:${'a'.repeat(65)}>`,
    '<secret:a><secret:b>',
  ])('returns ENV_SECRET_REF_MALFORMED for %j, never plain', (value) => {
    const result = parseEnvValue(value);
    expect(result).toMatchObject({ ok: false, code: 'ENV_SECRET_REF_MALFORMED' });
    expect(result).not.toHaveProperty('reference');
  });

  it('validates the value before classifying it', () => {
    expect(parseEnvValue('<secret:db>\n')).toMatchObject({ ok: false, code: 'ENV_VALUE_MULTILINE' });
    expect(parseEnvValue('a'.repeat(MAX_ENV_VALUE_BYTES + 1))).toMatchObject({
      ok: false,
      code: 'ENV_VALUE_TOO_LARGE',
    });
  });

  it('names a valid key in a malformed-reference error', () => {
    expect(parseEnvValue('<secret:>', 'API_KEY')).toMatchObject({
      code: 'ENV_SECRET_REF_MALFORMED',
      key: 'API_KEY',
    });
  });
});
