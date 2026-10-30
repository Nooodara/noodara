import { describe, expect, it } from 'vitest';
import {
  MAX_ENV_FILE_BYTES,
  MAX_ENV_FILE_LINE_BYTES,
  renderEnvFile,
} from './env-file.js';
import {
  MAX_ENV_KEY_LENGTH,
  MAX_ENV_VALUE_BYTES,
  MAX_ENV_VARS_PER_SCOPE,
} from './env-value.js';

describe('env-file limits (H3)', () => {
  it('keeps the measured 65,535-byte line limit (ADR 0011 A4)', () => {
    expect(MAX_ENV_FILE_LINE_BYTES).toBe(65_535);
  });

  it('a maximal KEY=VALUE line fits under the measured line limit', () => {
    expect(MAX_ENV_KEY_LENGTH + 1 + MAX_ENV_VALUE_BYTES).toBeLessThan(MAX_ENV_FILE_LINE_BYTES);
  });

  it('derives the aggregate cap from the line limit: 16 maximal lines, 1 MiB', () => {
    expect(MAX_ENV_FILE_BYTES).toBe(16 * (MAX_ENV_FILE_LINE_BYTES + 1));
    expect(MAX_ENV_FILE_BYTES).toBe(1024 * 1024);
  });
});

describe('renderEnvFile (A4)', () => {
  it('renders an empty list as an empty file', () => {
    expect(renderEnvFile([])).toEqual({ ok: true, value: '' });
  });

  it('emits KEY=VALUE lines sorted by key, each newline-terminated, values unquoted', () => {
    const result = renderEnvFile([
      { key: 'Z', value: 'last' },
      { key: 'A', value: 'first' },
      { key: 'A_B', value: 'third' },
      { key: 'AB', value: 'second' },
    ]);
    expect(result).toEqual({ ok: true, value: 'A=first\nAB=second\nA_B=third\nZ=last\n' });
  });

  it('carries =, quotes, spaces, # and empty values literally (measured docker semantics)', () => {
    const result = renderEnvFile([
      { key: 'EQ', value: 'a=b=c' },
      { key: 'QUOTED', value: '"a b"' },
      { key: 'SINGLE', value: "'x'" },
      { key: 'SPACEVAL', value: '  v ' },
      { key: 'HASH', value: 'a #b' },
      { key: 'LEADING_HASH', value: '#not-a-comment' },
      { key: 'BACKSLASH', value: 'a\\nb' },
      { key: 'EMPTY', value: '' },
    ]);
    expect(result).toEqual({
      ok: true,
      value: [
        'BACKSLASH=a\\nb',
        'EMPTY=',
        'EQ=a=b=c',
        'HASH=a #b',
        'LEADING_HASH=#not-a-comment',
        'QUOTED="a b"',
        'SINGLE=\'x\'',
        'SPACEVAL=  v ',
        '',
      ].join('\n'),
    });
  });

  it.each([
    ['a\nb', 'newline'],
    ['a\rb', 'carriage_return'],
    ['a\u0000b', 'nul'],
  ])('rejects a value docker --env-file cannot carry: %j', (value, characterClass) => {
    expect(renderEnvFile([{ key: 'ML', value }])).toMatchObject({
      ok: false,
      code: 'ENV_VALUE_MULTILINE',
      key: 'ML',
      characterClass,
    });
  });

  it('rejects an over-sized value and a lone surrogate', () => {
    expect(renderEnvFile([{ key: 'BIG', value: 'a'.repeat(MAX_ENV_VALUE_BYTES + 1) }])).toMatchObject({
      code: 'ENV_VALUE_TOO_LARGE',
      key: 'BIG',
    });
    expect(renderEnvFile([{ key: 'U', value: '\uD800' }])).toMatchObject({
      code: 'ENV_VALUE_INVALID_UTF8',
      key: 'U',
    });
  });

  it('rejects an invalid key without echoing it', () => {
    const result = renderEnvFile([{ key: 'bad key', value: 'v' }]);
    expect(result).toMatchObject({ ok: false, code: 'ENV_KEY_INVALID' });
    expect(result).not.toHaveProperty('key');
  });

  it('rejects a duplicate key (a bare second definition would silently win)', () => {
    expect(
      renderEnvFile([
        { key: 'A', value: '1' },
        { key: 'A', value: '2' },
      ]),
    ).toMatchObject({ ok: false, code: 'ENV_FILE_DUPLICATE_KEY', key: 'A' });
  });

  it('renders three full scopes of small variables', () => {
    const entries = Array.from({ length: MAX_ENV_VARS_PER_SCOPE * 3 }, (_, i) => ({
      key: `K${i.toString().padStart(4, '0')}`,
      value: 'v',
    }));
    const result = renderEnvFile(entries);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.split('\n')).toHaveLength(MAX_ENV_VARS_PER_SCOPE * 3 + 1);
  });

  it('accepts output of exactly MAX_ENV_FILE_BYTES and rejects one byte more (H3)', () => {
    // 32 lines of `Kxx=` + value + `\n`: each line is 4 + v + 1 bytes.
    const lines = 32;
    const perLine = MAX_ENV_FILE_BYTES / lines; // 32 KiB
    const valueBytes = perLine - 5;
    const entries = Array.from({ length: lines }, (_, i) => ({
      key: `K${i.toString().padStart(2, '0')}`,
      value: 'a'.repeat(valueBytes),
    }));
    const exact = renderEnvFile(entries);
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.value.length).toBe(MAX_ENV_FILE_BYTES);

    const over = renderEnvFile([...entries, { key: 'Z', value: '' }]);
    expect(over).toEqual({
      ok: false,
      code: 'ENV_FILE_TOO_LARGE',
      message: expect.any(String) as unknown,
      byteLength: MAX_ENV_FILE_BYTES + 3,
    });
  });

  it('counts the aggregate cap in UTF-8 bytes', () => {
    const value = '€'.repeat(10_000); // 30,000 bytes, 10,000 UTF-16 units
    const entries = Array.from({ length: 40 }, (_, i) => ({ key: `K${i.toString()}`, value }));
    expect(renderEnvFile(entries)).toMatchObject({ ok: false, code: 'ENV_FILE_TOO_LARGE' });
  });
});
