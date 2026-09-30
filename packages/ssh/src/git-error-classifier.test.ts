// Tests for classifyGitError (DEP-08, QA-10) over the real 11-06 captures in
// fixtures/deploy-errors/ubuntu-*/git-*.txt. Every capture exits 128, so the table keys on text.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_ERROR_CODES, type DeploymentErrorCode } from '@noodara/domain/deployment';
import { createRedactor } from '@noodara/domain/security';
import { describe, expect, it } from 'vitest';
import {
  GIT_ERROR_CLASSIFICATION_RULES,
  classifyGitError,
  type GitFailureInput,
  type RemoteFailure,
} from './git-error-classifier.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deploy-errors');
const UBUNTU_VERSIONS = ['ubuntu-22.04', 'ubuntu-24.04'] as const;

function loadCapture(version: string, file: string): RemoteFailure {
  const raw = readFileSync(join(FIXTURE_ROOT, version, file), 'utf8');
  const newline = raw.indexOf('\n');
  const header = raw.slice(0, newline);
  const match = /^# exit=(\d+)$/.exec(header);
  if (match?.[1] === undefined) throw new Error(`capture ${file} has no exit header`);
  return {
    exitCode: Number(match[1]),
    stderr: raw.slice(newline + 1),
    stdoutTail: '',
  };
}

function cloneFailure(failure: RemoteFailure): GitFailureInput {
  return { kind: 'command', operation: 'clone', failure };
}

function rawLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 12);
}

const CAPTURE_CASES: readonly {
  file: string;
  code: DeploymentErrorCode;
  rule: string;
}[] = [
  {
    file: 'git-auth-failed.txt',
    code: 'REPOSITORY_AUTH_FAILED',
    rule: 'repository-auth-failed',
  },
  {
    file: 'git-repository-not-found.txt',
    code: 'REPOSITORY_NOT_FOUND',
    rule: 'repository-not-found',
  },
  {
    file: 'git-branch-not-found.txt',
    code: 'BRANCH_NOT_FOUND',
    rule: 'branch-not-found',
  },
  {
    file: 'git-host-unreachable.txt',
    code: 'REPOSITORY_HOST_UNREACHABLE',
    rule: 'repository-host-unreachable',
  },
];

describe('classifyGitError over real captures', () => {
  for (const version of UBUNTU_VERSIONS) {
    for (const testCase of CAPTURE_CASES) {
      it(`${version}/${testCase.file} -> ${testCase.code}`, () => {
        const failure = loadCapture(version, testCase.file);

        const result = classifyGitError(cloneFailure(failure), {
          redactor: createRedactor(),
        });

        expect(failure.exitCode).toBe(128);
        expect(result.code).toBe(testCase.code);
        expect(result.message.length).toBeGreaterThan(0);
        for (const line of rawLines(failure.stderr)) {
          expect(result.message).not.toContain(line);
        }
        expect(result.message).not.toContain('noodara-test.internal');
      });
    }
  }

  it('names the matching rule for every capture', () => {
    for (const testCase of CAPTURE_CASES) {
      const failure = loadCapture('ubuntu-24.04', testCase.file);
      const rule = GIT_ERROR_CLASSIFICATION_RULES.find((candidate) =>
        candidate.matches(cloneFailure(failure)),
      );
      expect(rule?.name).toBe(testCase.rule);
    }
  });

  it('tells the operator to add the deploy key on an auth failure', () => {
    const failure = loadCapture('ubuntu-22.04', 'git-auth-failed.txt');

    const result = classifyGitError(cloneFailure(failure), {
      redactor: createRedactor(),
    });

    expect(result.message).toMatch(/deploy key/i);
  });

  it('accepts the GitHub-style (publickey) method list', () => {
    const failure: RemoteFailure = {
      exitCode: 128,
      stderr:
        'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n',
      stdoutTail: '',
    };

    expect(classifyGitError(cloneFailure(failure), { redactor: createRedactor() }).code).toBe(
      'REPOSITORY_AUTH_FAILED',
    );
  });
});

describe('classifyGitError text rules', () => {
  it('classifies No space left on device as DISK_FULL', () => {
    const failure: RemoteFailure = {
      exitCode: 128,
      stderr: "Cloning into 'repo'...\nfatal: write error: No space left on device\n",
      stdoutTail: '',
    };

    const result = classifyGitError(cloneFailure(failure), {
      redactor: createRedactor(),
    });

    expect(result.code).toBe('DISK_FULL');
    expect(result.message).toMatch(/disk/i);
  });

  it('falls back to CLONE_FAILED via unclassified-fallback on unknown stderr', () => {
    const failure: RemoteFailure = {
      exitCode: 128,
      stderr: 'fatal: something new happened',
      stdoutTail: '',
    };

    const result = classifyGitError(cloneFailure(failure), {
      redactor: createRedactor(),
    });

    expect(result.code).toBe('CLONE_FAILED');
    expect(result.message).not.toContain('something new happened');
  });

  it('does not classify by exit code alone', () => {
    const failure: RemoteFailure = {
      exitCode: 128,
      stderr: '',
      stdoutTail: '',
    };

    expect(classifyGitError(cloneFailure(failure), { redactor: createRedactor() }).code).toBe(
      'CLONE_FAILED',
    );
  });
});

