// 14-20: the API's SIGTERM/SIGINT shutdown sequence. PID 1 in the production image is
// `node dist/server.js`; without a handler `docker stop` waits the whole stop_grace_period and
// kills it (exit 137). Mirrors worker.ts's guarded shutdown: `close()` (Fastify: stop accepting,
// drain in-flight requests, end SSE in preClose, close Redis in onClose) is raced against a
// bounded timeout kept below compose's 30 s grace; a second signal or a timeout exits non-zero.
export interface ApiShutdownDeps {
  readonly close: () => Promise<void>;
  /** Extra cleanup (DB pool, ...) that always runs after `close`, even if it failed. */
  readonly afterClose: readonly (() => void | Promise<void>)[];
  readonly timeoutMs: number;
  readonly logger: { warn: (obj: unknown, msg: string) => void };
  readonly exit: (code: number) => void;
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function createApiShutdown(deps: ApiShutdownDeps): () => Promise<void> {
  let shuttingDown = false;
  return async function shutdown(): Promise<void> {
    if (shuttingDown) {
      // Second signal: the operator wants out now.
      deps.exit(1);
      return;
    }
    shuttingDown = true;

    let code = 0;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        deps.close(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('shutdown timed out'));
          }, deps.timeoutMs);
        }),
      ]);
    } catch (err) {
      code = 1;
      deps.logger.warn({ errorClass: errorClass(err) }, 'api close failed during shutdown');
    } finally {
      if (timer) clearTimeout(timer);
    }

    for (const step of deps.afterClose) {
      try {
        await step();
      } catch (err) {
        code = 1;
        deps.logger.warn({ errorClass: errorClass(err) }, 'api cleanup step failed during shutdown');
      }
    }
    deps.exit(code);
  };
}
