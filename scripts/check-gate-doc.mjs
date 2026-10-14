#!/usr/bin/env node
// Release gate document check (14-15 H1, 14-35). A gate row marked READY/PASS must cite its
// evidence: a log file (.log/.txt or a file under a *-logs/ directory) or a CI run id. A
// "Veredicto: READY" line is rejected while any row is UNVERIFIED, NOT READY or FAIL
// (noodara-release-gate: READY only with zero NOT READY and zero UNVERIFIED rows).
//
// Usage: node scripts/check-gate-doc.mjs [gate.md ...]   (default: docs/releases/v0.2-gate.md)
// Only `node:` builtins are imported.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_FILES = ['docs/releases/v0.2-gate.md'];

const STATUS_RE = /^(NOT READY|READY|PASS|FAIL|UNVERIFIED)\b/;
const PASSING_RE = /^(READY|PASS)\b/;
const UNMET_RE = /\b(UNVERIFIED|NOT READY|FAIL)\b/;
const DASHBOARD_RE = /^\S.*?\s{2,}((?:NOT READY|READY|PASS|FAIL|UNVERIFIED)\b.*)$/;
const EVIDENCE_RES = [
  /[\w./-]+\.(?:log|txt)\b/, // a log file
  /[\w.-]+-logs\/[\w./-]+/, // any file in a *-logs/ evidence directory
  /\bruns?\s+(?:id\s+)?#?\d{6,}/i, // "run 38606580357", "runs 123456 y ..."
  /actions\/runs\/\d+/, // a run URL
];

/** @param {string} text */
function clean(text) {
  return text.replace(/[*`]/g, '').trim();
}

/** @param {string} line */
function hasEvidence(line) {
  return EVIDENCE_RES.some((re) => re.test(line));
}

/** @param {string} line */
function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  if (/^\|[\s:|-]+\|$/.test(trimmed)) return null; // separator row
  return trimmed.slice(1, -1).split('|').map(clean);
}

/**
 * @param {string} markdown a release gate document
 * @returns {{ line: number, message: string }[]} problems; empty when the document is consistent
 */
export function checkGateDoc(markdown) {
  /** @type {{ line: number, message: string }[]} */
  const problems = [];
  /** @type {number[]} */
  const unmetLines = [];
  /** @type {number | undefined} */
  let readyVerdictLine;
  let inFence = false;
  let previousWasTable = false;

  markdown.split('\n').forEach((raw, index) => {
    const lineNo = index + 1;
    if (raw.trim().startsWith('```')) {
      inFence = !inFence;
      previousWasTable = false;
      return;
    }

    /** @type {string | undefined} */
    let status;
    if (inFence) {
      status = DASHBOARD_RE.exec(raw.trim())?.[1];
    } else {
      const verdict = /^(?:Veredicto|Verdict):\s*(.*)$/i.exec(raw.trim());
      if (verdict && PASSING_RE.test(clean(verdict[1] ?? ''))) readyVerdictLine = lineNo;

      const cells = tableCells(raw);
      const isHeader = cells !== null && !previousWasTable;
      previousWasTable = raw.trim().startsWith('|');
      if (cells === null || isHeader) return;
      status = cells.find((cell) => STATUS_RE.test(cell));
    }
    if (status === undefined) return;

    if (UNMET_RE.test(status)) unmetLines.push(lineNo);
    if (PASSING_RE.test(status) && !hasEvidence(raw)) {
      problems.push({ line: lineNo, message: 'row marked READY/PASS without a referenced log or run id' });
    }
  });

  if (readyVerdictLine !== undefined && unmetLines.length > 0) {
    problems.push({
      line: readyVerdictLine,
      message: `verdict READY while rows are UNVERIFIED, NOT READY or FAIL (lines ${unmetLines.join(', ')})`,
    });
  }
  return problems.sort((a, b) => a.line - b.line);
}

function main() {
  const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES;
  let failed = false;
  for (const file of files) {
    for (const problem of checkGateDoc(readFileSync(file, 'utf8'))) {
      console.error(`check-gate-doc: ${file}:${problem.line} ${problem.message}`);
      failed = true;
    }
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log(`check-gate-doc: ${files.join(', ')} ok`);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
