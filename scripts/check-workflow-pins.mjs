#!/usr/bin/env node
// Zero-dependency static gate for .github/workflows/*.yml (Plan 06-13, T-06-54).
//
// Why this exists: a mutable action tag (`uses: docker/login-action@v4`) can be repointed by its
// publisher at any time to code this repository never reviewed -- and the release pipeline this
// gate protects is the one workflow that holds a GHCR-publishing token and builds the images every
// real VPS install pulls (D-01). Pinning every third-party `uses:` to a 40-character commit SHA
// (with the human-readable tag kept as a trailing comment, so a reviewer can still see what
// version is running) closes that tampering surface. `ci.yml`/`nightly.yml` already follow this
// convention by hand; this script makes it a machine-checked gate instead of a review habit, the
// same zero-dependency, regex-over-known-shape discipline scripts/check-posix-sh.mjs already
// applies to install.sh (no YAML parser dependency added -- a workflow's `uses:` lines have a
// small, fixed, known shape, which is exactly the kind of problem this project's own
// "don't hand-roll" posture says a full parser is unneeded complexity for).
//
// Only `node:` builtins are imported.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Matches a YAML `uses:` step line (with or without the leading `- `), capturing the action
// reference (`owner/repo@ref` or `owner/repo/subpath@ref`) and any trailing `# comment`.
const USES_LINE_RE = /^\s*-?\s*uses:\s*(\S+)(?:\s*#\s*(.*))?\s*$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
// hard_rule #6's own escape hatch: an action whose SHA genuinely cannot be resolved in this
// environment becomes an explicit, grep-able TODO blocking Plan 06-15 -- never a silently shipped
// floating tag. Any line carrying this marker in its trailing comment is exempt from the pin
// check, but the finding itself must still be surfaced elsewhere (SUMMARY.md), never silently.
const TODO_MARKER = /TODO\(06-15\)/;

/**
 * Scans a workflow YAML source for `uses:` lines that are not pinned to a 40-character commit
 * SHA. Returns `[]` when every action reference is either already SHA-pinned or carries an
 * explicit `TODO(06-15)` trailing-comment exception.
 *
 * @param {string} source
 * @returns {Array<{ line: number, rule: 'unpinned-action' | 'missing-ref', action: string, ref: string }>}
 */
export function scanWorkflowPins(source) {
  const findings = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(USES_LINE_RE);
    if (!match) continue;

    const [, actionRef, comment] = match;
    if (actionRef === undefined) continue;

    const atIndex = actionRef.lastIndexOf('@');
    if (atIndex === -1) {
      findings.push({ line: i + 1, rule: 'missing-ref', action: actionRef, ref: '' });
      continue;
    }

    const action = actionRef.slice(0, atIndex);
    const ref = actionRef.slice(atIndex + 1);
    if (SHA_RE.test(ref)) continue;
    if (comment !== undefined && TODO_MARKER.test(comment)) continue;

    findings.push({ line: i + 1, rule: 'unpinned-action', action, ref });
  }

  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : ['.github/workflows/release.yml'];
  let hasFindings = false;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const findings = scanWorkflowPins(source);

    if (findings.length > 0) {
      hasFindings = true;
      for (const finding of findings) {
        console.error(`check-workflow-pins: ${file}:${finding.line} [${finding.rule}] ${finding.action}@${finding.ref}`);
      }
    } else {
      console.log(`check-workflow-pins: ${file} clean`);
    }
  }

  if (hasFindings) {
    process.exitCode = 1;
  }
}

// Same CLI-entrypoint guard scripts/check-posix-sh.mjs already uses -- lets this module be
// imported (e.g. from tests/unit/scripts/check-workflow-pins.test.ts) without running the gate as
// a side effect.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
