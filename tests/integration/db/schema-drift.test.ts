import { is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig, isPgEnum, type PgEnum } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import * as schema from '../../../apps/control-plane/src/db/schema/index.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 26-05 A2: the Drizzle schema (what the code reads and writes) and the database the versioned
// migrations build must agree: tables, columns (type, nullability), indexes, foreign keys
// (target and ON DELETE) and enum values, in both directions.

const tables = Object.values(schema).filter((value): value is PgTable => is(value, PgTable));
const enums = Object.values(schema).filter((value): value is PgEnum<[string, ...string[]]> => isPgEnum(value));

const ON_DELETE: Record<string, string> = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly type: string;
  readonly not_null: boolean;
}

interface ForeignKeyRow {
  readonly table_name: string;
  readonly name: string;
  readonly columns: string;
  readonly foreign_table: string;
  readonly foreign_columns: string;
  readonly on_delete: string;
}

let fixture: PostgresFixture | undefined;

function db(): Database {
  if (fixture === undefined) throw new Error('postgres fixture not started');
  return fixture.db;
}

beforeAll(async () => {
  fixture = await startPostgres();
});

afterAll(async () => {
  await fixture?.stop();
  fixture = undefined;
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  expect(containers.filter((container) => container.Labels['noodara.test'] === 'true')).toHaveLength(0);
});

describe('Drizzle schema vs migrated database (26-05 A2)', () => {
  it('every public table is in the Drizzle barrel and every barrel table exists', async () => {
    const result = await db().execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
    `);
    const inDatabase = result.rows.map((row) => row.table_name).sort();
    const inSchema = tables.map((table) => getTableConfig(table).name).sort();
    expect(inSchema).toEqual(expect.arrayContaining(['ai_messages', 'host_metric_samples', 'servers']));
    expect(enums.map((pgEnum) => pgEnum.enumName)).toContain('credential_type');
    expect(inDatabase).toEqual(inSchema);
  });

  it('columns agree on name, type and nullability', async () => {
    const result = await db().execute<ColumnRow>(sql`
      select c.relname as table_name, a.attname as column_name,
        format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    `);
    const inDatabase = result.rows.map((row) => `${row.table_name}.${row.column_name} ${row.type}${row.not_null ? ' not null' : ''}`).sort();
    const inSchema = tables
      .flatMap((table) => {
        const config = getTableConfig(table);
        return config.columns.map(
          (column) => `${config.name}.${column.name} ${column.getSQLType()}${column.notNull ? ' not null' : ''}`,
        );
      })
      .sort();
    expect(inDatabase).toEqual(inSchema);
  });

  it('indexes agree by name, table and uniqueness', async () => {
    const result = await db().execute<{ table_name: string; index_name: string; unique: boolean }>(sql`
      select t.relname as table_name, i.relname as index_name, x.indisunique as unique
      from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and not x.indisprimary
        and not exists (select 1 from pg_constraint k where k.conindid = x.indexrelid and k.contype = 'u')
    `);
    const inDatabase = result.rows.map((row) => `${row.table_name}.${row.index_name}${row.unique ? ' unique' : ''}`).sort();
    const inSchema = tables
      .flatMap((table) => {
        const config = getTableConfig(table);
        return config.indexes.map(
          (index) => `${config.name}.${index.config.name ?? '?'}${index.config.unique ? ' unique' : ''}`,
        );
      })
      .sort();
    expect(inDatabase).toEqual(inSchema);
  });

  it('foreign keys agree on columns, target and ON DELETE', async () => {
    const result = await db().execute<ForeignKeyRow>(sql`
      select t.relname as table_name, k.conname as name,
        (select string_agg(a.attname, ',' order by u.ord) from unnest(k.conkey) with ordinality u(attnum, ord)
          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum) as columns,
        f.relname as foreign_table,
        (select string_agg(a.attname, ',' order by u.ord) from unnest(k.confkey) with ordinality u(attnum, ord)
          join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum) as foreign_columns,
        k.confdeltype::text as on_delete
      from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_class f on f.oid = k.confrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and k.contype = 'f'
    `);
    const inDatabase = result.rows
      .map(
        (row) =>
          `${row.table_name}(${row.columns}) -> ${row.foreign_table}(${row.foreign_columns}) on delete ${ON_DELETE[row.on_delete] ?? row.on_delete}`,
      )
      .sort();
    const inSchema = tables
      .flatMap((table) => {
        const config = getTableConfig(table);
        return config.foreignKeys.map((foreignKey) => {
          const reference = foreignKey.reference();
          const target = getTableConfig(reference.foreignTable).name;
          return `${config.name}(${reference.columns.map((column) => column.name).join(',')}) -> ${target}(${reference.foreignColumns
            .map((column) => column.name)
            .join(',')}) on delete ${foreignKey.onDelete ?? 'no action'}`;
        });
      })
      .sort();
    expect(inDatabase).toEqual(inSchema);
  });

  it('enums agree on name and values', async () => {
    const result = await db().execute<{ typname: string; labels: string[] }>(sql`
      select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
      from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' group by t.typname
    `);
    const inDatabase = Object.fromEntries(result.rows.map((row) => [row.typname, [...row.labels].sort()]));
    const inSchema = Object.fromEntries(enums.map((pgEnum) => [pgEnum.enumName, [...pgEnum.enumValues].sort()]));
    expect(inDatabase).toEqual(inSchema);
  });
});
