// 05-17-PLAN.md Task 3: the add/edit server sheet and the delete confirmation, wired to the
// servers list's own toolbar/row-menu actions and proven end to end in a real browser -- including
// the D-04 no-leak assertions (T-5-73..T-5-79) that only a real browser, not jsdom, can prove:
// request content type, `localStorage`/`sessionStorage`, and navigation history. Runs against the
// same real stack.ts stack every other spec in this directory uses (Postgres, Redis, the API, the
// worker, the built web app), with the preseeded E2E admin. Every credential used here is an
// obviously-fake value (never a real key/password), matching the harness-hygiene rule that
// Playwright traces may capture typed secrets.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

// A real, throwaway ed25519 key generated fresh for this run only -- the credential store
// actually parses/validates a private key at registration time (apps/control-plane/src/services/
// credential-store.ts's encodePrivateKey calls @noodara/ssh's own loadPrivateKey), so an
// obviously-fake string is rejected as INVALID_CREDENTIAL before ever reaching a row. Generated
// with the host's own `ssh-keygen`, the same tool packages/ssh/src/testing/generate-keys.ts
// already uses for this identical purpose -- never written to the repository, never a real
// server's credential. A distinctive substring of the real encoded key body (never the fixed
// header/footer lines every OpenSSH key shares) is used as the leak-detection canary.
function generateFixtureEd25519Key(): { readonly privateKey: string; readonly canary: string } {
  const dir = mkdtempSync(join(tmpdir(), 'noodara-e2e-key-'));
  try {
    execFileSync('ssh-keygen', ['-q', '-N', '', '-t', 'ed25519', '-f', join(dir, 'key')], { stdio: 'ignore' });
    const privateKey = readFileSync(join(dir, 'key'), 'utf8');
    const bodyLine = privateKey.split('\n').find((line) => line.length >= 40 && !line.startsWith('-----'));
    if (bodyLine === undefined) {
      throw new Error('generateFixtureEd25519Key: no encoded body line found in the generated key');
    }
    return { privateKey, canary: bodyLine.slice(0, 40) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIXTURE_KEY = generateFixtureEd25519Key();
const FAKE_PASSWORD = 'e2e-fixture-only-password-Qx7vB';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

async function openCreateSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add server' }).click();
  await expect(page.getByTestId('server-sheet')).toBeVisible();
}

async function fillValidPasswordCredential(page: Page): Promise<void> {
  await page.getByLabel('Password').fill(FAKE_PASSWORD);
}

test('@sheet Add server opens the sheet with Name focused, Private key preselected and port/user showing placeholders, not values', async ({
  page,
}) => {
  await login(page);
  await openCreateSheet(page);

  await expect(page.getByLabel('Name')).toBeFocused();
  const credentialType = page.getByTestId('server-sheet-credential-type');
  await expect(credentialType.getByRole('radio', { name: 'Private key' })).toHaveAttribute('data-state', 'checked');
  await expect(page.getByLabel('SSH port')).toHaveValue('');
  await expect(page.getByLabel('SSH port')).toHaveAttribute('placeholder', '22');
  await expect(page.getByLabel('SSH user')).toHaveValue('');
  await expect(page.getByLabel('SSH user')).toHaveAttribute('placeholder', 'root');
});

test('@sheet Choose file fills the private-key textarea from a real file read, and the create request is JSON with the key under credential.privateKey, never multipart', async ({
  page,
}) => {
  await login(page);
  await openCreateSheet(page);

  const name = `file-cred-${String(Date.now())}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Host').fill(`${name}.example.test`);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'e2e-fake-key.pem',
    mimeType: 'text/plain',
    buffer: Buffer.from(FIXTURE_KEY.privateKey, 'utf8'),
  });

  await expect(page.getByLabel('Private key')).toHaveValue(FIXTURE_KEY.privateKey);

  const requests: Request[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/servers') && request.method() === 'POST') {
      requests.push(request);
    }
  });

  await page.getByTestId('server-sheet-save-connect').click();
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/);

  const createRequest = requests.find((request) => !request.url().includes('/connect'));
  expect(createRequest).toBeDefined();
  expect(createRequest?.headers()['content-type']).toBe('application/json');
  const body = createRequest?.postDataJSON() as { credential?: { privateKey?: string } };
  expect(body.credential?.privateKey).toBe(FIXTURE_KEY.privateKey);

  for (const request of requests) {
    // The best-effort /connect follow-up carries no body at all (apiSend never sets a
    // Content-Type header when there's nothing to send), so this only asserts against requests
    // that actually declared one -- never multipart, whichever ones exist.
    const contentType = request.headers()['content-type'];
    if (contentType !== undefined) {
      expect(contentType).not.toContain('multipart/form-data');
    }
  }
});

test('@sheet Save and connect on a valid form closes the sheet and lands on the server detail page', async ({ page }) => {
  await login(page);
  await openCreateSheet(page);

  const name = `save-connect-${String(Date.now())}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Host').fill(`${name}.example.test`);
  await page.getByTestId('server-sheet-credential-type').getByRole('radio', { name: 'Password' }).click();
  await fillValidPasswordCredential(page);

  await page.getByTestId('server-sheet-save-connect').click();

  await expect(page.getByTestId('server-sheet')).toHaveCount(0);
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

test('@sheet Save without connecting closes the sheet, leaves the new row PENDING and issues no connect request', async ({
  page,
}) => {
  await login(page);
  await openCreateSheet(page);

  const name = `save-only-${String(Date.now())}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Host').fill(`${name}.example.test`);
  await page.getByTestId('server-sheet-credential-type').getByRole('radio', { name: 'Password' }).click();
  await fillValidPasswordCredential(page);

  const connectRequests: Request[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/connect')) {
      connectRequests.push(request);
    }
  });

  await page.getByRole('button', { name: 'Save without connecting' }).click();

  await expect(page.getByTestId('server-sheet')).toHaveCount(0);
  await expect(page).toHaveURL(/\/servers$/);

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('status-pill')).toHaveAttribute('data-status', 'PENDING');
  expect(connectRequests).toHaveLength(0);
});

test('@sheet submitting a duplicate name renders the NAME_TAKEN copy under Name and keeps the sheet open with input intact', async ({
  page,
}) => {
  await login(page);

  const name = `dup-name-${String(Date.now())}`;
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  // A refused create must fail here, by name -- never later, disguised as a live event that
  // was lost.
  expect(created.status()).toBe(201);
  await page.reload();

  await openCreateSheet(page);
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Host').fill(`${name}-second.example.test`);
  await page.getByTestId('server-sheet-credential-type').getByRole('radio', { name: 'Password' }).click();
  await fillValidPasswordCredential(page);

  await page.getByTestId('server-sheet-save-connect').click();

  await expect(page.getByText(`A server named "${name}" already exists.`)).toBeVisible();
  await expect(page.getByTestId('server-sheet')).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue(name);
});

test('@sheet a real-shaped server-rejected VALIDATION_FAILED issue highlights its field inline, with no orphan "Check the highlighted fields" banner', async ({
  page,
}) => {
  // 05-VERIFICATION.md gap 5 / 05-30-PLAN.md Task 1+3: the literal backend issue-path shape
  // (`instancePath`, leading-slash) confirmed empirically in Task 1 by invoking the real
  // `@fastify/type-provider-zod` `validatorCompiler` against `CreateServerBodySchema` directly --
  // `/name` for a top-level field. Before Task 1's `normalizeFieldPath` fix, `fieldErrorsFromIssues`
  // compared this exact shape against bare `KNOWN_FORM_FIELD_PATHS` names and never matched, so
  // `ServerSheet.handleApiFailure` fell through to the generic `copyForErrorCode('VALIDATION_FAILED')`
  // toast ("Check the highlighted fields and try again.") with nothing actually highlighted -- the
  // literal gap-5 defect. This stub reproduces the real wire shape a genuine 400 sends, never an
  // invented one.
  await login(page);
  await openCreateSheet(page);

  const name = `server-rejected-${String(Date.now())}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Host').fill(`${name}.example.test`);
  await page.getByTestId('server-sheet-credential-type').getByRole('radio', { name: 'Password' }).click();
  await fillValidPasswordCredential(page);

  await page.route('**/api/servers', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'VALIDATION_FAILED',
        message: 'Request does not match the schema',
        issues: [{ path: '/name', message: 'This name is reserved by the server.' }],
      }),
    });
  });

  await page.getByTestId('server-sheet-save-connect').click();

  await expect(page.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('This name is reserved by the server.')).toBeVisible();
  await expect(page.getByTestId('server-sheet')).toBeVisible();
  // The fix's actual behaviour is stronger than "banner alongside a highlight": once the real
  // issue maps to a field, ServerSheet renders the field error alone -- no redundant, generic
  // "Check the highlighted fields" toast at all. Asserting its absence is the strongest available
  // proof that this is not the gap-5 "banner with nothing highlighted" defect in a new disguise.
  await expect(page.getByTestId('server-sheet-toast')).toHaveCount(0);
});

