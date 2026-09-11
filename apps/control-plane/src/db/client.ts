import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Builds a fresh Drizzle client bound to `connectionString`, over its own `pg.Pool`. Used by
 * `getDb()` below, by `migrate.ts`, and by the Testcontainers integration harness
 * (`tests/integration/helpers/postgres.ts`) so test setup and production migration share the same
 * connection path instead of diverging.
 */
export function createDb(connectionString: string): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString });
  // node-postgres's own docs: an idle pooled client emits 'error' when its connection is lost
  // (network blip, database restart/shutdown) — an unlistened 'error' event on an EventEmitter
  // crashes the process. No infrastructure failure may take down the API (CLAUDE.md §2.2); the
  // next query against the pool simply establishes a fresh client.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool };
}

let cached: { db: Database; pool: Pool } | undefined;

/**
 * The default control-plane database client, lazily created on first access and bound to
 * `env.DATABASE_URL` — never a bare `process.env.DATABASE_URL` read (INST-06). `env.js` is
 * imported dynamically here (not at module top level) so that importing `createDb` alone — as
 * the Testcontainers integration harness does — never triggers INST-06's fail-fast env
 * validation as a side effect.
 */
export async function getDb(): Promise<Database> {
  if (!cached) {
    const { env } = await import('../env.js');
    cached = createDb(env.DATABASE_URL);
  }
  return cached.db;
}
