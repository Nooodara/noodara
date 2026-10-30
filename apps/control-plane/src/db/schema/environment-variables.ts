import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { MAX_ENV_KEY_LENGTH, MAX_ENV_VALUE_BYTES } from "@noodara/domain";
import { ENVIRONMENT_VARIABLES_OWNER_KEY_UNIQUE_INDEX } from "@noodara/domain/api-contract";
import { environments } from "./environments.js";
import { projects } from "./projects.js";
import { services } from "./services.js";
import { envScopeEnum } from "./v04-enums.js";
import { ownerIdExpression, scopeOwnerCheck } from "./v04-owner.js";

// v0.4 (21-06, migration 0015). Plain variables at project, environment or service scope (ENV-01).
// project_id is always set; the composite FKs to environments(id, project_id) and
// services(id, project_id) make an owner of another project impossible. Owners cascade. Values
// that are secrets never live here: a value may hold `<secret:name>` references only (ENV-03).
export const environmentVariables = pgTable(
  "environment_variables",
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
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "environment_variables_environment_project_fk",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "environment_variables_service_project_fk",
      columns: [table.serviceId, table.projectId],
      foreignColumns: [services.id, services.projectId],
    }).onDelete("cascade"),
    uniqueIndex(ENVIRONMENT_VARIABLES_OWNER_KEY_UNIQUE_INDEX).on(ownerIdExpression(table), table.key),
    check("environment_variables_scope_owner_check", scopeOwnerCheck(table)),
    check(
      "environment_variables_size_check",
      sql.raw(
        `char_length("key") BETWEEN 1 AND ${String(MAX_ENV_KEY_LENGTH)} AND octet_length("value") <= ${String(MAX_ENV_VALUE_BYTES)}`,
      ),
    ),
  ],
);
