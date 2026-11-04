import { describe, expect, it } from "vitest";
import { DIAGNOSES } from "../observability/index.js";
import * as contract from "./index.js";

const UUID = "0192f1a4-7b3c-7d2e-8f00-00000000aaaa";
const UUID2 = "0192f1a4-7b3c-7d2e-8f00-00000000bbbb";
const NOW = "2026-11-03T10:00:00.000Z";
const CANARY = "sk-ant-api03-CANARY-26-04-do-not-leak-0000000000000000";

const V05_STATUSES: readonly (readonly [contract.V05ServiceErrorCode, number])[] = [
  ["METRICS_UNAVAILABLE", 503],
  ["LOG_SOURCE_UNAVAILABLE", 502],
  ["LOG_QUERY_INVALID", 422],
  ["AI_PROVIDER_NOT_CONFIGURED", 409],
  ["AI_PROVIDER_AUTH_FAILED", 422],
  ["AI_PROVIDER_UNAVAILABLE", 503],
  ["AI_PROVIDER_RATE_LIMITED", 429],
  ["AI_BUDGET_EXCEEDED", 422],
  ["AI_TOOL_NOT_ALLOWED", 403],
];

describe("v0.5 HTTP codes (A2)", () => {
  it.each(V05_STATUSES)("maps %s to %d", (code, status) => {
    expect(contract.mapServiceCodeToStatus(code)).toBe(status);
  });

  it("lists exactly the v0.5 codes, frozen, each with one fixed message", () => {
    expect([...contract.V05_SERVICE_ERROR_CODES]).toEqual(V05_STATUSES.map(([code]) => code));
    expect(Object.isFrozen(contract.V05_SERVICE_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(contract.V05_ERROR_MESSAGES)).toBe(true);
    expect(Object.keys(contract.V05_ERROR_MESSAGES).sort()).toEqual([...contract.V05_SERVICE_ERROR_CODES].sort());
  });

  it.each(V05_STATUSES)("%s has an actionable sentence that does not repeat the code", (code) => {
    const message = contract.V05_ERROR_MESSAGES[code];
    expect(message.length).toBeGreaterThan(20);
    expect(message).toMatch(/^[A-Z].*\.$/);
    expect(message).not.toContain(code);
    expect(message).not.toMatch(/[{}$]/);
  });

  it("never sends a 401 for a provider key failure (401 ends the Noodara session)", () => {
    for (const [code] of V05_STATUSES) expect(contract.mapServiceCodeToStatus(code)).not.toBe(401);
  });

  it("builds the body from the code alone (H1: no provider message can pass through)", () => {
    for (const [code] of V05_STATUSES) {
      const body = contract.toV05ErrorBody(code);
      expect(body).toStrictEqual({ error: code, message: contract.V05_ERROR_MESSAGES[code] });
      expect(JSON.stringify(body)).not.toContain("CANARY");
    }
    expect(contract.toV05ErrorBody.length).toBe(1);
  });
});

const series = {
  scope: "server",
  entityId: UUID,
  metric: "cpu_percent",
  from: NOW,
  to: NOW,
  intervalSeconds: 60,
  points: [
    { t: NOW, v: 12.5 },
    { t: NOW, v: null },
  ],
};

const statusSummary = {
  serviceId: UUID,
  runtimeStatus: "RUNNING",
  container: { state: "running", restartCount: 2, healthcheck: "healthy", observedAt: NOW },
  lastDeployment: { id: UUID2, status: "SUCCESS", commitSha: "a1b2c3d", finishedAt: NOW },
  flags: { highMemory: false, highDisk: true },
};

const logEntry = {
  source: "runtime",
  timestamp: "2026-11-03T18:37:14.689777509Z",
  level: "info",
  stream: "stdout",
  text: "listening on :3000",
  truncated: false,
};
const logPage = { entries: [logEntry], since: NOW, until: NOW, nextUntil: null, unavailableSources: [] };

const graph = {
  nodes: [
    { id: `server:${UUID}`, entityId: UUID, label: "vps-1", kind: "Server" },
    {
      id: `service:${UUID2}`,
      entityId: UUID2,
      label: "api",
      kind: "Service",
      projectId: UUID,
      environmentId: UUID,
      serverId: UUID,
    },
  ],
  relations: [{ id: `RUNS_ON:service:${UUID2}->server:${UUID}`, type: "RUNS_ON", from: `service:${UUID2}`, to: `server:${UUID}` }],
  omitted: [],
};

const settings = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  keyHint: "••••••••0000",
  validatedAt: NOW,
  updatedAt: NOW,
};