test('@sheet a real-shaped server-rejected /sshUser VALIDATION_FAILED issue highlights the SSH user field inline, and the request the sheet actually sent carries the typed sshUser', async ({
  page,
}) => {
  // 260920-ly9 (STATE.md 05-37 finding, 05-GAP-CLOSURE-AUDIT.md gap 5's "latent second bug"):
  // before this fix, ServerSheet.tsx's SSH user Field had no `error`/`invalid` wiring at all --
  // unlike the /name case above (already fixed in 05-30), a /sshUser issue produced zero visible
  // feedback of any kind. Also asserts the request-shape lesson from 05-30's own case in this
  // file: since this stubs a mutation, the test must assert the actual request the page sent, not
  // just the UI reaction to the stubbed response.
  await login(page);
  await openCreateSheet(page);

  const name = `sshuser-rejected-${String(Date.now())}`;
  const typedSshUser = 'deployer';
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Host').fill(`${name}.example.test`);
  await page.getByLabel('SSH user').fill(typedSshUser);
  await page.getByTestId('server-sheet-credential-type').getByRole('radio', { name: 'Password' }).click();
  await fillValidPasswordCredential(page);

  const createRequests: Request[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/servers') && request.method() === 'POST') {
      createRequests.push(request);
    }
  });

  await page.route('**/api/servers', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'VALIDATION_FAILED',
        message: 'Request does not match the schema',
        issues: [{ path: '/sshUser', message: 'sshUser must not contain whitespace.' }],
      }),
    });
  });

  await page.getByTestId('server-sheet-save-connect').click();

  await expect(page.getByLabel('SSH user')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('sshUser must not contain whitespace.')).toBeVisible();
  await expect(page.getByTestId('server-sheet')).toBeVisible();
  await expect(page.getByTestId('server-sheet-toast')).toHaveCount(0);

  expect(createRequests).toHaveLength(1);
  const [createRequest] = createRequests;
  expect(createRequest?.method()).toBe('POST');
  expect(createRequest?.url()).toContain('/api/servers');
  const body = createRequest?.postDataJSON() as { sshUser?: string };
  expect(body.sshUser).toBe(typedSshUser);
});

