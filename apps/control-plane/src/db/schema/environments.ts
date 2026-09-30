import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { projects } from "./projects.js";

// PROJ-04: the UNIQUE (id, project_id) constraint exists only to be the target of services'
// composite FK, which makes a service pointing at another project's environment impossible.
// `kind` is free text on purpose (ROADMAP D23), never an enum.
export const environments = pgTable(
  "environments",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("development"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("environments_id_project_id_unique").on(table.id, table.projectId),
    uniqueIndex("environments_project_name_lower_unique_idx").on(
      table.projectId,
      sql`lower(${table.name})`,
    ),
  ],
);
