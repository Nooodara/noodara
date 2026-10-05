import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FieldErrorBodySchema,
  mapServiceCodeToStatus,
  SERVICE_ERROR_STATUS,
  toClientRequestError,
  toErrorBody,
  toValidationErrorBody,
  type ServiceErrorCode,
} from './http-errors.js';

// D-16: this is the single place a status is ever decided for a service failure code. The
// exhaustiveness scan below reuses activity/boundary.test.ts's listTsFiles file-walk technique so
// a future service that adds a new FailureCode without updating SERVICE_ERROR_STATUS fails here,
// not silently in production.
const ROUTES_DIR = dirname(fileURLToPath(import.meta.url)); // apps/control-plane/src/routes
const SRC_ROOT = dirname(ROUTES_DIR); // apps/control-plane/src
const SERVICES_DIR = join(SRC_ROOT, 'services');

function listTsFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry: string) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') return [];
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      return listTsFiles(fullPath);
    }
    return fullPath.endsWith('.ts') && !fullPath.endsWith('.test.ts') ? [fullPath] : [];
  });
}

/** Extracts every quoted UPPER_SNAKE literal inside a `...FailureCode = <union>;` declaration,
 *  regardless of whether the union is written on one line or spread across several `| 'X'` rows. */
function extractFailureCodes(source: string): string[] {
  const unionBlocks = [...source.matchAll(/FailureCode\s*=([\s\S]*?);/g)];
  const codes: string[] = [];
  for (const block of unionBlocks) {
    const body = block[1] ?? '';
    for (const match of body.matchAll(/'([A-Z_]+)'/g)) {
      const code = match[1];
      if (code) codes.push(code);
    }
  }
  return codes;
}

describe('SERVICE_ERROR_STATUS / mapServiceCodeToStatus (D-16)', () => {
  it.each([
    ['VALIDATION_FAILED', 400],
    ['INVALID_CREDENTIAL', 400],
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN_ORIGIN', 403],
    ['NOT_FOUND', 404],
    ['NAME_TAKEN', 409],
    ['HOST_TAKEN', 409],
    ['SERVER_BUSY', 409],
    ['ALREADY_CONNECTING', 409],
    ['SERVER_NOT_CONNECTED', 409],
    ['NO_PENDING_FINGERPRINT', 409],
    ['CONFIRMATION_MISMATCH', 409],
    ['QUEUE_UNAVAILABLE', 503],
    ['SSE_LIMIT_REACHED', 503],
    ['INTERNAL_ERROR', 500],
    ['EMAIL_DOMAIN_UNRESOLVABLE', 400],
    ['EMAIL_DOMAIN_CHECK_UNAVAILABLE', 503],
    ['REAUTH_LOCKED', 429],
    ['SESSION_REVOKED_PASSWORD_CHANGED', 401],
    ['PROJECT_NAME_TAKEN', 409],
    ['ENVIRONMENT_NAME_TAKEN', 409],
    ['PROJECT_NOT_ARCHIVED', 422],
    ['DELETE_CONFIRMATION_MISMATCH', 422],
    ['SERVICE_INPUT_INVALID', 422],
    ['SERVICE_NAME_TAKEN', 409],
    ['PORT_IN_USE', 409],
    ['SERVER_DOCKER_UNAVAILABLE', 409],
    ['SERVER_BUILDKIT_UNAVAILABLE', 409],
    ['CREDENTIAL_SOURCE_MISMATCH', 409],
    ['SERVICE_CREDENTIAL_INVALID', 422],
    ['SERVER_HAS_SERVICES', 409],
    ['DEPLOYMENT_IN_PROGRESS', 409],
    ['PROJECT_ARCHIVED', 409],
    ['DEPLOYMENT_INPUT_INVALID', 422],
  ] satisfies [ServiceErrorCode, number][])('maps %s to %d', (code, status) => {
    expect(mapServiceCodeToStatus(code)).toBe(status);
  });

  it('defaults to 500 for a code that is not in the table, never throwing', () => {
    expect(() => mapServiceCodeToStatus('NOT_A_REAL_CODE')).not.toThrow();
    expect(mapServiceCodeToStatus('NOT_A_REAL_CODE')).toBe(500);
  });

  it('freezes the table so a later mutation is a no-op', () => {
    expect(Object.isFrozen(SERVICE_ERROR_STATUS)).toBe(true);
  });
});

