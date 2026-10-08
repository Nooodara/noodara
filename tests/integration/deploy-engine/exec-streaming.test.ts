// 11-14 streaming exec and confirmed remote kill on the real sshd + dockerd fixture (ADR 0008
// G1/G2, D-04, ROADMAP criterion 4). Everything remote goes through the public surface the engine
// will use: createSsh2Adapter -> SshDeploySession.stream with builder-made commands, and
// killSupervisedOperation. Raw strings are used only for root-side truth (pgrep, sha256sum, stat)
// and for writing test Dockerfiles. Measurements are logged as numbers only, never output text.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor, secretValue, type Redactor } from '@noodara/domain/security';
import {
  deployWorkspaceFor,
  deploymentImageRefFor,
  resolveRepoBuildPaths,
  validateBuildContextPath,
  validateDockerfilePath,
  validateResourceId,
  type DeployWorkspace,
  type ImageRef,
  type ValidationResult,
} from '@noodara/domain/validators';
import {
  createSsh2Adapter,
  dockerBuild,
  dockerImageRemove,
  killSupervisedOperation,
  prepareWorkspace,
  removeDeployDir,
  supervise,
  writeSecretFile,
  type RemoteCommand,
  type SshDeploySession,
  type StreamChunk,
  type StreamOptions,
  type StreamResult,
} from '@noodara/ssh';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLOW_BUILD_DOCKERFILE = readFileSync(path.join(HERE, 'fixtures/slow-build/Dockerfile'), 'utf8');
/** Same digest-pinned, harness-preloaded base as the slow-build fixture. */
const BASE_FROM_LINE = SLOW_BUILD_DOCKERFILE.split('\n').find((line) => line.startsWith('FROM '));
const SLOW_BUILD_STARTED = 'NOODARA_SLOW_BUILD_STARTED';
const NOISY_BUILD_READY = 'NOODARA_NOISY_BUILD_READY';
/**
 * BuildKit plain progress output line, e.g. `#5 12.345 NOODARA_NOISY_BUILD_READY`. Only this line
 * proves the RUN process exists: the step header (`#5 [2/2] RUN echo <marker> ...`) echoes the
 * marker when the step is scheduled, before its container starts (14-25).
 */
const outputLine = (marker: string): RegExp => new RegExp(`^#\\d+ \\d+\\.\\d+ ${marker}$`, 'm');
const READY_OUTPUT_LINE = outputLine(NOISY_BUILD_READY);
const SLOW_STARTED_OUTPUT_LINE = outputLine(SLOW_BUILD_STARTED);
/**
 * ~1.3 MB of build output: above the 1 MiB stream cap, below BuildKit's 2 MiB per-step clip.
 * Printed in bursts with a pause between them: a step printing faster than BuildKit's log speed
 * limit has the rest of its output clipped (measured in 11-14), and the cap would never be hit.
 */
const NOISY_BURSTS = 14;
const NOISY_LINES_PER_BURST = 2_000;
const NOISY_LONG_LINE_BYTES = 40_000;
const STREAM_CAP_BYTES = 1_048_576;
const LINE_CAP_BYTES = 16_384;
const STACK_TIMEOUT_MS = 900_000;
const KILL_CONFIRM_TIMEOUT_MS = 30_000;
const KILL_POLL_INTERVAL_MS = 250;
/** Builds outlive the readiness polls below; the test aborts or kills well before these. */
const BUILD_BOUNDS = { maxDurationMs: 300_000, idleTimeoutMs: 300_000, maxTotalBytes: STREAM_CAP_BYTES } as const;

/** Numbers only. Vitest hides console output of passing tests; NOODARA_MEASUREMENTS_FILE collects
 *  the SUMMARY numbers (same convention as contracts-g1-g2.test.ts). */
