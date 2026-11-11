import { describe, expect, it, vi } from 'vitest';
import { createSshDiagnostics } from '../../integration/helpers/ssh.js';

const secret = 'synthetic-sensitive-value-never-emitted';
const owner = 'e2f41893-1894-49fe-b1b3-2d3417637055';

describe('bounded observational SSH fixture diagnostics', () => {
  it('emits only allowlisted fields with monotonic elapsed time and task ownership', () => {
    const events: unknown[] = [];
    let now = 100;
    const diagnostic = createSshDiagnostics(owner, (event) => { events.push(event); }, () => now);
    diagnostic.record('image_build', 'begin');
    now = 125;
    diagnostic.record('image_build', 'success', new Error(secret));
    now = 115;
    diagnostic.record('container_start', 'failure', new Error(secret));

    expect(events).toEqual([
      { owner, stage: 'image_build', outcome: 'begin', elapsedMs: 0 },
      { owner, stage: 'image_build', outcome: 'success', elapsedMs: 25 },
      { owner, stage: 'container_start', outcome: 'failure', elapsedMs: 25, category: 'operation_failed' },
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it.each(['success', 'failure', 'timeout', 'cancelled'] as const)(
    'never serializes sensitive exception data for %s or cleanup failure', (outcome) => {
      const events: unknown[] = [];
      const diagnostic = createSshDiagnostics(owner, (event) => { events.push(event); });
      diagnostic.record('ssh_readiness', outcome, new Error(secret, { cause: { password: secret } }));
      diagnostic.record('cleanup', 'failure', { cookie: secret, toString: () => secret });
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(events).toHaveLength(2);
    },
  );

  it('isolates throwing and rejected sinks from fixture outcomes', async () => {
    const thrown = createSshDiagnostics(owner, () => { throw new Error(secret); });
    expect(() => thrown.record('cleanup', 'failure', new Error(secret))).not.toThrow();
    const rejected = createSshDiagnostics(owner, () => Promise.reject(new Error(secret)));
    expect(() => rejected.record('cleanup', 'success')).not.toThrow();
    await Promise.resolve();
  });

  it('does not queue events behind a closed or backpressured sink and caps production', () => {
    const sink = vi.fn(() => false);
    const diagnostic = createSshDiagnostics(owner, sink);
    for (let n = 0; n < 10_000; n += 1) diagnostic.record('container_start', 'begin');
    expect(sink).toHaveBeenCalledTimes(1);

    const flowing = vi.fn();
    const bounded = createSshDiagnostics(owner, flowing);
    for (let n = 0; n < 10_000; n += 1) bounded.record('container_start', 'begin');
    expect(flowing).toHaveBeenCalledTimes(64);
  });

  it('drops runtime values outside the stage and outcome allowlist', () => {
    const events: unknown[] = [];
    const diagnostic = createSshDiagnostics(owner, (event) => { events.push(event); });
    // Fault injection at an untyped boundary must not turn a diagnostic field into a leak.
    diagnostic.record(secret as 'image_build', 'success');
    diagnostic.record('cleanup', secret as 'failure');
    expect(events).toEqual([]);
  });

  it('never waits or queues behind a sink promise that does not settle', () => {
    const sink = vi.fn(() => new Promise<void>(() => undefined));
    const diagnostic = createSshDiagnostics(owner, sink);
    for (let n = 0; n < 10_000; n += 1) diagnostic.record('cleanup', 'success');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('refuses unowned identities before any diagnostic emission', () => {
    expect(() => createSshDiagnostics(secret, vi.fn())).toThrow('Invalid SSH fixture owner');
  });
});
