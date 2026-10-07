import { beforeEach, describe, expect, it, vi } from 'vitest';

const end = vi.fn<() => Promise<void>>();
vi.mock('pg', () => ({
  Pool: class {
    on = vi.fn();
    end = end;
  },
}));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('../env.js', () => ({ env: { DATABASE_URL: 'postgres://u:secret@h/db' } }));

describe('closeDb', () => {
  beforeEach(() => {
    vi.resetModules();
    end.mockReset();
    end.mockResolvedValue(undefined);
  });

  it('is a no-op when the client was never created', async () => {
    const { closeDb } = await import('./client.js');
    await closeDb();
    expect(end).not.toHaveBeenCalled();
  });

  it('ends the pool exactly once even when called twice', async () => {
    const { getDb, closeDb } = await import('./client.js');
    await getDb();
    await closeDb();
    await closeDb();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('propagates a pool close error', async () => {
    end.mockRejectedValue(new TypeError('boom secret'));
    const { getDb, closeDb } = await import('./client.js');
    await getDb();
    await expect(closeDb()).rejects.toThrow('boom');
  });
});
