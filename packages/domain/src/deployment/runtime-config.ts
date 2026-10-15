// RuntimeConfigSnapshot v1: what is needed to restart a past deployment's container.
// Deliberately has no env/secret field. Error messages never echo input values or key names.

import { fail, ok, type ValidationResult } from "../validators/network.js";
import { validateHealthcheckConfig, type HealthcheckConfig } from "./healthcheck.js";

export interface RuntimeConfigSnapshot {
  readonly version: 1;
  readonly imageRef: string;
  readonly internalPort: number;
  readonly publishedPort: number;
  readonly healthcheck: HealthcheckConfig;
}

export const MAX_IMAGE_REF_LENGTH = 255;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;
const KEYS = ["version", "imageRef", "internalPort", "publishedPort", "healthcheck"];
const INVALID = "RUNTIME_CONFIG_INVALID";

function isPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
}

export function parseRuntimeConfigSnapshot(
  input: unknown,
): ValidationResult<RuntimeConfigSnapshot> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail(INVALID, "Runtime config must be an object");
  }
  const o = input as Record<string, unknown>;
  if (o.version !== 1) {
    return fail(INVALID, "Unsupported runtime config version");
  }
  if (Object.keys(o).some((k) => !KEYS.includes(k))) {
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
  if (!isPort(o.internalPort) || !isPort(o.publishedPort)) {
    return fail(INVALID, "Runtime config ports must be integers from 1 to 65535");
  }
  const hc = validateHealthcheckConfig(o.healthcheck);
  if (!hc.ok) {
    return fail(INVALID, "Runtime config healthcheck is invalid");
  }
  return ok({
    version: 1,
    imageRef,
    internalPort: o.internalPort,
    publishedPort: o.publishedPort,
    healthcheck: hc.value,
  });
}
