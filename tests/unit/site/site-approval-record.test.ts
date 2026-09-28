// 10-12-PLAN.md Task 1 (SITE-03 / Success Criterion 5, D-13/D-15). Phase 10 closes with a
// "Phase 10 — Public site" block in the same docs/ui/APPROVAL.md record Phases 7-9 already use
// (see tests/unit/ui/approval-record.test.ts for the G1/G2/G3 precedent this mirrors). Unlike
// those three-gate blocks, Phase 10 is a single gate: one heading, one Field/Value table, one
// Adjustment log. Until a human approves it, the block legitimately carries `pending` in
// Date/Rounds used/Approver -- this test only asserts the block EXISTS and is WELL-FORMED, never
// that it is filled in, so it is green from Task 1 onward and stays green once Task 2 fills it in.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APPROVAL_PATH = 'docs/ui/APPROVAL.md';
const HEADING = '## Phase 10 — Public site';

const approval = (): string => readFileSync(APPROVAL_PATH, 'utf8');

/** The full text of the Phase 10 block, from its own heading up to (excluding) the next
 *  top-level `## ` heading or end of file. */
function phase10Section(): string {
  const text = approval();
  const start = text.indexOf(HEADING);
  expect(start, `no "${HEADING}" heading in ${APPROVAL_PATH}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + HEADING.length);
  const nextIndex = rest.search(/^## /m);
  const end = nextIndex === -1 ? text.length : start + HEADING.length + nextIndex;
  return text.slice(start, end);
}

/** The value cell of a two-column row `| <label> | <value> |`, scoped to the Phase 10 section. */
function row(section: string, label: string): string {
  const match = section.match(new RegExp(String.raw`^\|\s*${label}\s*\|\s*(.+?)\s*\|\s*$`, 'm'));
  expect(match, `no \`| ${label} |\` row in the Phase 10 section of ${APPROVAL_PATH}`).toBeTruthy();
  return match?.[1] ?? '';
}

describe('docs/ui/APPROVAL.md > Phase 10 — Public site', () => {
  it('has exactly one "## Phase 10 — Public site" heading', () => {
    const count = (approval().match(new RegExp(`^${HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm')) ?? [])
      .length;
    expect(count).toBe(1);
  });

  it('has a well-formed Field/Value table with all five required rows', () => {
    const section = phase10Section();
    for (const label of ['Gate', 'Date', 'Rounds used', 'Approver', 'Evidence']) {
      expect(row(section, label).length, `"${label}" row is empty`).toBeGreaterThan(0);
    }
  });

  it('names "Phase 10 — Public site" in the Gate row', () => {
    expect(row(phase10Section(), 'Gate')).toBe('Phase 10 — Public site');
  });

  it('Date is "pending" or an ISO date (YYYY-MM-DD)', () => {
    expect(row(phase10Section(), 'Date')).toMatch(/^(pending|\d{4}-\d{2}-\d{2})$/);
  });

  it('Rounds used is "pending" or an integer between 0 and 2', () => {
    expect(row(phase10Section(), 'Rounds used')).toMatch(/^(pending|[012])$/);
  });

  it('Approver is "pending" or a non-empty name', () => {
    const value = row(phase10Section(), 'Approver');
    expect(value.length).toBeGreaterThan(0);
    if (value !== 'pending') {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('Evidence cites the site review capture root and the capture command', () => {
    const value = row(phase10Section(), 'Evidence');
    expect(value).toContain('docs/ui/review/site/');
    expect(value).toContain('ui:review:site');
  });

  it('has its own Adjustment log naming both rounds, including an unused one', () => {
    const section = phase10Section();
    expect(section).toMatch(/### Adjustment log/);
    const log = section.slice(section.search(/### Adjustment log/));
    expect(log).toMatch(/Round 1:/);
    expect(log).toMatch(/Round 2:/);
  });
});
