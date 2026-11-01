import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

// 23-04 fixture: proves runtime env injection without ever echoing a value. `/env-digest?name=X`
// answers the sha256 (hex) of variable X as the container sees it, or 404 when X is unset. The
// port stays baked into the image so a service without variables deploys exactly like node-api.
const PORT = 3000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture.local');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/env-digest') {
    const name = url.searchParams.get('name') ?? '';
    const value = NAME.test(name) ? process.env[name] : undefined;
    if (value === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unset');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(createHash('sha256').update(value, 'utf8').digest('hex'));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT);

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
