import { createServer } from 'node:http';

// Fixture only: no dependencies, no env vars (v0.2 has no --build-arg/--env support, so the
// port is baked into the image). Kept intentionally trivial so build and boot are fast and
// deterministic for the deploy-engine test harness and Phase 12's E2E deploy flows.
const PORT = 3000;

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'node-api', ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT);

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
