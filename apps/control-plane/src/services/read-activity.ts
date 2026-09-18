// D-20: the read-only, keyset-paginated activity log `GET /api/activity` consumes. Mirrors
// read-servers.ts's shape: no transaction opened, no activity event written (a read is not an
// event, ACT-01).
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { activityEvents } from '../db/schema/activity-events.js';
import { encodeActivityCursor } from '../routes/activity-cursor.js';
import type { ServerServicesDeps } from './server-service-deps.js';

export interface ActivityItem {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorType: 'user' | 'system';
  readonly actorId: string | null;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly action: string;
  readonly outcome: 'success' | 'failure';
  readonly errorCode: string | null;
  readonly metadata: unknown;
}

export interface ListActivityEventsInput {
  readonly limit: number;
  readonly cursor?: { readonly occurredAt: Date; readonly id: string };
}

export interface ListActivityEventsResult {
  readonly items: ActivityItem[];
  readonly nextCursor: string | null;
}

/**
 * D-20/T-4-11/T-4-40: reverse-chronological, keyset-paginated activity, newest first. An explicit
 * ten-column select (never `.select()`) so a future column added to `activityEvents` cannot leak
 * into the wire response without a deliberate change here. `metadata` is returned exactly as
 * `writeActivityEvent` already redacted it on write — re-redacting on read would only imply the
 * stored value might be unsafe, which would be the real bug to fix, not this function's job.
 *
 * RESEARCH.md Pattern 7: the existing single-column `activity_events_occurred_at_idx` (occurred_at
 * desc) is sufficient at v0.1's stated scale (decenas de servidores, no filters); a composite
 * `(occurred_at desc, id desc)` index would be strictly better for the tie-break but is a future
 * optimisation, not a correctness requirement — this query is correct today either way.
 */
export async function listActivityEvents(
  deps: ServerServicesDeps,
  input: ListActivityEventsInput,
): Promise<ListActivityEventsResult> {
  const { limit, cursor } = input;

  const rows = await deps.db
    .select({
      id: activityEvents.id,
      occurredAt: activityEvents.occurredAt,
      actorType: activityEvents.actorType,
      actorId: activityEvents.actorId,
      entityType: activityEvents.entityType,
      entityId: activityEvents.entityId,
      action: activityEvents.action,
      outcome: activityEvents.outcome,
      errorCode: activityEvents.errorCode,
      metadata: activityEvents.metadata,
    })
    .from(activityEvents)
    .where(
      cursor
        ? or(
            lt(activityEvents.occurredAt, cursor.occurredAt),
            and(eq(activityEvents.occurredAt, cursor.occurredAt), lt(activityEvents.id, cursor.id)),
          )
        : undefined,
    )
    .orderBy(desc(activityEvents.occurredAt), desc(activityEvents.id))
    // Fetch one extra row so nextCursor/hasMore is decided with no second count query.
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: ActivityItem[] = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  const nextCursor =
    hasMore && last !== undefined ? encodeActivityCursor({ occurredAt: last.occurredAt, id: last.id }) : null;

  return { items, nextCursor };
}