const answer = {
  answer: "The api service runs on vps-1 and was killed for running out of memory.",
  diagnosis: "out_of_memory",
  confidence: 0.82,
  entities: [{ kind: "Service", id: UUID2, label: "api" }],
  evidence: [{ ref: "tool:get_service_status#1", note: "OOMKilled=true, exit 137" }],
  missingEvidence: [],
};

const toolCall = {
  id: UUID,
  name: "get_service_status",
  scope: { kind: "Service", id: UUID2 },
  status: "ok",
  errorCode: null,
  durationMs: 41,
  createdAt: NOW,
};

const conversation = { id: UUID, title: "Why did api restart?", createdAt: NOW, updatedAt: NOW };

const message = {
  id: UUID2,
  conversationId: UUID,
  role: "assistant",
  status: "complete",
  content: "It ran out of memory.",
  answer,
  toolCalls: [toolCall],
  errorCode: null,
  createdAt: NOW,
};

/** Every new output schema with a valid sample. */
const VIEWS: readonly (readonly [string, { safeParse(value: unknown): { success: boolean } }, Record<string, unknown>])[] = [
  ["MetricSeriesSchema", contract.MetricSeriesSchema, series],
  ["MetricSeriesResponseSchema", contract.MetricSeriesResponseSchema, { series: [series] }],
  ["ServiceStatusSummarySchema", contract.ServiceStatusSummarySchema, statusSummary],
  ["LogEntryViewSchema", contract.LogEntryViewSchema, logEntry],
  ["LogPageSchema", contract.LogPageSchema, logPage],
  ["GraphViewSchema", contract.GraphViewSchema, graph],
  ["AiProviderSettingsViewSchema", contract.AiProviderSettingsViewSchema, settings],
  ["AiProviderSettingsResponseSchema", contract.AiProviderSettingsResponseSchema, { settings }],
  ["AiStructuredAnswerSchema", contract.AiStructuredAnswerSchema, answer],
  ["AiToolCallRecordSchema", contract.AiToolCallRecordSchema, toolCall],
  ["AiConversationViewSchema", contract.AiConversationViewSchema, conversation],
  ["AiMessageViewSchema", contract.AiMessageViewSchema, message],
  ["AiConversationDetailSchema", contract.AiConversationDetailSchema, { conversation, messages: [message] }],
  ["ListAiConversationsResponseSchema", contract.ListAiConversationsResponseSchema, { items: [conversation] }],
];

