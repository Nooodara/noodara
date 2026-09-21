// Post-execution fix (orchestrator audit WR-06, code review report
// .planning/phases/06-instalador-y-docker-compose/06-REVIEW.md): the no-Docker apt-install-path
// test in preflight-scenarios.test.ts built its two ~1.6GB production images and created its donor
// volume BEFORE the try block that owns all cleanup -- a failure in that two-line window (the
// `docker volume create` throwing, for example) left the just-built images never removed. This is
// a structural, source-level proof (mirrors tests/unit/scripts/check-workflow-pins.test.ts's own
// "structural proof against the real files" pattern) rather than a real-Docker reproduction: the
// real fix is exercised for real whenever this file's own real suite runs
// (tests/integration/installer/preflight-scenarios.test.ts, gated separately, hard_rule #6).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = 'tests/integration/installer/preflight-scenarios.test.ts';

function noDockerTestBody(): string {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const match = source.match(
    /'installs Docker Engine and the Compose plugin[\s\S]*?\n {6}\},\n {6}NO_DOCKER_TIMEOUT_MS,\n {4}\);/,
  );
  expect(match, 'no-Docker apt-install-path test body not found in preflight-scenarios.test.ts').toBeTruthy();
  return match?.[0] ?? '';
}

describe('preflight-scenarios.test.ts no-Docker apt-install-path resource cleanup (WR-06)', () => {
  it('never calls buildInstallerScenarioImages before the try block that cleans it up', () => {
    const body = noDockerTestBody();
    const tryIndex = body.indexOf('try {');
    const buildIndex = body.indexOf('buildInstallerScenarioImages(');

    expect(tryIndex, 'no try block found').toBeGreaterThan(-1);
    expect(buildIndex, 'buildInstallerScenarioImages( not found').toBeGreaterThan(-1);
    expect(buildIndex, 'buildInstallerScenarioImages must run inside the try block, not before it').toBeGreaterThan(
      tryIndex,
    );
  });

  it('never calls docker volume create before the try block that cleans it up', () => {
    const body = noDockerTestBody();
    const tryIndex = body.indexOf('try {');
    const volumeCreateIndex = body.indexOf("'volume', 'create'");

    expect(tryIndex, 'no try block found').toBeGreaterThan(-1);
    expect(volumeCreateIndex, "'volume', 'create' not found").toBeGreaterThan(-1);
    expect(volumeCreateIndex, 'docker volume create must run inside the try block, not before it').toBeGreaterThan(
      tryIndex,
    );
  });

  it('guards the finally-block image/volume cleanup so it never runs against something that was never created', () => {
    const body = noDockerTestBody();
    const finallyIndex = body.indexOf('} finally {');
    expect(finallyIndex, 'no finally block found').toBeGreaterThan(-1);
    const finallyBlock = body.slice(finallyIndex);

    // removeBuiltImages/volume rm must each be reachable only when the corresponding create
    // actually ran -- proven structurally by requiring an `if` guard immediately governing each
    // cleanup call, rather than an unconditional call sitting directly in `finally`.
    expect(finallyBlock).toMatch(/if\s*\([^)]*\)\s*\{\s*\n\s*execFileSync\('docker',\s*\['volume',\s*'rm'/);
    expect(finallyBlock).toMatch(/if\s*\([^)]*\)\s*\{\s*\n\s*removeBuiltImages\(/);
  });
});
