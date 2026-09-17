import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

export interface RedisFixture {
  container: StartedRedisContainer;
  connectionUrl: string;
  /** Safe to call more than once. */
  stop: () => Promise<void>;
}

/**
 * Starts a fresh `redis:7-alpine` container labelled `noodara.test=true` — mirrors
 * `postgres.ts`'s fixture shape exactly (labels, idempotent `stop()`, returned object). The label
 * is not decorative: CI's stray-container check in the `integration`, `security` and
 * `boot-smoke` jobs filters on `label=noodara.test=true`, so an unlabelled container would leak
 * silently across runs.
 */
export async function startRedis(): Promise<RedisFixture> {
  const container = await new RedisContainer('redis:7-alpine').withLabels({ 'noodara.test': 'true' }).start();

  const connectionUrl = container.getConnectionUrl();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await container.stop();
  };

  return { container, connectionUrl, stop };
}
