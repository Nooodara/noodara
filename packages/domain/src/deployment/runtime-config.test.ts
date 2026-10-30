import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_ENV_VARS_PER_SCOPE,
  parseRuntimeConfigSnapshot,
  runtimeConfigEnv,
  type RuntimeConfigSnapshot,
  type RuntimeConfigSnapshotV1,
  type RuntimeEnvEntry,
} from "../index.js";

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
    expect(code(parseRuntimeConfigSnapshot({ ...valid, version: 0 }))).toBe("RUNTIME_CONFIG_INVALID");
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
  it("accepts a null publishedPort (service without a published port)", () => {
    const r = parseRuntimeConfigSnapshot({ ...valid, publishedPort: null });
    expect(r.ok && r.value.publishedPort).toBeNull();
    for (const publishedPort of [0, 65536, undefined]) {
      expect(parseRuntimeConfigSnapshot({ ...valid, publishedPort }).ok).toBe(false);
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
    expectTypeOf<keyof RuntimeConfigSnapshotV1>().toEqualTypeOf<
      "version" | "imageRef" | "internalPort" | "publishedPort" | "healthcheck"
    >();
  });
  it("parses as an empty env", () => {
    const r = parseRuntimeConfigSnapshot(valid);
    if (!r.ok) throw new Error("expected ok");
    expect(runtimeConfigEnv(r.value)).toEqual([]);
  });
  it("rejects an env field on a v1 snapshot", () => {
    expect(code(parseRuntimeConfigSnapshot({ ...valid, env: [] }))).toBe("RUNTIME_CONFIG_INVALID");
  });
});

const v2 = {
  ...valid,
  version: 2,
  env: [
    { key: "NODE_ENV", value: "production" },
    { key: "DATABASE_URL", secretRef: "database_url", secretVersion: 3 },
  ],
};

