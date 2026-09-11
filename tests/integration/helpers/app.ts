import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { startPostgres, type PostgresFixture } from './postgres.js';

export interface TestAppFixture {
  app: FastifyInstance;
  db: PostgresFixture['db'];
  stop: () => Promise<void>;
}

/**
 * `env.ts` fail-fasts by reading `process.env` at *module import time* (INST-06) — there is no
 * injectable-env parameter on `buildApp()` (Plan 01-03's `app.ts` is intentionally never touched
 * again by downstream plans until they own a specific route file). So a complete, valid test
 * environment is written to `process.env` *before* `app.ts` is imported for the first time in
 * this module graph, exactly like `vitest.config.ts`'s `apps` project already does for unit tests
 * — the only difference here is `DATABASE_URL` points at a live, freshly migrated container
 * instead of a fixture string that is never actually connected to.
 */
function setTestEnv(connectionString: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
}

/**
 * Starts a migrated, isolated PostgreSQL (`startPostgres()`) and a fully built Fastify app in one
 * call. Every later integration plan in this phase (01-08..01-14) uses this as its one entrypoint.
 */
export async function startTestApp(): Promise<TestAppFixture> {
  const postgres = await startPostgres();
  setTestEnv(postgres.connectionString);

  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const app = buildApp();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await app.close();
    await postgres.stop();
  };

  return { app, db: postgres.db, stop };
}
