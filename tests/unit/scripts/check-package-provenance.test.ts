import { describe, expect, it } from 'vitest';

// WR-C-14 (05-REVIEW.md): `scripts/check-package-provenance.mjs` used to enumerate a hardcoded
// 29-entry list instead of the actual locked dependency tree, missing security-critical
// production packages (`ssh2`, `argon2`, `better-auth`, `pg`, `fastify`, `pino`, `zod`) entirely,
// and resolved each package's registry `repository.url` at `dist-tags.latest` rather than the
// exact version pinned in `pnpm-lock.yaml`. These tests pin down both fixes.
//
// `enumerateLockedDependencies` shells out to the local `pnpm list -r --depth 0 --json` (no
// network call — pnpm already has the workspace's node_modules resolved on disk), so this stays
// a fast, deterministic unit test rather than an integration test against a real registry.
import { enumerateLockedDependencies } from '../../../scripts/check-package-provenance.mjs';

// The exact packages WR-C-14 named as missing from the old hardcoded EXPECTED_PACKAGES list.
const WR_C_14_PACKAGES = ['ssh2', 'argon2', 'better-auth', 'pg', 'fastify', 'pino', 'zod'];

describe('check-package-provenance.mjs enumerateLockedDependencies', () => {
  it('includes every WR-C-14 package the old hardcoded list was missing', () => {
    const enumerated = enumerateLockedDependencies();
    const names = enumerated.map((pkg) => pkg.name);

    for (const missingPackage of WR_C_14_PACKAGES) {
      expect(names).toContain(missingPackage);
    }
  });

  it('resolves ioredis to its exact locked version, not the registry "latest" tag', () => {
    // package.json / ADR-0000 pin ioredis at 5.11.1 specifically because 6.0.0 (the registry's
    // current dist-tags.latest) switches its default wire protocol to RESP3 — unvalidated
    // against this project's BullMQ pin (04-RESEARCH.md Pitfall 2). A gate that silently checked
    // "latest" would report on a version this repository does not even install.
    const enumerated = enumerateLockedDependencies();
    const ioredis = enumerated.find((pkg) => pkg.name === 'ioredis');

    expect(ioredis).toBeDefined();
    expect(ioredis?.version).toBe('5.11.1');
  });

  it('excludes workspace-internal packages (no registry entry to check)', () => {
    const enumerated = enumerateLockedDependencies();
    const names = enumerated.map((pkg) => pkg.name);

    for (const workspacePackage of ['@noodara/domain', '@noodara/ssh', '@noodara/ui']) {
      expect(names).not.toContain(workspacePackage);
    }
  });
});
