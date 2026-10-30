// Deterministic JSON for files Traefik reads as YAML (JSON is valid YAML 1.2): object keys sorted
// at every level, two-space indent, trailing newline. Same input, same bytes.

export type JsonValue = string | number | boolean | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object') {
    const record = value as JsonObject;
    const sorted: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1))) {
      sorted[key] = sortKeys(child);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
