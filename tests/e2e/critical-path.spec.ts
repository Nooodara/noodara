// 05-20-PLAN.md Task 1 (QA-04): the whole roadmap §6.6 critical path -- login -> Servers -> add
// server -> connect -> discovery -> detail -- driven through the real UI against a real Ubuntu
// sshd Testcontainer, never a `page.route` stub. This is the one spec every other Phase 5 spec's
// own real-backend precedent (tests/e2e/discovery.spec.ts's `@ssh-live`, tests/e2e/host-key.spec.ts's
// UF-01 regression, tests/integration/routes/api-e2e.test.ts's HTTP-layer flow) converges into at
// the UI layer: one continuous, re-runnable journey, never a route-intercepted stand-in.
//
// The sshd fixture is started through `startCriticalPathSshd()`/`stopCriticalPathSshd()`
// (tests/e2e/fixtures/stack.ts) rather than calling `startSshd` directly: those wrappers register
// the live fixture on `stack.ts`'s own module-level handle so `stopStack`'s guarded teardown
// sequence (global-teardown.ts) tears it down as a safety net even if this test's own `finally`
// never runs (a hard crash mid-test) -- never a second, parallel container-lifecycle
// implementation of `tests/integration/helpers/ssh.ts`'s own `startSshd`.
//
// Re-runnable N times against a fresh or reused stack with zero state leakage between repetitions
// (the nightly's own ×20 requirement): every identifier below is derived from `Date.now()` (never
// a fixed literal), the sshd fixture is started and stopped entirely inside this one test, and the
// only shared state this test depends on -- the preseeded E2E admin -- is read-only.
import { expect, test, type Page } from '@playwright/test';
import { DISCOVERY_CHECK_IDS } from '@noodara/domain/discovery';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, startCriticalPathSshd, stopCriticalPathSshd } from './fixtures/stack.js';
import { readTestKey } from '../integration/helpers/ssh.js';

const RESOLVED_SEVERITIES = new Set(['pass', 'warning', 'fail', 'skipped', 'not_applicable']);
const PENDING_SEVERITIES = new Set(['pending', 'running']);
// The six discovery step ids (apps/web/src/lib/discovery-steps.ts's own DISCOVERY_STEP_NAMES) --
// duplicated here as a literal array (rather than importing that app-internal module from an E2E
// spec) since `page.addInitScript`'s callback runs inside the browser and can only close over
// values passed through its own serializable second argument.
const DISCOVERY_STEP_IDS = ['ssh_reachable', 'authenticated', 'os', 'resources', 'docker', 'access'] as const;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

/**
 * Installed before the first navigation (`addInitScript` re-runs on every subsequent navigation
 * too, but this spec never reloads mid-run). Two independent, purely observational instruments,
 * neither replacing anything the real app does:
 *
 * 1. A `MutationObserver` recording every distinct snapshot of all six `discovery-step-*`
 *    elements' own `data-severity` attribute -- the direct DOM evidence this task's behaviour
 *    needs: at least one snapshot with some steps resolved and at least one still
 *    pending/running.
 * 2. A subclassed `EventSource` recording every genuine `server.discovery_progress` frame's
 *    arrival time and check id, exactly like tests/e2e/discovery.spec.ts's own `@ssh-live`
 *    precedent -- the documented fallback for a run too fast for (1) to ever catch a mixed
 *    snapshot, and independent corroborating evidence either way.
 */
async function installDiscoveryInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(
    ({ stepIds }) => {
      const severitySnapshots: { at: number; severities: Record<string, string | null> }[] = [];
      (window as unknown as { __severitySnapshots: typeof severitySnapshots }).__severitySnapshots = severitySnapshots;

      function captureSeverities(): void {
        const severities: Record<string, string | null> = {};
        let sawAny = false;
        for (const stepId of stepIds) {
          const el = document.querySelector(`[data-testid="discovery-step-${stepId}"]`);
          if (el === null) continue;
          sawAny = true;
          severities[stepId] = el.getAttribute('data-severity');
        }
        if (!sawAny) return;
        severitySnapshots.push({ at: performance.now(), severities });
      }

      const observer = new MutationObserver(captureSeverities);
      function startObserving(): void {
        captureSeverities();
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-severity'] });
      }
      if (document.body !== null) {
        startObserving();
      } else {
        document.addEventListener('DOMContentLoaded', startObserving);
      }

      const progressEvents: { receivedAt: number; checkId: string }[] = [];
      (window as unknown as { __progressEvents: typeof progressEvents }).__progressEvents = progressEvents;
      const NativeEventSource = window.EventSource;
      class InstrumentedEventSource extends NativeEventSource {
        constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
          super(url, eventSourceInitDict);
          this.addEventListener('server.discovery_progress', (event) => {
            try {
              const data = JSON.parse((event as MessageEvent<string>).data) as { check?: { id?: string } };
              if (typeof data.check?.id === 'string') {
                progressEvents.push({ receivedAt: performance.now(), checkId: data.check.id });
              }
            } catch {
              // Malformed frame -- irrelevant to this instrumentation, the real parser handles it.
            }
          });
        }
      }
      window.EventSource = InstrumentedEventSource;
    },
    { stepIds: DISCOVERY_STEP_IDS },
  );
}

