// Healthcheck contract (ADR 0010 A1/H1/H2/A4). Pure: the caller owns probes and timers.
// Probe output is one line `NOODARA_PROBE http <code>|open|refused|empty|malformed|error`.
// Budget = startPeriod + retries * (interval + probeTimeout), capped by min(600 s, deployMax / 2).

import { fail, ok, type ValidationResult } from "../validators/network.js";
import {
  DEFAULT_POST_START_POLL_POLICY,
  type PostStartPollPolicy,
} from "./post-start-polls.js";

export interface HealthcheckTiming {
  readonly probeTimeoutS: number;
  readonly intervalS: number;
  readonly retries: number;
  readonly startPeriodS: number;
}

export type HealthcheckConfig =
  | (HealthcheckTiming & {
      readonly type: "http";
      readonly path: string;
      readonly port: number;
      readonly expectedStatuses: readonly number[];
    })
  | (HealthcheckTiming & { readonly type: "tcp"; readonly port: number })
  | (HealthcheckTiming & { readonly type: "container" });

const INVALID = "HEALTHCHECK_CONFIG_INVALID";
const MAX_PATH_LENGTH = 256;
const MAX_PROBE_OUTPUT_BYTES = 1024;
export const MAX_HEALTHCHECK_BUDGET_MS = 600_000;

const BOUNDS = {
  probeTimeoutS: [1, 30],
  intervalS: [1, 60],
  retries: [1, 30],
  startPeriodS: [0, 300],
} as const;

export const DEFAULT_EXPECTED_STATUSES: readonly number[] = Object.freeze(
  Array.from({ length: 200 }, (_, i) => 200 + i),
);

// Derived from the v0.2 post-start poll policy so both budgets are equal by construction:
// retries * (interval + probeTimeout) is fixed at maxPolls * 2 s, startPeriod takes the rest.
function defaultContainerHealthcheck(policy: PostStartPollPolicy): HealthcheckConfig {
  const pollsS = Math.ceil(
    Array.from({ length: policy.maxPolls }, (_, i) =>
      Math.min(policy.initialDelayMs * 2 ** i, policy.maxDelayMs),
    ).reduce((a, b) => a + b, 0) / 1000,
  );
  const intervalS = 1;
  const probeTimeoutS = 1;
  return Object.freeze({
    type: "container",
    probeTimeoutS,
    intervalS,
    retries: policy.maxPolls,
    startPeriodS: pollsS - policy.maxPolls * (intervalS + probeTimeoutS),
  });
}

export const DEFAULT_CONTAINER_HEALTHCHECK: HealthcheckConfig =
  defaultContainerHealthcheck(DEFAULT_POST_START_POLL_POLICY);

// 16-03 A1: URL path/query characters only; every shell metacharacter (& * ! ; $ ` | < > ( ) { }
// [ ] ' " \), whitespace and control character is rejected.
const SAFE_PATH = /^\/[A-Za-z0-9\-._~/%?=+,:@]*$/;
const COMMON_KEYS = [
  "type",
  "probeTimeoutS",
  "intervalS",
  "retries",
  "startPeriodS",
];
const KEYS_BY_TYPE: Record<string, readonly string[]> = {
  http: [...COMMON_KEYS, "path", "port", "expectedStatuses"],
  tcp: [...COMMON_KEYS, "port"],
  container: COMMON_KEYS,
};

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function bad<T>(message: string): ValidationResult<T> {
  return fail(INVALID, message);
}

export function validateHealthcheckConfig(
  input: unknown,
): ValidationResult<HealthcheckConfig> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return bad("Healthcheck must be an object");
  }
  const o = input as Record<string, unknown>;
  const type = o.type;
  const allowed = typeof type === "string" ? KEYS_BY_TYPE[type] : undefined;
  if (allowed === undefined || !Object.hasOwn(KEYS_BY_TYPE, type as string)) {
    return bad("Healthcheck type must be http, tcp or container");
  }
  const unknown = Object.keys(o).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return bad(`Unknown healthcheck field(s): ${unknown.join(", ")}`);
  }
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    if (!isInt(o[key], min, max)) {
      return bad(
        `Healthcheck ${key} must be an integer from ${String(min)} to ${String(max)}`,
      );
    }
  }
  const timing: HealthcheckTiming = {
    probeTimeoutS: o.probeTimeoutS as number,
    intervalS: o.intervalS as number,
    retries: o.retries as number,
    startPeriodS: o.startPeriodS as number,
  };
  if (type === "container") {
    return ok({ type: "container", ...timing });
  }
  if (!isInt(o.port, 1, 65535)) {
    return bad("Healthcheck port must be an integer from 1 to 65535");
  }
  const port = o.port;
  if (type === "tcp") {
    return ok({ type: "tcp", port, ...timing });
  }
  const path = o.path;
  if (
    typeof path !== "string" ||
    path.length > MAX_PATH_LENGTH ||
    !SAFE_PATH.test(path)
  ) {
    return bad(
      `Healthcheck path must start with / and use only URL-safe characters (max ${String(MAX_PATH_LENGTH)})`,
    );
  }
  if (path.split(/[/?]/).includes("..")) {
    return bad("Healthcheck path must not contain ..");
  }
  if (o.expectedStatuses === null) {
    return bad("Healthcheck expectedStatuses must not be null; omit it for the default");
  }
  const statuses = o.expectedStatuses ?? DEFAULT_EXPECTED_STATUSES;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    statuses.length > 300 ||
    !statuses.every((s) => isInt(s, 100, 599))
  ) {
    return bad(
      "Healthcheck expectedStatuses must be 1-300 HTTP status codes from 100 to 599",
    );
  }
  return ok({
    type: "http",
    path,
    port,
    expectedStatuses: statuses,
    ...timing,
  });
}

