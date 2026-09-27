// Pure identity validators: entity slugs, SSH user names and email addresses (roadmap §6.4,
// noodara-domain-model skill §1 slug convention). Reuses network.ts's shared `ValidationResult`
// so every validator in this package returns the same discriminated shape.

import { type ValidationResult, fail, ok } from './network.js';

// noodara-domain-model skill §1: entity names exposed to the user are a slug, unique within
// their parent. Uppercase is rejected outright (not lowercased) so a case-only difference is
// visible to the caller as a distinct, rejected input rather than silently accepted.
const SERVER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Starts with a letter or underscore (never a digit — some systems reserve leading-digit names),
// then up to 31 more letters/digits/underscore/hyphen (32 chars total). This single character
// class naturally excludes whitespace, `/`, `:` and every shell metacharacter without needing a
// separate check per forbidden character.
const SSH_USER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

// SET-02 discretion (09-CONTEXT.md): the admin's display name, 1-80 characters after trim, no
// control characters. C0 (\u0000-\u001F, \u007F) and C1 (\u0080-\u009F) control ranges are both
// rejected, matching the same control-character posture as `SecretValue` redaction elsewhere.
const MAX_NAME_LENGTH = 80;
// eslint-disable-next-line no-control-regex -- deliberately matching C0/C1 control characters
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Validates an entity slug (`Server.name` and later `Environment`/`Service` names) against the
 * skill's `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?` pattern. The success value is the input unchanged
 * (already lowercase by construction), so callers can compare case-insensitively for collisions.
 */
export function validateServerName(input: string): ValidationResult<string> {
  if (!SERVER_NAME_PATTERN.test(input)) {
    return fail(
      'SERVER_NAME_INVALID',
      'Server name must be a lowercase slug matching [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?',
    );
  }
  return ok(input);
}

/** Validates `Server.ssh_user` (skill §2). */
export function validateSshUser(input: string): ValidationResult<string> {
  if (!SSH_USER_PATTERN.test(input)) {
    return fail(
      'SSH_USER_INVALID',
      'SSH user must start with a letter or underscore, contain only letters, digits, "_" or "-", and be at most 32 characters',
    );
  }
  return ok(input);
}

/** Validates the single-admin email address (AUTH-01). The success value is lowercased. */
export function validateEmail(input: string): ValidationResult<string> {
  if (input.length > MAX_EMAIL_LENGTH) {
    return fail('EMAIL_INVALID', `Email must be at most ${MAX_EMAIL_LENGTH.toString()} characters`);
  }
  if (!EMAIL_PATTERN.test(input)) {
    return fail(
      'EMAIL_INVALID',
      'Email must contain "@" and a domain with a dot, with no leading or trailing whitespace',
    );
  }
  return ok(input.toLowerCase());
}

/**
 * Validates the admin's display name (SET-02). Trims surrounding whitespace, counts length by
 * Unicode code points (`[...trimmed].length`, not UTF-16 code units) so an 80-emoji name is not
 * rejected on a technicality, and rejects any control character.
 */
export function validateName(input: string): ValidationResult<string> {
  const trimmed = input.trim();
  const length = Array.from(trimmed).length;

  if (length < 1 || length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    return fail('NAME_INVALID', 'Name must be 1–80 characters.');
  }

  return ok(trimmed);
}

/** Validates an account email edit (SET-02 discretion): trim then the existing `validateEmail`. */
export function validateAccountEmail(input: string): ValidationResult<string> {
  return validateEmail(input.trim());
}
