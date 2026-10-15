import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import {
  DEPLOYMENT_ERROR_CODES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
  type DeploymentStatus,
  type RuntimeConfigSnapshot,
} from "@noodara/domain/deployment";
import { services } from "./services.js";
import { webhookDeliveries } from "./webhook-deliveries.js";

// Enums derived from the domain tuples (DEP-01) so DB and TS unions cannot drift.
export const deploymentStatusEnum = pgEnum("deployment_status", [
  ...DEPLOYMENT_STATUSES,
]);
export const deploymentTriggerEnum = pgEnum("deployment_trigger", [
  ...DEPLOYMENT_TRIGGERS,
]);
export const deploymentErrorCodeEnum = pgEnum("deployment_error_code", [
  ...DEPLOYMENT_ERROR_CODES,
]);

// The DB sort order partitions the enum: every non-terminal status sorts before this one, every
// terminal one at or after it (migration 0011 adds HEALTHCHECK/ROLLING_BACK BEFORE 'SUCCESS').
// A literal IN list cannot name values added in the same migrator transaction (55P04), so the
// one-active predicate is `status < 'SUCCESS'`; tests/integration/db proves it equals NON_TERMINAL.
const FIRST_TERMINAL_STATUS: DeploymentStatus = "SUCCESS";
const firstTerminalStatus = sql.raw(`'${FIRST_TERMINAL_STATUS}'`);

// Append-only attempts: a redeploy is a new row. ROADMAP D16: at most one non-terminal
// deployment per service, enforced by the partial unique index. v0.3 columns ship nullable (D4).
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    status: deploymentStatusEnum("status").notNull().default("QUEUED"),
    trigger: deploymentTriggerEnum("trigger").notNull().default("manual"),
    // User id or 'system'.
    triggeredBy: text("triggered_by"),
    // Snapshot of the service source at trigger time; never contains secrets.
    source: jsonb("source").notNull(),
    commitSha: text("commit_sha"),
    previousDeploymentId: uuid("previous_deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    startedAt: timestamp("started_at", { withTimezone: true }),
    // 13-03 step boundaries, written in the same UPDATE as their status edge (verify: the one
    // write allowed only while DEPLOYING). Nullable: older rows derive their steps from status.
    buildingStartedAt: timestamp("building_started_at", { withTimezone: true }),
    deployingStartedAt: timestamp("deploying_started_at", { withTimezone: true }),
    verifyingStartedAt: timestamp("verifying_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    errorCode: deploymentErrorCodeEnum("error_code"),
    errorMessage: text("error_message"),
    // 16-06 (migration 0013) v0.3 traceability. Every column is nullable without a default, so the
    // ALTER on a populated table is metadata-only: no heap rewrite, only a brief ACCESS EXCLUSIVE
    // lock (bound: forward and rollback on 10k rows < 10 s, tests/integration/db/migration-0013).
    // The image this attempt ran (rollback target, image retention).
    imageRef: text("image_ref"),
    // Manual rollback: the deployment whose retained image this attempt restores.
    rollbackOfDeploymentId: uuid("rollback_of_deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    webhookDeliveryId: uuid("webhook_delivery_id").references(
      (): AnyPgColumn => webhookDeliveries.id,
      { onDelete: "set null" },
    ),
    // Idempotency-Key header and the sha256 of the canonical request it was first used with.
    idempotencyKey: text("idempotency_key"),
    requestFingerprint: text("request_fingerprint"),
    // Snapshot of the container runtime config at deploy time; never contains secret values.
    runtimeConfig: jsonb("runtime_config").$type<RuntimeConfigSnapshot>(),
    healthcheckStartedAt: timestamp("healthcheck_started_at", {
      withTimezone: true,
    }),
    rollbackStartedAt: timestamp("rollback_started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("deployments_service_active_unique_idx")
      .on(table.serviceId)
      .where(sql`${table.status} < ${firstTerminalStatus}`),
    index("deployments_service_created_at_idx").on(
      table.serviceId,
      table.createdAt.desc(),
    ),
    uniqueIndex("deployments_service_idempotency_key_unique_idx")
      .on(table.serviceId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      "deployments_idempotency_pair_check",
      sql`(${table.idempotencyKey} IS NULL AND ${table.requestFingerprint} IS NULL) OR (${table.idempotencyKey} IS NOT NULL AND ${table.requestFingerprint} IS NOT NULL AND char_length(${table.idempotencyKey}) BETWEEN 1 AND 255 AND ${table.requestFingerprint} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "deployments_runtime_config_object_check",
      sql`${table.runtimeConfig} IS NULL OR jsonb_typeof(${table.runtimeConfig}) = 'object'`,
    ),
  ],
);
