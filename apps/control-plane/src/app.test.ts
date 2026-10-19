// 20-03 F1: the API bounds how long a client may take to send a request. Fastify 5 defaults
// requestTimeout to 0 (never), so a client dripping a body one byte at a time held a socket and
// a parser forever. The bound covers receiving the request only: a slow response (SSE, logs
// follow) is never cut, and connectionTimeout stays 0 for the same reason.
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { API_REQUEST_TIMEOUT_MS, buildApp } from './app.js';
import { noopServerEventPublisher } from './events/server-event-publisher.js';
import { createLogger } from './logger.js';

const stubBroadcaster = { start: () => Promise.resolve(), stop: () => Promise.resolve(), closeAll: () => Promise.resolve() };
const silent = createLogger({ level: 'silent', destination: { write: () => true } }) as unknown as FastifyInstance['log'];

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(requestTimeout?: { timeoutMs: number; checkIntervalMs: number }): FastifyInstance {
  app = buildApp({
    logger: silent,
    broadcaster: stubBroadcaster as never,
    eventPublisher: noopServerEventPublisher,
    ...(requestTimeout !== undefined ? { requestTimeout } : {}),
  });
  return app;
}

/** Sends `head` plus `firstBytes` and then nothing; resolves with what the server did. */
function stall(port: number, head: string, deadlineMs: number): Promise<{ statusLine: string | null; closedByServer: boolean; elapsedMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    let settled = false;
    const finish = (closedByServer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      const line = response.split('\r\n')[0] ?? '';
      resolve({ statusLine: line === '' ? null : line, closedByServer, elapsedMs: Date.now() - started });
    };
    const deadline = setTimeout(() => {
      finish(false);
    }, deadlineMs);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.on('close', () => {
      finish(true);
    });
    socket.on('error', () => {
      finish(true);
    });
    socket.write(head);
  });
}

describe('buildApp request timeout (20-03 F1)', () => {
  it('bounds request receipt by default and never sets an idle connection timeout', () => {
    const built = build();
    expect(API_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(built.initialConfig.connectionTimeout).toBe(0);
    // Node only enforces the bound when headersTimeout does not exceed it.
    expect(built.server.requestTimeout).toBe(API_REQUEST_TIMEOUT_MS);
    expect(built.server.headersTimeout).toBeLessThanOrEqual(API_REQUEST_TIMEOUT_MS);
  });

  it('cuts a body that never completes with 408 once the timeout passes', async () => {
    const built = build({ timeoutMs: 300, checkIntervalMs: 50 });
    built.post('/__test/echo', (request) => ({ got: request.body }));
    await built.listen({ port: 0, host: '127.0.0.1' });
    const { port } = built.server.address() as AddressInfo;

    const head = 'POST /__test/echo HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 64\r\n\r\n{"a"';
    const exchange = await stall(port, head, 5_000);

    expect(exchange.closedByServer, 'the API held an incomplete body open past its request timeout').toBe(true);
    expect(exchange.statusLine).toMatch(/^HTTP\/1\.1 408 /);
    expect(exchange.elapsedMs).toBeGreaterThanOrEqual(250);
  });

  it('never cuts a slow response once the request itself has arrived', async () => {
    const built = build({ timeoutMs: 200, checkIntervalMs: 50 });
    built.get('/__test/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { ok: true };
    });
    await built.listen({ port: 0, host: '127.0.0.1' });
    const { port } = built.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${String(port)}/__test/slow`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
