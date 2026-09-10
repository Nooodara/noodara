import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Smoke test for the Vitest harness itself (noodara-tdd skill §1 RED-loop check). If any of
// these three assertions is inverted and starts passing/failing unexpectedly, the harness is
// broken and no TDD cycle in this repo can be trusted.
describe('vitest harness', () => {
  it('runs a trivially true assertion', () => {
    expect(1 + 1).toBe(2);
  });

  it('fails for the right reason when inverted', () => {
    // Inverting this expectation (e.g. expect(1 + 1).toBe(3)) must make the suite fail.
    expect(1 + 1).not.toBe(3);
  });

  it('keeps the QA-02 coverage gate wired to packages/domain in vitest.config.ts', () => {
    const config = readFileSync(new URL('../../vitest.config.ts', import.meta.url), 'utf8');
    const thresholdsBlock = config.slice(config.indexOf('thresholds:'));
    expect(thresholdsBlock).toContain('packages/domain');
  });
});
