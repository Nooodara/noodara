import { describe, expect, it } from "vitest";
import {
  DEFAULT_POST_START_POLL_POLICY,
  DEFAULT_CONTAINER_HEALTHCHECK,
  postStartPollDelays,
  decideHealthcheck,
  healthcheckBudgetMs,
  healthcheckPolicy,
  parseProbeOutput,
  resolveHealthcheck,
  validateHealthcheckBudget,
  validateHealthcheckConfig,
  type HealthcheckConfig,
  type HealthcheckState,
} from "./index.js";

const timing = { probeTimeoutS: 5, intervalS: 10, retries: 3, startPeriodS: 0 };
const http = {
  type: "http",
  path: "/health",
  port: 8080,
  expectedStatuses: [200],
  ...timing,
};
const code = (r: { ok: boolean; code?: string }): string | undefined =>
  r.ok ? undefined : r.code;

describe("validateHealthcheckConfig (A1, H1)", () => {
  it("accepts http, tcp and container configs", () => {
    expect(validateHealthcheckConfig(http).ok).toBe(true);
    expect(
      validateHealthcheckConfig({ type: "tcp", port: 5432, ...timing }).ok,
    ).toBe(true);
    expect(validateHealthcheckConfig({ type: "container", ...timing }).ok).toBe(
      true,
    );
  });
  it("defaults expectedStatuses to 200-399 for http", () => {
    const { expectedStatuses: _e, ...rest } = http;
    const r = validateHealthcheckConfig(rest);
    expect(
      r.ok && r.value.type === "http" && r.value.expectedStatuses.length,
    ).toBe(200);
  });
  it.each([
    ["no leading slash", { ...http, path: "health" }],
    ["dotdot", { ...http, path: "/a/../b" }],
    ["whitespace", { ...http, path: "/a b" }],
    ["control char", { ...http, path: "/a\u0007" }],
    ["newline", { ...http, path: "/a\n" }],
    ["shell chars", { ...http, path: "/a;rm" }],
    ["dollar", { ...http, path: "/$(id)" }],
    ["too long", { ...http, path: `/${"a".repeat(256)}` }],
    ["port 0", { ...http, port: 0 }],
    ["port 65536", { ...http, port: 65536 }],
    ["timeout 0", { ...http, probeTimeoutS: 0 }],
    ["timeout 31", { ...http, probeTimeoutS: 31 }],
    ["interval 0", { ...http, intervalS: 0 }],
    ["interval 61", { ...http, intervalS: 61 }],
    ["retries 0", { ...http, retries: 0 }],
    ["retries 31", { ...http, retries: 31 }],
    ["start period -1", { ...http, startPeriodS: -1 }],
    ["start period 301", { ...http, startPeriodS: 301 }],
    ["status 99", { ...http, expectedStatuses: [99] }],
    ["status 600", { ...http, expectedStatuses: [600] }],
    ["no statuses", { ...http, expectedStatuses: [] }],
    ["fractional", { ...http, retries: 1.5 }],
    ["NaN", { ...http, intervalS: Number.NaN }],
    ["string number", { ...http, port: "80" }],
    ["unknown type", { type: "udp", ...timing }],
    ["not an object", "x"],
    ["null", null],
  ])("rejects %s", (_n, input) => {
    expect(code(validateHealthcheckConfig(input))).toBe(
      "HEALTHCHECK_CONFIG_INVALID",
    );
  });
  // 16-03 A1: one case per shell metacharacter, whitespace and control character.
  it.each([
    "&",
    "*",
    "!",
    ";",
    "$",
    "`",
    "|",
    "<",
    ">",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    "'",
    '"',
    "\\",
    " ",
    "\t",
    "\n",
    "\r",
    "\u0000",
    "\u001b",
    "\u007f",
  ])("rejects the path character %j", (char) => {
    expect(
      code(validateHealthcheckConfig({ ...http, path: `/a${char}b` })),
    ).toBe("HEALTHCHECK_CONFIG_INVALID");
  });
  it("keeps URL-legit path characters", () => {
    const path = "/api/v1/health?full=1,2?x=a:b@c+d-e.f_g~h%20/";
    const r = validateHealthcheckConfig({ ...http, path });
    expect(r.ok && r.value.type === "http" && r.value.path).toBe(path);
  });
  it("names an unknown field instead of stripping it", () => {
    const r = validateHealthcheckConfig({ ...http, cmd: "id" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("cmd");
  });
  it("rejects a tcp config carrying a path", () => {
    expect(
      validateHealthcheckConfig({ type: "tcp", port: 1, path: "/x", ...timing })
        .ok,
    ).toBe(false);
  });
});

describe("budget (A2)", () => {
  it("is startPeriod + retries * (interval + probeTimeout)", () => {
    const c = { ...http, startPeriodS: 20 } as HealthcheckConfig;
    expect(healthcheckBudgetMs(c)).toBe(20_000 + 3 * 15_000);
  });
  it("is bounded for the largest valid config", () => {
    const c = {
      ...http,
      probeTimeoutS: 30,
      intervalS: 60,
      retries: 30,
      startPeriodS: 300,
    } as HealthcheckConfig;
    expect(healthcheckBudgetMs(c)).toBeLessThanOrEqual(3_000_000);
  });
  it("rejects a budget above min(600 s, deployMax / 2) with a named error", () => {
    const c = { ...http, intervalS: 60, retries: 30 } as HealthcheckConfig;
    expect(code(validateHealthcheckBudget(c, 14_400_000))).toBe(
      "HEALTHCHECK_BUDGET_EXCEEDED",
    );
    expect(
      code(validateHealthcheckBudget(http as HealthcheckConfig, 40_000)),
    ).toBe("HEALTHCHECK_BUDGET_EXCEEDED");
    expect(
      validateHealthcheckBudget(http as HealthcheckConfig, 3_600_000).ok,
    ).toBe(true);
  });
});

describe("resolveHealthcheck (A3)", () => {
  it("null resolves to the container check with the post-start poll policy", () => {
    const r = resolveHealthcheck(null);
    expect(r.config).toEqual(DEFAULT_CONTAINER_HEALTHCHECK);
    expect(r.config.type).toBe("container");
    expect(r.postStart).toBe(DEFAULT_POST_START_POLL_POLICY);
  });
  it("a config resolves to itself without post-start polls", () => {
    const r = resolveHealthcheck(http as HealthcheckConfig);
    expect(r.config).toBe(http);
    expect(r.postStart).toBeNull();
  });
});

describe("default container healthcheck vs post-start polls (A3)", () => {
  it("pins both budgets numerically so they cannot drift apart silently", () => {
    const d = DEFAULT_CONTAINER_HEALTHCHECK;
    expect(d).toMatchObject({ retries: 5, intervalS: 1, probeTimeoutS: 5, startPeriodS: 0 });
    expect(healthcheckBudgetMs(d)).toBe(30_000);
    const p = DEFAULT_POST_START_POLL_POLICY;
    expect(p).toMatchObject({ maxPolls: 5, initialDelayMs: 1000, maxDelayMs: 8000, stablePolls: 2 });
    const pollMs = postStartPollDelays(p).reduce((a, b) => a + b, 0);
    expect(pollMs).toBe(23_000);
    // the container budget covers the poll waits plus a 7 s allowance for inspect round-trips
    expect(healthcheckBudgetMs(d) - pollMs).toBe(7_000);
  });
});

describe("expectedStatuses null (A2)", () => {
  it("rejects an explicit null with a named error; absent keeps the default", () => {
    const r = validateHealthcheckConfig({ ...http, expectedStatuses: null });
    expect(r.ok).toBe(false);
    expect(code(r)).toBe("HEALTHCHECK_CONFIG_INVALID");
    expect(!r.ok && r.message).toMatch(/expectedStatuses/);
    const { expectedStatuses: _e, ...rest } = http;
    expect(validateHealthcheckConfig(rest).ok).toBe(true);
  });
});

describe("parseProbeOutput (A5)", () => {
  it.each([
    ["NOODARA_PROBE http 200\n", { kind: "http", status: 200 }],
    ["NOODARA_PROBE http 503", { kind: "http", status: 503 }],
    ["NOODARA_PROBE open\n", { kind: "open" }],
    ["NOODARA_PROBE refused\n", { kind: "refused" }],
    ["NOODARA_PROBE empty\n", { kind: "empty" }],
    ["NOODARA_PROBE malformed\n", { kind: "malformed" }],
    ["NOODARA_PROBE error\n", { kind: "error" }],
    ["noise\nNOODARA_PROBE http 204\n", { kind: "http", status: 204 }],
  ])("parses %j", (out, expected) => {
    expect(parseProbeOutput(out)).toEqual(expected);
  });
  it.each([
    [""],
    ["garbage"],
    ["NOODARA_PROBE"],
    ["NOODARA_PROBE http"],
    ["NOODARA_PROBE http 99"],
    ["NOODARA_PROBE http 20000"],
    ["NOODARA_PROBE http abc"],
    ["NOODARA_PROBE http 200 extra"],
    ["NOODARA_PROBE ope"],
    ["\u0000\u0001"],
    ["NOODARA_PROBE http 20"],
    ["x".repeat(5000)],
    [`NOODARA_PROBE http 200\n${"x".repeat(5000)}`],
  ])("turns %j into a failed observation", (out) => {
    expect(parseProbeOutput(out)).toEqual({ kind: "error" });
  });
  it("never throws on non-string input", () => {
    expect(parseProbeOutput(undefined as unknown as string)).toEqual({
      kind: "error",
    });
  });
});

describe("decideHealthcheck (A4, H2)", () => {
  const policy = healthcheckPolicy(http as HealthcheckConfig);
  const st = (o: Partial<HealthcheckState> = {}): HealthcheckState => ({
    elapsedMs: 0,
    failures: 0,
    ...o,
  });

  it("passes on an expected status", () => {
    expect(
      decideHealthcheck(policy, st(), { kind: "http", status: 200 }).decision,
    ).toEqual({ kind: "pass" });
  });
  it("retries on a wrong status until retries are used, then HEALTHCHECK_FAILED", () => {
    const a = decideHealthcheck(policy, st(), { kind: "http", status: 500 });
    expect(a.decision).toEqual({ kind: "retry", delayMs: 10_000 });
    expect(a.state.failures).toBe(1);
    const last = decideHealthcheck(
      policy,
      st({ failures: 2, elapsedMs: 20_000 }),
      { kind: "http", status: 500 },
    );
    expect(last.decision).toMatchObject({
      kind: "failed",
      code: "HEALTHCHECK_FAILED",
      reason: "wrong_status",
    });
  });
  it("maps refused, empty, malformed, error and open-on-http to failures", () => {
    for (const kind of [
      "refused",
      "empty",
      "malformed",
      "error",
      "open",
    ] as const) {
      const d = decideHealthcheck(policy, st({ failures: 2 }), {
        kind,
      }).decision;
      expect(d).toMatchObject({ kind: "failed", code: "HEALTHCHECK_FAILED" });
    }
    expect(
      decideHealthcheck(policy, st({ failures: 2 }), { kind: "refused" })
        .decision,
    ).toMatchObject({ reason: "refused" });
  });
  it("fails at once when the container exited", () => {
    expect(
      decideHealthcheck(policy, st(), { kind: "exited" }).decision,
    ).toMatchObject({
      kind: "failed",
      code: "HEALTHCHECK_FAILED",
      reason: "exited",
    });
  });
  it("a hung probe on the last retry is HEALTHCHECK_TIMEOUT", () => {
    expect(
      decideHealthcheck(policy, st({ failures: 2 }), { kind: "timeout" })
        .decision,
    ).toEqual({
      kind: "timeout",
      code: "HEALTHCHECK_TIMEOUT",
    });
  });
  it("tcp passes on open; container passes on running", () => {
    const tcp = healthcheckPolicy({ type: "tcp", port: 1, ...timing });
    expect(decideHealthcheck(tcp, st(), { kind: "open" }).decision.kind).toBe(
      "pass",
    );
    expect(
      decideHealthcheck(tcp, st({ failures: 2 }), { kind: "http", status: 200 })
        .decision.kind,
    ).toBe("failed");
    const cont = healthcheckPolicy({ type: "container", ...timing });
    expect(
      decideHealthcheck(cont, st(), { kind: "running" }).decision.kind,
    ).toBe("pass");
    expect(
      decideHealthcheck(cont, st(), { kind: "refused" }).decision.kind,
    ).toBe("retry");
  });
  it("failures during the start period are retried and not counted", () => {
    const p = healthcheckPolicy({
      ...http,
      startPeriodS: 30,
    } as HealthcheckConfig);
    const r = decideHealthcheck(p, st({ failures: 2, elapsedMs: 5_000 }), {
      kind: "refused",
    });
    expect(r.decision.kind).toBe("retry");
    expect(r.state.failures).toBe(2);
  });
  it("a pass during the start period passes", () => {
    const p = healthcheckPolicy({
      ...http,
      startPeriodS: 30,
    } as HealthcheckConfig);
    expect(
      decideHealthcheck(p, st({ elapsedMs: 1000 }), {
        kind: "http",
        status: 200,
      }).decision.kind,
    ).toBe("pass");
  });
  it("an observation after the budget is exhausted is HEALTHCHECK_TIMEOUT, never a retry or pass", () => {
    for (const o of [
      { kind: "http", status: 200 },
      { kind: "refused" },
      { kind: "exited" },
    ] as const) {
      expect(
        decideHealthcheck(policy, st({ elapsedMs: policy.budgetMs }), o)
          .decision,
      ).toEqual({
        kind: "timeout",
        code: "HEALTHCHECK_TIMEOUT",
      });
    }
  });
  it("the retry delay never exceeds the remaining budget and is deterministic", () => {
    const s = st({ elapsedMs: policy.budgetMs - 3000 });
    const a = decideHealthcheck(policy, s, { kind: "refused" });
    expect(a.decision).toEqual({ kind: "retry", delayMs: 3000 });
    expect(decideHealthcheck(policy, s, { kind: "refused" })).toEqual(a);
  });
  it("time advances by the delay in the returned state", () => {
    const a = decideHealthcheck(policy, st(), { kind: "refused" });
    expect(a.state.elapsedMs).toBe(10_000);
  });
});
