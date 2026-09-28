// 10-07-PLAN.md Task 1 (D-14/D-16/SITE-01, T-10-05/T-10-03/T-10-21): fixture-only tests for the
// pure detection functions check-export.mjs's CLI wraps -- never touches a real `out/` directory
// (that is the CLI's own job, proven by a real `pnpm --filter @noodara/site build` in Task 2's
// verify step, not by this unit suite). Mirrors scripts/check-ui-safety.mjs's own "scan function
// separate from the CLI/test caller" shape (10-06-SUMMARY.md's own pattern note).

import { describe, expect, it } from 'vitest';
import {
  findFontFaces,
  findLeakedEnvNames,
  findMissingRequiredFiles,
  findThirdPartyAssetUrls,
  REQUIRED_EXPORT_FILES,
} from '../../../apps/site/scripts/check-export.mjs';

describe('findThirdPartyAssetUrls', () => {
  it('flags a third-party <script src>', () => {
    expect(findThirdPartyAssetUrls('<script src="https://cdn.example.com/a.js">')).toHaveLength(1);
  });

  it('flags a third-party stylesheet <link>', () => {
    expect(
      findThirdPartyAssetUrls('<link rel="stylesheet" href="https://fonts.googleapis.com/x">'),
    ).toHaveLength(1);
  });

  it('flags a third-party <img src>', () => {
    expect(findThirdPartyAssetUrls('<img src="http://x.test/a.png">')).toHaveLength(1);
  });

  it('flags a third-party <source srcset>', () => {
    expect(findThirdPartyAssetUrls('<source srcset="https://x.test/a.png 1x">')).toHaveLength(1);
  });

  it('flags a third-party <iframe src>', () => {
    expect(findThirdPartyAssetUrls('<iframe src="https://x.test">')).toHaveLength(1);
  });

  it('flags a third-party CSS url()', () => {
    expect(findThirdPartyAssetUrls('.a{background:url(https://x.test/a.png)}')).toHaveLength(1);
  });

  it('ignores a navigation <a href>, even to a third-party origin', () => {
    expect(findThirdPartyAssetUrls('<a href="https://github.com/nooodara/noodara">')).toEqual([]);
  });

  it('ignores a canonical <link>', () => {
    expect(
      findThirdPartyAssetUrls('<link rel="canonical" href="https://noodara.com/docs">'),
    ).toEqual([]);
  });

  it('ignores an og:image <meta> tag', () => {
    expect(
      findThirdPartyAssetUrls(
        '<meta property="og:image" content="https://noodara.com/opengraph-image.png">',
      ),
    ).toEqual([]);
  });

  it('ignores a same-origin, root-relative <script src>', () => {
    expect(findThirdPartyAssetUrls('<script src="/_next/static/x.js">')).toEqual([]);
  });

  it('ignores a same-origin, root-relative <img src>', () => {
    expect(findThirdPartyAssetUrls('<img src="/screenshots/servers-light.png">')).toEqual([]);
  });
});

describe('findFontFaces', () => {
  it('flags an @font-face declaration', () => {
    expect(findFontFaces('@font-face{font-family:x;src:url(/f.woff2)}')).toHaveLength(1);
  });

  it('returns [] when there is no @font-face declaration', () => {
    expect(findFontFaces('a{color:var(--ink)}')).toEqual([]);
  });
});

describe('findLeakedEnvNames', () => {
  it('flags a secret env assignment', () => {
    expect(findLeakedEnvNames('BETTER_AUTH_SECRET=abc123')).toHaveLength(1);
  });

  it('ignores a documented secret name with no assignment', () => {
    expect(findLeakedEnvNames('`NOODARA_ADMIN_PASSWORD`')).toEqual([]);
  });

  it('ignores a placeholder assignment', () => {
    expect(findLeakedEnvNames('NOODARA_ADMIN_PASSWORD=<password>')).toEqual([]);
  });
});

describe('findMissingRequiredFiles', () => {
  it('accepts an entry matched exactly (the real shape a route handler exports today)', () => {
    expect(findMissingRequiredFiles(new Set(['api/search']), ['api/search'])).toEqual([]);
    expect(findMissingRequiredFiles(new Set(['CNAME']), ['CNAME'])).toEqual([]);
  });

  it('accepts an entry as "<entry>.html"', () => {
    expect(findMissingRequiredFiles(new Set(['api/search.html']), ['api/search'])).toEqual([]);
  });

  it('accepts an entry as "<entry>/index.html"', () => {
    expect(findMissingRequiredFiles(new Set(['api/search/index.html']), ['api/search'])).toEqual([]);
  });

  it('rejects an entry produced deeper than the three known export shapes', () => {
    expect(findMissingRequiredFiles(new Set(['api/search/foo/bar.json']), ['api/search'])).toEqual([
      'api/search',
    ]);
  });

  it('reports every missing entry, in order', () => {
    expect(findMissingRequiredFiles(new Set(['index.html']), ['404.html', 'index.html'])).toEqual([
      '404.html',
    ]);
  });
});

describe('REQUIRED_EXPORT_FILES', () => {
  it('lists the exact set of files every export must contain', () => {
    expect(REQUIRED_EXPORT_FILES).toEqual([
      '404.html',
      'sitemap.xml',
      'robots.txt',
      'api/search',
      'docs.html',
      'index.html',
      '_headers',
    ]);
  });
});
