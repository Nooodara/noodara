// D-29/T-4-07: CSRF-lite defense for a same-origin-by-construction topology (the fase 5 web app
// proxies `/api/*`; this app never registers a cross-origin-resource-sharing plugin). A mutating
// request carrying a present but foreign `Origin` header is rejected before any route handler
// runs; an absent `Origin` is allowed, which is how `app.inject` and non-browser clients (the
// worker's own future CLI, curl) call this API. `GET`/`HEAD`/`OPTIONS` are never checked — the
// check is meaningless for a read.
import type { onRequestHookHandler } from 'fastify';
import { toErrorBody } from '../routes/http-errors.js';

export interface CreateOriginGuardOptions {
  /** The control plane's own public URL (`NOODARA_PUBLIC_URL`) — the caller passes this in
   *  explicitly rather than this module reading `env` directly, so the unit tests need no env
   *  manipulation. */
  readonly publicUrl: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const FORBIDDEN_ORIGIN_MESSAGE = 'Request origin is not allowed';

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createOriginGuard(options: CreateOriginGuardOptions): onRequestHookHandler {
  // Computed once, at factory time: the expected origin never changes for the lifetime of the
  // process, and re-parsing `options.publicUrl` on every request would be wasted work.
  const expectedOrigin = new URL(options.publicUrl).origin;

  // `onRequestHookHandler` is Fastify's synchronous, `done`-callback-style hook signature (as
  // opposed to `onRequestAsyncHookHandler`'s 2-arg/`Promise`-returning shape) — short-circuiting
  // a request here follows Fastify's own documented pattern for this style: call `reply.send()`
  // and `return` without ever invoking `done`, which stops the hook chain without a duplicate
  // "hook already resolved" warning that an unawaited async `.send()` inside this shape risks.
  const originGuard: onRequestHookHandler = function originGuard(request, reply, done) {
    if (SAFE_METHODS.has(request.method)) {
      done();
      return;
    }

    const rawOrigin = firstHeaderValue(request.headers.origin);
    if (rawOrigin === undefined) {
      done();
      return;
    }

    let actualOrigin: string;
    try {
      actualOrigin = new URL(rawOrigin).origin;
    } catch {
      void reply.code(403).send(toErrorBody('FORBIDDEN_ORIGIN', FORBIDDEN_ORIGIN_MESSAGE));
      return;
    }

    // Strict equality on the parsed origin only — never a prefix or substring comparison, which
    // a subdomain-suffix spoof like `https://app.example.evil.com` would otherwise satisfy.
    if (actualOrigin !== expectedOrigin) {
      void reply.code(403).send(toErrorBody('FORBIDDEN_ORIGIN', FORBIDDEN_ORIGIN_MESSAGE));
      return;
    }

    done();
  };

  return originGuard;
}
