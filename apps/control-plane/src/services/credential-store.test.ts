// D-15/SEC-02: RED for the single envelope <-> SshCredential boundary. Every private key used
// below is generated fresh inside this test run, never a committed key literal.
//
// RSA-2048/RSA-1024 keys are built directly with `node:crypto.generateKeyPairSync` (PKCS#1 PEM,
// the classic `-----BEGIN RSA PRIVATE KEY-----` form `ssh2`'s parser accepts). ed25519 keys need
// the OpenSSH private-key container (`-----BEGIN OPENSSH PRIVATE KEY-----`) — `node:crypto` has no
// export format for that container, so `buildOpenSshEd25519Key` below hand-assembles the
// documented `openssh-key-v1` wire format around a `node:crypto`-generated raw key pair (see
// https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key — no shell-out, no
// third-party dependency, no committed key material). A passphrase-protected ed25519 key is
// generated via the host's own `ssh-keygen` (mirroring `packages/ssh/src/testing/generate-keys.ts`
// and `tests/integration/helpers/ssh.ts`'s established per-run-material pattern) since faithfully
// reproducing OpenSSH's bcrypt-pbkdf key-wrapping by hand is out of scope for this test.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRedactor,
  decryptSecret,
  revealSecret,
  SecretTamperError,
  type EncryptedBlob,
  type EncryptionKey,
} from '@noodara/domain/security';
import { currentKeyVersion, decodeCredential, encodeCredential } from './credential-store.js';

function encodeLengthPrefixed(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function encodeStringField(text: string): Buffer {
  return encodeLengthPrefixed(Buffer.from(text, 'utf8'));
}

/** Hand-assembles an unencrypted OpenSSH `openssh-key-v1` private key container around a fresh
 *  ed25519 key pair, per OpenSSH's own PROTOCOL.key format. */
function buildOpenSshEd25519Key(): string {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const seed = Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url');

  const magic = Buffer.from('openssh-key-v1\0', 'binary');
  const cipherName = encodeStringField('none');
  const kdfName = encodeStringField('none');
  const kdfOptions = encodeLengthPrefixed(Buffer.alloc(0));
  const keyCount = Buffer.alloc(4);
  keyCount.writeUInt32BE(1, 0);

  const publicKeyBlob = Buffer.concat([encodeStringField('ssh-ed25519'), encodeLengthPrefixed(pub)]);
  const publicKeySection = encodeLengthPrefixed(publicKeyBlob);

  const checkInt = randomBytes(4);
  let privateSection = Buffer.concat([
    checkInt,
    checkInt,
    encodeStringField('ssh-ed25519'),
    encodeLengthPrefixed(pub),
    encodeLengthPrefixed(Buffer.concat([seed, pub])),
    encodeStringField(''), // comment
  ]);
  const blockSize = 8;
  const padLen = (blockSize - (privateSection.length % blockSize)) % blockSize;
  const padding = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1));
  privateSection = Buffer.concat([privateSection, padding]);
  const encryptedSection = encodeLengthPrefixed(privateSection);

  const full = Buffer.concat([magic, cipherName, kdfName, kdfOptions, keyCount, publicKeySection, encryptedSection]);
  const wrapped = full.toString('base64').match(/.{1,70}/g)?.join('\n') ?? full.toString('base64');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

interface LockedKey {
  readonly pem: string;
  readonly passphrase: string;
  cleanup(): void;
}

/** A passphrase-protected ed25519 key, shelled out to the host's own `ssh-keygen` — the same
 *  established technique `packages/ssh/src/testing/generate-keys.ts` uses, scoped locally here so
 *  `apps/control-plane` never reaches into `packages/ssh`'s internal (unexported) test helpers. */
function buildLockedEd25519Key(): LockedKey {
  const dir = mkdtempSync(join(tmpdir(), 'noodara-credential-store-test-'));
  const passphrase = randomBytes(18).toString('base64url');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-f', join(dir, 'key')], {
    stdio: 'ignore',
  });
  const pem = readFileSync(join(dir, 'key'), 'utf8');
  return { pem, passphrase, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function buildRsaPem(modulusLength: number): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return privateKey;
}

