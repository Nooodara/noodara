import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDockerGroupMembership, parseSudoCheck } from './access.js';

function readFixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('parseSudoCheck', () => {
  it('maps exit code 0 (the captured deployer fixture) to pass', () => {
    const result = parseSudoCheck({ exitCode: 0, stderr: '' });

    expect(result).toEqual({ status: 'pass', detail: '' });
  });

  it('maps a non-zero exit code (the captured restricted-user fixture) to fail, carrying stderr as detail', () => {
    const result = parseSudoCheck({ exitCode: 1, stderr: 'sudo: a password is required\n' });

    expect(result).toEqual({ status: 'fail', detail: 'sudo: a password is required\n' });
  });

  it('maps any other non-zero exit code to fail too', () => {
    const result = parseSudoCheck({ exitCode: 127, stderr: 'sudo: command not found\n' });

    expect(result.status).toBe('fail');
  });
});

describe('parseDockerGroupMembership', () => {
  it('reports membership true against the captured deployer `id -nG` output', () => {
    const result = parseDockerGroupMembership(
      readFixture('./fixtures/ubuntu-22.04/docker_group.txt'),
    );

    expect(result).toBe(true);
  });

  it('reports membership false against the captured restricted-user `id -nG` output', () => {
    const result = parseDockerGroupMembership(
      readFixture('./fixtures/ubuntu-22.04/docker_group.restricted.txt'),
    );

    expect(result).toBe(false);
  });

  it('reports membership true against the captured 24.04 deployer `id -nG` output', () => {
    const result = parseDockerGroupMembership(
      readFixture('./fixtures/ubuntu-24.04/docker_group.txt'),
    );

    expect(result).toBe(true);
  });

  // Synthetic: no fixture happens to include a decoy group name — this proves whole-token
  // matching without which a naive `stdout.includes('docker')` substring check would misreport.
  it('does not count a "dockerx" group as membership (whole-token match only)', () => {
    const result = parseDockerGroupMembership('deployer sudo dockerx');

    expect(result).toBe(false);
  });

  // Synthetic: same trap as above, for a group name containing "docker" as a prefix of a longer
  // hyphenated token.
  it('does not count a "docker-compose" group as membership (whole-token match only)', () => {
    const result = parseDockerGroupMembership('deployer docker-compose');

    expect(result).toBe(false);
  });
});
