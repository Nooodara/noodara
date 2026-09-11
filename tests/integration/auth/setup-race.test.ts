import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// T-1-34 (01-12-PLAN.md threat register): "first visitor becomes admin" race. Ten concurrent
// redemptions of the same valid token must produce exactly one admin — proven against a real,
// migrated PostgreSQL, not mocked, since the defense (`pg_advisory_xact_lock` plus an
// admin-existence re-check inside the lock) is a database-level guarantee.

const CONCURRENCY = 10;
const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

let fixture: TestAppFixture | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

describe('setup-token race (T-1-34)', () => {
  it('produces exactly one 200 and exactly one user row across 10 concurrent redemptions', async () => {
    fixture = await startTestApp();
    const issued = await issueToken(fixture.db, 'setup', new Date());
    const token = revealSecret(issued.token);

    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        fixture?.app.inject({
          method: 'POST',
          url: '/api/setup',
          payload: { token, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        }),
      ),
    );

    const statusCodes = responses.map((response) => response?.statusCode);
    const successCount = statusCodes.filter((code) => code === 200).length;
    const failureCount = statusCodes.filter((code) => code !== undefined && code >= 400 && code < 500).length;

    expect(successCount).toBe(1);
    expect(failureCount).toBe(CONCURRENCY - 1);

    const rows = await fixture.db.select({ id: users.id }).from(users);
    expect(rows).toHaveLength(1);
  });
});
