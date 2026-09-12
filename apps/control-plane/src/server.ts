// Must be the very first import: `env.ts`'s module-level `loadEnv(process.env)` call is the
// INST-06 fail-fast gate — it must run, and exit the process on failure, before anything else
// (Fastify, the DB pool, etc.) is even constructed.
import './env.js';

import { auth } from './auth/auth.js';
import { bootstrapAdmin } from './boot/bootstrap-admin.js';
import { getDb } from './db/client.js';
import { env } from './env.js';
import { buildApp } from './app.js';

const app = buildApp();

async function main(): Promise<void> {
  const db = await getDb();

  // D-01/D-04: a boot that cannot establish an admin path must never start serving — this must
  // resolve (or throw and abort) before `app.listen` is ever called.
  try {
    await bootstrapAdmin({ db, auth, logger: app.log, env });
  } catch (err) {
    app.log.error({ err }, 'Admin bootstrap failed; refusing to start');
    process.exit(1);
    return;
  }

  app.listen({ port: env.PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
}

void main();
