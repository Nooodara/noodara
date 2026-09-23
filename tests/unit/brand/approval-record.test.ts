// 07-05-PLAN.md Task 6 (BRAND-03, D-16, D-17): the approval act, kept honest by the code.
//
// D-17 says the approval is an explicit act of the user and that it is RECORDED -- date, chosen
// concept, rounds used -- in the brand kit, and that nothing may be applied to a product surface
// (BRAND-02) before that record exists. A record that nothing reads is a record that silently
// rots: `DEFAULT_CONCEPT` could be retuned to another construction next month and
// `docs/brand/APPROVAL.md` would keep claiming the old one was approved, with no test to notice.
//
// So this file reads the real document off disk and compares it to the real export -- the same
// discipline `tests/unit/docs/install-docs-accuracy.test.ts` applies to `docs/install.md` against
// `install.sh`: nothing here is asserted by hand, everything is parsed from the artifacts the
// project actually ships.
//
// It also guards the two things that make the record USABLE: the approved concept's captures are
// committed next to it (the review tree itself is gitignored and regenerated, so an uncommitted
// approval would point at files a fresh clone does not have), and nothing under `docs/brand/`
// carries an AI attribution string -- CLAUDE.md sec 7 forbids those in this repository, and a brand
// kit is the one folder whose contents get copied outward into a public site.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONCEPT_IDS, CONCEPT_META, DEFAULT_CONCEPT } from '../../../packages/ui/src/brand/geometry.js';
import { REVIEW_SURFACES, THEMES } from '../../../scripts/brand/review-paths.js';

const APPROVAL_PATH = 'docs/brand/APPROVAL.md';
const APPROVED_DIR = 'docs/brand/approved';
const BRAND_DIR = 'docs/brand';

const approval = (): string => readFileSync(APPROVAL_PATH, 'utf8');

/** The value cell of a two-column row `| <label> | <value> |`, trimmed. */
function row(label: string): string {
  const match = approval().match(new RegExp(String.raw`^\|\s*${label}\s*\|\s*(.+?)\s*\|\s*$`, 'm'));
  expect(match, `no \`| ${label} |\` row in ${APPROVAL_PATH}`).toBeTruthy();
  return match?.[1] ?? '';
}

/** Every file under `docs/brand/`, recursively -- including the gitignored review captures when
 *  they happen to be on this machine, since a leaked string there would be one `git add -f` away
 *  from history. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe('docs/brand/APPROVAL.md', () => {
  it('records the approval act as a table with a Date, Concept, rounds, Approver and Evidence row', () => {
    expect(approval()).toContain('# Brand approval record');
    for (const label of ['Date', 'Concept', 'Adjustment rounds used', 'Approver', 'Evidence']) {
      expect(row(label).length).toBeGreaterThan(0);
    }
  });

  it('dates the approval in ISO form', () => {
    expect(row('Date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('names one of the three concepts by id and by its own CONCEPT_META name', () => {
    const cell = row('Concept');
    const match = cell.match(/^([abc]) — (.+)$/);
    expect(match, `Concept cell "${cell}" is not "<id> — <name>"`).toBeTruthy();
    const id = match?.[1] ?? '';
    expect(CONCEPT_IDS).toContain(id);
    expect(match?.[2]).toBe(CONCEPT_META[id as (typeof CONCEPT_IDS)[number]].name);
  });

  it('reports the adjustment rounds used against D-16’s hard ceiling of two', () => {
    expect(row('Adjustment rounds used')).toMatch(/^[0-2] of 2$/);
  });

  it('points its Evidence row at the committed captures', () => {
    expect(row('Evidence')).toContain('docs/brand/approved/');
  });

  it('logs one line per adjustment round, including the rounds that were not used', () => {
    const text = approval();
    expect(text).toContain('## Adjustment log');
    const log = text.slice(text.indexOf('## Adjustment log'));
    expect(log).toMatch(/Round 1:/);
    expect(log).toMatch(/Round 2:/);
  });
});

describe('the recorded concept and the code default', () => {
  it('DEFAULT_CONCEPT is exactly the concept the record says was approved', () => {
    const id = row('Concept').match(/^([abc]) /)?.[1];
    expect(DEFAULT_CONCEPT).toBe(id);
  });

  it('geometry.ts points at the record instead of calling the default a placeholder', () => {
    const source = readFileSync('packages/ui/src/brand/geometry.ts', 'utf8');
    expect(source).toMatch(/^export const DEFAULT_CONCEPT: ConceptId = '[abc]';$/m);
    expect(source).toContain(APPROVAL_PATH);
  });
});

describe('docs/brand/approved/', () => {
  it('holds the approved concept’s board and four in-app surfaces in both themes, and nothing else', () => {
    const expected = [
      ...['board', ...REVIEW_SURFACES].flatMap((surface) => THEMES.map((theme) => `${surface}-${theme}.png`)),
      'README.md',
    ];
    expect(readdirSync(APPROVED_DIR).sort()).toEqual(expected.sort());
  });

  it('holds ten PNGs, each a real capture rather than an empty placeholder', () => {
    const pngs = readdirSync(APPROVED_DIR).filter((name) => name.endsWith('.png'));
    expect(pngs).toHaveLength(10);
    for (const name of pngs) {
      expect(statSync(path.join(APPROVED_DIR, name)).size, `${name} is too small to be a capture`).toBeGreaterThan(1024);
    }
  });

  it('says how to regenerate itself', () => {
    expect(readFileSync(path.join(APPROVED_DIR, 'README.md'), 'utf8')).toContain('pnpm brand:boards');
  });
});

describe('the brand kit carries no AI attribution (CLAUDE.md §7)', () => {
  it('no file under docs/brand/ mentions an assistant vendor or an attribution trailer', () => {
    const forbidden = ['claude', 'anthropic', 'co-authored-by'];
    const offenders = filesUnder(BRAND_DIR).filter((file) => {
      const text = readFileSync(file, 'latin1').toLowerCase();
      return forbidden.some((needle) => text.includes(needle));
    });
    expect(offenders).toEqual([]);
  });
});
