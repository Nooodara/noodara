// 28-04 (A1, A3): the final reply must be one structured answer, and everything it cites must come
// from a tool call in this conversation. Unknown entity ids and evidence refs are stripped and
// reported as hallucinated; a diagnosis left with no supporting evidence becomes `unknown`.
import { AI_ANSWER_MAX_MISSING_EVIDENCE, AiStructuredAnswerSchema, type AiStructuredAnswer } from '@noodara/domain/api-contract';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WALK_DEPTH = 32;

export const UNGROUNDED_NOTE = 'No tool result in this conversation supported the proposed diagnosis.';
export const FALLBACK_ANSWER_TEXT = 'The assistant could not produce a structured answer for this question.';
export const FALLBACK_MISSING_NOTE = 'The model did not return a valid structured answer.';

/** Ids and refs a tool returned in this conversation. */
export class GroundingIndex {
  readonly #entityIds = new Set<string>();
  readonly #refs = new Set<string>();

  /** A tool call id the model may cite as evidence. */
  addCall(callId: string): void {
    if (callId !== '') this.#refs.add(callId);
  }

  /** Every UUID inside a successful tool result becomes a citable entity id and evidence ref. */
  addResult(data: unknown): void {
    this.#walk(data, 0);
  }

  hasEntity(id: string): boolean {
    return this.#entityIds.has(id.toLowerCase());
  }

  hasRef(ref: string): boolean {
    return this.#refs.has(ref) || this.#entityIds.has(ref.toLowerCase());
  }

  #walk(value: unknown, depth: number): void {
    if (depth > MAX_WALK_DEPTH) return;
    if (typeof value === 'string') {
      if (UUID_PATTERN.test(value)) this.#entityIds.add(value.toLowerCase());
    } else if (Array.isArray(value)) {
      for (const item of value) this.#walk(item, depth + 1);
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) this.#walk(item, depth + 1);
    }
  }
}

/** Pulls the JSON object out of the reply (bare, fenced, or wrapped in stray text). */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last <= first) return undefined;
  try {
    return JSON.parse(body.slice(first, last + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/** The reply validated against the structured answer schema, or null. */
export function parseStructuredAnswer(text: string): AiStructuredAnswer | null {
  const parsed = AiStructuredAnswerSchema.safeParse(extractJson(text));
  return parsed.success ? parsed.data : null;
}

export function fallbackAnswer(): AiStructuredAnswer {
  return {
    answer: FALLBACK_ANSWER_TEXT,
    diagnosis: 'unknown',
    confidence: 0,
    entities: [],
    evidence: [],
    missingEvidence: [FALLBACK_MISSING_NOTE],
  };
}

export interface GroundingReport {
  readonly hallucinatedEntities: readonly string[];
  readonly hallucinatedEvidence: readonly string[];
  /** A diagnosis was replaced by `unknown` because no evidence supported it. */
  readonly downgraded: boolean;
}

export interface GroundedAnswer {
  readonly answer: AiStructuredAnswer;
  readonly report: GroundingReport;
}

export function groundAnswer(answer: AiStructuredAnswer, index: GroundingIndex): GroundedAnswer {
  const entities = answer.entities.filter((entity) => index.hasEntity(entity.id));
  const evidence = answer.evidence.filter((item) => index.hasRef(item.ref));
  const hallucinatedEntities = answer.entities.filter((entity) => !index.hasEntity(entity.id)).map((entity) => entity.id);
  const hallucinatedEvidence = answer.evidence.filter((item) => !index.hasRef(item.ref)).map((item) => item.ref);

  const downgraded = answer.diagnosis !== 'unknown' && evidence.length === 0;
  const missingEvidence =
    downgraded && answer.missingEvidence.length < AI_ANSWER_MAX_MISSING_EVIDENCE
      ? [...answer.missingEvidence, UNGROUNDED_NOTE]
      : answer.missingEvidence;

  return {
    answer: {
      ...answer,
      diagnosis: downgraded ? 'unknown' : answer.diagnosis,
      confidence: downgraded ? 0 : answer.confidence,
      entities,
      evidence,
      missingEvidence,
    },
    report: { hallucinatedEntities, hallucinatedEvidence, downgraded },
  };
}
