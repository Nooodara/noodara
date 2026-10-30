import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { CERT_FAILURE_CAUSES } from "@noodara/domain";
import { DOMAIN_APPLY_STATUSES, DOMAINS_HOSTNAME_UNIQUE_INDEX } from "@noodara/domain/api-contract";
import { projects } from "./projects.js";
import { services } from "./services.js";
import { domainCertStatusEnum, domainDnsStatusEnum } from "./v04-enums.js";
import { sqlInList } from "./v04-owner.js";

const MAX_HOSTNAME_LENGTH = 253;

// v0.4 (21-06, migration 0015). (service_id, project_id) -> services(id, project_id) makes a
// domain of another project's service impossible, like services -> environments (PROJ-04). The
// hostname is stored lowercased and unique across every service (DMN-01); the index name is the
// one the 21-05 unique-violation mapper turns into DOMAIN_ALREADY_ASSIGNED.
export const domains = pgTable(
  "domains",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").notNull(),
    hostname: text("hostname").notNull(),
    httpsRedirect: boolean("https_redirect").notNull().default(true),
    certStatus: domainCertStatusEnum("cert_status").notNull().default("NONE"),
    certNotAfter: timestamp("cert_not_after", { withTimezone: true }),
    certErrorCode: text("cert_error_code"),
    dnsStatus: domainDnsStatusEnum("dns_status"),
    dnsCheckedAt: timestamp("dns_checked_at", { withTimezone: true }),
    applyStatus: text("apply_status").notNull().default("PENDING"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "domains_service_project_fk",
      columns: [table.serviceId, table.projectId],
      foreignColumns: [services.id, services.projectId],
    }).onDelete("cascade"),
    uniqueIndex(DOMAINS_HOSTNAME_UNIQUE_INDEX).on(sql`lower(${table.hostname})`),
    check(
      "domains_hostname_shape_check",
      sql.raw(
        `"hostname" = lower("hostname") AND char_length("hostname") BETWEEN 1 AND ${String(MAX_HOSTNAME_LENGTH)}`,
      ),
    ),
    check(
      "domains_cert_error_code_check",
      sql.raw(`"cert_error_code" IS NULL OR "cert_error_code" IN (${sqlInList(CERT_FAILURE_CAUSES)})`),
    ),
    check("domains_apply_status_check", sql.raw(`"apply_status" IN (${sqlInList(DOMAIN_APPLY_STATUSES)})`)),
  ],
);
