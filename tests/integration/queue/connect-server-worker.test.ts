// D-10/D-12/D-15/ACT-01: RED for the connect-server-worker job handler. Every expectation below
// fails today for the same reason — apps/control-plane/src/queue/connect-server-worker.ts does
// not exist yet.
//
// Proves: the worker runs `connectAndDiscover` off the API thread and completes `{ outcome: 'ok'
// }` on success; an expected `{ ok: false, code }` service result completes the job (never fails
// it) with `{ outcome: code }`; a genuine throw (an injected failing `deps.db`) marks the job
// failed and logs only the jobId, never the payload; a malformed `job.data` written directly into
// Redis completes as `INVALID_PAYLOAD` and the worker keeps serving; and `trigger: 'connect'` /
// `'discover'` drive the identical code path (D-10).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandName, ExecResult, HostFingerprint } from '@noodara/ssh';
import { servers } from '../../../apps/control-plane/src/db/schema/index.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { startWorkerFixture, type WorkerFixture } from '../helpers/worker-fixture.js';
import { buildFakeSshPort, buildFakeSshSession } from '../services/helpers/service-fixture.js';

let fixture: WorkerFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

type FixtureActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };
const SYSTEM: FixtureActor = { type: 'system' };

const FP1: HostFingerprint = {
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

function freshPassword(): string {
  return randomUUID().replace(/-/g, '');
}

function uniqueName(): string {
  return `srv-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

function execResult(overrides: Partial<ExecResult> & { commandName: CommandName }): ExecResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 5,
    truncated: false,
    ...overrides,
  };
}

/** A scripted, fully successful discovery run (mirrors packages/ssh/src/run-discovery.test.ts's
 *  own `successfulScripts()` — not exported from that package, so duplicated here rather than
 *  reaching past @noodara/ssh's single public entrypoint). The worker never overrides
 *  `connectAndDiscover`'s `discover` seam (only phase-3's own service tests do), so proving the
 *  row actually reaches CONNECTED here means scripting the real `runDiscovery` end to end. */
function successfulExecResults(): Record<CommandName, ExecResult> {
  return {
    'discovery.hostname': execResult({ commandName: 'discovery.hostname', stdout: 'web-01\n' }),
    'discovery.os_release': execResult({
      commandName: 'discovery.os_release',
      stdout: 'ID=ubuntu\nNAME="Ubuntu"\nVERSION_ID="24.04"\n',
    }),
    'discovery.arch': execResult({ commandName: 'discovery.arch', stdout: 'x86_64\n' }),
    'discovery.cpu': execResult({ commandName: 'discovery.cpu', stdout: '4\n' }),
    'discovery.memory': execResult({
      commandName: 'discovery.memory',
      stdout: 'MemTotal:        8024176 kB\n',
    }),
    'discovery.disk': execResult({
      commandName: 'discovery.disk',
      stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 932594 88404 800000 10% /\n',
    }),
    'discovery.uptime': execResult({ commandName: 'discovery.uptime', stdout: '12345.67 999.99\n' }),
    'docker.version': execResult({
      commandName: 'docker.version',
      stdout: '{"Client":{"Version":"24.0.7"},"Server":{"Version":"24.0.7"}}',
    }),
    'docker.compose_version': execResult({ commandName: 'docker.compose_version', stdout: 'v2.29.1' }),
    'access.sudo': execResult({ commandName: 'access.sudo', exitCode: 0 }),
    'access.docker_group': execResult({
      commandName: 'access.docker_group',
      stdout: 'deployer docker sudo\n',
    }),
  };
}

function buildSuccessfulSshPort() {
  return buildFakeSshPort({
    ok: true,
    session: buildFakeSshSession(successfulExecResults()),
    fingerprint: FP1,
    fingerprintCaptured: true,
    attempts: 1,
  });
}

async function registerFixtureServer(fx: WorkerFixture) {
  const { registerServer } = await import('../../../apps/control-plane/src/services/register-server.js');
  const result = await registerServer(fx.deps, {
    actor: SYSTEM,
    name: uniqueName(),
    host: uniqueHost(),
    credential: { kind: 'password', password: freshPassword() },
  });
  if (!result.ok) {
    throw new Error(`registerFixtureServer failed unexpectedly: ${result.code} ${result.message}`);
  }
  return result.server;
}

async function enqueueJob(
  fx: WorkerFixture,
  serverId: string,
  trigger: 'connect' | 'discover' = 'connect',
): Promise<string> {
  const result = await fx.queue.enqueue({
    serverId,
    actor: SYSTEM,
    requestedAt: new Date().toISOString(),
    trigger,
  });
  if (!result.ok) {
    throw new Error(`enqueue failed unexpectedly: ${result.code} ${result.message}`);
  }
  return result.jobId;
}

function waitForCompletion(
  fx: WorkerFixture,
  jobId: string,
  timeoutMs = 20_000,
): Promise<{ outcome: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`job ${jobId} did not complete within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    fx.worker.worker.on('completed', (job, result: { outcome: string }) => {
      if (job.id === jobId) {
        clearTimeout(timer);
        resolve(result);
      }
    });
  });
}

