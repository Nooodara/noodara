// Tests for classifyDockerError (QA-10, D-03) over the real 11-08 captures in
// fixtures/deploy-errors/ubuntu-*/docker-*.txt (see DOCKER.md for the marker regexes).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_ERROR_CODES, type DeploymentErrorCode } from '@noodara/domain/deployment';
import { createRedactor } from '@noodara/domain/security';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_ERROR_CLASSIFICATION_RULES,
  classifyDockerError,
  type DockerFailureInput,
} from './docker-error-classifier.js';
import type { RemoteFailure } from './git-error-classifier.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deploy-errors');
const UBUNTU_VERSIONS = ['ubuntu-22.04', 'ubuntu-24.04'] as const;

function loadCapture(version: string, file: string): RemoteFailure {
  const raw = readFileSync(join(FIXTURE_ROOT, version, file), 'utf8');
  const newline = raw.indexOf('\n');
  const match = /^# exit=(\d+)$/.exec(raw.slice(0, newline));
  if (match?.[1] === undefined) throw new Error(`capture ${file} has no exit header`);
  return { exitCode: Number(match[1]), stderr: raw.slice(newline + 1), stdoutTail: '' };
}

function rawLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 12);
}

function failure(stderr: string, exitCode: number | null = 1): RemoteFailure {
  return { exitCode, stderr, stdoutTail: '' };
}

const CAPTURE_CASES: readonly {
  file: string;
  operation: DockerFailureInput['operation'];
  exitCode: number;
  code: DeploymentErrorCode;
  rule: string;
}[] = [
  {
    file: 'docker-build-failed.txt',
    operation: 'build',
    exitCode: 1,
    code: 'BUILD_FAILED',
    rule: 'build-step-failed',
  },
  {
    file: 'docker-dockerfile-not-found.txt',
    operation: 'build',
    exitCode: 1,
    code: 'DOCKERFILE_NOT_FOUND',
    rule: 'dockerfile-not-found',
  },
  {
    file: 'docker-registry-unauthorized.txt',
    operation: 'pull',
    exitCode: 1,
    code: 'REGISTRY_AUTH_FAILED',
    rule: 'registry-auth-failed',
  },
  {
    file: 'docker-login-failed.txt',
    operation: 'login',
    exitCode: 1,
    code: 'REGISTRY_AUTH_FAILED',
    rule: 'registry-auth-failed',
  },
  {
    file: 'docker-image-not-found.txt',
    operation: 'pull',
    exitCode: 1,
    code: 'IMAGE_NOT_FOUND',
    rule: 'image-not-found',
  },
  {
    file: 'docker-port-in-use.txt',
    operation: 'start',
    exitCode: 125,
    code: 'PORT_IN_USE',
    rule: 'port-in-use',
  },
];

describe('classifyDockerError over real captures', () => {
  for (const version of UBUNTU_VERSIONS) {
    for (const testCase of CAPTURE_CASES) {
      it(`${version}/${testCase.file} -> ${testCase.code}`, () => {
        const captured = loadCapture(version, testCase.file);

        const result = classifyDockerError(
          { operation: testCase.operation, failure: captured },
          { redactor: createRedactor() },
        );

        expect(captured.exitCode).toBe(testCase.exitCode);
        expect(result.code).toBe(testCase.code);
        expect(result.message).toMatch(/\.$/);
        for (const line of rawLines(captured.stderr)) {
          expect(result.message).not.toContain(line);
        }
        expect(result.message).not.toContain('noodara-test.internal');
        expect(result.message).not.toContain('NOODARA_FIXTURE_BUILD_FAILURE');
      });
    }
  }

  it('names the matching rule for every capture', () => {
    for (const testCase of CAPTURE_CASES) {
      const input: DockerFailureInput = {
        operation: testCase.operation,
        failure: loadCapture('ubuntu-22.04', testCase.file),
      };
      const rule = DOCKER_ERROR_CLASSIFICATION_RULES.find((candidate) => candidate.matches(input));
      expect(rule?.name).toBe(testCase.rule);
    }
  });

  it('reports the failing build step and exit code as parsed numbers only', () => {
    const result = classifyDockerError(
      { operation: 'build', failure: loadCapture('ubuntu-24.04', 'docker-build-failed.txt') },
      { redactor: createRedactor() },
    );

    expect(result.message).toContain('step 2 of 2');
    expect(result.message).toContain('exit code 42');
    expect(result.message).not.toContain('RUN');
    expect(result.message).not.toContain('echo');
  });

  it('reports the allocated host port as a parsed number', () => {
    const result = classifyDockerError(
      { operation: 'start', failure: loadCapture('ubuntu-22.04', 'docker-port-in-use.txt') },
      { redactor: createRedactor() },
    );

    expect(result.message).toContain('13100');
  });
});

