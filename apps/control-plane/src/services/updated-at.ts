// 13-02 (H1): `updated_at` is strictly increasing per row, so the `updatedAt` an SSE event carries
// orders writes to one service or deployment even when two land in the same millisecond or the
// clock steps back. Clients keep the newest `updatedAt` per id (snapshot or event).
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/** `now`, or 1 ms past the stored value when `now` is not later (row read under a lock). */
export function nextUpdatedAt(previous: Date, now: Date): Date {
  return now.getTime() > previous.getTime() ? now : new Date(previous.getTime() + 1);
}

/** The same rule in SQL, for a compare-and-set UPDATE that never read the row. */
export function nextUpdatedAtSql(column: PgColumn, now: Date): SQL<Date> {
  return sql<Date>`greatest(${now.toISOString()}::timestamptz, ${column} + interval '1 millisecond')`;
}