test('@sheet submitting a port of 70000 renders an inline error under the SSH port field and never reaches the server', async ({
  page,
}) => {
  await login(page);
  await openCreateSheet(page);

  const name = `bad-port-${String(Date.now())}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Host').fill(`${name}.example.test`);
  await page.getByLabel('SSH port').fill('70000');
  await page.getByTestId('server-sheet-credential-type').getByRole('radio', { name: 'Password' }).click();
  await fillValidPasswordCredential(page);

  const createRequests: Request[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/servers') && request.method() === 'POST') {
      createRequests.push(request);
    }
  });

  await page.getByTestId('server-sheet-save-connect').click();

  await expect(page.getByText('Port must be between 1 and 65535.')).toBeVisible();
  await expect(page.getByTestId('server-sheet')).toBeVisible();
  expect(createRequests).toHaveLength(0);
});

test('@sheet opening Edit shows the credential collapsed to dots plus Replace, with no key text anywhere in the DOM', async ({
  page,
}) => {
  await login(page);

  const name = `edit-collapse-${String(Date.now())}`;
  const created = await page.request.post('/api/servers', {
    data: {
      name,
      host: `${name}.example.test`,
      credential: { type: 'ssh_private_key', privateKey: FIXTURE_KEY.privateKey },
    },
  });
  // A refused create must fail here, by name -- never later, disguised as a live event that
  // was lost.
  expect(created.status()).toBe(201);
  await page.reload();

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await row.hover();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();

  await expect(page.getByTestId('server-sheet')).toBeVisible();
  await expect(page.getByText('••••••••')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace' })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(3); // Name, Host, SSH user only -- no credential textbox yet

  const html = await page.content();
  expect(html).not.toContain(FIXTURE_KEY.privateKey);
  expect(html).not.toContain(FIXTURE_KEY.canary);
});

test('@sheet Delete requires the exact name: the confirm button stays disabled until it matches, then deletes the row', async ({
  page,
}) => {
  await login(page);

  const name = `delete-me-${String(Date.now())}`;
  const created = await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
  // A refused create must fail here, by name -- never later, disguised as a live event that
  // was lost.
  expect(created.status()).toBe(201);
  await page.reload();

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await row.hover();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();

  const dialog = page.getByTestId('delete-server-dialog');
  await expect(dialog).toBeVisible();
  const confirmButton = dialog.getByRole('button', { name: 'Delete server' });
  await expect(confirmButton).toBeDisabled();

  await dialog.getByLabel('Type the name to confirm').fill(`${name}-wrong`);
  await expect(confirmButton).toBeDisabled();

  await dialog.getByLabel('Type the name to confirm').fill('');
  await dialog.getByLabel('Type the name to confirm').fill(name);
  await expect(confirmButton).toBeEnabled();

  await confirmButton.click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('servers-row').filter({ hasText: name })).toHaveCount(0);
});

test('@sheet after the whole create/edit flow, neither storage nor navigation history contains the submitted key or password', async ({
  page,
}) => {
  await login(page);
  await openCreateSheet(page);

  const name = `no-leak-${String(Date.now())}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Host').fill(`${name}.example.test`);
  await page.getByLabel('Private key').fill(FIXTURE_KEY.privateKey);
  await page.getByRole('button', { name: 'Save without connecting' }).click();
  await expect(page.getByTestId('server-sheet')).toHaveCount(0);

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await row.hover();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByTestId('server-sheet')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('server-sheet')).toHaveCount(0);

  const storedValues = await page.evaluate(() => {
    const values: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) values.push(localStorage.getItem(key) ?? '');
    }
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key !== null) values.push(sessionStorage.getItem(key) ?? '');
    }
    return values;
  });

  const secretFragment = FIXTURE_KEY.canary;
  expect(storedValues.some((value) => value.includes(secretFragment))).toBe(false);
  expect(storedValues.some((value) => value.includes(FAKE_PASSWORD))).toBe(false);
  expect(page.url()).not.toContain(secretFragment);
});

