import { createHash } from 'node:crypto';
import { utils, type ParsedKey } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeFingerprint,
  fingerprintsEqual,
  formatFingerprint,
  InvalidHostKeyError,
  parseFingerprint,
} from './fingerprint.js';
import { generateTestKeys, type TestKeySet } from './testing/generate-keys.js';
import type { HostFingerprint } from './ssh-port.js';

function parseOrThrow(text: string): ParsedKey {
  const parsed = utils.parseKey(text);
  if (parsed instanceof Error || Array.isArray(parsed)) {
    throw new Error('test setup: expected a real generated key to parse cleanly');
  }
  return parsed;
}

/**
 * The test's own, independent digest computation — deliberately not calling into
 * `fingerprint.ts`'s `computeFingerprint`. Strips base64 padding via a `while`-loop character
 * trim (rather than `formatFingerprint`'s regex) so this is a visibly different code path over
 * the same bytes, per Task 2's own instruction: an authoritative cross-check against real
 * `ssh-keygen -lf` output already exists as a standing integration assertion
 * (tests/integration/ssh/contracts.test.ts, ADR 0004) — this file only proves internal
 * consistency of the digest algorithm, never re-derives the ssh-keygen oracle.
 */
function independentSha256Fingerprint(blob: Buffer): string {
  let base64 = createHash('sha256').update(blob).digest('base64');
  while (base64.endsWith('=')) {
    base64 = base64.slice(0, -1);
  }
  return `SHA256:${base64}`;
}

describe('computeFingerprint', () => {
  let keys: TestKeySet;

  beforeAll(() => {
    keys = generateTestKeys();
  });

  afterAll(() => {
    keys.cleanup();
  });

  it.each(['ed25519', 'ecdsa', 'rsa3072'] as const)(
    'computes the SHA256 digest and keyType for a real %s public key blob',
    (name) => {
      const parsed = parseOrThrow(keys[name]);
      const blob = parsed.getPublicSSH();

      const result = computeFingerprint(blob);

      expect(result.keyType).toBe(parsed.type);
      expect(result.fingerprint).toBe(independentSha256Fingerprint(blob));
      expect(result.fingerprint.endsWith('=')).toBe(false);
    },
  );

  it('rejects a zero-length buffer as a validation error rather than digesting nothing', () => {
    expect(() => computeFingerprint(Buffer.alloc(0))).toThrow(InvalidHostKeyError);
  });

  it('rejects a non-Buffer input as a validation error', () => {
    expect(() => computeFingerprint('not-a-buffer' as unknown as Buffer)).toThrow(InvalidHostKeyError);
  });

  it('rejects a blob whose RFC 4253 length prefix exceeds the buffer, without reading out of bounds', () => {
    const malformed = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01, 0x02]);
    expect(() => computeFingerprint(malformed)).toThrow(InvalidHostKeyError);
  });

  it('rejects a blob too short to contain a length prefix at all', () => {
    expect(() => computeFingerprint(Buffer.from([0x00, 0x01]))).toThrow(InvalidHostKeyError);
  });
});

describe('formatFingerprint / parseFingerprint', () => {
  let keys: TestKeySet;

  beforeAll(() => {
    keys = generateTestKeys();
  });

  afterAll(() => {
    keys.cleanup();
  });

  it.each(['ed25519', 'ecdsa', 'rsa3072'] as const)(
    'round-trips a real %s fingerprint through format then parse',
    (name) => {
      const parsed = parseOrThrow(keys[name]);
      const fp = computeFingerprint(parsed.getPublicSSH());

      const rendered = formatFingerprint(fp);
      const roundTripped = parseFingerprint(rendered);

      expect(roundTripped).toEqual(fp);
    },
  );

  it.each(['SHA256:abc', 'ssh-ed25519', ''])('rejects a malformed fingerprint string: %s', (bad) => {
    expect(() => parseFingerprint(bad)).toThrow(InvalidHostKeyError);
  });
});

describe('fingerprintsEqual (D-05)', () => {
  const base: HostFingerprint = { keyType: 'ssh-ed25519', fingerprint: 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaa' };

  it('is true when both keyType and fingerprint match', () => {
    expect(fingerprintsEqual(base, { ...base })).toBe(true);
  });

  it('is false for a same-digest, different-keyType pair (a key-type change is a mismatch)', () => {
    const changedType: HostFingerprint = { ...base, keyType: 'ecdsa-sha2-nistp256' };
    expect(fingerprintsEqual(base, changedType)).toBe(false);
  });

  it('is false for a same-keyType, different-digest pair', () => {
    const changedDigest: HostFingerprint = { ...base, fingerprint: 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    expect(fingerprintsEqual(base, changedDigest)).toBe(false);
  });
});
