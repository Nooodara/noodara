import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { capture } from './bounded-http.mjs';

test('bounded HTTP capture: success, cancellation, header stall, stream stall and overflow', async () => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/headers-stall') return;
    res.writeHead(req.url === '/error' ? 503 : 200);
    if (req.url === '/stream-stall') { res.write('partial'); return; }
    if (req.url === '/overflow') { res.end('x'.repeat(2048)); return; }
    if (req.url === '/cancel') { res.write('fresh marker\n'); return; }
    res.end('readable complete\n');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { connectionMs: 150, overallMs: 300, maxBytes: 1024 };
  try {
    const success = await capture(base + '/ok', options);
    assert.equal(success.status, 200);
    assert.equal(success.body, 'readable complete\n');
    assert.equal(success.ended, true);
    const cancelled = await capture(base + '/cancel', { ...options, stopWhen: (body) => body.includes('fresh marker\n') });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.body, 'fresh marker\n');
    for (const [path, code] of [['/headers-stall', 'CONNECTION_DEADLINE'], ['/stream-stall', 'OVERALL_DEADLINE'], ['/overflow', 'BYTE_LIMIT'], ['/error', 'HTTP_STATUS']]) {
      await assert.rejects(capture(base + path, options), (error) => error.code === code);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sockets.size, 0, 'owned request sockets must close on every path');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
