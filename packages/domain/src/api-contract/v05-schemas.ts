// Zod output schemas for the v0.5 routes (metrics, status, logs, graph, AI), 26-04 A1. Every view
// is strict, so a server-side leak (an extra key such as a provider key or tool output) fails
// validation instead of reaching the UI. Free text and arrays are capped (H2): an oversized model
// answer fails here instead of being stored or streamed.
import { z } from "zod";
import { ACTIVITY_ACTOR_TYPES } from "../activity/index.js";
import { DOCKER_CONTAINER_STATES, DEPLOYMENT_STATUSES, SERVICE_STATUSES } from "../deployment/index.js";
import { MAX_ENV_KEY_LENGTH } from "../env/index.js";
import { GRAPH_NODE_KINDS, GRAPH_OMIT_REASONS, GRAPH_RELATION_TYPES } from "../graph/index.js";
import { LOG_LEVELS, LOG_SOURCES } from "../logs/index.js";
import { DIAGNOSES, HEALTHCHECK_OUTCOMES } from "../observability/index.js";
import { V05_SERVICE_ERROR_CODES } from "./http-errors.js";

const Timestamp = z.iso.datetime({ offset: true });
const Label = z.string().max(253);

export const ActivityActorTypeSchema = z.enum(ACTIVITY_ACTOR_TYPES);

// ---- metrics ----------------------------------------------------------------------------------

/** Max points per series; the API downsamples a range to at most this many buckets. */
export const METRIC_SERIES_MAX_POINTS = 500;

export const METRIC_SCOPES = Object.freeze(["server", "service"] as const);
export const METRIC_NAMES = Object.freeze([
  "cpu_percent",
  "memory_used_bytes",
  "memory_percent",
  "disk_used_percent",
  "restart_count",
] as const);

/** `v` is null for a bucket without samples: gaps are never interpolated or zero-filled. */
export const MetricPointSchema = z.strictObject({
  t: Timestamp,
  v: z.number().nullable(),
});

export const MetricSeriesSchema = z.strictObject({
  scope: z.enum(METRIC_SCOPES),
  entityId: z.uuid(),
  metric: z.enum(METRIC_NAMES),
  from: Timestamp,
  to: Timestamp,
  intervalSeconds: z.number().int().positive(),
  points: z.array(MetricPointSchema).max(METRIC_SERIES_MAX_POINTS),
});
export type MetricSeries = z.infer<typeof MetricSeriesSchema>;

export const MetricSeriesResponseSchema = z.strictObject({
  series: z.array(MetricSeriesSchema).max(METRIC_NAMES.length),
});

// ---- service status ---------------------------------------------------------------------------

export const ServiceStatusSummarySchema = z.strictObject({
  serviceId: z.uuid(),
  runtimeStatus: z.enum(SERVICE_STATUSES),
  /** null when no container exists or none was observed yet. */
  container: z
    .strictObject({
      state: z.enum(DOCKER_CONTAINER_STATES),
      restartCount: z.number().int().nonnegative(),
      healthcheck: z.enum(HEALTHCHECK_OUTCOMES),
      observedAt: Timestamp,
    })
    .nullable(),
  lastDeployment: z
    .strictObject({
      id: z.uuid(),
      status: z.enum(DEPLOYMENT_STATUSES),
      commitSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
      finishedAt: Timestamp.nullable(),
    })
    .nullable(),
  flags: z.strictObject({ highMemory: z.boolean(), highDisk: z.boolean() }),
});
export type ServiceStatusSummary = z.infer<typeof ServiceStatusSummarySchema>;

// ---- logs -------------------------------------------------------------------------------------

/** ADR 0012: at most 1000 lines per page; a line over 8 KiB is truncated and flagged. */
export const LOG_PAGE_MAX_ENTRIES = 1000;
export const LOG_LINE_MAX_LENGTH = 8 * 1024;
export const LOG_STREAMS = Object.freeze(["stdout", "stderr"] as const);

export const LogEntryViewSchema = z.strictObject({
  source: z.enum(LOG_SOURCES),
  timestamp: Timestamp,
  level: z.enum(LOG_LEVELS),
  /** Runtime lines only; null for build, deploy and activity entries. */
  stream: z.enum(LOG_STREAMS).nullable(),
  /** Already redacted with the service's secret values. */
  text: z.string().max(LOG_LINE_MAX_LENGTH),
  truncated: z.boolean(),
});
export type LogEntryView = z.infer<typeof LogEntryViewSchema>;

