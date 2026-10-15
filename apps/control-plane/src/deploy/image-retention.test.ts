import { describe, expect, it, vi } from 'vitest';
import type { ServiceImage, ServiceImagesResult, StepResult } from '@noodara/docker';
import type { DeploymentStatus } from '@noodara/domain/deployment';
import { createRedactor } from '@noodara/domain/security';
import type { ResourceId } from '@noodara/domain/validators';
import type { SshDeploySession } from '@noodara/ssh';
import {
  IMAGE_RETENTION_MAX_REMOVALS,
  createImageRetention,
  type ImageRetentionDeps,
  type ImageRetentionRunInput,
  type RetentionHistory,
} from './image-retention.js';

const SERVICE = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb' as ResourceId;
const id = (n: number): ResourceId => `0192f1a4-7b3c-7d2e-8f00-${String(n).padStart(12, '0')}` as ResourceId;
const ref = (deploymentId: string): string => `noodara/${SERVICE}:${deploymentId}`;
const CURRENT = id(9);

const completed = { exitCode: 0, signal: null, truncated: false, stdoutTail: '', stderrTail: '' } as never;
const listed = (ids: readonly string[]): StepResult<ServiceImagesResult> => ({
  ok: true,
  value: {
    kind: 'ok',
    images: ids.map((deploymentId): ServiceImage => ({ deploymentId: deploymentId as ResourceId, imageId: `sha256:${deploymentId}`, createdAt: '' })),
  },
  result: completed,
});

interface Row {
  readonly id: string;
  readonly status: DeploymentStatus;
}
/** createdAt follows the id order (uuidv7 ids are time ordered too). */
const history = (rows: readonly Row[], retention = 3): RetentionHistory => ({
  retention,
  deployments: rows.map((row) => ({ id: row.id, status: row.status, createdAt: Number(row.id.slice(-4)) })),
});

function harness(options: {
  host: readonly string[];
  rows: readonly Row[];
  retention?: number;
  remove?: ImageRetentionDeps['remove'];
  list?: ImageRetentionDeps['list'];
  load?: ImageRetentionDeps['load'];
}) {
  const removed: string[] = [];
  const loadCalls: { serviceId: string; ids: readonly string[] }[] = [];
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const deps: ImageRetentionDeps = {
    load:
      options.load ??
      vi.fn((serviceId: string, ids: readonly string[]) => {
        loadCalls.push({ serviceId, ids });
        return Promise.resolve(history(options.rows.filter((row) => ids.includes(row.id)), options.retention));
      }),
    list: options.list ?? vi.fn(() => Promise.resolve(listed(options.host))),
    remove:
      options.remove ??
      vi.fn((_input: ImageRetentionRunInput, deploymentId: ResourceId) => {
        removed.push(deploymentId);
        return Promise.resolve({ ok: true as const, value: ref(deploymentId), result: completed });
      }),
    logger: {
      info: (fields, message) => void logs.push({ level: 'info', fields, message }),
      warn: (fields, message) => void logs.push({ level: 'warn', fields, message }),
    },
  };
  return { run: createImageRetention(deps), deps, removed, loadCalls, logs };
}

const input = (overrides: Partial<ImageRetentionRunInput> = {}): ImageRetentionRunInput => ({
  serviceId: SERVICE,
  deploymentId: CURRENT,
  outcome: 'SUCCESS',
  previousSuccessId: null,
  session: { stream: vi.fn() } as unknown as SshDeploySession,
  redactor: createRedactor(),
  ...overrides,
});

const successes = (...ns: number[]): Row[] => ns.map((n) => ({ id: id(n), status: 'SUCCESS' }));

