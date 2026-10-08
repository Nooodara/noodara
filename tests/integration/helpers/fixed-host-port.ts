// A host port for a fixture that must be republished on the SAME host:port (a real host-key
// change: stop sshd A, start a fresh-keyed sshd B where the server record still points). It is
// drawn below every common ephemeral range (Linux 32768-60999, macOS/BSD/Windows 49152+), so no
// kernel-assigned client socket and no Docker random published port can ever sit on it, and it is
// probed free right before use. A hard-coded port inside Linux's range (42_544) was held for the
// whole retry window on the CI runner (14-24).
import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';

/** Disjoint from deploy.spec.ts's own 20_000-29_999 published service ports. */
export const FIXED_HOST_PORT_RANGE = { min: 30_000, max: 32_767 } as const;

/** True when `port` can be bound exclusively on all interfaces right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

export interface PickFixedHostPortOptions {
  readonly attempts?: number;
  /** Injectable for tests; defaults to a random port in `FIXED_HOST_PORT_RANGE`. */
  readonly nextCandidate?: () => number;
  /** Injectable for tests; defaults to `isPortFree`. */
  readonly isFree?: (port: number) => Promise<boolean>;
}

export async function pickFixedHostPort(options: PickFixedHostPortOptions = {}): Promise<number> {
  const attempts = options.attempts ?? 20;
  const nextCandidate =
    options.nextCandidate ?? (() => randomInt(FIXED_HOST_PORT_RANGE.min, FIXED_HOST_PORT_RANGE.max + 1));
  const isFree = options.isFree ?? isPortFree;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = nextCandidate();
    if (await isFree(candidate)) return candidate;
  }
  throw new Error(`no free host port in ${String(FIXED_HOST_PORT_RANGE.min)}-${String(FIXED_HOST_PORT_RANGE.max)} after ${String(attempts)} attempts`);
}