export const LogPageSchema = z.strictObject({
  entries: z.array(LogEntryViewSchema).max(LOG_PAGE_MAX_ENTRIES),
  since: Timestamp,
  until: Timestamp,
  /** Pagination is backwards: the next page ends at the oldest entry returned. */
  nextUntil: Timestamp.nullable(),
  /** Requested sources that could not be read for this page (e.g. an unreachable server). */
  unavailableSources: z.array(z.enum(LOG_SOURCES)).max(LOG_SOURCES.length),
});
export type LogPage = z.infer<typeof LogPageSchema>;

// ---- graph ------------------------------------------------------------------------------------

export const GRAPH_MAX_NODES = 5000;
export const GRAPH_MAX_RELATIONS = 20_000;

const NodeId = z.string().max(64);
const NodeBase = { id: NodeId, entityId: z.uuid(), label: Label };

export const GraphNodeViewSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...NodeBase, kind: z.literal("Server") }),
  z.strictObject({ ...NodeBase, kind: z.literal("Project") }),
  z.strictObject({ ...NodeBase, kind: z.literal("Environment"), projectId: z.uuid() }),
  z.strictObject({
    ...NodeBase,
    kind: z.literal("Service"),
    projectId: z.uuid(),
    environmentId: z.uuid(),
    serverId: z.uuid(),
  }),
  z.strictObject({
    ...NodeBase,
    kind: z.literal("Domain"),
    projectId: z.uuid(),
    environmentId: z.uuid(),
    serviceId: z.uuid(),
  }),
]);

export const GraphRelationViewSchema = z.strictObject({
  id: z.string().max(160),
  type: z.enum(GRAPH_RELATION_TYPES),
  from: NodeId,
  to: NodeId,
  /** DEPENDS_ON only: env keys, never values. */
  envKeys: z.array(z.string().max(MAX_ENV_KEY_LENGTH)).max(100).optional(),
});

export const GraphViewSchema = z.strictObject({
  nodes: z.array(GraphNodeViewSchema).max(GRAPH_MAX_NODES),
  relations: z.array(GraphRelationViewSchema).max(GRAPH_MAX_RELATIONS),
  omitted: z
    .array(
      z.strictObject({
        kind: z.enum(GRAPH_NODE_KINDS),
        entityId: z.string().max(64),
        reason: z.enum(GRAPH_OMIT_REASONS),
      }),
    )
    .max(GRAPH_MAX_NODES),
});
export type GraphView = z.infer<typeof GraphViewSchema>;

// ---- AI provider settings ---------------------------------------------------------------------

export const AI_PROVIDERS = Object.freeze(["anthropic", "openai"] as const);
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** Per-provider model allowlist (ADR 0012 pinned defaults); a new model is an ADR amendment. */
export const AI_PROVIDER_MODELS = Object.freeze({
  anthropic: Object.freeze(["claude-opus-5-5"] as const),
  openai: Object.freeze(["gpt-5-2025-08-07"] as const),
} satisfies Record<AiProvider, readonly string[]>);

export const AI_PROVIDER_KEY_MIN_LENGTH = 20;
export const AI_PROVIDER_KEY_MAX_LENGTH = 512;

/** At most the last 4 characters of the key, after a fixed mask. It cannot hold a whole key. */
export const AI_KEY_HINT_PATTERN = /^•{8}[\x21-\x7e]{0,4}$/;

/** Write-only: the key is accepted here and never appears in any view. */
export const PutAiProviderSettingsBodySchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("anthropic"),
    model: z.enum(AI_PROVIDER_MODELS.anthropic),
    apiKey: z.string().min(AI_PROVIDER_KEY_MIN_LENGTH).max(AI_PROVIDER_KEY_MAX_LENGTH),
  }),
  z.strictObject({
    provider: z.literal("openai"),
    model: z.enum(AI_PROVIDER_MODELS.openai),
    apiKey: z.string().min(AI_PROVIDER_KEY_MIN_LENGTH).max(AI_PROVIDER_KEY_MAX_LENGTH),
  }),
]);

const settingsView = { keyHint: z.string().regex(AI_KEY_HINT_PATTERN), validatedAt: Timestamp, updatedAt: Timestamp };

/** No field can carry the key: provider and model are enums, the hint is capped by its pattern. */
export const AiProviderSettingsViewSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("anthropic"), model: z.enum(AI_PROVIDER_MODELS.anthropic), ...settingsView }),
  z.strictObject({ provider: z.literal("openai"), model: z.enum(AI_PROVIDER_MODELS.openai), ...settingsView }),
]);
export type AiProviderSettingsView = z.infer<typeof AiProviderSettingsViewSchema>;

export const AiProviderSettingsResponseSchema = z.strictObject({
  settings: AiProviderSettingsViewSchema.nullable(),
});

