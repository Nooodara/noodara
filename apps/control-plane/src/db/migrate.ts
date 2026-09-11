// The `pnpm db:migrate` entrypoint (QA-06). Fully non-interactive — no prompts, no TTY
// assumptions — because the phase-6 installer runs this inside a container.
//
// `env.ts` is deliberately NOT imported at module top level here: doing so would run INST-06's
// fail-fast `loadEnv(process.env)` the instant anything imports `runMigrations` — including the
// Testcontainers integration harness (`tests/integration/helpers/postgres.ts`), which supplies
// its own already-migrated connection string and has no reason to require the rest of the app's
// env vars (BETTER_AUTH_SECRET, REDIS_URL, ...) to exist. `env.js` is imported lazily inside
// `main()` instead, so it still runs — and still fail-fasts — first thing when this file is
// executed as the actual CLI entrypoint, but never as a side effect of importing this module.
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Database } from './client.js';

// Resolved next to this file's own location (not `process.cwd()`), so the folder is found
// identically whether this module runs as the CLI entrypoint or is imported by the Testcontainers
// integration harness via `runMigrations`.
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
  // INST-06 fail-fast gate: runs (and exits the process on failure) before the Pool below is
  // ever constructed.
  const { env } = await import('../env.js');
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
