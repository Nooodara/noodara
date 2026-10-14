import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkGateDoc } from '../../../scripts/check-gate-doc.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function doc(...lines: string[]): string {
  return ['# Noodara v0.9 — Release Gate', '', 'Veredicto: NOT READY', '', ...lines, ''].join('\n');
}

const TABLE_HEAD = ['| # | Criterio | Estado | Evidencia |', '|---|---|---|---|'];

describe('checkGateDoc (14-15 H1)', () => {
  it('accepts READY/PASS rows that cite a log file or a run id', () => {
    const markdown = doc(
      ...TABLE_HEAD,
      '| 1 | Deploy | READY | `08-test-integration.log` |',
      '| 2 | CI verde | READY | ci.yml run 38606580357 |',
      '| 3 | UAT | PASS | `docs/releases/v0.9-uat-logs/01-install.md` |',
      '| 4 | Nightly | READY | https://github.com/o/r/actions/runs/38577823485 |',
      '',
      '```',
      'Unit tests            PASS   (`04-test.log`)',
      'AI evaluations        N/A until v0.5',
      '```',
    );

    expect(checkGateDoc(markdown)).toEqual([]);
  });

  it('rejects a READY row without a referenced log or run id', () => {
    const markdown = doc(...TABLE_HEAD, '| 1 | Deploy | READY | `tests/integration/deploy.test.ts` |');

    const problems = checkGateDoc(markdown);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ line: 7 });
    expect(problems[0]?.message).toContain('without a referenced log or run id');
  });

  it('rejects a PASS dashboard line without evidence', () => {
    const markdown = doc('```', 'E2E                   PASS   todo verde', '```');

    expect(checkGateDoc(markdown)).toMatchObject([{ line: 6 }]);
  });

  it('does not treat NOT READY, UNVERIFIED or headers as passing', () => {
    const markdown = doc(
      ...TABLE_HEAD,
      '| 1 | VPS real | NOT READY | — |',
      '| 2 | arm64 | UNVERIFIED | deuda OPS-05 |',
      '| 3 | ufw | NOT READY (OPS-05) | — |',
    );

    expect(checkGateDoc(markdown)).toEqual([]);
  });

  it('rejects a READY verdict while any row is UNVERIFIED or NOT READY', () => {
    const markdown = [
      '# Gate',
      'Veredicto: READY',
      ...TABLE_HEAD,
      '| 1 | Deploy | READY | run 38606580357 |',
      '| 2 | arm64 | UNVERIFIED | OPS-05 |',
    ].join('\n');

    const problems = checkGateDoc(markdown);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ line: 2 });
    expect(problems[0]?.message).toContain('UNVERIFIED');
  });

  it('accepts a READY verdict when every row passes with evidence', () => {
    const markdown = ['# Gate', 'Veredicto: **READY**', ...TABLE_HEAD, '| 1 | Deploy | READY | run 38606580357 |'].join('\n');

    expect(checkGateDoc(markdown)).toEqual([]);
  });

  it('passes on the committed v0.2 gate document', () => {
    const markdown = readFileSync(path.join(ROOT, 'docs/releases/v0.2-gate.md'), 'utf8');

    expect(checkGateDoc(markdown)).toEqual([]);
  });
});
