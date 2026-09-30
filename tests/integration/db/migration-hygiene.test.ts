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
const ADD_VALUE = /ALTER\s+TYPE\b[\s\S]*?\bADD\s+VALUE\b/i;
const ADD_VALUE_GUARDED = /ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'/i;
const ADD_VALUE_LITERAL = /ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi;

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

  // T-11-15: drizzle-orm's migrator runs every pending migration inside ONE transaction, and
  // PostgreSQL forbids using an enum value in the transaction that added it ("unsafe use of new
  // value"). A fresh install runs 0000..latest together, so no statement in ANY migration may
  // reference a value added by `ALTER TYPE ... ADD VALUE` anywhere.
  const addedEnumValues = [
    ...new Set(
      migrationFiles.flatMap((file) =>
        file.statements.flatMap((statement) =>
          [...statement.matchAll(ADD_VALUE_LITERAL)].map((match) => match[1] ?? ''),
        ),
      ),
    ),
  ].filter((value) => value.length > 0);

  it.each(statementCases.filter(({ statement }) => ADD_VALUE.test(statement)))(
    '$label guards ALTER TYPE ... ADD VALUE with IF NOT EXISTS',
    ({ fileName, statement }) => {
      expect(statement, `${fileName}: ADD VALUE without IF NOT EXISTS: ${statement}`).toMatch(
        ADD_VALUE_GUARDED,
      );
    },
  );

  it('no migration statement references an enum value added by ADD VALUE', () => {
    const offenders = statementCases
      .filter(({ statement }) => !ADD_VALUE.test(statement))
      .flatMap(({ label, statement }) =>
        addedEnumValues
          .filter((value) => statement.includes(`'${value}'`))
          .map((value) => `${label} uses '${value}'`),
      );

    expect(offenders).toEqual([]);
  });

  it('the guard itself detects the ADD VALUE literals it must protect', () => {
    const sample = `ALTER TYPE "public"."credential_type" ADD VALUE IF NOT EXISTS 'git_deploy_key';`;

    expect([...sample.matchAll(ADD_VALUE_LITERAL)].map((match) => match[1])).toEqual([
      'git_deploy_key',
    ]);
    expect(addedEnumValues).toEqual(
      expect.arrayContaining(['git_deploy_key', 'git_https_token', 'registry_password']),
    );
  });
});
