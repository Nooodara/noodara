import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import {
  WEBHOOK_DELIVERY_OUTCOMES,
  type WebhookDeliveryOutcome,
} from "@noodara/domain";
import { deployments } from "./deployments.js";
import { services } from "./services.js";

// The outcome stays text + CHECK built from the domain tuple (no new enum type: a later outcome is
// a constraint swap, never an ADD VALUE inside the migrator transaction).
const outcomeList = sql.raw(
  WEBHOOK_DELIVERY_OUTCOMES.map((outcome) => `'${outcome}'`).join(", "),
);

// 16-06 A4: one row per accepted GitHub delivery of a service's hook (16-05). It keeps only what
// traceability needs; the payload and the signature header are never stored. A repeated
// X-GitHub-Delivery id for the same hook is a duplicate (unique index), not a new row.
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    // X-GitHub-Delivery header value.
    deliveryId: text("delivery_id").notNull(),
    // X-GitHub-Event header value (push, ping, ...).
    event: text("event").notNull(),
    outcome: text("outcome").$type<WebhookDeliveryOutcome>().notNull(),
    // `after` of a push; null for events that carry no commit (ping).
    pushedSha: text("pushed_sha"),
    deploymentId: uuid("deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_service_delivery_unique_idx").on(
      table.serviceId,
      table.deliveryId,
    ),
    index("webhook_deliveries_service_received_at_idx").on(
      table.serviceId,
      table.receivedAt.desc(),
    ),
    check(
      "webhook_deliveries_outcome_check",
      sql`${table.outcome} IN (${outcomeList})`,
    ),
    check(
      "webhook_deliveries_delivery_id_check",
      sql`char_length(${table.deliveryId}) BETWEEN 1 AND 128 AND char_length(${table.event}) BETWEEN 1 AND 64`,
    ),
    check(
      "webhook_deliveries_pushed_sha_check",
      sql`${table.pushedSha} IS NULL OR ${table.pushedSha} ~ '^[0-9a-f]{40}$'`,
    ),
  ],
);
