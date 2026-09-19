// T-5-26/T-5-27 (05-07-PLAN.md threat register): the eight documented behaviours of apiGet/apiSend
// -- the one fetch wrapper every apps/web screen uses to reach the control plane. Stubs
// `globalThis.fetch` per case (this file runs in Vitest's `apps` project, the default node
// environment -- no DOM needed for a fetch wrapper).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiSend } from './api-client';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('apiGet/apiSend', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a 200 JSON response to { ok: true, data } with the body unchanged', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'srv_1', name: 'db-1' }));

    const result = await apiGet<{ id: string; name: string }>('/api/servers/srv_1');

    expect(result).toEqual({ ok: true, data: { id: 'srv_1', name: 'db-1' } });
  });

  it('parses a 400 VALIDATION_FAILED body, preserving issues', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: 'VALIDATION_FAILED',
        message: 'Request does not match the schema',
        issues: [{ path: 'sshPort', message: 'Port must be between 1 and 65535' }],
      }),
    );

    const result = await apiSend('POST', '/api/servers', { sshPort: 99999 });

    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Request does not match the schema',
      issues: [{ path: 'sshPort', message: 'Port must be between 1 and 65535' }],
      unauthorized: false,
    });
  });

  it('parses a 404 NOT_FOUND body with issues absent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'NOT_FOUND', message: 'This server no longer exists.' }));

    const result = await apiGet('/api/servers/missing');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toBe('This server no longer exists.');
    expect(result.issues).toBeUndefined();
  });

  it('resolves a 401 to a failure with code UNAUTHORIZED and sets unauthorized: true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'UNAUTHORIZED', message: 'Not authenticated' }));

    const result = await apiGet('/api/servers');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNAUTHORIZED');
    expect(result.unauthorized).toBe(true);
  });

  it('parses a Retry-After header into retryAfterSeconds on a 503', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(503, { error: 'QUEUE_UNAVAILABLE', message: 'Try again shortly' }, { 'Retry-After': '5' }),
    );

    const result = await apiSend('POST', '/api/servers/srv_1/connect');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('QUEUE_UNAVAILABLE');
    expect(result.retryAfterSeconds).toBe(5);
  });

  it('degrades a non-JSON or empty error body to a generic INTERNAL_ERROR, never the raw text', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const result = await apiGet('/api/servers');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.message).not.toContain('html');
    expect(result.message).not.toContain('Bad Gateway');
  });

  it('issues every request with credentials: same-origin and a relative /api/ URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiGet('/api/servers');

    expect(fetchMock).toHaveBeenCalledWith('/api/servers', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('throws before calling fetch when given an absolute URL, never a relative /api/ path', async () => {
    await expect(apiGet('https://evil.example.com/api/servers')).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a rejected fetch to a NETWORK_ERROR failure without echoing the thrown message', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('internal-dns-resolver-hostname-leak'));

    const result = await apiGet('/api/servers');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.message).not.toContain('internal-dns-resolver-hostname-leak');
  });
});
