// 12-12: the chunked build-log sink (A1/A2, H1) and the logs read route (H2).
import { getTableConfig } from 'drizzle-orm/pg-core';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from '@fastify/type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedactor } from '@noodara/domain/security';
import type { LogChunkerPolicy } from '@noodara/domain/deployment';
import { deploymentLogChunks } from '../db/schema/deployment-log-chunks.js';
import type { ServerEvent, ServerEventPublisher } from '../events/server-event-publisher.js';
import deploymentsRoutes from '../routes/deployments.js';
import { DEPLOYMENT_LOGS_MAX_LIMIT } from '../routes/deployment-schemas.js';
import { toValidationErrorBody } from '../routes/http-errors.js';
import {
  createChunkedDeploymentLogSink,
  createDeploymentLogSinkFactory,
  type DeploymentLogChunkRow,
  type DeploymentLogChunkWriter,
  type DeploymentLogReader,
  type LogSinkTimers,
} from './log-sink.js';

const DEPLOYMENT_ID = '0192a7e4-0000-7000-8000-000000000001';
const POLICY: LogChunkerPolicy = { flushIntervalMs: 250, flushBytes: 1024, maxLineBytes: 1024, maxPhaseBytes: 4096 };

/** A manual clock + timer queue; `advance` fires every timer that became due, in order. */
function fakeTime() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const port: LogSinkTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  return {
    now: () => now,
    timers: port,
    pending: () => timers.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flushMicrotasks();
      }
      now = target;
      await flushMicrotasks();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function recordingWriter(impl?: (row: DeploymentLogChunkRow) => Promise<void>) {
  const rows: DeploymentLogChunkRow[] = [];
  const insert = vi.fn(async (row: DeploymentLogChunkRow) => {
    if (impl) await impl(row);
    rows.push(row);
  });
  const writer: DeploymentLogChunkWriter = { insert };
  return { rows, writer, insert };
}

