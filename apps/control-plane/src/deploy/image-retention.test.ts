import { describe, expect, it, vi } from 'vitest';
import type { ServiceImage, ServiceImagesResult, StepResult } from '@noodara/docker';
import { imageRetention, type DeploymentStatus } from '@noodara/domain/deployment';
import { createRedactor } from '@noodara/domain/security';
import type { ResourceId } from '@noodara/domain/validators';
import type { SshDeploySession } from '@noodara/ssh';
import {
  IMAGE_RETENTION_MAX_REMOVALS,
  createImageRetention,
  type ImageRetentionDeps,
  type ImageRetentionRunInput,
  type RetentionHistory,
  serviceImageRetention,
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
  /** 20-06: the recorded image; a rollback row records its target's image. Absent: the own tag. */
  readonly imageRef?: string | null;
}
/** createdAt follows the id order (uuidv7 ids are time ordered too). */
const history = (rows: readonly Row[], retention = 3): RetentionHistory => ({
  retention,
  deployments: rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: Number(row.id.slice(-4)),
    ...(row.imageRef === undefined ? {} : { imageRef: row.imageRef }),
  })),
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

describe('20-02 RED: worker and API retention views agree after a manual rollback', () => {
  it('an automatic rollback right after a manual rollback keeps every image the API lists as retained', async () => {
    // G1..G4 SUCCESS (own images), M5 = manual rollback to G3 (SUCCESS, imageRef = G3's tag, no own image),
    // U6 = unhealthy deploy being rolled back to the previous success, which is M5.
    const M5 = id(5);
    const U6 = id(6);
    const h = harness({
      host: [id(1), id(2), id(3), id(4), U6],
      rows: [...successes(1, 2, 3, 4), { id: M5, status: 'SUCCESS', imageRef: ref(id(3)) }, { id: U6, status: 'ROLLING_BACK' }],
    });
    // The API view (deployment-services.ts retainedImageRefs): SUCCESS rows by their imageRef, running = newest SUCCESS.
    const apiRows = [1, 2, 3, 4].map((n) => ({ id: id(n), status: 'SUCCESS' as const, imageRef: ref(id(n)), createdAt: n }));
    apiRows.push({ id: M5, status: 'SUCCESS', imageRef: ref(id(3)), createdAt: 5 });
    const apiRetained = new Set(imageRetention(apiRows, ref(id(3)), 3).keep);

    await h.run(input({ deploymentId: U6, outcome: 'ROLLED_BACK', previousSuccessId: M5 }));

    const removedButRetainedByApi = h.removed.map(ref).filter((r) => apiRetained.has(r));
    expect(removedButRetainedByApi).toEqual([]);
  });
});

