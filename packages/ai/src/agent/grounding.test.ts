// 28-04 A1, A3: answer parsing and the hallucination guard.
import { describe, expect, it } from 'vitest';
import { fallbackAnswer, groundAnswer, GroundingIndex, parseStructuredAnswer, UNGROUNDED_NOTE } from './grounding.js';

const ID = '7d1f3c2a-4b5e-4f60-8a71-92b3c4d5e6f7';
const base = {
  answer: 'ok',
  diagnosis: 'high_disk' as const,
  confidence: 0.6,
  entities: [{ kind: 'Server' as const, id: ID, label: 'web' }],
  evidence: [{ ref: 'c1', note: 'disk at 97%' }],
  missingEvidence: [],
};

describe('parseStructuredAnswer', () => {
  it('accepts bare, fenced and wrapped JSON that matches the schema', () => {
    const json = JSON.stringify(base);
    expect(parseStructuredAnswer(json)).toEqual(base);
    expect(parseStructuredAnswer(`\`\`\`json\n${json}\n\`\`\``)).toEqual(base);
    expect(parseStructuredAnswer(`Here it is: ${json}`)).toEqual(base);
  });

  it('rejects prose, broken JSON and schema violations', () => {
    expect(parseStructuredAnswer('the disk is full')).toBeNull();
    expect(parseStructuredAnswer('{"answer": ')).toBeNull();
    expect(parseStructuredAnswer(JSON.stringify({ ...base, diagnosis: 'aliens' }))).toBeNull();
    expect(parseStructuredAnswer(JSON.stringify({ ...base, extra: true }))).toBeNull();
    expect(parseStructuredAnswer(JSON.stringify({ ...base, confidence: 2 }))).toBeNull();
  });
});

describe('groundAnswer', () => {
  it('keeps what a tool returned (case-insensitive ids, nested data)', () => {
    const index = new GroundingIndex();
    index.addCall('c1');
    index.addResult({ items: [{ server: { id: ID.toUpperCase() } }] });
    const { answer, report } = groundAnswer(base, index);
    expect(answer).toEqual(base);
    expect(report).toEqual({ hallucinatedEntities: [], hallucinatedEvidence: [], downgraded: false });
  });

  it('strips unknown ids and downgrades an unsupported diagnosis', () => {
    const { answer, report } = groundAnswer(base, new GroundingIndex());
    expect(answer).toEqual(
      expect.objectContaining({ diagnosis: 'unknown', confidence: 0, entities: [], evidence: [], missingEvidence: [UNGROUNDED_NOTE] }),
    );
    expect(report).toEqual({ hallucinatedEntities: [ID], hallucinatedEvidence: ['c1'], downgraded: true });
  });

  it('does not downgrade an unknown answer and respects the missing-evidence cap', () => {
    expect(groundAnswer(fallbackAnswer(), new GroundingIndex()).report.downgraded).toBe(false);
    const full = { ...base, missingEvidence: Array.from({ length: 10 }, (_, i) => `m${String(i)}`) };
    expect(groundAnswer(full, new GroundingIndex()).answer.missingEvidence).toHaveLength(10);
  });

  it('ignores non-uuid strings and stops at a depth bound', () => {
    const index = new GroundingIndex();
    index.addCall('');
    index.addResult({ name: 'not-an-id' });
    let deep: unknown = ID;
    for (let i = 0; i < 40; i += 1) deep = [deep];
    index.addResult(deep);
    expect(index.hasRef('not-an-id')).toBe(false);
    expect(index.hasRef('')).toBe(false);
    expect(index.hasEntity(ID)).toBe(false);
  });
});
