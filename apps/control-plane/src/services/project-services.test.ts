import { describe, expect, it, vi } from 'vitest';
import type { ProjectSlug } from '@noodara/domain';
import type { Database } from '../db/client.js';
import {
  changedFieldNames,
  createProject,
  createEnvironment,
  pickFreeProjectSlug,
  toEnvironmentView,
  toProjectView,
  updateProject,
  type ProjectServicesDeps,
} from './project-services.js';

const ACTOR = { type: 'user', id: '0192f1a4-7b3c-7d2e-8f00-00000000aaaa' } as const;
const NOW = new Date('2026-10-04T12:00:00.000Z');
const SHOP = 'shop' as ProjectSlug;

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error('Failed query'), { cause: { code: '23505', constraint } });
}

/** A `db` whose only reachable method is `transaction`; every call runs `impl`. */
function fakeDb(impl: () => Promise<unknown>): { deps: ProjectServicesDeps; transaction: ReturnType<typeof vi.fn> } {
  const transaction = vi.fn(impl);
  const db = { transaction } as unknown as Database;
  return { deps: { db, now: () => NOW }, transaction };
}

describe('pickFreeProjectSlug', () => {
  it('keeps the derived slug when it is free', async () => {
    await expect(pickFreeProjectSlug(SHOP, () => Promise.resolve(false))).resolves.toBe('shop');
  });

  it('appends the first free counter starting at 2', async () => {
    const taken = new Set(['shop', 'shop-2', 'shop-3']);
    await expect(pickFreeProjectSlug(SHOP, (slug) => Promise.resolve(taken.has(slug)))).resolves.toBe(
      'shop-4',
    );
  });

  it('gives up after a bounded number of candidates instead of looping forever', async () => {
    const isTaken = vi.fn(() => Promise.resolve(true));
    await expect(pickFreeProjectSlug(SHOP, isTaken)).rejects.toThrow(/slug/i);
    expect(isTaken.mock.calls.length).toBeLessThanOrEqual(1000);
  });
});

describe('views', () => {
  it('serializes a project row to its allowlisted view with ISO timestamps', () => {
    const view = toProjectView({
      id: 'p1',
      name: 'Shop',
      slug: 'shop',
      description: null,
      archivedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(view).toStrictEqual({
      id: 'p1',
      name: 'Shop',
      slug: 'shop',
      description: null,
      archivedAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it('serializes an environment row to its allowlisted view', () => {
    const view = toEnvironmentView({
      id: 'e1',
      projectId: 'p1',
      name: 'production',
      kind: 'production',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(Object.keys(view).sort()).toEqual(['createdAt', 'id', 'kind', 'name', 'projectId', 'updatedAt']);
  });
});

describe('changedFieldNames', () => {
  it('lists only the fields whose value actually changes', () => {
    expect(changedFieldNames({ name: 'a', description: null }, { name: 'a', description: 'b' })).toEqual([
      'description',
    ]);
    expect(changedFieldNames({ name: 'a' }, { name: 'a' })).toEqual([]);
    expect(changedFieldNames({ name: 'a' }, {})).toEqual([]);
  });
});

describe('createProject', () => {
  it('rejects an invalid name as VALIDATION_FAILED without touching the database', async () => {
    const { deps, transaction } = fakeDb(() => Promise.resolve(undefined));
    const result = await createProject(deps, { actor: ACTOR, name: '   ' });
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a name embedding URL credentials, which activity metadata may never carry', async () => {
    const { deps, transaction } = fakeDb(() => Promise.resolve(undefined));
    const result = await createProject(deps, { actor: ACTOR, name: 'https://user:pw@example.com' });
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('maps a lost name-uniqueness race (unique violation at commit) to PROJECT_NAME_TAKEN, never a throw', async () => {
    const { deps } = fakeDb(() => Promise.reject(uniqueViolation('projects_name_lower_unique_idx')));
    const result = await createProject(deps, { actor: ACTOR, name: 'Shop' });
    expect(result).toMatchObject({ ok: false, code: 'PROJECT_NAME_TAKEN' });
  });

  it('retries the whole transaction when it loses a slug race', async () => {
    let calls = 0;
    const { deps, transaction } = fakeDb(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(uniqueViolation('projects_slug_unique_idx'));
      return Promise.resolve({ ok: false, code: 'PROJECT_NAME_TAKEN', message: 'taken' });
    });
    const result = await createProject(deps, { actor: ACTOR, name: 'Shop' });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, code: 'PROJECT_NAME_TAKEN' });
  });

  it('rethrows an unrelated database error (the global handler turns it into an opaque 500)', async () => {
    const { deps } = fakeDb(() => Promise.reject(new Error('connection reset')));
    await expect(createProject(deps, { actor: ACTOR, name: 'Shop' })).rejects.toThrow('connection reset');
  });
});

describe('updateProject', () => {
  it('rejects an empty edit as VALIDATION_FAILED', async () => {
    const { deps, transaction } = fakeDb(() => Promise.resolve(undefined));
    const result = await updateProject(deps, { actor: ACTOR, projectId: 'p1' });
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('maps a rename race to PROJECT_NAME_TAKEN', async () => {
    const { deps } = fakeDb(() => Promise.reject(uniqueViolation('projects_name_lower_unique_idx')));
    const result = await updateProject(deps, { actor: ACTOR, projectId: 'p1', name: 'Shop' });
    expect(result).toMatchObject({ ok: false, code: 'PROJECT_NAME_TAKEN' });
  });
});

describe('createEnvironment', () => {
  it('rejects a non-slug name as VALIDATION_FAILED', async () => {
    const { deps, transaction } = fakeDb(() => Promise.resolve(undefined));
    const result = await createEnvironment(deps, { actor: ACTOR, projectId: 'p1', name: 'Production!' });
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a non-slug kind as VALIDATION_FAILED', async () => {
    const { deps } = fakeDb(() => Promise.resolve(undefined));
    const result = await createEnvironment(deps, {
      actor: ACTOR,
      projectId: 'p1',
      name: 'production',
      kind: 'Prod Env',
    });
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('maps a lost per-project name race to ENVIRONMENT_NAME_TAKEN', async () => {
    const { deps } = fakeDb(() =>
      Promise.reject(uniqueViolation('environments_project_name_lower_unique_idx')),
    );
    const result = await createEnvironment(deps, { actor: ACTOR, projectId: 'p1', name: 'production' });
    expect(result).toMatchObject({ ok: false, code: 'ENVIRONMENT_NAME_TAKEN' });
  });
});
