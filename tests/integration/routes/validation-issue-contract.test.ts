// Closes 05-VERIFICATION.md's gap-5 residual (05-44-PLAN.md, requirements UI-02/QA-05): each end
// of the server-side-field-error contract is independently proven elsewhere, but nothing proves
// them together against a real HTTP round trip. `tests/integration/routes/servers-crud.test.ts`
// proves the real backend returns an `issues` array over real HTTP but never asserts the
// leading-slash path shape against a form field. `tests/e2e/server-sheet.spec.ts` (~line 239-291)
// proves the frontend renders a `/sshUser` issue -- but supplies that response body itself via
// Playwright's network-interception helper, so it proves consumption of an ASSUMED shape, not of
// the real one.
//
// Rule for every test below: no hand-written issue array, no stub, no route fixture. Every
// `issues` value fed to the real `fieldErrorsFromIssues` comes from a real `app.inject()` response
// produced by the real control plane in this same test.
//
// Note recorded for the SUMMARY: service-level `VALIDATION_FAILED` responses (e.g.
// `validateSshUser`/`validateHost` rejections inside a service) carry NO `issues` array at all --
// only the schema-level `app.setErrorHandler` branch in apps/control-plane/src/app.ts produces one
// (via `hasZodFastifySchemaValidationErrors` / `toValidationErrorBody`). The `/sshUser` whitespace
// case `tests/e2e/server-sheet.spec.ts` stubs is therefore genuinely unreachable through this seam
// -- that E2E's stub is not a shortcut, it is a necessity for that particular message.
import { randomUUID } from 'node:crypto';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { fieldErrorsFromIssues, KNOWN_FORM_FIELD_PATHS } from '../../../apps/web/src/lib/error-copy.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

interface ValidationFailedBody {
  readonly error: string;
  readonly message: string;
  readonly issues: { path: string; message: string }[];
}

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

function uniqueName(suffix: string): string {
  return `srv-${suffix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

async function createAdmin(app: TestAppFixture['app'], db: TestAppFixture['db']): Promise<void> {
  const issued = await issueToken(db, 'setup', new Date());
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (response.statusCode !== 200) {
    throw new Error(`setup failed: ${response.statusCode.toString()} ${response.body}`);
  }
}

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const parsed = parseSetCookie.parse(rawCookies, { map: false });
  return parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function signIn(app: TestAppFixture['app']): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode.toString()} ${response.body}`);
  }
  return cookieHeaderFrom(response);
}

/** Boots a fresh app, creates the one admin and signs in -- the setup every test in this file
 *  needs. Same shape as tests/integration/servers/trust-fingerprint-binding.test.ts's own helper. */
async function bootAuthenticated(): Promise<{ app: TestAppFixture['app']; cookie: string }> {
  fixture = await startTestApp();
  await createAdmin(fixture.app, fixture.db);
  const cookie = await signIn(fixture.app);
  return { app: fixture.app, cookie };
}

describe('the real VALIDATION_FAILED body feeds the real fieldErrorsFromIssues (05-VERIFICATION.md gap-5 residual)', () => {
  it('Case 1/2/5/6: a top-level field violation (empty name) maps byte-identical to the real issue message, every issue path in the response starts with "/", and the mapping is non-empty and stays inside KNOWN_FORM_FIELD_PATHS', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: '',
        host: uniqueHost(),
        credential: { type: 'ssh_password', password: randomUUID() },
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as ValidationFailedBody;
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);

    // Case 2: the exact property normalizeFieldPath depends on, asserted against a real response.
    expect(body.issues.every((issue) => issue.path.startsWith('/'))).toBe(true);

    const nameIssue = body.issues.find((issue) => issue.path === '/name');
    expect(nameIssue).toBeDefined();

    const mapped = fieldErrorsFromIssues(body.issues);

    // Case 1: no hardcoded expected string -- compared against the response's own issue message.
    expect(mapped.name).toBe(nameIssue?.message);

    // Case 6: the mapping must be non-empty where it matters -- a silently-empty mapping is the
    // failure mode this whole seam exists to catch.
    expect(Object.keys(mapped).length).toBeGreaterThan(0);

    // Case 5: every mapped key is renderable, sourced from the real KNOWN_FORM_FIELD_PATHS.
    expect(Object.keys(mapped).every((key) => KNOWN_FORM_FIELD_PATHS.has(key))).toBe(true);
  });

  it('Case 3/5/6: the nested credential block collapses onto the single "credential" form key (never "password"/"privateKey"), and the mapping is non-empty and stays inside KNOWN_FORM_FIELD_PATHS', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: uniqueName('cred'),
        host: uniqueHost(),
        credential: { type: 'ssh_password' },
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as ValidationFailedBody;
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(body.issues.some((issue) => issue.path.startsWith('/credential'))).toBe(true);

    const mapped = fieldErrorsFromIssues(body.issues);

    // Case 3: the single shared credential error CredentialFields.tsx renders -- never a
    // per-sub-field key, matching ServerFormErrors' one `credential` slot.
    expect(mapped.credential).toBeDefined();
    expect(mapped.password).toBeUndefined();
    expect(mapped.privateKey).toBeUndefined();

    // Case 6 for this scenario too.
    expect(Object.keys(mapped).length).toBeGreaterThan(0);

    // Case 5 for this scenario too.
    expect(Object.keys(mapped).every((key) => KNOWN_FORM_FIELD_PATHS.has(key))).toBe(true);
  });

  it('Case 4/5: an unrecognized top-level key rejected by .strict() maps to nothing -- never rendered under a field this UI never built', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: uniqueName('unk'),
        host: uniqueHost(),
        credential: { type: 'ssh_password', password: randomUUID() },
        totallyUnknownField: 'never a real form field',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as ValidationFailedBody;
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(body.issues.length).toBeGreaterThan(0);

    const mapped = fieldErrorsFromIssues(body.issues);

    // Case 4: the unknown field name is absent from the mapped keys -- dropped, never rendered.
    expect(Object.keys(mapped)).not.toContain('totallyUnknownField');

    // Case 5: whatever did map (if anything) stays inside the real KNOWN_FORM_FIELD_PATHS.
    expect(Object.keys(mapped).every((key) => KNOWN_FORM_FIELD_PATHS.has(key))).toBe(true);
  });
});
