// Environment variable keys and values, secret names and `<secret:name>` references (ENV-01,
// SCR-02, ADR 0011 A4). Validators return a result instead of throwing. A failure carries only
// the key (when valid), the byte length and the offending character class, never the input
// value: values may be secrets and names may be typos of one.

import type { ValidationFailure, ValidationSuccess } from '../validators/network.js';

export const MAX_ENV_KEY_LENGTH = 128;
/** 32 KiB: a maximal `KEY=VALUE` line stays far below the measured 65,535-byte line limit. */
export const MAX_ENV_VALUE_BYTES = 32 * 1024;
export const MAX_SECRET_NAME_LENGTH = 64;
export const MAX_ENV_VARS_PER_SCOPE = 200;
export const MAX_SECRETS_PER_SCOPE = 100;

export const ENV_ERROR_CODES = Object.freeze([
  'ENV_KEY_REQUIRED',
  'ENV_KEY_TOO_LONG',
  'ENV_KEY_INVALID',
  'ENV_VALUE_MULTILINE',
  'ENV_VALUE_INVALID_UTF8',
  'ENV_VALUE_TOO_LARGE',
  'ENV_SECRET_REF_MALFORMED',
  'SECRET_NAME_REQUIRED',
  'SECRET_NAME_TOO_LONG',
  'SECRET_NAME_INVALID',
  'SECRET_UNRESOLVED',
  'ENV_FILE_DUPLICATE_KEY',
  'ENV_FILE_TOO_LARGE',
] as const);

export type EnvErrorCode = (typeof ENV_ERROR_CODES)[number];

export type EnvCharacterClass =
  | 'newline'
  | 'carriage_return'
  | 'nul'
  | 'lone_surrogate'
  | 'leading_digit'
  | 'leading_non_letter'
  | 'lowercase'
  | 'uppercase'
  | 'whitespace'
  | 'control'
  | 'non_ascii'
  | 'symbol';

export interface UnresolvedSecretRef {
  readonly key: string;
  readonly reference: string;
}

/** A named env error. Never holds a value: only key, reference name, byte length, char class. */
export interface EnvFailure extends ValidationFailure {
  readonly code: EnvErrorCode;
  readonly key?: string;
  readonly reference?: string;
  readonly byteLength?: number;
  readonly characterClass?: EnvCharacterClass;
  readonly unresolved?: readonly UnresolvedSecretRef[];
}

export type EnvResult<T> = ValidationSuccess<T> | EnvFailure;

export type EnvValue =
  | { readonly kind: 'plain'; readonly value: string }
  | { readonly kind: 'secret_ref'; readonly name: string };

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_REF_PATTERN = /^<secret:([a-z][a-z0-9_]{0,63})>$/;
// Anything that looks like an attempt at a reference: case, spacing and position do not matter.
const SECRET_REF_ATTEMPT_PATTERN = /<\s*secret\s*:/i;
const LINE_BREAK_PATTERN = /[\n\r\0]/;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const WHITESPACE_PATTERN = /\s/;

const MULTILINE_MESSAGE =
  'Value must be a single line without NUL bytes; encode multi-line or binary values (certificates, keys) as base64';

/** UTF-8 length of `value`; a lone surrogate counts as its 3-byte U+FFFD replacement. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (isSurrogatePair(value, i)) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isSurrogatePair(value: string, index: number): boolean {
  const high = value.charCodeAt(index);
  const low = value.charCodeAt(index + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function failure(code: EnvErrorCode, message: string, fields: Omit<EnvFailure, 'ok' | 'code' | 'message'> = {}): EnvFailure {
  return { ok: false, code, message, ...fields };
}

function sharedClass(char: string, cp: number): EnvCharacterClass | null {
  if (WHITESPACE_PATTERN.test(char)) return 'whitespace';
  if (cp < 0x20 || cp === 0x7f) return 'control';
  if (cp > 0x7f) return 'non_ascii';
  return null;
}

function classifyKeyChar(char: string, index: number): EnvCharacterClass | null {
  if (/[A-Z_]/.test(char) || (index > 0 && /\d/.test(char))) return null;
  if (/[a-z]/.test(char)) return 'lowercase';
  const shared = sharedClass(char, char.charCodeAt(0));
  if (shared) return shared;
  return index === 0 && /\d/.test(char) ? 'leading_digit' : 'symbol';
}

function classifyNameChar(char: string, index: number): EnvCharacterClass | null {
  if (/[a-z]/.test(char) || (index > 0 && /[0-9_]/.test(char))) return null;
  if (/[A-Z]/.test(char)) return 'uppercase';
  const shared = sharedClass(char, char.charCodeAt(0));
  if (shared) return shared;
  return index === 0 ? 'leading_non_letter' : 'symbol';
}

function firstOffendingClass(
  value: string,
  classify: (char: string, index: number) => EnvCharacterClass | null,
): EnvCharacterClass | null {
  let index = 0;
  for (const char of value) {
    const characterClass = classify(char, index);
    if (characterClass) return characterClass;
    index += 1;
  }
  return null;
}

function isValidKey(key: string): boolean {
  return key.length <= MAX_ENV_KEY_LENGTH && ENV_KEY_PATTERN.test(key);
}

/** `{ key }` only for a valid key, so an invalid key (possibly a pasted value) is never echoed. */
function keyContext(key: string | undefined): { key?: string } {
  return key !== undefined && isValidKey(key) ? { key } : {};
}