function recordingEvents(impl?: () => Promise<void>) {
  const events: ServerEvent[] = [];
  const publish = vi.fn(async (event: ServerEvent) => {
    if (impl) await impl();
    events.push(event);
  });
  const publisher: ServerEventPublisher = { publish };
  return { events, publisher, publish };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function setup(options: {
  writerImpl?: (row: DeploymentLogChunkRow) => Promise<void>;
  publishImpl?: () => Promise<void>;
  maxPendingBytes?: number;
  closeTimeoutMs?: number;
} = {}) {
  const time = fakeTime();
  const writer = recordingWriter(options.writerImpl);
  const events = recordingEvents(options.publishImpl);
  const logger = makeLogger();
  const sink = createChunkedDeploymentLogSink({
    deploymentId: DEPLOYMENT_ID,
    writer: writer.writer,
    events: events.publisher,
    logger,
    policy: POLICY,
    now: time.now,
    timers: time.timers,
    ...(options.maxPendingBytes === undefined ? {} : { maxPendingBytes: options.maxPendingBytes }),
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
  });
  return { time, writer, events, logger, sink };
}

describe('createChunkedDeploymentLogSink (A2)', () => {
  it('holds a small write until the flush interval, then persists before publishing', async () => {
    const { time, writer, events, sink } = setup();
    sink.write({ phase: 'build', stream: 'stdout', text: 'step 1/3\n', seq: 0 });
    await flushMicrotasks();
    expect(writer.rows).toHaveLength(0);
    expect(time.pending()).toBe(1);

    await time.advance(250);
    expect(writer.rows).toEqual([
      { deploymentId: DEPLOYMENT_ID, phase: 'build', seq: 1, content: 'step 1/3\n', byteLength: 9 },
    ]);
    expect(events.events).toEqual([
      expect.objectContaining({ type: 'deployment.log_chunk', deploymentId: DEPLOYMENT_ID, phase: 'build', seq: 1, text: 'step 1/3\n' }),
    ]);
    const insertOrder = writer.insert.mock.invocationCallOrder[0] ?? 0;
    const publishOrder = events.publish.mock.invocationCallOrder[0] ?? 0;
    expect(insertOrder).toBeLessThan(publishOrder);
  });

  it('flushes by size at once and numbers chunks per phase from 1', async () => {
    const { writer, sink } = setup();
    const line = `${'a'.repeat(600)}\n`;
    sink.write({ phase: 'build', stream: 'stdout', text: line, seq: 0 });
    sink.write({ phase: 'build', stream: 'stdout', text: line, seq: 1 });
    sink.write({ phase: 'prepare', stream: 'system', text: line, seq: 2 });
    sink.write({ phase: 'prepare', stream: 'system', text: line, seq: 3 });
    await flushMicrotasks();
    expect(writer.rows.map((row) => [row.phase, row.seq])).toEqual([
      ['build', 1],
      ['prepare', 1],
    ]);
    await sink.close();
    expect(writer.rows.map((row) => [row.phase, row.seq])).toEqual([
      ['build', 1],
      ['prepare', 1],
      ['prepare', 2],
      ['build', 2],
    ]);
  });

  it('caps lines and the phase with a single truncation notice', async () => {
    const { writer, sink } = setup();
    sink.write({ phase: 'build', stream: 'stdout', text: `${'x'.repeat(5000)}\n`, seq: 0 });
    for (let i = 0; i < 10; i += 1) {
      sink.write({ phase: 'build', stream: 'stdout', text: `${'y'.repeat(900)}\n`, seq: i + 1 });
    }
    await sink.close();
    const content = writer.rows.map((row) => row.content).join('');
    expect(content).toContain('[line truncated]');
    expect(content.match(/reached the 4096 bytes limit/g)).toHaveLength(1);
    // The chunk that reaches the phase cap may hold one pending batch plus the last head (12-03).
    expect(writer.rows.every((row) => row.byteLength <= POLICY.flushBytes + POLICY.maxLineBytes)).toBe(true);
    const seqs = writer.rows.map((row) => row.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it('strips ANSI escapes and control bytes before persisting', async () => {
    const { writer, sink } = setup();
    sink.write({ phase: 'build', stream: 'stderr', text: '\u001b[31mred\u001b[0m\r\nbin\u0000\u0001ary\n', seq: 0 });
    await sink.close();
    expect(writer.rows[0]?.content).toBe('red\nbin�ary\n');
  });

  it('close flushes a partial line and is idempotent; writes after close are ignored', async () => {
    const { time, writer, sink } = setup();
    sink.write({ phase: 'deploy', stream: 'system', text: 'no newline', seq: 0 });
    await Promise.all([sink.close(), sink.close()]);
    sink.write({ phase: 'deploy', stream: 'system', text: 'late\n', seq: 1 });
    await time.advance(1000);
    expect(writer.rows.map((row) => row.content)).toEqual(['no newline\n']);
    expect(time.pending()).toBe(0);
  });

  it('never throws from write, even for an unknown phase', async () => {
    const { logger, sink } = setup();
    expect(() => {
      sink.write({ phase: 'bogus' as 'build', stream: 'stdout', text: 'x\n', seq: 0 });
    }).not.toThrow();
    await sink.close();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: DEPLOYMENT_ID, errorKind: 'RangeError' }),
      expect.any(String),
    );
  });
});

describe('createChunkedDeploymentLogSink failures (H1)', () => {
  const CANARY = 'canary-chunk-content-7f3a';

  it('a persistence failure is logged without chunk content and publishing continues', async () => {
    const { writer, events, logger, sink } = setup({
      writerImpl: () => Promise.reject(new Error(`duplicate key value violates unique constraint: ${CANARY}`)),
    });
    sink.write({ phase: 'build', stream: 'stdout', text: `${CANARY}\n`, seq: 0 });
    sink.write({ phase: 'build', stream: 'stdout', text: `${CANARY} again\n`, seq: 1 });
    await expect(sink.close()).resolves.toBeUndefined();
    expect(writer.rows).toHaveLength(0);
    expect(events.events).toHaveLength(1);
    expect(sink.stats().persistFailures).toBe(1);
    const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.info.mock.calls]);
    expect(logged).not.toContain(CANARY);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: DEPLOYMENT_ID, phase: 'build', seq: 1, errorKind: 'Error' }),
      'deployment log chunk could not be persisted',
    );
  });

  it('a publish failure is logged without chunk content and persistence continues', async () => {
    const { writer, logger, sink } = setup({ publishImpl: () => Promise.reject(new Error(CANARY)) });
    sink.write({ phase: 'build', stream: 'stdout', text: `${CANARY}\n`, seq: 0 });
    await sink.close();
    expect(writer.rows).toHaveLength(1);
    expect(sink.stats().publishFailures).toBe(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(CANARY);
  });

  it('a stalled database never stalls close beyond its timeout and bounds the pending queue', async () => {
    const { time, logger, sink } = setup({
      writerImpl: () => new Promise<void>(() => undefined),
      maxPendingBytes: 4096,
      closeTimeoutMs: 5000,
    });
    for (let i = 0; i < 40; i += 1) {
      sink.write({ phase: i % 2 === 0 ? 'build' : 'deploy', stream: 'stdout', text: `${'z'.repeat(1000)}\n`, seq: i });
    }
    await flushMicrotasks();
    const stats = sink.stats();
    // Only the per-phase truncation notices (one per phase, ~100 bytes) may pass the bound.
    expect(stats.peakPendingBytes).toBeLessThanOrEqual(4096 + 2 * 128);
    expect(stats.droppedChunks).toBeGreaterThan(0);

    let closed = false;
    void sink.close().then(() => {
      closed = true;
    });
    await flushMicrotasks();
    expect(closed).toBe(false);
    await time.advance(5000);
    expect(closed).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: DEPLOYMENT_ID }),
      'deployment log sink did not drain before its close timeout',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: DEPLOYMENT_ID, droppedChunks: expect.any(Number) as number }),
      'deployment log chunks were dropped',
    );
  });

  it('deployment_log_chunks rejects a duplicate (deployment, phase, seq) through a unique index', () => {
    const config = getTableConfig(deploymentLogChunks);
    const unique = config.indexes.find((index) => index.config.unique);
    expect(unique?.config.columns.map((column) => ('name' in column ? column.name : ''))).toEqual([
      'deployment_id',
      'phase',
      'seq',
    ]);
  });
});

