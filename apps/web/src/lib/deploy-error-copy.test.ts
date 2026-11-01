import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_ERROR_CODES, V04_DEPLOYMENT_ERROR_CODES } from '@noodara/domain/deployment';
import {
  CONTEXT_ERROR_CODES,
  DEPLOYMENT_ERROR_COPY,
  GENERIC_DEPLOYMENT_ERROR_COPY,
  deploymentErrorCopy,
  guardLogTail,
  LOG_TAIL_MAX_CHARS,
  LOG_TAIL_MAX_LINE_CHARS,
  LOG_TAIL_MAX_LINES,
  parseConfigureLog,
} from './deploy-error-copy';

// 21-06: the v0.4 codes are part of DEPLOYMENT_ERROR_CODES (migration 0014).
it('the v0.4 codes are domain deployment error codes', () => {
  expect(DEPLOYMENT_ERROR_CODES).toEqual(expect.arrayContaining([...V04_DEPLOYMENT_ERROR_CODES]));
});

describe('deploymentErrorCopy', () => {
  it.each(DEPLOYMENT_ERROR_CODES.map((code) => [code]))('%s has a title and an actionable recovery', (code) => {
    const copy = deploymentErrorCopy(code);
    expect(copy.title.trim().length).toBeGreaterThan(0);
    expect(copy.recovery.trim().length).toBeGreaterThan(0);
    expect(copy).not.toEqual(GENERIC_DEPLOYMENT_ERROR_COPY);
    // Copy rules: sentence case, no exclamation marks, recovery ends as a sentence.
    expect(copy.title).not.toMatch(/!/);
    expect(copy.recovery).toMatch(/\.$/);
  });

  it('has copy for exactly the domain error codes, so a new code without copy fails here', () => {
    expect(Object.keys(DEPLOYMENT_ERROR_COPY).sort()).toEqual([...DEPLOYMENT_ERROR_CODES].sort());
  });

  it('the v0.3 codes (16-02 A7) have their own titles', () => {
    expect(deploymentErrorCopy('HEALTHCHECK_FAILED').title).toBe('Health check failed');
    expect(deploymentErrorCopy('HEALTHCHECK_TIMEOUT').title).toBe('Health check timed out');
    expect(deploymentErrorCopy('ROLLBACK_FAILED').title).toBe('Rollback failed');
    expect(deploymentErrorCopy('ROLLBACK_TARGET_UNAVAILABLE').title).toBe('Rollback target unavailable');
    expect(deploymentErrorCopy('COMMIT_NOT_FOUND').title).toBe('Commit not found');
  });

  it('the v0.4 codes (21-05) have their own titles', () => {
    expect(deploymentErrorCopy('SECRET_UNRESOLVED').title).toBe('Secret not found');
    expect(deploymentErrorCopy('ENV_INJECTION_FAILED').title).toBe('Variables not written');
    expect(deploymentErrorCopy('PROXY_ROUTE_FAILED').title).toBe('Proxy route rejected');
  });

  it('ENQUEUE_FAILED (14-08) tells the user nothing ran and to deploy again', () => {
    const copy = deploymentErrorCopy('ENQUEUE_FAILED');
    expect(copy.title).toBe('Deploy never started');
    expect(copy.recovery).toMatch(/Deploy again\.$/);
    expect(copy.recovery).not.toMatch(/redis|postgres/i);
  });

  it('WORKSPACE_UNAVAILABLE (14-30) points at the SSH user\'s home directory, not the repository or deploy key', () => {
    const copy = deploymentErrorCopy('WORKSPACE_UNAVAILABLE');
    expect(copy.title).toBe('Deploy workspace unavailable');
    expect(copy.recovery).toMatch(/home directory/);
    expect(copy.recovery).toMatch(/SSH user/);
    expect(copy.recovery).not.toMatch(/repository URL|deploy key/i);
  });

  it('gives every code its own title', () => {
    const titles = DEPLOYMENT_ERROR_CODES.map((code) => deploymentErrorCopy(code).title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it.each([
    ['an unknown future code', 'QUANTUM_FLUX_FAILED'],
    ['an empty string', ''],
    ['a prototype key', '__proto__'],
    ['an inherited key', 'constructor'],
    ['toString', 'toString'],
    ['null', null],
    ['undefined', undefined],
  ])('falls back to the generic copy for %s', (_label, code) => {
    const copy = deploymentErrorCopy(code);
    expect(copy).toEqual(GENERIC_DEPLOYMENT_ERROR_COPY);
    expect(typeof copy.title).toBe('string');
    expect(typeof copy.recovery).toBe('string');
  });

  it('never echoes the code it was given into the copy', () => {
    const copy = deploymentErrorCopy('raw server errorMessage: password=hunter2');
    expect(copy.title).not.toContain('hunter2');
    expect(copy.recovery).not.toContain('hunter2');
  });
});

describe('guardLogTail', () => {
  it('returns the last lines, dropping trailing blank lines', () => {
    const text = Array.from({ length: LOG_TAIL_MAX_LINES + 5 }, (_, index) => `line ${String(index)}`).join('\n');
    const lines = guardLogTail(`${text}\n\n`);
    expect(lines).toHaveLength(LOG_TAIL_MAX_LINES);
    expect(lines.at(-1)).toBe(`line ${String(LOG_TAIL_MAX_LINES + 4)}`);
    expect(lines[0]).toBe('line 5');
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(guardLogTail('')).toEqual([]);
    expect(guardLogTail('\n \n\t\n')).toEqual([]);
    expect(guardLogTail(null)).toEqual([]);
    expect(guardLogTail(undefined)).toEqual([]);
  });

  it('caps each line and the total length', () => {
    const long = 'x'.repeat(LOG_TAIL_MAX_LINE_CHARS * 3);
    const lines = guardLogTail(Array.from({ length: LOG_TAIL_MAX_LINES }, () => long).join('\n'));
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(LOG_TAIL_MAX_LINE_CHARS);
    expect(lines.join('\n').length).toBeLessThanOrEqual(LOG_TAIL_MAX_CHARS);
    expect(lines[0]?.endsWith('…')).toBe(true);
  });

  it('strips control characters and CR line endings', () => {
    expect(guardLogTail('a\u0007b\u001b[31mc\r\nnext\r')).toEqual(['ab[31mc', 'next']);
  });

  it.each([
    ['a per-run e2e canary', 'step 3: noodara-canary-password-0123456789abcdef0123456789abcdef'],
    ['a build canary', 'echo cnryBuildH0123456789abcdef0123456789abcdef'],
    ['a short-prefix canary', 'value cnryA9f8e7d6c5b4a39281706f5e4d3c2b1a0'],
    ['a GitHub token', 'remote: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'],
    ['an OpenAI-style key', 'sk-abcdefghijklmnopQRSTUV'],
    ['an AWS access key', 'AKIAABCDEFGHIJKLMNOP'],
    ['a bearer header', 'Authorization: Bearer abc.def.ghi'],
    ['URL userinfo', 'fatal: https://x-access-token:s3cr3tValue@github.com/acme/app.git'],
    ['a password assignment', 'DB_PASSWORD=s3cr3tValue npm run build'],
    ['a token assignment', 'npm_token: s3cr3tValue'],
    ['a postgres URL', 'postgres://app:s3cr3tValue@db:5432/app'],
  ])('masks %s even when the server missed it', (_label, line) => {
    const [guarded] = guardLogTail(line);
    expect(guarded).toBeDefined();
    expect(guarded).toContain('[REDACTED');
    for (const secret of ['0123456789abcdef0123456789abcdef', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', 's3cr3tValue', 'abc.def.ghi']) {
      expect(guarded).not.toContain(secret);
    }
    expect(guarded).not.toMatch(/cnry[A-Za-z]*[0-9a-f]{16}/);
    expect(guarded).not.toMatch(/AKIA[A-Z0-9]{10}/);
    expect(guarded).not.toMatch(/sk-[A-Za-z0-9]{10}/);
  });

  it('masks a private key whose BEGIN line fell outside the tail', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';
    const text = [...Array.from({ length: LOG_TAIL_MAX_LINES }, () => body), '-----END PRIVATE KEY-----'].join('\n');
    const lines = guardLogTail(text);
    expect(lines.join('\n')).not.toContain(body);
  });

  it('masks a secret before capping, so a cut never leaves a partial secret', () => {
    const secret = `noodara-canary-x-${'ab'.repeat(16)}`;
    const line = `${'y'.repeat(LOG_TAIL_MAX_LINE_CHARS - 20)}${secret}`;
    const [guarded] = guardLogTail(line);
    expect(guarded).not.toContain('noodara-canary');
    expect(guarded).not.toContain('abab');
  });

  it('keeps ordinary build output, including image digests', () => {
    const line = '#5 sha256:4f2a8f0d6c9e1b3a5d7f9e2c4b6a8d0f1e3c5a7b9d1f3e5c7a9b1d3f5e7c9a1b 0.2s done';
    expect(guardLogTail(line)).toEqual([line]);
    expect(guardLogTail('npm ERR! code ELIFECYCLE')).toEqual(['npm ERR! code ELIFECYCLE']);
  });
});

// 24-03 A2: recovery copy names keys and reference names (never values) when they are known.
describe('configure context in recovery copy', () => {
  it('parses keys and secret references from configure log lines, never values', () => {
    const text = [
      'Configuring environment: 2 variables, 1 secret.',
      '  PORT',
      '  NODE_ENV',
      '  DATABASE_URL = <secret:db_password>',
      'PASSWORD=hunter2',
      '  bad key = <secret:x>',
    ].join('\n');
    expect(parseConfigureLog(text)).toEqual({
      keys: ['PORT', 'NODE_ENV', 'DATABASE_URL'],
      references: [{ key: 'DATABASE_URL', secret: 'db_password' }],
    });
    expect(parseConfigureLog(null)).toEqual({ keys: [], references: [] });
  });

  it('SECRET_UNRESOLVED names each key and the secret it references', () => {
    const copy = deploymentErrorCopy('SECRET_UNRESOLVED', {
      keys: ['DATABASE_URL', 'PORT'],
      references: [{ key: 'DATABASE_URL', secret: 'db_password' }],
    });
    expect(copy.recovery).toContain('DATABASE_URL');
    expect(copy.recovery).toContain('<secret:db_password>');
    expect(copy.recovery).not.toContain('PORT');
    expect(copy.recovery).toMatch(/\.$/);
  });

  it('ENV_INJECTION_FAILED names the keys it could not write', () => {
    const copy = deploymentErrorCopy('ENV_INJECTION_FAILED', { keys: ['PORT', 'NODE_ENV'], references: [] });
    expect(copy.recovery).toContain('PORT, NODE_ENV');
    expect(copy.recovery).toMatch(/\.$/);
  });

  it('PROXY_ROUTE_FAILED names the hostnames when given', () => {
    const copy = deploymentErrorCopy('PROXY_ROUTE_FAILED', { hostnames: ['app.example.com'] });
    expect(copy.recovery).toContain('app.example.com');
    expect(copy.recovery).toMatch(/\.$/);
  });

  it('caps long lists and drops tokens that are not plain names', () => {
    const keys = Array.from({ length: 9 }, (_, i) => `KEY_${String(i)}`);
    const copy = deploymentErrorCopy('ENV_INJECTION_FAILED', { keys: [...keys, 'x=secret value'] });
    expect(copy.recovery).toContain('and 4 more');
    expect(copy.recovery).not.toContain('secret value');
  });

  it('falls back to the plain copy without context, and ignores context for other codes', () => {
    expect(deploymentErrorCopy('SECRET_UNRESOLVED', { keys: [], references: [] })).toEqual(DEPLOYMENT_ERROR_COPY.SECRET_UNRESOLVED);
    expect(deploymentErrorCopy('BUILD_FAILED', { keys: ['PORT'] })).toEqual(DEPLOYMENT_ERROR_COPY.BUILD_FAILED);
    expect(deploymentErrorCopy('nope', { keys: ['PORT'] })).toEqual(GENERIC_DEPLOYMENT_ERROR_COPY);
  });

  it('marks exactly the three codes that use configure context', () => {
    expect([...CONTEXT_ERROR_CODES].sort()).toEqual(['ENV_INJECTION_FAILED', 'PROXY_ROUTE_FAILED', 'SECRET_UNRESOLVED']);
  });
});
