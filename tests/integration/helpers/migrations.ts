import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { MIGRATIONS_FOLDER } from '../../../apps/control-plane/src/db/migrate.js';

// The same bookkeeping table/schema names drizzle-orm's own `migrate()` uses by default
// (drizzle-orm/pg-core/dialect.js) — kept identical here so a database migrated partially by
// `applyMigrationsUpTo` looks, to a later call of the real `runMigrations`, exactly like one
// migrated partially by drizzle itself.
const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

interface Journal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: JournalEntry[];
}

function readJournalFile(): Journal {
  const journalPath = `${MIGRATIONS_FOLDER}/meta/_journal.json`;
  return JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
}

/**
 * The ordered list of every migration tag recorded in `meta/_journal.json`, oldest first — the
 * single source of truth both `applyMigrationsUpTo` below and the from-snapshot test in
 * `migrations.test.ts` use, so neither needs editing as migrations accumulate (01-CONTEXT.md:
 * "en esta fase el snapshot anterior es la migracion inicial").
 */
export function readJournal(): string[] {
  return readJournalFile().entries.map((entry) => entry.tag);
}

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(MIGRATIONS_SCHEMA)}`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

/**
 * Applies every migration up to and including `tag`, in journal order, and nothing after it.
 * `tag === null` applies nothing at all (useful for asserting an empty-database baseline).
 *
 * Each migration file is split on drizzle's own `--> statement-breakpoint` marker — never on bare
 * semicolons, which would break inside a `DO $$ ... END $$` function body or a quoted string —
 * and every statement chunk is executed in file order, exactly like
 * `drizzle-orm/node-postgres/migrator.js`'s `migrate()` does internally.
 *
 * After each migration file is applied, one row is written to the `drizzle.__drizzle_migrations`
 * bookkeeping table with the same hash (sha256 of the raw file contents) and `created_at`
 * (the journal entry's `when` timestamp) drizzle's real migrator would have written — so a later
 * call to the production `runMigrations` (apps/control-plane/src/db/migrate.ts) sees these
 * migrations as already applied and only runs whatever comes after `tag`, instead of re-running
 * (and failing on) statements that already ran.
 */
export async function applyMigrationsUpTo(db: Database, tag: string | null): Promise<void> {
  if (tag === null) {
    return;
  }

  const journal = readJournalFile();
  const targetIndex = journal.entries.findIndex((entry) => entry.tag === tag);
  if (targetIndex === -1) {
    throw new Error(`No journal entry found for tag "${tag}"`);
  }

  await ensureMigrationsTable(db);

  const entriesToApply = journal.entries.slice(0, targetIndex + 1);
  for (const entry of entriesToApply) {
    const migrationPath = `${MIGRATIONS_FOLDER}/${entry.tag}.sql`;
    const fileContents = readFileSync(migrationPath, 'utf8');
    const statements = fileContents.split('--> statement-breakpoint');
    const hash = createHash('sha256').update(fileContents).digest('hex');

    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }

    await db.execute(sql`
      insert into ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}
        ("hash", "created_at")
      values (${hash}, ${entry.when})
    `);
  }
}
