// Environment inputs (D23). The name is free: any entity slug is valid, unique per project (the
// caller's job). `production`, `staging` and `development` are UI suggestions only; there is no
// separate `kind` enum, so `EnvironmentName` is a plain branded string.

import type { Brand } from '../validators/branded.js';
import { type ValidationResult, fail, ok } from '../validators/network.js';
import { ENTITY_SLUG_PATTERN, parseInputRecord } from './input.js';

export type EnvironmentName = Brand<string, 'EnvironmentName'>;

export const ENVIRONMENT_NAME_SUGGESTIONS = ['production', 'staging', 'development'] as const;

export interface EnvironmentCreateInput {
  readonly name: EnvironmentName;
}

export function isSuggestedEnvironmentName(name: string): boolean {
  return (ENVIRONMENT_NAME_SUGGESTIONS as readonly string[]).includes(name);
}

export function validateEnvironmentName(input: unknown): ValidationResult<EnvironmentName> {
  if (typeof input !== 'string' || !ENTITY_SLUG_PATTERN.test(input)) {
    return fail(
      'ENVIRONMENT_NAME_INVALID',
      'Environment name must be a lowercase slug matching [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?',
    );
  }
  return ok(input as EnvironmentName);
}

export function validateEnvironmentCreateInput(
  input: unknown,
): ValidationResult<EnvironmentCreateInput> {
  const parsed = parseInputRecord(input, ['name'], 'ENVIRONMENT_INPUT', 'Environment');
  if (!parsed.ok) return parsed;
  const name = validateEnvironmentName(parsed.value.name);
  if (!name.ok) return name;
  return ok({ name: name.value });
}