describe('classifyDockerError text rules', () => {
  it.each([
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
  ])('classifies %s as DOCKER_UNAVAILABLE', (stderr) => {
    const result = classifyDockerError(
      { operation: 'build', failure: failure(stderr) },
      { redactor: createRedactor() },
    );

    expect(result.code).toBe('DOCKER_UNAVAILABLE');
  });

  it.each([
    "docker: 'buildx' is not a docker command.\nSee 'docker --help'",
    'ERROR: BuildKit is enabled but the buildx component is missing or broken.\n       Install the buildx component to build images with BuildKit:',
    // Real stderr from packages/domain/src/discovery/fixtures/ubuntu-*/docker_buildkit.plugin_missing.meta.json
    'DEPRECATED: The legacy builder is deprecated and will be removed in a future release.\n            Install the buildx component to build images with BuildKit:\n            https://docs.docker.com/go/buildx/\n\n',
  ])(
    'classifies a missing BuildKit as BUILDKIT_UNAVAILABLE naming docker-buildx-plugin',
    (stderr) => {
      const result = classifyDockerError(
        { operation: 'build', failure: failure(stderr) },
        { redactor: createRedactor() },
      );

      expect(result.code).toBe('BUILDKIT_UNAVAILABLE');
      expect(result.message).toContain('docker-buildx-plugin');
    },
  );

  it('classifies No space left on device as DISK_FULL', () => {
    const result = classifyDockerError(
      {
        operation: 'pull',
        failure: failure('write /var/lib/docker/tmp/x: no space left on device'),
      },
      { redactor: createRedactor() },
    );

    expect(result.code).toBe('DISK_FULL');
  });

  it('does not treat a build log line containing "not found" as IMAGE_NOT_FOUND', () => {
    const stderr =
      '#5 0.1 /bin/sh: foo: not found\n#5 ERROR: process "/bin/sh -c foo" did not complete successfully: exit code: 127\n';

    const result = classifyDockerError(
      { operation: 'build', failure: failure(stderr) },
      { redactor: createRedactor() },
    );

    expect(result.code).toBe('BUILD_FAILED');
    expect(result.message).toContain('exit code 127');
  });

  it.each([
    ['build', 'BUILD_FAILED', 'build-unclassified'],
    ['pull', 'IMAGE_PULL_FAILED', 'image-unclassified'],
    ['login', 'IMAGE_PULL_FAILED', 'image-unclassified'],
    ['create', 'START_FAILED', 'unclassified-fallback'],
    ['start', 'START_FAILED', 'unclassified-fallback'],
    ['stop', 'START_FAILED', 'unclassified-fallback'],
    ['remove', 'START_FAILED', 'unclassified-fallback'],
    ['inspect', 'START_FAILED', 'unclassified-fallback'],
    ['network', 'START_FAILED', 'unclassified-fallback'],
  ] as const)('falls back per operation: %s -> %s via %s', (operation, code, ruleName) => {
    const input: DockerFailureInput = { operation, failure: failure('something unexpected', 1) };

    const result = classifyDockerError(input, { redactor: createRedactor() });
    const rule = DOCKER_ERROR_CLASSIFICATION_RULES.find((candidate) => candidate.matches(input));

    expect(result.code).toBe(code);
    expect(rule?.name).toBe(ruleName);
    expect(result.message).not.toContain('something unexpected');
  });
});

