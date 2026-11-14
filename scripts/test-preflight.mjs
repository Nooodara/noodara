#!/usr/bin/env node
// `pnpm test:doctor [--tier unit|integration|e2e]` (36-03): read-only report of what the chosen
// test tier needs on this machine. All logic lives in test-preflight-lib.mjs; this file only wires
// argv, the real probes and stdout. Exit codes: 0 ok, 1 hard prerequisite missing, 2 usage error.

import {
  EXIT_OK,
  EXIT_USAGE,
  USAGE,
  createHostProbes,
  exitCodeFor,
  formatReport,
  parseArgs,
  runPreflight,
} from './test-preflight-lib.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.ok) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(EXIT_USAGE);
}
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(EXIT_OK);
}

const report = await runPreflight({ tier: args.tier, probes: createHostProbes(), env: process.env });
const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
process.stdout.write(`${formatReport(report, { color })}\n`);
process.exit(exitCodeFor(report));
