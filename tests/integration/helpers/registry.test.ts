import { describe, it, expect, vi } from 'vitest';
import {
  MIRROR_FALLBACK_UPSTREAM,
  MIRROR_UPSTREAM,
  REGISTRY_IMAGE,
  selectMirrorUpstream,
  startWithin,
} from './registry.js';

describe('registry helper (unit)', () => {
  describe('selectMirrorUpstream', () => {
    it('prefers mirror.gcr.io when it answers', async () => {
      const probe = vi.fn(async () => true);
      await expect(selectMirrorUpstream(probe)).resolves.toBe(MIRROR_UPSTREAM);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('falls back to Docker Hub only after probing it', async () => {
      const probe = vi.fn(async (url: string) => url === MIRROR_FALLBACK_UPSTREAM);
      await expect(selectMirrorUpstream(probe)).resolves.toBe(MIRROR_FALLBACK_UPSTREAM);
      expect(probe.mock.calls.map(([url]) => url)).toEqual([
        MIRROR_UPSTREAM,
        MIRROR_FALLBACK_UPSTREAM,
      ]);
    });

    it('fails fast naming both registries when neither answers', async () => {
      const error = await selectMirrorUpstream(async () => false).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(MIRROR_UPSTREAM);
      expect((error as Error).message).toContain(MIRROR_FALLBACK_UPSTREAM);
      expect((error as Error).message).toMatch(/unreachable/);
    });
  });

  describe('startWithin', () => {
    it('returns the started value when it beats the deadline', async () => {
      const container = { stop: vi.fn(async () => undefined) };
      await expect(startWithin(async () => container, 1_000, 'docker.io')).resolves.toBe(container);
      expect(container.stop).not.toHaveBeenCalled();
    });

    it('rejects at the deadline naming the image and the registry it is pulled from', async () => {
      vi.useFakeTimers();
      try {
        const pending = startWithin(() => new Promise<never>(() => undefined), 5_000, 'docker.io');
        const assertion = expect(pending).rejects.toThrow(
          new RegExp(`${REGISTRY_IMAGE.split('@')[0] ?? ''}.*docker\\.io.*5000ms`),
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops a container that finishes starting after the deadline', async () => {
      vi.useFakeTimers();
      try {
        let resolveLate: (value: { stop: () => Promise<void> }) => void = () => undefined;
        const late = { stop: vi.fn(async () => undefined) };
        const pending = startWithin(
          () =>
            new Promise<{ stop: () => Promise<void> }>((resolve) => {
              resolveLate = resolve;
            }),
          100,
          'docker.io',
        );
        const assertion = expect(pending).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(100);
        await assertion;
        resolveLate(late);
        await vi.advanceTimersByTimeAsync(0);
        expect(late.stop).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('propagates a start failure unchanged', async () => {
      await expect(
        startWithin<{ stop: () => Promise<void> }>(
          async () => Promise.reject(new Error('pull denied')),
          1_000,
          'docker.io',
        ),
      ).rejects.toThrow('pull denied');
    });
  });
});
