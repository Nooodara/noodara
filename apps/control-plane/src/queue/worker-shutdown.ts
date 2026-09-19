// T-4-32: the extracted, unit-tested worker shutdown sequence. `worker.ts`'s previous inline
// `shutdown()` closure raced `handle.close()` against a grace timer but never guarded the
// cleanup steps that followed it — a rejecting `close()` (or a rejecting `queue.close()`) would
// have crashed out of the async function before `stopHeartbeat`/`disconnect` ever ran, leaving
// Redis connections and the heartbeat key dangling after termination. Every step here is
// individually isolated (mirrors `events/sse-broadcaster.ts`'s `closeAll()` — one dead stream's
// `.write()` throw must never stop the others from receiving a message; here, one failing
// cleanup step must never skip the rest), and the injected `exit` — never a direct call into
// Node's own process-termination API — is what makes the whole sequence callable from a plain
// unit test.
export interface WorkerShutdownDeps {
  readonly close: () => Promise<void>;
  readonly graceMs: number;
  readonly stopHeartbeat: () => void;
  readonly closeQueue: () => Promise<void>;
  readonly disconnect: readonly (() => void)[];
  readonly logger: { warn: (obj: unknown, msg: string) => void };
  readonly exit: (code: number) => void;
}

// Keyed by the `deps` object identity, not a single module-level boolean: every production call
// site (worker.ts's SIGTERM and SIGINT handlers) shares one `deps` object built once in `main()`,
// so a second real invocation still correctly no-ops, while a WeakSet lets unrelated `deps`
// objects across separate unit tests never interfere with each other's guard state.
const inFlight = new WeakSet<WorkerShutdownDeps>();

/**
 * Races `close()` against `graceMs`, then always runs `stopHeartbeat`, `closeQueue` and every
 * `disconnect` entry in order, then calls `exit(0)` — regardless of whether `close()` or
 * `closeQueue()` rejected, or any single `disconnect()` threw. Calling this a second time with
 * the same `deps` object (concurrently or after completion) is a no-op.
 */
export async function runWorkerShutdown(deps: WorkerShutdownDeps): Promise<void> {
  if (inFlight.has(deps)) return;
  inFlight.add(deps);

  try {
    await Promise.race([
      deps.close(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, deps.graceMs);
      }),
    ]);
  } catch (err) {
    deps.logger.warn({ err }, 'worker close rejected during shutdown');
  }

  deps.stopHeartbeat();

  try {
    await deps.closeQueue();
  } catch (err) {
    deps.logger.warn({ err }, 'queue close rejected during shutdown');
  }

  for (const disconnect of deps.disconnect) {
    try {
      disconnect();
    } catch (err) {
      deps.logger.warn({ err }, 'connection disconnect failed during shutdown');
    }
  }

  deps.exit(0);
}
