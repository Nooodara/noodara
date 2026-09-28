// 08-01-PLAN.md Task 3 (D-13, D-15): the UI redesign's approval act, kept honest by the code.
//
// D-15 mirrors D-17's brand-kit discipline exactly, but for three human gates instead of one
// concept: G1 (baseline), G2 (direction) and G3 (final) each get their own record -- a record that
// nothing reads is a record that silently rots. This file reads the real document off disk and
// compares it to the real approved-capture set, the same discipline
// `tests/unit/brand/approval-record.test.ts` applies to `docs/brand/APPROVAL.md`.
//
// It also guards the two things that make the record USABLE and SAFE: the approved set can never
// silently drift (an extra or renamed file under `docs/ui/approved/` fails, T-08-06), and nothing
// under `docs/ui/` ever carries an AI-attribution string (CLAUDE.md §7) or a fixture admin
// credential (T-08-02) -- a screenshot of a real, authenticated run is exactly the kind of
// artifact that could otherwise leak one.
//
// Until a gate is actually approved, its block legitimately carries `pending` in the Date/
// Approver/Rounds-used cells -- this test asserts the rows EXIST and are WELL-FORMED, never that
// they are filled, so it is green from this plan onward and stays green as 08-02/08-11/08-19 (the
// gate plans) fill each block in.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from '../../e2e/fixtures/stack.js';
import { approvedPngPath, SCREENS, THEMES } from '../../../scripts/ui/review-paths.js';

const APPROVAL_PATH = 'docs/ui/APPROVAL.md';
const APPROVED_DIR = 'docs/ui/approved';
const UI_DIR = 'docs/ui';

const GATES = ['G1', 'G2', 'G3'] as const;
type Gate = (typeof GATES)[number];

const approval = (): string => readFileSync(APPROVAL_PATH, 'utf8');

/** The full text of one gate's own `## G<n> — ...` section, up to (excluding) the next top-level
 *  gate heading or end of file -- so each gate's rows are parsed against only its own block, never
 *  against whichever gate happens to appear first in the file. */
function gateSection(gate: Gate): string {
  const text = approval();
  const start = text.search(new RegExp(String.raw`^## ${gate} `, 'm'));
  expect(start, `no "## ${gate} " heading in ${APPROVAL_PATH}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const nextIndex = rest.search(/^## G[123] /m);
  const end = nextIndex === -1 ? text.length : start + 1 + nextIndex;
  return text.slice(start, end);
}

/** The value cell of a two-column row `| <label> | <value> |`, trimmed, scoped to a single gate's
 *  own section text (see `gateSection` above) -- never a whole-file search, since every gate
 *  repeats the same row labels. */
function row(section: string, label: string): string {
  const match = section.match(new RegExp(String.raw`^\|\s*${label}\s*\|\s*(.+?)\s*\|\s*$`, 'm'));
  expect(match, `no \`| ${label} |\` row in this gate's section of ${APPROVAL_PATH}`).toBeTruthy();
  return match?.[1] ?? '';
}

/** Every file under `dir`, recursively -- including gitignored review captures when they happen to
 *  be on this machine, since a leaked string there would be one `git add -f` away from history. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe('docs/ui/APPROVAL.md', () => {
  it('has exactly one "| Gate |" row per redesign gate (later phases may append their own)', () => {
    // Phase 9+ append further approval blocks to the same record (D-15 keeps one document), so the
    // count is no longer fixed at three; each of G1/G2/G3 must still appear exactly once.
    const cells = (approval().match(/^\| Gate \|\s*(.+?)\s*\|\s*$/gm) ?? []).map((line) =>
      line.replace(/^\| Gate \|\s*/, '').replace(/\s*\|\s*$/, ''),
    );
    expect(cells.length).toBeGreaterThanOrEqual(GATES.length);
    for (const gate of GATES) {
      expect(cells.filter((cell) => cell.startsWith(`${gate} `)), `${gate} Gate rows`).toHaveLength(1);
    }
  });

  for (const gate of GATES) {
    describe(gate, () => {
      it('has a well-formed Field/Value table with all five required rows', () => {
        const section = gateSection(gate);
        for (const label of ['Gate', 'Date', 'Rounds used', 'Approver', 'Evidence']) {
          expect(row(section, label).length, `"${label}" row is empty in ${gate}'s section`).toBeGreaterThan(0);
        }
      });

      it('names its own gate id in the Gate row', () => {
        expect(row(gateSection(gate), 'Gate')).toMatch(new RegExp(`^${gate} — .+`));
      });

      it('points its Evidence row at the committed approved captures', () => {
        expect(row(gateSection(gate), 'Evidence')).toContain('docs/ui/approved/');
      });

      it('has its own Adjustment log naming both rounds, including an unused one', () => {
        const section = gateSection(gate);
        expect(section).toMatch(/Adjustment log/);
        const log = section.slice(section.search(/Adjustment log/));
        expect(log).toMatch(/Round 1:/);
        expect(log).toMatch(/Round 2:/);
      });
    });
  }
});

describe('docs/ui/approved/', () => {
  it('holds only files from the pinned SCREENS × THEMES set, plus README.md -- never a stray or renamed file', () => {
    const validNames = new Set<string>(['README.md']);
    for (const screen of SCREENS) {
      for (const theme of THEMES) {
        validNames.add(path.basename(approvedPngPath(screen, theme)));
      }
    }
    // 6 screens × 2 themes + README.md.
    expect(validNames.size).toBe(13);

    const actual = readdirSync(APPROVED_DIR);
    for (const name of actual) {
      expect(validNames.has(name), `${name} is not part of the pinned SCREENS × THEMES set nor README.md`).toBe(true);
    }
  });

  it('says how to regenerate itself', () => {
    expect(readFileSync(path.join(APPROVED_DIR, 'README.md'), 'utf8')).toContain('pnpm ui:review');
  });
});

describe('docs/ui/ carries no AI attribution (CLAUDE.md §7)', () => {
  it('no file under docs/ui/ mentions an assistant vendor or an attribution trailer', () => {
    const forbidden = ['claude', 'anthropic', 'co-authored-by'];
    const offenders = filesUnder(UI_DIR).filter((file) => {
      const text = readFileSync(file, 'latin1').toLowerCase();
      return forbidden.some((needle) => text.includes(needle));
    });
    expect(offenders).toEqual([]);
  });
});

describe('docs/ui/ carries no fixture admin credential (T-08-02)', () => {
  it('no file under docs/ui/ contains the fixture admin email or password', () => {
    const offenders = filesUnder(UI_DIR).filter((file) => {
      const text = readFileSync(file, 'latin1');
      return text.includes(E2E_ADMIN_EMAIL) || text.includes(E2E_ADMIN_PASSWORD);
    });
    expect(offenders).toEqual([]);
  });
});