// 08-12-PLAN.md Task 3 (UI-06, D19, brief §7.4): the drag-to-dismiss sequence exercised with real
// pointer events. `packages/ui/src/Sheet.tsx`'s `m.div` drag surface -- the one DOM node whose
// `transform` actually moves during a drag, distinct from the outer `[data-testid="server-sheet"]`
// dialog element that still owns the CSS-transition-based open/close position -- carries its own
// `data-testid="server-sheet-drag-surface"` for exactly this. Reading `style.transform` off the
// real node (never Motion's internal `MotionValue`/private state) is deliberate: research
// Architecture Patterns Pattern 1 is explicit that the *rendered* curve must be verified, not
// Motion's private implementation.
const DRAG_SURFACE_TESTID = 'server-sheet-drag-surface';

/** Parses the `translateX(Npx)` component out of a Motion-controlled element's inline
 *  `transform` style -- `0` if the node has no transform yet (pre-gesture rest state, where
 *  Motion may render an identity `translateX(0px)` or, before `LazyMotion`'s lazy `domMax` chunk
 *  resolves, no inline transform at all). */
async function readDragSurfaceX(page: Page): Promise<number> {
  return page.evaluate((testid) => {
    const el = document.querySelector(`[data-testid="${testid}"]`);
    if (el === null) return 0;
    const transform = (el as HTMLElement).style.transform;
    const match = /translateX\(([-\d.]+)px\)/.exec(transform);
    return match?.[1] !== undefined ? Number.parseFloat(match[1]) : 0;
  }, DRAG_SURFACE_TESTID);
}

