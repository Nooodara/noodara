// Admin password policy (AUTH-02, D-01..D-04's single-admin auth). Claude's Discretion in
// 01-CONTEXT.md: minimum 12 characters, no composition rules, rejection of common passwords, no
// expiry. Reuses network.ts's shared `ValidationResult` shape.

import { type ValidationResult, assertDefined, fail, ok } from './network.js';
import { COMMON_PASSWORDS } from './common-passwords.js';

/** AUTH-02: minimum length for the admin password. No composition rule is layered on top. */
export const PASSWORD_MIN_LENGTH = 12;

/** argon2's practical input bound, not a composition rule — protects against hashing very long
 *  attacker-supplied strings rather than encoding any "strength" requirement. */
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordValidationContext {
  readonly email?: string;
}

/**
 * Validates a candidate admin password. Checks run in this order — length lower bound, length
 * upper bound, identifier equality, common-password membership — and a failure `message` never
 * echoes the submitted password (T-1-14).
 */
export function validatePassword(
  password: string,
  context: PasswordValidationContext = {},
): ValidationResult<string> {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return fail(
      'PASSWORD_TOO_SHORT',
      `Password must be at least ${PASSWORD_MIN_LENGTH.toString()} characters`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return fail(
      'PASSWORD_TOO_LONG',
      `Password must be at most ${PASSWORD_MAX_LENGTH.toString()} characters`,
    );
  }

  const lowerPassword = password.toLowerCase();

  if (context.email !== undefined) {
    const lowerEmail = context.email.toLowerCase();
    const localPart = assertDefined(lowerEmail.split('@')[0]);
    if (lowerPassword === lowerEmail || lowerPassword === localPart) {
      return fail(
        'PASSWORD_EQUALS_IDENTIFIER',
        'Password must not equal your email address or its local part',
      );
    }
  }

  if (COMMON_PASSWORDS.has(lowerPassword)) {
    return fail('PASSWORD_TOO_COMMON', 'Password is too common; choose a less predictable one');
  }

  return ok(password);
}
