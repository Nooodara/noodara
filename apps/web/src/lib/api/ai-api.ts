// 30-04: typed client of the 28-02 BYOK settings routes and the 28-05 conversation routes.
// - The key is write-only: it goes out once in a `sensitive` PUT (a failure that echoes it is
//   replaced with fixed copy) and no function here returns, stores or logs it.
// - askQuestion reads the POST's SSE stream with fetch (EventSource cannot POST). Frames are parsed
//   defensively and every answer is sanitised: entities keep only known kinds with UUID ids, so a
//   chip can only ever link to a route built from a validated id.
import { DIAGNOSES, type Diagnosis } from '@noodara/domain';
import {
  AI_ENTITY_KINDS,
  AI_PROVIDER_MODELS,
  AI_QUESTION_MAX_LENGTH,
  AI_TOOL_NAME_PATTERN,
  V05_ERROR_MESSAGES,
  type AiProvider,
  type AiProviderSettingsView,
  type V05ServiceErrorCode,
} from '@noodara/domain/api-contract';
import {
  deployApiGet,
  deployApiSend,
  networkFailure,
  toDeployApiFailure,
  type ApiFailure,
  type ApiResult,
  type DeployApiErrorCode,
} from '../api-client';
import { isUuid } from './graph-api';

export type { AiProvider, AiProviderSettingsView, Diagnosis, V05ServiceErrorCode };
export { AI_PROVIDER_MODELS, AI_QUESTION_MAX_LENGTH, DIAGNOSES, V05_ERROR_MESSAGES };

export type AiFailure = ApiFailure<DeployApiErrorCode>;
export type AiEntityKind = (typeof AI_ENTITY_KINDS)[number];

const SETTINGS_PATH = '/api/settings/ai';
const CONVERSATIONS_PATH = '/api/ai/conversations';

// ---- settings ---------------------------------------------------------------------------------

export function getAiSettings(): Promise<ApiResult<{ settings: AiProviderSettingsView | null }, DeployApiErrorCode>> {
  return deployApiGet(SETTINGS_PATH);
}

export interface PutAiSettingsInput {
  readonly provider: AiProvider;
  readonly model: string;
  readonly apiKey: string;
}

/** Validates the key against the provider (one bounded call server-side) and stores it. */
export function putAiSettings(input: PutAiSettingsInput): Promise<ApiResult<AiProviderSettingsView, DeployApiErrorCode>> {
  return deployApiSend('PUT', SETTINGS_PATH, { provider: input.provider, model: input.model, apiKey: input.apiKey }, { sensitive: true });
}

export function deleteAiSettings(): Promise<ApiResult<undefined, DeployApiErrorCode>> {
  return deployApiSend('DELETE', SETTINGS_PATH);
}

// ---- conversations ----------------------------------------------------------------------------

export interface AiConversation {
  readonly id: string;
  readonly title: string;
}

export async function createConversation(): Promise<ApiResult<AiConversation, DeployApiErrorCode>> {
  const result = await deployApiSend<{ id?: unknown; title?: unknown }>('POST', CONVERSATIONS_PATH, {});
  if (!result.ok) return result;
  if (!isUuid(result.data.id)) return { ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong.', unauthorized: false };
  return { ok: true, data: { id: result.data.id, title: typeof result.data.title === 'string' ? result.data.title : '' } };
}

// ---- answer sanitising ------------------------------------------------------------------------

export interface AiEntity {
  readonly kind: AiEntityKind;
  readonly id: string;
  readonly label: string;
}

export interface AiEvidence {
  readonly ref: string;
  readonly note: string;
}

export interface AiAnswer {
  readonly answer: string;
  readonly diagnosis: Diagnosis;
  readonly confidence: number;
  readonly entities: readonly AiEntity[];
  readonly evidence: readonly AiEvidence[];
  readonly missingEvidence: readonly string[];
}

export interface AiToolCall {
  readonly name: string;
  readonly scope: { readonly kind: AiEntityKind; readonly id: string } | null;
}

const MAX_TEXT = 4000;
const MAX_NOTE = 500;
const MAX_LABEL = 200;
const MAX_ITEMS = 20;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]).slice(0, MAX_ITEMS) : [];
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function isEntityKind(value: unknown): value is AiEntityKind {
  return (AI_ENTITY_KINDS as readonly unknown[]).includes(value);
}

function isDiagnosis(value: unknown): value is Diagnosis {
  return (DIAGNOSES as readonly unknown[]).includes(value);
}

/** Keeps only well-formed parts of an answer; returns null when there is no answer text. */
export function sanitizeAnswer(raw: unknown): AiAnswer | null {
  const value = record(raw);
  if (value === null) return null;
  const answer = text(value.answer, MAX_TEXT);
  if (answer === null) return null;
  const entities: AiEntity[] = [];
  const seen = new Set<string>();
  for (const item of list(value.entities)) {
    const entity = record(item);
    if (entity === null || !isEntityKind(entity.kind) || !isUuid(entity.id)) continue;
    const label = text(entity.label, MAX_LABEL);
    const key = `${entity.kind}:${entity.id.toLowerCase()}`;
    if (label === null || seen.has(key)) continue;
    seen.add(key);
    entities.push({ kind: entity.kind, id: entity.id, label });
  }
  const evidence: AiEvidence[] = [];
  for (const item of list(value.evidence)) {
    const entry = record(item);
    const ref = entry === null ? null : text(entry.ref, MAX_LABEL);
    if (entry === null || ref === null) continue;
    evidence.push({ ref, note: typeof entry.note === 'string' ? entry.note.slice(0, MAX_NOTE) : '' });
  }
  const missingEvidence = list(value.missingEvidence).flatMap((item) => {
    const note = text(item, MAX_NOTE);
    return note === null ? [] : [note];
  });
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? Math.min(1, Math.max(0, value.confidence)) : 0;
  return {
    answer,
    diagnosis: isDiagnosis(value.diagnosis) ? value.diagnosis : 'unknown',
    confidence,
    entities,
    evidence,
    missingEvidence,
  };
}