export function healthcheckBudgetMs(config: HealthcheckConfig): number {
  return (
    config.startPeriodS * 1000 +
    config.retries * (config.intervalS + config.probeTimeoutS) * 1000
  );
}

export function validateHealthcheckBudget(
  config: HealthcheckConfig,
  deployMaxMs: number,
): ValidationResult<HealthcheckConfig> {
  const cap = Math.min(MAX_HEALTHCHECK_BUDGET_MS, Math.floor(deployMaxMs / 2));
  const budget = healthcheckBudgetMs(config);
  if (budget > cap) {
    return fail(
      "HEALTHCHECK_BUDGET_EXCEEDED",
      `Healthcheck needs up to ${String(budget / 1000)} s but at most ${String(cap / 1000)} s fit in the deploy time limit`,
    );
  }
  return ok(config);
}

/** null keeps the v0.2 behaviour: the container check driven by the post-start polls. */
export function resolveHealthcheck(config: HealthcheckConfig | null): {
  readonly config: HealthcheckConfig;
  readonly postStart: PostStartPollPolicy | null;
} {
  if (config === null) {
    return {
      config: DEFAULT_CONTAINER_HEALTHCHECK,
      postStart: DEFAULT_POST_START_POLL_POLICY,
    };
  }
  return { config, postStart: null };
}

export type HealthcheckObservation =
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "open" | "refused" | "empty" | "malformed" | "error" }
  | { readonly kind: "timeout" | "exited" | "running" };

const WORD_KINDS = ["open", "refused", "empty", "malformed", "error"] as const;
const ERROR_OBSERVATION: HealthcheckObservation = { kind: "error" };

/** Total: any garbage, truncated or oversized output is a failed (`error`) observation. */
export function parseProbeOutput(output: string): HealthcheckObservation {
  if (typeof output !== "string" || output.length > MAX_PROBE_OUTPUT_BYTES) {
    return ERROR_OBSERVATION;
  }
  const line = output.split("\n").find((l) => l.startsWith("NOODARA_PROBE"));
  if (line === undefined) return ERROR_OBSERVATION;
  const parts = line.trimEnd().split(" ");
  const [, word, code, extra] = parts;
  if (
    parts.length === 3 &&
    word === "http" &&
    code !== undefined &&
    /^[1-5]\d\d$/.test(code)
  ) {
    return { kind: "http", status: Number(code) };
  }
  const kind = WORD_KINDS.find((k) => k === word);
  if (parts.length === 2 && kind !== undefined && extra === undefined) {
    return { kind };
  }
  return ERROR_OBSERVATION;
}

export interface HealthcheckPolicy {
  readonly config: HealthcheckConfig;
  readonly budgetMs: number;
  readonly intervalMs: number;
  readonly startPeriodMs: number;
  readonly retries: number;
}

export interface HealthcheckState {
  readonly elapsedMs: number;
  readonly failures: number;
}

export type HealthcheckFailReason =
  "wrong_status" | "refused" | "exited" | "unhealthy";

export type HealthcheckDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "retry"; readonly delayMs: number }
  | {
      readonly kind: "failed";
      readonly code: "HEALTHCHECK_FAILED";
      readonly reason: HealthcheckFailReason;
    }
  | { readonly kind: "timeout"; readonly code: "HEALTHCHECK_TIMEOUT" };

export function healthcheckPolicy(
  config: HealthcheckConfig,
): HealthcheckPolicy {
  return {
    config,
    budgetMs: healthcheckBudgetMs(config),
    intervalMs: config.intervalS * 1000,
    startPeriodMs: config.startPeriodS * 1000,
    retries: config.retries,
  };
}

function passes(config: HealthcheckConfig, o: HealthcheckObservation): boolean {
  switch (config.type) {
    case "http":
      return o.kind === "http" && config.expectedStatuses.includes(o.status);
    case "tcp":
      return o.kind === "open";
    case "container":
      return o.kind === "running";
  }
}

function failReason(o: HealthcheckObservation): HealthcheckFailReason {
  if (o.kind === "http") return "wrong_status";
  if (o.kind === "refused") return "refused";
  if (o.kind === "exited") return "exited";
  return "unhealthy";
}

const TIMEOUT: HealthcheckDecision = {
  kind: "timeout",
  code: "HEALTHCHECK_TIMEOUT",
};

export function decideHealthcheck(
  policy: HealthcheckPolicy,
  state: HealthcheckState,
  observation: HealthcheckObservation,
): {
  readonly decision: HealthcheckDecision;
  readonly state: HealthcheckState;
} {
  const remaining = policy.budgetMs - state.elapsedMs;
  if (remaining <= 0) {
    return { decision: TIMEOUT, state };
  }
  if (passes(policy.config, observation)) {
    return { decision: { kind: "pass" }, state };
  }
  if (observation.kind === "exited") {
    return {
      decision: {
        kind: "failed",
        code: "HEALTHCHECK_FAILED",
        reason: "exited",
      },
      state,
    };
  }
  const inStartPeriod = state.elapsedMs < policy.startPeriodMs;
  const failures = inStartPeriod ? state.failures : state.failures + 1;
  if (failures >= policy.retries) {
    const decision: HealthcheckDecision =
      observation.kind === "timeout"
        ? TIMEOUT
        : {
            kind: "failed",
            code: "HEALTHCHECK_FAILED",
            reason: failReason(observation),
          };
    return { decision, state: { elapsedMs: state.elapsedMs, failures } };
  }
  const delayMs = Math.min(policy.intervalMs, remaining);
  return {
    decision: { kind: "retry", delayMs },
    state: { elapsedMs: state.elapsedMs + delayMs, failures },
  };
}
