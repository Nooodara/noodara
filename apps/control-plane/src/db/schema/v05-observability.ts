import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import {
  DOCKER_CONTAINER_STATES,
  OBSERVABILITY_PARSE_ERRORS,
  type ContainerHealthStatus,
  type FilesystemUsage,
} from "@noodara/domain";
import { servers } from "./servers.js";
import { services } from "./services.js";
import { sqlInList } from "./v04-owner.js";

// v0.5 (26-05, migration 0019). Metric snapshots (ADR 0012 A7): one host row per server per tick
// and one row per managed container, pruned by sampled_at (retention job, 27-02). A sample never
// outlives its server or service (ON DELETE CASCADE). No row holds env, command or log text.

const CONTAINER_HEALTH_STATUSES = ["starting", "healthy", "unhealthy"] as const satisfies readonly ContainerHealthStatus[];
const percentCheck = (column: string): string => `"${column}" IS NULL OR "${column}" BETWEEN 0 AND 100`;

export const hostMetricSamples = pgTable(
  "host_metric_samples",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
    /** NULL on the first sample or a counter wrap (domain `cpuPercent`). */
    cpuPercent: doublePrecision("cpu_percent"),
    memoryTotalBytes: bigint("memory_total_bytes", { mode: "number" }).notNull(),
    memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" }).notNull(),
    /** The highest used percentage over `filesystems`; NULL when none has blocks. */
    diskUsedPercent: doublePrecision("disk_used_percent"),
    filesystems: jsonb("filesystems").$type<readonly FilesystemUsage[]>().notNull().default([]),
    uptimeSeconds: bigint("uptime_seconds", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("host_metric_samples_server_sampled_at_idx").on(table.serverId, table.sampledAt.desc()),
    index("host_metric_samples_sampled_at_idx").on(table.sampledAt),
    check(
      "host_metric_samples_values_check",
      sql.raw(
        `(${percentCheck("cpu_percent")}) AND (${percentCheck("disk_used_percent")}) AND "memory_total_bytes" >= 0 AND "memory_used_bytes" BETWEEN 0 AND "memory_total_bytes" AND "uptime_seconds" >= 0`,
      ),
    ),
  ],
);

export const containerMetricSamples = pgTable(
  "container_metric_samples",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    containerId: text("container_id").notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
    running: boolean("running").notNull(),
    /** NULL when the container is not running (no `docker stats` row). */
    cpuPercent: doublePrecision("cpu_percent"),
    memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" }),
    /** NULL when unlimited (HostConfig.Memory = 0). */
    memoryLimitBytes: bigint("memory_limit_bytes", { mode: "number" }),
    restartCount: integer("restart_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("container_metric_samples_service_sampled_at_idx").on(table.serviceId, table.sampledAt.desc()),
    index("container_metric_samples_sampled_at_idx").on(table.sampledAt),
    check(
      "container_metric_samples_values_check",
      // docker stats reports CPU per core, so a busy container exceeds 100%: only the floor is fixed.
      sql.raw(
        `"container_id" ~ '^[0-9a-f]{64}$' AND ("cpu_percent" IS NULL OR "cpu_percent" >= 0) AND ("memory_used_bytes" IS NULL OR "memory_used_bytes" >= 0) AND ("memory_limit_bytes" IS NULL OR "memory_limit_bytes" > 0) AND "restart_count" >= 0`,
      ),
    ),
  ],
);

// Container state points (domain `ContainerStatePoint`), stored when the state changes (27-02);
// the crash-loop and OOM rules read a window of them. A row with `parse_error` records a sample
// that could not be parsed and carries no state.
export const containerObservations = pgTable(
  "container_observations",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    containerId: text("container_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    status: text("status"),
    running: boolean("running").notNull().default(false),
    restarting: boolean("restarting").notNull().default(false),
    restartCount: integer("restart_count").notNull().default(0),
    oomKilled: boolean("oom_killed").notNull().default(false),
    exitCode: integer("exit_code"),
    health: text("health"),
    /** Exit codes of the last Health.Log entries only, never their Output (ADR 0012 A2). */
    healthExitCodes: jsonb("health_exit_codes").$type<readonly number[]>().notNull().default([]),
    memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" }),
    memoryLimitBytes: bigint("memory_limit_bytes", { mode: "number" }),
    parseError: text("parse_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("container_observations_service_observed_at_idx").on(table.serviceId, table.observedAt.desc()),
    index("container_observations_observed_at_idx").on(table.observedAt),
    check(
      "container_observations_state_check",
      sql.raw(
        `("parse_error" IS NULL AND "status" IS NOT NULL AND "container_id" IS NOT NULL) OR ("parse_error" IS NOT NULL AND "status" IS NULL)`,
      ),
    ),
    check(
      "container_observations_values_check",
      sql.raw(
        `("status" IS NULL OR "status" IN (${sqlInList(DOCKER_CONTAINER_STATES)})) AND ("health" IS NULL OR "health" IN (${sqlInList(CONTAINER_HEALTH_STATUSES)})) AND ("parse_error" IS NULL OR "parse_error" IN (${sqlInList(OBSERVABILITY_PARSE_ERRORS)})) AND ("container_id" IS NULL OR "container_id" ~ '^[0-9a-f]{64}$') AND "restart_count" >= 0 AND jsonb_typeof("health_exit_codes") = 'array'`,
      ),
    ),
  ],
);
