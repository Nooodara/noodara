import { GenericContainer } from 'testcontainers';
import { describe, expect, it } from 'vitest';
import {
  buildInstallerDindImage,
  InstallerDindBuildError,
  type DindBuildDiagnosis,
  type DindImageBuilder,
  type DindImageBuildSpec,
} from './installer-dind.js';

const SPEC: DindImageBuildSpec = {
  context: '/fake/images',
  dockerfile: 'installer-dind-ubuntu-22.04/Dockerfile',
  buildArgs: { WITH_DOCKER: 'true', WITH_SNAP_DOCKER: 'true' },
  label: 'installer-dind-ubuntu-22.04',
};

/** Fake builder: the testcontainers build fails like nightly 38577823485, the diagnostic
 *  rebuild returns whatever the case needs. */
function fakeBuilder(diagnosis: DindBuildDiagnosis | Error): { builder: DindImageBuilder; diagnosed: DindImageBuildSpec[] } {
  const diagnosed: DindImageBuildSpec[] = [];
  const builder: DindImageBuilder = {
    build: () => Promise.reject(new Error('Failed to build image')),
    diagnose: (spec) => {
      diagnosed.push(spec);
      return diagnosis instanceof Error ? Promise.reject(diagnosis) : Promise.resolve(diagnosis);
    },
  };
  return { builder, diagnosed };
}

async function buildError(builder: DindImageBuilder): Promise<InstallerDindBuildError> {
  const error: unknown = await buildInstallerDindImage(SPEC, { builder, timeoutMs: 1_000, diagnoseTimeoutMs: 1_000 }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InstallerDindBuildError);
  return error as InstallerDindBuildError;
}

describe('buildInstallerDindImage (14-35, OPEN_QUESTIONS #13)', () => {
  it('returns the built image and never runs the diagnostic rebuild when the build succeeds', async () => {
    const image = new GenericContainer('noodara-test/fake:latest');
    const diagnosed: DindImageBuildSpec[] = [];
    const builder: DindImageBuilder = {
      build: () => Promise.resolve(image),
      diagnose: (spec) => {
        diagnosed.push(spec);
        return Promise.resolve({ exitCode: 0, output: '' });
      },
    };

    const result = await buildInstallerDindImage(SPEC, { builder, timeoutMs: 1_000, diagnoseTimeoutMs: 1_000 });

    expect(result).toBe(image);
    expect(diagnosed).toEqual([]);
  });

  it('surfaces the build output and calls the failure real when the diagnostic rebuild fails too', async () => {
    const { builder, diagnosed } = fakeBuilder({
      exitCode: 100,
      output: 'Step 4/9 : RUN apt-get install -y docker-ce\nE: Unable to locate package docker-ce\n',
    });

    const error = await buildError(builder);

    expect(diagnosed).toEqual([SPEC]);
    expect(error.reproduced).toBe(true);
    expect(error.message).toContain('Failed to build image');
    expect(error.message).toContain('installer-dind-ubuntu-22.04');
    expect(error.message).toContain('also failed (exit 100)');
    expect(error.message).toContain('E: Unable to locate package docker-ce');
    expect((error.cause as Error).message).toBe('Failed to build image');
  });

  it('calls the failure transient when the diagnostic rebuild succeeds', async () => {
    const { builder } = fakeBuilder({ exitCode: 0, output: 'Successfully built 0123abcd\n' });

    const error = await buildError(builder);

    expect(error.reproduced).toBe(false);
    expect(error.message).toContain('transient');
    expect(error.message).toContain('Successfully built 0123abcd');
  });

  it('reports a diagnostic rebuild that did not finish without hiding the original error', async () => {
    const timedOut = await buildError(fakeBuilder({ exitCode: null, output: 'Step 2/9 : RUN apt-get update\n', error: 'timed out after 1000ms' }).builder);
    const crashed = await buildError(fakeBuilder(new Error('spawn docker ENOENT')).builder);

    expect(timedOut.reproduced).toBeUndefined();
    expect(timedOut.message).toContain('did not finish (timed out after 1000ms)');
    expect(timedOut.message).toContain('RUN apt-get update');
    expect(crashed.reproduced).toBeUndefined();
    expect(crashed.message).toContain('spawn docker ENOENT');
    expect(crashed.message).toContain('Failed to build image');
  });

  it('keeps only the tail of a long build output', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${String(i)}`);
    const { builder } = fakeBuilder({ exitCode: 1, output: `${lines.join('\n')}\n` });

    const error = await buildError(builder);

    expect(error.message).toContain('line 499');
    expect(error.message).not.toContain('line 0\n');
    expect(error.message.split('\n').length).toBeLessThan(80);
  });

  it('bounds a hung build with the explicit timeout, then diagnoses', async () => {
    const diagnosed: DindImageBuildSpec[] = [];
    const builder: DindImageBuilder = {
      build: () => new Promise<GenericContainer>(() => undefined),
      diagnose: (spec) => {
        diagnosed.push(spec);
        return Promise.resolve({ exitCode: 1, output: 'boom\n' });
      },
    };

    const error: unknown = await buildInstallerDindImage(SPEC, { builder, timeoutMs: 20, diagnoseTimeoutMs: 1_000 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(InstallerDindBuildError);
    expect((error as Error).message).toContain('timed out after 20ms');
    expect(diagnosed).toHaveLength(1);
  });
});
