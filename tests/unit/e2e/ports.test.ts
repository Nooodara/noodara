import { describe, expect, it } from 'vitest';
import { resolveE2ePorts } from '../../e2e/fixtures/ports.js';

describe('test-only host ports', () => {
  it.each([
    [{}, 3000, 3100],
    [{ NOODARA_E2E_WEB_PORT: '33993', NOODARA_E2E_API_PORT: '33994' }, 33993, 33994],
    [{ NOODARA_E2E_WEB_PORT: '33993' }, 33993, 3100],
    [{ NOODARA_E2E_API_PORT: '33994' }, 3000, 33994],
    [{ NOODARA_TEST_PORT_OVERRIDE: '12345' }, 3000, 3100],
    [{ NOODARA_E2E_WEB_PORT: '1', NOODARA_E2E_API_PORT: '65535' }, 1, 65535],
  ])('resolves %j', (env, webPort, apiPort) => {
    expect(resolveE2ePorts(env)).toEqual({ webPort, apiPort,
      webOrigin: `http://localhost:${String(webPort)}`, apiOrigin: `http://localhost:${String(apiPort)}` });
  });
  it.each(['', ' ', ' 33993', '33993 ', '+1', '-1', '1.5', '0x12', '1e3', '0', '65536', 'synthetic-sensitive-invalid'])('rejects invalid values without echoing them', (value) => {
    for (const name of ['NOODARA_E2E_WEB_PORT', 'NOODARA_E2E_API_PORT']) {
      expect(() => resolveE2ePorts({ [name]: value })).toThrow(name);
      if (value.length > 1 && value.trim() !== '') {
        try { resolveE2ePorts({ [name]: value }); } catch (err) {
          expect((err as Error).message).not.toContain(value);
        }
      }
    }
  });
  it.each([
    { NOODARA_E2E_WEB_PORT: '3100' }, { NOODARA_E2E_API_PORT: '3000' },
    { NOODARA_E2E_WEB_PORT: '33993', NOODARA_E2E_API_PORT: '33993' },
  ])('rejects equal resolved ports', (env) => {
    expect(() => resolveE2ePorts(env)).toThrow('distinct');
  });
});
