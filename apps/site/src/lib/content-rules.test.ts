// 10-06-PLAN.md Task 1 (D-10): fixture-level RED test for content-rules.ts. Written before
// content-rules.ts exists -- confirmed failing on `pnpm vitest run` with "Cannot find module".

import { describe, expect, it } from 'vitest';
import { findForbiddenWording, findUnsafeMarkup } from './content-rules';

describe('findForbiddenWording', () => {
  it('flags "coming soon"', () => {
    const findings = findForbiddenWording('Domains are coming soon.');
    expect(findings.some((f) => f.rule === 'coming-soon')).toBe(true);
  });

  it('flags "soon"', () => {
    const findings = findForbiddenWording('Available soon.');
    expect(findings.some((f) => f.rule === 'soon')).toBe(true);
  });

  it('flags "roadmap"', () => {
    const findings = findForbiddenWording('See the roadmap.');
    expect(findings.some((f) => f.rule === 'roadmap')).toBe(true);
  });

  it('flags a bare year', () => {
    const findings = findForbiddenWording('Released in 2026.');
    expect(findings.some((f) => f.rule === 'date-year')).toBe(true);
  });

  it('flags an ISO date', () => {
    const findings = findForbiddenWording('2026-09-27');
    expect(findings.some((f) => f.rule === 'date-iso')).toBe(true);
  });

  it('flags a month + day', () => {
    const findings = findForbiddenWording('on September 27');
    expect(findings.some((f) => f.rule === 'date-month-day')).toBe(true);
  });

  it('does not flag technical numbers: version numbers, ports, exit codes, license years', () => {
    const findings = findForbiddenWording('Ubuntu 22.04 and 24.04, port 3000, exit 53, Apache License 2.0');
    expect(findings).toEqual([]);
  });

  it('does not flag a month name with no following day number', () => {
    expect(findForbiddenWording('May I')).toEqual([]);
  });

  it('flags planning ids: D-NN, T-NN-N, NN-NN-PLAN', () => {
    const findings = findForbiddenWording('see D-07 and T-10-03');
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain('planning-id');
    expect(findings.filter((f) => f.rule === 'planning-id')).toHaveLength(2);
  });

  it('flags no forbidden wording in a clean sentence', () => {
    expect(findForbiddenWording('Noodara connects to a server you already own over SSH.')).toEqual([]);
  });
});

describe('findUnsafeMarkup', () => {
  it('flags a raw <script> tag', () => {
    expect(findUnsafeMarkup('<script>x</script>').length).toBeGreaterThan(0);
  });

  it('flags a raw <iframe> tag', () => {
    expect(findUnsafeMarkup('<iframe src=x>').length).toBeGreaterThan(0);
  });

  it('flags a javascript: URL', () => {
    expect(findUnsafeMarkup('[a](javascript:alert(1))').length).toBeGreaterThan(0);
  });

  it('flags dangerouslySetInnerHTML', () => {
    expect(findUnsafeMarkup('dangerouslySetInnerHTML={{ __html: x }}').length).toBeGreaterThan(0);
  });

  it('does not flag a fenced code block showing curl piped to sh', () => {
    const text = ['Install with:', '', '```sh', 'curl -fsSL https://example.com/install.sh | sh', '```'].join('\n');
    expect(findUnsafeMarkup(text)).toEqual([]);
  });
});
