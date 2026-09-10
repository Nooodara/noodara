import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLogger, writableForTests } from '../logger.js';
import { decodeMasterKey, InvalidMasterKeyError, logMasterKeyWarning, masterKeyFingerprint } from './master-key.js';

interface WarnRecord {
  level: number;
  msg: string;
  keyFingerprint: string;
}

describe('masterKeyFingerprint', () => {
  it('returns the first 16 lowercase hex characters of the SHA-256 digest', () => {
    const keyBytes = randomBytes(32);

    const fingerprint = masterKeyFingerprint(keyBytes);

    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across calls for the same key', () => {
    const keyBytes = randomBytes(32);

    expect(masterKeyFingerprint(keyBytes)).toBe(masterKeyFingerprint(keyBytes));
  });

  it('differs for two different keys', () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);

    expect(masterKeyFingerprint(keyA)).not.toBe(masterKeyFingerprint(keyB));
  });

  it('never equals or contains the base64 form of the key', () => {
    const keyBytes = randomBytes(32);
    const base64Key = keyBytes.toString('base64');

    const fingerprint = masterKeyFingerprint(keyBytes);

    expect(fingerprint).not.toBe(base64Key);
    expect(base64Key).not.toContain(fingerprint);
    expect(fingerprint).not.toContain(base64Key);
  });
});

describe('decodeMasterKey', () => {
  it('decodes valid base64 to the original 32-byte buffer', () => {
    const keyBytes = randomBytes(32);

    const decoded = decodeMasterKey(keyBytes.toString('base64'));

    expect(decoded).toHaveLength(32);
    expect(decoded.equals(keyBytes)).toBe(true);
  });

  it('throws InvalidMasterKeyError for a value that does not decode to 32 bytes', () => {
    const tooShort = randomBytes(31).toString('base64');

    expect(() => decodeMasterKey(tooShort)).toThrow(InvalidMasterKeyError);
  });
});

describe('logMasterKeyWarning (D-12)', () => {
  it('emits exactly one warn record with the fixed sentence and a keyFingerprint field', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });
    const keyBytes = randomBytes(32);

    logMasterKeyWarning(logger, keyBytes);

    const allRecords = records() as unknown as WarnRecord[];
    const warnRecords = allRecords.filter((record) => record.level === 40);
    expect(warnRecords).toHaveLength(1);
    expect(warnRecords[0]?.msg).toBe(
      'Back up NOODARA_MASTER_KEY; credentials are unrecoverable without it',
    );
    expect(warnRecords[0]?.keyFingerprint).toBe(masterKeyFingerprint(keyBytes));
  });

  it('never logs the raw base64 key material', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });
    const keyBytes = randomBytes(32);
    const base64Key = keyBytes.toString('base64');

    logMasterKeyWarning(logger, keyBytes);

    const serialized = JSON.stringify(records());
    expect(serialized).not.toContain(base64Key);
  });
});
