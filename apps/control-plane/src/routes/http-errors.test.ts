import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  mapServiceCodeToStatus,
  SERVICE_ERROR_STATUS,
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
