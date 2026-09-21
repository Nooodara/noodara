// Post-execution fix (orchestrator audit WR-07, code review report
// .planning/phases/06-instalador-y-docker-compose/06-REVIEW.md): every `docker`/`docker compose`
// spawn and every `fetch()` in the installer test suite is supposed to carry an explicit timeout
// (installer-dind.ts's own header comment states this convention directly) -- an unbounded call
// blocks the whole run forever if the Docker daemon (or a container's HTTP server) is
// unresponsive at exactly that point, instead of failing after a bounded time. This is a
// structural, source-level proof (mirrors check-workflow-pins.test.ts's own "structural proof
// against the real files" pattern) over every call site named in the review plus every additional
// one found by a directed repo-wide search (idempotent-rerun.test.ts:475 was the primary review
// finding; web-image.test.ts/control-plane-image.test.ts's own cleanup spawnSync calls were the
// review's own secondary finding; control-plane-image.test.ts's two /health fetch() calls and
// env-contract.test.ts's spawnSync were found by the search this fix round's own instructions
// asked for, not named in the review itself).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Extracts the statement starting at `needle` up to (and including) its own matching closing
 *  `);` -- a simple depth-tracking scan over parens, robust to the call spanning several lines
 *  (unlike a fixed-width regex window, which breaks the moment a call is reformatted). */
function statementAt(source: string, needle: string): string {
  const start = source.indexOf(needle);
  expect(start, `"${needle}" not found`).toBeGreaterThan(-1);
  let depth = 0;
  let i = start;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return source.slice(start, i);
}

describe('installer test suite: every docker spawn/fetch carries an explicit timeout (WR-07)', () => {
  it('idempotent-rerun.test.ts: the stray-container count check has an explicit timeout', () => {
    const source = readFileSync('tests/integration/installer/idempotent-rerun.test.ts', 'utf8');
    const call = statementAt(source, "execFileSync('docker', ['ps', '-aq', '--filter', 'label=noodara.test=true']");
    expect(call).toMatch(/timeout/);
  });

  it('web-image.test.ts: the best-effort image cleanup spawnSync has an explicit timeout', () => {
    const source = readFileSync('tests/integration/installer/web-image.test.ts', 'utf8');
    const call = statementAt(source, "spawnSync('docker', ['rmi', '-f', tag]");
    expect(call).toMatch(/timeout/);
  });

  it('control-plane-image.test.ts: the best-effort image cleanup spawnSync has an explicit timeout', () => {
    const source = readFileSync('tests/integration/installer/control-plane-image.test.ts', 'utf8');
    const call = statementAt(source, "spawnSync('docker', ['rmi', '-f', tag]");
    expect(call).toMatch(/timeout/);
  });

  it('control-plane-image.test.ts: both /health fetch() calls carry an AbortSignal timeout', () => {
    const source = readFileSync('tests/integration/installer/control-plane-image.test.ts', 'utf8');
    const matches = [...source.matchAll(/fetch\(`http:\/\/\$\{host\}:\$\{String\(port\)\}\/health`[\s\S]*?\)/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const match of matches) {
      expect(match[0]).toMatch(/AbortSignal\.timeout/);
    }
  });

  it('env-contract.test.ts: the compiled env.js spawnSync has an explicit timeout', () => {
    const source = readFileSync('tests/integration/installer/env-contract.test.ts', 'utf8');
    const call = statementAt(source, 'const result = spawnSync(');
    expect(call).toMatch(/timeout/);
  });
});