describe('credential-store', () => {
  let ed25519Key: string;
  let rsa2048: string;
  let rsa1024: string;
  let locked: LockedKey;
  let key: EncryptionKey;

  beforeAll(() => {
    ed25519Key = buildOpenSshEd25519Key();
    rsa2048 = buildRsaPem(2048);
    rsa1024 = buildRsaPem(1024);
    locked = buildLockedEd25519Key();
    key = { key: randomBytes(32), version: 1 };
  });

  afterAll(() => {
    locked.cleanup();
  });

  describe('encodeCredential', () => {
    it('encrypts a password credential, plaintext is the bare password string', () => {
      const redactor = createRedactor();
      const result = encodeCredential({ kind: 'password', password: 'a-real-password' }, key, redactor);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.type).toBe('ssh_password');
      expect(result.keyVersion).toBe(key.version);
      const decrypted = decryptSecret(result.encryptedValue, new Map([[key.version, key.key]]));
      expect(decrypted).toBe('a-real-password');
    });

    it('rejects an empty password', () => {
      const redactor = createRedactor();
      const result = encodeCredential({ kind: 'password', password: '' }, key, redactor);

      expect(result).toMatchObject({ ok: false, code: 'INVALID_CREDENTIAL' });
    });

    it('encrypts a private key without a passphrase as JSON with exactly one key: privateKey', () => {
      const redactor = createRedactor();
      const result = encodeCredential({ kind: 'private_key', privateKey: ed25519Key }, key, redactor);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.type).toBe('ssh_private_key');
      const decrypted = decryptSecret(result.encryptedValue, new Map([[key.version, key.key]]));
      const parsed = JSON.parse(decrypted) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(['privateKey']);
      expect('passphrase' in parsed).toBe(false);
      expect(parsed.privateKey).toBe(ed25519Key);
    });

    it('encrypts a private key with a passphrase as JSON {privateKey, passphrase}', () => {
      const redactor = createRedactor();
      const result = encodeCredential(
        { kind: 'private_key', privateKey: locked.pem, passphrase: locked.passphrase },
        key,
        redactor,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const decrypted = decryptSecret(result.encryptedValue, new Map([[key.version, key.key]]));
      const parsed = JSON.parse(decrypted) as { privateKey: string; passphrase: string };
      expect(parsed.privateKey).toBe(locked.pem);
      expect(parsed.passphrase).toBe(locked.passphrase);
    });

    it('rejects a malformed private key and persists nothing', () => {
      const redactor = createRedactor();
      const result = encodeCredential({ kind: 'private_key', privateKey: 'not-a-key' }, key, redactor);

      expect(result).toMatchObject({ ok: false, code: 'INVALID_CREDENTIAL' });
      expect(JSON.stringify(result)).not.toContain('not-a-key');
    });

    it('rejects an RSA key below the 2048-bit minimum, using loadPrivateKey\'s own message', () => {
      const redactor = createRedactor();
      const result = encodeCredential({ kind: 'private_key', privateKey: rsa1024 }, key, redactor);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('INVALID_CREDENTIAL');
      expect(result.message).toContain('2048');
    });

    it('accepts a valid 2048-bit RSA key', () => {
      const redactor = createRedactor();
      const result = encodeCredential({ kind: 'private_key', privateKey: rsa2048 }, key, redactor);

      expect(result.ok).toBe(true);
    });

    it('rejects a wrong passphrase for an encrypted key as INVALID_CREDENTIAL', () => {
      const redactor = createRedactor();
      const result = encodeCredential(
        { kind: 'private_key', privateKey: locked.pem, passphrase: 'definitely-the-wrong-one' },
        key,
        redactor,
      );

      expect(result).toMatchObject({ ok: false, code: 'INVALID_CREDENTIAL' });
    });

    it('never returns the raw key material in the result', () => {
      const redactor = createRedactor();
      const result = encodeCredential({ kind: 'private_key', privateKey: ed25519Key }, key, redactor);

      expect(JSON.stringify(result)).not.toContain(ed25519Key);
    });
  });

  describe('decodeCredential', () => {
    it('decodes an ssh_password row back to the original password', () => {
      const encrypted = encodeCredential({ kind: 'password', password: 'round-trip-pw' }, key, createRedactor());
      if (!encrypted.ok) throw new Error('test setup: expected encodeCredential to succeed');

      const decoded = decodeCredential(
        { type: 'ssh_password', encryptedValue: encrypted.encryptedValue, keyVersion: encrypted.keyVersion },
        { current: key.key },
      );

      expect(decoded.kind).toBe('password');
      if (decoded.kind !== 'password') return;
      expect(revealSecret(decoded.password)).toBe('round-trip-pw');
    });

    it('decodes an ssh_private_key row without a passphrase', () => {
      const encrypted = encodeCredential(
        { kind: 'private_key', privateKey: ed25519Key },
        key,
        createRedactor(),
      );
      if (!encrypted.ok) throw new Error('test setup: expected encodeCredential to succeed');

      const decoded = decodeCredential(
        { type: 'ssh_private_key', encryptedValue: encrypted.encryptedValue, keyVersion: encrypted.keyVersion },
        { current: key.key },
      );

      expect(decoded.kind).toBe('private_key');
      if (decoded.kind !== 'private_key') return;
      expect('passphrase' in decoded).toBe(false);
      expect(revealSecret(decoded.privateKey)).toBe(ed25519Key);
    });

    it('decodes an ssh_private_key row with a passphrase, both fields SecretValue', () => {
      const encrypted = encodeCredential(
        { kind: 'private_key', privateKey: locked.pem, passphrase: locked.passphrase },
        key,
        createRedactor(),
      );
      if (!encrypted.ok) throw new Error('test setup: expected encodeCredential to succeed');

      const decoded = decodeCredential(
        { type: 'ssh_private_key', encryptedValue: encrypted.encryptedValue, keyVersion: encrypted.keyVersion },
        { current: key.key },
      );

      expect(decoded.kind).toBe('private_key');
      if (decoded.kind !== 'private_key') return;
      expect('passphrase' in decoded).toBe(true);
      expect(revealSecret(decoded.privateKey)).toBe(locked.pem);
      if ('passphrase' in decoded && decoded.passphrase !== undefined) {
        expect(revealSecret(decoded.passphrase)).toBe(locked.passphrase);
        expect(decoded.passphrase.kind).toBe('ssh_private_key');
      }
    });

    it('decodes a row encrypted under masterKeys.previous when supplied', () => {
      const oldKey: EncryptionKey = { key: randomBytes(32), version: 1 };
      const encrypted = encodeCredential({ kind: 'password', password: 'old-key-pw' }, oldKey, createRedactor());
      if (!encrypted.ok) throw new Error('test setup: expected encodeCredential to succeed');

      const decoded = decodeCredential(
        { type: 'ssh_password', encryptedValue: encrypted.encryptedValue, keyVersion: encrypted.keyVersion },
        { current: randomBytes(32), previous: oldKey.key },
      );

      expect(decoded.kind).toBe('password');
      if (decoded.kind !== 'password') return;
      expect(revealSecret(decoded.password)).toBe('old-key-pw');
    });

    it('throws SecretTamperError on a tampered envelope', () => {
      const encrypted = encodeCredential({ kind: 'password', password: 'tamper-me' }, key, createRedactor());
      if (!encrypted.ok) throw new Error('test setup: expected encodeCredential to succeed');

      const segments = (encrypted.encryptedValue as string).split(':');
      const tampered = `${segments[0]}:${segments[1]}:${segments[2]!.slice(0, -4)}AAAA:${segments[3]}` as EncryptedBlob;

      expect(() =>
        decodeCredential({ type: 'ssh_password', encryptedValue: tampered, keyVersion: encrypted.keyVersion }, {
          current: key.key,
        }),
      ).toThrow(SecretTamperError);
    });

    it('never leaks plaintext through String()/JSON.stringify() of the result', () => {
      const encrypted = encodeCredential({ kind: 'password', password: 'never-leak-me' }, key, createRedactor());
      if (!encrypted.ok) throw new Error('test setup: expected encodeCredential to succeed');

      const decoded = decodeCredential(
        { type: 'ssh_password', encryptedValue: encrypted.encryptedValue, keyVersion: encrypted.keyVersion },
        { current: key.key },
      );

      expect(String(decoded)).not.toContain('never-leak-me');
      expect(JSON.stringify(decoded)).not.toContain('never-leak-me');
    });
  });

  describe('currentKeyVersion', () => {
    it('is exported as an async function (integration-tested in plan 03-05)', () => {
      expect(typeof currentKeyVersion).toBe('function');
    });
  });
});
