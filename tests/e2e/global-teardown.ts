// Playwright `globalTeardown`: reads back the handle global-setup.ts wrote and stops the stack.
// The real teardown work happens against `stack.ts`'s own module-level singleton (see
// global-setup.ts's header comment) — the JSON file's contents are passed through mainly as a
// sanity check and so this file's own contract ("read the handle back") is genuinely honoured
// rather than silently relying on shared module state alone.
import { readFileSync } from 'node:fs';
import { stopStack, type Stack } from './fixtures/stack.js';
import { STACK_HANDOFF_PATH } from './global-setup.js';

export default async function globalTeardown(): Promise<void> {
  let stack: Stack;
  try {
    stack = JSON.parse(readFileSync(STACK_HANDOFF_PATH, 'utf8')) as Stack;
  } catch {
    // No handoff file — global-setup.ts never got past `startStack()` (which already tears down
    // anything it started before rethrowing, per its own half-start guarantee). Nothing to do.
    return;
  }
  await stopStack(stack);
}
