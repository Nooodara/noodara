import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../../../apps/control-plane/src/db/migrate.js';
import { readJournal } from '../helpers/migrations.js';

interface MigrationFile {
  readonly tag: string;
  readonly fileName: string;
  readonly statements: string[];
}

function isCommentOnly(statement: string): boolean {
  const meaningfulLines = statement
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'));
  return meaningfulLines.length === 0;
}

function readMigrationFiles(): MigrationFile[] {
  const fileNames = readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith('.sql'));
  return fileNames.map((fileName) => {
    const tag = fileName.replace(/\.sql$/, '');
    const contents = readFileSync(`${MIGRATIONS_FOLDER}/${fileName}`, 'utf8');
    const statements = contents
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0 && !isCommentOnly(statement));
    return { tag, fileName, statements };
  });
}

// T-1-21: a migration reaching main that is not defensive breaks a real in-place upgrade the
// moment it runs against a database that already has the object it tries to create/drop —
// exactly the failure mode PITFALLS.md documents Coolify hitting four separate times.
const CREATE_TABLE_WITHOUT_GUARD = /CREATE\s+TABLE\s+(?!IF NOT EXISTS)/i;
const CREATE_INDEX_WITHOUT_GUARD = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/i;
const DROP_WITHOUT_GUARD = /\bDROP\s+(TABLE|INDEX|TYPE|CONSTRAINT)\s+(?!IF EXISTS)/i;
const CREATE_TYPE = /CREATE\s+TYPE\b/i;

describe('migration hygiene guard (QA-06, T-1-21)', () => {
  const migrationFiles = readMigrationFiles();

  it('finds at least one migration file to guard', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it('every migration file on disk is listed in the journal and vice versa', () => {
    const journalTags = [...readJournal()].sort();
    const fileTags = migrationFiles.map((file) => file.tag).sort();

    expect(fileTags).toEqual(journalTags);
  });

  const statementCases = migrationFiles.flatMap((file) =>
    file.statements.map((statement, index) => ({
      label: `${file.fileName} statement #${index.toString()}`,
      fileName: file.fileName,
      statement,
    })),
  );

  it.each(statementCases)(
    '$label is defensive (guarded CREATE TABLE/INDEX, guarded DROP, guarded CREATE TYPE)',
    ({ fileName, statement }) => {
      expect(
        statement,
        `${fileName}: unguarded CREATE TABLE (missing IF NOT EXISTS): ${statement}`,
      ).not.toMatch(CREATE_TABLE_WITHOUT_GUARD);

      expect(
        statement,
        `${fileName}: unguarded CREATE INDEX (missing IF NOT EXISTS): ${statement}`,
      ).not.toMatch(CREATE_INDEX_WITHOUT_GUARD);

      expect(statement, `${fileName}: unguarded DROP (missing IF EXISTS): ${statement}`).not.toMatch(
        DROP_WITHOUT_GUARD,
      );

      if (CREATE_TYPE.test(statement)) {
        // Postgres has no `CREATE TYPE IF NOT EXISTS`; the defensive shape this project uses
        // instead wraps it in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN null; END $$`
        // (01-07-SUMMARY.md), which the drizzle statement-breakpoint split keeps as one chunk.
        expect(statement, `${fileName}: CREATE TYPE not guarded against re-run: ${statement}`).toMatch(
          /EXCEPTION/i,
        );
        expect(statement, `${fileName}: CREATE TYPE not guarded against re-run: ${statement}`).toMatch(
          /duplicate_object/i,
        );
      }
    },
  );
});
