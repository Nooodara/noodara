// SET-02/SET-03/SET-04/SET-05/D-08/T-09-03: the phase-9 extension of `pnpm security:scan-leaks`
// — the same canary discipline `canary.test.ts` (phase 1) and `canary-http.test.ts` (phase 4)
// already apply, driven through every `/api/account/*` endpoint this phase adds: `PATCH
// /api/account/profile` (name and email), `POST /api/account/password` (success, wrong current,
// weak new) and `PATCH /api/account/preferences`. Scans every response body, every response
// header, every captured log line and every `activity_events.metadata` row for a random per-run
// password canary, the real Better Auth session token, and the literal `$argon2` hash prefix.
//
// Every dynamic import below happens only after `startTestApp()` has already written a valid test
// environment to `process.env` — `env.ts`/`logger.ts` both fail-fast at *import time* (INST-06),
// matching every other suite in this phase.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import type { DnsChecker } from '../../../apps/control-plane/src/auth/dns-checker.js';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { sessions } from '../../../apps/control-plane/src/db/schema/auth.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

function fakeDnsChecker(): DnsChecker {
  return { checkEmailDomain: () => Promise.resolve('resolvable') };
}

let fixture: TestAppFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  return rawCookies.map((cookie) => String(cookie).split(';')[0]).join('; ');
}

describe('canary proof: every /api/account/* endpoint leaks no password, hash or session token', () => {
  it(
    'redacts a runtime password canary and the real session token from success bodies, error ' +
      'bodies, response headers, logs and activity metadata',
    async () => {
      // Per-run random canaries only — never a committed literal (noodara-security skill §9).
      const adminEmail = `admin-${randomUUID().replace(/-/g, '').slice(0, 8)}@noodara.test`;
      const currentPasswordCanary = `Cx-${randomBytes(18).toString('hex')}-current`;
      const newPasswordCanary = `Nx-${randomBytes(18).toString('hex')}-new`;

      let logRecords: (() => unknown[]) | undefined;

      fixture = await startTestApp({
        dnsChecker: fakeDnsChecker(),
        buildLogger: async () => {
          const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
          const capture = writableForTests();
          logRecords = capture.records;
          return createLogger({ destination: capture.stream });
        },
      });

      const issued = await issueToken(fixture.db, 'setup', new Date());
      const setupResponse = await fixture.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { token: revealSecret(issued.token), email: adminEmail, password: currentPasswordCanary, name: 'Admin' },
      });
      if (setupResponse.statusCode !== 200) {
        throw new Error(`setup failed: ${setupResponse.statusCode.toString()} ${setupResponse.body}`);
      }

      const signInResponse = await fixture.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: adminEmail, password: currentPasswordCanary },
      });
      if (signInResponse.statusCode !== 200) {
        throw new Error(`sign-in failed: ${signInResponse.statusCode.toString()} ${signInResponse.body}`);
      }
      const cookie = cookieHeaderFrom(signInResponse);

      const bodies: string[] = [setupResponse.body, signInResponse.body];
      const allHeaders: unknown[] = [setupResponse.headers, signInResponse.headers];

      // PATCH /api/account/profile — name.
      const nameResponse = await fixture.app.inject({
        method: 'PATCH',
        url: '/api/account/profile',
        headers: { cookie },
        payload: { name: 'Canary Admin', currentPassword: currentPasswordCanary },
      });
      expect(nameResponse.statusCode).toBe(200);
      bodies.push(nameResponse.body);
      allHeaders.push(nameResponse.headers);

      // PATCH /api/account/profile — email.
      const newEmail = `canary-${randomUUID().replace(/-/g, '').slice(0, 8)}@example.com`;
      const emailResponse = await fixture.app.inject({
        method: 'PATCH',
        url: '/api/account/profile',
        headers: { cookie },
        payload: { email: newEmail, currentPassword: currentPasswordCanary },
      });
      expect(emailResponse.statusCode).toBe(200);
      bodies.push(emailResponse.body);
      allHeaders.push(emailResponse.headers);

      // PATCH /api/account/profile — wrong current password (error body surface).
      const wrongProfileResponse = await fixture.app.inject({
        method: 'PATCH',
        url: '/api/account/profile',
        headers: { cookie },
        payload: { name: 'Someone Else', currentPassword: `${currentPasswordCanary}-wrong` },
      });
      expect(wrongProfileResponse.statusCode).toBe(400);
      bodies.push(wrongProfileResponse.body);
      allHeaders.push(wrongProfileResponse.headers);

      // PATCH /api/account/preferences.
      const preferencesResponse = await fixture.app.inject({
        method: 'PATCH',
        url: '/api/account/preferences',
        headers: { cookie },
        payload: { theme: 'dark' },
      });
      expect(preferencesResponse.statusCode).toBe(200);
      bodies.push(preferencesResponse.body);
      allHeaders.push(preferencesResponse.headers);

      // POST /api/account/password — wrong current password (error body surface).
      const wrongPasswordResponse = await fixture.app.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: { cookie },
        payload: { currentPassword: `${currentPasswordCanary}-wrong`, newPassword: newPasswordCanary },
      });
      expect(wrongPasswordResponse.statusCode).toBe(400);
      bodies.push(wrongPasswordResponse.body);
      allHeaders.push(wrongPasswordResponse.headers);

      // POST /api/account/password — weak new password (error body surface).
      const weakPasswordResponse = await fixture.app.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: { cookie },
        payload: { currentPassword: currentPasswordCanary, newPassword: 'too-short' },
      });
      expect(weakPasswordResponse.statusCode).toBe(400);
      bodies.push(weakPasswordResponse.body);
      allHeaders.push(weakPasswordResponse.headers);

      // POST /api/account/password — success (rotates the session; both canaries appear here).
      const passwordResponse = await fixture.app.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: { cookie },
        payload: { currentPassword: currentPasswordCanary, newPassword: newPasswordCanary },
      });
      expect(passwordResponse.statusCode).toBe(200);
      bodies.push(passwordResponse.body);
      allHeaders.push(passwordResponse.headers);

      // Non-vacuity: the real session token this run created must exist and be a genuine,
      // non-trivial secret — otherwise the "never appears" assertion below would be vacuous.
      const sessionRows = await fixture.db.select({ token: sessions.token }).from(sessions);
      expect(sessionRows.length).toBeGreaterThan(0);
      const realTokens = sessionRows.map((row) => row.token).filter((token) => token.length > 0);
      expect(realTokens.length).toBeGreaterThan(0);

      const activityRows = await fixture.db.select().from(activityEvents);
      // Non-vacuity: this run's own account.* events must actually exist.
      expect(activityRows.some((row) => row.action.startsWith('account.'))).toBe(true);
      const activityText = JSON.stringify(activityRows);

      const logsText = JSON.stringify(logRecords?.() ?? []);
      const headersText = JSON.stringify(allHeaders);

      for (const surface of [bodies.join('\n'), headersText, logsText, activityText]) {
        expect(surface).not.toContain(currentPasswordCanary);
        expect(surface).not.toContain(newPasswordCanary);
        expect(surface).not.toContain('$argon2');
      }

      // The raw session token legitimately appears in the caller's OWN rotated `Set-Cookie`
      // header (D-05 requires forwarding it) — that is the credential delivery mechanism, not a
      // leak. T-09-05's actual concern is the JSON response BODY, the logs and the activity
      // metadata, none of which may ever carry it.
      for (const surface of [bodies.join('\n'), logsText, activityText]) {
        for (const token of realTokens) {
          expect(surface).not.toContain(token);
        }
      }
    },
  );
});
