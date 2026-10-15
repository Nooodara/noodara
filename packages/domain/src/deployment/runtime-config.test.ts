import { describe, expect, expectTypeOf, it } from "vitest";
import { parseRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from "./index.js";

const valid = {
  version: 1,
  imageRef: "registry.local/app:abc123",
  internalPort: 3000,
  publishedPort: 20001,
  healthcheck: { type: "container", probeTimeoutS: 5, intervalS: 1, retries: 5, startPeriodS: 0 },
};
const code = (r: { ok: boolean; code?: string }): string | undefined => (r.ok ? undefined : r.code);

describe("parseRuntimeConfigSnapshot v1", () => {
  it("parses a valid snapshot", () => {
    const r = parseRuntimeConfigSnapshot(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(valid);
  });
  it.each([null, "x", 3, [], undefined])("rejects non-object %j", (v) => {
    expect(code(parseRuntimeConfigSnapshot(v))).toBe("RUNTIME_CONFIG_INVALID");
  });
  it("rejects unknown or missing versions", () => {
    expect(code(parseRuntimeConfigSnapshot({ ...valid, version: 2 }))).toBe("RUNTIME_CONFIG_INVALID");
    const { version: _v, ...rest } = valid;
    expect(code(parseRuntimeConfigSnapshot(rest))).toBe("RUNTIME_CONFIG_INVALID");
  });
  it("rejects bad ports and healthcheck", () => {
    for (const patch of [
      { internalPort: 0 },
      { internalPort: 1.5 },
      { publishedPort: 70000 },
      { publishedPort: "1" },
      { healthcheck: { type: "nope" } },
      { healthcheck: undefined },
    ]) {
      expect(parseRuntimeConfigSnapshot({ ...valid, ...patch }).ok).toBe(false);
    }
  });
  it("bounds and validates the image ref", () => {
    for (const imageRef of ["", "x".repeat(256), "a b", "a\nb", "a;rm", 5]) {
      expect(parseRuntimeConfigSnapshot({ ...valid, imageRef }).ok).toBe(false);
    }
    expect(parseRuntimeConfigSnapshot({ ...valid, imageRef: "x".repeat(255) }).ok).toBe(true);
  });
  it("never echoes unknown keys or values in errors", () => {
    const r1 = parseRuntimeConfigSnapshot({ ...valid, env: { PASSWORD: "hunter2-secret" } });
    const r2 = parseRuntimeConfigSnapshot({ ...valid, imageRef: "hunter2 secret" });
    const r3 = parseRuntimeConfigSnapshot({ ...valid, healthcheck: { type: "http", token: "hunter2" } });
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/hunter2|PASSWORD|token/);
    }
  });
  it("has no field that can hold a secret (type-level)", () => {
    expectTypeOf<keyof RuntimeConfigSnapshot>().toEqualTypeOf<
      "version" | "imageRef" | "internalPort" | "publishedPort" | "healthcheck"
    >();
  });
});
