// Playwright `globalSetup`: starts the real stack (fixtures/stack.ts) exactly once before any
// spec runs. `stack.ts` itself keeps the live process/container handles in a module-level
// singleton (global-setup.ts and global-teardown.ts are both loaded via plain require/import in
// the same runner process, never a forked child) — this file additionally persists the
// serializable parts (base URL, admin credentials) to a JSON file under Playwright's output
// directory, so a crashed run still leaves a debuggable record and global-teardown.ts has
// something concrete to read back per its own contract.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startStack } from './fixtures/stack.js';

export const STACK_HANDOFF_PATH = path.join(process.cwd(), 'test-results', 'e2e-stack.json');

export default async function globalSetup(): Promise<void> {
  const stack = await startStack();

  mkdirSync(path.dirname(STACK_HANDOFF_PATH), { recursive: true });
  writeFileSync(STACK_HANDOFF_PATH, JSON.stringify(stack, null, 2), 'utf8');
}
