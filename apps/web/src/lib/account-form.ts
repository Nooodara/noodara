// 09-11-PLAN.md Task 1: the pure form logic behind the Name/Email/Password account Sheets
// (09-CONTEXT.md D-01/D-02/D-05/D-06). Every rule the Sheets apply is a tested pure function here
// -- no browser framework import and no network call of any kind, matching `server-form.ts`'s own
// precedent for a component-free form-helper module. The server always re-validates (D-03's own
// domain/length rules); the trim/lowercase here are convenience only, never a security boundary.
import { formatRetryAfterDuration } from './error-copy';

export interface ProfileFormValue {
  readonly value: string;
  readonly currentPassword: string;
}

/** Save is enabled only once both the field value and the current-password confirmation
 *  (09-CONTEXT.md D-02, every sensitive change requires it) are non-blank. */
export function canSubmitProfile({ value, currentPassword }: ProfileFormValue): boolean {
  return value.trim() !== '' && currentPassword !== '';
}

export type ProfileField = 'name' | 'email';

export interface ProfileRequestBody {
  readonly name?: string;
  readonly email?: string;
  readonly currentPassword: string;
}

/** `PATCH /api/account/profile`'s body for a single-field edit -- trims the value, lowercases it
 *  only for `email` (`validateAccountEmail`'s own normalization, 09-06-SUMMARY.md), and never
 *  includes a key for the field that was not edited. */
export function buildProfileRequest(field: ProfileField, value: string, currentPassword: string): ProfileRequestBody {
  const trimmed = value.trim();
  if (field === 'email') {
    return { email: trimmed.toLowerCase(), currentPassword };
  }
  return { name: trimmed, currentPassword };
}

export function passwordsMatch(a: string, b: string): boolean {
  return a === b;
}

/** "Passwords don't match." only once the user has actually typed something into Confirm --
 *  an empty Confirm field is not yet an error, it just has not been filled in. */
export function confirmError(newPassword: string, confirmPassword: string): string | undefined {
  if (confirmPassword === '') return undefined;
  return passwordsMatch(newPassword, confirmPassword) ? undefined : "Passwords don't match.";
}

export interface PasswordFormValue {
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly confirmPassword: string;
}

/** Save is enabled only once all three fields are non-blank and the new/confirm pair matches
 *  (09-CONTEXT.md D-05). */
export function canSubmitPassword({ currentPassword, newPassword, confirmPassword }: PasswordFormValue): boolean {
  return (
    currentPassword !== '' &&
    newPassword !== '' &&
    confirmPassword !== '' &&
    passwordsMatch(newPassword, confirmPassword)
  );
}

// Claude's Discretion (09-11-PLAN.md Task 1): 09-UI-SPEC.md's Notice copy table only spells out
// the "count known" and "count unknown" cases, always with "were signed out" regardless of count.
// This refines that with a singular n=1 case ("session was") and a bare "Password updated." for
// n=0 (no "other sessions" clause at all when there genuinely were none) -- both a small,
// grammatically-correct extension of the same D-06 rule, not a contradiction of it.
export function passwordNoticeMessage(sessionsRevoked: number | undefined): string {
  if (sessionsRevoked === undefined) {
    return 'Password updated. Other sessions were signed out.';
  }
  if (sessionsRevoked === 0) {
    return 'Password updated.';
  }
  const verb = sessionsRevoked === 1 ? 'session was' : 'sessions were';
  return `Password updated. ${String(sessionsRevoked)} other ${verb} signed out.`;
}

/** 09-UI-SPEC.md's lockout copy ("Too many attempts. Try again {duration}.") for a `REAUTH_LOCKED`
 *  429 -- reuses `error-copy.ts`'s own `formatRetryAfterDuration` rather than a second duration
 *  formatter. */
export function retryMessage(seconds: number): string {
  return `Too many attempts. Try again ${formatRetryAfterDuration(seconds)}.`;
}
