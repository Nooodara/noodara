#!/usr/bin/env node
// The `noodara` operator CLI (D-03, D-11). `env.js` is imported first, exactly like `server.ts`
// does for the api, so a misconfigured environment fails the same fail-fast way here — before any
// database connection is attempted (INST-06).
import '../env.js';

import { Command } from 'commander';
import { appRedactor } from '../activity/redaction.js';
import { getDb } from '../db/client.js';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { adminResetCommand } from './admin-reset.js';
import { secretsRotateCommand } from './secrets-rotate.js';

/** Never echoes a raw error's message verbatim: routes it through the shared app redactor first,
 *  so a `postgres://user:pass@host` connection string embedded in a driver error can never reach
 *  the operator's terminal — this CLI runs with full database access and both master keys in its
 *  environment. */
function printCliError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`noodara: ${context} failed: ${appRedactor.redact(message)}\n`);
}

export const program = new Command();
program.name('noodara').description('Noodara control-plane operator CLI');

const adminCommand = program.command('admin').description('Admin account operations');
adminCommand
  .command('reset')
  .description('Issue a one-time recovery token for the existing admin (D-03)')
  .action(async () => {
    try {
      const db = await getDb();
      const logger = createLogger();
      const exitCode = await adminResetCommand({
        db,
        logger: {
          error: (msg: string) => {
            logger.error(msg);
          },
        },
      });
      process.exitCode = exitCode;
    } catch (err) {
      printCliError('admin reset', err);
      process.exitCode = 1;
    }
  });

const secretsCommand = program.command('secrets').description('Master-key secret operations');
secretsCommand
  .command('rotate')
  .description('Re-encrypt every credential row under the new master key (D-11)')
  .action(async () => {
    try {
      const db = await getDb();
      const logger = createLogger();
      const exitCode = await secretsRotateCommand({
        db,
        env,
        logger: {
          error: (msg: string) => {
            logger.error(msg);
          },
          info: (msg: string) => {
            logger.info(msg);
          },
        },
      });
      process.exitCode = exitCode;
    } catch (err) {
      printCliError('secrets rotate', err);
      process.exitCode = 1;
    }
  });

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  void program.parseAsync(process.argv);
}
