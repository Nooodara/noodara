import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { env } from '../env.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Builds a fresh Drizzle client bound to `connectionString`, over its own `pg.Pool`. Used by
 * `db.ts`'s lazy default export, by `migrate.ts`, and by the Testcontainers integration harness
 * (`tests/integration/helpers/postgres.ts`) so test setup and production migration share the same
 * connection path instead of diverging.
 */
export function createDb(connectionString: string): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool };
}

let cached: { db: Database; pool: Pool } | undefined;

/**
 * The default control-plane database client, lazily created on first access and bound to
 * `env.DATABASE_URL` — never a bare `process.env.DATABASE_URL` read (INST-06).
 */
export function getDb(): Database {
  cached ??= createDb(env.DATABASE_URL);
  return cached.db;
}
