import { defineConfig } from 'drizzle-kit';
import { env } from './src/env.js';

// QA-06: drizzle-kit only ever *generates* versioned SQL migrations here (`db:generate`). There
// is deliberately no `db:push` script anywhere in this package — push has no migration file, so
// it cannot satisfy QA-06's "versioned migrations" requirement or PITFALLS.md #10's defensive-SQL
// review step.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
