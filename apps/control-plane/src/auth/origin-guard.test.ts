import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createOriginGuard } from './origin-guard.js';

// D-29/T-4-07: `createOriginGuard` is a plain `onRequestHookHandler`, not a whole plugin, so this
// suite registers it directly on one bare `Fastify()` instance shared by every probe route (no
// encapsulation concerns to work around, unlike `require-session.test.ts`).
function buildTestApp(publicUrl: string) {
  const app = Fastify();
  app.addHook('onRequest', createOriginGuard({ publicUrl }));
  app.get('/probe', () => Promise.resolve({ ok: true as const }));
  app.post('/probe', () => Promise.resolve({ ok: true as const }));
  app.patch('/probe', () => Promise.resolve({ ok: true as const }));
  app.delete('/probe', () => Promise.resolve({ ok: true as const }));
  return app;
}

const PUBLIC_URL = 'https://app.example';

describe('createOriginGuard', () => {
  it('allows a POST with no Origin header (app.inject / non-browser clients)', async () => {
    const app = buildTestApp(PUBLIC_URL);

    const response = await app.inject({ method: 'POST', url: '/probe' });

    expect(response.statusCode).toBe(200);
  });

  it('allows a POST with an Origin exactly equal to the configured public origin', async () => {
    const app = buildTestApp(PUBLIC_URL);

    const response = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { origin: 'https://app.example' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects a POST with a foreign Origin, 403 with the exact D-16 body, handler never runs', async () => {
    const app = buildTestApp(PUBLIC_URL);

    const response = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: 'FORBIDDEN_ORIGIN',
      message: 'Request origin is not allowed',
    });
  });

  it.each(['PATCH', 'DELETE'] as const)(
    'rejects a %s with a foreign Origin the same way POST does',
    async (method) => {
      const app = buildTestApp(PUBLIC_URL);

      const response = await app.inject({
        method,
        url: '/probe',
        headers: { origin: 'https://evil.example' },
      });

      expect(response.statusCode).toBe(403);
    },
  );

  it('allows a GET with a mismatched Origin (the check is meaningless for a read)', async () => {
    const app = buildTestApp(PUBLIC_URL);

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('treats a trailing slash on the Origin as the same origin (parsed scheme+host+port)', async () => {
    const app = buildTestApp(PUBLIC_URL);

    const response = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { origin: 'https://app.example/' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects a scheme mismatch (http vs. https) even though host and port match', async () => {
    const app = buildTestApp(PUBLIC_URL);

    const response = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { origin: 'http://app.example' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a subdomain-suffix spoof (never startsWith/includes matching)', async () => {
    const app = buildTestApp(PUBLIC_URL);

    const response = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { origin: 'https://app.example.evil.com' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a syntactically invalid Origin header value with 403 rather than throwing', async () => {
    const app = buildTestApp(PUBLIC_URL);

    const response = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { origin: 'not a url' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: 'FORBIDDEN_ORIGIN',
      message: 'Request origin is not allowed',
    });
  });
});
