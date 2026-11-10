import { expect, it } from 'vitest';
import { startSshd } from '../../../tests/integration/helpers/ssh.js';
const ubuntu = process.env['SSH_DIAGNOSTIC_UBUNTU'];
if (ubuntu !== '22.04' && ubuntu !== '24.04') throw new Error('Diagnostic Ubuntu version required');
// A fresh hosted runner is the cold context; the second call is warm within that same job.
for (const cache of ['cold', 'warm'] as const) {
  it(`observes ${ubuntu} ${cache} actual fixture before browser actions`, async () => {
    process.stdout.write(`SSH_DIAGNOSTIC ${JSON.stringify({ kind: 'context', ubuntu, cache })}\n`);
    const fixture = await startSshd({ ubuntu, diagnostics: (event) => {
      process.stdout.write(`SSH_DIAGNOSTIC ${JSON.stringify({ kind: 'stage', ...event })}\n`);
    } });
    try { expect(fixture.port).toBeGreaterThan(0); }
    finally { await fixture.stop(); }
  }, 180000);
}
