#!/usr/bin/env node
// `tsc` does not emit `.sql` files or `migrations/meta/_journal.json` — it only compiles
// TypeScript. Without this step `dist/cli/index.js` (already declared in this package's `bin`)
// could not run `noodara`'s migration path against a built artifact, and neither could
// `dist/db/migrate.js` (the `start`/production path this plan is closing). Run after `tsc` as
// part of the `build` script.
import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

const source = path.join(PACKAGE_ROOT, 'src', 'db', 'migrations');
const destination = path.join(PACKAGE_ROOT, 'dist', 'db', 'migrations');

cpSync(source, destination, { recursive: true });

process.stdout.write(`copy-migration-assets: copied ${source} -> ${destination}\n`);
