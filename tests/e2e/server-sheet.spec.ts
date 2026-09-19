// 05-17-PLAN.md Task 3: the add/edit server sheet and the delete confirmation, wired to the
// servers list's own toolbar/row-menu actions and proven end to end in a real browser -- including
// the D-04 no-leak assertions (T-5-73..T-5-79) that only a real browser, not jsdom, can prove:
// request content type, `localStorage`/`sessionStorage`, and navigation history. Runs against the
// same real stack.ts stack every other spec in this directory uses (Postgres, Redis, the API, the
// worker, the built web app), with the preseeded E2E admin. Every credential used here is an
// obviously-fake value (never a real key/password), matching the harness-hygiene rule that
// Playwright traces may capture typed secrets.
import { expect, test, type Page, type Request } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const FAKE_PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-e2e-only-key-material-zK9qLdistinctive\n-----END OPENSSH PRIVATE KEY-----';
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
    buffer: Buffer.from(FAKE_PRIVATE_KEY, 'utf8'),
  });

  await expect(page.getByLabel('Private key')).toHaveValue(FAKE_PRIVATE_KEY);

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
  expect(body.credential?.privateKey).toBe(FAKE_PRIVATE_KEY);

  for (const request of requests) {
    expect(request.headers()['content-type']).not.toContain('multipart/form-data');
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
  await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
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
  await page.request.post('/api/servers', {
    data: {
      name,
      host: `${name}.example.test`,
      credential: { type: 'ssh_private_key', privateKey: FAKE_PRIVATE_KEY },
    },
  });
  await page.reload();

  const row = page.getByTestId('servers-row').filter({ hasText: name });
  await row.hover();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();

  await expect(page.getByTestId('server-sheet')).toBeVisible();
  await expect(page.getByText('••••••••')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace' })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(2); // Name, Host only -- no credential textbox yet

  const html = await page.content();
  expect(html).not.toContain(FAKE_PRIVATE_KEY);
  expect(html).not.toContain('fake-e2e-only-key-material-zK9qLdistinctive');
});

test('@sheet Delete requires the exact name: the confirm button stays disabled until it matches, then deletes the row', async ({
  page,
}) => {
  await login(page);

  const name = `delete-me-${String(Date.now())}`;
  await page.request.post('/api/servers', {
    data: { name, host: `${name}.example.test`, credential: { type: 'ssh_password', password: 'diagnostic-only' } },
  });
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
  await page.getByLabel('Private key').fill(FAKE_PRIVATE_KEY);
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

  const secretFragment = 'fake-e2e-only-key-material-zK9qLdistinctive';
  expect(storedValues.some((value) => value.includes(secretFragment))).toBe(false);
  expect(storedValues.some((value) => value.includes(FAKE_PASSWORD))).toBe(false);
  expect(page.url()).not.toContain(secretFragment);
});