describe('20-06: worker retention and the API retention agree (one rule)', () => {
  /** The production loader's contract: the named rows plus the rows recording one of their tags. */
  const dbLoad = (rows: readonly Row[], retention = 3): ImageRetentionDeps['load'] =>
    vi.fn((_serviceId: string, ids: readonly string[]) => {
      const tags = new Set(ids.map(ref));
      return Promise.resolve(
        history(
          rows.filter((row) => ids.includes(row.id) || (row.imageRef != null && tags.has(row.imageRef))),
          retention,
        ),
      );
    });
  /** The API view once the run is recorded: SUCCESS rows by imageRef, the newest SUCCESS is running. */
  const apiRetained = (rows: readonly Row[], retention = 3): ReadonlySet<string> => {
    const successRows = rows
      .filter((row) => row.status === 'SUCCESS')
      .map((row) => ({ id: row.id, status: row.status, imageRef: row.imageRef ?? ref(row.id), createdAt: Number(row.id.slice(-4)) }));
    const newest = successRows.reduce<(typeof successRows)[number] | undefined>((a, b) => (a && a.createdAt > b.createdAt ? a : b), undefined);
    return new Set(serviceImageRetention(successRows, newest?.id ?? null, retention).keep);
  };
  const rollbackOf = (n: number, imageOf: number, status: DeploymentStatus = 'SUCCESS'): Row => ({
    id: id(n),
    status,
    imageRef: ref(id(imageOf)),
  });
  const run = async (options: { host: readonly string[]; rows: readonly Row[]; after: readonly Row[]; input: Partial<ImageRetentionRunInput> }) => {
    const h = harness({ host: options.host, rows: options.rows, load: dbLoad(options.rows) });
    const report = await h.run(input(options.input));
    const retained = apiRetained(options.after);
    const remaining = options.host.map(ref).filter((tag) => !h.removed.map(ref).includes(tag));
    return { h, report, retained, remaining };
  };

  it('previous success is a normal deploy: only the unhealthy attempt image goes; the host equals the API set', async () => {
    const U5 = id(5);
    const r = await run({
      host: [id(1), id(2), id(3), id(4), U5],
      rows: [...successes(1, 2, 3, 4), { id: U5, status: 'ROLLING_BACK' }],
      after: [...successes(1, 2, 3, 4), { id: U5, status: 'ROLLED_BACK' }],
      input: { deploymentId: U5, outcome: 'ROLLED_BACK', previousSuccessId: id(4) },
    });

    expect(r.h.removed).toEqual([U5]);
    expect(new Set(r.remaining)).toEqual(r.retained);
  });

  it('previous success is a manual rollback: its target image is running; the host equals the API set', async () => {
    const U6 = id(6);
    const r = await run({
      host: [id(1), id(2), id(3), id(4), U6],
      rows: [...successes(1, 2, 3, 4), rollbackOf(5, 3), { id: U6, status: 'ROLLING_BACK' }],
      after: [...successes(1, 2, 3, 4), rollbackOf(5, 3), { id: U6, status: 'ROLLED_BACK' }],
      input: { deploymentId: U6, outcome: 'ROLLED_BACK', previousSuccessId: id(5) },
    });

    expect(r.h.removed).toEqual([U6]);
    expect(new Set(r.remaining)).toEqual(r.retained);
  });

  it('a manual rollback row counts as a newer use of its target image in a later deploy', async () => {
    // G1..G4, M5 = rollback to G1, D6 = a new deploy: the API keeps D6 + {G1 (via M5), G4, G3}.
    const D6 = id(6);
    const rows = [...successes(1, 2, 3, 4), rollbackOf(5, 1), { id: D6, status: 'HEALTHCHECK' as const }];
    const r = await run({
      host: [id(1), id(2), id(3), id(4), D6],
      rows,
      after: [...successes(1, 2, 3, 4), rollbackOf(5, 1), { id: D6, status: 'SUCCESS' }],
      input: { deploymentId: D6, outcome: 'SUCCESS' },
    });

    expect(r.h.removed).toEqual([id(2)]);
    expect(new Set(r.remaining)).toEqual(r.retained);
  });

  it('a rollback of a rollback: the running image is the original target, on success and after an unhealthy deploy', async () => {
    // G1..G4, M5 = rollback to G1, D6 deploy (G2 removed), M7 = rollback of M5 (image G1).
    const D6 = id(6);
    const M7 = id(7);
    const U8 = id(8);
    const base = [...successes(1, 2, 3, 4), rollbackOf(5, 1), { id: D6, status: 'SUCCESS' as const }];
    const host = [id(1), id(3), id(4), D6];

    // M7 succeeds: the worker passes the restored target (M5) as the running deployment (17-05).
    const restored = await run({
      host,
      rows: [...base, rollbackOf(7, 1, 'HEALTHCHECK')],
      after: [...base, rollbackOf(7, 1)],
      input: { deploymentId: id(5), outcome: 'SUCCESS' },
    });
    expect(restored.h.removed).toEqual([]);
    expect(new Set(restored.remaining)).toEqual(restored.retained);

    // U8 is unhealthy and rolled back to M7.
    const rolledBack = await run({
      host: [...host, U8],
      rows: [...base, rollbackOf(7, 1), { id: U8, status: 'ROLLING_BACK' }],
      after: [...base, rollbackOf(7, 1), { id: U8, status: 'ROLLED_BACK' }],
      input: { deploymentId: U8, outcome: 'ROLLED_BACK', previousSuccessId: M7 },
    });
    expect(rolledBack.h.removed).toEqual([U8]);
    expect(new Set(rolledBack.remaining)).toEqual(rolledBack.retained);
  });

  it("a rollback whose target image is already gone: nothing the API retains is removed and the run completes", async () => {
    // G1..G4, M5 = rollback to G3, but G3's image is no longer on the host; U6 rolls back to M5.
    const U6 = id(6);
    const r = await run({
      host: [id(1), id(2), id(4), U6],
      rows: [...successes(1, 2, 3, 4), rollbackOf(5, 3), { id: U6, status: 'ROLLING_BACK' }],
      after: [...successes(1, 2, 3, 4), rollbackOf(5, 3), { id: U6, status: 'ROLLED_BACK' }],
      input: { deploymentId: U6, outcome: 'ROLLED_BACK', previousSuccessId: id(5) },
    });

    expect(r.report.outcome).toBe('done');
    expect(r.h.removed).toEqual([U6]);
    expect(r.h.removed.map(ref).filter((tag) => r.retained.has(tag))).toEqual([]);
  });
});

describe('serviceImageRetention (20-06)', () => {
  const row = (n: number, imageOf = n, status: DeploymentStatus = 'SUCCESS') => ({ id: id(n), status, imageRef: ref(id(imageOf)), createdAt: n });

  it('the running image is the running row image (a rollback row: its target image)', () => {
    const plan = serviceImageRetention([row(1), row(2), row(3), row(4), row(5, 3)], id(5), 3);

    expect(new Set(plan.keep)).toEqual(new Set([ref(id(3)), ref(id(4)), ref(id(2)), ref(id(1))]));
  });

  it('a missing running row or no running id keeps only the N newest known-good images', () => {
    expect(serviceImageRetention([row(1), row(2)], id(9), 1).keep).toEqual([ref(id(2))]);
    expect(serviceImageRetention([row(1), row(2)], null, 1).keep).toEqual([ref(id(2))]);
  });

  it('orders newest first whatever the input order, the id breaking a createdAt tie', () => {
    const tie = [{ ...row(1), createdAt: 7 }, { ...row(2), createdAt: 7 }];
    expect(serviceImageRetention(tie, null, 1).keep).toEqual([ref(id(2))]);
    expect(serviceImageRetention([...tie].reverse(), null, 1).keep).toEqual([ref(id(2))]);
  });
});