describe('createChunkedDeploymentLogSink (SEC)', () => {
  it('publishes and persists only what the per-run Redactor already produced', async () => {
    const redactor = createRedactor();
    const secret = 'ghp_runCanary0123456789abcdefABCDEF0123';
    redactor.register(secret, 'git_token');
    const { writer, events, sink } = setup();
    sink.write({ phase: 'prepare', stream: 'stderr', text: redactor.redact(`fatal: auth ${secret}\n`), seq: 0 });
    await sink.close();
    const surface = JSON.stringify([writer.rows, events.events]);
    expect(surface).not.toContain(secret);
    expect(surface).toContain('[REDACTED');
  });
});

describe('createDeploymentLogSinkFactory', () => {
  it('rejects an invalid chunker policy at construction', () => {
    expect(() =>
      createDeploymentLogSinkFactory({
        writer: recordingWriter().writer,
        events: recordingEvents().publisher,
        logger: makeLogger(),
        policy: { ...POLICY, flushIntervalMs: 1 },
      }),
    ).toThrow(RangeError);
  });

  it('builds an independent sink per deployment', async () => {
    const writer = recordingWriter();
    const sinkFor = createDeploymentLogSinkFactory({
      writer: writer.writer,
      events: recordingEvents().publisher,
      logger: makeLogger(),
      policy: POLICY,
    });
    const a = sinkFor(DEPLOYMENT_ID);
    const b = sinkFor('0192a7e4-0000-7000-8000-000000000002');
    a.write({ phase: 'build', stream: 'stdout', text: 'a\n', seq: 0 });
    b.write({ phase: 'build', stream: 'stdout', text: 'b\n', seq: 0 });
    await Promise.all([a.close(), b.close()]);
    expect(writer.rows.map((row) => [row.deploymentId.slice(-1), row.seq, row.content])).toEqual([
      ['1', 1, 'a\n'],
      ['2', 1, 'b\n'],
    ]);
  });
});

