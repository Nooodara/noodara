// 10-04-PLAN.md Task 1: the public-site review matrix's own paths and static-serving rules,
// pinned before the capture script (Task 2) exists.
//
// SITE_PAGES/SITE_REVIEW_ROOT/siteReviewPngPath mirror scripts/ui/review-paths.ts's own SCREENS/
// REVIEW_ROOT/reviewPngPath shape (08-01 precedent) so the site capture script and any future
// pin test agree on where a capture lives without duplicating the string. static-site-server.ts's
// resolveStaticPath/isThirdPartyRequest are pure enough to test directly against a temp dir and
// literal URLs -- no real server needs to be running for this file.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SITE_PAGES, SITE_REVIEW_ROOT, siteReviewPngPath } from '../../../scripts/ui/review-paths.js';
import { isThirdPartyRequest, resolveStaticPath } from '../../../scripts/ui/static-site-server.js';

describe('SITE_PAGES', () => {
  it('holds exactly the six site surfaces, in capture order', () => {
    expect(SITE_PAGES.map((p) => [p.id, p.path])).toEqual([
      ['landing', '/'],
      ['docs-install', '/docs/getting-started/install'],
      ['docs-first-server', '/docs/getting-started/first-server'],
      ['docs-concept-server', '/docs/concepts/server'],
      ['docs-scope', '/docs/reference/scope'],
      ['not-found', '/this-page-does-not-exist'],
    ]);
  });
});

describe('SITE_REVIEW_ROOT', () => {
  it('is absolute and ends with docs/ui/review/site', () => {
    expect(path.isAbsolute(SITE_REVIEW_ROOT)).toBe(true);
    expect(SITE_REVIEW_ROOT.endsWith(path.join('docs', 'ui', 'review', 'site'))).toBe(true);
  });
});

describe('siteReviewPngPath', () => {
  it('places a site capture at <site review root>/<surface>-<theme>-<width>.png', () => {
    expect(siteReviewPngPath('landing', 'dark', 375)).toBe(path.join(SITE_REVIEW_ROOT, 'landing-dark-375.png'));
  });

  it('accepts the landing-reduced-motion surface', () => {
    expect(siteReviewPngPath('landing-reduced-motion', 'light', 1280)).toBe(
      path.join(SITE_REVIEW_ROOT, 'landing-reduced-motion-light-1280.png'),
    );
  });
});

describe('resolveStaticPath', () => {
  const dirs: string[] = [];

  function makeOutDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'noodara-site-review-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps '/' to <outDir>/index.html", () => {
    const outDir = makeOutDir();
    writeFileSync(path.join(outDir, 'index.html'), '<html></html>');
    expect(resolveStaticPath(outDir, '/')).toBe(path.join(outDir, 'index.html'));
  });

  it('maps a docs path to <p>.html when that file exists', () => {
    const outDir = makeOutDir();
    mkdirSync(path.join(outDir, 'docs', 'getting-started'), { recursive: true });
    writeFileSync(path.join(outDir, 'docs', 'getting-started', 'install.html'), '<html></html>');
    expect(resolveStaticPath(outDir, '/docs/getting-started/install')).toBe(
      path.join(outDir, 'docs', 'getting-started', 'install.html'),
    );
  });

  it('serves an exact asset file directly', () => {
    const outDir = makeOutDir();
    mkdirSync(path.join(outDir, '_next', 'static'), { recursive: true });
    writeFileSync(path.join(outDir, '_next', 'static', 'x.css'), 'body{}');
    expect(resolveStaticPath(outDir, '/_next/static/x.css')).toBe(path.join(outDir, '_next', 'static', 'x.css'));
  });

  it('rejects a path escaping outDir', () => {
    const outDir = makeOutDir();
    expect(resolveStaticPath(outDir, '/../../etc/passwd')).toBeNull();
  });

  it('rejects a traversal reintroduced by normalize (an interior "../" segment), WR-02', () => {
    // path.normalize('foo/../../etc/passwd') -> '../etc/passwd', which is not a *leading* run of
    // '../' before normalize runs -- the real security boundary here is the path.relative(outDir,
    // candidate) check below, not any regex strip, so this must reject regardless of which of the
    // two runs first.
    const outDir = makeOutDir();
    expect(resolveStaticPath(outDir, '/foo/../../etc/passwd')).toBeNull();
  });

  it('returns null for a genuinely missing path', () => {
    const outDir = makeOutDir();
    expect(resolveStaticPath(outDir, '/missing')).toBeNull();
  });

  it('falls back to <p>/index.html when present', () => {
    const outDir = makeOutDir();
    mkdirSync(path.join(outDir, 'docs'), { recursive: true });
    writeFileSync(path.join(outDir, 'docs', 'index.html'), '<html></html>');
    expect(resolveStaticPath(outDir, '/docs')).toBe(path.join(outDir, 'docs', 'index.html'));
  });
});

describe('isThirdPartyRequest', () => {
  const allowedOrigin = 'http://127.0.0.1:5123';

  it('treats a same-origin request as first-party', () => {
    expect(isThirdPartyRequest('http://127.0.0.1:5123/_next/x.js', allowedOrigin)).toBe(false);
  });

  it('treats a different origin as third-party', () => {
    expect(isThirdPartyRequest('https://fonts.googleapis.com/css', allowedOrigin)).toBe(true);
  });

  it('always allows data: URLs', () => {
    expect(isThirdPartyRequest('data:image/png;base64,xx', allowedOrigin)).toBe(false);
  });

  it('always allows blob: URLs', () => {
    expect(isThirdPartyRequest('blob:http://127.0.0.1:5123/abc-def', allowedOrigin)).toBe(false);
  });
});