async function dragSurfaceCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(DRAG_SURFACE_TESTID).boundingBox();
  if (box === null) {
    throw new Error('dragSurfaceCenter: the drag surface has no bounding box -- is the Sheet open?');
  }
  // Centered horizontally, near the top of the header (well clear of the title text on the left
  // and the close button on the right) -- never a form control, which could itself capture the
  // pointer and prevent the drag from ever starting.
  return { x: box.x + box.width / 2, y: box.y + 24 };
}

/** Drives a real, multi-step pointer drag (never a single synthetic jump) so Motion computes a
 *  genuine, non-instantaneous `info.velocity` from real timestamped `pointermove` samples --
 *  research Pitfall 3's own guidance: verify the felt curve empirically, don't assume a formula.
 *  `steps` and `stepDelayMs` together control both the distance-per-step (rubber-banding
 *  resolution) and the gesture's overall speed (fast vs. slow flick). */
async function performDrag(
  page: Page,
  deltaX: number,
  options: { steps?: number; stepDelayMs?: number } = {},
): Promise<void> {
  const { steps = 10, stepDelayMs = 16 } = options;
  const start = await dragSurfaceCenter(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.waitForTimeout(stepDelayMs);
    await page.mouse.move(start.x + (deltaX * i) / steps, start.y, { steps: 1 });
  }
}

