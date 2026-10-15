// Idempotency key validation and request fingerprint (SHA-256 over a canonical serialization).
// node:crypto is allowed in the pure domain (computation only, see purity.test.ts).

import { createHash } from "node:crypto";
import { fail, ok, type ValidationResult } from "../validators/network.js";

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

export function validateIdempotencyKey(key: unknown): ValidationResult<string> {
  if (
    typeof key !== "string" ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !VISIBLE_ASCII.test(key)
  ) {
    return fail(
      "IDEMPOTENCY_KEY_INVALID",
      `Idempotency key must be 1-${String(MAX_IDEMPOTENCY_KEY_LENGTH)} visible ASCII characters`,
    );
  }
  return ok(key);
}

/** Length-delimited by JSON quoting, keys sorted, undefined members dropped. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  return "null";
}

export function requestFingerprint(request: unknown): string {
  return createHash("sha256").update(canonical(request), "utf8").digest("hex");
}
