// Shared plumbing for Plan 06-11's real-daemon installer scenarios (fresh-install.test.ts,
// preseed-admin.test.ts): building the two real production images once, loading every image the
// production docker-compose.yml references into a fixture's nested daemon (D-19, no registry),
// reading the installer's own generated artifacts (`.env`, `install.log`) back out of the fixture,
// parsing `docker compose ps --format json`'s NDJSON shape (06-07-SUMMARY.md precedent), issuing a
// curl-based JSON request against the panel's own `/api/*` proxy from inside the fixture (there is
// no host port to reach directly), and the T-06-02 canary assertion over the REAL captured streams.
//
// Extracted here (06-11-PLAN.md Task 2's own <action> text) because both scenario files build the
// identical two images once and drive the identical curl-through-the-panel pattern -- duplicating
// either would drift the two files apart over time for no reason.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { ExecResultLike, InstallerDindFixture } from '../helpers/installer-dind.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Resolved from this file's own location, never process.cwd() -- mirrors every other installer
// suite's own REPO_ROOT resolution (control-plane-image.test.ts, compose-stack.test.ts).
export const REPO_ROOT = path.resolve(HERE, '../../..');
export const CONTROL_PLANE_DOCKERFILE = 'apps/control-plane/Dockerfile';
export const WEB_DOCKERFILE = 'apps/web/Dockerfile';

export const BUILD_TIMEOUT_MS = 900_000;
export const FIXTURE_TIMEOUT_MS = 300_000;
export const LOAD_TIMEOUT_MS = 600_000;
export const INSTALL_TIMEOUT_MS = 900_000;
export const CLI_TIMEOUT_MS = 60_000;

/** The internal port every service in docker-compose.yml agrees on -- `NOODARA_PUBLIC_URL`'s own
 *  trailing port and `NOODARA_PORT` are both set to this value so the installer never needs a
 *  network lookup to resolve either (D-02/06-VALIDATION.md's own no-network rule for this plan). */
export const FIXTURE_PANEL_PORT = 3000;

export interface BuiltImages {
  readonly controlPlaneImage: string;
  readonly webImage: string;
  readonly imagePrefix: string;
  readonly version: string;
}

/** Builds `apps/control-plane/Dockerfile` and `apps/web/Dockerfile` ONCE on the host, tagged
 *  under a fresh, lowercase, per-run-unique prefix -- reused across every Ubuntu-version fixture
 *  in the calling test file via `loadLocalImages`, never rebuilt per fixture (06-11-PLAN.md Task 1
 *  <action>: "Build ... once per run local tag"). */
export function buildInstallerScenarioImages(planTag: string): BuiltImages {
  const runId = randomUUID().replace(/-/g, '').slice(0, 12);
  const imagePrefix = `noodara-test-${planTag}-${runId}`;
  const version = `test-${planTag}-${runId}`;
  const controlPlaneImage = `${imagePrefix}/noodara-control-plane:${version}`;
  const webImage = `${imagePrefix}/noodara-web:${version}`;

  execFileSync(
    'docker',
    [
      'build',
      '--file',
      CONTROL_PLANE_DOCKERFILE,
      '--build-arg',
      `NOODARA_IMAGE_VERSION=${version}`,
      '--tag',
      controlPlaneImage,
      '.',
    ],
    { cwd: REPO_ROOT, timeout: BUILD_TIMEOUT_MS, stdio: 'pipe' },
  );
  execFileSync(
    'docker',
    [
      'build',
      '--file',
      WEB_DOCKERFILE,
      '--build-arg',
      'NOODARA_API_ORIGIN=http://api:3000',
      '--tag',
      webImage,
      '.',
    ],
    { cwd: REPO_ROOT, timeout: BUILD_TIMEOUT_MS, stdio: 'pipe' },
  );

  return { controlPlaneImage, webImage, imagePrefix, version };
}

export function removeBuiltImages(images: BuiltImages): void {
  execFileSync('docker', ['rmi', '-f', images.controlPlaneImage], { stdio: 'ignore', timeout: CLI_TIMEOUT_MS });
  execFileSync('docker', ['rmi', '-f', images.webImage], { stdio: 'ignore', timeout: CLI_TIMEOUT_MS });
}

/** Loads the two locally built images PLUS the two base images docker-compose.yml also
 *  references (`postgres:17-alpine`, `redis:7-alpine`) into a fixture's nested daemon -- D-19: no
 *  registry involved anywhere, so the base images must already be present on the OUTER host
 *  (already true for this repo's own dev stack) and are saved/loaded exactly like the two images
 *  this run just built. */