describe("parseRuntimeConfigSnapshot v2", () => {
  it("parses plain and secret-reference entries next to the v1 fields", () => {
    const r = parseRuntimeConfigSnapshot(v2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(v2);
    expect(runtimeConfigEnv(r.value)).toEqual(v2.env);
    expectTypeOf(runtimeConfigEnv(r.value)).toEqualTypeOf<readonly RuntimeEnvEntry[]>();
  });
  it("accepts an empty env and an empty plain value", () => {
    expect(parseRuntimeConfigSnapshot({ ...v2, env: [] }).ok).toBe(true);
    expect(parseRuntimeConfigSnapshot({ ...v2, env: [{ key: "EMPTY", value: "" }] }).ok).toBe(true);
  });
  it("rejects a missing or non-array env", () => {
    const { env: _e, ...noEnv } = v2;
    for (const input of [noEnv, { ...v2, env: {} }, { ...v2, env: "A=1" }, { ...v2, env: null }]) {
      expect(code(parseRuntimeConfigSnapshot(input))).toBe("RUNTIME_CONFIG_INVALID");
    }
  });
  it("rejects a value carried next to a secretRef, never echoing it", () => {
    const r = parseRuntimeConfigSnapshot({
      ...v2,
      env: [{ key: "DATABASE_URL", secretRef: "database_url", secretVersion: 1, value: "hunter2-secret" }],
    });
    expect(code(r)).toBe("RUNTIME_CONFIG_ENV_ENTRY_INVALID");
    expect(JSON.stringify(r)).not.toMatch(/hunter2|DATABASE_URL|database_url/);
  });
  it.each([
    ["a non-object entry", "A=1"],
    ["a null entry", null],
    ["an entry with neither value nor secretRef", { key: "A" }],
    ["an unknown entry field", { key: "A", value: "1", scope: "service" }],
    ["a secretRef without version", { key: "A", secretRef: "a" }],
    ["a non-integer secretVersion", { key: "A", secretRef: "a", secretVersion: 1.5 }],
    ["a zero secretVersion", { key: "A", secretRef: "a", secretVersion: 0 }],
    ["a string secretVersion", { key: "A", secretRef: "a", secretVersion: "1" }],
    ["a non-string value", { key: "A", value: 1 }],
    ["a secretVersion on a plain entry", { key: "A", value: "1", secretVersion: 1 }],
  ])("rejects %s as RUNTIME_CONFIG_ENV_ENTRY_INVALID", (_label, entry) => {
    expect(code(parseRuntimeConfigSnapshot({ ...v2, env: [entry] }))).toBe("RUNTIME_CONFIG_ENV_ENTRY_INVALID");
  });
  it("rejects duplicate keys across plain and secret entries (H2)", () => {
    const r = parseRuntimeConfigSnapshot({
      ...v2,
      env: [
        { key: "API_TOKEN", value: "hunter2" },
        { key: "API_TOKEN", secretRef: "api_token", secretVersion: 1 },
      ],
    });
    expect(code(r)).toBe("RUNTIME_CONFIG_ENV_DUPLICATE_KEY");
    expect(JSON.stringify(r)).not.toMatch(/hunter2|API_TOKEN/);
  });
  it.each([["lower"], ["1ABC"], [""], ["A-B"], ["A".repeat(129)], [5]])(
    "rejects key %j as RUNTIME_CONFIG_ENV_KEY_INVALID (H2)",
    (key) => {
      const r = parseRuntimeConfigSnapshot({ ...v2, env: [{ key, value: "hunter2" }] });
      expect(code(r)).toBe("RUNTIME_CONFIG_ENV_KEY_INVALID");
      expect(JSON.stringify(r)).not.toContain("hunter2");
    },
  );
  it.each([["Upper"], ["1abc"], [""], ["a-b"], ["a".repeat(65)], [7]])(
    "rejects secretRef %j as RUNTIME_CONFIG_ENV_SECRET_REF_INVALID (H2)",
    (secretRef) => {
      expect(code(parseRuntimeConfigSnapshot({ ...v2, env: [{ key: "A", secretRef, secretVersion: 1 }] }))).toBe(
        "RUNTIME_CONFIG_ENV_SECRET_REF_INVALID",
      );
    },
  );
  it.each([["line\nbreak"], ["nul\u0000"], ["x".repeat(32 * 1024 + 1)]])(
    "rejects an invalid plain value as RUNTIME_CONFIG_ENV_VALUE_INVALID without echoing it",
    (value) => {
      const r = parseRuntimeConfigSnapshot({ ...v2, env: [{ key: "SECRET_KEY", value: `hunter2${value}` }] });
      expect(code(r)).toBe("RUNTIME_CONFIG_ENV_VALUE_INVALID");
      expect(JSON.stringify(r)).not.toMatch(/hunter2|SECRET_KEY/);
    },
  );
  it("bounds the env to MAX_ENV_VARS_PER_SCOPE * 3 entries (H2)", () => {
    const max = MAX_ENV_VARS_PER_SCOPE * 3;
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `K_${String(i)}`, value: "v" }));
    expect(parseRuntimeConfigSnapshot({ ...v2, env: entries(max) }).ok).toBe(true);
    expect(code(parseRuntimeConfigSnapshot({ ...v2, env: entries(max + 1) }))).toBe("RUNTIME_CONFIG_ENV_TOO_MANY");
  });
  it("still validates the v1 fields and rejects unknown top-level fields", () => {
    expect(code(parseRuntimeConfigSnapshot({ ...v2, internalPort: 0 }))).toBe("RUNTIME_CONFIG_INVALID");
    expect(code(parseRuntimeConfigSnapshot({ ...v2, secrets: [] }))).toBe("RUNTIME_CONFIG_INVALID");
    expect(code(parseRuntimeConfigSnapshot({ ...v2, version: 3 }))).toBe("RUNTIME_CONFIG_INVALID");
  });
  it("the snapshot type is the union of v1 and v2", () => {
    expectTypeOf<RuntimeConfigSnapshot["version"]>().toEqualTypeOf<1 | 2>();
  });
});