describe('classifyGitError feature probe rule (D-09)', () => {
  it('classifies an lfs probe as UNSUPPORTED_REPOSITORY_FEATURE', () => {
    const input: GitFailureInput = {
      kind: 'feature_probe',
      result: { kind: 'unsupported', features: ['lfs'] },
    };

    const result = classifyGitError(input, { redactor: createRedactor() });

    expect(result).toEqual({
      code: 'UNSUPPORTED_REPOSITORY_FEATURE',
      message: 'This repository uses Git LFS, which is not supported in v0.2.',
    });
  });

  it('names both features', () => {
    const input: GitFailureInput = {
      kind: 'feature_probe',
      result: { kind: 'unsupported', features: ['lfs', 'submodules'] },
    };

    const result = classifyGitError(input, { redactor: createRedactor() });

    expect(result.code).toBe('UNSUPPORTED_REPOSITORY_FEATURE');
    expect(result.message).toContain('Git LFS');
    expect(result.message).toContain('Git submodules');
  });

  it('is a named rule placed first in the table', () => {
    expect(GIT_ERROR_CLASSIFICATION_RULES[0]?.name).toBe('unsupported-repository-feature');
    expect(GIT_ERROR_CLASSIFICATION_RULES[0]?.code).toBe('UNSUPPORTED_REPOSITORY_FEATURE');
  });

  it.each([
    { kind: 'supported' as const },
    {
      kind: 'unparseable' as const,
      reason: 'Probe output contained an unexpected line',
    },
    { kind: 'unsupported' as const, features: [] },
  ])('never classifies a %o probe as unsupported', (result) => {
    const outcome = classifyGitError(
      { kind: 'feature_probe', result },
      { redactor: createRedactor() },
    );

    expect(outcome.code).toBe('CLONE_FAILED');
    expect(outcome.message).not.toContain('Probe output');
  });
});

describe('classifyGitError safety', () => {
  it('never echoes a registered secret present in stderr', () => {
    const redactor = createRedactor();
    const secret = 'hunter2-super-secret-token';
    redactor.register(secret, 'token');
    for (const stderr of [
      `fatal: ${secret}`,
      `git@host: Permission denied (publickey). ${secret}`,
      `ssh: Could not resolve hostname ${secret}: Name or service not known`,
    ]) {
      const result = classifyGitError(cloneFailure({ exitCode: 128, stderr, stdoutTail: secret }), {
        redactor,
      });
      expect(result.message).not.toContain(secret);
    }
  });

  it('routes every message through the redactor', () => {
    const calls: unknown[] = [];
    const redactor = createRedactor();
    const spy = {
      ...redactor,
      redact: <T>(input: T): T => (calls.push(input), redactor.redact(input)),
    };

    classifyGitError(cloneFailure({ exitCode: 1, stderr: 'x', stdoutTail: '' }), { redactor: spy });

    expect(calls).toHaveLength(1);
  });

  it('returns a code when every getter throws', () => {
    const hostile = {
      get kind(): never {
        throw new Error('boom');
      },
    } as unknown as GitFailureInput;
    const hostileFailure = {
      kind: 'command',
      operation: 'clone',
      get failure(): never {
        throw new Error('boom');
      },
    } as unknown as GitFailureInput;
    const hostileStderr = cloneFailure({
      exitCode: 1,
      get stderr(): never {
        throw new Error('boom');
      },
      stdoutTail: '',
    } as unknown as RemoteFailure);

    for (const input of [hostile, hostileFailure, hostileStderr, null, undefined, 42, 'x']) {
      const result = classifyGitError(input as GitFailureInput, {
        redactor: createRedactor(),
      });
      expect(DEPLOYMENT_ERROR_CODES).toContain(result.code);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('returns a code for empty, binary and huge stderr', () => {
    const inputs = [
      '',
      '\u0000\u0001�\uD800 binary \u0007',
      'x'.repeat(8 * 1024 * 1024),
      'fatal: '.repeat(500_000) + 'Permission denied (publickey)',
    ];
    for (const stderr of inputs) {
      const result = classifyGitError(cloneFailure({ exitCode: 128, stderr, stdoutTail: '' }), {
        redactor: createRedactor(),
      });
      expect(DEPLOYMENT_ERROR_CODES).toContain(result.code);
    }
  });

  it('returns a code even when the redactor throws', () => {
    const redactor = {
      ...createRedactor(),
      redact: (): never => {
        throw new Error('redactor broke');
      },
    };

    const result = classifyGitError(cloneFailure({ exitCode: 1, stderr: 'x', stdoutTail: '' }), {
      redactor,
    });

    expect(result.code).toBe('CLONE_FAILED');
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('GIT_ERROR_CLASSIFICATION_RULES', () => {
  it('is frozen with unique names', () => {
    const names = GIT_ERROR_CLASSIFICATION_RULES.map((rule) => rule.name);

    expect(Object.isFrozen(GIT_ERROR_CLASSIFICATION_RULES)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('ends with the named terminal rule that matches everything', () => {
    const last = GIT_ERROR_CLASSIFICATION_RULES[GIT_ERROR_CLASSIFICATION_RULES.length - 1];

    expect(last?.name).toBe('unclassified-fallback');
    expect(last?.code).toBe('CLONE_FAILED');
    expect(last?.matches(null as unknown as GitFailureInput)).toBe(true);
  });

  it('only uses codes from the closed vocabulary and produces English messages with a next step', () => {
    for (const rule of GIT_ERROR_CLASSIFICATION_RULES) {
      expect(DEPLOYMENT_ERROR_CODES).toContain(rule.code);
    }
    for (const version of UBUNTU_VERSIONS) {
      for (const testCase of CAPTURE_CASES) {
        const result = classifyGitError(cloneFailure(loadCapture(version, testCase.file)), {
          redactor: createRedactor(),
        });
        expect(result.message).toMatch(/\.$/);
        expect(result.message.split('. ').length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
