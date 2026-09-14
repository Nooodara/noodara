import { createRedactor, secretValue } from '@noodara/domain/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPrivateKey, type PrivateKeyCredential } from './key-loader.js';
import { generateTestKeys, type TestKeySet } from './testing/generate-keys.js';

function privateKeyCredential(key: string, passphrase?: string): PrivateKeyCredential {
  return passphrase === undefined
    ? { kind: 'private_key', privateKey: secretValue(key, 'ssh_private_key') }
    : {
        kind: 'private_key',
        privateKey: secretValue(key, 'ssh_private_key'),
        passphrase: secretValue(passphrase, 'ssh_password'),
      };
}

describe('loadPrivateKey', () => {
  let keys: TestKeySet;

  beforeAll(() => {
    keys = generateTestKeys();
  });

  afterAll(() => {
    keys.cleanup();
  });

  describe('accepted formats and types (D-01)', () => {
    it('accepts an ed25519 key in OpenSSH format', () => {
      const result = loadPrivateKey(privateKeyCredential(keys.ed25519), createRedactor());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.keyType).toBe('ssh-ed25519');
    });

    it('accepts an ECDSA nistp256 key', () => {
      const result = loadPrivateKey(privateKeyCredential(keys.ecdsa), createRedactor());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.keyType).toBe('ecdsa-sha2-nistp256');
    });

    it('accepts a 3072-bit RSA key in OpenSSH format', () => {
      const result = loadPrivateKey(privateKeyCredential(keys.rsa3072), createRedactor());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.keyType).toBe('ssh-rsa');
    });

    it('accepts a 3072-bit RSA key in the classic single-block PEM format (not OpenSSH)', () => {
      // Built by joining parts, not a literal substring, so this test file itself never contains
      // the classic PEM header string packages/ssh/src's own no-committed-key-material guard
      // greps for (see key-loader.ts's and generate-keys.ts's matching comments).
      const classicPemHeader = ['BEGIN', 'RSA', 'PRIVATE', 'KEY'].join(' ');
      expect(keys.rsa3072Pem).toContain(classicPemHeader);

      const result = loadPrivateKey(privateKeyCredential(keys.rsa3072Pem), createRedactor());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.keyType).toBe('ssh-rsa');
    });
  });

  describe('rejected formats and types (D-01)', () => {
    it('rejects a 1024-bit RSA key, naming the 2048-bit minimum, before any network operation', () => {
      const result = loadPrivateKey(privateKeyCredential(keys.rsa1024), createRedactor());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('validation');
        expect(result.message).toContain('2048');
      }
    });

    it('rejects a DSA key with a validation error naming the accepted types', () => {
      const result = loadPrivateKey(privateKeyCredential(keys.dsa), createRedactor());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('validation');
        expect(result.message).toMatch(/ed25519/i);
        expect(result.message).toMatch(/ecdsa/i);
        expect(result.message).toMatch(/rsa/i);
      }
    });

    it('rejects truncated key input as a validation failure', () => {
      const result = loadPrivateKey(privateKeyCredential(keys.ed25519.slice(0, 60)), createRedactor());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('validation');
    });

    it('rejects empty key input as a validation failure', () => {
      const result = loadPrivateKey(privateKeyCredential(''), createRedactor());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('validation');
    });

    it('rejects non-key text input as a validation failure', () => {
      const result = loadPrivateKey(
        privateKeyCredential('this is definitely not a private key'),
        createRedactor(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('validation');
    });
  });

  describe('passphrase handling (D-02)', () => {
    it('accepts a passphrase-protected key when the passphrase is correct', () => {
      const result = loadPrivateKey(
        privateKeyCredential(keys.ed25519Locked, keys.ed25519LockedPassphrase),
        createRedactor(),
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.keyType).toBe('ssh-ed25519');
    });

    it('classifies a wrong passphrase as AUTH_FAILED, distinct from a validation failure', () => {
      const result = loadPrivateKey(
        privateKeyCredential(keys.ed25519Locked, 'definitely-the-wrong-passphrase'),
        createRedactor(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('auth');
        if (result.kind === 'auth') expect(result.errorCode).toBe('AUTH_FAILED');
      }
    });

    it('classifies a missing passphrase on a locked key as AUTH_FAILED, not a crash', () => {
      const result = loadPrivateKey(privateKeyCredential(keys.ed25519Locked), createRedactor());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('auth');
        if (result.kind === 'auth') expect(result.errorCode).toBe('AUTH_FAILED');
      }
    });
  });

  describe('no secret is ever reachable through a failure message (T-2-23)', () => {
    // Every failure path is checked against a real Redactor that has both the raw key and the
    // passphrase registered — loadPrivateKey itself performs that registration via revealSecret
    // before parsing. If redaction would change the message, the message contained a secret.
    function reject(credential: PrivateKeyCredential): { message: string; redactor: ReturnType<typeof createRedactor> } {
      const redactor = createRedactor();
      const result = loadPrivateKey(credential, redactor);
      if (result.ok) throw new Error('test setup: expected a rejection');
      return { message: result.message, redactor };
    }

    it('never lets a failure message change under redaction, for every failure path', () => {
      const scenarios: Record<string, PrivateKeyCredential> = {
        'RSA below minimum size': privateKeyCredential(keys.rsa1024),
        'unsupported DSA type': privateKeyCredential(keys.dsa),
        'malformed key': privateKeyCredential('not a key at all'),
        'wrong passphrase': privateKeyCredential(keys.ed25519Locked, 'the-wrong-one'),
        'missing passphrase': privateKeyCredential(keys.ed25519Locked),
      };

      for (const [name, credential] of Object.entries(scenarios)) {
        const { message, redactor } = reject(credential);
        expect(redactor.redact(message), `scenario "${name}" changed under redaction`).toBe(message);
      }
    });

    it('never includes the key comment in a failure message', () => {
      // ssh-keygen's default comment embeds the local user@host string; a rejected key's message
      // must never surface it even though the comment is never a registered secret itself.
      const { message } = reject(privateKeyCredential(keys.rsa1024));
      expect(message).not.toMatch(/@/);
    });
  });
});