describe("v0.5 output schemas (A1)", () => {
  it.each(VIEWS)("%s accepts a valid sample", (_, schema, sample) => {
    expect(schema.safeParse(sample).success).toBe(true);
  });

  it("metric series: bounded points, gaps as null, finite values only", () => {
    const point = { t: NOW, v: 1 };
    const full = Array.from({ length: contract.METRIC_SERIES_MAX_POINTS }, () => point);
    expect(contract.MetricSeriesSchema.safeParse({ ...series, points: full }).success).toBe(true);
    expect(contract.MetricSeriesSchema.safeParse({ ...series, points: [...full, point] }).success).toBe(false);
    expect(contract.MetricSeriesSchema.safeParse({ ...series, points: [] }).success).toBe(true);
    expect(contract.MetricSeriesSchema.safeParse({ ...series, points: [{ t: NOW, v: Number.NaN }] }).success).toBe(false);
    expect(contract.MetricSeriesSchema.safeParse({ ...series, points: [{ t: NOW, v: Infinity }] }).success).toBe(false);
    expect(contract.MetricSeriesSchema.safeParse({ ...series, metric: "load_avg" }).success).toBe(false);
    expect(contract.MetricSeriesSchema.safeParse({ ...series, scope: "project" }).success).toBe(false);
    expect(contract.MetricSeriesSchema.safeParse({ ...series, intervalSeconds: 0 }).success).toBe(false);
    for (const scope of contract.METRIC_SCOPES) {
      expect(contract.MetricSeriesSchema.safeParse({ ...series, scope }).success).toBe(true);
    }
  });

  it("service status: nullable container and deployment, sha shape, healthcheck outcome", () => {
    const parse = (value: unknown) => contract.ServiceStatusSummarySchema.safeParse(value).success;
    expect(parse({ ...statusSummary, container: null, lastDeployment: null })).toBe(true);
    expect(parse({ ...statusSummary, lastDeployment: { ...statusSummary.lastDeployment, commitSha: "not a sha" } })).toBe(
      false,
    );
    expect(parse({ ...statusSummary, container: { ...statusSummary.container, healthcheck: "sick" } })).toBe(false);
    expect(parse({ ...statusSummary, container: { ...statusSummary.container, restartCount: -1 } })).toBe(false);
    expect(parse({ ...statusSummary, flags: { highMemory: true } })).toBe(false);
  });

  it("log page: bounded entries and line length, known sources and streams", () => {
    const parse = (value: unknown) => contract.LogPageSchema.safeParse(value).success;
    const many = Array.from({ length: contract.LOG_PAGE_MAX_ENTRIES }, () => logEntry);
    expect(parse({ ...logPage, entries: many })).toBe(true);
    expect(parse({ ...logPage, entries: [...many, logEntry] })).toBe(false);
    const longLine = { ...logEntry, text: "x".repeat(contract.LOG_LINE_MAX_LENGTH + 1) };
    expect(parse({ ...logPage, entries: [longLine] })).toBe(false);
    expect(parse({ ...logPage, entries: [{ ...logEntry, source: "kernel" }] })).toBe(false);
    expect(parse({ ...logPage, entries: [{ ...logEntry, source: "build", stream: null }] })).toBe(true);
    expect(parse({ ...logPage, unavailableSources: ["runtime"], nextUntil: NOW })).toBe(true);
    expect(parse({ ...logPage, since: "yesterday" })).toBe(false);
  });

  it("graph: node kinds carry their own parents, relation types are closed", () => {
    const parse = (value: unknown) => contract.GraphViewSchema.safeParse(value).success;
    expect(parse({ ...graph, nodes: [{ ...graph.nodes[1], kind: "Server" }] })).toBe(false);
    expect(parse({ ...graph, nodes: [{ ...graph.nodes[0], kind: "Database" }] })).toBe(false);
    expect(parse({ ...graph, relations: [{ ...graph.relations[0], type: "CALLS" }] })).toBe(false);
    expect(
      parse({ ...graph, relations: [{ ...graph.relations[0], type: "DEPENDS_ON", envKeys: ["DATABASE_URL"] }] }),
    ).toBe(true);
    expect(parse({ ...graph, omitted: [{ kind: "Service", entityId: UUID, reason: "missing_parent" }] })).toBe(true);
  });

  it("AI provider settings: models come from the per-provider allowlist", () => {
    const parse = (value: unknown) => contract.AiProviderSettingsViewSchema.safeParse(value).success;
    expect(parse({ ...settings, provider: "openai", model: "gpt-5-2025-08-07" })).toBe(true);
    expect(parse({ ...settings, provider: "openai", model: "claude-opus-5-5" })).toBe(false);
    expect(parse({ ...settings, provider: "mistral" })).toBe(false);
    expect(contract.AiProviderSettingsResponseSchema.safeParse({ settings: null }).success).toBe(true);
    for (const provider of contract.AI_PROVIDERS) {
      expect(contract.AI_PROVIDER_MODELS[provider].length).toBeGreaterThan(0);
    }
  });

  it("structured answer: the diagnosis is one of DIAGNOSES", () => {
    for (const diagnosis of DIAGNOSES) {
      expect(contract.AiStructuredAnswerSchema.safeParse({ ...answer, diagnosis }).success).toBe(true);
    }
    expect(contract.AiStructuredAnswerSchema.safeParse({ ...answer, diagnosis: "cosmic_rays" }).success).toBe(false);
    expect(
      contract.AiStructuredAnswerSchema.safeParse({ ...answer, entities: [{ kind: "Service", id: "api", label: "api" }] })
        .success,
    ).toBe(false);
  });

  it("tool call record: tool names are identifiers, statuses and error codes are closed", () => {
    const parse = (value: unknown) => contract.AiToolCallRecordSchema.safeParse(value).success;
    expect(parse({ ...toolCall, status: "refused", errorCode: "AI_TOOL_NOT_ALLOWED", scope: null })).toBe(true);
    expect(parse({ ...toolCall, name: "rm -rf /" })).toBe(false);
    expect(parse({ ...toolCall, status: "maybe" })).toBe(false);
    expect(parse({ ...toolCall, errorCode: "SOMETHING" })).toBe(false);
    expect(parse({ ...toolCall, durationMs: -1 })).toBe(false);
  });

  it("activity actor schema includes ai", () => {
    expect(contract.ActivityActorTypeSchema.safeParse("ai").success).toBe(true);
    expect(contract.ActivityActorTypeSchema.safeParse("bot").success).toBe(false);
  });
});