interface SeveritySnapshot {
  readonly at: number;
  readonly severities: Record<string, string | null>;
}

function hasMixedSnapshot(snapshots: readonly SeveritySnapshot[]): boolean {
  return snapshots.some((snapshot) => {
    const values = Object.values(snapshot.severities);
    const hasResolved = values.some((v) => v !== null && RESOLVED_SEVERITIES.has(v));
    const hasPending = values.some((v) => v !== null && PENDING_SEVERITIES.has(v));
    return hasResolved && hasPending;
  });
}

/**
 * Asserts genuine live per-check progress reached the browser during one discovery run, clearing
 * both instruments first so a second run (the re-run-discovery behaviour below) gets its own,
 * uncontaminated evidence. Prefers the direct DOM mixed-snapshot proof; falls back to the SSE
 * frame-sequence proof (documented, never silently substituting a weaker "it eventually shows six
 * passes" assertion) only when the run settled too fast for any intermediate DOM snapshot to be
 * observable -- logged either way so a human reading the run's own output knows which held.
 */
async function assertLiveProgress(page: Page, label: string): Promise<void> {
  const severitySnapshots = await page.evaluate(
    () => (window as unknown as { __severitySnapshots: SeveritySnapshot[] }).__severitySnapshots,
  );
  if (hasMixedSnapshot(severitySnapshots)) {
    console.log(`[critical-path] ${label}: direct DOM mixed resolved/pending snapshot observed (${String(severitySnapshots.length)} snapshots captured).`);
    return;
  }

  const progressEvents = await page.evaluate(
    () => (window as unknown as { __progressEvents: { receivedAt: number; checkId: string }[] }).__progressEvents,
  );
  const distinctArrivals = new Set(progressEvents.map((e) => e.receivedAt)).size;
  console.log(
    `[critical-path] ${label}: no mixed DOM snapshot observed (run settled too fast) -- falling back to the SSE ` +
      `frame-sequence proof: ${String(progressEvents.length)} frames, ${String(distinctArrivals)} distinct arrival times.`,
  );
  expect(progressEvents.map((e) => e.checkId)).toEqual([...DISCOVERY_CHECK_IDS]);
  expect(distinctArrivals).toBeGreaterThan(1);
}

async function resetInstrumentation(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __severitySnapshots: unknown[] }).__severitySnapshots = [];
    (window as unknown as { __progressEvents: unknown[] }).__progressEvents = [];
  });
}

