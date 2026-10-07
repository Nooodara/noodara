// WR-A-04 (05-34): `server.ts`'s `app.listen(...)` error callback used to log a bare `Error` as
// pino's first argument (`app.log.error(err)`). Verified experimentally against this repo's own
// pino config: when an `Error` is the first argument, pino wraps it as `{ err }` for the
// *serializer* but independently copies `err.message` into the record's own `msg` field -- the
// raw message leaves even though `logger.ts`'s custom `err` serializer (T-4-10/T-4-38) ran and
// stripped `message`/`stack` from the `err` object itself.
//
// `server.ts` cannot be unit-imported to exercise this directly: it is a self-executing entrypoint
// script (`void main()` runs at module-load time, requiring a real Postgres connection and a
// fully valid `env.ts` before it ever reaches the `app.listen` line under test) -- this is why no
// `server.test.ts` existed before this plan, and why `worker.ts`'s equivalent gate (05-34 Task 3)
// is proven via a spawned child process in `tests/integration/boot/`, not a unit import. This test
// instead pins the exact call shape `server.ts`'s callback uses against the real, unmodified
// `createLogger()` every production log line in this app goes through -- the same class of
// standalone reproduction 05-REVIEW.md itself used to confirm WR-A-04. The static acceptance
// checks (`grep -n "app.log.error(err)"` finds no match; `grep -n "app.log.error({ err"` does) are
// the direct proof `server.ts` itself was changed to the shape asserted safe here.
//
// 05-43 closed the residual WR-A-04 left in 05-VERIFICATION.md's `gaps_remaining`: `logger.ts`
// now carries a `hooks.logMethod` interceptor that rewrites ANY bare Error first argument into
// `{ err }` plus a literal fallback message, at every log level, for every call site -- not just
// the one `server.ts` call site this file was written to pin. The first test below is updated
// accordingly: a bare Error no longer leaks even without the `{ err }` call-site shape, because
// the guard is now structural rather than per-call-site.
import { describe, expect, it } from 'vitest';
import { createApiShutdown, type ApiShutdownDeps } from './boot/api-shutdown.js';
import { createLogger, writableForTests } from './logger.js';

describe('server.ts app.listen() failure logging shape (WR-A-04)', () => {
  it('a bare Error as the first argument no longer leaks its raw message into msg (guarded by 05-43\'s hooks.logMethod)', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });
    const secretMessage = 'listen EADDRINUSE CANARY-SECRET-DO-NOT-LEAK :3100';

    logger.error(new Error(secretMessage));

    const serialized = JSON.stringify(records());
    expect(serialized).not.toContain(secretMessage);
    const [record] = records() as unknown as [{ err: { name: string }; msg: string }];
    expect(record.err.name).toBe('Error');
    expect(record.msg).toBe('error logged without a message');
  });

  it('the { err } merging-object form keeps the raw message out of the record (the shape server.ts now uses)', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });
    const secretMessage = 'listen EADDRINUSE CANARY-SECRET-DO-NOT-LEAK :3100';

    logger.error({ err: new Error(secretMessage) }, 'listen failed');

    const serialized = JSON.stringify(records());
    expect(serialized).not.toContain(secretMessage);
    const [record] = records() as unknown as [{ err: { name: string }; msg: string }];
    expect(record.err.name).toBe('Error');
    expect(record.msg).toBe('listen failed');
  });
});

describe('api graceful shutdown (14-20)', () => {
  function setup(overrides: { close?: () => Promise<void>; timeoutMs?: number } = {}) {
    const calls: string[] = [];
    const warnings: unknown[] = [];
    const exits: number[] = [];
    const deps: ApiShutdownDeps = {
      close: overrides.close ?? (() => {
        calls.push('close');
        return Promise.resolve();
      }),
      afterClose: [() => { calls.push('afterClose'); }],
      timeoutMs: overrides.timeoutMs ?? 50,
      logger: { warn: (obj) => { warnings.push(obj); } },
      exit: (code) => { exits.push(code); },
    };
    return { deps, calls, warnings, exits };
  }

  it('closes the app, then the after-close steps, then exits 0', async () => {
    const { deps, calls, exits } = setup();
    const shutdown = createApiShutdown(deps);
    await shutdown();
    expect(calls).toEqual(['close', 'afterClose']);
    expect(exits).toEqual([0]);
  });

  it('a second signal while shutting down exits non-zero without a second close', async () => {
    let release: () => void = () => undefined;
    const closes: string[] = [];
    const { deps, exits } = setup({
      close: () => {
        closes.push('close');
        return new Promise<void>((resolve) => { release = resolve; });
      },
      timeoutMs: 1000,
    });
    const shutdown = createApiShutdown(deps);
    const first = shutdown();
    await shutdown();
    expect(exits).toEqual([1]);
    release();
    await first;
    expect(closes).toHaveLength(1);
  });

  it('a close that exceeds the bounded timeout exits non-zero', async () => {
    const { deps, exits } = setup({ close: () => new Promise<void>(() => undefined), timeoutMs: 20 });
    await createApiShutdown(deps)();
    expect(exits).toEqual([1]);
  });

  it('logs a close error by class only and still exits', async () => {
    const { deps, warnings, exits, calls } = setup({
      close: () => Promise.reject(new TypeError('CANARY-SECRET postgres://u:p@h/db')),
    });
    await createApiShutdown(deps)();
    expect(JSON.stringify(warnings)).not.toContain('CANARY-SECRET');
    expect(warnings).toEqual([{ errorClass: 'TypeError' }]);
    expect(calls).toEqual(['afterClose']);
    expect(exits).toEqual([1]);
  });
});
