import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type Database } from '../../../apps/control-plane/src/db/client.js';
import { runMigrations } from '../../../apps/control-plane/src/db/migrate.js';

export interface PostgresFixture {
  container: StartedPostgreSqlContainer;
  connectionString: string;
  db: Database;
  /** Safe to call more than once. */
  stop: () => Promise<void>;
}

/**
 * Starts a fresh `postgres:17-alpine` container, applies every migration via the exact same
 * `runMigrations` function `src/db/migrate.ts`'s CLI entrypoint uses — never a shelled-out
 * `pnpm db:migrate` — so test setup and production migration can never diverge (noodara-tdd
 * skill §5). The container's own wait strategy (health check + listening ports) gates readiness;
 * this module never pauses for a fixed, arbitrary duration.
 */
export async function startPostgres(): Promise<PostgresFixture> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    // Labelled so the suite-level cleanup assertion (noodara-tdd skill §5) can find any stray
    // container left behind by a crashed run.
    .withLabels({ 'noodara.test': 'true' })
    .start();

  const connectionString = container.getConnectionUri();
  const { db, pool } = createDb(connectionString);

  await runMigrations(db);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await pool.end();
    await container.stop();
  };

  return { container, connectionString, db, stop };
}
