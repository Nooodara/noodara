import { describe, expect, it, vi } from 'vitest';
import { createProxyQueue, PROXY_INSTALL_JOB_NAME, type ProxyBullQueue } from './proxy-queue.js';
import type { ProxyInstallJobPayload } from './proxy-job-payload.js';

const SERVER = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const JOB_ID = `proxy-install-${SERVER}`;
const payload: ProxyInstallJobPayload = { serverId: SERVER, acmeEmail: 'ops@example.com', jobId: JOB_ID };

function fakeQueue(state: string | null) {
  const jobs = new Map<string, { state: string }>();
  if (state !== null) jobs.set(JOB_ID, { state });
  const add = vi.fn(async (_name: string, _data: ProxyInstallJobPayload, opts: { jobId: string }) => {
    jobs.set(opts.jobId, { state: 'waiting' });
    return { id: opts.jobId };
  });
  const queue: ProxyBullQueue = {
    add,
    getJob: async (id) => {
      const job = jobs.get(id);
      return job ? { getState: async () => job.state, remove: async () => void jobs.delete(id) } : undefined;
    },
    close: async () => undefined,
  };
  return { queue, add };
}

describe('proxy queue (22-02 H1)', () => {
  it('adds one non-retried job under the deterministic id', async () => {
    const { queue, add } = fakeQueue(null);
    const result = await createProxyQueue({ queue }).enqueue(payload);
    expect(result).toEqual({ ok: true, jobId: JOB_ID, collapsed: false });
    expect(add).toHaveBeenCalledWith(PROXY_INSTALL_JOB_NAME, payload, expect.objectContaining({ jobId: JOB_ID, attempts: 1 }));
  });

  it('concurrent installs for one server collapse into one job', async () => {
    const { queue, add } = fakeQueue(null);
    const proxy = createProxyQueue({ queue });
    const first = await proxy.enqueue(payload);
    const results = await Promise.all([proxy.enqueue(payload), proxy.enqueue(payload)]);
    expect(first.ok).toBe(true);
    expect(results).toEqual([
      { ok: true, jobId: JOB_ID, collapsed: true },
      { ok: true, jobId: JOB_ID, collapsed: true },
    ]);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'delayed'])('a %s job collapses the request', async (state) => {
    const { queue, add } = fakeQueue(state);
    expect(await createProxyQueue({ queue }).enqueue(payload)).toEqual({ ok: true, jobId: JOB_ID, collapsed: true });
    expect(add).not.toHaveBeenCalled();
  });

  it('a finished job is replaced', async () => {
    const { queue, add } = fakeQueue('failed');
    expect((await createProxyQueue({ queue }).enqueue(payload)).ok).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('refuses a payload carrying anything else', async () => {
    const { queue, add } = fakeQueue(null);
    const tampered = { ...payload, privateKey: 'x' } as ProxyInstallJobPayload;
    expect((await createProxyQueue({ queue }).enqueue(tampered)).ok).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it('a broken queue is QUEUE_UNAVAILABLE with a fixed message', async () => {
    const queue: ProxyBullQueue = {
      add: async () => {
        throw new Error('redis://:pw@redis:6379 down');
      },
      getJob: async () => undefined,
      close: async () => undefined,
    };
    const result = await createProxyQueue({ queue }).enqueue(payload);
    expect(result).toEqual({ ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable' });
    expect(await createProxyQueue({ queue }).isInstallPending(SERVER)).toBe(false);
  });

  it('isInstallPending reflects the job state', async () => {
    expect(await createProxyQueue({ queue: fakeQueue('active').queue }).isInstallPending(SERVER)).toBe(true);
    expect(await createProxyQueue({ queue: fakeQueue('completed').queue }).isInstallPending(SERVER)).toBe(false);
  });
});
