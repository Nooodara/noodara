// The `pnpm db:migrate` entrypoint (QA-06). Fully non-interactive — no prompts, no TTY
// assumptions — because the phase-6 installer runs this inside a container. Must be the first
// import so INST-06's fail-fast env validation runs before a Pool is even constructed.
import '../env.js';

import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { env } from '../env.js';
import { createDb, type Database } from './client.js';

// Resolved next to this file's own location (not `process.cwd()`), so the folder is found
// identically whether this module runs as the CLI entrypoint or is imported by the Testcontainers
// integration harness (`tests/integration/helpers/postgres.ts`) via `runMigrations`.
export const MIGRATIONS_FOLDER = new URL('./migrations', import.meta.url).pathname;

/** Drizzle's own migration-tracking table (default name/schema, never overridden here). */
async function countAppliedMigrations(db: Database): Promise<number> {
  try {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from "drizzle"."__drizzle_migrations"`,
    );
    return result.rows[0]?.count ?? 0;
  } catch {
    // Table does not exist yet — this is the very first migration run.
    return 0;
  }
}

/**
 * Applies every pending migration in `MIGRATIONS_FOLDER` to `db`. The one migration path shared
 * by the CLI entrypoint below and by `tests/integration/helpers/postgres.ts`, so test setup and
 * production migration can never diverge.
 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

async function main(): Promise<void> {
  const { db, pool } = createDb(env.DATABASE_URL);

  try {
    const before = await countAppliedMigrations(db);
    const startedAt = Date.now();
    await runMigrations(db);
    const after = await countAppliedMigrations(db);
    const applied = after - before;
    process.stdout.write(
      `db:migrate completed in ${(Date.now() - startedAt).toString()}ms: ` +
        `${applied.toString()} migration(s) applied, ${after.toString()} total\n`,
    );
  } finally {
    await pool.end();
  }
}

// Only run as a CLI entrypoint (`pnpm db:migrate`), never when `runMigrations` is imported
// directly by the integration test harness.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error: unknown) => {
    // T-1-19: log the error message only, never the connection string or `DATABASE_URL`.
    const message = error instanceof Error ? error.message : 'Unknown migration error';
    process.stderr.write(`db:migrate failed: ${message}\n`);
    process.exit(1);
  });
}
