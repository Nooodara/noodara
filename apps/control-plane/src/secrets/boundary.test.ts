import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SEC-04 (23-01 A1): machine-enforced boundary, like credential-store's: secret-store.ts is the
// only module in apps/control-plane that imports both the envelope primitives and the `secrets`
// schema, so no route, worker or service can decrypt or write a secret envelope on its own.
const SECRETS_DIR = dirname(fileURLToPath(import.meta.url)); // apps/control-plane/src/secrets
const SRC_ROOT = dirname(SECRETS_DIR); // apps/control-plane/src
const SECRET_STORE = join(SECRETS_DIR, 'secret-store.ts');

const ENVELOPE_PRIMITIVES = new Set(['encryptSecret', 'decryptSecret', 'reencryptSecret']);
const SECRETS_SCHEMA_SUFFIX = 'db/schema/secrets.js';

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry: string) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') return [];
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) return listTsFiles(fullPath);
    return fullPath.endsWith('.ts') && !fullPath.endsWith('.test.ts') ? [fullPath] : [];
  });
}

interface ImportStatement {
  readonly names: readonly string[];
  readonly specifier: string;
}

function importStatements(source: string): ImportStatement[] {
  const statements = [...source.matchAll(/(?:import|export)\s+(?:type\s+)?([^'"]*?)\s*from\s+['"]([^'"]+)['"]/g)];
  return statements.map((match) => {
    const clause = match[1] ?? '';
    const braces = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    const names = braces
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '')
      .filter((name) => name.length > 0);
    return { names: clause.includes('*') ? ['*'] : names, specifier: match[2] ?? '' };
  });
}

function importsEnvelope(statements: readonly ImportStatement[]): boolean {
  return statements.some(
    (statement) =>
      statement.specifier.startsWith('@noodara/domain') &&
      statement.names.some((name) => name === '*' || ENVELOPE_PRIMITIVES.has(name)),
  );
}

function importsSecretsSchema(statements: readonly ImportStatement[]): boolean {
  return statements.some((statement) => statement.specifier.endsWith(SECRETS_SCHEMA_SUFFIX));
}

describe('secrets envelope boundary (SEC-04)', () => {
  it('secret-store.ts itself imports both the envelope primitives and the secrets schema', () => {
    const statements = importStatements(readFileSync(SECRET_STORE, 'utf8'));
    expect(importsEnvelope(statements)).toBe(true);
    expect(importsSecretsSchema(statements)).toBe(true);
  });

  it('no other module in apps/control-plane/src imports both', () => {
    const offenders = listTsFiles(SRC_ROOT).filter((file) => {
      if (file === SECRET_STORE) return false;
      const statements = importStatements(readFileSync(file, 'utf8'));
      return importsEnvelope(statements) && importsSecretsSchema(statements);
    });
    expect(offenders).toEqual([]);
  });

  it('detects a module that would import both (the check is not vacuous)', () => {
    const statements = importStatements(
      "import { decryptSecret as d, type EncryptedBlob } from '@noodara/domain/security';\nimport { secrets } from '../db/schema/secrets.js';\n",
    );
    expect(importsEnvelope(statements)).toBe(true);
    expect(importsSecretsSchema(statements)).toBe(true);
  });
});
