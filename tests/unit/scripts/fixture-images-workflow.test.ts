// 36-04 A4/H9/H10: .github/workflows/fixture-images.yml is the only place fixture images are
// published from, and the registry pull stays opt-in everywhere. Structural checks over the file on
// disk (the same zero-dependency, regex-over-known-shape approach as check-workflow-pins.test.ts);
// nothing here runs a workflow or talks to a registry.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanWorkflowPins } from '../../../scripts/check-workflow-pins.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), 'utf8');
const workflow = (): string => read('.github/workflows/fixture-images.yml');

function topLevelSection(source: string, key: string): string {
  const match = new RegExp(`(?:^|\\n)${key}:([^\\n]*)\\n((?:(?:[ #][^\\n]*)?\\n)*)`).exec(source);
  expect(match, `${key}: section not found`).toBeTruthy();
  return `${match?.[1] ?? ''}\n${match?.[2] ?? ''}`;
}

function jobBlocks(source: string): Map<string, string> {
  const jobs = topLevelSection(source, 'jobs');
  const blocks = new Map<string, string>();
  const names = [...jobs.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)].map((m) => m[1] as string);
  for (const name of names) {
    const match = new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][a-z0-9_-]*:\\n|$)`).exec(`\n${jobs}`);
    blocks.set(name, match?.[1] ?? '');
  }
  return blocks;
}

/** Lines of the `permissions:` mapping inside a job block. */
function jobPermissions(job: string): string[] {
  const match = /\n? {4}permissions:([^\n]*)\n((?: {6,}[^\n]*\n?)*)/.exec(job);
  if (!match) return [];
  const inline = (match[1] ?? '').trim();
  if (inline !== '') return [inline];
  return (match[2] ?? '')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
}

/** Every `run:` script body (single-line or block scalar), comments included. */
function runScripts(source: string): string[] {
  const lines = source.split('\n');
  const scripts: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i] ?? '');
    if (!match) continue;
    const indent = (match[1] ?? '').length;
    const head = match[2] ?? '';
    if (!/^[|>][-+]?\s*$/.test(head)) {
      scripts.push(head);
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? '';
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    scripts.push(body.join('\n'));
  }
  return scripts;
}

function actionPins(source: string): string[] {
  return [...source.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] as string);
}

describe('fixture-images.yml (A4)', () => {
  it('exists and every uses: is pinned to a full commit SHA', () => {
    const pins = actionPins(workflow());
    expect(pins.length).toBeGreaterThan(0);
    expect(scanWorkflowPins(workflow())).toEqual([]);
  });

  it('reuses only action pins already reviewed in ci.yml or release.yml', () => {
    const reviewed = new Set([...actionPins(read('.github/workflows/ci.yml')), ...actionPins(read('.github/workflows/release.yml'))]);
    for (const pin of actionPins(workflow())) expect(reviewed.has(pin), pin).toBe(true);
  });

  it('triggers only on workflow_dispatch and on pushes to main that change tests/integration/images/**', () => {
    const on = topLevelSection(workflow(), 'on');
    const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(triggers.sort()).toEqual(['push', 'workflow_dispatch']);
    expect(on).toMatch(/\n {4}branches:\s*\[main\]\s*\n/);
    const paths = /\n {4}paths:\s*\n((?: {6}- [^\n]*\n?)+)/.exec(on)?.[1] ?? '';
    expect(paths.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(["- 'tests/integration/images/**'"]);
    expect(on).not.toMatch(/tags:|paths-ignore:|branches-ignore:|inputs:/);
  });

  it('never uses pull_request_target, pull_request or a schedule', () => {
    expect(workflow()).not.toMatch(/pull_request|schedule:/);
  });

  it('declares top-level permissions: {}', () => {
    expect(workflow()).toMatch(/\npermissions:\s*\{\}\s*\n/);
  });

  it('only the publishing job has permissions, exactly contents: read and packages: write', () => {
    const jobs = jobBlocks(workflow());
    expect(jobs.size).toBeGreaterThan(0);
    const publishing = [...jobs].filter(([, block]) => /node scripts\/fixture-images\.mjs publish\b/.test(block));
    expect(publishing.map(([name]) => name)).toHaveLength(1);
    for (const [name, block] of jobs) {
      const permissions = jobPermissions(block).sort();
      if (publishing.some(([n]) => n === name)) expect(permissions, name).toEqual(['contents: read', 'packages: write']);
      else expect(permissions.join(' '), name).not.toMatch(/write/);
    }
  });

  it('uses no secret other than GITHUB_TOKEN', () => {
    const source = workflow();
    const secrets = [...source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(secrets.length).toBeGreaterThan(0);
    for (const name of secrets) expect(name).toBe('GITHUB_TOKEN');
    expect(source).not.toMatch(/secrets\[|toJSON\(secrets\)/);
  });
});

describe('fixture-images.yml hardening (H9)', () => {
  it('declares a concurrency group that never cancels a publish in progress', () => {
    const concurrency = topLevelSection(workflow(), 'concurrency');
    expect(concurrency).toMatch(/\n {2}group:\s*\S+/);
    expect(concurrency).toMatch(/\n {2}cancel-in-progress:\s*false/);
  });

  it('every job has an explicit timeout-minutes', () => {
    for (const [name, block] of jobBlocks(workflow())) {
      expect(block, name).toMatch(/\n {4}timeout-minutes:\s*\d+\s*(?:#.*)?\n/);
    }
  });

  it('every checkout sets persist-credentials: false', () => {
    const lines = workflow().split('\n');
    const checkouts = lines.flatMap((line, i) => (/uses:\s*actions\/checkout@/.test(line) ? [i] : []));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const index of checkouts) {
      const step = [];
      for (let j = index + 1; j < lines.length && !/^\s*- /.test(lines[j] ?? '') && !/^ {0,4}\S/.test(lines[j] ?? ''); j += 1) step.push(lines[j]);
      expect(step.join('\n'), `checkout at line ${String(index + 1)}`).toMatch(/with:\s*\n\s+persist-credentials:\s*false/);
    }
  });

  it('interpolates no expression, and in particular no github.event.* or github.head_ref, into a run: script', () => {
    const scripts = runScripts(workflow());
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script).not.toMatch(/github\.event|github\.head_ref/);
      expect(script).not.toContain('${{');
    }
  });

  it('publishes only through the script, which skips an existing <name>:<hash> tag', () => {
    const source = workflow();
    expect(source).toMatch(/run: node scripts\/fixture-images\.mjs publish --registry "\$[A-Z_]+"/);
    // No second publishing path that could overwrite a tag without the existence check.
    expect(source).not.toMatch(/build-push-action|imagetools|docker push|docker tag|--force/);
    const script = read('scripts/fixture-images.mjs');
    expect(script).toMatch(/already published/);
    expect(script).toMatch(/'manifest',\s*'inspect'/);
  });

  it('logs in only through the pinned docker/login-action with the built-in token', () => {
    const source = workflow();
    expect(source).toMatch(/uses: docker\/login-action@[0-9a-f]{40}/);
    expect(source).toMatch(/password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    expect(runScripts(source).join('\n')).not.toMatch(/docker login|GITHUB_TOKEN/);
  });

  it('never mentions a timeout scale (CI budgets stay unscaled)', () => {
    expect(workflow()).not.toMatch(/TIMEOUT_SCALE/i);
  });
});

describe('the registry pull stays opt-in (H10)', () => {
  it('no file under .github/workflows sets or mentions NOODARA_TEST_FIXTURE_REGISTRY', () => {
    const files = readdirSync(WORKFLOWS).filter((name) => statSync(path.join(WORKFLOWS, name)).isFile());
    expect(files).toContain('fixture-images.yml');
    for (const name of files) {
      expect(readFileSync(path.join(WORKFLOWS, name), 'utf8'), name).not.toContain('NOODARA_TEST_FIXTURE_REGISTRY');
    }
  });
});

describe('docs/testing/fixture-images.md (H10 trust model)', () => {
  const doc = (): string => read('docs/testing/fixture-images.md');

  it('states the trust model in plain words', () => {
    const text = doc().replace(/\s+/g, ' ');
    expect(text).toMatch(/third-party code/i);
    expect(text).toMatch(/proves the identity claimed by the publisher, not (?:its )?integrity/i);
    expect(text).toMatch(/test SSH key pairs?/i);
    expect(text).toMatch(/never (?:be )?treat(?:ed)? (?:them )?as secrets/i);
  });

  it('explains identity, resolution order, the image option and how to enable or disable the pull', () => {
    const text = doc();
    expect(text).toContain('NOODARA_TEST_FIXTURE_REGISTRY');
    expect(text).toMatch(/image: 'reuse'/);
    expect(text).toMatch(/image: 'build'/);
    expect(text).toMatch(/## Resolution order/);
    expect(text).toMatch(/## Disabling the registry pull/);
    expect(text).toContain('node scripts/fixture-images.mjs list');
  });

  it('says nothing is published yet and that publication needs maintainer approval', () => {
    const text = doc().replace(/\s+/g, ' ');
    expect(text).toMatch(/nothing has been published yet/i);
    expect(text).toMatch(/maintainer approval/i);
  });

  it('carries no home paths, IP addresses or full UUIDs', () => {
    const text = doc();
    expect(text).not.toMatch(/[\\/](?:home|Users)[\\/][A-Za-z0-9._-]+/);
    expect(text).not.toMatch(/\b[A-Za-z]:[\\/]+Users[\\/]/i);
    expect(text).not.toMatch(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/);
    expect(text).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  });
});