test('@critical the whole roadmap SS6.6 flow: login -> Servers -> add server -> connect -> live discovery -> detail, against a real sshd container', async ({
  page,
}) => {
  test.setTimeout(180_000);

  const sshd = await startCriticalPathSshd();

  try {
    await installDiscoveryInstrumentation(page);

    // 1. Sign in as the preseeded admin; land on Servers.
    await login(page);

    // 2. Open the add sheet and fill it with the real sshd container's own host, mapped port, ssh
    // user (`deployer` -- docker-group member with passwordless sudo, so every SERV-08 discovery
    // check genuinely passes, per tests/integration/images/sshd-common/setup-users.sh) and a real
    // ed25519 private key read straight from the container's own `/keys` (never a repository
    // literal, matching every other real-ssh spec's own discipline).
    const serverName = `critical-${String(Date.now())}`;
    const privateKey = await readTestKey(sshd, 'ed25519');

    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page.getByTestId('server-sheet')).toBeVisible();

    await page.getByLabel('Name').fill(serverName);
    await page.getByLabel('Host').fill(sshd.host);
    await page.getByLabel('SSH port').fill(String(sshd.port));
    await page.getByLabel('SSH user').fill('deployer');
    // Private key is the sheet's own default-selected credential type (server-sheet.spec.ts's own
    // "Private key preselected" precedent) -- no radio click needed.
    await page.getByLabel('Private key').fill(privateKey);

    // 3. Save and connect -- lands on the new server's detail page, the same, already-mounted page
    // instance stays open from here through both discovery runs below (no reload anywhere in this
    // test): if the live SSE pipeline were broken, this page would stay stuck on its initial
    // CONNECTING/pending render forever.
    await page.getByTestId('server-sheet-save-connect').click();
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { name: serverName })).toBeVisible();

    // 4. The Discovery section auto-expands while CONNECTING (05-18's own DiscoverySection
    // behaviour) -- assert live, per-check progress genuinely reached this page before settlement.
    await assertLiveProgress(page, 'first run');

    // 5. Settle: Connected pill, six steps, the settled one-line summary.
    await expect(page.getByTestId('status-pill')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 60_000 });
    await expect(page.getByTestId('discovery-summary')).toBeVisible();
    await expect(page.getByTestId('discovery-summary')).toContainText('Discovered');
    for (const stepId of ['ssh_reachable', 'authenticated', 'os', 'resources', 'docker', 'access']) {
      await expect(page.getByTestId(`discovery-step-${stepId}`)).toBeVisible();
    }
    // deployer is in the docker group with passwordless sudo -- every SERV-08 check genuinely
    // passes, proving this run's real, per-server facts (not fabricated ones) reached the browser.
    await expect(page.getByTestId('discovery-step-access')).toHaveAttribute('data-severity', 'pass');
    await expect(page.getByTestId('discovery-step-docker')).toHaveAttribute('data-severity', 'pass');

    // 6. Real discovered facts on the detail page -- a non-placeholder hostname, an OS value, a
    // CPU core count, a RAM value, a disk used-of-total value and an uptime value, each with an
    // "as of" caption (ServerFacts.tsx).
    const systemGroup = page.getByTestId('server-facts-system');
    const hostnameValue = await systemGroup.locator('[data-mono="true"]').first().innerText();
    expect(hostnameValue).not.toBe('—');
    expect(hostnameValue.length).toBeGreaterThan(0);
    await expect(systemGroup).toContainText('as of');

    await expect(page.getByTestId('server-fact-cpu-cores')).not.toContainText('—');
    await expect(page.getByTestId('server-fact-cpu-cores')).toContainText('as of');
    await expect(page.getByTestId('server-fact-ram')).not.toContainText('—');
    await expect(page.getByTestId('server-fact-ram')).toContainText('as of');
    await expect(page.getByTestId('server-fact-disk')).toContainText('of');
    await expect(page.getByTestId('server-fact-disk')).toContainText('as of');
    await expect(page.getByTestId('server-fact-uptime')).not.toContainText('—');
    await expect(page.getByTestId('server-fact-uptime')).toContainText('as of');

    // 7. The Connection group's permanent host fingerprint row -- mono, with its own copy button
    // (05-19's TOFU surfaces own the first-trust notice; this is the permanent row DETL-01 itself
    // owns).
    const connectionGroup = page.getByTestId('server-facts-connection');
    await expect(connectionGroup.locator('[data-mono="true"]', { hasText: 'SHA256:' })).toBeVisible();
    await expect(connectionGroup.getByRole('button', { name: 'Copy Host fingerprint' })).toBeVisible();

    // 8. Activity log: creation, connection attempt and discovery completion, each a real
    // sentence, newest first.
    await page.goto('/activity');
    const createdRow = page.getByTestId('activity-row').filter({ hasText: `added server ${serverName}` });
    const connectedRow = page.getByTestId('activity-row').filter({ hasText: `connected ${serverName}` });
    const discoveredRow = page.getByTestId('activity-row').filter({ hasText: `Discovery completed for ${serverName}` });
    await expect(createdRow).toBeVisible();
    await expect(connectedRow).toBeVisible();
    await expect(discoveredRow).toBeVisible();

    const rows = page.getByTestId('activity-row');
    const rowCount = await rows.count();
    const rowTexts: string[] = [];
    for (let i = 0; i < rowCount; i += 1) {
      rowTexts.push((await rows.nth(i).innerText()).trim());
    }
    const discoveredIndex = rowTexts.findIndex((text) => text.includes(`Discovery completed for ${serverName}`));
    const connectedIndex = rowTexts.findIndex((text) => text.includes(`connected ${serverName}`));
    const createdIndex = rowTexts.findIndex((text) => text.includes(`added server ${serverName}`));
    expect(discoveredIndex).toBeGreaterThanOrEqual(0);
    expect(connectedIndex).toBeGreaterThan(discoveredIndex);
    expect(createdIndex).toBeGreaterThan(connectedIndex);

    // 9. Back to detail: re-run discovery produces a second live run that settles again.
    await page.goto('/servers');
    const row = page.getByTestId('servers-row').filter({ hasText: serverName });
    await row.getByRole('link').click();
    await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/);
    await expect(page.getByTestId('status-pill')).toHaveAttribute('data-status', 'CONNECTED');

    await resetInstrumentation(page);
    await page.getByTestId('discovery-rerun-button').click();

    await assertLiveProgress(page, 'second run (re-run discovery)');
    await expect(page.getByTestId('status-pill')).toHaveAttribute('data-status', 'CONNECTED', { timeout: 60_000 });
    await expect(page.getByTestId('discovery-summary')).toContainText('Discovered');
  } finally {
    // 10. Teardown -- idempotent alongside stack.ts's own stopStack safety net (stopCriticalPathSshd
    // no-ops if this already ran); leaves no `noodara.test=true` container.
    await stopCriticalPathSshd();
  }
});
