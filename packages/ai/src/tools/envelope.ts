// 28-03 (A3, H1): every tool result reaches the model as one fixed JSON envelope
// {tool, scope, truncated, data}, never as free text. `data` is redacted first and then capped:
// long strings are cut and the largest arrays shortened until the serialized envelope fits.
import type { Redactor } from '@noodara/domain/security';
import { isAIToolName, type ToolTarget } from './types.js';

export const AI_TOOL_RESULT_MAX_BYTES = 32 * 1024;
export const AI_TOOL_STRING_MAX_CHARS = 2000;
/** Room for the envelope keys around `data`. */
const ENVELOPE_OVERHEAD_BYTES = 256;
const MAX_SHRINK_ROUNDS = 64;

export interface ToolEnvelope {
  /** The tool name, or 'invalid' when the model named something that is not a tool name. */
  readonly tool: string;
  /** The entity this call targeted, or null for an unscoped list. */
  readonly scope: ToolTarget | null;
  readonly truncated: boolean;
  readonly data: unknown;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON.stringify is typed as string but answers undefined for undefined and functions. */
function stringify(value: unknown): string | undefined {
  const text: string | undefined = JSON.stringify(value);
  return text;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(stringify(value) ?? 'null', 'utf8');
}

/** Dates become ISO strings, undefined and functions disappear, exactly as JSON would send them. */
function toJson(value: unknown): Json {
  const text = stringify(value);
  return text === undefined ? null : (JSON.parse(text) as Json);
}

function clampStrings(value: Json, maxChars: number, flag: { truncated: boolean }): Json {
  if (typeof value === 'string') {
    if (value.length <= maxChars) return value;
    flag.truncated = true;
    return value.slice(0, maxChars);
  }
  if (Array.isArray(value)) return value.map((item) => clampStrings(item, maxChars, flag));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) out[key] = clampStrings(item, maxChars, flag);
    return out;
  }
  return value;
}

interface ArraySlot {
  readonly array: Json[];
  readonly bytes: number;
}

function collectArrays(value: Json, out: ArraySlot[]): void {
  if (Array.isArray(value)) {
    if (value.length > 0) out.push({ array: value, bytes: byteLength(value) });
    for (const item of value) collectArrays(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectArrays(item, out);
  }
}

/** Shortens the largest non-empty array in place; false when there is none left to shorten. */
function shrinkLargestArray(value: Json, size: number, maxBytes: number): boolean {
  const slots: ArraySlot[] = [];
  collectArrays(value, slots);
  let largest: ArraySlot | undefined;
  for (const slot of slots) if (largest === undefined || slot.bytes > largest.bytes) largest = slot;
  if (largest === undefined) return false;
  const { array } = largest;
  const ratio = Math.min(0.9, maxBytes / size);
  const keep = Math.min(array.length - 1, Math.floor(array.length * ratio));
  array.length = Math.max(0, keep);
  return true;
}

export interface CappedData {
  readonly data: Json;
  readonly truncated: boolean;
}

/** Caps `data` so its JSON fits in `maxBytes`; when nothing more can be cut, data becomes null. */
export function capToolData(data: unknown, maxBytes: number, maxChars: number = AI_TOOL_STRING_MAX_CHARS): CappedData {
  const flag = { truncated: false };
  const value = clampStrings(toJson(data), maxChars, flag);
  for (let round = 0; round < MAX_SHRINK_ROUNDS; round += 1) {
    const size = byteLength(value);
    if (size <= maxBytes) return { data: value, truncated: flag.truncated };
    if (!shrinkLargestArray(value, size, maxBytes)) break;
    flag.truncated = true;
  }
  return byteLength(value) <= maxBytes ? { data: value, truncated: true } : { data: null, truncated: true };
}

export interface EnvelopeInput {
  readonly tool: string;
  readonly scope: ToolTarget | null;
  readonly data: unknown;
  /** Already truncated upstream (e.g. a capped log page). */
  readonly truncated?: boolean;
}

/** Redacts, caps and wraps one result. The model receives `JSON.stringify(envelope)` only. */
export function buildToolEnvelope(input: EnvelopeInput, redactor: Redactor, maxBytes: number = AI_TOOL_RESULT_MAX_BYTES): ToolEnvelope {
  const redacted = redactor.redact(toJson(input.data));
  const scope = input.scope === null ? null : { kind: input.scope.kind, id: input.scope.id };
  const capped = capToolData(redacted, Math.max(0, maxBytes - ENVELOPE_OVERHEAD_BYTES));
  return {
    tool: isAIToolName(input.tool) ? input.tool : 'invalid',
    scope,
    truncated: capped.truncated || input.truncated === true,
    data: capped.data,
  };
}

export function serializeToolEnvelope(envelope: ToolEnvelope): string {
  return JSON.stringify({ tool: envelope.tool, scope: envelope.scope, truncated: envelope.truncated, data: envelope.data });
}
