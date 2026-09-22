// Idempotent, ledgered file writes for the brand asset pipeline (07-02-PLAN.md Task 3).
//
// Mirrors scripts/capture-discovery-fixtures.mjs's own `writeIfChanged` discipline (read in full
// this session) so 07-06's asset-generation script reports "no files changed" on a genuine no-op
// re-run instead of always touching mtimes -- committed brand assets are human-reviewed (D-17),
// so a script that silently rewrites bytes that did not actually change would make every
// regeneration look like a real content change in `git diff`.
//
// T-07-04 (this plan's threat register): no `rm`/`unlink` API is exposed here on purpose. Callers
// pass an absolute path they computed themselves (from `import.meta.dirname`, never from argv or
// an environment variable), and this module only ever creates or overwrites -- it can never
// delete a file a caller did not explicitly name.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// scripts/brand/ -> repo root. Matches scripts/capture-discovery-fixtures.mjs's own
// `path.resolve(HERE, '..')` shape, one level deeper since this file lives in scripts/brand/, not
// scripts/ directly.
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** Repo-relative paths written during the current process's lifetime, in write order. Reset via
 *  `resetChangedFiles()` between logically independent runs (e.g. between test cases). */
export const changedFiles: string[] = [];

function readPrevious(absPath: string, isBuffer: boolean): string | Buffer | undefined {
  if (!existsSync(absPath)) return undefined;
  return isBuffer ? readFileSync(absPath) : readFileSync(absPath, 'utf8');
}

function contentEquals(previous: string | Buffer, next: string | Buffer): boolean {
  if (Buffer.isBuffer(previous) && Buffer.isBuffer(next)) return previous.equals(next);
  if (typeof previous === 'string' && typeof next === 'string') return previous === next;
  return false;
}

/** Writes `content` to `absPath` only if it differs from what is already on disk (string content
 *  compared by value, Buffer content compared via `Buffer.equals`). Creates parent directories as
 *  needed. Returns `true` if a write actually happened, `false` for a genuine no-op. */
export function writeIfChanged(absPath: string, content: string | Buffer): boolean {
  const isBuffer = Buffer.isBuffer(content);
  const previous = readPrevious(absPath, isBuffer);

  if (previous !== undefined && contentEquals(previous, content)) {
    return false;
  }

  mkdirSync(path.dirname(absPath), { recursive: true });
  if (Buffer.isBuffer(content)) {
    writeFileSync(absPath, content);
  } else {
    writeFileSync(absPath, content, 'utf8');
  }
  changedFiles.push(path.relative(REPO_ROOT, absPath));
  return true;
}

/** Clears the ledger. Callers that run multiple independent generation passes in one process (or
 *  tests exercising `writeIfChanged` repeatedly) call this between passes so `changedFiles` only
 *  ever reflects the current pass. */
export function resetChangedFiles(): void {
  changedFiles.length = 0;
}
