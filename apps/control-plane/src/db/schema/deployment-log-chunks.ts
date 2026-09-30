import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { DEPLOYMENT_LOG_PHASES } from "@noodara/domain/deployment";
import { deployments } from "./deployments.js";

export const deploymentLogPhaseEnum = pgEnum("deployment_log_phase", [
  ...DEPLOYMENT_LOG_PHASES,
]);

// Ordered build/deploy output per phase. `content` is stored already redacted; nothing here is
// ever a secret value.
export const deploymentLogChunks = pgTable(
  "deployment_log_chunks",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    phase: deploymentLogPhaseEnum("phase").notNull(),
    seq: integer("seq").notNull(),
    content: text("content").notNull(),
    byteLength: integer("byte_length").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("deployment_log_chunks_deployment_phase_seq_unique_idx").on(
      table.deploymentId,
      table.phase,
      table.seq,
    ),
  ],
);
