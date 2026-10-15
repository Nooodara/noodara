import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import {
  DEFAULT_IMAGE_RETENTION,
  MAX_IMAGE_RETENTION,
  MIN_IMAGE_RETENTION,
  SERVICE_STATUSES,
  type HealthcheckConfig,
} from "@noodara/domain/deployment";
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
    // 16-06 (migration 0013). null = the default container healthcheck (ADR 0010).
    healthcheck: jsonb("healthcheck").$type<HealthcheckConfig>(),
    autoRollback: boolean("auto_rollback").notNull().default(true),
    imageRetention: integer("image_retention")
      .notNull()
      .default(DEFAULT_IMAGE_RETENTION),
    // Opaque random id in the public webhook URL, set together with the encrypted HMAC secret
    // (credentials envelope). The FK cascades: the secret credential exists only for this
    // service's hook, so no service row can outlive it pointing at a missing secret.
    webhookHookId: text("webhook_hook_id"),
    webhookSecretCredentialId: uuid("webhook_secret_credential_id").references(
      () => credentials.id,
      { onDelete: "cascade" },
    ),
    // The single coalesced push waiting for the active deployment to end (16-05, latest wins).
    pendingTriggerDeliveryId: text("pending_trigger_delivery_id"),
    pendingTriggerSha: text("pending_trigger_sha"),
    pendingTriggerAt: timestamp("pending_trigger_at", { withTimezone: true }),
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
    uniqueIndex("services_webhook_hook_id_unique_idx").on(table.webhookHookId),
    check(
      "services_webhook_hook_id_shape_check",
      sql`${table.webhookHookId} IS NULL OR ${table.webhookHookId} ~ '^[A-Za-z0-9_-]{22,64}$'`,
    ),
    check(
      "services_webhook_pair_check",
      sql`(${table.webhookHookId} IS NULL) = (${table.webhookSecretCredentialId} IS NULL)`,
    ),
    check(
      "services_pending_trigger_check",
      sql`(${table.pendingTriggerDeliveryId} IS NULL AND ${table.pendingTriggerSha} IS NULL AND ${table.pendingTriggerAt} IS NULL) OR (${table.pendingTriggerDeliveryId} IS NOT NULL AND ${table.pendingTriggerAt} IS NOT NULL AND ${table.pendingTriggerSha} IS NOT NULL AND ${table.pendingTriggerSha} ~ '^[0-9a-f]{40}$')`,
    ),
    check(
      "services_image_retention_range_check",
      sql.raw(
        `"image_retention" BETWEEN ${String(MIN_IMAGE_RETENTION)} AND ${String(MAX_IMAGE_RETENTION)}`,
      ),
    ),
    check(
      "services_healthcheck_object_check",
      sql`${table.healthcheck} IS NULL OR jsonb_typeof(${table.healthcheck}) = 'object'`,
    ),
    check(
      "services_ports_range_check",
      sql`${table.internalPort} BETWEEN 1 AND 65535 AND (${table.publishedPort} IS NULL OR ${table.publishedPort} BETWEEN 1 AND 65535)`,
    ),
  ],
);
