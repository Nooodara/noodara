import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

it('cancels the real Playwright fixture during timeout before any handle is returned and joins the late build rejection', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'noodara-ssh-playwright-'));
  const report = path.join(directory, 'report.json');
  const evidence = path.join(directory, 'evidence.json');
  const stack = path.join(root, 'tests/e2e/fixtures/stack.ts');
  const containers = path.join(root, 'node_modules/testcontainers/build/index.js');
  const playwright = path.join(root, 'node_modules/@playwright/test/index.mjs');
  try {
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(path.join(directory, 'playwright.config.ts'), `export default ${JSON.stringify({
      testDir: directory, testMatch: 'cancellation.spec.ts', timeout: 0,
      workers: 1, retries: 0, reporter: [['json', { outputFile: report }]],
    })};`);
    writeFileSync(path.join(directory, 'cancellation.spec.ts'), `
import { sshTest } from ${JSON.stringify(stack)};
import { GenericContainer } from ${JSON.stringify(containers)};
import { writeFileSync } from 'node:fs';
import { expect } from ${JSON.stringify(playwright)};
const events: {stage: string; outcome: string}[] = [];
let rejectBuild: (reason: Error) => void;
const held = new Promise<never>((_resolve, reject) => { rejectBuild = reject; });
const original = GenericContainer.fromDockerfile;
GenericContainer.fromDockerfile = (() => ({
  withBuildArgs() { return this; }, build() { return held; },
})) as typeof GenericContainer.fromDockerfile;
const test = sshTest.extend<{ observer: void }>({
  observer: [async ({}, use) => {
    try { await use(); }
    finally {
      GenericContainer.fromDockerfile = original;
      const cancelled = events.some((event) => event.stage === 'image_build' && event.outcome === 'cancelled');
      const created = events.some((event) => event.stage === 'container_create');
      writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ cancelled, created }));
      expect(cancelled).toBe(true);
      expect(created).toBe(false);
    }
  }, { auto: true }],
});
// The event-loop boundary lets real fixture teardown cancel ownership first, then settles
// the held operation. It is a rendezvous, not an arbitrary timer or readiness delay.
test.afterEach(() => { setImmediate(() => rejectBuild(new Error('controlled late build rejection'))); });
test('controlled outer timeout', async ({ startOwnedSshd }) => {
  // Install the outer budget after creation begins. This exercises real runner teardown,
  // without racing the fixture's own deadline timer against Playwright's timeout callback.
  const pending = startOwnedSshd({ ubuntu: '24.04', diagnostics: (event) => { events.push(event); } });
  test.setTimeout(200);
  await pending;
});
`);
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', path.join(directory, 'playwright.config.ts')], {
      cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    // An actual outer timeout is the induced fault. No retry, skipped case, or fake runner.
    expect(result.status).toBe(1);
    expect(existsSync(evidence), result.stdout + result.stderr).toBe(true);
    const observed = JSON.parse(readFileSync(evidence, 'utf8')) as { cancelled: boolean; created: boolean };
    expect(observed).toEqual({ cancelled: true, created: false });
    const summary = JSON.parse(readFileSync(report, 'utf8')) as { stats: { unexpected: number; skipped: number }; suites: { specs: { tests: { results: { status: string }[] }[] }[] }[] };
    expect(summary.stats).toMatchObject({ unexpected: 1, skipped: 0 });
    const results = summary.suites.flatMap((suite) => suite.specs.flatMap((spec) => spec.tests.flatMap((test) => test.results)));
    expect(results.map((result) => result.status)).toEqual(['timedOut']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20_000);

it('keeps a successfully started fixture usable after a runner budget extension and cleans it on the actual outer timeout', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'noodara-ssh-playwright-budget-'));
  const report = path.join(directory, 'report.json');
  const evidence = path.join(directory, 'evidence.json');
  const live = path.join(directory, 'live-owner');
  const reaped = path.join(directory, 'reaped-owner');
  const stack = path.join(root, 'tests/e2e/fixtures/stack.ts');
  const containers = path.join(root, 'node_modules/testcontainers/build/index.js');
  const playwright = path.join(root, 'node_modules/@playwright/test/index.mjs');
  try {
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    // Substitute only Docker's boundary. The real lifecycle and Playwright fixture own the
    // successful handle; their actual reap command makes that handle unusable.
    writeFileSync(path.join(directory, 'docker'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const live = ${JSON.stringify(live)};
if (args[0] === 'ps' && fs.existsSync(live)) {
  const owner = fs.readFileSync(live, 'utf8');
  if (args.at(-1) === 'label=noodara.test.ssh-owner=' + owner) process.stdout.write('controlled-container');
}
if (args[0] === 'rm') { fs.rmSync(live, { force: true }); fs.writeFileSync(${JSON.stringify(reaped)}, 'reaped'); }
`, { mode: 0o700 });
    writeFileSync(path.join(directory, 'playwright.config.ts'), `export default ${JSON.stringify({
      testDir: directory, testMatch: 'budget.spec.ts', timeout: 1000,
      workers: 1, retries: 0, reporter: [['json', { outputFile: report }]],
    })};`);
    writeFileSync(path.join(directory, 'budget.spec.ts'), `
import { sshTest } from ${JSON.stringify(stack)};
import { GenericContainer } from ${JSON.stringify(containers)};
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect } from ${JSON.stringify(playwright)};
const live = ${JSON.stringify(live)};
const events: {stage: string; outcome: string}[] = [];
let aliveAfterOriginalDeadline = false;
const originalBuild = GenericContainer.fromDockerfile;
const originalStart = GenericContainer.prototype.start;
GenericContainer.fromDockerfile = (() => ({
  withBuildArgs() { return this; }, async build() {},
})) as typeof GenericContainer.fromDockerfile;
GenericContainer.prototype.start = async function() {
  const hooks = this as unknown as Record<string, () => Promise<void>>;
  await hooks.beforeContainerCreated();
  await hooks.containerCreated();
  await hooks.containerStarting();
  await hooks.containerStarted();
  const owner = events.find((event) => event.stage === 'image_build') as unknown as { owner: string };
  writeFileSync(live, owner.owner);
  return {
    getHost: () => '127.0.0.1', getMappedPort: () => 2022,
    async exec() { return { exitCode: existsSync(live) ? 0 : 1, output: existsSync(live) ? 'ready' : 'gone' }; },
    async stop() { rmSync(live, { force: true }); writeFileSync(${JSON.stringify(reaped)}, 'stopped'); },
  } as never;
};
const test = sshTest.extend<{ observer: void }>({
  observer: [async ({}, use) => {
    try { await use(); }
    finally {
      GenericContainer.fromDockerfile = originalBuild;
      GenericContainer.prototype.start = originalStart;
      const cleanupSucceeded = events.some((event) => event.stage === 'cleanup' && event.outcome === 'success');
      const stopped = existsSync(${JSON.stringify(reaped)});
      const observed = { aliveAfterOriginalDeadline, stopped, survivors: existsSync(live), cleanupSucceeded };
      writeFileSync(${JSON.stringify(evidence)}, JSON.stringify(observed));
      expect(observed).toEqual({ aliveAfterOriginalDeadline: true, stopped: true, survivors: false, cleanupSucceeded: true });
    }
  }, { auto: true }],
});
test('successful fixture lives through extended budget', async ({ startOwnedSshd }) => {
  const fixture = await startOwnedSshd({ ubuntu: '24.04', diagnostics: (event) => { events.push(event); } });
  test.setTimeout(6000);
  // Cross the original deadline deliberately: this is the regression's clock boundary,
  // not a readiness delay. Success was already returned before the budget was extended.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const response = await fixture.container.exec(['true']);
  aliveAfterOriginalDeadline = response.exitCode === 0;
  expect(response).toMatchObject({ exitCode: 0, output: 'ready' });
  await new Promise(() => {});
});
`);
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', path.join(directory, 'playwright.config.ts')], {
      cwd: root, env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(existsSync(evidence), result.stdout + result.stderr).toBe(true);
    expect(JSON.parse(readFileSync(evidence, 'utf8')), result.stdout + result.stderr).toEqual({
      aliveAfterOriginalDeadline: true, stopped: true, survivors: false, cleanupSucceeded: true,
    });
    const summary = JSON.parse(readFileSync(report, 'utf8')) as { stats: { unexpected: number; skipped: number }; suites: { specs: { tests: { results: { status: string }[] }[] }[] }[] };
    expect(summary.stats).toMatchObject({ unexpected: 1, skipped: 0 });
    const results = summary.suites.flatMap((suite) => suite.specs.flatMap((spec) => spec.tests.flatMap((test) => test.results)));
    expect(results.map((result) => result.status)).toEqual(['timedOut']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20_000);
