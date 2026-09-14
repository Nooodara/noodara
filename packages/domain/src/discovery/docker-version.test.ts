import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseComposeVersion, parseDockerVersion, type CommandOutput } from './docker-version.js';

function readFixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function readMeta(path: string): { command: string; exitCode: number; stderr: string } {
  return JSON.parse(readFixture(path)) as { command: string; exitCode: number; stderr: string };
}

describe.each(['ubuntu-22.04', 'ubuntu-24.04'] as const)('parseDockerVersion (%s)', (version) => {
  it('reports daemon_unreachable with the captured client version (CLI present, no daemon)', () => {
    const stdout = readFixture(`./fixtures/${version}/docker_version.txt`);
    const meta = readMeta(`./fixtures/${version}/docker_version.meta.json`);
    const input: CommandOutput = { stdout, stderr: meta.stderr, exitCode: meta.exitCode };

    const result = parseDockerVersion(input);

    expect(result.kind).toBe('daemon_unreachable');
    expect(result.kind === 'daemon_unreachable' && result.clientVersion).toBe('29.8.0');
    expect(result.kind === 'daemon_unreachable' && result.clientVersion).not.toBeNull();
  });

  it('reports not_installed for the captured plain-image output (docker CLI absent)', () => {
    const stdout = readFixture(`./fixtures/${version}/docker_version.not_installed.txt`);
    const meta = readMeta(`./fixtures/${version}/docker_version.not_installed.meta.json`);
    const input: CommandOutput = { stdout, stderr: meta.stderr, exitCode: meta.exitCode };

    const result = parseDockerVersion(input);

    expect(result).toEqual({ kind: 'not_installed' });
  });
});

describe('parseDockerVersion (D-12 / T-2-17: unparseable must never masquerade as not_installed)', () => {
  it('reports unparseable for a valid exit code with invalid JSON on stdout, never not_installed', () => {
    const result = parseDockerVersion({ stdout: 'not valid json{', stderr: '', exitCode: 1 });

    expect(result.kind).toBe('unparseable');
    expect(result.kind).not.toBe('not_installed');
  });

  // Synthetic: defends against a future refactor keying only on "empty stdout" instead of
  // requiring the exact measured 127 + empty-stdout combination for not_installed.
  it('reports unparseable (not not_installed) for an empty stdout at a non-127 exit code', () => {
    const result = parseDockerVersion({ stdout: '', stderr: 'connection reset', exitCode: 1 });

    expect(result).toEqual({ kind: 'unparseable', reason: 'Command produced no output' });
  });

  // Synthetic: valid JSON that parses to a non-object (a bare number) — JSON.parse succeeds, but
  // there is no Client/Server shape to read at all.
  it('reports unparseable when the JSON parses to a non-object value', () => {
    const result = parseDockerVersion({ stdout: '42', stderr: '', exitCode: 1 });

    expect(result.kind).toBe('unparseable');
  });

  // Synthetic: JSON is valid but does not have the shape ADR 0004 measured at all.
  it('reports unparseable when the JSON has no Client field', () => {
    const result = parseDockerVersion({ stdout: '{"Server":null}', stderr: '', exitCode: 1 });

    expect(result.kind).toBe('unparseable');
  });

  // Synthetic: Client is present but its Version field is missing/non-string.
  it('reports unparseable when Client has no string Version', () => {
    const result = parseDockerVersion({
      stdout: '{"Client":{"Platform":{"Name":"x"}},"Server":null}',
      stderr: '',
      exitCode: 1,
    });

    expect(result.kind).toBe('unparseable');
  });

  // Synthetic: Server is present but malformed (no Version) — an edge no fixture captures, since
  // ADR 0004 could not build a responding daemon inside the sshd fixture image.
  it('reports unparseable when Server is present but has no string Version', () => {
    const result = parseDockerVersion({
      stdout: '{"Client":{"Version":"29.8.0"},"Server":{"Components":[]}}',
      stderr: '',
      exitCode: 0,
    });

    expect(result.kind).toBe('unparseable');
  });

  // Derived (per ADR 0004 and fixtures/README.md: "Docker daemon present and responding" cannot
  // be captured from this fixture matrix — hand-written from Docker's own documented JSON schema,
  // never saved into fixtures/ as if it were measured reality.
  it('reports installed with both client and server versions for a derived responding-daemon shape', () => {
    const derivedRespondingDaemonJson = JSON.stringify({
      Client: { Version: '29.8.0', Arch: 'arm64' },
      Server: { Version: '29.8.0', Components: [{ Name: 'Engine', Version: '29.8.0' }] },
    });

    const result = parseDockerVersion({ stdout: derivedRespondingDaemonJson, stderr: '', exitCode: 0 });

    expect(result).toEqual({ kind: 'installed', clientVersion: '29.8.0', serverVersion: '29.8.0' });
  });
});

describe.each(['ubuntu-22.04', 'ubuntu-24.04'] as const)('parseComposeVersion (%s)', (version) => {
  it('returns the captured compose plugin version', () => {
    const stdout = readFixture(`./fixtures/${version}/docker_compose_version.txt`);
    const meta = readMeta(`./fixtures/${version}/docker_compose_version.meta.json`);
    const input: CommandOutput = { stdout, stderr: meta.stderr, exitCode: meta.exitCode };

    const result = parseComposeVersion(input);

    expect(result).toEqual({ kind: 'installed', version: '5.5.1' });
  });

  it('returns a null version, without failing, for the captured command-not-found exit code', () => {
    const stdout = readFixture(`./fixtures/${version}/docker_compose_version.not_installed.txt`);
    const meta = readMeta(`./fixtures/${version}/docker_compose_version.not_installed.meta.json`);
    const input: CommandOutput = { stdout, stderr: meta.stderr, exitCode: meta.exitCode };

    const result = parseComposeVersion(input);

    expect(result).toEqual({ kind: 'not_installed', version: null });
  });
});

describe('parseComposeVersion (malformed input)', () => {
  // Synthetic: no fixture happens to produce multi-line compose output.
  it('reports unparseable for unexpected multi-line output', () => {
    const result = parseComposeVersion({ stdout: '5.5.1\nextra line\n', stderr: '', exitCode: 0 });

    expect(result.kind).toBe('unparseable');
  });

  // Synthetic: defensive branch mirroring parseDockerVersion's own empty-stdout-but-not-127 case.
  it('reports unparseable for an empty stdout at a non-127 exit code', () => {
    const result = parseComposeVersion({ stdout: '', stderr: 'unexpected', exitCode: 1 });

    expect(result).toEqual({ kind: 'unparseable', reason: 'Command produced no output' });
  });
});