export function sanitizeToolCall(raw: unknown): AiToolCall | null {
  const value = record(raw);
  if (value === null || typeof value.name !== 'string' || !AI_TOOL_NAME_PATTERN.test(value.name)) return null;
  const scope = record(value.scope);
  return {
    name: value.name,
    scope: scope !== null && isEntityKind(scope.kind) && isUuid(scope.id) ? { kind: scope.kind, id: scope.id } : null,
  };
}

// ---- SSE ---------------------------------------------------------------------------------------

export type AskEvent =
  | { readonly type: 'start'; readonly messageId: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: AiToolCall }
  | { readonly type: 'answer'; readonly answer: AiAnswer }
  | { readonly type: 'error'; readonly code: V05ServiceErrorCode | 'INTERNAL_ERROR' }
  | { readonly type: 'done'; readonly status: 'complete' | 'failed' | 'aborted' };

const V05_CODES: ReadonlySet<string> = new Set(Object.keys(V05_ERROR_MESSAGES));
/** A raw SSE block longer than this is dropped unparsed (an answer of 4000 chars fits easily). */
export const AI_SSE_MAX_FRAME_CHARS = 64 * 1024;

/** Parses one SSE block (`event:` and `data:` lines). Comments, unknown events and malformed data are skipped. */
export function parseSseBlock(block: string): AskEvent | null {
  if (block.length > AI_SSE_MAX_FRAME_CHARS) return null;
  let event = '';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (event === '' || data.length === 0) return null;
  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(data.join('\n')) as unknown);
  } catch {
    return null;
  }
  if (payload === null) return null;
  switch (event) {
    case 'start':
      return typeof payload.messageId === 'string' ? { type: 'start', messageId: payload.messageId } : null;
    case 'text':
      return typeof payload.text === 'string' ? { type: 'text', text: payload.text.slice(0, MAX_TEXT) } : null;
    case 'tool_call': {
      const call = sanitizeToolCall(payload);
      return call === null ? null : { type: 'tool_call', call };
    }
    case 'answer': {
      const answer = sanitizeAnswer(payload.answer);
      return answer === null ? null : { type: 'answer', answer };
    }
    case 'error':
      return {
        type: 'error',
        code: typeof payload.error === 'string' && V05_CODES.has(payload.error) ? (payload.error as V05ServiceErrorCode) : 'INTERNAL_ERROR',
      };
    case 'done':
      return payload.status === 'complete' || payload.status === 'failed' || payload.status === 'aborted'
        ? { type: 'done', status: payload.status }
        : null;
    default:
      return null;
  }
}

/** Client cap on one answer: the server's stream cap (120 s) plus slack. */
export const AI_ASK_MAX_MS = 150_000;
export const AI_ASK_OPEN_TIMEOUT_MS = 30_000;

export interface AskOptions {
  readonly conversationId: string;
  readonly question: string;
  readonly signal: AbortSignal;
  readonly onEvent: (event: AskEvent) => void;
  readonly openTimeoutMs?: number;
  readonly maxDurationMs?: number;
}

export type AskResult = { readonly ok: true; readonly reason: 'ended' | 'aborted' } | AiFailure;

/** One POST per question; the stream's reader is cancelled on every exit. */
export async function askQuestion(options: AskOptions): Promise<AskResult> {
  if (!isUuid(options.conversationId)) return { ok: false, code: 'NOT_FOUND', message: 'Not found.', unauthorized: false };
  const local = new AbortController();
  const onAbort = (): void => {
    local.abort();
  };
  options.signal.addEventListener('abort', onAbort);
  const cap = setTimeout(onAbort, options.maxDurationMs ?? AI_ASK_MAX_MS);
  const openTimer = setTimeout(onAbort, options.openTimeoutMs ?? AI_ASK_OPEN_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${CONVERSATIONS_PATH}/${encodeURIComponent(options.conversationId)}/messages`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ question: options.question.slice(0, AI_QUESTION_MAX_LENGTH) }),
        signal: local.signal,
      });
    } catch {
      return options.signal.aborted ? { ok: true, reason: 'aborted' } : networkFailure();
    } finally {
      clearTimeout(openTimer);
    }
    if (!response.ok) return await toDeployApiFailure(response);
    if (response.body === null) return networkFailure();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, '\n');
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const event = parseSseBlock(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          if (event !== null) options.onEvent(event);
          index = buffer.indexOf('\n\n');
        }
        if (buffer.length > AI_SSE_MAX_FRAME_CHARS) buffer = '';
      }
      const tail = parseSseBlock(buffer.trim());
      if (tail !== null) options.onEvent(tail);
      return { ok: true, reason: 'ended' };
    } catch {
      return options.signal.aborted ? { ok: true, reason: 'aborted' } : networkFailure();
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  } finally {
    clearTimeout(cap);
    clearTimeout(openTimer);
    options.signal.removeEventListener('abort', onAbort);
  }
}
