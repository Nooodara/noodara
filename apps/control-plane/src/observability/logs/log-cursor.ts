// 27-04 (H1): the opaque pagination cursor of the unified logs API. It encodes a position
// (timestamp, source, sequence) bound to one service and signed with an HMAC, so a tampered,
// truncated or foreign cursor decodes to null (LOG_QUERY_INVALID), never to another service's
// entries. Positions order by timestamp, then LOG_SOURCES order, then sequence, the same order
// mergeLogEntries produces.
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  compareLogTimestamps,
  isLogSource,
  LOG_SOURCES,
  parseLogTimestamp,
  type LogSource,
} from '@noodara/domain';

export interface LogPosition {
  readonly timestamp: string;
  readonly source: LogSource;
  /** Ordinal among the source's entries with the same instant, in the source's own order. */
  readonly seq: number;
}

export const LOG_CURSOR_MAX_LENGTH = 512;
const VERSION = 'v1';
const MAC_BYTES = 16;
const MAX_SEQ = 1_000_000_000;

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(`${VERSION}.${payload}`).digest().subarray(0, MAC_BYTES);
}

/** Derives the cursor signing key from a server secret (never the secret itself). */
export function deriveLogCursorKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('noodara.logs.cursor.v1').digest();
}

export function encodeLogCursor(position: LogPosition, serviceId: string, key: Buffer): string {
  const payload = Buffer.from(
    JSON.stringify([serviceId, position.timestamp, position.source, position.seq]),
    'utf8',
  ).toString('base64url');
  return `${VERSION}.${payload}.${mac(key, payload).toString('base64url')}`;
}

/** The position, or null for anything not issued by this server for this service. */
export function decodeLogCursor(raw: string, serviceId: string, key: Buffer): LogPosition | null {
  if (raw.length === 0 || raw.length > LOG_CURSOR_MAX_LENGTH) return null;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload = '', signature = ''] = parts;
  const given = Buffer.from(signature, 'base64url');
  // Re-encoding rejects a non-canonical signature (extra or altered padding bits).
  if (given.length !== MAC_BYTES || given.toString('base64url') !== signature) return null;
  if (!timingSafeEqual(given, mac(key, payload))) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== 4) return null;
  const [owner, timestamp, source, seq] = decoded as unknown[];
  if (owner !== serviceId) return null;
  if (typeof timestamp !== 'string' || parseLogTimestamp(timestamp) === null) return null;
  if (!isLogSource(source)) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return null;
  return { timestamp, source, seq };
}

/** Total order of positions; an unparseable timestamp sorts last (never issued in a cursor). */
export function compareLogPositions(a: LogPosition, b: LogPosition): number {
  const at = parseLogTimestamp(a.timestamp);
  const bt = parseLogTimestamp(b.timestamp);
  const byTime =
    at === null || bt === null ? Number(at === null) - Number(bt === null) : compareLogTimestamps(at, bt);
  return byTime || LOG_SOURCES.indexOf(a.source) - LOG_SOURCES.indexOf(b.source) || a.seq - b.seq;
}