function measure(ubuntu: string, data: Record<string, unknown>): void {
  const line = `[11-14] ${JSON.stringify({ ubuntu, ...data })}`;
  console.log(line);
  const file = process.env.NOODARA_MEASUREMENTS_FILE;
  if (file !== undefined && file !== '') appendFileSync(file, `${line}\n`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function valid<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`fixture failed validation: ${result.code}`);
  return result.value;
}

async function pollUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Highest `<n> noodara-noisy-build-padding-line` number in `text`, or 0. */
function lastPaddingNumber(text: string): number {
  let last = 0;
  for (const match of text.matchAll(/ (\d+) noodara-noisy-build-padding-line/g)) {
    last = Math.max(last, Number(match[1]));
  }
  return last;
}

/** Live view of one stream: chunks plus the numbers this plan records. */
interface Watched {
  readonly chunks: StreamChunk[];
  readonly startedAt: number;
  firstChunkAt: number | null;
  deliveredBytes: number;
  text(): string;
}

function watch(): { watched: Watched; onChunk: (chunk: StreamChunk) => void } {
  const watched: Watched = {
    chunks: [],
    startedAt: Date.now(),
    firstChunkAt: null,
    deliveredBytes: 0,
    text: () => watched.chunks.map((chunk) => chunk.text).join(''),
  };
  return {
    watched,
    onChunk: (chunk) => {
      watched.firstChunkAt ??= Date.now();
      watched.deliveredBytes += Buffer.byteLength(chunk.text);
      watched.chunks.push(chunk);
    },
  };
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  '11-14 / ADR 0008 G1/G2, D-04, criterion 4: streaming exec and confirmed kill, Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let session: SshDeploySession | undefined;
    const redactor: Redactor = createRedactor();
    /** Every chunk and tail seen by this suite; checked for leaks at the end. */
    const transcript: string[] = [];
    const canary = `noodara-canary-${randomBytes(32).toString('base64url')}`;
    const fileSecret = `-----BEGIN TEST SECRET-----\n${randomBytes(48).toString('base64url')}\n-----END TEST SECRET-----\n`;

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const sess = (): SshDeploySession => {
      if (session === undefined) throw new Error('session not connected');
      return session;
    };
    const bounds = (overrides: Partial<StreamOptions> = {}): StreamOptions => ({
      maxDurationMs: 120_000,
      idleTimeoutMs: 120_000,
      maxTotalBytes: 65_536,
      maxLineBytes: LINE_CAP_BYTES,
      onChunk: (chunk) => transcript.push(chunk.text),
      ...overrides,
    });
    const record = (result: StreamResult): StreamResult => {
      transcript.push(result.stdoutTail, result.stderrTail);
      return result;
    };
    const mustStream = async (command: RemoteCommand, stdin?: string): Promise<void> => {
      const result = record(
        await sess().stream(
          command,
          bounds(stdin === undefined ? {} : { stdin: secretValue(stdin, 'ssh_private_key') }),
        ),
      );
      expect(result.outcome, `${command.name}: ${result.stderrTail}`).toBe('completed');
      expect(result.exitCode, `${command.name}: ${result.stderrTail}`).toBe(0);
    };
    /** Root-side truth, never the primitive under test. */
    const rootOut = async (argv: readonly string[]): Promise<string> => {
      const result = await s().exec(argv);
      return result.stdout.trim();
    };
    /** The RUN step is running: its `sh -c '... && sleep 300'` or the final `sleep 300` itself. */
    const sleepAlive = async (): Promise<boolean> => (await rootOut(['pgrep', '-f', 'sleep 300'])) !== '';
    /** The RUN step reached its final, silent `sleep 300`: it has written all of its output. */
    const buildQuiet = async (): Promise<boolean> => (await rootOut(['pgrep', '-x', '-f', 'sleep 300'])) !== '';

    const withWorkspace = async (body: (ws: DeployWorkspace) => Promise<void>): Promise<void> => {
      const ws = valid(deployWorkspaceFor(randomUUID()));
      await mustStream(prepareWorkspace(ws));
      try {
        await body(ws);
      } finally {
        await mustStream(removeDeployDir(ws));
        expect(await rootOut(['sh', '-c', 'test -e "$0" && echo present || echo gone', ws.root])).toBe('gone');
      }
    };

    /** Writes a test Dockerfile under the (not cloned) repo dir and returns a build command. */
    const prepareBuild = async (
      ws: DeployWorkspace,
      dir: string,
      dockerfile: string,
    ): Promise<{ build: RemoteCommand; image: ImageRef }> => {
      const serviceText = randomUUID();
      const deploymentId = valid(validateResourceId(randomUUID()));
      const image = valid(deploymentImageRefFor(serviceText, deploymentId));
      const { contextPath, dockerfilePath } = resolveRepoBuildPaths(
        ws.repo,
        valid(validateBuildContextPath(dir)),
        valid(validateDockerfilePath(`${dir}/Dockerfile`)),
      );
      const written = await s().exec(
        ['sh', '-c', 'umask 077 && mkdir -p "$0" && cat > "$0/Dockerfile"', contextPath],
        { user: 'deployer', stdin: dockerfile },
      );
      expect(written.exitCode, written.stderr).toBe(0);
      const build = dockerBuild({
        contextPath,
        dockerfilePath,
        image,
        target: null,
        serviceId: valid(validateResourceId(serviceText)),
        deploymentId,
      });
      return { build, image };
    };

    const cleanupBuild = async (image: ImageRef): Promise<void> => {
      await s().exec(['pkill', '-KILL', '-f', 'sleep 300']);
      if ((await rootOut(['docker', 'images', '-q', image])) !== '') {
        await mustStream(dockerImageRemove(image));
      }
    };

    beforeAll(async () => {
      redactor.register(canary, 'api_key');
      stack = await startDeployEngineStack({ ubuntu });
      const outcome = await createSsh2Adapter().connect({
        target: { host: stack.ssh.host, port: stack.ssh.port, user: stack.ssh.user },
        credential: { kind: 'private_key', privateKey: secretValue(stack.ssh.privateKey, 'ssh_private_key') },
        timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
        trustedFingerprint: null,
        redactor,
      });
      if (!outcome.ok) throw new Error(`connect failed: ${outcome.errorCode}`);
      session = outcome.session;
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      await session?.close();
      await stack?.stop();
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it('G1: secrets.write_file through stream stdin lands the exact bytes at 0600', async () => {
      await withWorkspace(async (ws) => {
        await mustStream(writeSecretFile(ws.secretFile('deploy_key')), fileSecret);

        const mode = await rootOut(['stat', '-c', '%a %U', ws.secretFile('deploy_key')]);
        const sha = await rootOut(['sha256sum', ws.secretFile('deploy_key')]);

        expect(mode).toBe('600 deployer');
        expect(sha.split(' ')[0]).toBe(sha256(fileSecret));
      });
    }, 120_000);

    it('noisy build: chunks arrive before the build ends, canary only as [REDACTED], 1 MiB cap truncates, abort leaves the group alive, kill confirms absence', async () => {
      if (BASE_FROM_LINE === undefined) throw new Error('slow-build fixture has no FROM line');
      const dockerfile = [
        BASE_FROM_LINE,
        `RUN echo "noisy canary ${canary}" && head -c ${String(NOISY_LONG_LINE_BYTES)} /dev/zero | tr '\\0' a && echo && ` +
          `for b in $(seq 1 ${String(NOISY_BURSTS)}); do ` +
          `seq $(( (b - 1) * ${String(NOISY_LINES_PER_BURST)} + 1 )) $(( b * ${String(NOISY_LINES_PER_BURST)} )) | ` +
          `sed 's/$/ noodara-noisy-build-padding-line/'; sleep 1; done && ` +
          `echo ${NOISY_BUILD_READY} && sleep 300`,
        '',
      ].join('\n');

      await withWorkspace(async (ws) => {
        const { build, image } = await prepareBuild(ws, 'noisy', dockerfile);
        const pidFile = ws.pidFile('build');
        const controller = new AbortController();
        const { watched, onChunk } = watch();
        try {
          const streaming = sess().stream(
            supervise(pidFile, build),
            bounds({ ...BUILD_BOUNDS, signal: controller.signal, onChunk }),
          );

          const ready = await pollUntil(sleepAlive, 180_000);
          expect(ready, watched.text().slice(-2_000)).toBe(true);
          // BuildKit's progress lags the RUN step: wait until delivery reaches the cap, then keep
          // reading a little so lines past the cap reach the tails before the read stops.
          const capped = await pollUntil(
            () => Promise.resolve(watched.deliveredBytes >= STREAM_CAP_BYTES - 1_024),
            240_000,
          );
          if (!capped) {
            controller.abort();
            const stalled = await streaming;
            expect.fail(
              `delivery stalled at ${String(watched.deliveredBytes)} bytes; tail: ${stalled.stderrTail.slice(-1_500)}`,
            );
          }
          const cappedAt = Date.now();
          // Abort only once the remote is silent. Closing the channel does not signal the group,
          // but a docker CLI that still has build output to print dies of EPIPE about 1 s after
          // the close and BuildKit cancels the RUN step (measured in 12-19); aborting mid-output
          // made the survival check below a race that load lost.
          const quiet = await pollUntil(buildQuiet, 240_000);
          expect(quiet, 'the RUN step never reached its final sleep').toBe(true);
          const abortedAt = Date.now();
          controller.abort();
          const result = record(await streaming);
          for (const chunk of watched.chunks) transcript.push(chunk.text);

          const maxLine = Math.max(
            ...watched.chunks.flatMap((chunk) => chunk.text.split('\n').map((line) => Buffer.byteLength(line))),
          );
          const largestChunk = Math.max(...watched.chunks.map((chunk) => Buffer.byteLength(chunk.text)));
          const streamSeconds = (abortedAt - watched.startedAt) / 1_000;
          const firstChunkToCapSeconds = (cappedAt - (watched.firstChunkAt ?? cappedAt)) / 1_000;

          expect(result.outcome).toBe('aborted');
          expect(watched.firstChunkAt).not.toBeNull();
          expect(watched.firstChunkAt ?? Infinity).toBeLessThan(abortedAt);
          expect(result.truncated).toBe(true);
          expect(watched.deliveredBytes).toBeLessThanOrEqual(STREAM_CAP_BYTES);
          expect(maxLine).toBeLessThanOrEqual(LINE_CAP_BYTES);
          expect(watched.text()).toContain('[REDACTED');
          expect(watched.text()).not.toContain(canary);
          expect(result.stderrTail + result.stdoutTail).not.toContain(canary);
          // The tail covers lines past the cap that were never delivered.
          expect(lastPaddingNumber(result.stderrTail + result.stdoutTail)).toBeGreaterThan(
            lastPaddingNumber(watched.text()),
          );
          // The RUN header echoes the marker; only its output line (after the cap) must be absent.
          expect(watched.text()).not.toMatch(READY_OUTPUT_LINE);
          // The CLI printed its last line before the close, so nothing is left to hit the closed
          // pipe; a miss here means the CLI lagged the RUN step, not that the abort killed it.
          expect(result.stderrTail + result.stdoutTail, 'docker CLI had not drained at abort').toMatch(
            READY_OUTPUT_LINE,
          );
          // ADR 0008 G2: closing the channel does not stop the remote build.
          expect(await sleepAlive()).toBe(true);

          const kill = await killSupervisedOperation({
            session: sess(),
            pidFile,
            buildContainer: null,
            confirmTimeoutMs: KILL_CONFIRM_TIMEOUT_MS,
            pollIntervalMs: KILL_POLL_INTERVAL_MS,
            redactor,
          });

          expect(kill.confirmed).toBe(true);
          expect(kill.steps).toEqual(['kill_group']);
          expect(await rootOut(['pgrep', '-f', 'sleep 300'])).toBe('');
          expect(await rootOut(['pgrep', '-f', 'docker buil[d]'])).toBe('');

          measure(ubuntu, {
            scenario: 'noisy',
            timeToFirstChunkMs: (watched.firstChunkAt ?? 0) - watched.startedAt,
            chunks: watched.chunks.length,
            chunksPerSecond: Number((watched.chunks.length / streamSeconds).toFixed(1)),
            deliveredBytesPerSecond: Math.round(watched.deliveredBytes / firstChunkToCapSeconds),
            largestChunkBytes: largestChunk,
            maxLineBytes: maxLine,
            deliveredBytes: watched.deliveredBytes,
            rawBytes: result.totalBytes,
            killToAbsenceMs: kill.elapsedMs,
            steps: kill.steps,
          });
        } finally {
          await cleanupBuild(image);
        }
      });
    }, 360_000);

    it('slow build: killSupervisedOperation runs while the stream is open on the same connection, confirms, and the stream then ends non-zero', async () => {
      await withWorkspace(async (ws) => {
        const { build, image } = await prepareBuild(ws, 'slow', SLOW_BUILD_DOCKERFILE);
        const pidFile = ws.pidFile('build');
        const { watched, onChunk } = watch();
        try {
          const streaming = sess().stream(supervise(pidFile, build), bounds({ ...BUILD_BOUNDS, onChunk }));
          // Awaited below; this only keeps an early assertion failure from resurfacing as an
          // unhandled CONNECTION_LOST when afterAll closes the session under the abandoned stream.
          void streaming.catch(() => undefined);

          // 14-25: wait for the RUN step's output, not the marker in its header. On a loaded
          // runner the header arrives alone, before the step's container starts, and the
          // sleepAlive check below then ran before `sh -c` existed.
          const started = await pollUntil(
            () => Promise.resolve(SLOW_STARTED_OUTPUT_LINE.test(watched.text())),
            180_000,
          );
          expect(started, watched.text().slice(-2_000)).toBe(true);
          expect(await sleepAlive()).toBe(true);

          const kill = await killSupervisedOperation({
            session: sess(),
            pidFile,
            buildContainer: null,
            confirmTimeoutMs: KILL_CONFIRM_TIMEOUT_MS,
            pollIntervalMs: KILL_POLL_INTERVAL_MS,
            redactor,
          });
          const result = record(await streaming);
          for (const chunk of watched.chunks) transcript.push(chunk.text);

          expect(kill.confirmed).toBe(true);
          expect(await rootOut(['pgrep', '-f', 'sleep 300'])).toBe('');
          expect(result.outcome).toBe('completed');
          expect(result.exitCode).not.toBe(0);

          measure(ubuntu, {
            scenario: 'slow',
            timeToFirstChunkMs: (watched.firstChunkAt ?? 0) - watched.startedAt,
            chunks: watched.chunks.length,
            killToAbsenceMs: kill.elapsedMs,
            steps: kill.steps,
            streamExitCode: result.exitCode,
          });
        } finally {
          await cleanupBuild(image);
        }
      });
    }, 360_000);

    it('SEC: no secret value (canary, stdin file secret) appears in any chunk or tail', () => {
      const all = transcript.join('\n');
      const secretLines = fileSecret.split('\n').filter((line) => line.length >= 8 && !line.startsWith('-----'));

      expect(all).not.toContain(canary);
      for (const line of secretLines) expect(all).not.toContain(line);
      expect(all).not.toContain(s().ssh.privateKey.split('\n')[1] ?? s().ssh.privateKey);
    });
  },
);