describe('toClientRequestError (Fastify-owned 4xx kept as 4xx)', () => {
  it.each([
    ['FST_ERR_CTP_INVALID_JSON_BODY', 400, 'MALFORMED_REQUEST'],
    ['FST_ERR_CTP_EMPTY_JSON_BODY', 400, 'MALFORMED_REQUEST'],
    ['FST_ERR_CTP_BODY_TOO_LARGE', 413, 'PAYLOAD_TOO_LARGE'],
    ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ])('maps %s to %d %s with a fixed message', (code, statusCode, error) => {
    const result = toClientRequestError({ code, statusCode, message: 'Unexpected token } at "CANARY"' });
    expect(result?.status).toBe(statusCode);
    expect(result?.body.error).toBe(error);
    expect(Object.keys(result?.body ?? {})).toStrictEqual(['error', 'message']);
    expect(typeof result?.body.message).toBe('string');
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('returns null for an error that is not Fastify-owned, even with a 4xx statusCode', () => {
    expect(toClientRequestError({ code: 'SOME_LIB', statusCode: 404, message: 'x' })).toBeNull();
    expect(toClientRequestError({ statusCode: 400, message: 'x' })).toBeNull();
  });

  it('returns null for a Fastify error outside the 4xx range', () => {
    expect(toClientRequestError({ code: 'FST_ERR_SOMETHING', statusCode: 500, message: 'x' })).toBeNull();
    expect(toClientRequestError({ code: 'FST_ERR_SOMETHING', message: 'x' })).toBeNull();
  });
});

describe('toErrorBody (D-16 error body shape)', () => {
  it('returns exactly { error, message } with no extra keys, stack or cause', () => {
    const body = toErrorBody('NOT_FOUND', 'Server "x" not found');
    expect(body).toStrictEqual({ error: 'NOT_FOUND', message: 'Server "x" not found' });
    expect(Object.keys(body)).toStrictEqual(['error', 'message']);
  });
});

describe('toValidationErrorBody (D-16 Zod/Fastify validation normalization)', () => {
  it('maps AJV-style instancePath issues to { path, message } pairs with a fixed message', () => {
    const body = toValidationErrorBody([
      { instancePath: '/name', message: 'Required' },
      { instancePath: '/host', message: 'Invalid host' },
    ]);
    expect(body).toStrictEqual({
      error: 'VALIDATION_FAILED',
      message: 'Request does not match the schema',
      issues: [
        { path: '/name', message: 'Required' },
        { path: '/host', message: 'Invalid host' },
      ],
    });
  });

  it('drops any extra fields (e.g. received/expected) from each issue', () => {
    const body = toValidationErrorBody([
      {
        instancePath: '/password',
        message: 'Too short',
        // @ts-expect-error -- exercising a raw issue shape carrying extra, non-safe fields
        received: 'super-secret-value',
        expected: 'string',
      },
    ]);
    expect(body.issues[0]).toStrictEqual({ path: '/password', message: 'Too short' });
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
  });

  it('accepts an explicit code (09-06), keeping error equal to the service code, not VALIDATION_FAILED', () => {
    const body = toValidationErrorBody(
      [{ instancePath: '/currentPassword', message: 'Current password is incorrect.' }],
      'INVALID_CREDENTIAL',
    );
    expect(body).toStrictEqual({
      error: 'INVALID_CREDENTIAL',
      message: 'Request does not match the schema',
      issues: [{ path: '/currentPassword', message: 'Current password is incorrect.' }],
    });
  });

  it('defaults to VALIDATION_FAILED when no code is supplied (existing callers unaffected)', () => {
    const body = toValidationErrorBody([{ instancePath: '/name', message: 'Required' }]);
    expect(body.error).toBe('VALIDATION_FAILED');
  });
});

describe('FieldErrorBodySchema (09-06)', () => {
  it('validates a field-tagged service error body carrying a non-VALIDATION_FAILED error code', () => {
    const parsed = FieldErrorBodySchema.parse({
      error: 'EMAIL_DOMAIN_UNRESOLVABLE',
      message: "We couldn't find a mail server for this domain. Check the address and try again.",
      issues: [{ path: 'email', message: "We couldn't find a mail server for this domain. Check the address and try again." }],
    });
    expect(parsed.error).toBe('EMAIL_DOMAIN_UNRESOLVABLE');
  });
});

describe('D-16 static exhaustiveness: SERVICE_ERROR_STATUS covers every service FailureCode', () => {
  it('is not vacuous: scans a realistic number of service files and finds a realistic number of codes', () => {
    const files = listTsFiles(SERVICES_DIR);
    expect(files.length).toBeGreaterThanOrEqual(5);

    const allCodes = new Set<string>();
    for (const file of files) {
      for (const code of extractFailureCodes(readFileSync(file, 'utf8'))) {
        allCodes.add(code);
      }
    }
    expect(allCodes.size).toBeGreaterThanOrEqual(8);
  });

  it('maps every FailureCode found in apps/control-plane/src/services/*.ts to a status', () => {
    const files = listTsFiles(SERVICES_DIR);
    const allCodes = new Set<string>();
    for (const file of files) {
      for (const code of extractFailureCodes(readFileSync(file, 'utf8'))) {
        allCodes.add(code);
      }
    }

    const mappedKeys = new Set(Object.keys(SERVICE_ERROR_STATUS));
    for (const code of allCodes) {
      expect(mappedKeys.has(code), `SERVICE_ERROR_STATUS is missing a mapping for "${code}"`).toBe(
        true,
      );
    }
  });
});
