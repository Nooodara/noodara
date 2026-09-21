import { afterEach, describe, expect, it, vi } from 'vitest';

// F1 (05-42-PLAN.md, docs/adr/0003 "Local build env defaults for test harnesses"): buildWorkspace()
// previously spawned `pnpm build` with no explicit `env`, so the child inherited whatever the
// developer's ambient shell had -- nothing on a clean checkout, since apps/web/next.config.ts
// fail-fasts without NOODARA_API_ORIGIN (docs/adr/0006). That made `pnpm build`, `pnpm test:boot`
// and `pnpm test:integration` all fail in about two seconds on a clean local shell.
//
// `node:child_process` is mocked so this stays a fast, deterministic unit test asserting on the
// `spawnSync` call's `env` argument, without actually running a real (slow) `pnpm build`.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const { spawnSync } = await import('node:child_process');
const { buildWorkspace } = await import('../../integration/helpers/boot-process.js');

const mockedSpawnSync = vi.mocked(spawnSync);
const ORIGINAL_NOODARA_API_ORIGIN = process.env.NOODARA_API_ORIGIN;

describe('buildWorkspace env (F1)', () => {
  afterEach(() => {
    mockedSpawnSync.mockReset();
    if (ORIGINAL_NOODARA_API_ORIGIN === undefined) {
      delete process.env.NOODARA_API_ORIGIN;
    } else {
      process.env.NOODARA_API_ORIGIN = ORIGINAL_NOODARA_API_ORIGIN;
    }
  });

  it('defaults NOODARA_API_ORIGIN to http://localhost:3100 when the caller has not set one', () => {
    delete process.env.NOODARA_API_ORIGIN;
    mockedSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    buildWorkspace();

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'pnpm',
      ['build'],
      expect.objectContaining({
        env: expect.objectContaining({ NOODARA_API_ORIGIN: 'http://localhost:3100' }),
      }),
    );
  });

  it('honours an already-exported NOODARA_API_ORIGIN instead of overwriting it', () => {
    process.env.NOODARA_API_ORIGIN = 'http://localhost:9999';
    mockedSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    buildWorkspace();

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'pnpm',
      ['build'],
      expect.objectContaining({
        env: expect.objectContaining({ NOODARA_API_ORIGIN: 'http://localhost:9999' }),
      }),
    );
  });

  it('spreads process.env so PATH/HOME are not stripped from the spawned build', () => {
    delete process.env.NOODARA_API_ORIGIN;
    mockedSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);

    buildWorkspace();

    const call = mockedSpawnSync.mock.calls[0];
    const options = call?.[2] as { env?: NodeJS.ProcessEnv } | undefined;

    expect(options?.env?.PATH).toBe(process.env.PATH);
  });
});
