import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createRedactor } from './redactor.js';
import { revealSecret, secretValue, type SecretKind } from './secret-value.js';

describe('secretValue', () => {
  it('toString() returns the redacted marker carrying the kind', () => {
    const secret = secretValue('hunter2hunter2', 'ssh_password');
    expect(secret.toString()).toBe('[REDACTED:ssh_password]');
  });

  it('String(secret) uses the redacted form', () => {
    const secret = secretValue('hunter2hunter2', 'ssh_password');
    expect(String(secret)).toBe('[REDACTED:ssh_password]');
  });

  it('template interpolation yields the redacted form, never the raw value', () => {
    const secret = secretValue('hunter2hunter2', 'ssh_password');
    const line = `password=${secret.toString()}`;
    expect(line).toBe('password=[REDACTED:ssh_password]');
    expect(line).not.toContain('hunter2hunter2');
  });

  it('JSON.stringify of a containing object never contains the raw value', () => {
    const secret = secretValue('-----BEGIN RAW PRIVATE MATERIAL-----', 'ssh_private_key');
    const json = JSON.stringify({ credential: secret });
    expect(json).toContain('[REDACTED:ssh_private_key]');
    expect(json).not.toContain('RAW PRIVATE MATERIAL');
  });

  it('util.inspect of a containing object never contains the raw value', () => {
    const secret = secretValue('do-not-leak-this-value', 'api_key');
    const inspected = inspect({ credential: secret });
    expect(inspected).toContain('[REDACTED:api_key]');
    expect(inspected).not.toContain('do-not-leak-this-value');
  });

  it('implements the nodejs.util.inspect.custom symbol directly on the instance', () => {
    const secret = secretValue('x', 'master_key');
    const inspectCustom = (secret as unknown as Record<symbol, unknown>)[
      Symbol.for('nodejs.util.inspect.custom')
    ];
    expect(typeof inspectCustom).toBe('function');
  });

  it('revealSecret is the only way to obtain the raw string', () => {
    const secret = secretValue('the-actual-raw-value', 'session_secret');
    expect(revealSecret(secret)).toBe('the-actual-raw-value');
  });

  it('revealSecret registers the revealed value with a provided redactor', () => {
    const redactor = createRedactor();
    const secret = secretValue('reveal-me-please-9000', 'setup_token');
    const raw = revealSecret(secret, redactor);
    expect(raw).toBe('reveal-me-please-9000');
    expect(redactor.redact(`issued token was ${raw}`)).toBe(
      'issued token was [REDACTED:setup_token]',
    );
  });

  it('revealSecret without a redactor does not throw and still returns the raw value', () => {
    const secret = secretValue('no-redactor-needed', 'api_key');
    expect(revealSecret(secret)).toBe('no-redactor-needed');
  });

  it('supports every declared SecretKind', () => {
    const kinds: SecretKind[] = [
      'ssh_password',
      'ssh_private_key',
      'master_key',
      'session_secret',
      'setup_token',
      'api_key',
    ];
    for (const kind of kinds) {
      const secret = secretValue('v', kind);
      expect(secret.toString()).toBe(`[REDACTED:${kind}]`);
      expect(secret.kind).toBe(kind);
    }
  });
});
