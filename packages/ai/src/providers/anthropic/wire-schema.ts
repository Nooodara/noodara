// Anthropic strict tools reject numeric bounds and array size constraints other than minItems 0/1
// with a 400. The wire schema drops them and repeats them in the description as a hint; the tool's
// own Zod schema still enforces them on every call (tools/definitions.ts).

type Schema = Record<string, unknown>;

const NUMERIC = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] as const;
/** Keywords whose value is a map of name -> subschema. */
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
/** Keywords whose value is one subschema. */
const SCHEMA_ONE = new Set(['items', 'additionalProperties', 'not', 'contains', 'if', 'then', 'else', 'propertyNames']);
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LIST = new Set(['anyOf', 'allOf', 'oneOf', 'prefixItems']);

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unsupported(key: string, value: unknown): boolean {
  if ((NUMERIC as readonly string[]).includes(key) || key === 'maxItems') return true;
  return key === 'minItems' && value !== 0 && value !== 1;
}

function sanitize(schema: Schema): Schema {
  const out: Schema = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (unsupported(key, value)) {
      dropped.push(`${key}: ${JSON.stringify(value)}`);
    } else if (SCHEMA_MAPS.has(key) && isSchema(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, isSchema(sub) ? sanitize(sub) : sub]),
      );
    } else if (SCHEMA_ONE.has(key) && isSchema(value)) {
      out[key] = sanitize(value);
    } else if (SCHEMA_LIST.has(key) && Array.isArray(value)) {
      out[key] = value.map((sub: unknown) => (isSchema(sub) ? sanitize(sub) : sub));
    } else {
      out[key] = value;
    }
  }
  if (dropped.length > 0) {
    const hint = `(${dropped.join(', ')})`;
    out.description = typeof out.description === 'string' && out.description !== '' ? `${out.description} ${hint}` : hint;
  }
  return out;
}

/** A copy of a tool input schema that Anthropic strict mode accepts. Pure; never mutates. */
export function toAnthropicInputSchema(schema: Readonly<Schema>): Schema {
  return sanitize(schema);
}