describe('classifyDockerError safety', () => {
  it('never echoes a registered registry password present in stderr', () => {
    const redactor = createRedactor();
    const password = 'r3gistry-Pa55word-xyz';
    redactor.register(password, 'password');
    for (const stderr of [
      `Error response from daemon: login attempt to http://r/v2/ failed with status: 401 Unauthorized ${password}`,
      `unexpected ${password}`,
      `#5 ERROR: process "/bin/sh -c echo ${password}" did not complete successfully: exit code: 3`,
    ]) {
      for (const operation of ['login', 'build', 'start'] as const) {
        const result = classifyDockerError(
          { operation, failure: { exitCode: 1, stderr, stdoutTail: password } },
          { redactor },
        );
        expect(result.message).not.toContain(password);
      }
    }
  });

  it('routes every message through the redactor', () => {
    const calls: unknown[] = [];
    const redactor = createRedactor();
    const spy = {
      ...redactor,
      redact: <T>(input: T): T => (calls.push(input), redactor.redact(input)),
    };

    classifyDockerError({ operation: 'build', failure: failure('x') }, { redactor: spy });

    expect(calls).toHaveLength(1);
  });

  it('returns a code when getters throw or the input is not an object', () => {
    const hostileOperation = {
      get operation(): never {
        throw new Error('boom');
      },
      failure: failure('x'),
    } as unknown as DockerFailureInput;
    const hostileFailure = {
      operation: 'build',
      get failure(): never {
        throw new Error('boom');
      },
    } as unknown as DockerFailureInput;
    const hostileStderr: DockerFailureInput = {
      operation: 'pull',
      failure: {
        exitCode: 1,
        get stderr(): never {
          throw new Error('boom');
        },
        stdoutTail: '',
      },
    };

    for (const input of [
      hostileOperation,
      hostileFailure,
      hostileStderr,
      null,
      undefined,
      7,
      'x',
    ]) {
      const result = classifyDockerError(input as DockerFailureInput, {
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
      'exit code: '.repeat(500_000),
      ' > ['.repeat(500_000) + 'did not complete successfully: exit code: 99999',
    ];
    for (const stderr of inputs) {
      const result = classifyDockerError(
        { operation: 'build', failure: failure(stderr) },
        { redactor: createRedactor() },
      );
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

    const result = classifyDockerError({ operation: 'start', failure: failure('x') }, { redactor });

    expect(result.code).toBe('START_FAILED');
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('DOCKER_ERROR_CLASSIFICATION_RULES', () => {
  it('is frozen with unique names and closed-vocabulary codes', () => {
    const names = DOCKER_ERROR_CLASSIFICATION_RULES.map((rule) => rule.name);

    expect(Object.isFrozen(DOCKER_ERROR_CLASSIFICATION_RULES)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    for (const rule of DOCKER_ERROR_CLASSIFICATION_RULES) {
      expect(DEPLOYMENT_ERROR_CODES).toContain(rule.code);
    }
  });

  it('follows the documented order', () => {
    expect(DOCKER_ERROR_CLASSIFICATION_RULES.map((rule) => rule.name)).toEqual([
      'docker-unavailable',
      'buildkit-unavailable',
      'disk-full',
      'registry-auth-failed',
      'image-not-found',
      'dockerfile-not-found',
      'port-in-use',
      'build-step-failed',
      'build-unclassified',
      'image-unclassified',
      'unclassified-fallback',
    ]);
  });

  it('ends with the named terminal rule that matches everything', () => {
    const last = DOCKER_ERROR_CLASSIFICATION_RULES[DOCKER_ERROR_CLASSIFICATION_RULES.length - 1];

    expect(last?.name).toBe('unclassified-fallback');
    expect(last?.code).toBe('START_FAILED');
    expect(last?.matches(null as unknown as DockerFailureInput)).toBe(true);
  });
});
