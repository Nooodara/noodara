import { createServer } from 'node:http';

// Fixture only (17-02 A4): runs and listens, but its health path answers 500 so an HTTP
// healthcheck fails with a wrong status while the container keeps running. `/hang` never
// answers, so a probe against it times out.
const PORT = 3000;

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'unhealthy-api', ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('unhealthy');
    return;
  }

  if (req.method === 'GET' && req.url === '/hang') {
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT);

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
