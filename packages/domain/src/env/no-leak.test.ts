// H4: every named error from the env module carries only the key, the reference name, the byte
// length and the offending character class. A canary value goes through every error path and
// must not appear in the code, the message or any field.
import { describe, expect, it } from 'vitest';
import { renderEnvFile } from './env-file.js';
import {
  MAX_ENV_KEY_LENGTH,
  MAX_ENV_VALUE_BYTES,
  MAX_SECRET_NAME_LENGTH,
  parseEnvValue,
  validateEnvKey,
  validateEnvValue,
  validateSecretName,
} from './env-value.js';
import { resolveEnv, resolveSecretRefs } from './resolve-env.js';

const CANARY = 'nd-canary-7f3a9c';
const CANARY_KEY = 'CANARY_7F3A9C';
const CANARY_NAME = 'canary_7f3a9c';

function assertNoCanary(result: unknown, label: string): void {
  expect(result, label).toMatchObject({ ok: false });
  const text = JSON.stringify(result).toLowerCase();
  for (const canary of [CANARY, CANARY_KEY, CANARY_NAME]) {
    expect(text, label).not.toContain(canary.toLowerCase());
  }
}

describe('env errors never carry the value (H4)', () => {
  it('validateEnvKey', () => {
    assertNoCanary(validateEnvKey(CANARY), 'invalid key');
    assertNoCanary(validateEnvKey(`${CANARY_KEY} X`), 'whitespace key');
    assertNoCanary(validateEnvKey(CANARY_KEY.repeat(MAX_ENV_KEY_LENGTH)), 'long key');
  });

  it('validateEnvValue', () => {
    for (const value of [
      `${CANARY}\n${CANARY}`,
      `${CANARY}\r`,
      `${CANARY}\u0000`,
      `${CANARY}\uD800`,
      CANARY.repeat(Math.ceil(MAX_ENV_VALUE_BYTES / CANARY.length) + 1),
    ]) {
      assertNoCanary(validateEnvValue(value), JSON.stringify(value.slice(0, 30)));
      assertNoCanary(validateEnvValue(value, CANARY), 'invalid key context');
    }
  });

  it('validateSecretName', () => {
    assertNoCanary(validateSecretName(CANARY), 'invalid name');
    assertNoCanary(validateSecretName(CANARY_NAME.repeat(MAX_SECRET_NAME_LENGTH)), 'long name');
  });

  it('parseEnvValue', () => {
    for (const value of [
      `<secret:${CANARY}>`,
      `<secret:${CANARY_NAME}> `,
      `<secret:${CANARY_NAME}>${CANARY}`,
      `${CANARY}<secret:x>`,
      `<secret:${CANARY_KEY}>`,
      `<secret: ${CANARY_NAME}>`,
      `${CANARY}\n`,
    ]) {
      assertNoCanary(parseEnvValue(value), value);
    }
  });

  it('resolveSecretRefs', () => {
    const resolved = resolveEnv(
      [{ key: 'PLAIN', value: { kind: 'plain', value: CANARY } }],
      [],
      [{ key: 'MISSING', value: { kind: 'secret_ref', name: 'missing' } }],
    );
    assertNoCanary(resolveSecretRefs(resolved, {}), 'unresolved');
  });

  it('renderEnvFile', () => {
    const big = 'a'.repeat(MAX_ENV_VALUE_BYTES - CANARY.length) + CANARY;
    const cases: { key: string; value: string }[][] = [
      [{ key: 'A', value: `${CANARY}\n` }],
      [{ key: 'A', value: `${CANARY}\u0000` }],
      [{ key: 'A', value: `${CANARY}\uDC00` }],
      [{ key: 'A', value: CANARY.repeat(MAX_ENV_VALUE_BYTES) }],
      [{ key: CANARY, value: CANARY }],
      [
        { key: 'A', value: CANARY },
        { key: 'A', value: CANARY },
      ],
      Array.from({ length: 40 }, (_, i) => ({ key: `K${i.toString()}`, value: big })),
    ];
    for (const entries of cases) {
      assertNoCanary(renderEnvFile(entries), `${entries.length.toString()} entries`);
    }
  });
});