function waitForFailure(fx: WorkerFixture, jobId: string, timeoutMs = 20_000): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`job ${jobId} did not fail within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    fx.worker.worker.on('failed', (job, err) => {
      if (job?.id === jobId) {
        clearTimeout(timer);
        resolve(err);
      }
    });
  });
}

describe('connect-server-worker: the job handler (D-10/D-15)', () => {
  it('drives connectAndDiscover exactly once and completes { outcome: "ok" }; the row reaches CONNECTED with two server.updated events', async () => {
    fixture = await startWorkerFixture();
    const server = await registerFixtureServer(fixture);
    const fakeSsh = buildSuccessfulSshPort();
    fixture.setSshPort(fakeSsh);

    const eventsBefore = fixture.events.length;
    const jobId = await enqueueJob(fixture, server.id, 'connect');
    const result = await waitForCompletion(fixture, jobId);

    expect(result).toEqual({ outcome: 'ok' });
    expect(fakeSsh.calls).toHaveLength(1);

    const [row] = await fixture.db.select().from(servers).where(eq(servers.id, server.id));
    expect(row?.status).toBe('CONNECTED');

    // Since plan 05-04 the same stream also carries one `server.discovery_progress` event per
    // check, so the two status events are selected by type rather than assumed adjacent. The
    // ordering is still pinned: CONNECTING first, CONNECTED last, nothing but progress between.
    const published = fixture.events.slice(eventsBefore);
    const statusUpdates = published.filter((event) => event.type === 'server.updated');
    expect(statusUpdates).toHaveLength(2);
    expect(statusUpdates[0]).toMatchObject({ type: 'server.updated', server: { status: 'CONNECTING' } });
    expect(statusUpdates[1]).toMatchObject({ type: 'server.updated', server: { status: 'CONNECTED' } });

    expect(published[0]).toBe(statusUpdates[0]);
    expect(published.at(-1)).toBe(statusUpdates[1]);
    const between = published.slice(1, -1);
    expect(between.every((event) => event.type === 'server.discovery_progress')).toBe(true);
  });

  it('a NOT_FOUND service result completes the job (never fails it)', async () => {
    fixture = await startWorkerFixture();
    const missingId = randomUUID();

    const jobId = await enqueueJob(fixture, missingId, 'connect');
    const result = await waitForCompletion(fixture, jobId);

    expect(result).toEqual({ outcome: 'NOT_FOUND' });
  });

  it('an ALREADY_CONNECTING service result completes the job (never fails it)', async () => {
    fixture = await startWorkerFixture();
    const server = await registerFixtureServer(fixture);
    await fixture.db.update(servers).set({ status: 'CONNECTING' }).where(eq(servers.id, server.id));

    const jobId = await enqueueJob(fixture, server.id, 'connect');
    const result = await waitForCompletion(fixture, jobId);

    expect(result).toEqual({ outcome: 'ALREADY_CONNECTING' });
  });

  it('a throwing deps.db marks the job failed and logs only the jobId, never the payload', async () => {
    fixture = await startWorkerFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setDbFailing(true);

    const jobId = await enqueueJob(fixture, server.id, 'connect');
    const err = await waitForFailure(fixture, jobId);

    expect(err).toBeInstanceOf(Error);

    const errorLogs = fixture.logs.filter((record) => record.level === 'error');
    expect(errorLogs.length).toBeGreaterThanOrEqual(1);
    const [record] = errorLogs;
    expect(record?.obj).toMatchObject({ jobId });
    expect(record?.obj).not.toHaveProperty('payload');
    expect(record?.obj).not.toHaveProperty('data');
    expect(record?.obj).not.toHaveProperty('serverId');
  });

  it('a malformed job.data completes as INVALID_PAYLOAD and the worker keeps processing subsequent jobs', async () => {
    fixture = await startWorkerFixture();

    const { createQueueRedisConnection } = await import('../../../apps/control-plane/src/redis/connections.js');
    const bullmq = await import('bullmq');
    const rawConnection = createQueueRedisConnection(fixture.redisUrl);
    const rawQueue = new bullmq.Queue('servers', { connection: rawConnection, prefix: 'noodara' });
    const malformedJobId = `connect-${randomUUID()}`;

    try {
      await rawQueue.add(
        'connect-server',
        { totally: 'not a valid connect-server payload' },
        { jobId: malformedJobId, attempts: 1 },
      );
      const malformedResult = await waitForCompletion(fixture, malformedJobId);
      expect(malformedResult).toEqual({ outcome: 'INVALID_PAYLOAD' });

      const server = await registerFixtureServer(fixture);
      fixture.setSshPort(buildSuccessfulSshPort());
      const jobId = await enqueueJob(fixture, server.id, 'connect');
      const result = await waitForCompletion(fixture, jobId);
      expect(result).toEqual({ outcome: 'ok' });
    } finally {
      await rawQueue.close();
      rawConnection.disconnect();
    }
  });

  it('trigger connect and discover take the identical code path (D-10)', async () => {
    fixture = await startWorkerFixture();
    const serverA = await registerFixtureServer(fixture);
    const serverB = await registerFixtureServer(fixture);

    const sshA = buildSuccessfulSshPort();
    fixture.setSshPort(sshA);
    const jobA = await enqueueJob(fixture, serverA.id, 'connect');
    const resultA = await waitForCompletion(fixture, jobA);

    const sshB = buildSuccessfulSshPort();
    fixture.setSshPort(sshB);
    const jobB = await enqueueJob(fixture, serverB.id, 'discover');
    const resultB = await waitForCompletion(fixture, jobB);

    expect(resultA).toEqual({ outcome: 'ok' });
    expect(resultB).toEqual({ outcome: 'ok' });
    expect(sshA.calls).toHaveLength(1);
    expect(sshB.calls).toHaveLength(1);

    const [rowA] = await fixture.db.select().from(servers).where(eq(servers.id, serverA.id));
    const [rowB] = await fixture.db.select().from(servers).where(eq(servers.id, serverB.id));
    expect(rowA?.status).toBe('CONNECTED');
    expect(rowB?.status).toBe('CONNECTED');
  });
});