describe("H1: a canary never reaches serialized output through a new schema", () => {
  it.each(VIEWS)("%s rejects a canary in an extra key", (_, schema, sample) => {
    for (const key of ["apiKey", "key", "value", "secret", "output", "__canary"]) {
      expect(schema.safeParse({ ...sample, [key]: CANARY }).success).toBe(false);
    }
  });

  it("the AI provider settings view has no field that can carry the key", () => {
    const parse = (value: unknown) => contract.AiProviderSettingsViewSchema.safeParse(value).success;
    for (const field of ["provider", "model", "keyHint", "validatedAt", "updatedAt"]) {
      expect(parse({ ...settings, [field]: CANARY }), field).toBe(false);
    }
    // The hint holds at most 4 characters of the key after the mask.
    expect(parse({ ...settings, keyHint: `••••••••${CANARY}` })).toBe(false);
    expect(parse({ ...settings, keyHint: CANARY.slice(-12) })).toBe(false);
    expect(parse({ ...settings, keyHint: "••••••••" })).toBe(true);
    for (const option of contract.AiProviderSettingsViewSchema.options) {
      expect(Object.keys(option.shape).filter((key) => /api|secret|token|value|^key$/i.test(key))).toEqual([]);
    }
    expect(contract.AI_PROVIDER_KEY_MIN_LENGTH).toBeGreaterThan(12);
  });

  it("a canary in a parsed sample does not survive into nested arrays", () => {
    const leakyNode = { ...graph.nodes[0], apiKey: CANARY };
    expect(contract.GraphViewSchema.safeParse({ ...graph, nodes: [leakyNode] }).success).toBe(false);
    const leakyTool = { ...toolCall, output: CANARY };
    expect(contract.AiMessageViewSchema.safeParse({ ...message, toolCalls: [leakyTool] }).success).toBe(false);
    const leakyEvidence = { ...answer.evidence[0], raw: CANARY };
    expect(contract.AiStructuredAnswerSchema.safeParse({ ...answer, evidence: [leakyEvidence] }).success).toBe(false);
    const leakyLog = { ...logEntry, env: CANARY };
    expect(contract.LogPageSchema.safeParse({ ...logPage, entries: [leakyLog] }).success).toBe(false);
  });

  it("the write-only key body is strict and bounded", () => {
    const body = { provider: "anthropic", model: "claude-opus-5-5", apiKey: CANARY };
    expect(contract.PutAiProviderSettingsBodySchema.safeParse(body).success).toBe(true);
    expect(contract.PutAiProviderSettingsBodySchema.safeParse({ ...body, hint: "x" }).success).toBe(false);
    expect(contract.PutAiProviderSettingsBodySchema.safeParse({ ...body, apiKey: "short" }).success).toBe(false);
    expect(
      contract.PutAiProviderSettingsBodySchema.safeParse({
        ...body,
        apiKey: "k".repeat(contract.AI_PROVIDER_KEY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    // A failed parse never echoes the key in its issues.
    const failed = contract.PutAiProviderSettingsBodySchema.safeParse({ ...body, model: "gpt-4" });
    expect(failed.success).toBe(false);
    expect(JSON.stringify(failed.error?.issues)).not.toContain("CANARY");
  });
});

describe("H2: answer, message and tool-call schemas cap sizes and confidence", () => {
  const parseAnswer = (value: unknown) => contract.AiStructuredAnswerSchema.safeParse(value).success;
  const entity = answer.entities[0];
  const evidence = answer.evidence[0];

  it("caps answer text", () => {
    expect(parseAnswer({ ...answer, answer: "x".repeat(contract.AI_ANSWER_MAX_LENGTH) })).toBe(true);
    expect(parseAnswer({ ...answer, answer: "x".repeat(contract.AI_ANSWER_MAX_LENGTH + 1) })).toBe(false);
    expect(parseAnswer({ ...answer, answer: "" })).toBe(false);
  });

  it("caps entities, evidence and missing evidence", () => {
    const n = (count: number, item: unknown) => Array.from({ length: count }, () => item);
    expect(parseAnswer({ ...answer, entities: n(contract.AI_ANSWER_MAX_ENTITIES, entity) })).toBe(true);
    expect(parseAnswer({ ...answer, entities: n(contract.AI_ANSWER_MAX_ENTITIES + 1, entity) })).toBe(false);
    expect(parseAnswer({ ...answer, evidence: n(contract.AI_ANSWER_MAX_EVIDENCE, evidence) })).toBe(true);
    expect(parseAnswer({ ...answer, evidence: n(contract.AI_ANSWER_MAX_EVIDENCE + 1, evidence) })).toBe(false);
    expect(parseAnswer({ ...answer, missingEvidence: n(contract.AI_ANSWER_MAX_MISSING_EVIDENCE + 1, "x") })).toBe(false);
    expect(parseAnswer({ ...answer, evidence: [{ ...evidence, ref: "r".repeat(contract.AI_EVIDENCE_REF_MAX_LENGTH + 1) }] })).toBe(
      false,
    );
    expect(parseAnswer({ ...answer, evidence: [{ ...evidence, note: "n".repeat(contract.AI_EVIDENCE_NOTE_MAX_LENGTH + 1) }] })).toBe(
      false,
    );
    expect(parseAnswer({ ...answer, entities: [{ ...entity, label: "l".repeat(254) }] })).toBe(false);
  });

  it.each([0, 0.5, 1])("accepts confidence %d", (confidence) => {
    expect(parseAnswer({ ...answer, confidence })).toBe(true);
  });

  it.each([-0.01, 1.01, Number.NaN, Infinity, "0.9"])("rejects confidence %s", (confidence) => {
    expect(parseAnswer({ ...answer, confidence })).toBe(false);
  });

  it("caps message content, tool calls per message and the nested answer", () => {
    const parse = (value: unknown) => contract.AiMessageViewSchema.safeParse(value).success;
    expect(parse({ ...message, content: "x".repeat(contract.AI_MESSAGE_MAX_LENGTH + 1) })).toBe(false);
    const calls = Array.from({ length: contract.AI_MAX_TOOL_CALLS_PER_MESSAGE }, () => toolCall);
    expect(parse({ ...message, toolCalls: calls })).toBe(true);
    expect(parse({ ...message, toolCalls: [...calls, toolCall] })).toBe(false);
    expect(parse({ ...message, answer: { ...answer, confidence: 2 } })).toBe(false);
    expect(parse({ ...message, role: "system" })).toBe(false);
    for (const status of contract.AI_MESSAGE_STATUSES) {
      expect(parse({ ...message, status, answer: null })).toBe(true);
    }
  });

  it("caps the tool name, the question and the conversation title", () => {
    expect(contract.AiToolCallRecordSchema.safeParse({ ...toolCall, name: `a${"b".repeat(64)}` }).success).toBe(false);
    expect(contract.AskBodySchema.safeParse({ question: "q".repeat(contract.AI_QUESTION_MAX_LENGTH) }).success).toBe(true);
    expect(contract.AskBodySchema.safeParse({ question: "q".repeat(contract.AI_QUESTION_MAX_LENGTH + 1) }).success).toBe(
      false,
    );
    expect(contract.AskBodySchema.safeParse({ question: "" }).success).toBe(false);
    expect(contract.AskBodySchema.safeParse({ question: "why?", conversationId: UUID }).success).toBe(false);
    expect(
      contract.AiConversationViewSchema.safeParse({
        ...conversation,
        title: "t".repeat(contract.AI_CONVERSATION_TITLE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});