describe('GET /api/deployments/:deploymentId/logs (H2)', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(reader: DeploymentLogReader): Promise<FastifyInstance> {
    const instance = Fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    instance.setErrorHandler((error, _request, reply) => {
      if (hasZodFastifySchemaValidationErrors(error)) {
        void reply.code(400).send(toValidationErrorBody(error.validation));
        return;
      }
      void reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal error' });
    });
    await instance.register(deploymentsRoutes, { readLogs: reader });
    await instance.ready();
    app = instance;
    return instance;
  }

  const page = {
    items: [{ phase: 'build' as const, seq: 4, text: 'later\n', byteLength: 6, createdAt: '2026-10-05T00:00:00.000Z' }],
    hasMore: false,
  };

  it('passes phase, since and limit to the reader and returns only its page', async () => {
    const reader = vi.fn<DeploymentLogReader>(() => Promise.resolve(page));
    const instance = await build(reader);
    const response = await instance.inject({ url: `/api/deployments/${DEPLOYMENT_ID}/logs?phase=build&since=3&limit=10` });
    expect(response.statusCode).toBe(200);
    expect(reader).toHaveBeenCalledWith(DEPLOYMENT_ID, { phase: 'build', since: 3, limit: 10 });
    expect(response.json()).toEqual({
      items: [{ phase: 'build', seq: 4, text: 'later\n', byteLength: 6, createdAt: '2026-10-05T00:00:00.000Z' }],
      hasMore: false,
    });
  });

  it('defaults to the start of the first phase and a capped page size', async () => {
    const reader = vi.fn<DeploymentLogReader>(() => Promise.resolve({ items: [], hasMore: false }));
    const instance = await build(reader);
    const response = await instance.inject({ url: `/api/deployments/${DEPLOYMENT_ID}/logs` });
    expect(response.statusCode).toBe(200);
    expect(reader).toHaveBeenCalledWith(DEPLOYMENT_ID, { phase: 'prepare', since: 0, limit: expect.any(Number) as number });
    const limit = reader.mock.calls[0]?.[1].limit ?? 0;
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(DEPLOYMENT_LOGS_MAX_LIMIT);
  });

  it.each([
    ['since=-1'],
    ['since=1.5'],
    ['since=abc'],
    ['since='],
    ['since=1e3'],
    ['since=99999999999'],
    [`limit=${String(DEPLOYMENT_LOGS_MAX_LIMIT + 1)}`],
    ['limit=0'],
    ['phase=runtime'],
    ['unknown=1'],
  ])('rejects %s with a 400 before reading', async (query) => {
    const reader = vi.fn<DeploymentLogReader>(() => Promise.resolve(page));
    const instance = await build(reader);
    const response = await instance.inject({ url: `/api/deployments/${DEPLOYMENT_ID}/logs?${query}` });
    expect(response.statusCode).toBe(400);
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid id with a 400', async () => {
    const reader = vi.fn<DeploymentLogReader>(() => Promise.resolve(page));
    const instance = await build(reader);
    const response = await instance.inject({ url: '/api/deployments/not-a-uuid/logs' });
    expect(response.statusCode).toBe(400);
    expect(reader).not.toHaveBeenCalled();
  });

  it('answers 404 when the deployment is outside the caller scope', async () => {
    const reader = vi.fn<DeploymentLogReader>(() => Promise.resolve(null));
    const instance = await build(reader);
    const response = await instance.inject({ url: `/api/deployments/${DEPLOYMENT_ID}/logs?since=2` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'NOT_FOUND', message: expect.stringContaining(DEPLOYMENT_ID) as string });
  });
});
