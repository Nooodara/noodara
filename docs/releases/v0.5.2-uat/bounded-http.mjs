import http from 'node:http';
import https from 'node:https';

// No request URL, headers, response body or remote exception enters an error message.
// The caller parses and checks successful captures before claiming redaction evidence.
export function capture(url, { headers = {}, connectionMs = 5000, overallMs = 20000, maxBytes = 1048576, stopWhen, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (![connectionMs, overallMs, maxBytes].every((n) => Number.isSafeInteger(n) && n > 0)) {
      reject(Object.assign(new Error('INVALID_LIMIT'), { code: 'INVALID_LIMIT' }));
      return;
    }
    let settled = false;
    let response;
    let connectTimer;
    let overallTimer;
    const chunks = [];
    let bytes = 0;
    const request = (new URL(url).protocol === 'https:' ? https : http).request(url, { headers, agent: false });
    const finish = (code, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(overallTimer);
      signal?.removeEventListener('abort', abort);
      response?.destroy();
      request.destroy();
      if (code) reject(Object.assign(new Error(code), { code }));
      else resolve(result);
    };
    const abort = () => finish('ABORTED');
    connectTimer = setTimeout(() => finish('CONNECTION_DEADLINE'), connectionMs);
    overallTimer = setTimeout(() => finish('OVERALL_DEADLINE'), overallMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    request.on('error', () => finish('TRANSPORT_ERROR'));
    request.on('response', (incoming) => {
      response = incoming;
      clearTimeout(connectTimer);
      if (incoming.statusCode !== 200) { finish('HTTP_STATUS'); return; }
      incoming.on('error', () => finish('TRANSPORT_ERROR'));
      incoming.on('aborted', () => finish('PARTIAL_RESPONSE'));
      incoming.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { finish('BYTE_LIMIT'); return; }
        chunks.push(chunk);
        if (stopWhen) {
          const body = Buffer.concat(chunks).toString('utf8');
          let stop;
          try { stop = stopWhen(body); } catch { finish('PARSE_FAILURE'); return; }
          if (stop) finish(null, { status: incoming.statusCode, body, bytes, ended: false, cancelled: true });
        }
      });
      incoming.on('end', () => {
        if (!incoming.complete || bytes === 0) { finish('EMPTY_OR_PARTIAL'); return; }
        finish(null, { status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8'), bytes, ended: true, cancelled: false });
      });
    });
    request.end();
  });
}
