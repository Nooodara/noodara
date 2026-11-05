// 29-02 (A2, H1): provider cassettes. A live run records every provider turn under a key that is
// the SHA-256 of the canonicalized, redacted request (sorted keys; model id, system prompt,
// messages, tool definitions, output cap). Nothing about the transport enters the key: no header,
// API key, timestamp or request id. Replay answers a turn only from an entry recorded with the
// pinned model under the same key; anything else is a miss that fails the run.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AIProviderError,
  type AIChatRequest,
  type AIChatResponse,
  type AIProvider,
  type AIStreamChunk,
  type AIStreamRequest,
  type AIToolCallRequest,
  type ImplementedAIProviderId,
} from '@noodara/ai';
import type { Redactor } from '@noodara/domain';
import { z } from 'zod';
import { findRealSecrets } from './secret-scan.js';

export const CASSETTE_SCHEMA_VERSION = 1;

/** JSON with object keys sorted at every depth; `undefined` members disappear as in JSON. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : sortKeys(item)));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined && typeof item !== 'function') sorted[key] = sortKeys(item);
    }
    return sorted;
  }
  return value;
}

/** The only request fields a cassette key covers. Everything else (signal, transport) is dropped. */
export function canonicalRequest(model: string, request: AIStreamRequest): Record<string, unknown> {
  return {
    model,
    system: request.system ?? null,
    maxTokens: request.maxTokens ?? null,
    tools: request.tools ?? [],
    messages: request.messages,
  };
}

export function cassetteKey(model: string, request: AIStreamRequest, redactor: Redactor): string {
  const canonical = canonicalJson(redactor.redact(canonicalRequest(model, request)));
  return createHash('sha256').update(canonical).digest('hex');
}

// ---- file format ------------------------------------------------------------------------------

const ToolCallSchema = z.strictObject({ id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) });
const ResponseSchema = z.strictObject({
  text: z.string(),
  toolCalls: z.array(ToolCallSchema),
  stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'refusal', 'pause', 'other']),
  usage: z.strictObject({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() }),
  message: z.strictObject({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(ToolCallSchema),
    reasoning: z.strictObject({ provider: z.enum(['anthropic', 'openai']), blocks: z.array(z.unknown()) }).optional(),
  }),
});
const ErrorSchema = z.strictObject({
  code: z.enum(['AI_PROVIDER_AUTH_FAILED', 'AI_PROVIDER_RATE_LIMITED', 'AI_PROVIDER_UNAVAILABLE']),
  reason: z.string().min(1).max(40),
});

const InteractionSchema = z.union([
  z.strictObject({ key: z.string().regex(/^[0-9a-f]{64}$/), model: z.string().min(1), turn: z.int().positive(), response: ResponseSchema }),
  z.strictObject({ key: z.string().regex(/^[0-9a-f]{64}$/), model: z.string().min(1), turn: z.int().positive(), error: ErrorSchema }),
]);
export type CassetteInteraction = z.infer<typeof InteractionSchema>;

export const CassetteFileSchema = z.strictObject({
  schemaVersion: z.literal(CASSETTE_SCHEMA_VERSION),
  /** Cassettes only ever come from a live run against the provider. */
  source: z.literal('live'),
  provider: z.enum(['anthropic', 'openai']),
  model: z.string().min(1),
  scenarioId: z.string().min(1),
  datasetVersion: z.string().min(1),
  recordedOn: z.iso.date(),
  /** 0 when the provider accepted it, null when the pinned model only samples at its default. */
  temperature: z.literal(0).nullable(),
  interactions: z.array(InteractionSchema),
});
export type CassetteFile = z.infer<typeof CassetteFileSchema>;

export function cassettePath(dir: string, provider: ImplementedAIProviderId, scenarioId: string): string {
  return join(dir, provider, 'scenarios', `${scenarioId}.json`);
}

export function readCassette(file: string): CassetteFile | null {
  if (!existsSync(file)) return null;
  return CassetteFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** A JSON member named like an auth header, or a bearer token. */
const AUTH_HEADER_PATTERN = /"(?:authorization|proxy-authorization|x-api-key|api-key)"\s*:|\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i;

/** Why `text` must not be written: a forbidden value, a real credential shape, or an auth header. */
export function cassetteProblems(text: string, forbidden: readonly string[]): string[] {
  const problems: string[] = [];
  forbidden.forEach((value, index) => {
    if (value.length > 0 && text.includes(value)) problems.push(`forbidden value #${index}`);
  });
  problems.push(...findRealSecrets(text));
  if (AUTH_HEADER_PATTERN.test(text)) problems.push('auth header');
  return problems;
}

/** Writes atomically after a final scan; refuses to write a cassette holding any secret. */
export function writeCassette(file: string, cassette: CassetteFile, forbidden: readonly string[]): void {
  const text = `${JSON.stringify(CassetteFileSchema.parse(cassette), null, 2)}\n`;
  const problems = cassetteProblems(text, forbidden);
  if (problems.length > 0) throw new Error(`cassette ${cassette.scenarioId} not written: ${problems.join(', ')}`);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, text, { mode: 0o644 });
  renameSync(temp, file);
}

