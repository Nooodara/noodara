import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** `'a', 'b'` for a CHECK ... IN list built from a domain tuple (constants, never user input). */
export function sqlInList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

interface OwnerColumns {
  readonly scope: PgColumn;
  readonly projectId: PgColumn;
  readonly environmentId: PgColumn;
  readonly serviceId: PgColumn;
}

/** The owner columns must match the scope: project rows name no environment or service, an
 *  environment row names only its environment, a service row only its service. */
export function scopeOwnerCheck(table: OwnerColumns): SQL {
  return sql`(${table.scope} = 'project' AND ${table.environmentId} IS NULL AND ${table.serviceId} IS NULL) OR (${table.scope} = 'environment' AND ${table.environmentId} IS NOT NULL AND ${table.serviceId} IS NULL) OR (${table.scope} = 'service' AND ${table.serviceId} IS NOT NULL AND ${table.environmentId} IS NULL)`;
}

/** The single owner id of a row (service, else environment, else project); uuidv7 ids never
 *  collide across tables, so (owner, key) is unique per owner whatever the scope. */
export function ownerIdExpression(table: OwnerColumns): SQL {
  return sql`COALESCE(${table.serviceId}, ${table.environmentId}, ${table.projectId})`;
}
