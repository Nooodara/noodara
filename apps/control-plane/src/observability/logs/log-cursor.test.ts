// 27-04 (H1): the cursor is opaque, signed and bound to one service.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compareLogPositions,
  decodeLogCursor,
  deriveLogCursorKey,
  encodeLogCursor,
  LOG_CURSOR_MAX_LENGTH,
  type LogPosition,
} from './log-cursor.js';

const key = deriveLogCursorKey('a-server-secret-of-some-length');
const serviceId = randomUUID();
const position: LogPosition = { timestamp: '2026-11-04T10:00:00.123456789Z', source: 'runtime', seq: 2 };

describe('log cursor (H1)', () => {
  it('round-trips a position for the same service', () => {
    const cursor = encodeLogCursor(position, serviceId, key);
    expect(cursor).not.toContain(serviceId);
    expect(decodeLogCursor(cursor, serviceId, key)).toEqual(position);
  });

  it('rejects a cursor issued for another service', () => {
    const cursor = encodeLogCursor(position, randomUUID(), key);
    expect(decodeLogCursor(cursor, serviceId, key)).toBeNull();
  });

  it('rejects a cursor signed with another key', () => {
    const cursor = encodeLogCursor(position, serviceId, deriveLogCursorKey('other-secret'));
    expect(decodeLogCursor(cursor, serviceId, key)).toBeNull();
  });

  it('rejects tampered, truncated and malformed cursors', () => {
    const cursor = encodeLogCursor(position, serviceId, key);
    const [version, payload = '', mac = ''] = cursor.split('.');
    const forged = Buffer.from(JSON.stringify([serviceId, '2020-01-01T00:00:00Z', 'build', 0])).toString('base64url');
    const flipped = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [
      `${version ?? ''}.${forged}.${mac}`,
      `${version ?? ''}.${flipped}.${mac}`,
      cursor.slice(0, -3),
      cursor.slice(0, 10),
      `${cursor}.extra`,
      `v2.${payload}.${mac}`,
      '',
      'x'.repeat(LOG_CURSOR_MAX_LENGTH + 1),
      'not-a-cursor',
    ]) {
      expect(decodeLogCursor(bad, serviceId, key), bad).toBeNull();
    }
  });

  it('rejects a well-signed payload with invalid fields', () => {
    const cases: [string, string, number][] = [
      ['yesterday', 'build', 0],
      ['2026-11-04T10:00:00Z', 'kernel', 0],
      ['2026-11-04T10:00:00Z', 'build', -1],
      ['2026-11-04T10:00:00Z', 'build', 1.5],
    ];
    for (const [timestamp, source, seq] of cases) {
      const cursor = encodeLogCursor({ timestamp, source: source as LogPosition['source'], seq }, serviceId, key);
      expect(decodeLogCursor(cursor, serviceId, key), `${timestamp} ${source} ${String(seq)}`).toBeNull();
    }
  });

  it('orders positions by instant, then source, then sequence', () => {
    const at = (timestamp: string, source: LogPosition['source'], seq = 0): LogPosition => ({ timestamp, source, seq });
    expect(compareLogPositions(at('2026-11-04T10:00:00Z', 'activity'), at('2026-11-04T10:00:00.001Z', 'build'))).toBeLessThan(0);
    expect(compareLogPositions(at('2026-11-04T10:00:00.000Z', 'build'), at('2026-11-04T10:00:00Z', 'runtime'))).toBeLessThan(0);
    expect(compareLogPositions(at('2026-11-04T10:00:00Z', 'runtime', 3), at('2026-11-04T10:00:00Z', 'runtime', 1))).toBeGreaterThan(0);
    expect(compareLogPositions(at('2026-11-04T10:00:00Z', 'deploy', 1), at('2026-11-04T10:00:00.000000000Z', 'deploy', 1))).toBe(0);
  });
});