/** SHA-256 over the given scenarios' cassettes for one provider; ties a baseline to its recording. */
export function cassetteDigest(dir: string, provider: ImplementedAIProviderId, scenarioIds: readonly string[]): string {
  const hash = createHash('sha256');
  for (const id of [...scenarioIds].sort()) {
    const cassette = readCassette(cassettePath(dir, provider, id));
    hash.update(`${id}\n${cassette === null ? 'missing' : canonicalJson(cassette)}\n`);
  }
  return hash.digest('hex');
}

export function listCassetteIds(dir: string, provider: ImplementedAIProviderId): string[] {
  const root = join(dir, provider, 'scenarios');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

// ---- providers --------------------------------------------------------------------------------

export class CassetteMissError extends Error {
  constructor(
    readonly scenarioId: string,
    readonly key: string,
    readonly turn: number,
  ) {
    super(`cassette miss: scenario ${scenarioId}, turn ${turn}, key ${key}`);
    this.name = 'CassetteMissError';
  }
}

const unsupportedStream = (): AsyncIterable<AIStreamChunk> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.reject(new AIProviderError('AI_PROVIDER_UNAVAILABLE', 'unexpected_response')),
  }),
});

export interface ReplayProviderOptions {
  readonly provider: ImplementedAIProviderId;
  /** The pinned model: entries recorded with any other model never answer. */
  readonly model: string;
  readonly scenarioId: string;
  readonly cassette: CassetteFile | null;
  readonly redactor: Redactor;
}

export function createReplayProvider(options: ReplayProviderOptions): AIProvider {
  const byKey = new Map<string, CassetteInteraction[]>();
  const usable = options.cassette !== null && options.cassette.model === options.model && options.cassette.provider === options.provider;
  for (const interaction of usable ? (options.cassette?.interactions ?? []) : []) {
    if (interaction.model !== options.model) continue;
    byKey.set(interaction.key, [...(byKey.get(interaction.key) ?? []), interaction]);
  }
  let turn = 0;

  async function play(request: AIStreamRequest): Promise<AIChatResponse> {
    turn += 1;
    const key = cassetteKey(options.model, request, options.redactor);
    const queue = byKey.get(key);
    const interaction = queue?.shift();
    if (interaction === undefined) throw new CassetteMissError(options.scenarioId, key, turn);
    if ('error' in interaction) throw new AIProviderError(interaction.error.code, interaction.error.reason as AIProviderError['reason']);
    return Promise.resolve(structuredClone(interaction.response) as AIChatResponse);
  }

  return {
    id: options.provider,
    model: options.model,
    chat: (request: AIChatRequest) => play(request),
    toolCall: (request: AIToolCallRequest) => play(request),
    stream: unsupportedStream,
  };
}

export interface RecordingProvider extends AIProvider {
  readonly interactions: readonly CassetteInteraction[];
}

/**
 * Wraps a live provider. Each response is redacted before it is recorded or returned, so the live
 * run and its replay feed the agent loop exactly the same turn.
 */
export function createRecordingProvider(inner: AIProvider, redactor: Redactor): RecordingProvider {
  const interactions: CassetteInteraction[] = [];

  async function record(request: AIStreamRequest, call: () => Promise<AIChatResponse>): Promise<AIChatResponse> {
    const turn = interactions.length + 1;
    const key = cassetteKey(inner.model, request, redactor);
    try {
      const response = redactor.redact(await call());
      interactions.push({ key, model: inner.model, turn, response: ResponseSchema.parse(structuredClone(response)) });
      return response;
    } catch (error) {
      if (error instanceof AIProviderError) interactions.push({ key, model: inner.model, turn, error: { code: error.code, reason: error.reason } });
      throw error;
    }
  }

  return {
    id: inner.id,
    model: inner.model,
    interactions,
    chat: (request: AIChatRequest) => record(request, () => inner.chat(request)),
    toolCall: (request: AIToolCallRequest) => record(request, () => inner.toolCall(request)),
    stream: unsupportedStream,
  };
}