export async function loadComposeImagesInto(fixture: InstallerDindFixture, images: BuiltImages): Promise<void> {
  await fixture.loadLocalImages([images.controlPlaneImage, images.webImage, 'postgres:17-alpine', 'redis:7-alpine'], {
    timeoutMs: LOAD_TIMEOUT_MS,
  });
}

/** POSIX single-quote escaping for embedding an arbitrary value into a shell snippet (mirrors
 *  compose-stack.test.ts's own shQuote). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Reads a file out of the fixture as a UTF-8 string via `cat`. Throws with the real stderr on a
 *  non-zero exit rather than returning a misleadingly empty string. */
export async function readFixtureFile(fixture: InstallerDindFixture, absolutePath: string): Promise<string> {
  const result = await fixture.exec(['cat', absolutePath]);
  if (result.exitCode !== 0) {
    throw new Error(`readFixtureFile: cat ${absolutePath} failed (exit ${String(result.exitCode)}): ${result.stderr}`);
  }
  return result.stdout;
}

/** `stat -c '<mode> <owner>:<group>'` for a path inside the fixture -- e.g. `"600 root:root"`. */
export async function statFixturePath(fixture: InstallerDindFixture, absolutePath: string): Promise<string> {
  const result = await fixture.exec(['stat', '-c', '%a %U:%G', absolutePath]);
  if (result.exitCode !== 0) {
    throw new Error(`statFixturePath: stat ${absolutePath} failed (exit ${String(result.exitCode)}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Parses a generated `.env`'s "<KEY>=<VALUE>" lines into a map, stripping one layer of
 *  surrounding single quotes when present -- mirrors install.sh's own `noodara_env_get_value`
 *  parsing rule (last-match-wins is irrelevant here since every key is written exactly once by a
 *  fresh install). Comment lines (leading `#`) are skipped. */
export function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export interface ComposePsEntry {
  readonly ID: string;
  readonly Service: string;
  readonly State: string;
  readonly ExitCode: number;
  readonly Health: string;
  readonly Publishers: { PublishedPort: number }[];
}

/** `docker compose ps -a --format json` from inside the fixture, parsed as NDJSON (one compact
 *  object per line -- the shape this Compose version actually ships, confirmed by
 *  06-07-SUMMARY.md). Runs with `/opt/noodara` as cwd, exactly like install.sh's own
 *  `noodara_service_health`/`noodara_service_exit_code`, so project-name resolution (docker-
 *  compose.yml's own `name: noodara` top-level key) matches the installer's real behavior. */
export async function composePsInFixture(fixture: InstallerDindFixture, installDir: string): Promise<ComposePsEntry[]> {
  const result = await fixture.exec(['/bin/sh', '-c', `cd ${shQuote(installDir)} && docker compose ps -a --format json`]);
  if (result.exitCode !== 0) {
    throw new Error(`composePsInFixture: docker compose ps failed (exit ${String(result.exitCode)}): ${result.stderr}`);
  }
  return result.stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ComposePsEntry);
}

export interface CurlJsonResult {
  readonly status: number;
  readonly body: string;
  readonly headers: string;
}

/** Issues a JSON request against `http://127.0.0.1:<port><urlPath>` FROM INSIDE the fixture (the
 *  panel URL is an in-fixture address -- there is no host port to reach directly, mirroring
 *  06-11-PLAN.md Task 1's own <action> instruction). Headers and body are captured to separate
 *  temp files inside the fixture so the response's own `Set-Cookie` headers can be inspected
 *  without the body's JSON structure interfering with header parsing. Never logs the request body
 *  itself (it may carry a real synthetic-admin password) -- only the caller decides what to assert
 *  about the response. */
export async function curlJsonInFixture(
  fixture: InstallerDindFixture,
  port: number,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<CurlJsonResult> {
  const id = randomUUID().replace(/-/g, '');
  const headersFile = `/tmp/noodara-curl-headers-${id}`;
  const bodyFile = `/tmp/noodara-curl-body-${id}`;
  const parts = [
    'curl',
    '-s',
    '-D',
    headersFile,
    '-o',
    bodyFile,
    '-w',
    "'%{http_code}'",
    '-X',
    method,
  ];
  if (body !== undefined) {
    parts.push('-H', "'Content-Type: application/json'", '--data', shQuote(JSON.stringify(body)));
  }
  parts.push(`http://127.0.0.1:${String(port)}${urlPath}`);

  const statusResult = await fixture.exec(['/bin/sh', '-c', parts.join(' ')]);
  if (statusResult.exitCode !== 0) {
    throw new Error(`curlJsonInFixture: curl failed (exit ${String(statusResult.exitCode)}): ${statusResult.stderr}`);
  }
  const status = Number(statusResult.stdout.trim());

  const [headers, bodyText] = await Promise.all([
    readFixtureFile(fixture, headersFile),
    readFixtureFile(fixture, bodyFile),
  ]);
  await fixture.exec(['rm', '-f', headersFile, bodyFile]);

  return { status, body: bodyText, headers };
}

/** True when `headers` (a raw HTTP header block, possibly several responses concatenated by
 *  curl across a redirect chain) contains a `Set-Cookie` line whose attributes include
 *  `HttpOnly` -- case-insensitive on both the header name and the attribute, matching real HTTP
 *  header casing variance. */
export function hasHttpOnlyCookie(headers: string): boolean {
  return headers
    .split(/\r?\n/)
    .some((line) => /^set-cookie:/i.test(line) && /HttpOnly/i.test(line));
}

/** Extracts the LAST `NOODARA_SETUP_TOKEN=<value>` occurrence from a block of text (api container
 *  logs, or the installer's own stdout summary line), trimming a trailing CR -- mirrors
 *  install.sh's own `noodara_read_setup_token` extraction rule exactly, so this helper proves
 *  install.sh's parsing agrees with an independent implementation reading the identical source
 *  text, not merely with itself. */
export function extractSetupTokenValue(text: string, pattern: RegExp): string | undefined {
  let match: RegExpExecArray | null;
  let last: string | undefined;
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  // eslint-disable-next-line no-cond-assign
  while ((match = globalPattern.exec(text)) !== null) {
    const value = match[1];
    if (value !== undefined) {
      last = value.replace(/\r$/, '');
    }
  }
  return last;
}

/** The specific `.env` keys hard_rule #8 (T-06-02) names as generated secrets that must never
 *  reach stdout, stderr or install.log -- deliberately NOT every `.env` value (NOODARA_PORT,
 *  NOODARA_VERSION, NOODARA_PUBLIC_URL are all expected to appear verbatim in the installer's own
 *  summary output, so a blanket "no .env value anywhere" check would false-positive on those). */
const CANARY_ENV_KEYS = [
  'NOODARA_MASTER_KEY',
  'BETTER_AUTH_SECRET',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'NOODARA_ADMIN_PASSWORD',
] as const;

/** Extracts the userinfo segment (`user:pass` or `:pass`) from a `scheme://userinfo@host...`
 *  connection string, or `undefined` when the value has no `@`. */
function connectionStringUserinfo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^\w+:\/\/([^/@]+)@/.exec(value);
  return match?.[1];
}

export interface CapturedStreams {
  readonly stdout: string;
  readonly stderr: string;
  readonly installLog: string;
}

/** T-06-02's canary assertion, applied over the REAL captured stdout/stderr/install.log: every
 *  generated secret named in hard_rule #8 must occur in none of the three. On failure, the
 *  assertion message names the offending KEY only -- the secret's own value is never interpolated
 *  into an assertion message or a vitest diff (hard_rule #8's own "never print the .env, the
 *  token or docker compose config to the test's own output" instruction). */
export function assertNoSecretLeak(streams: CapturedStreams, env: Record<string, string>): void {
  const candidates = new Map<string, string>();
  for (const key of CANARY_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.length > 0) {
      candidates.set(key, value);
    }
  }
  const dbUserinfo = connectionStringUserinfo(env.DATABASE_URL);
  if (dbUserinfo !== undefined && dbUserinfo.length > 0) candidates.set('DATABASE_URL userinfo', dbUserinfo);
  const redisUserinfo = connectionStringUserinfo(env.REDIS_URL);
  if (redisUserinfo !== undefined && redisUserinfo.length > 0) candidates.set('REDIS_URL userinfo', redisUserinfo);

  for (const [name, value] of candidates) {
    expect(streams.stdout.includes(value), `stdout must not contain ${name}`).toBe(false);
    expect(streams.stderr.includes(value), `stderr must not contain ${name}`).toBe(false);
    expect(streams.installLog.includes(value), `install.log must not contain ${name}`).toBe(false);
  }
}

/** Asserts the setup token occurs exactly once in stdout (the one deliberate plaintext path,
 *  D-13) and never in install.log (hard_rule #8's own explicit requirement). */
export function assertSetupTokenOnlyOnceInStdout(streams: CapturedStreams, token: string): void {
  const stdoutOccurrences = streams.stdout.split(token).length - 1;
  expect(stdoutOccurrences, 'setup token must occur exactly once in stdout').toBe(1);
  expect(streams.installLog.includes(token), 'install.log must not contain the setup token').toBe(false);
}

export function runResultToStreams(run: ExecResultLike, installLog: string): CapturedStreams {
  return { stdout: run.stdout, stderr: run.stderr, installLog };
}
