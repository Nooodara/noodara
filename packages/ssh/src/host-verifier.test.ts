import { utils, type ParsedKey } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeFingerprint } from './fingerprint.js';
import { createHostVerifier, type HostVerifierInput } from './host-verifier.js';
import { generateTestKeys, type TestKeySet } from './testing/generate-keys.js';
import type { HostFingerprint } from './ssh-port.js';

function parseOrThrow(text: string): ParsedKey {
  const parsed = utils.parseKey(text);
  if (parsed instanceof Error || Array.isArray(parsed)) {
    throw new Error('test setup: expected a real generated key to parse cleanly');
  }
  return parsed;
}

describe('createHostVerifier', () => {
  let keys: TestKeySet;
  let blobs: Record<'ed25519' | 'ecdsa' | 'rsa3072', Buffer>;
  let fingerprints: Record<'ed25519' | 'ecdsa' | 'rsa3072', HostFingerprint>;

  beforeAll(() => {
    keys = generateTestKeys();
    blobs = {
      ed25519: parseOrThrow(keys.ed25519).getPublicSSH(),
      ecdsa: parseOrThrow(keys.ecdsa).getPublicSSH(),
      rsa3072: parseOrThrow(keys.rsa3072).getPublicSSH(),
    };
    fingerprints = {
      ed25519: computeFingerprint(blobs.ed25519),
      ecdsa: computeFingerprint(blobs.ecdsa),
      rsa3072: computeFingerprint(blobs.rsa3072),
    };
  });

  afterAll(() => {
    keys.cleanup();
  });

  describe('no pinned fingerprint (D-07 first-connection capture)', () => {
    it('accepts the first key seen and exposes it as the captured fingerprint', () => {
      const verifier = createHostVerifier({ trusted: null });

      const accepted = verifier.verify(blobs.ed25519);

      expect(accepted).toBe(true);
      expect(verifier.captured()).toBe(true);
      expect(verifier.observed()).toEqual(fingerprints.ed25519);
    });

    it('has never captured before the first verify call', () => {
      const verifier = createHostVerifier({ trusted: null });

      expect(verifier.captured()).toBe(false);
      expect(verifier.observed()).toBeNull();
    });
  });

  describe('a pinned fingerprint (D-05/D-07)', () => {
    it('accepts a key matching the pinned type and digest', () => {
      const verifier = createHostVerifier({ trusted: fingerprints.ed25519 });

      expect(verifier.verify(blobs.ed25519)).toBe(true);
      expect(verifier.captured()).toBe(false);
      expect(verifier.observed()).toEqual(fingerprints.ed25519);
    });

    it.each(['ed25519', 'ecdsa', 'rsa3072'] as const)(
      'rejects a mismatching %s key blob and exposes the observed (rejected) fingerprint',
      (name) => {
        // Pin against a key of a different type than the one presented, guaranteeing a mismatch
        // regardless of which of the three is under test.
        const trusted = fingerprints[name === 'ed25519' ? 'ecdsa' : 'ed25519'];
        const verifier = createHostVerifier({ trusted });

        const accepted = verifier.verify(blobs[name]);

        expect(accepted).toBe(false);
        expect(verifier.captured()).toBe(false);
        expect(verifier.observed()).toEqual(fingerprints[name]);
      },
    );

    it('rejects a same-type key whose digest differs (a different ed25519 host key)', () => {
      // Two independently generated ed25519 keys always have different public key material, and
      // therefore different digests, even though both report keyType 'ssh-ed25519'.
      const otherKeys = generateTestKeys();
      try {
        const otherBlob = parseOrThrow(otherKeys.ed25519).getPublicSSH();
        const verifier = createHostVerifier({ trusted: fingerprints.ed25519 });

        expect(verifier.verify(otherBlob)).toBe(false);
      } finally {
        otherKeys.cleanup();
      }
    });

    it('returns false, never throws, on a mismatch', () => {
      const verifier = createHostVerifier({ trusted: fingerprints.ed25519 });

      expect(() => verifier.verify(blobs.ecdsa)).not.toThrow();
      expect(verifier.verify(blobs.ecdsa)).toBe(false);
    });

    it('returns false, never throws, for a blob it cannot fingerprint at all', () => {
      const verifier = createHostVerifier({ trusted: fingerprints.ed25519 });

      expect(() => verifier.verify(Buffer.alloc(0))).not.toThrow();
      expect(verifier.verify(Buffer.alloc(0))).toBe(false);
    });
  });

  describe('idempotent observation (ssh2 calls the verifier once, but a real defect could still lurk)', () => {
    it('calling verify twice with the same key is safe and records the same observation', () => {
      const verifier = createHostVerifier({ trusted: fingerprints.ed25519 });

      const first = verifier.verify(blobs.ed25519);
      const second = verifier.verify(blobs.ed25519);

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(verifier.observed()).toEqual(fingerprints.ed25519);
    });
  });

  describe('no bypass path exists (SEC-03, D-07, Pitfall 1)', () => {
    it('the factory accepts exactly one option: `trusted`', () => {
      const input: HostVerifierInput = { trusted: null };
      expect(Object.keys(input)).toEqual(['trusted']);
    });

    it('createHostVerifier and verify() each declare exactly one parameter', () => {
      expect(createHostVerifier.length).toBe(1);
      expect(createHostVerifier({ trusted: null }).verify.length).toBe(1);
    });

    it('the returned verifier exposes no option to make a mismatch accepted, for any of the three key types', () => {
      for (const name of ['ed25519', 'ecdsa', 'rsa3072'] as const) {
        const otherType = name === 'ed25519' ? 'ecdsa' : 'ed25519';
        const verifier = createHostVerifier({ trusted: fingerprints[otherType] });
        expect(verifier.verify(blobs[name])).toBe(false);
      }
    });
  });
});
