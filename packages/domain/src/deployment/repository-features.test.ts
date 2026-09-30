import { describe, expect, it } from 'vitest';
import * as deploymentSubpath from '@noodara/domain/deployment';
import type { CommandOutput } from '../discovery/docker-version.js';
import {
  REPOSITORY_FEATURES,
  parseRepositoryFeatureProbe,
  unsupportedRepositoryFeatureError,
} from './repository-features.js';

const ok = (stdout: string): CommandOutput => ({ stdout, stderr: '', exitCode: 0 });

describe('REPOSITORY_FEATURES', () => {
  it('is the closed feature vocabulary', () => {
    expect([...REPOSITORY_FEATURES]).toEqual(['lfs', 'submodules']);
  });
});

describe('parseRepositoryFeatureProbe', () => {
  it('reports supported when neither feature is present', () => {
    expect(parseRepositoryFeatureProbe(ok('submodules=0\nlfs=0\n'))).toEqual({ kind: 'supported' });
  });

  it('accepts either key order and a missing trailing newline', () => {
    expect(parseRepositoryFeatureProbe(ok('lfs=0\nsubmodules=0'))).toEqual({ kind: 'supported' });
  });

  it('reports submodules', () => {
    expect(parseRepositoryFeatureProbe(ok('submodules=1\nlfs=0\n'))).toEqual({
      kind: 'unsupported',
      features: ['submodules'],
    });
  });

  it('reports lfs', () => {
    expect(parseRepositoryFeatureProbe(ok('submodules=0\nlfs=1\n'))).toEqual({
      kind: 'unsupported',
      features: ['lfs'],
    });
  });

  it('reports both features sorted regardless of line order', () => {
    const expected = { kind: 'unsupported', features: ['lfs', 'submodules'] };

    expect(parseRepositoryFeatureProbe(ok('submodules=1\nlfs=1\n'))).toEqual(expected);
    expect(parseRepositoryFeatureProbe(ok('lfs=1\nsubmodules=1\n'))).toEqual(expected);
  });

  it.each([
    ['non-zero exit code', { stdout: 'submodules=0\nlfs=0\n', stderr: '', exitCode: 1 }],
    ['command not found', { stdout: '', stderr: '', exitCode: 127 }],
    ['empty stdout', ok('')],
    ['whitespace-only stdout', ok('  \n')],
    ['missing lfs key', ok('submodules=0\n')],
    ['missing submodules key', ok('lfs=0\n')],
    ['duplicated key', ok('submodules=0\nlfs=0\nlfs=0\n')],
    ['duplicated key hiding a positive', ok('lfs=1\nsubmodules=0\nlfs=0\n')],
    ['value other than 0/1', ok('submodules=2\nlfs=0\n')],
    ['empty value', ok('submodules=\nlfs=0\n')],
    ['unknown extra line', ok('submodules=0\nlfs=0\nhooks=0\n')],
    ['free-form extra line', ok('submodules=0\nlfs=0\nall good\n')],
    ['blank line in the middle', ok('submodules=0\n\nlfs=0\n')],
    ['spaces around the separator', ok('submodules = 0\nlfs=0\n')],
  ] as const)('is unparseable for %s (never supported)', (_label, output) => {
    const result = parseRepositoryFeatureProbe(output);

    expect(result.kind).toBe('unparseable');
    if (result.kind === 'unparseable') {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('does not echo raw output into the unparseable reason', () => {
    const result = parseRepositoryFeatureProbe(ok('submodules=0\nlfs=0\nsecret-token-abc123\n'));

    expect(result.kind).toBe('unparseable');
    expect(JSON.stringify(result)).not.toContain('secret-token-abc123');
  });
});

describe('unsupportedRepositoryFeatureError', () => {
  it('names Git LFS and says v0.2 does not support it', () => {
    const error = unsupportedRepositoryFeatureError(['lfs']);

    expect(error.code).toBe('UNSUPPORTED_REPOSITORY_FEATURE');
    expect(error.message).toContain('Git LFS');
    expect(error.message).toContain('v0.2');
    expect(error.message).not.toContain('submodules');
  });

  it('names submodules', () => {
    const error = unsupportedRepositoryFeatureError(['submodules']);

    expect(error.code).toBe('UNSUPPORTED_REPOSITORY_FEATURE');
    expect(error.message).toContain('submodules');
    expect(error.message).not.toContain('LFS');
  });

  it('names both features with a single code', () => {
    const error = unsupportedRepositoryFeatureError(['lfs', 'submodules']);

    expect(error.code).toBe('UNSUPPORTED_REPOSITORY_FEATURE');
    expect(error.message).toContain('Git LFS');
    expect(error.message).toContain('submodules');
  });

  it('builds the message from the closed vocabulary only', () => {
    const probe = parseRepositoryFeatureProbe(ok('submodules=1\nlfs=1\n'));
    if (probe.kind !== 'unsupported') {
      throw new Error('expected unsupported');
    }

    const error = unsupportedRepositoryFeatureError(probe.features);

    expect(error.message).not.toContain('=1');
  });
});

describe('@noodara/domain/deployment subpath', () => {
  it('re-exports the deployment module surface', () => {
    expect(deploymentSubpath.DEPLOYMENT_STATUSES).toHaveLength(7);
    expect(typeof deploymentSubpath.transitionDeployment).toBe('function');
    expect(typeof deploymentSubpath.deriveServiceStatus).toBe('function');
    expect(typeof deploymentSubpath.isDeploymentErrorCode).toBe('function');
    expect(typeof deploymentSubpath.parseRepositoryFeatureProbe).toBe('function');
  });
});
