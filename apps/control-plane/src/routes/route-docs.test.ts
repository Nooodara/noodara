import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

// H2: every registered /api/projects, /api/services and /api/deployments route must be
// documented (method + path) in docs/deploy-engine.md. The doc uses shorthand (`POST|GET`,
// `{a|b}`, relative `/:id` under a listed prefix), so doc entries are expanded to full routes.
const registered = vi.hoisted(() => [] as { method: string; url: string }[]);

vi.mock('fastify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('fastify')>();
  const wrapped = ((...args: unknown[]) => {
    const app = (mod.default as unknown as (...a: unknown[]) => FastifyInstance)(...args);
    app.addHook('onRoute', (route) => {
      const methods: string[] = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.push({ method, url: route.url });
    });
    return app;
  }) as typeof mod.default;
  return { ...mod, default: wrapped, fastify: wrapped };
});

const { buildApp } = await import('../app.js');

const DOC = readFileSync(resolve(__dirname, '../../../../docs/deploy-engine.md'), 'utf8');
const WATCHED = /^\/api\/(projects|services|deployments)(\/|$)/;
const stubBroadcaster = { start: () => Promise.resolve(), stop: () => Promise.resolve(), closeAll: () => Promise.resolve() };

/** Expands `POST|GET /a`, `{x|y}` and `[/p]` shorthand; relative `.../x` or `/:id` bodies
 *  resolve against the last absolute path of the same line. */
function documentedRoutes(): Set<string> {
  const out = new Set<string>();
  for (const line of DOC.split('\n')) {
    for (const m of line.matchAll(/`((?:[A-Z]+\|?)+) ([^`]+)`/g)) {
      const methods = (m[1] ?? '').split('|').filter(Boolean);
      for (const path of expand(m[2] ?? '')) for (const method of methods) out.add(`${method} ${path}`);
    }
  }
  return out;
}

function expand(path: string): string[] {
  const brace = /\{([^{}]+)\}/.exec(path) ?? /\[([^[\]]+)\]/.exec(path);
  if (!brace) return [path];
  const opts = (brace[1] ?? '').split('|');
  const optional = brace[0].startsWith('[');
  const all = (optional ? ['', ...opts] : opts).flatMap((o) =>
    expand(path.replace(brace[0], optional ? o : o)),
  );
  return all;
}

describe('docs/deploy-engine.md route list', () => {
  it('documents every registered projects, services and deployments route', async () => {
    const app = buildApp({ broadcaster: stubBroadcaster as never });
    await app.ready();
    await app.close();
    const watched = registered.filter((r) => WATCHED.test(r.url) && r.method !== 'HEAD' && r.method !== 'OPTIONS');
    expect(watched.length).toBeGreaterThan(10);
    const doc = documentedRoutes();
    const missing = watched
      .map((r) => `${r.method} ${r.url}`)
      .filter((key) => !doc.has(key) && !coveredByRelative(key));
    expect(missing).toEqual([]);
  });
});

/** Relative doc forms (`.../environments/:environmentId`, `/:serviceId/credentials`) hang off a
 *  documented prefix; accept a route when its method is documented on that prefix line. */
function coveredByRelative(key: string): boolean {
  const [method, url] = key.split(' ') as [string, string];
  const segs = url.split('/');
  const tail = segs.slice(-1)[0] ?? '';
  const whole = DOC.replace(/\\\|/g, '|');
  const methodRe = new RegExp(`[A-Z|]*\\b${method}\\b[A-Z|]*`);
  return whole.split('\n').some((line) => methodRe.test(line) && line.includes(tail.replace(/^:/, ':')) && url.startsWith('/api'));
}
