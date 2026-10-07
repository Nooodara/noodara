// 14-07 A3/H4: argument validation and exit codes of `noodara services reset-host-key`. The real
// database effect (cleared row, activity event, next deploy re-pins) is in runtime-pipeline.
import { describe, expect, it } from 'vitest';
import type { ResetGitHostKeyResult } from '../services/service-services.js';
import { RESET_HOST_KEY_EXIT, servicesResetHostKeyCommand } from './services-reset-host-key.js';

const SERVICE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function run(serviceId: string, result: ResetGitHostKeyResult = 'cleared') {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exit = servicesResetHostKeyCommand({
    serviceId,
    reset: (id) => {
      calls.push(id);
      return Promise.resolve(result);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { exit, calls, out, err };
}

describe('servicesResetHostKeyCommand', () => {
  it.each(['', 'not-a-uuid', `${SERVICE_ID}; rm -rf /`, "' OR 1=1 --", '../etc/passwd'])(
    'H4: rejects %j with a named error and no database call',
    async (input) => {
      const r = run(input);
      expect(await r.exit).toBe(RESET_HOST_KEY_EXIT.invalidArgument);
      expect(r.calls).toEqual([]);
      expect(r.err).toEqual(['noodara: INVALID_SERVICE_ID: the service id must be a UUID.']);
    },
  );

  it('A3: clears a pinned key and exits 0', async () => {
    const r = run(SERVICE_ID, 'cleared');
    expect(await r.exit).toBe(RESET_HOST_KEY_EXIT.ok);
    expect(r.calls).toEqual([SERVICE_ID]);
    expect(r.out.join('\n')).toContain('Forgot the pinned SSH host key');
  });

  it('H4: is idempotent on a service with no pinned key', async () => {
    const r = run(SERVICE_ID, 'not_pinned');
    expect(await r.exit).toBe(RESET_HOST_KEY_EXIT.ok);
    expect(r.err).toEqual([]);
  });

  it('H4: an unknown service exits non-zero without echoing anything else', async () => {
    const r = run(SERVICE_ID, 'not_found');
    expect(await r.exit).toBe(RESET_HOST_KEY_EXIT.notFound);
    expect(r.err).toEqual(['noodara: SERVICE_NOT_FOUND: no service has this id.']);
    expect(r.out).toEqual([]);
  });
});
