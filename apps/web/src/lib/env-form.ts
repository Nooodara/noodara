// 24-02: pure helpers for the variables and secrets editors. Keys, values and secret names are
// checked with the shared domain validators, so the named errors match the API's. Copy is fixed
// per code: a failure never echoes a key, value or server text. Unknown scopes fall back.
import {
  parseEnvValue,
  validateEnvKey,
  validateEnvValue,
  validateSecretName,
  type EnvErrorCode,
} from '@noodara/domain';
import type { ApiFailure, DeployApiErrorCode } from './api-client';

export type EnvScope = 'project' | 'environment' | 'service';

export const NEXT_DEPLOY_COPY = 'Changes apply on the next deploy.';
export const REDEPLOY_TO_APPLY_COPY = 'Variables changed since the running deploy. Redeploy to apply.';
export const SECRET_WRITE_ONLY_COPY = 'Secret values are write-only. Noodara never shows them again.';
export const ENV_GENERIC_FAILURE_COPY = "Couldn't save the change. Check your connection and try again.";
export const MAX_SECRET_VALUE_CHARS = 64 * 1024;

const SCOPE_LABELS: Readonly<Record<EnvScope, string>> = {
  project: 'Project',
  environment: 'Environment',
  service: 'Service',
};

/** Label for an origin or scope pill; a scope this build does not know renders as "Other". */
export function scopeLabel(scope: string): string {
  return Object.hasOwn(SCOPE_LABELS, scope) ? SCOPE_LABELS[scope as EnvScope] : 'Other';
}

const ENV_ERROR_COPY: Readonly<Record<EnvErrorCode, string>> = {
  ENV_KEY_REQUIRED: 'Enter a variable name.',
  ENV_KEY_TOO_LONG: 'Variable names can be up to 128 characters.',
  ENV_KEY_INVALID: 'Use A-Z, 0-9 and _ for the name, not starting with a digit.',
  ENV_VALUE_MULTILINE: 'Values must be a single line.',
  ENV_VALUE_INVALID_UTF8: 'The value must be valid text.',
  ENV_VALUE_TOO_LARGE: 'Values can be up to 32 KiB.',
  ENV_SECRET_REF_MALFORMED: 'Write a secret reference exactly as <secret:name>, or pick one with Use a secret.',
  SECRET_NAME_REQUIRED: 'Enter a secret name.',
  SECRET_NAME_TOO_LONG: 'Secret names can be up to 64 characters.',
  SECRET_NAME_INVALID: 'Use a-z, 0-9 and _ for the name, starting with a letter.',
  SECRET_UNRESOLVED: 'That secret is not visible from here.',
  ENV_FILE_DUPLICATE_KEY: 'This variable is defined twice.',
  ENV_FILE_TOO_LARGE: 'Too many variables for one deploy.',
};

export function envErrorCopy(code: string): string | null {
  return Object.hasOwn(ENV_ERROR_COPY, code) ? ENV_ERROR_COPY[code as EnvErrorCode] : null;
}

export type CheckResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly field: 'key' | 'value' | 'name'; readonly message: string };

export function checkVariableInput(key: string, value: string): CheckResult<{ key: string; value: string }> {
  const trimmedKey = key.trim();
  const checkedKey = validateEnvKey(trimmedKey);
  if (!checkedKey.ok) return { ok: false, field: 'key', message: envErrorCopy(checkedKey.code) ?? ENV_GENERIC_FAILURE_COPY };
  const checkedValue = parseEnvValue(value, trimmedKey);
  if (!checkedValue.ok) {
    return { ok: false, field: 'value', message: envErrorCopy(checkedValue.code) ?? ENV_GENERIC_FAILURE_COPY };
  }
  return { ok: true, key: trimmedKey, value };
}

export function checkVariableValue(value: string): CheckResult<{ value: string }> {
  const checked = parseEnvValue(value);
  if (!checked.ok) return { ok: false, field: 'value', message: envErrorCopy(checked.code) ?? ENV_GENERIC_FAILURE_COPY };
  return { ok: true, value };
}

export function checkSecretName(name: string): CheckResult<{ name: string }> {
  const trimmed = name.trim();
  const checked = validateSecretName(trimmed);
  if (!checked.ok) return { ok: false, field: 'name', message: envErrorCopy(checked.code) ?? ENV_GENERIC_FAILURE_COPY };
  return { ok: true, name: trimmed };
}

/** A secret value is never quoted back: only whether it is empty, multi-line or too long. */
export function checkSecretValue(value: string): CheckResult<{ value: string }> {
  if (value.length === 0) return { ok: false, field: 'value', message: 'Enter the secret value.' };
  if (value.length > MAX_SECRET_VALUE_CHARS) return { ok: false, field: 'value', message: 'Secret values can be up to 64 KiB.' };
  const checked = validateEnvValue(value);
  if (!checked.ok && checked.code === 'ENV_VALUE_MULTILINE') {
    return { ok: false, field: 'value', message: 'Secret values must be a single line.' };
  }
  if (!checked.ok && checked.code === 'ENV_VALUE_INVALID_UTF8') {
    return { ok: false, field: 'value', message: 'The value must be valid text.' };
  }
  return { ok: true, value };
}

/** The secret name a value references, or null for a plain (or malformed) value. */
export function secretRefName(value: string): string | null {
  const parsed = parseEnvValue(value);
  return parsed.ok && parsed.value.kind === 'secret_ref' ? parsed.value.name : null;
}

export function secretReference(name: string): string {
  return `<secret:${name}>`;
}

const FAILURE_COPY: Partial<Record<DeployApiErrorCode, string>> = {
  ENV_KEY_DUPLICATE: 'This scope already has a variable with this name.',
  ENV_VALUE_MULTILINE: 'Values must be a single line.',
  ENV_LIMIT_REACHED: 'This scope has reached its variable limit.',
  SECRET_NOT_FOUND: 'That secret is not visible from here. Pick one with Use a secret.',
  SECRET_IN_USE: 'This secret is still referenced by variables. Change them first.',
  SECRET_NAME_DUPLICATE: 'This scope already has a secret with this name.',
  SECRET_LIMIT_REACHED: 'This scope has reached its secret limit.',
  NOT_FOUND: 'It no longer exists. Refresh the page.',
  NETWORK_ERROR: ENV_GENERIC_FAILURE_COPY,
  RATE_LIMITED: 'Too many changes at once. Wait a moment and try again.',
};

/** Fixed copy for an API failure: the code first, then a domain rule in `reason`, then generic. */
export function envFailureCopy(failure: ApiFailure<DeployApiErrorCode>): string {
  const byCode = FAILURE_COPY[failure.code];
  if (byCode !== undefined) return byCode;
  const byReason = failure.reason === undefined ? null : envErrorCopy(failure.reason);
  return byReason ?? ENV_GENERIC_FAILURE_COPY;
}
