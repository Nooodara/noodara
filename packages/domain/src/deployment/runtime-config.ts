// RuntimeConfigSnapshot: what is needed to restart a past deployment's container.
// v1 has no env field (it parses as an empty env, see runtimeConfigEnv). v2 (21-05) adds the
// resolved env: plain values, or secret references pinned to a version; never a secret value.
// Error messages never echo input values, key names or secret names.

import { MAX_ENV_VARS_PER_SCOPE, validateEnvKey, validateEnvValue, validateSecretName } from "../env/env-value.js";
import { fail, ok, type ValidationResult } from "../validators/network.js";
import { validateHealthcheckConfig, type HealthcheckConfig } from "./healthcheck.js";

export interface RuntimeConfigSnapshotV1 {
  readonly version: 1;
  readonly imageRef: string;
  readonly internalPort: number;
  readonly publishedPort: number | null;
  readonly healthcheck: HealthcheckConfig;
}

export type RuntimeEnvEntry =
  | { readonly key: string; readonly value: string }
  | { readonly key: string; readonly secretRef: string; readonly secretVersion: number };

export interface RuntimeConfigSnapshotV2 extends Omit<RuntimeConfigSnapshotV1, "version"> {
  readonly version: 2;
  readonly env: readonly RuntimeEnvEntry[];
}

export type RuntimeConfigSnapshot = RuntimeConfigSnapshotV1 | RuntimeConfigSnapshotV2;

export const MAX_IMAGE_REF_LENGTH = 255;
/** Project + environment + service scopes, each capped at MAX_ENV_VARS_PER_SCOPE. */
export const MAX_RUNTIME_ENV_ENTRIES = MAX_ENV_VARS_PER_SCOPE * 3;

export const RUNTIME_CONFIG_ERROR_CODES = Object.freeze([
  "RUNTIME_CONFIG_INVALID",
  "RUNTIME_CONFIG_ENV_ENTRY_INVALID",
  "RUNTIME_CONFIG_ENV_DUPLICATE_KEY",
  "RUNTIME_CONFIG_ENV_KEY_INVALID",
  "RUNTIME_CONFIG_ENV_SECRET_REF_INVALID",
  "RUNTIME_CONFIG_ENV_VALUE_INVALID",
  "RUNTIME_CONFIG_ENV_TOO_MANY",
] as const);

const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;
const V1_KEYS = ["version", "imageRef", "internalPort", "publishedPort", "healthcheck"];
const V2_KEYS = [...V1_KEYS, "env"];
const PLAIN_ENTRY_KEYS = ["key", "value"];
const SECRET_ENTRY_KEYS = ["key", "secretRef", "secretVersion"];
const INVALID = "RUNTIME_CONFIG_INVALID";
const NO_ENV: readonly RuntimeEnvEntry[] = Object.freeze([]);

function isPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && own.every((k) => keys.includes(k));
}

/** The env a snapshot restores: v1 snapshots have none. */
export function runtimeConfigEnv(snapshot: RuntimeConfigSnapshot): readonly RuntimeEnvEntry[] {
  return snapshot.version === 2 ? snapshot.env : NO_ENV;
}

function parseEnvEntry(entry: unknown): ValidationResult<RuntimeEnvEntry> {
  if (!isRecord(entry)) return fail("RUNTIME_CONFIG_ENV_ENTRY_INVALID", "Runtime config env entry is invalid");
  const plain = hasExactKeys(entry, PLAIN_ENTRY_KEYS);
  if (!plain && !hasExactKeys(entry, SECRET_ENTRY_KEYS)) {
    // Also covers a value carried next to a secretRef: a snapshot never holds a secret value.
    return fail("RUNTIME_CONFIG_ENV_ENTRY_INVALID", "Runtime config env entry is invalid");
  }
  const { key } = entry;
  if (typeof key !== "string" || !validateEnvKey(key).ok) {
    return fail("RUNTIME_CONFIG_ENV_KEY_INVALID", "Runtime config env key is invalid");
  }
  if (plain) {
    const { value } = entry;
    if (typeof value !== "string") {
      return fail("RUNTIME_CONFIG_ENV_ENTRY_INVALID", "Runtime config env entry is invalid");
    }
    if (!validateEnvValue(value).ok) {
      return fail("RUNTIME_CONFIG_ENV_VALUE_INVALID", "Runtime config env value is invalid");
    }
    return ok({ key, value });
  }
  const { secretRef, secretVersion } = entry;
  if (typeof secretRef !== "string" || !validateSecretName(secretRef).ok) {
    return fail("RUNTIME_CONFIG_ENV_SECRET_REF_INVALID", "Runtime config env secret reference is invalid");
  }
  if (typeof secretVersion !== "number" || !Number.isSafeInteger(secretVersion) || secretVersion < 1) {
    return fail("RUNTIME_CONFIG_ENV_ENTRY_INVALID", "Runtime config env entry is invalid");
  }
  return ok({ key, secretRef, secretVersion });
}

function parseEnv(input: unknown): ValidationResult<readonly RuntimeEnvEntry[]> {
  if (!Array.isArray(input)) return fail(INVALID, "Runtime config env must be an array");
  if (input.length > MAX_RUNTIME_ENV_ENTRIES) {
    return fail(
      "RUNTIME_CONFIG_ENV_TOO_MANY",
      `Runtime config env must have at most ${MAX_RUNTIME_ENV_ENTRIES.toString()} entries`,
    );
  }
  const entries: RuntimeEnvEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input as readonly unknown[]) {
    const entry = parseEnvEntry(raw);
    if (!entry.ok) return entry;
    if (seen.has(entry.value.key)) {
      return fail("RUNTIME_CONFIG_ENV_DUPLICATE_KEY", "Runtime config env has a duplicate key");
    }
    seen.add(entry.value.key);
    entries.push(entry.value);
  }
  return ok(entries);
}

export function parseRuntimeConfigSnapshot(
  input: unknown,
): ValidationResult<RuntimeConfigSnapshot> {
  if (!isRecord(input)) {
    return fail(INVALID, "Runtime config must be an object");
  }
  const o = input;
  if (o.version !== 1 && o.version !== 2) {
    return fail(INVALID, "Unsupported runtime config version");
  }
  const keys = o.version === 1 ? V1_KEYS : V2_KEYS;
  if (Object.keys(o).some((k) => !keys.includes(k))) {
    return fail(INVALID, "Runtime config contains unsupported fields");
  }
  const { imageRef } = o;
  if (
    typeof imageRef !== "string" ||
    imageRef.length > MAX_IMAGE_REF_LENGTH ||
    !IMAGE_REF.test(imageRef)
  ) {
    return fail(INVALID, "Runtime config imageRef is invalid");
  }
  if (!isPort(o.internalPort) || (o.publishedPort !== null && !isPort(o.publishedPort))) {
    return fail(INVALID, "Runtime config ports must be integers from 1 to 65535 (publishedPort may be null)");
  }
  const hc = validateHealthcheckConfig(o.healthcheck);
  if (!hc.ok) {
    return fail(INVALID, "Runtime config healthcheck is invalid");
  }
  const base = {
    imageRef,
    internalPort: o.internalPort,
    publishedPort: o.publishedPort,
    healthcheck: hc.value,
  };
  if (o.version === 1) return ok({ version: 1, ...base });
  const env = parseEnv(o.env);
  if (!env.ok) return env;
  return ok({ version: 2, ...base, env: env.value });
}
