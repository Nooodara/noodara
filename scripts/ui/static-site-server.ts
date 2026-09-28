// 10-04-PLAN.md Task 1: a local static server over `apps/site/out` for the site review capture
// (Task 2) -- and a runtime check for D-16 (zero third-party requests) at the same time.
//
// WHY A HAND-ROLLED SERVER. The static export in `apps/site/out` already mimics GitHub Pages'
// own resolution rules (extensionless routes served from `<path>.html`, `next.config.mjs`'s own
// `trailingSlash: false`), so serving it correctly means reproducing that resolution locally
// rather than reaching for a generic static-file server that would not match production
// behaviour. `resolveStaticPath` is the one function both this server and its own tests exercise
// directly (T-10-18): it rejects any path that would escape `outDir` before ever touching the
// filesystem.
//
// 127.0.0.1 ONLY, EPHEMERAL PORT. `startStaticSiteServer` never binds `0.0.0.0` and never takes a
// fixed port -- the OS assigns one (`listen(0, '127.0.0.1')`), so this can never collide with a
// real dev server and is never reachable from outside the machine running the capture.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** An explicit timeout on every request this server accepts (CLAUDE.md §2.3: "Timeouts explícitos
 *  en toda operación remota"; this is local-only, but the discipline is the same). */
const REQUEST_TIMEOUT_MS = 10_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
}

/**
 * Maps a request URL path to a real file under `outDir`, mirroring GitHub Pages' own resolution
 * of a Next.js static export (`output: 'export'`, `trailingSlash: false`): an exact file first,
 * then `<path>.html`, then `<path>/index.html`. Returns `null` if none exist, or if the decoded,
 * normalised path would resolve outside `outDir` (T-10-18) -- the caller serves `404.html` with
 * status 404 in either case, so a path-traversal attempt and a genuine miss look identical to the
 * client.
 */
export function resolveStaticPath(outDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }

  const normalised = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '/');
  const relative = normalised.replace(/^[/\\]+/, '');

  const candidates =
    relative === ''
      ? [path.join(outDir, 'index.html')]
      : [path.join(outDir, relative), path.join(outDir, `${relative}.html`), path.join(outDir, relative, 'index.html')];

  for (const candidate of candidates) {
    const rel = path.relative(outDir, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }
    if (isRegularFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** A synchronous existence+regular-file check, kept to the candidate-resolution loop above (it
 *  runs at most three `stat`s per request, over local disk, never over the network). */
function isRegularFile(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Classifies a URL a captured page requested as first-party (same origin as `allowedOrigin`, or a
 * `data:`/`blob:` URL a page can only have produced from its own already-loaded bytes) or
 * third-party (D-16: the capture run fails on any of these).
 */
export function isThirdPartyRequest(url: string, allowedOrigin: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return false;
  }
  try {
    return new URL(url).origin !== new URL(allowedOrigin).origin;
  } catch {
    return true;
  }
}

export interface StaticSiteServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

async function serve(outDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = req.url ?? '/';
  const filePath = resolveStaticPath(outDir, urlPath);

  if (filePath === null) {
    const notFoundPath = path.join(outDir, '404.html');
    try {
      const body = await readFile(notFoundPath);
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
    return;
  }

  const body = await readFile(filePath);
  res.writeHead(200, { 'content-type': contentTypeFor(filePath) });
  res.end(body);
}

/** Starts a local static server over `outDir` on `127.0.0.1`, an OS-assigned ephemeral port.
 *  Resolves once listening, with `{ origin, close }` -- `close()` returns a promise so the
 *  caller can `await` a clean shutdown before the process exits. */
export async function startStaticSiteServer(outDir: string): Promise<StaticSiteServer> {
  const server: Server = createServer((req, res) => {
    serve(outDir, req, res).catch(() => {
      res.writeHead(500);
      res.end('Internal error');
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('static-site-server: failed to determine the listening port');
  }

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
