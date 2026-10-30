import { pgEnum } from "drizzle-orm/pg-core";
import { CERT_STATUSES, DNS_OUTCOMES, ENV_SCOPES, PROXY_STATUSES } from "@noodara/domain";

// v0.4 enums (migration 0014), derived from the domain tuples so the DB and the TS unions cannot
// drift (deployment-state.test.ts H2 checks the migrations against them).
export const domainCertStatusEnum = pgEnum("domain_cert_status", [...CERT_STATUSES]);
export const domainDnsStatusEnum = pgEnum("domain_dns_status", [...DNS_OUTCOMES]);
export const proxyStatusEnum = pgEnum("proxy_status", [...PROXY_STATUSES]);
export const envScopeEnum = pgEnum("env_scope", [...ENV_SCOPES]);
