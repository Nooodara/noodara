import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { MAX_SECRET_NAME_LENGTH } from "@noodara/domain";
import { SECRETS_OWNER_NAME_UNIQUE_INDEX } from "@noodara/domain/api-contract";
import { environments } from "./environments.js";
import { projects } from "./projects.js";
import { services } from "./services.js";
import { envScopeEnum } from "./v04-enums.js";
import { ownerIdExpression, scopeOwnerCheck } from "./v04-owner.js";

// v0.4 (21-06, migration 0015). Secrets at project, environment or service scope (SEC-04).
// `encryptedValue` holds the AES-256-GCM envelope (packages/domain/src/security/envelope.ts) and
// `keyVersion` the master-key version; there is no plaintext column, ever. `version` counts
// value changes (a rotation bumps it); `hint` is a non-secret display aid. Ownership and scope
// rules match environment_variables.
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    scope: envScopeEnum("scope").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id"),
    serviceId: uuid("service_id"),
    name: text("name").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    keyVersion: integer("key_version").notNull(),
    version: integer("version").notNull().default(1),
    hint: text("hint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "secrets_environment_project_fk",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "secrets_service_project_fk",
      columns: [table.serviceId, table.projectId],
      foreignColumns: [services.id, services.projectId],
    }).onDelete("cascade"),
    uniqueIndex(SECRETS_OWNER_NAME_UNIQUE_INDEX).on(ownerIdExpression(table), table.name),
    check("secrets_scope_owner_check", scopeOwnerCheck(table)),
    check(
      "secrets_shape_check",
      sql.raw(
        `char_length("name") BETWEEN 1 AND ${String(MAX_SECRET_NAME_LENGTH)} AND "version" >= 1 AND "key_version" >= 1`,
      ),
    ),
  ],
);