// ---- structured answer ------------------------------------------------------------------------

export const AI_ANSWER_MAX_LENGTH = 4000;
export const AI_ANSWER_MAX_ENTITIES = 20;
export const AI_ANSWER_MAX_EVIDENCE = 20;
export const AI_ANSWER_MAX_MISSING_EVIDENCE = 10;
export const AI_EVIDENCE_REF_MAX_LENGTH = 200;
export const AI_EVIDENCE_NOTE_MAX_LENGTH = 500;

/** Entity kinds an answer can cite; chips navigate only by these kinds and validated UUIDs. */
export const AI_ENTITY_KINDS = Object.freeze([...GRAPH_NODE_KINDS, "Deployment"] as const);

export const AiEntityRefSchema = z.strictObject({
  kind: z.enum(AI_ENTITY_KINDS),
  id: z.uuid(),
  label: Label,
});

/** `ref` is the id a tool returned (a tool call or entity reference); the agent drops unknown ones. */
export const AiEvidenceRefSchema = z.strictObject({
  ref: z.string().min(1).max(AI_EVIDENCE_REF_MAX_LENGTH),
  note: z.string().max(AI_EVIDENCE_NOTE_MAX_LENGTH),
});

export const AiStructuredAnswerSchema = z.strictObject({
  answer: z.string().min(1).max(AI_ANSWER_MAX_LENGTH),
  diagnosis: z.enum(DIAGNOSES),
  confidence: z.number().min(0).max(1),
  entities: z.array(AiEntityRefSchema).max(AI_ANSWER_MAX_ENTITIES),
  evidence: z.array(AiEvidenceRefSchema).max(AI_ANSWER_MAX_EVIDENCE),
  /** For `unknown`: what evidence was missing. */
  missingEvidence: z.array(z.string().min(1).max(AI_EVIDENCE_NOTE_MAX_LENGTH)).max(AI_ANSWER_MAX_MISSING_EVIDENCE),
});
export type AiStructuredAnswer = z.infer<typeof AiStructuredAnswerSchema>;

// ---- conversations, messages, tool calls ------------------------------------------------------

export const AI_CONVERSATION_TITLE_MAX_LENGTH = 200;
export const AI_QUESTION_MAX_LENGTH = 4000;
export const AI_MESSAGE_MAX_LENGTH = 16_000;
export const AI_MAX_TOOL_CALLS_PER_MESSAGE = 16;
export const AI_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const AI_MESSAGE_ROLES = Object.freeze(["user", "assistant"] as const);
export const AI_MESSAGE_STATUSES = Object.freeze(["pending", "complete", "failed", "aborted"] as const);
export const AI_TOOL_CALL_STATUSES = Object.freeze(["ok", "error", "refused"] as const);

export const AiConversationViewSchema = z.strictObject({
  id: z.uuid(),
  title: z.string().max(AI_CONVERSATION_TITLE_MAX_LENGTH),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AiConversationView = z.infer<typeof AiConversationViewSchema>;

export const ListAiConversationsResponseSchema = z.strictObject({ items: z.array(AiConversationViewSchema) });

/** Name and scope only: tool input and output never leave the server through this view. */
export const AiToolCallRecordSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().regex(AI_TOOL_NAME_PATTERN),
  scope: z.strictObject({ kind: z.enum(AI_ENTITY_KINDS), id: z.uuid() }).nullable(),
  status: z.enum(AI_TOOL_CALL_STATUSES),
  errorCode: z.enum(V05_SERVICE_ERROR_CODES).nullable(),
  durationMs: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export type AiToolCallRecord = z.infer<typeof AiToolCallRecordSchema>;

export const AiMessageViewSchema = z.strictObject({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: z.enum(AI_MESSAGE_ROLES),
  status: z.enum(AI_MESSAGE_STATUSES),
  /** Redacted text: the question, or the assistant's streamed text. */
  content: z.string().max(AI_MESSAGE_MAX_LENGTH),
  answer: AiStructuredAnswerSchema.nullable(),
  toolCalls: z.array(AiToolCallRecordSchema).max(AI_MAX_TOOL_CALLS_PER_MESSAGE),
  errorCode: z.enum(V05_SERVICE_ERROR_CODES).nullable(),
  createdAt: Timestamp,
});
export type AiMessageView = z.infer<typeof AiMessageViewSchema>;

export const AiConversationDetailSchema = z.strictObject({
  conversation: AiConversationViewSchema,
  messages: z.array(AiMessageViewSchema),
});

export const AskBodySchema = z.strictObject({
  question: z.string().min(1).max(AI_QUESTION_MAX_LENGTH),
});
