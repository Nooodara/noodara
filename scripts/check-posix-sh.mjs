#!/usr/bin/env node
// Zero-dependency static gate for install.sh (06-01-PLAN.md Task 1).
//
// Why this exists: 06-RESEARCH.md Pitfall 1 -- install.sh is published as
// `curl -fsSL .../install.sh | sh` (D-03), and on Ubuntu that always runs under dash regardless
// of any `#!/bin/bash` shebang the script might carry -- the shebang is inert when the
// interpreter is invoked explicitly by the pipe. The dev machine (macOS) ships a bash-flavoured
// `/bin/sh`, so a bashism written and even manually run as `bash install.sh` locally can look
// correct and still fail on a real user's VPS. This scanner makes that gap machine-checked
// instead of review-only.
//
// It also enforces the get.docker.com truncation-safety pattern this project's own install.sh
// must follow: all logic lives inside function bodies, and the only side-effecting top-level
// statement is the final guarded dispatch (`if [ "${NOODARA_INSTALL_SH_SOURCE_ONLY:-0}" != "1" ];
// then noodara_main "$@"; fi`). A `curl | sh` stream that gets cut off mid-download then only
// ever defines partial functions and exits -- it can never half-run an install. The
// `toplevel-side-effect` and `missing-guard` rules below are what catch a script that violates
// this shape.
//
// Only `node:` builtins are imported, matching scripts/check-package-provenance.mjs's own
// zero-dependency discipline -- this project's stated posture is "cero dependencias de tooling
// nuevas salvo necesidad justificada" and 06-CONTEXT.md explicitly rejects any new dependency for
// this phase's shell-testing layer.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only function openings written exactly as `name() {` at column 0 increase brace depth, and only
// a bare `}` at column 0 decreases it (06-01-PLAN.md Task 1's own <action> text) -- this is a
// deliberate simplification, not a general POSIX-sh brace tracker, which is why install.sh must
// be written with every function in exactly this shape.
const FUNCTION_OPEN_RE = /^[a-z_][a-z0-9_]*\(\) \{$/;
const FUNCTION_CLOSE_RE = /^\}$/;

// The exact three-line guard block install.sh's own <action> text requires as the file's final
// statement (06-01-PLAN.md Task 2).
const GUARD_LINES = [
  'if [ "${NOODARA_INSTALL_SH_SOURCE_ONLY:-0}" != "1" ]; then',
  '  noodara_main "$@"',
  'fi',
];

// What is permitted at brace depth 0, besides function open/close lines and the guard block
// itself (handled separately below): blank/comment lines (skipped before this is ever
// consulted), `set ...`, and `NAME=...` / `readonly NAME=...` assignments.
const TOPLEVEL_ALLOWED_PATTERNS = [/^set\b/, /^(readonly\s+)?[A-Za-z_][A-Za-z0-9_]*=/];

// One rule per known bashism, named exactly as 06-01-PLAN.md Task 1's <behavior> table lists
// them -- later plans reference these rule ids, so they must not be renamed casually.
const BASHISM_RULES = [
  { rule: 'bracket-test', pattern: /\[\[/ },
  { rule: 'euid', pattern: /\$EUID\b/ },
  { rule: 'pipefail', pattern: /\bpipefail\b/ },
  { rule: 'local', pattern: /(^|\s)local\s+\S/ },
  { rule: 'source', pattern: /(^|[\s;])source\s+\S/ },
  { rule: 'function-keyword', pattern: /^\s*function\s+\S/ },
  { rule: 'echo-flags', pattern: /\becho\s+-[a-zA-Z]/ },
  { rule: 'append-assign', pattern: /[A-Za-z_][A-Za-z0-9_]*\+=/ },
  { rule: 'herestring', pattern: /<<</ },
  { rule: 'ampersand-redirect', pattern: /&>/ },
  { rule: 'case-modifier', pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*(,,?|\^\^?)\}/ },
  { rule: 'ansi-c-quote', pattern: /\$'/ },
  { rule: 'declare', pattern: /\bdeclare\s+-/ },
  { rule: 'arith-command', pattern: /\(\(/ },
  { rule: 'array-literal', pattern: /[A-Za-z_][A-Za-z0-9_]*=\(/ },
];

/**
 * Scans POSIX-sh source text for bashisms and two structural violations
 * (`toplevel-side-effect`, `missing-guard`). Returns `[]` for a strict-POSIX, correctly-shaped
 * script.
 *
 * A line whose first non-blank character is `#` never produces a finding of any kind -- comments
 * may legitimately quote bash syntax as documentation.
 */
export function scanPosixSh(source) {
  const lines = source.split('\n');
  const findings = [];

  // Locate the final non-blank, non-comment line, then check whether the three lines ending
  // there are exactly the guard block -- computed once up front so the main loop below can
  // cheaply exempt only the genuine guard block (by line index), not any line that merely happens
  // to share text with one of its three lines (e.g. a stray `fi` closing an unrelated top-level
  // `if`, which must still be flagged).
  let lastContentIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    lastContentIndex = i;
    break;
  }

  let guardStartIndex = -1;
  if (lastContentIndex >= 2) {
    const candidateStart = lastContentIndex - 2;
    if (
      lines[candidateStart] === GUARD_LINES[0] &&
      lines[candidateStart + 1] === GUARD_LINES[1] &&
      lines[candidateStart + 2] === GUARD_LINES[2]
    ) {
      guardStartIndex = candidateStart;
    }
  }

  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const lineNo = i + 1;

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    for (const { rule, pattern } of BASHISM_RULES) {
      if (pattern.test(raw)) {
        findings.push({ line: lineNo, rule, excerpt: trimmed });
      }
    }

    const isFunctionOpen = FUNCTION_OPEN_RE.test(raw);
    const isFunctionClose = FUNCTION_CLOSE_RE.test(raw);
    const isGuardLine = guardStartIndex !== -1 && i >= guardStartIndex && i <= guardStartIndex + 2;

    if (depth === 0 && !isFunctionOpen && !isFunctionClose && !isGuardLine) {
      const allowed = TOPLEVEL_ALLOWED_PATTERNS.some((pattern) => pattern.test(raw));
      if (!allowed) {
        findings.push({ line: lineNo, rule: 'toplevel-side-effect', excerpt: trimmed });
      }
    }

    if (isFunctionOpen) depth += 1;
    if (isFunctionClose && depth > 0) depth -= 1;
  }

  if (guardStartIndex === -1) {
    if (lastContentIndex === -1) {
      findings.push({ line: 0, rule: 'missing-guard', excerpt: '' });
    } else {
      findings.push({
        line: lastContentIndex + 1,
        rule: 'missing-guard',
        excerpt: lines[lastContentIndex].trim(),
      });
    }
  }

  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : ['install.sh'];
  let hasFindings = false;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const findings = scanPosixSh(source);

    if (findings.length > 0) {
      hasFindings = true;
      for (const finding of findings) {
        console.error(`check-posix-sh: ${file}:${finding.line} [${finding.rule}] ${finding.excerpt}`);
      }
    } else {
      const lineCount = source.split('\n').length;
      console.log(`check-posix-sh: ${file} clean (${lineCount} lines)`);
    }
  }

  if (hasFindings) {
    process.exitCode = 1;
  }
}

// Same CLI-entrypoint guard apps/control-plane/src/db/migrate.ts already uses -- lets this module
// be imported (e.g. from tests/unit/scripts/check-posix-sh.test.ts) without running the gate as a
// side effect.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
