// This is the ONLY permitted insert into `activity_events` anywhere in this codebase
// (ARCHITECTURE.md §6: "only application services write activity events (never routes or
// workers directly)"). Phase 3's application services are the only intended callers — a route or
// worker must go through a service, never call `writeActivityEvent` itself. Enforced today by
// this being the sole file that references `activityEvents` for an insert (grepped in this
// plan's own acceptance criteria and by future CI); a runtime guard is unnecessary complexity for
// a single-process monorepo.
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { buildActivityEvent, type BuildActivityEventInput } from '@noodara/domain/activity';
import * as schema from '../db/schema/index.js';
import { activityEvents } from '../db/schema/activity-events.js';
import { appRedactor } from './redaction.js';

/**
 * The common base both the default `db` handle (`NodePgDatabase<typeof schema>`) and a
 * transaction handle (the `tx` parameter a caller receives inside a `db`-instance
 * `.transaction(async (tx) => ...)` call) extend, so `writeActivityEvent` composes into a
 * caller's transaction without any special-casing.
 */
export type ActivityWriteHandle = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export type WriteActivityEventInput = BuildActivityEventInput;

/**
 * Builds the `ActivityEvent` (which throws `InvalidActivityActionError`/`SensitiveMetadataError`
 * before anything touches the database), redacts `metadata` through `appRedactor`, and inserts
 * exactly one row. Returns the inserted row's id.
 *
 * `handle` accepts either the default `db` or a transaction handle — this function never opens
 * its own transaction, so a caller inside a `db`-instance `.transaction(async (tx) => ...)` call
 * gets atomicity between a state change and its activity event for free (T-1-24).
 *
 * Order of operations is deliberate: build, THEN redact. A forbidden key in `metadata` (e.g.
 * `password`) must be a hard failure that surfaces the bug at the call site — never something
 * silently laundered into `[REDACTED:...]` and persisted as if the call had been fine all along
 * (T-1-22).
 */
export async function writeActivityEvent(
  handle: ActivityWriteHandle,
  input: WriteActivityEventInput,
  now: Date = new Date(),
): Promise<string> {
  const event = buildActivityEvent(input, now);
  const redactedMetadata = appRedactor.redact(event.metadata);

  const [row] = await handle
    .insert(activityEvents)
    .values({
      occurredAt: event.occurredAt,
      actorType: event.actorType,
      actorId: event.actorId,
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      outcome: event.outcome,
      metadata: redactedMetadata,
      ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
    })
    .returning({ id: activityEvents.id });

  if (!row) {
    throw new Error('writeActivityEvent: insert returned no row');
  }
  return row.id;
}