export function validateEnvKey(key: string): EnvResult<string> {
  if (key.length === 0) return failure('ENV_KEY_REQUIRED', 'Variable name is required');
  if (key.length > MAX_ENV_KEY_LENGTH) {
    return failure(
      'ENV_KEY_TOO_LONG',
      `Variable name must be at most ${MAX_ENV_KEY_LENGTH.toString()} characters`,
      { byteLength: utf8ByteLength(key) },
    );
  }
  const characterClass = firstOffendingClass(key, classifyKeyChar);
  if (characterClass) {
    return failure(
      'ENV_KEY_INVALID',
      'Variable name must use A-Z, 0-9 and _ and must not start with a digit',
      { characterClass },
    );
  }
  return { ok: true, value: key };
}

/** Single-line, well-formed UTF-8, at most 32 KiB. `key` only adds context to the error. */
export function validateEnvValue(value: string, key?: string): EnvResult<string> {
  const lineBreak = LINE_BREAK_PATTERN.exec(value);
  if (lineBreak) {
    const char = lineBreak[0];
    const characterClass: EnvCharacterClass =
      char === '\n' ? 'newline' : char === '\r' ? 'carriage_return' : 'nul';
    return failure('ENV_VALUE_MULTILINE', MULTILINE_MESSAGE, {
      ...keyContext(key),
      characterClass,
    });
  }
  if (LONE_SURROGATE_PATTERN.test(value)) {
    return failure('ENV_VALUE_INVALID_UTF8', 'Value must be valid UTF-8 text', {
      ...keyContext(key),
      characterClass: 'lone_surrogate',
    });
  }
  const byteLength = utf8ByteLength(value);
  if (byteLength > MAX_ENV_VALUE_BYTES) {
    return failure(
      'ENV_VALUE_TOO_LARGE',
      `Value must be at most ${MAX_ENV_VALUE_BYTES.toString()} bytes`,
      { ...keyContext(key), byteLength },
    );
  }
  return { ok: true, value };
}

export function validateSecretName(name: string): EnvResult<string> {
  if (name.length === 0) return failure('SECRET_NAME_REQUIRED', 'Secret name is required');
  if (name.length > MAX_SECRET_NAME_LENGTH) {
    return failure(
      'SECRET_NAME_TOO_LONG',
      `Secret name must be at most ${MAX_SECRET_NAME_LENGTH.toString()} characters`,
      { byteLength: utf8ByteLength(name) },
    );
  }
  const characterClass = firstOffendingClass(name, classifyNameChar);
  if (characterClass) {
    return failure('SECRET_NAME_INVALID', 'Secret name must start with a-z and use only a-z, 0-9 and _', {
      characterClass,
    });
  }
  return { ok: true, value: name };
}

/**
 * Validates `value` and classifies it. Exactly `<secret:name>` (the whole string) is a reference;
 * anything else that looks like a reference attempt is ENV_SECRET_REF_MALFORMED, so a typo can
 * never reach a container as a literal value. Everything else is plain.
 */
export function parseEnvValue(value: string, key?: string): EnvResult<EnvValue> {
  const valid = validateEnvValue(value, key);
  if (!valid.ok) return valid;
  const match = SECRET_REF_PATTERN.exec(value);
  if (match?.[1] !== undefined) return { ok: true, value: { kind: 'secret_ref', name: match[1] } };
  if (SECRET_REF_ATTEMPT_PATTERN.test(value)) {
    return failure(
      'ENV_SECRET_REF_MALFORMED',
      'A secret reference must be the whole value, written exactly as <secret:name> with name in a-z, 0-9 and _',
      { ...keyContext(key), byteLength: utf8ByteLength(value) },
    );
  }
  return { ok: true, value: { kind: 'plain', value } };
}
