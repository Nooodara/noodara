import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { SERVICE_STATUSES } from "@noodara/domain/deployment";
import { SERVICE_SOURCE_TYPES } from "@noodara/domain/validators";
import { credentials } from "./credentials.js";
import { environments } from "./environments.js";
import { projects } from "./projects.js";
import { servers } from "./servers.js";

export const serviceSourceTypeEnum = pgEnum("service_source_type", [
  ...SERVICE_SOURCE_TYPES,
]);
export const serviceStatusEnum = pgEnum("service_status", [
  ...SERVICE_STATUSES,
]);

// PROJ-04: (environment_id, project_id) -> environments(id, project_id) makes a cross-project
// service impossible at the database. server_id is RESTRICT (PROJ-05 backstop). The credential
// FKs are RESTRICT too (D-17): deleting a service deletes its credentials in the same
// transaction, service first. No build-args or env columns here (DEP-08, ROADMAP D13).
export const services = pgTable(
  "services",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    sourceType: serviceSourceTypeEnum("source_type").notNull(),
    repositoryUrl: text("repository_url"),
    branch: text("branch"),
    buildContext: text("build_context"),
    dockerfilePath: text("dockerfile_path"),
    buildTarget: text("build_target"),
    imageRef: text("image_ref"),
    internalPort: integer("internal_port").notNull(),
    publishedPort: integer("published_port"),
    status: serviceStatusEnum("status").notNull().default("NEVER_DEPLOYED"),
    repositoryCredentialId: uuid("repository_credential_id").references(
      () => credentials.id,
      {
        onDelete: "restrict",
      },
    ),
    registryCredentialId: uuid("registry_credential_id").references(
      () => credentials.id,
      {
        onDelete: "restrict",
      },
    ),
    // 14-07: the TOFU-pinned SSH host key of a non-bundled Git host: the known_hosts host
    // (`host` or `[host]:port`) and its validated known_hosts lines. Public keys, not secrets,
    // but never part of an API view; set together or not at all.
    gitHostKeyHost: text("git_host_key_host"),
    gitHostKey: text("git_host_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "services_environment_project_fk",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }).onDelete("cascade"),
    uniqueIndex("services_environment_name_lower_unique_idx").on(
      table.environmentId,
      sql`lower(${table.name})`,
    ),
    check(
      "services_source_shape_check",
      sql`(${table.sourceType} = 'git' AND ${table.repositoryUrl} IS NOT NULL AND ${table.branch} IS NOT NULL AND ${table.buildContext} IS NOT NULL AND ${table.dockerfilePath} IS NOT NULL AND ${table.imageRef} IS NULL) OR (${table.sourceType} = 'image' AND ${table.imageRef} IS NOT NULL AND ${table.repositoryUrl} IS NULL AND ${table.branch} IS NULL AND ${table.buildContext} IS NULL AND ${table.dockerfilePath} IS NULL AND ${table.buildTarget} IS NULL)`,
    ),
    check(
      "services_git_host_key_pair_check",
      sql`(${table.gitHostKeyHost} IS NULL) = (${table.gitHostKey} IS NULL)`,
    ),
    check(
      "services_ports_range_check",
      sql`${table.internalPort} BETWEEN 1 AND 65535 AND (${table.publishedPort} IS NULL OR ${table.publishedPort} BETWEEN 1 AND 65535)`,
    ),
  ],
);
