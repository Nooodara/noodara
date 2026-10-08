// 14-24: host-key.spec.ts pinned its sshd fixtures to 42_544/42_545, inside Linux's ephemeral
// range (32768-60999). On the CI runner a long-lived client socket held 42_544 through all five
// port-binding retries ("failed to bind host port for 0.0.0.0:42544 ... address already in use",
// nightly 37741127947 attempt 1); macOS's range starts at 49152, so it never showed locally.
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXED_HOST_PORT_RANGE, isPortFree, pickFixedHostPort } from './fixed-host-port.js';

const LINUX_EPHEMERAL_MIN = 32_768;
const BSD_EPHEMERAL_MIN = 49_152;

let held: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (held ? held.close(() => resolve()) : resolve()));
  held = undefined;
});

describe('pickFixedHostPort', () => {
  it('keeps its whole range below every common ephemeral range', () => {
    expect(FIXED_HOST_PORT_RANGE.max).toBeLessThan(LINUX_EPHEMERAL_MIN);
    expect(FIXED_HOST_PORT_RANGE.max).toBeLessThan(BSD_EPHEMERAL_MIN);
    expect(FIXED_HOST_PORT_RANGE.min).toBeGreaterThan(1024);
  });

  it('returns a port inside the range that is free to bind', async () => {
    const port = await pickFixedHostPort();

    expect(port).toBeGreaterThanOrEqual(FIXED_HOST_PORT_RANGE.min);
    expect(port).toBeLessThanOrEqual(FIXED_HOST_PORT_RANGE.max);
    expect(await isPortFree(port)).toBe(true);
  });

  it('skips a candidate that is already bound', async () => {
    const taken = FIXED_HOST_PORT_RANGE.min;
    held = createServer();
    await new Promise<void>((resolve) => held?.listen({ port: taken, host: '0.0.0.0', exclusive: true }, resolve));
    const candidates = [taken, taken + 1];

    const port = await pickFixedHostPort({ nextCandidate: () => candidates.shift() ?? taken + 2 });

    expect(await isPortFree(taken)).toBe(false);
    expect(port).toBe(taken + 1);
  });

  it('fails loudly when no free candidate turns up within its attempts', async () => {
    await expect(pickFixedHostPort({ attempts: 3, isFree: () => Promise.resolve(false) })).rejects.toThrow(
      /no free host port/,
    );
  });
});
