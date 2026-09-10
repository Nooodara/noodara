import { describe, expect, it } from 'vitest';
import { createRedactor } from './redactor.js';

describe('createRedactor', () => {
  it('replaces an exact registered value with its typed marker', () => {
    const redactor = createRedactor();
    redactor.register('hunter2hunter2', 'ssh_password');
    expect(redactor.redact('password is hunter2hunter2 today')).toBe(
      'password is [REDACTED:ssh_password] today',
    );
  });

  it('replaces the base64-encoded form of a registered value', () => {
    const redactor = createRedactor();
    const raw = 'super-secret-value';
    redactor.register(raw, 'api_key');
    const encoded = Buffer.from(raw, 'utf8').toString('base64');
    expect(redactor.redact(`payload=${encoded}`)).toBe('payload=[REDACTED:api_key]');
  });

  it('replaces the URL-encoded form of a registered value', () => {
    const redactor = createRedactor();
    const raw = 'p@ss word/with special+chars';
    redactor.register(raw, 'ssh_password');
    const encoded = encodeURIComponent(raw);
    expect(redactor.redact(`?pw=${encoded}`)).toBe('?pw=[REDACTED:ssh_password]');
  });

  it('redacts a PEM private key block regardless of registration', () => {
    const redactor = createRedactor();
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\ndef456\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactor.redact(`key:\n${pem}\ndone`)).toBe('key:\n[REDACTED:private_key]\ndone');
  });

  it('redacts a ghp_ GitHub token regardless of registration', () => {
    const redactor = createRedactor();
    expect(redactor.redact('token=ghp_abcdefghijklmnopqrstuvwxyz012345')).toBe(
      'token=[REDACTED:token]',
    );
  });

  it('redacts a sk- style token regardless of registration', () => {
    const redactor = createRedactor();
    expect(redactor.redact('key=sk-abcdefghijklmnopqrstuvwxyz')).toBe('key=[REDACTED:token]');
  });

  it('redacts an AKIA AWS access key id regardless of registration', () => {
    const redactor = createRedactor();
    expect(redactor.redact('id=AKIAABCDEFGHIJKLMNOP')).toBe('id=[REDACTED:token]');
  });

  it('redacts only the password segment of a postgres:// URL', () => {
    const redactor = createRedactor();
    const input = 'DATABASE_URL=postgres://appuser:sup3rSecret@db.internal:5432/app';
    expect(redactor.redact(input)).toBe(
      'DATABASE_URL=postgres://appuser:[REDACTED:password]@db.internal:5432/app',
    );
  });

  it('redacts an Authorization: Bearer header value', () => {
    const redactor = createRedactor();
    expect(redactor.redact('Authorization: Bearer abc.def.ghi-JWT')).toBe(
      'Authorization: Bearer [REDACTED:token]',
    );
  });

  it('applies structural patterns even when nothing was registered', () => {
    const redactor = createRedactor();
    expect(redactor.redact('AKIAABCDEFGHIJKLMNOP')).toBe('[REDACTED:token]');
  });

  it('walks plain objects and arrays recursively, leaving non-string leaves untouched', () => {
    const redactor = createRedactor();
    redactor.register('inner-secret', 'ssh_password');
    const input = {
      name: 'server-1',
      port: 22,
      enabled: true,
      tags: ['prod', 'inner-secret'],
      nested: { note: 'has inner-secret inside' },
    };
    const output = redactor.redact(input);
    expect(output).toEqual({
      name: 'server-1',
      port: 22,
      enabled: true,
      tags: ['prod', '[REDACTED:ssh_password]'],
      nested: { note: 'has [REDACTED:ssh_password] inside' },
    });
  });

  it('release(value) removes the value from the live registry', () => {
    const redactor = createRedactor();
    redactor.register('temp-secret', 'session_secret');
    expect(redactor.redact('has temp-secret in it')).toBe('has [REDACTED:session_secret] in it');
    redactor.release('temp-secret');
    expect(redactor.redact('has temp-secret in it')).toBe('has temp-secret in it');
  });

  it('escapes regex metacharacters in a registered secret', () => {
    const redactor = createRedactor();
    const tricky = 'a.b*c+d?e(f)g[h]';
    redactor.register(tricky, 'api_key');
    expect(redactor.redact(`value=${tricky}`)).toBe('value=[REDACTED:api_key]');
  });

  it('sorts registered values longest-first so a short secret substring leaves no fragment', () => {
    const redactor = createRedactor();
    redactor.register('abc', 'session_secret');
    redactor.register('abcdef', 'api_key');
    const output = redactor.redact('first abcdef then abc alone');
    expect(output.match(/\[REDACTED:/g)).toHaveLength(2);
    expect(output).not.toContain('def');
  });

  it('createRedactor returns an independent registry per instance', () => {
    const a = createRedactor();
    const b = createRedactor();
    a.register('only-in-a', 'session_secret');
    expect(a.redact('only-in-a')).toBe('[REDACTED:session_secret]');
    expect(b.redact('only-in-a')).toBe('only-in-a');
  });

  it('redacts a 1 MB string with 50 registered values in under 50ms', () => {
    const redactor = createRedactor();
    const secrets: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const value = `secret-value-number-${i}-${'x'.repeat(20)}`;
      secrets.push(value);
      redactor.register(value, 'api_key');
    }

    const chunks: string[] = [];
    let size = 0;
    let i = 0;
    while (size < 1_000_000) {
      const useSecret = i % 7 === 0;
      const filler = useSecret ? (secrets[i % secrets.length] ?? '') : `filler-text-${i}-`;
      chunks.push(filler);
      size += filler.length;
      i += 1;
    }
    const input = chunks.join(' ');

    const start = performance.now();
    redactor.redact(input);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(50);
  });
});
