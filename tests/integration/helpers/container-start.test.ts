import { describe, expect, it } from 'vitest';
import { isPortBindTimeout, startLabelledContainer } from './container-start.js';
import { dockerCli, type DockerRunner } from './test-resources.js';

const PORT_BIND_TIMEOUT = 'Timed out after 10000ms while waiting for container ports to be bound to the host';

/** Fake `docker` CLI: each `ps` for an attempt's start label returns the ids that attempt left. */
function fakeDocker(leftovers: Record<string, string[]> = {}): { docker: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const docker: DockerRunner = (args) => {
    calls.push([...args]);
    if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1] ?? '';
      const startId = filter.replace('label=noodara.test.start=', '');
      return Promise.resolve((leftovers[startId] ?? []).join('\n'));
    }
    return Promise.resolve('');
  };
  return { docker, calls };
}

describe('isPortBindTimeout (14-28)', () => {
  it("matches testcontainers' fixed port-bind wait timeout and nothing else", () => {
    expect(isPortBindTimeout(new Error(PORT_BIND_TIMEOUT))).toBe(true);
    expect(isPortBindTimeout(new Error('Container failed to be ready'))).toBe(false);
    expect(isPortBindTimeout('port is already allocated')).toBe(false);
  });
});

describe('startLabelledContainer (14-28)', () => {
  it('labels the container noodara.test=true plus a per-attempt start id, and returns the started value', async () => {
    const { docker, calls } = fakeDocker();
    const seen: Record<string, string>[] = [];
    const value = await startLabelledContainer(
      'postgres:17-alpine',
      (labels) => {
        seen.push(labels);
        return Promise.resolve('started');
      },
      { docker },
    );
    expect(value).toBe('started');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.['noodara.test']).toBe('true');
    expect(seen[0]?.['noodara.test.start']).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toEqual([]);
  });

  it('removes the container a port-bind timeout left running, then retries with a fresh start id', async () => {
    const startIds: string[] = [];
    const leftovers: Record<string, string[]> = {};
    const { docker, calls } = fakeDocker(leftovers);
    const value = await startLabelledContainer(
      'postgres:17-alpine',
      (labels) => {
        const id = labels['noodara.test.start'] ?? '';
        startIds.push(id);
        if (startIds.length === 1) {
          leftovers[id] = ['leaked-container-id'];
          return Promise.reject(new Error(PORT_BIND_TIMEOUT));
        }
        return Promise.resolve('second attempt');
      },
      { docker },
    );
    expect(value).toBe('second attempt');
    expect(startIds).toHaveLength(2);
    expect(startIds[0]).not.toBe(startIds[1]);
    expect(calls).toContainEqual(['rm', '-f', '-v', 'leaked-container-id']);
  });

  it('gives up after the bounded number of attempts with a clear error naming the image and the cause', async () => {
    const { docker, calls } = fakeDocker();
    let attempts = 0;
    const outcome = startLabelledContainer(
      'redis:7-alpine',
      () => {
        attempts += 1;
        return Promise.reject(new Error(PORT_BIND_TIMEOUT));
      },
      { docker, attempts: 3 },
    );
    await expect(outcome).rejects.toThrow(
      /redis:7-alpine did not bind its ports to the host in 3 attempt\(s\)/,
    );
    await expect(outcome).rejects.toHaveProperty('cause.message', PORT_BIND_TIMEOUT);
    expect(attempts).toBe(3);
    expect(calls.filter((c) => c[0] === 'ps')).toHaveLength(3);
  });

  it('does not retry any other start failure, but still removes what that attempt created', async () => {
    const leftovers: Record<string, string[]> = {};
    const { docker, calls } = fakeDocker(leftovers);
    const failure = new Error('image pull failed');
    let attempts = 0;
    const outcome = startLabelledContainer(
      'postgres:17-alpine',
      (labels) => {
        attempts += 1;
        leftovers[labels['noodara.test.start'] ?? ''] = ['created-id'];
        return Promise.reject(failure);
      },
      { docker },
    );
    await expect(outcome).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(calls).toContainEqual(['rm', '-f', '-v', 'created-id']);
  });

  it('against real Docker, removes the labelled container a port-bind timeout left behind', async () => {
    const created: string[] = [];
    const outcome = startLabelledContainer(
      'postgres:17-alpine',
      async (labels) => {
        const labelArgs = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
        created.push((await dockerCli(['create', ...labelArgs, 'postgres:17-alpine'])).trim());
        throw new Error(PORT_BIND_TIMEOUT);
      },
      { attempts: 1 },
    );
    await expect(outcome).rejects.toThrow(/did not bind its ports/);
    expect(created).toHaveLength(1);
    const left = await dockerCli(['ps', '-aq', '--no-trunc', '--filter', `id=${created[0] ?? ''}`]);
    expect(left.trim()).toBe('');
  });

  it('rejects a non-positive attempts bound', async () => {
    await expect(
      startLabelledContainer('x', () => Promise.resolve(1), { attempts: 0 }),
    ).rejects.toThrow(RangeError);
  });
});
