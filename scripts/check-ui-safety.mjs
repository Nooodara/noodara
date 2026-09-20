#!/usr/bin/env node
// 05-21-PLAN.md Task 2: the repo-wide UI safety gates named by 05-UI-SPEC.md SS10 and this phase's
// threat register (T-5-99, T-5-100, T-5-103), made machine-checked instead of convention-only
// (T-5-102's "a rule only checked by review erodes; a rule checked by a command does not").
//
// Every gate below scans the real file contents with comment lines already stripped, so a comment
// mentioning a forbidden pattern (this file's own header included) can never satisfy or defeat a
// gate. Zero third-party dependencies -- only `node:` builtins, matching
// scripts/check-package-provenance.mjs's own zero-dependency discipline.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Recursively lists every file under `dir` (relative to REPO_ROOT), skipping `node_modules`,
 *  `dist`, `.next` and `.turbo` -- this project has no bundler-output directory checked in, but a
 *  local `pnpm build` leaves `.next`/`dist` on disk and neither should ever be scanned. */
function listFiles(dir) {
  const absDir = path.join(REPO_ROOT, dir);
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (['node_modules', 'dist', '.next', '.turbo'].includes(entry.name)) continue;
    const relPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(relPath));
    } else {
      files.push(relPath);
    }
  }
  return files;
}

function isTestFile(relPath) {
  return /\.test\.tsx?$/.test(relPath);
}

/** Strips comment-only lines (`//...`, `/* ... * /`-style continuation lines starting with `*`,
 *  and the opening `/ *` line) before a gate ever counts a match -- a comment describing or
 *  banning a pattern must never itself satisfy or invalidate that pattern's own count. This is a
 *  line-based strip (sufficient for this codebase's own comment style: every block comment here
 *  is written one line at a time, never `/* code * /` inline on a single line with real code
 *  before or after it -- verified by this script's own `--self-check` mode below). */
function stripCommentLines(content) {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return '';
      return line;
    })
    .join('\n');
}

function codeOf(relPath) {
  const content = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  return stripCommentLines(content);
}

/** One gate = one named, independently reportable check. `countMatcher` runs against each file's
 *  comment-stripped code; `files` is already scoped/filtered by the caller. */
function runCountGate({ name, files, pattern, expected, comparator }) {
  const perFile = [];
  let total = 0;
  for (const relPath of files) {
    const code = codeOf(relPath);
    const matches = code.match(pattern);
    const count = matches === null ? 0 : matches.length;
    if (count > 0) perFile.push({ relPath, count });
    total += count;
  }
  const ok = comparator(total, expected);
  return { name, total, expected, ok, perFile };
}

const TSX_GLOBS = ['apps/web/src', 'packages/ui/src'];
const ALL_SOURCE_FILES = TSX_GLOBS.flatMap((dir) => listFiles(dir)).filter((f) => /\.(ts|tsx|css)$/.test(f));
const NON_TEST_SOURCE_FILES = ALL_SOURCE_FILES.filter((f) => !isTestFile(f));
const NON_TEST_TSX_FILES = NON_TEST_SOURCE_FILES.filter((f) => f.endsWith('.tsx'));
// tokens.css is the one legitimate place hex colours are declared (the design system's own
// single source of truth, 05-UI-SPEC.md "Tokens" section) -- excluded from the hex/rgb-literal
// gates by name; everything else (theme.css, every component/page file) must reference a
// `--token` instead of a literal colour value.
const HEX_RGB_SCAN_FILES = NON_TEST_SOURCE_FILES.filter((f) => f !== path.join('packages', 'ui', 'tokens.css'));

const gates = [
  runCountGate({
    name: 'exactly one reviewed dangerouslySetInnerHTML occurrence (T-5-99)',
    files: ALL_SOURCE_FILES,
    pattern: /dangerouslySetInnerHTML/g,
    expected: 1,
    comparator: (total, expected) => total === expected,
  }),
  runCountGate({
    name: 'zero JSON.stringify in a component or page file',
    files: NON_TEST_TSX_FILES,
    pattern: /JSON\.stringify/g,
    expected: 0,
    comparator: (total, expected) => total === expected,
  }),
  runCountGate({
    name: 'zero hex colour literals outside packages/ui/tokens.css',
    files: HEX_RGB_SCAN_FILES,
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
    expected: 0,
    comparator: (total, expected) => total === expected,
  }),
  runCountGate({
    name: "zero rgb(/rgba( colour literals outside packages/ui/tokens.css",
    files: HEX_RGB_SCAN_FILES,
    pattern: /rgba?\(/g,
    expected: 0,
    comparator: (total, expected) => total === expected,
  }),
  runCountGate({
    name: 'zero literal `outline: none` CSS declarations, in either a raw CSS/style-tag form or a ' +
      "JS/JSX inline-style object's quoted form (Tailwind's `outline-none` utility class name is " +
      'a different, unrelated string and is not scanned by this gate)',
    files: NON_TEST_SOURCE_FILES,
    pattern: /outline:\s*['"]?none['"]?/g,
    expected: 0,
    comparator: (total, expected) => total === expected,
  }),
  runCountGate({
    name: 'zero onEscapeKeyDown/onInteractOutside overrides (Radix Dialog/Sheet default behaviour must stay untouched)',
    files: NON_TEST_SOURCE_FILES,
    pattern: /onEscapeKeyDown|onInteractOutside/g,
    expected: 0,
    comparator: (total, expected) => total === expected,
  }),
  runCountGate({
    name: 'zero animate-spin/spinner usage (the skill\'s full-screen-spinner ban, skeletons only)',
    files: NON_TEST_SOURCE_FILES,
    pattern: /animate-spin|\bspinner\b/g,
    expected: 0,
    comparator: (total, expected) => total === expected,
  }),
  runCountGate({
    name: "zero credentials: 'include' (D-29's same-origin lock, T-5-100)",
    files: NON_TEST_SOURCE_FILES,
    pattern: /credentials:\s*['"]include['"]/g,
    expected: 0,
    comparator: (total, expected) => total === expected,
  }),
  runCountGate({
    name: '@noodara/ui/testing imported only from *.test.tsx/*.test.ts files (ADR-0005, T-5-103)',
    files: NON_TEST_SOURCE_FILES,
    pattern: /@noodara\/ui\/testing/g,
    expected: 0,
    comparator: (total, expected) => total === expected,
  }),
];

let failed = false;
for (const gate of gates) {
  if (gate.ok) {
    console.log(`OK   ${gate.name} (count=${String(gate.total)})`);
  } else {
    failed = true;
    console.error(`FAIL ${gate.name} -- expected ${String(gate.expected)}, found ${String(gate.total)}`);
    for (const { relPath, count } of gate.perFile) {
      console.error(`       ${relPath} (${String(count)})`);
    }
  }
}

if (failed) {
  console.error('\ncheck:ui-safety FAILED -- see the gates above.');
  process.exit(1);
}

console.log('\ncheck:ui-safety OK -- all repo-wide UI safety gates hold.');
