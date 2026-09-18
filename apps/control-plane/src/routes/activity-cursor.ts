// D-20/T-4-39: the opaque base64url keyset cursor `GET /api/activity` paginates by. Carries no
// secret — everything it encodes (`occurredAt`, `id`) is already visible on the very items the
// response returns — so it is encoded for opacity-by-convention, never encrypted. The one
// property that matters for T-4-39 is that decoding a tampered or malformed cursor is an ordinary
// failure result, never a thrown exception: a cursor is client input like any other.
const SEPARATOR = '|';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActivityCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

export type DecodeActivityCursorResult =
  | { readonly ok: true; readonly cursor: ActivityCursor }
  | { readonly ok: false };

/** `base64url` of `<occurredAt.toISOString()>|<id>` — `toISOString()` preserves millisecond
 *  precision, which is what makes the round-trip through `decodeActivityCursor` exact. */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  const raw = `${cursor.occurredAt.toISOString()}${SEPARATOR}${cursor.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Decodes and validates a cursor, returning a result union rather than throwing. Splits on the
 * *first* separator only (an id can never legitimately contain one, but this keeps the split
 * unambiguous either way), then requires the timestamp half to parse as a real date and the id
 * half to look like a uuid. `Buffer.from(..., 'base64url')` never throws on invalid input (Node's
 * base64/base64url decoder is lenient, not strict) — the try/catch below is defensive, not load
 * bearing; validation of the *decoded content* is what actually rejects a tampered cursor.
 */
export function decodeActivityCursor(raw: string): DecodeActivityCursorResult {
  if (raw.length === 0) {
    return { ok: false };
  }

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return { ok: false };
  }

  const separatorIndex = decoded.indexOf(SEPARATOR);
  if (separatorIndex === -1) {
    return { ok: false };
  }

  const occurredAtRaw = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);

  if (!UUID_PATTERN.test(id)) {
    return { ok: false };
  }

  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    return { ok: false };
  }

  return { ok: true, cursor: { occurredAt, id } };
}
