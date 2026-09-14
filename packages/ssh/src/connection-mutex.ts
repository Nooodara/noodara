// Per-target connection mutex (02-CONTEXT.md's own discretion note, T-2-35). Not a general-purpose
// lock library: exactly the shape `ssh2-adapter.ts` needs — serialise attempts against the same
// `user@host:port`, release even when the guarded function throws or rejects (so a failed
// connection can never wedge a target permanently), and let two different targets run fully
// concurrently. The global concurrency limit across all targets is deliberately deferred to the
// phase 4 worker.
export interface ConnectionMutex {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createConnectionMutex(): ConnectionMutex {
  const tails = new Map<string, Promise<void>>();

  function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = tails.get(key) ?? Promise.resolve();
    const result = previousTail.then(fn, fn);

    // The chain entry always settles (never rejects), purely so the *next* acquisition for this
    // key can await it regardless of this run's own outcome — `fn`'s rejection still propagates
    // to this call's own caller via `result` above, untouched.
    const chainTail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, chainTail);
    void chainTail.finally(() => {
      if (tails.get(key) === chainTail) {
        tails.delete(key);
      }
    });

    return result;
  }

  return { runExclusive };
}
