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
