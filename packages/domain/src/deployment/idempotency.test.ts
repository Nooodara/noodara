import { describe, expect, it } from "vitest";
import { requestFingerprint, validateIdempotencyKey } from "./index.js";

describe("validateIdempotencyKey", () => {
  it("accepts 1-255 visible ASCII", () => {
    expect(validateIdempotencyKey("a").ok).toBe(true);
    expect(validateIdempotencyKey("abc-123_~!").ok).toBe(true);
    expect(validateIdempotencyKey("x".repeat(255)).ok).toBe(true);
  });
  it.each(["", "x".repeat(256), "   ", "a b", "a\tb", "a\u0000b", "café", "a\u007f", " a", 5, null])(
    "rejects %j",
    (k) => {
      const r = validateIdempotencyKey(k);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("IDEMPOTENCY_KEY_INVALID");
    },
  );
  it("does not echo the key in the message", () => {
    const r = validateIdempotencyKey("secret value");
    expect(JSON.stringify(r)).not.toContain("secret value");
  });
});

describe("requestFingerprint", () => {
  it("is a SHA-256 hex digest", () => {
    expect(requestFingerprint({})).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable under key order, also nested", () => {
    expect(requestFingerprint({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      requestFingerprint({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
  });
  it("differs for semantic changes", () => {
    const base = requestFingerprint({ a: "1", l: [1, 2] });
    expect(requestFingerprint({ a: 1, l: [1, 2] })).not.toBe(base);
    expect(requestFingerprint({ a: "1", l: [2, 1] })).not.toBe(base);
    expect(requestFingerprint({ a: "1", l: [1, 2], z: null })).not.toBe(base);
    expect(requestFingerprint(null)).not.toBe(requestFingerprint("null"));
  });
  it("is collision-safe across field boundaries", () => {
    expect(requestFingerprint({ a: "b", c: "" })).not.toBe(requestFingerprint({ a: "", c: "b" }));
    expect(requestFingerprint(["ab", "c"])).not.toBe(requestFingerprint(["a", "bc"]));
  });
  it("treats undefined object members as absent and handles primitives", () => {
    expect(requestFingerprint({ a: 1, b: undefined })).toBe(requestFingerprint({ a: 1 }));
    expect(requestFingerprint([undefined])).toBe(requestFingerprint([null]));
    expect(requestFingerprint(true)).not.toBe(requestFingerprint(false));
    expect(requestFingerprint(undefined)).toBe(requestFingerprint(null));
  });
});
