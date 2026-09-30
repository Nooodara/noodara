// Repository feature probe parser (DEP-08, D-09). The `git.probe_features` template (11-13)
// prints exactly two lines, `submodules=<0|1>` and `lfs=<0|1>`, in any order. The key set is
// closed: any unknown, duplicated or malformed line yields `unparseable`, never `supported`, so
// a crafted repository cannot fake support (T-11-01). Messages are built from the closed
// vocabulary only, never from raw probe output (T-11-02).

import type { CommandOutput } from '../discovery/docker-version.js';

export const REPOSITORY_FEATURES = Object.freeze(['lfs', 'submodules'] as const);

export type RepositoryFeature = (typeof REPOSITORY_FEATURES)[number];

export type RepositoryFeatureProbeResult =
  | { readonly kind: 'supported' }
  | { readonly kind: 'unsupported'; readonly features: readonly RepositoryFeature[] }
  | { readonly kind: 'unparseable'; readonly reason: string };

const LINE_PATTERN = /^(lfs|submodules)=([01])$/;

function isRepositoryFeature(value: string): value is RepositoryFeature {
  return (REPOSITORY_FEATURES as readonly string[]).includes(value);
}

export function parseRepositoryFeatureProbe(output: CommandOutput): RepositoryFeatureProbeResult {
  if (output.exitCode !== 0) {
    return { kind: 'unparseable', reason: `Probe exited with code ${String(output.exitCode)}` };
  }

  const body = output.stdout.endsWith('\n') ? output.stdout.slice(0, -1) : output.stdout;
  if (body.trim().length === 0) {
    return { kind: 'unparseable', reason: 'Probe produced no output' };
  }

  const seen = new Map<RepositoryFeature, boolean>();
  for (const line of body.split('\n')) {
    const match = LINE_PATTERN.exec(line);
    const key = match?.[1];
    if (match === null || key === undefined || !isRepositoryFeature(key)) {
      return { kind: 'unparseable', reason: 'Probe output contained an unexpected line' };
    }
    if (seen.has(key)) {
      return { kind: 'unparseable', reason: `Probe output repeated the '${key}' key` };
    }
    seen.set(key, match[2] === '1');
  }

  const missing = REPOSITORY_FEATURES.filter((feature) => !seen.has(feature));
  if (missing.length > 0) {
    return { kind: 'unparseable', reason: `Probe output is missing: ${missing.join(', ')}` };
  }

  const features = REPOSITORY_FEATURES.filter((feature) => seen.get(feature) === true);
  return features.length === 0 ? { kind: 'supported' } : { kind: 'unsupported', features };
}

const FEATURE_LABELS: Readonly<Record<RepositoryFeature, string>> = Object.freeze({
  lfs: 'Git LFS',
  submodules: 'Git submodules',
});

export function unsupportedRepositoryFeatureError(features: readonly RepositoryFeature[]): {
  readonly code: 'UNSUPPORTED_REPOSITORY_FEATURE';
  readonly message: string;
} {
  const labels = REPOSITORY_FEATURES.filter((feature) => features.includes(feature)).map(
    (feature) => FEATURE_LABELS[feature],
  );
  const verb = labels.length > 1 ? 'are' : 'is';
  return {
    code: 'UNSUPPORTED_REPOSITORY_FEATURE',
    message: `This repository uses ${labels.join(' and ')}, which ${verb} not supported in v0.2.`,
  };
}