describe('image retention (17-04)', () => {
  it('A1: after SUCCESS keeps the running image plus N previous known-good images and removes the rest', async () => {
    const h = harness({
      host: [id(1), id(2), id(3), id(4), id(5), CURRENT],
      // The current deployment is still non-terminal in the database: retention runs before finish.
      rows: [...successes(1, 2, 3, 4, 5), { id: CURRENT, status: 'HEALTHCHECK' }],
    });

    const report = await h.run(input());

    expect(h.removed.sort()).toEqual([id(1), id(2)]);
    expect(report.outcome).toBe('done');
    expect([...report.kept].sort()).toEqual([ref(id(3)), ref(id(4)), ref(id(5)), ref(CURRENT)].sort());
    expect([...report.removed].sort()).toEqual([ref(id(1)), ref(id(2))]);
    expect(report.failed).toEqual([]);
  });

  it('A1: the service retention setting is honoured', async () => {
    const h = harness({
      host: [id(1), id(2), id(3), CURRENT],
      rows: [...successes(1, 2, 3), { id: CURRENT, status: 'DEPLOYING' }],
      retention: 1,
    });

    await h.run(input());

    expect(h.removed.sort()).toEqual([id(1), id(2)]);
  });

  it('A1: after ROLLED_BACK the restored image is the running one; the failed attempt image is removed', async () => {
    const h = harness({
      host: [id(1), id(2), id(3), id(4), id(5), CURRENT],
      rows: [...successes(1, 2, 3, 4, 5), { id: CURRENT, status: 'ROLLING_BACK' }],
    });

    const report = await h.run(input({ outcome: 'ROLLED_BACK', previousSuccessId: id(5) }));

    // Running id(5) plus three previous: id(4), id(3), id(2).
    expect(h.removed.sort()).toEqual([id(1), CURRENT].sort());
    expect(report.kept).toContain(ref(id(5)));
  });

  it('A1: the running image is never removed, even when it is older than the N newest known-good images', async () => {
    const h = harness({
      host: [id(1), id(2), id(3), id(4), id(5), CURRENT],
      rows: [...successes(1, 2, 3, 4, 5), { id: CURRENT, status: 'ROLLING_BACK' }],
    });

    // A manual rollback restored id(1): it is running and must be kept.
    await h.run(input({ outcome: 'ROLLED_BACK', previousSuccessId: id(1) }));

    expect(h.removed).not.toContain(id(1));
  });

  it('A1: a SUCCESS deployment never removes its own image', async () => {
    const h = harness({ host: [id(1), CURRENT], rows: [...successes(1), { id: CURRENT, status: 'HEALTHCHECK' }], retention: 1 });

    await h.run(input());

    expect(h.removed).not.toContain(CURRENT);
  });

  it('keeps the images of failed and cancelled attempts out of the known-good count and removes them', async () => {
    const h = harness({
      host: [id(1), id(2), id(3), CURRENT],
      rows: [{ id: id(1), status: 'SUCCESS' }, { id: id(2), status: 'FAILED' }, { id: id(3), status: 'CANCELLED' }, { id: CURRENT, status: 'HEALTHCHECK' }],
    });

    await h.run(input());

    expect(h.removed.sort()).toEqual([id(2), id(3)]);
  });

  it('removes images of the service whose deployment row no longer exists', async () => {
    const h = harness({ host: [id(7), CURRENT], rows: [{ id: CURRENT, status: 'HEALTHCHECK' }] });

    await h.run(input());

    expect(h.removed).toEqual([id(7)]);
  });

  it('H1: loads only the deployments whose images are on the host, plus the current and restored ones', async () => {
    const h = harness({ host: [id(1), CURRENT], rows: [...successes(1, 5), { id: CURRENT, status: 'HEALTHCHECK' }] });

    await h.run(input({ outcome: 'ROLLED_BACK', previousSuccessId: id(5) }));

    expect(h.loadCalls).toHaveLength(1);
    expect(h.loadCalls[0]?.serviceId).toBe(SERVICE);
    expect([...(h.loadCalls[0]?.ids ?? [])].sort()).toEqual([id(1), id(5), CURRENT].sort());
  });

  it('H1: never touches an image that is not in the listing of noodara/<serviceId> managed images', async () => {
    const h = harness({ host: [id(1), id(2)], rows: [...successes(1, 2, 3, 4, 5, 6), { id: CURRENT, status: 'HEALTHCHECK' }], retention: 1 });

    await h.run(input());

    // id(3)..id(6) are older SUCCESS rows without an image on the host: nothing to remove there.
    for (const removed of h.removed) expect([id(1), id(2)]).toContain(removed);
  });

  it('H1: a non-terminal deployment other than the current one keeps its image (defensive)', async () => {
    const h = harness({
      host: [id(1), id(2), CURRENT],
      rows: [{ id: id(1), status: 'SUCCESS' }, { id: id(2), status: 'PREPARING' }, { id: CURRENT, status: 'HEALTHCHECK' }],
      retention: 1,
    });

    await h.run(input());

    expect(h.removed).not.toContain(id(2));
  });

  it('A2: a refused or failed removal is logged and reported; the other removals still run', async () => {
    const remove = vi.fn((_input: ImageRetentionRunInput, deploymentId: ResourceId) => {
      if (deploymentId === id(1)) {
        return Promise.resolve({ ok: false as const, kind: 'in_use' as const, image: ref(deploymentId) as never, message: 'kept' });
      }
      if (deploymentId === id(2)) {
        return Promise.resolve({ ok: false as const, kind: 'failed' as const, code: 'DOCKER_UNAVAILABLE' as const, message: 'x' });
      }
      return Promise.resolve({ ok: true as const, value: ref(deploymentId), result: completed });
    });
    const h = harness({
      host: [id(1), id(2), id(3), CURRENT],
      rows: [...successes(1, 2, 3), { id: CURRENT, status: 'HEALTHCHECK' }],
      retention: 1,
      remove,
    });

    const report = await h.run(input());

    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual(
      expect.arrayContaining([
        { imageRef: ref(id(1)), kind: 'in_use' },
        { imageRef: ref(id(2)), kind: 'DOCKER_UNAVAILABLE' },
      ]),
    );
    expect(h.logs.filter((log) => log.level === 'warn')).toHaveLength(2);
  });

  it('A2: a thrown removal is reported by error class only', async () => {
    const remove = vi.fn(() => Promise.reject(new TypeError('ssh: postgres://user:pw@db stderr')));
    // Retention 1 after a SUCCESS: CURRENT runs, id(2) is the previous known-good, id(1) goes.
    const h = harness({
      host: [id(1), id(2), CURRENT],
      rows: [...successes(1, 2), { id: CURRENT, status: 'HEALTHCHECK' }],
      retention: 1,
      remove,
    });

    const report = await h.run(input());

    expect(report.failed).toEqual([{ imageRef: ref(id(1)), kind: 'TypeError' }]);
    expect(JSON.stringify(h.logs)).not.toContain('postgres://');
  });

  it('A2: an interrupted removal stops the run; the rest is left for the next deployment', async () => {
    const remove = vi.fn(() => Promise.resolve({ ok: false as const, kind: 'interrupted' as const, outcome: 'timed_out' as const }));
    const h = harness({
      host: [id(1), id(2), id(3), CURRENT],
      rows: [...successes(1, 2, 3), { id: CURRENT, status: 'HEALTHCHECK' }],
      retention: 1,
      remove,
    });

    const report = await h.run(input());

    expect(remove).toHaveBeenCalledTimes(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.kind).toBe('timed_out');
  });

  it('bounds the removals of one run', async () => {
    const old = Array.from({ length: IMAGE_RETENTION_MAX_REMOVALS + 5 }, (_, i) => id(100 + i));
    const h = harness({
      host: [...old, CURRENT],
      rows: [...old.map((oldId) => ({ id: oldId, status: 'FAILED' as const })), { id: CURRENT, status: 'HEALTHCHECK' }],
    });

    await h.run(input());

    expect(h.removed).toHaveLength(IMAGE_RETENTION_MAX_REMOVALS);
  });

  it('skips without removing anything when the listing fails or is unparseable', async () => {
    const failed = harness({
      host: [],
      rows: [],
      list: () => Promise.resolve({ ok: false, kind: 'failed', code: 'DOCKER_UNAVAILABLE', message: 'x' }),
    });
    const unparseable = harness({
      host: [],
      rows: [],
      list: () => Promise.resolve({ ok: true, value: { kind: 'unparseable', reason: 'truncated' }, result: completed }),
    });

    expect((await failed.run(input())).outcome).toBe('skipped_list_failed');
    expect((await unparseable.run(input())).outcome).toBe('skipped_list_failed');
    expect(failed.removed).toEqual([]);
    expect(unparseable.removed).toEqual([]);
    expect(failed.logs.some((log) => log.level === 'warn')).toBe(true);
  });

  it('skips without removing anything when the history cannot be loaded or the service is gone', async () => {
    const thrown = harness({ host: [id(1), CURRENT], rows: [], load: () => Promise.reject(new Error('db down')) });
    const missing = harness({ host: [id(1), CURRENT], rows: [], load: () => Promise.resolve(null) });

    expect((await thrown.run(input())).outcome).toBe('skipped_load_failed');
    expect((await missing.run(input())).outcome).toBe('skipped_service_missing');
    expect(thrown.removed).toEqual([]);
    expect(missing.removed).toEqual([]);
  });

  it('a thrown listing never escapes', async () => {
    const h = harness({ host: [], rows: [], list: () => Promise.reject(new Error('boom')) });

    await expect(h.run(input())).resolves.toMatchObject({ outcome: 'skipped_list_failed' });
  });

  it('does nothing on a host without images of the service', async () => {
    const h = harness({ host: [], rows: [] });

    const report = await h.run(input());

    expect(report.outcome).toBe('done');
    expect(h.loadCalls).toEqual([]);
    expect(h.removed).toEqual([]);
  });

  it('an aborted run removes nothing', async () => {
    const h = harness({ host: [id(1), CURRENT], rows: [{ id: id(1), status: 'FAILED' }, { id: CURRENT, status: 'HEALTHCHECK' }] });

    const report = await h.run(input({ signal: AbortSignal.abort() }));

    expect(report.outcome).toBe('skipped_aborted');
    expect(h.removed).toEqual([]);
  });
});
