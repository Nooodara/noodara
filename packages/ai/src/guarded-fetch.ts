import type { AIProviderFailureReason } from './errors.js';

// H1: the only fetch a provider SDK gets. It refuses any URL outside the pinned base, caps the
// response size, ends a body that stops sending (idle timeout), honors the call's abort signal
// and always releases the underlying body reader. The failure reason is recorded on `state`
// so the call scope classifies it before looking at whatever the SDK rethrows.

export interface CallState {
  failure: AIProviderFailureReason | undefined;
}

export interface GuardedFetchOptions {
  readonly baseUrl: string;
  readonly maxResponseBytes: number;
  readonly idleTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly state: CallState;
  /** Test seam; defaults to the global fetch looked up at call time (so MSW can patch it). */
  readonly fetchImpl?: typeof fetch | undefined;
}

export class GuardedFetchError extends Error {
  readonly reason: AIProviderFailureReason;
  constructor(reason: AIProviderFailureReason) {
    super(`guarded fetch failed: ${reason}`);
    this.name = 'GuardedFetchError';
    this.reason = reason;
  }
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input instanceof URL ? input.href : input);
}

function isAllowed(url: URL, base: URL): boolean {
  if (url.origin !== base.origin || url.username !== '' || url.password !== '') return false;
  const basePath = base.pathname.replace(/\/+$/, '');
  return basePath === '' || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
}

function abortPromise(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_, reject) => {
    const fail = (): void => {
      reject(new GuardedFetchError('aborted'));
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  promise.catch(() => undefined);
  return promise;
}

function fail(state: CallState, reason: AIProviderFailureReason): GuardedFetchError {
  state.failure ??= reason;
  return new GuardedFetchError(reason);
}

function guardBody(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  options: GuardedFetchOptions,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const aborted = abortPromise(signal);
  let total = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', release, { once: true });

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let idleTimer: NodeJS.Timeout | undefined;
        const idle = new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => {
            reject(new GuardedFetchError('idle_timeout'));
          }, options.idleTimeoutMs);
        });
        idle.catch(() => undefined);
        try {
          if (signal.aborted) throw new GuardedFetchError('aborted');
          const chunk = await Promise.race([reader.read(), idle, aborted]);
          if (chunk.done) {
            released = true;
            controller.close();
            return;
          }
          total += chunk.value.byteLength;
          if (total > options.maxResponseBytes) throw new GuardedFetchError('too_large');
          controller.enqueue(chunk.value);
        } catch (error) {
          const reason = error instanceof GuardedFetchError ? error.reason : 'connection';
          release();
          controller.error(fail(options.state, reason));
        } finally {
          clearTimeout(idleTimer);
        }
      },
      cancel() {
        release();
      },
    },
    { highWaterMark: 0 },
  );
}

export function createGuardedFetch(options: GuardedFetchOptions): typeof fetch {
  const base = new URL(options.baseUrl);
  return async (input, init) => {
    const url = requestUrl(input);
    if (!isAllowed(url, base)) throw fail(options.state, 'host_mismatch');

    const signals = [options.signal];
    if (init?.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    const impl = options.fetchImpl ?? globalThis.fetch;

    let response: Response;
    try {
      response = await Promise.race([impl(input, { ...init, signal }), abortPromise(signal)]);
    } catch (error) {
      throw fail(options.state, error instanceof GuardedFetchError ? error.reason : 'connection');
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > options.maxResponseBytes) {
      // Not awaited: a stalled body must not hold the caller past the refusal.
      response.body?.cancel().catch(() => undefined);
      throw fail(options.state, 'too_large');
    }
    if (response.body === null) return response;
    return new Response(guardBody(response.body, signal, options), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
