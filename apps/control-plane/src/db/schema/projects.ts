import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

// Phase 11 (PROJ-01): top of the Project -> Environment -> Service ownership tree. Names are
// unique case-insensitively at the database, like servers (D-10).
export const projects = pgTable(
  "projects",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("projects_name_lower_unique_idx").on(sql`lower(${table.name})`),
    uniqueIndex("projects_slug_unique_idx").on(table.slug),
  ],
);
