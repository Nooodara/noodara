// Unique-violation mapper (21-05 H1): a Postgres 23505 on a v0.4 unique index becomes its typed
// 409 code instead of a 500. The constraint names are the single source for the migrations and the
// Drizzle schema (21-06), so a renamed index fails the drift test instead of leaking a 500.
import type { ServiceErrorCode } from "./http-errors.js";

export const DOMAINS_HOSTNAME_UNIQUE_INDEX = "domains_hostname_lower_unique_idx";
export const ENVIRONMENT_VARIABLES_OWNER_KEY_UNIQUE_INDEX = "environment_variables_owner_key_unique_idx";
export const SECRETS_OWNER_NAME_UNIQUE_INDEX = "secrets_owner_name_unique_idx";

const PG_UNIQUE_VIOLATION = "23505";

export const UNIQUE_CONSTRAINT_ERROR_CODES: Readonly<
  Record<string, Extract<ServiceErrorCode, "DOMAIN_ALREADY_ASSIGNED" | "ENV_KEY_DUPLICATE" | "SECRET_NAME_DUPLICATE">>
> = Object.freeze({
  [DOMAINS_HOSTNAME_UNIQUE_INDEX]: "DOMAIN_ALREADY_ASSIGNED",
  [ENVIRONMENT_VARIABLES_OWNER_KEY_UNIQUE_INDEX]: "ENV_KEY_DUPLICATE",
  [SECRETS_OWNER_NAME_UNIQUE_INDEX]: "SECRET_NAME_DUPLICATE",
});

export type UniqueViolationCode = (typeof UNIQUE_CONSTRAINT_ERROR_CODES)[string];

function constraintOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { code, constraint } = value as { code?: unknown; constraint?: unknown };
  if (code !== PG_UNIQUE_VIOLATION || typeof constraint !== "string") return null;
  return constraint;
}

/**
 * The typed 409 code for a unique violation on a known v0.4 index, or null for anything else
 * (another constraint, another SQL state, a non-error). Reads the pg error directly or as the
 * `cause` of a Drizzle query error.
 */
export function mapUniqueViolation(error: unknown): UniqueViolationCode | null {
  const constraint =
    constraintOf(error) ??
    (typeof error === "object" && error !== null ? constraintOf((error as { cause?: unknown }).cause) : null);
  if (constraint === null || !Object.hasOwn(UNIQUE_CONSTRAINT_ERROR_CODES, constraint)) return null;
  return UNIQUE_CONSTRAINT_ERROR_CODES[constraint] ?? null;
}
