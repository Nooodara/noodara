import { AsyncLocalStorage } from 'node:async_hooks';

// AUTH-01 (D-02): the only way Better Auth's own `/sign-up/email` handler is ever allowed to run
// is when `setup-service.ts` explicitly opens this window around its own internal
// `auth.api.signUpEmail` call. `signup-gate.ts` is the sole reader of `isBootstrapInProgress()`;
// nothing else in this codebase should ever need to touch this flag.
//
// `AsyncLocalStorage` (not a module-level boolean) because the flag must be scoped to the single
// in-flight redemption that opened it — a module-level flag would leak "true" across concurrent
// requests sharing the same process, which is exactly the race this plan's own threat register
// (T-1-34) exists to close.
const bootstrapStorage = new AsyncLocalStorage<true>();

/**
 * Runs `fn` with the bootstrap window open for the duration of its own async call chain. Any
 * `/sign-up/email` request dispatched from inside `fn` (including Better Auth's internal
 * `auth.api.signUpEmail` call, which goes through the same `hooks.before` pipeline as an HTTP
 * request) is let through by `signupGate`; nothing outside `fn`'s continuation ever sees the flag.
 */
export function runInBootstrap<T>(fn: () => Promise<T>): Promise<T> {
  return bootstrapStorage.run(true, fn);
}

/** Reads whether the current async context is inside a `runInBootstrap` call. */
export function isBootstrapInProgress(): boolean {
  return bootstrapStorage.getStore() === true;
}
