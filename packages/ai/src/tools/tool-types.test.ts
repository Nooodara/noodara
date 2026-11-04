// 28-03 A2: `kind` admits only 'read' at the type level, and no argument is a free string that
// could reach SSH or a shell. The ts-expect-error lines are checked by `pnpm typecheck`.
import { describe, expect, it } from 'vitest';
import { READ_ONLY_TOOLS } from './definitions.js';
import { AI_TOOL_NAMES, type AITool, type AIToolKind, type ReadToolBackend } from './types.js';

describe('AITool kind (type level)', () => {
  it('admits only read', () => {
    const kind: AIToolKind = 'read';
    // @ts-expect-error a write kind does not compile
    const write: AIToolKind = 'write';
    // @ts-expect-error an exec kind does not compile
    const exec: AIToolKind = 'exec';
    expect([kind, write, exec]).toHaveLength(3);
  });

  it('a tool literal with a write kind does not compile', () => {
    const base = READ_ONLY_TOOLS.get_server;
    // @ts-expect-error kind must be 'read'
    const forged: AITool<'get_server'> = { ...base, kind: 'write' };
    expect(forged.name).toBe('get_server');
  });

  it('a backend cannot add a write method', () => {
    type Keys = keyof ReadToolBackend;
    // @ts-expect-error restart is not a tool
    const restart: Keys = 'restart';
    // @ts-expect-error deploy is not a tool
    const deploy: Keys = 'deploy';
    expect([restart, deploy]).toHaveLength(2);
  });

  it('every runtime tool is kind read', () => {
    for (const name of AI_TOOL_NAMES) expect(READ_ONLY_TOOLS[name].kind).toBe('read');
  });
});

type Schema = Record<string, unknown> & { properties?: Record<string, Schema>; items?: Schema };

/** Collects every string-typed leaf that is not a uuid, a timestamp or an enum. */
function freeStrings(schema: Schema, path: string, out: string[]): void {
  if (schema.type === 'string' && schema.format === undefined && schema.enum === undefined && schema.pattern === undefined) {
    out.push(path);
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) freeStrings(child, `${path}.${key}`, out);
  if (schema.items !== undefined) freeStrings(schema.items, `${path}[]`, out);
}

describe('tool arguments', () => {
  it('only get_logs.search is a free string, and it is a bounded substring', () => {
    const found: string[] = [];
    for (const name of AI_TOOL_NAMES) freeStrings(READ_ONLY_TOOLS[name].inputSchema, name, found);
    expect(found).toEqual(['get_logs.search']);
    const search = (READ_ONLY_TOOLS.get_logs.inputSchema as Schema).properties?.search;
    expect(search?.maxLength).toBe(200);
  });

  it('every schema rejects unknown keys', () => {
    for (const name of AI_TOOL_NAMES) {
      expect((READ_ONLY_TOOLS[name].inputSchema as Schema).additionalProperties).toBe(false);
    }
  });
});
