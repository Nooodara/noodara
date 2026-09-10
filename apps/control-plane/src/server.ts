// Must be the very first import: `env.ts`'s module-level `loadEnv(process.env)` call is the
// INST-06 fail-fast gate — it must run, and exit the process on failure, before anything else
// (Fastify, the DB pool, etc.) is even constructed.
import './env.js';

import { env } from './env.js';
import { buildApp } from './app.js';

const app = buildApp();

app.listen({ port: env.PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
