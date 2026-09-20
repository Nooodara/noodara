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
