// 31-11 (A1): every leaf field the AI read tools send to the model, derived from the backend's own
// projections (AI_READ_PROJECTIONS), never from a copy. A field is `free` when it can carry
// arbitrary text (a text/jsonb column, a string without a format or pattern) and `closed` otherwise
// (enums, numbers, booleans, uuids, timestamps, pattern-checked strings).
import { readFileSync } from 'node:fs';
import { AI_READ_PROJECTIONS } from '../../../../apps/control-plane/src/ai/tools/read-projections.js';

export type FieldKind = 'free' | 'closed';

const FREE_COLUMNS = new Set(['PgText', 'PgVarchar', 'PgChar', 'PgJsonb', 'PgJson']);

interface ZodLike {
  readonly _zod: { readonly def: Readonly<Record<string, unknown>> & { readonly type: string } };
}
interface ColumnLike {
  readonly columnType: string;
}

const isZod = (value: unknown): value is ZodLike => typeof value === 'object' && value !== null && '_zod' in value;
const child = (def: Readonly<Record<string, unknown>>, key: string): ZodLike => {
  const value = def[key];
  if (!isZod(value)) throw new Error(`zod def without ${key}`);
  return value;
};

function stringKind(def: Readonly<Record<string, unknown>>): FieldKind {
  if (typeof def.format === 'string') return 'closed';
  const checks = Array.isArray(def.checks) ? (def.checks as unknown[]) : [];
  return checks.some((check) => isZod(check) && check._zod.def.check === 'string_format') ? 'closed' : 'free';
}

const merge = (a: FieldKind | undefined, b: FieldKind): FieldKind => (a === 'free' || b === 'free' ? 'free' : 'closed');

function walk(schema: ZodLike, path: string, out: Map<string, FieldKind>): void {
  const def = schema._zod.def;
  const leaf = (kind: FieldKind) => out.set(path, merge(out.get(path), kind));
  switch (def.type) {
    case 'object':
      for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
        if (!isZod(value)) throw new Error(`${path}.${key}: not a zod schema`);
        walk(value, path === '' ? key : `${path}.${key}`, out);
      }
      return;
    case 'nullable':
    case 'optional':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      walk(child(def, 'innerType'), path, out);
      return;
    case 'pipe':
      walk(child(def, 'out'), path, out);
      return;
    case 'array':
      walk(child(def, 'element'), path, out);
      return;
    case 'record':
      walk(child(def, 'valueType'), `${path}.*`, out);
      return;
    case 'union':
      for (const option of def.options as unknown[]) {
        if (!isZod(option)) throw new Error(`${path}: union option is not a zod schema`);
        walk(option, path, out);
      }
      return;
    case 'intersection':
      walk(child(def, 'left'), path, out);
      walk(child(def, 'right'), path, out);
      return;
    case 'string':
      leaf(stringKind(def));
      return;
    case 'enum':
    case 'literal':
    case 'number':
    case 'int':
    case 'boolean':
    case 'null':
    case 'date':
    case 'bigint':
      leaf('closed');
      return;
    default:
      // A shape this walker does not know is a field nobody classified: fail loudly.
      throw new Error(`${path}: unsupported zod type ${def.type}`);
  }
}

/** `projection.path` → kind, over every projection the read tools send to the model. */
export function exposedFields(): Map<string, FieldKind> {
  const out = new Map<string, FieldKind>();
  for (const [projection, value] of Object.entries(AI_READ_PROJECTIONS)) {
    if (isZod(value)) {
      walk(value, projection, out);
      continue;
    }
    for (const [key, column] of Object.entries(value as Record<string, ColumnLike>))
      out.set(`${projection}.${key}`, FREE_COLUMNS.has(column.columnType) ? 'free' : 'closed');
  }
  return out;
}

// ---- threat model rows ------------------------------------------------------------------------

export const TRUST_SOURCES = ['user', 'host', 'external', 'noodara'] as const;
export type TrustSource = (typeof TRUST_SOURCES)[number];

export interface FieldRow {
  readonly field: string;
  readonly kind: FieldKind;
  readonly source: TrustSource;
  readonly mitigation: string;
  readonly cases: readonly string[];
}

export const REVIEW_FILE = new URL('../../../../docs/security/v0.5-review.md', import.meta.url);
const START = '<!-- ai-fields:start -->';
const END = '<!-- ai-fields:end -->';

/** The rows between the ai-fields markers: | `field` | kind | source | mitigation | cases |. */
export function threatModelRows(text: string = readFileSync(REVIEW_FILE, 'utf8')): FieldRow[] {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 || end < start) return [];
  const rows: FieldRow[] = [];
  for (const line of text.slice(start + START.length, end).split('\n')) {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    const field = /^`([^`]+)`$/.exec(cells[0] ?? '')?.[1];
    if (field === undefined || cells.length !== 5) continue;
    const [, kind, source, mitigation, cases] = cells as [string, string, string, string, string];
    if (kind !== 'free' && kind !== 'closed') throw new Error(`${field}: kind ${kind}`);
    if (!(TRUST_SOURCES as readonly string[]).includes(source)) throw new Error(`${field}: source ${source}`);
    rows.push({
      field,
      kind,
      source: source as TrustSource,
      mitigation,
      cases: [...cases.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1] ?? ''),
    });
  }
  return rows;
}
