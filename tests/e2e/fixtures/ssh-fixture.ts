// The single definition of the Playwright-owned SSH fixture (35-04 A7). It lives in its own
// dependency-light module so a real Playwright process can load it without the full E2E stack:
// stack.ts pulls Postgres migrations, boot processes and apps/control-plane, whose workspace
// imports resolve through built `dist` outputs that a clean checkout (the CI unit job) does not
// have. stack.ts re-exports this exact `sshTest`, so critical-path/discovery keep the identical
// fixture. tests/unit/integration-helpers/ssh-fixture-module-graph.test.ts fails if this module's
// graph reaches apps/control-plane or any workspace dist again.
import { createSshdLifecycle, type SshdFixture, type StartSshdOptions, type SshdLifecycle } from '../../integration/helpers/ssh.js';
import { test as base } from '@playwright/test';

export type StartOwnedSshd = (options: StartSshdOptions) => Promise<SshdFixture>;

/** Playwright owns this fixture before test code awaits image build. Teardown runs on setup
 * failure and test timeout, including when no SshdFixture handle was ever returned. */
export const sshTest = base.extend<{ startOwnedSshd: StartOwnedSshd }>({
  startOwnedSshd: async ({}, use, testInfo) => {
    const began = performance.now();
    const owners: SshdLifecycle[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    try {
      await use((options) => {
        const owner = createSshdLifecycle(options);
        owners.push(owner);
        let startupTimer: ReturnType<typeof setTimeout> | undefined;
        // Read the current timeout at invocation: test.setTimeout may run inside the test.
        // This is the existing outer budget, not a new or increased startup budget.
        if (testInfo.timeout > 0) {
          const remaining = Math.max(0, testInfo.timeout - (performance.now() - began));
          startupTimer = setTimeout(() => owner.cancel(new Error('SSH fixture test deadline')), remaining);
          timers.push(startupTimer);
        }
        // The captured deadline bounds startup only. Once a handle is returned, the runner
        // owns its lifetime and may legitimately extend the test budget (discovery does).
        // Real timeout teardown still cancels and joins every registered owner below.
        return owner.result.finally(() => clearTimeout(startupTimer));
      });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const owner of owners) owner.cancel();
      const results = await Promise.allSettled(owners.map((owner) => owner.stop()));
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('SSH fixture cleanup unverified');
      }
    }
  },
});