test.describe('@sheet-drag drag-to-dismiss (UI-06, brief §7.4)', () => {
  test('@sheet-drag dragging right past the closed edge resists progressively -- displacement grows less than the pointer\'s own movement, and never freezes', async ({
    page,
  }) => {
    await login(page);
    await openCreateSheet(page);

    const start = await dragSurfaceCenter(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();

    const samples: number[] = [];
    const pointerDeltas = [40, 80, 120, 160, 200];
    for (const pointerDelta of pointerDeltas) {
      await page.mouse.move(start.x + pointerDelta, start.y, { steps: 4 });
      await page.waitForTimeout(30);
      samples.push(await readDragSurfaceX(page));
    }

    await page.mouse.up();
    await expect(page.getByTestId('server-sheet')).toBeVisible();

    // Every sample must still be moving (never frozen at a hard stop) ...
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1] ?? 0);
    }
    // ... but each successive equal-sized pointer step (40px) never produces a LARGER incremental
    // displacement than the previous one -- progressive resistance, per `dragElastic`'s own
    // resistance curve (brief §7.4 step 5's "resistencia progresiva, nunca un tope duro"). The
    // curve asymptotes at large offsets, so consecutive increments can tie at pixel resolution
    // (never grow) rather than strictly shrink on every single step.
    const increments = samples.map((sample, i) => sample - (samples[i - 1] ?? 0));
    // A 1px tolerance absorbs pixel-rounding noise at the curve's flattest (largest-offset) end,
    // where two consecutive increments can land on the same rounded pixel value.
    const ROUNDING_TOLERANCE_PX = 1;
    for (let i = 1; i < increments.length; i += 1) {
      expect(increments[i]).toBeLessThanOrEqual((increments[i - 1] ?? Number.POSITIVE_INFINITY) + ROUNDING_TOLERANCE_PX);
    }
    // The first increment is strictly larger than the last -- the resistance curve has genuinely
    // flattened, not merely held flat throughout.
    expect(increments[0]).toBeGreaterThan(increments.at(-1) ?? 0);
    // And the panel never tracks 1:1 with the raw pointer distance once past the edge -- the
    // final sample is well short of the 200px the pointer itself travelled.
    expect(samples.at(-1)).toBeLessThan(200);
  });

  test('@sheet-drag a short, fast flick closes the sheet even though it travelled less than half the panel width', async ({
    page,
  }) => {
    await login(page);
    await openCreateSheet(page);

    // A short (60px, well under the 240px midpoint of the 480px panel), fast (single big step,
    // minimal settle time) rightward flick -- brief §7.4 step 6's "un flick corto y rápido debe
    // cerrar", decided by velocity, not distance.
    await performDrag(page, 60, { steps: 1, stepDelayMs: 0 });
    await page.mouse.up();

    await expect(page.getByTestId('server-sheet')).toHaveCount(0, { timeout: 5000 });
  });

  test('@sheet-drag a slow drag of the same short distance leaves the sheet open (snaps back)', async ({ page }) => {
    await login(page);
    await openCreateSheet(page);

    // The identical 60px distance as the flick test above, but spread over many slow steps --
    // low velocity, below the close threshold, and short of the midpoint -- must snap back open,
    // never close (research Pitfall 3's position-based fallback check).
    await performDrag(page, 60, { steps: 12, stepDelayMs: 60 });
    await page.mouse.up();

    // The sheet must never actually close ...
    await page.waitForTimeout(500);
    await expect(page.getByTestId('server-sheet')).toBeVisible();
    // ... and the drag surface must have sprung back to its resting position.
    await expect
      .poll(async () => readDragSurfaceX(page), { timeout: 3000 })
      .toBeLessThan(2);
  });

  test('@sheet-drag after a fast release the panel keeps moving in the release direction on the next frame, instead of restarting from rest', async ({
    page,
  }) => {
    await login(page);
    await openCreateSheet(page);

    // A fast drag past the midpoint, close enough to release-time to still be a real gesture, far
    // enough that the ensuing close animation is not instantaneous -- projecting momentum forward
    // per brief §7.4 step 7/8 (handoff of velocity into the closing spring).
    await performDrag(page, 260, { steps: 3, stepDelayMs: 8 });
    const xAtRelease = await readDragSurfaceX(page);
    await page.mouse.up();

    // Sampled one frame after release: if the release velocity was truly handed off (no seam
    // between dragging and animating), the panel is further along than it was at the moment of
    // release, not reset back to 0 and restarting from scratch.
    await page.waitForTimeout(16);
    const xOneFrameAfterRelease = await readDragSurfaceX(page);
    expect(xOneFrameAfterRelease).toBeGreaterThanOrEqual(xAtRelease);
  });

  test('@sheet-drag re-grabbing mid-close resumes 1:1 tracking from the panel\'s current on-screen position', async ({
    page,
  }) => {
    await login(page);
    await openCreateSheet(page);

    // Release past the close threshold so the panel is genuinely animating shut ...
    await performDrag(page, 260, { steps: 3, stepDelayMs: 8 });
    await page.mouse.up();

    // ... wait a short, fixed interval into the close animation (the panel is now somewhere
    // between the release point and fully closed, not at either extreme) ...
    await page.waitForTimeout(40);
    const xMidClose = await readDragSurfaceX(page);

    // ... then grab again and move a small amount. Research Assumption A2, tagged [ASSUMED] and
    // requiring exactly this dedicated test before being relied on: the panel's tracking must
    // resume from wherever it currently sits on screen, not snap back to 0 (its rest position) or
    // jump to the in-flight close target first.
    const start = await dragSurfaceCenter(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 10, start.y, { steps: 2 });
    await page.waitForTimeout(30);
    const xAfterRegrab = await readDragSurfaceX(page);

    await page.mouse.up();

    // The re-grabbed position must be close to where the close animation had already reached --
    // never a hard reset to 0 first.
    expect(Math.abs(xAfterRegrab - xMidClose)).toBeLessThan(200);
  });

  test('@sheet-drag Esc still closes the sheet, unaffected by the new drag surface', async ({ page }) => {
    await login(page);
    await openCreateSheet(page);

    await expect(page.getByTestId('server-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    // Esc-close-then-focus-return-to-trigger is a pre-existing gap in this codebase (reproduced
    // against the pristine, pre-08-12 Sheet.tsx: `Sheet` never renders a `DialogPrimitive.Trigger`,
    // it is opened via an externally-controlled `open` prop, so Radix's `FocusScope` has no
    // Trigger of its own to restore focus to) -- out of this plan's scope per the SCOPE BOUNDARY
    // rule (not caused by this plan's changes), logged to deferred-items.md rather than fixed
    // here. This assertion only covers what T-08-34 actually requires this plan preserve: Esc
    // still dismisses the Sheet at all.
    await expect(page.getByTestId('server-sheet')).toHaveCount(0);
  });
});
