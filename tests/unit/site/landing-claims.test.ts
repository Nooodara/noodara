// 10-06-PLAN.md Task 2 (SITE-01, T-10-04): anchors apps/site/src/content/scope.ts -- the ONE
// typed source of claimed capabilities and stated limits the landing, the Scope page and the
// in-context notes all render from -- to PROJECT.md's own "Out of Scope" text, so the site can
// never claim more than PROJECT.md itself scopes out, and every claim is backed by a real,
// on-disk evidence file. RED: written before apps/site/src/content/scope.ts exists.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findForbiddenWording } from '../../../apps/site/src/lib/content-rules';
import { DELIVERED_CAPABILITIES, findExcludedTerms, SCOPE_EXCLUSIONS } from '../../../apps/site/src/content/scope';

function readProjectMd(): string {
  return readFileSync('.planning/PROJECT.md', 'utf8');
}

function readOutOfScopeSection(): string {
  const text = readProjectMd();
  const match = text.match(/### Out of Scope\n([\s\S]*?)\n## /);
  expect(match, '"### Out of Scope" section not found in PROJECT.md').toBeTruthy();
  return match?.[1] ?? '';
}

function readFueraDeV02Line(): string {
  const text = readProjectMd();
  const match = text.match(/^\*\*Fuera de v0\.2:\*\*.*$/m);
  expect(match, '"**Fuera de v0.2:**" line not found in PROJECT.md').toBeTruthy();
  return match?.[0] ?? '';
}

describe('SCOPE_EXCLUSIONS anchored to PROJECT.md', () => {
  const outOfScope = readOutOfScopeSection();
  const fueraDeV02 = readFueraDeV02Line();

  it('every projectAnchor occurs verbatim in the Out of Scope section or the Fuera de v0.2 line', () => {
    for (const exclusion of SCOPE_EXCLUSIONS) {
      const found = outOfScope.includes(exclusion.projectAnchor) || fueraDeV02.includes(exclusion.projectAnchor);
      expect(found, `"${exclusion.id}".projectAnchor "${exclusion.projectAnchor}" not found in PROJECT.md`).toBe(true);
    }
  });

  it('includes the landing-visible D-03/D-09 exclusion ids', () => {
    const showOnLandingIds = SCOPE_EXCLUSIONS.filter((e) => e.showOnLanding).map((e) => e.id);
    for (const id of ['app-config', 'domains-tls', 'advanced-deploy', 'multi-user', 'deploy-services']) {
      expect(showOnLandingIds).toContain(id);
    }
  });

  it('every exclusion statement starts with "Noodara", is present tense, and has no forbidden wording', () => {
    for (const exclusion of SCOPE_EXCLUSIONS) {
      expect(exclusion.statement.startsWith('Noodara'), `"${exclusion.id}" statement must start with "Noodara"`).toBe(true);
      expect(exclusion.statement, `"${exclusion.id}" statement must not use future tense "will"`).not.toMatch(/\bwill\b/i);
      expect(findForbiddenWording(exclusion.statement), `"${exclusion.id}" statement has forbidden wording`).toEqual([]);
    }
  });
});

describe('DELIVERED_CAPABILITIES backed by real evidence', () => {
  it('every capability has at least one evidence path, and every evidence path exists on disk', () => {
    for (const capability of DELIVERED_CAPABILITIES) {
      expect(capability.evidence.length, `"${capability.id}" has no evidence`).toBeGreaterThan(0);
      for (const evidencePath of capability.evidence) {
        expect(existsSync(evidencePath), `"${capability.id}" evidence "${evidencePath}" does not exist on disk`).toBe(true);
      }
    }
  });

  it('no delivered claim uses an excluded term', () => {
    for (const capability of DELIVERED_CAPABILITIES) {
      expect(findExcludedTerms(capability.claim), `"${capability.id}" claim "${capability.claim}" hits an excluded term`).toEqual([]);
    }
  });
});

describe('findExcludedTerms', () => {
  it('flags a claim that names both an excluded deploy feature and an excluded domains/TLS feature', () => {
    const findings = findExcludedTerms('Deploy apps with automatic HTTPS');
    const ids = new Set(findings.map((f) => f.exclusionId));
    expect(ids).toContain('deploy-services');
    expect(ids).toContain('domains-tls');
  });

  it('does not match the short all-caps term "AI" inside a longer word like "AIX"', () => {
    expect(findExcludedTerms('Built for AIX servers')).toEqual([]);
  });
});

describe('scope.ts ids are unique', () => {
  it('has no id collision across DELIVERED_CAPABILITIES and SCOPE_EXCLUSIONS', () => {
    const ids = [...DELIVERED_CAPABILITIES.map((c) => c.id), ...SCOPE_EXCLUSIONS.map((e) => e.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
