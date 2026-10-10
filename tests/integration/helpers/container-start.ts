// Leak-proof, bounded container start for integration fixtures (14-28).
//
// testcontainers 12 waits a fixed, non-configurable 10 s for Docker to report a started
// container's published ports (`inspectContainerUntilPortsExposed`). On a slow daemon (this host:
// 4000+ images, list/inspect calls over 10 s at times) that wait can expire, and unlike a failed
// wait strategy (which stops and removes the container) this path throws with the container still
// running and no handle returned: the caller cannot stop it. In gate 14-15 run 2 that leaked a
// postgres container from events-sse.test.ts and failed every later test's stray check.
//
// Here every attempt carries a unique `noodara.test.start` label, so whatever a failed attempt
// left behind is found and removed by label. Only the port-bind timeout is retried, a bounded
// number of times, each with a fresh container: the effective port-bind wait is
// `attempts` x testcontainers' 10 s. After that the start fails with an error naming the image.
import { randomUUID } from 'node:crypto';
import { dockerCli, type DockerRunner } from './test-resources.js';

export const DEFAULT_START_ATTEMPTS = 3;
const START_LABEL = 'noodara.test.start';
const PORT_BIND_TIMEOUT_PATTERN = /while waiting for container ports to be bound to the host/i;

export function isPortBindTimeout(error: unknown): boolean {
  return error instanceof Error && PORT_BIND_TIMEOUT_PATTERN.test(error.message);
}

export interface StartLabelledOptions {
  /** Total attempts including the first one. Default 3. */
  readonly attempts?: number;
  /** Injectable for tests; defaults to the bounded `docker` CLI runner. */
  readonly docker?: DockerRunner;
}

async function removeAttempt(startId: string, docker: DockerRunner): Promise<void> {
  const ids = (await docker(['ps', '-aq', '--no-trunc', '--filter', `label=${START_LABEL}=${startId}`]))
    .split('\n')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length > 0) await docker(['rm', '-f', '-v', ...ids]);
}

/**
 * Calls `start` with the labels to put on the container. A failed attempt's container is removed
 * before the error propagates; a port-bind timeout is retried up to `attempts` times in total.
 */
export async function startLabelledContainer<T>(
  image: string,
  start: (labels: Record<string, string>) => Promise<T>,
  options: StartLabelledOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_START_ATTEMPTS;
  const docker = options.docker ?? dockerCli;
  if (attempts < 1) throw new RangeError('attempts must be at least 1');

  for (let attempt = 1; ; attempt += 1) {
    const startId = randomUUID();
    try {
      return await start({ 'noodara.test': 'true', [START_LABEL]: startId });
    } catch (error: unknown) {
      // Best effort: the leak guard still reaps by `noodara.test` if this removal fails.
      await removeAttempt(startId, docker).catch(() => undefined);
      if (!isPortBindTimeout(error)) throw error;
      if (attempt >= attempts) {
        throw new Error(
          `${image} did not bind its ports to the host in ${String(attempts)} attempt(s) ` +
            `(testcontainers waits a fixed 10 s per attempt); the Docker daemon is too slow or overloaded`,
          { cause: error },
        );
      }
    }
  }
}
