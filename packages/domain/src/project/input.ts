// Shared shape checks for untyped create/edit bodies (API body, DB row) in this module.

import { type ValidationResult, fail, ok } from '../validators/network.js';

export type InputRecord = Readonly<Record<string, unknown>>;

/**
 * Accepts a plain object whose keys are all in `allowed`. Anything else fails with
 * `<prefix>_INVALID`; the first unknown key fails by name with `<prefix>_UNSUPPORTED_FIELD`, so
 * `buildArgs`/`env` never pass silently.
 */
export function parseInputRecord(
  input: unknown,
  allowed: readonly string[],
  prefix: string,
  entity: string,
): ValidationResult<InputRecord> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(`${prefix}_INVALID`, `${entity} input must be an object`);
  }
  const record = input as InputRecord;
  const unsupported = Object.keys(record).find((key) => !allowed.includes(key));
  if (unsupported !== undefined) {
    return fail(`${prefix}_UNSUPPORTED_FIELD`, `${entity} field "${unsupported}" is not supported`);
  }
  return ok(record);
}

export function hasKey(record: InputRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// C0 and C1 control characters plus the bidi embedding/override/isolate controls that can make
// a name render differently from its stored value ("Trojan Source").
/* eslint-disable no-control-regex -- deliberately matching control characters */
export const UNSAFE_TEXT_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
/* eslint-enable no-control-regex */

/** Entity slug of the domain-model skill section 1, at most 63 characters. */
export const ENTITY_SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
