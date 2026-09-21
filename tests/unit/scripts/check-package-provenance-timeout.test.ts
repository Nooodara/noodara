import { afterEach, describe, expect, it, vi } from 'vitest';

// GR-05 (05-REVIEW.md): WR-C-12's fix text said "Add `timeout: 30_000` to both `execFileSync`
// calls" in scripts/check-package-provenance.mjs, but neither call actually set one — a hung
// `pnpm list` or `npm view` could burn the whole 40-minute CI `security` job budget instead of
// failing that one step promptly with an actionable message (T-5G-42-01/02/03).
//
// `node:child_process` is mocked here (unlike check-package-provenance.test.ts's real-subprocess
// unit tests) specifically to simulate a timeout deterministically and assert on both the
// `execFileSync` call options and the resulting error/fallback behaviour, without waiting 30
// real seconds or depending on network/registry state.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const { execFileSync } = await import('node:child_process');
const { enumerateLockedDependencies, resolvePackageProvenance } = await import(
  '../../../scripts/check-package-provenance.mjs'
);

const mockedExecFileSync = vi.mocked(execFileSync);

describe('check-package-provenance.mjs subprocess timeouts (GR-05)', () => {
  afterEach(() => {
    mockedExecFileSync.mockReset();
    vi.unstubAllGlobals();
  });

  describe('enumerateLockedDependencies (pnpm list -r --depth 0 --json)', () => {
    it('passes a 30_000ms timeout to execFileSync', () => {
      mockedExecFileSync.mockReturnValue('[]');

      enumerateLockedDependencies();

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'pnpm',
        ['list', '-r', '--depth', '0', '--json'],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('rethrows an actionable error naming the command and "timeout" when the call times out, with no fallback', () => {
      const timeoutError = Object.assign(new Error('Command failed'), { code: 'ETIMEDOUT' });
      mockedExecFileSync.mockImplementation(() => {
        throw timeoutError;
      });

      let thrown: unknown;
      try {
        enumerateLockedDependencies();
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('pnpm list -r --depth 0 --json');
      expect((thrown as Error).message.toLowerCase()).toContain('timeout');
    });
  });

  describe('resolvePackageProvenance (npm view <spec> repository.url)', () => {
    it('passes a 30_000ms timeout to execFileSync', async () => {
      mockedExecFileSync.mockReturnValue('git+https://github.com/vitest-dev/vitest.git');

      await resolvePackageProvenance('vitest', '5.0.0');

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'npm',
        ['view', 'vitest@5.0.0', 'repository.url'],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('falls back to the registry API fetch when the npm view call times out, by design', async () => {
      const timeoutError = Object.assign(new Error('Command failed'), { code: 'ETIMEDOUT' });
      mockedExecFileSync.mockImplementation(() => {
        throw timeoutError;
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          versions: { '5.0.0': { repository: { url: 'git+https://github.com/vitest-dev/vitest.git' } } },
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await resolvePackageProvenance('vitest', '5.0.0');

      expect(fetchMock).toHaveBeenCalled();
      expect(result.source).toBe('registry.npmjs.org fetch fallback (locked version)');
      expect(result.repoUrl).toBe('git+https://github.com/vitest-dev/vitest.git');
    });
  });
});
