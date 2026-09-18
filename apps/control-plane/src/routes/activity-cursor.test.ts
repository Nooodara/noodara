import { describe, expect, it } from 'vitest';
import { decodeActivityCursor, encodeActivityCursor } from './activity-cursor.js';

const SAMPLE_ID = '018f1e2a-1234-7abc-89ab-0123456789ab';

describe('encodeActivityCursor / decodeActivityCursor (D-20)', () => {
  it('round-trips, preserving millisecond precision', () => {
    const occurredAt = new Date('2026-01-02T03:04:05.678Z');
    const encoded = encodeActivityCursor({ occurredAt, id: SAMPLE_ID });
    const decoded = decodeActivityCursor(encoded);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.cursor.occurredAt.getTime()).toBe(occurredAt.getTime());
      expect(decoded.cursor.id).toBe(SAMPLE_ID);
    }
  });

  it('is base64url (no padding, no +/ characters)', () => {
    const encoded = encodeActivityCursor({ occurredAt: new Date('2026-01-01T00:00:00.000Z'), id: SAMPLE_ID });
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('never throws on a non-base64 string', () => {
    expect(() => decodeActivityCursor('not-base64!!!')).not.toThrow();
    expect(decodeActivityCursor('not-base64!!!').ok).toBe(false);
  });

  it('never throws on an empty string', () => {
    expect(() => decodeActivityCursor('')).not.toThrow();
    expect(decodeActivityCursor('').ok).toBe(false);
  });

  it('rejects a base64url string whose decoded content is malformed (no separator)', () => {
    const malformed = Buffer.from('no-separator-here', 'utf8').toString('base64url');
    expect(decodeActivityCursor(malformed).ok).toBe(false);
  });

  it('rejects a decoded id that is not a uuid', () => {
    const raw = Buffer.from('2026-01-01T00:00:00.000Z|not-a-uuid', 'utf8').toString('base64url');
    expect(decodeActivityCursor(raw).ok).toBe(false);
  });

  it('rejects a decoded timestamp that is not parseable', () => {
    const raw = Buffer.from(`not-a-date|${SAMPLE_ID}`, 'utf8').toString('base64url');
    expect(decodeActivityCursor(raw).ok).toBe(false);
  });

  it('accepts a well-formed decoded value', () => {
    const raw = Buffer.from(`2026-01-01T00:00:00.000Z|${SAMPLE_ID}`, 'utf8').toString('base64url');
    const decoded = decodeActivityCursor(raw);
    expect(decoded.ok).toBe(true);
  });
});
