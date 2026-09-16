import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ACT-01/T-3-08: machine-enforced boundary for "only application services write activity
// events" (ARCHITECTURE.md §6), so a phase 4 route or worker cannot bypass the services this
// phase built and write an undisciplined event directly. Mirrors packages/ssh/src/boundary.test.ts
// and packages/domain/src/purity.test.ts's listTsFiles/importSpecifiers file-walk technique.
const ACTIVITY_DIR = dirname(fileURLToPath(import.meta.url)); // apps/control-plane/src/activity
const SRC_ROOT = dirname(ACTIVITY_DIR); // apps/control-plane/src

const SERVICES_DIR = join(SRC_ROOT, 'services') + '/';
const ACTIVITY_DIR_PREFIX = ACTIVITY_DIR + '/';

// The Drizzle barrel every schema-bound client (the migration runner, client.ts, the Better Auth
// adapter) binds against. It re-exports every table, including `activityEvents`, so it can never
// avoid a `db/schema/activity-events.js` specifier landing in its own source — but it never
// inserts anything itself, so it is allowlisted here rather than moved.
const SCHEMA_BARREL = join(SRC_ROOT, 'db/schema/index.ts');

// Phase 1 predates ACT-01's own enforcement and already ships three legitimate direct callers of
// `writeActivityEvent`, none of which is an HTTP route or a background worker (the two caller
// kinds T-3-08 actually targets): the first-boot admin bootstrap, the login-attempt guard (an
// auth hook invoked from Better Auth's own middleware pipeline, not a Fastify route handler) and
// the `noodara admin reset` CLI command (which only imports the `ActivityWriteHandle` type, never
// calls the function). Moving these into `src/services/` is a real Phase 1 refactor outside this
// plan's scope (03-CONTEXT.md's phase boundary: this phase adds `server.*` events and the
// enforcement test, it does not restructure Phase 1's auth flow) — they are named individually,
// not directory-allowlisted, so this list cannot silently grow to swallow a real violation.
const PRE_ACT01_EXCEPTIONS = new Set([
  join(SRC_ROOT, 'boot/bootstrap-admin.ts'),
  join(SRC_ROOT, 'auth/login-guard.ts'),
  join(SRC_ROOT, 'cli/admin-reset.ts'),
]);

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

function importSpecifiers(source: string): string[] {
  const matches = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)];
  return matches.map((match) => match[1] ?? '');
}

function isAllowedImporter(filePath: string): boolean {
  if (filePath.startsWith(SERVICES_DIR) || filePath.startsWith(ACTIVITY_DIR_PREFIX)) return true;
  if (filePath === SCHEMA_BARREL) return true;
  return PRE_ACT01_EXCEPTIONS.has(filePath);
}

const FORBIDDEN_WRITE_EVENT_SUFFIX = 'activity/write-activity-event.js';
const FORBIDDEN_SCHEMA_SUFFIX = 'db/schema/activity-events.js';

describe('activity_events write boundary (ACT-01)', () => {
  it('is only imported for writeActivityEvent from src/services/ or src/activity/', () => {
    const files = listTsFiles(SRC_ROOT);

    for (const file of files) {
      if (isAllowedImporter(file)) continue;

      const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
      const forbidden = specifiers.find((specifier) =>
        specifier.endsWith(FORBIDDEN_WRITE_EVENT_SUFFIX),
      );
      expect(
        forbidden,
        `${file} imports "${forbidden ?? ''}", which may only be imported from apps/control-plane/src/services/ or apps/control-plane/src/activity/ (ACT-01)`,
      ).toBeUndefined();
    }
  });

  it('activity-events.js is only imported from src/services/, src/activity/, or the schema barrel', () => {
    const files = listTsFiles(SRC_ROOT);

    for (const file of files) {
      if (isAllowedImporter(file)) continue;

      const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
      const forbidden = specifiers.find((specifier) => specifier.endsWith(FORBIDDEN_SCHEMA_SUFFIX));
      expect(
        forbidden,
        `${file} imports "${forbidden ?? ''}", which may only be imported from apps/control-plane/src/services/ or apps/control-plane/src/activity/ (ACT-01)`,
      ).toBeUndefined();
    }
  });

  // T-3-32: a bad path glob that scans nothing would make the two assertions above pass
  // vacuously forever. Prove the scan actually found a realistic number of files and at least
  // one legitimate service importer, so a broken SRC_ROOT/listTsFiles change fails loudly.
  it('is not vacuous: the scan finds a realistic file count and a legitimate service importer', () => {
    const files = listTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(20);

    const legitimateImporters = files.filter((file) => {
      if (!file.startsWith(SERVICES_DIR)) return false;
      const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
      return specifiers.some((specifier) => specifier.endsWith(FORBIDDEN_WRITE_EVENT_SUFFIX));
    });
    expect(legitimateImporters.length).toBeGreaterThanOrEqual(1);
  });

  // Catches a direct `.insert(activityEvents, ...)` call that dodges the import-specifier scan
  // via the schema barrel's re-export (e.g. `import * as schema from '../db/schema/index.js'`
  // then `tx.insert(schema.activityEvents)` under a different local name).
  it('never calls .insert(activityEvents outside src/activity/', () => {
    const files = listTsFiles(SRC_ROOT);

    for (const file of files) {
      if (file.startsWith(ACTIVITY_DIR_PREFIX)) continue;

      const source = readFileSync(file, 'utf8');
      expect(
        /\.insert\(\s*activityEvents/.test(source),
        `${file} calls .insert(activityEvents directly, bypassing writeActivityEvent (ACT-01)`,
      ).toBe(false);
    }
  });
});
