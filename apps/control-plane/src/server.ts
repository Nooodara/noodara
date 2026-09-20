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
      // WR-A-04: a bare `Error` as pino's first argument bypasses `logger.ts`'s `err` serializer
      // for the record's own `msg` field (pino independently copies `err.message` there) even
      // though the serializer still runs on the `err` key itself -- the merging-object form is
      // what keeps the raw message out of the log line, matching the precedent already used
      // correctly elsewhere in this codebase (`queue/connect-server-worker.ts`'s `{ jobId, err }`).
      app.log.error({ err }, 'listen failed');
      process.exit(1);
    }
  });
}

void main();
