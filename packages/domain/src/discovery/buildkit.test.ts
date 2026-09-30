import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommandOutput } from './docker-version.js';
import { parseBuildKitStatus } from './buildkit.js';

const VERSIONS = ['22.04', '24.04'] as const;

function load(version: string, name: string): CommandOutput {
  const base = `./fixtures/ubuntu-${version}/docker_buildkit${name}`;
  const stdout = readFileSync(new URL(`${base}.txt`, import.meta.url), 'utf8');
  const meta = JSON.parse(readFileSync(new URL(`${base}.meta.json`, import.meta.url), 'utf8')) as {
    stderr: string;
    exitCode: number;
  };
  return { stdout, stderr: meta.stderr, exitCode: meta.exitCode };
}

describe('parseBuildKitStatus (real G3 captures)', () => {
  it.each(VERSIONS)('active on Ubuntu %s', (version) => {
    expect(parseBuildKitStatus(load(version, ''))).toEqual({ kind: 'active', version: null });
  });

  it.each(VERSIONS)('plugin_missing on Ubuntu %s', (version) => {
    expect(parseBuildKitStatus(load(version, '.plugin_missing'))).toEqual({ kind: 'plugin_missing' });
  });

  it.each(VERSIONS)('DOCKER_BUILDKIT=0 is reported as disabled, not active, on Ubuntu %s', (version) => {
    expect(parseBuildKitStatus(load(version, '.legacy_env'))).toEqual({ kind: 'buildkit_disabled' });
  });
});

describe('parseBuildKitStatus (edge cases)', () => {
  const run = (stdout: string, exitCode = 0, stderr = ''): ReturnType<typeof parseBuildKitStatus> =>
    parseBuildKitStatus({ stdout, stderr, exitCode });

  it('exit 127 with empty stdout is unparseable, never plugin_missing', () => {
    expect(run('', 127).kind).toBe('unparseable');
  });

  it('detects an unreachable daemon', () => {
    expect(run('', 1, 'Cannot connect to the Docker daemon at unix:///x').kind).toBe('daemon_unreachable');
  });

  it.each([[''], ['garbage'], ['{"trunc'], ['Usage: docker buildx build'], ['Usage:  docker buildxx build'], ['Usage:  docker builder']])(
    'unparseable for %j',
    (stdout) => {
      expect(run(stdout).kind).toBe('unparseable');
    },
  );

  it('non-zero exit with a usage line is unparseable', () => {
    expect(run('Usage:  docker buildx build [OPTIONS]', 1).kind).toBe('unparseable');
  });

  it('accepts a bare usage line and leading blank lines are not tolerated silently', () => {
    expect(run('Usage:  docker buildx build').kind).toBe('active');
    expect(run('Usage:  docker build').kind).toBe('plugin_missing');
    expect(run('\nUsage:  docker build').kind).toBe('unparseable');
  });
});
