// 30-04: the BYOK AI settings group in a real browser against the real stack. The settings routes
// are intercepted with page.route (ADR-0005, same as graph.spec.ts): storing, testing and
// encrypting the key are proven by the 28-02 integration tests. Here the UI contract: provider and
// model picker, a write-only key field, the redacted hint after save, remove, the read-only and
// data-sent statements, and that the pasted key never reaches storage, the URL or the console (H1).
import { expect, test, type Page, type Route } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const KEY = 'canary-byok-e2e-key-7f3a9c1d5e8b2a4f6071';
const HINT = '••••••••6071';
const NOW = '2026-11-05T10:00:00.000Z';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface SettingsMock {
  settings: Record<string, string> | null;
  putBodies: unknown[];
  deletes: number;
  rejectNext: boolean;
}

async function mockSettings(page: Page, initial: Record<string, string> | null = null): Promise<SettingsMock> {
  const state: SettingsMock = { settings: initial, putBodies: [], deletes: 0, rejectNext: false };
  await page.route('**/api/settings/ai', async (route) => {
    const method = route.request().method();
    if (method === 'GET') return json(route, { settings: state.settings });
    if (method === 'PUT') {
      const body = route.request().postDataJSON() as { provider: string; model: string };
      state.putBodies.push(body);
      if (state.rejectNext) {
        state.rejectNext = false;
        return json(route, { error: 'AI_PROVIDER_AUTH_FAILED', message: 'The provider rejected the key.' }, 422);
      }
      state.settings = { provider: body.provider, model: body.model, keyHint: HINT, validatedAt: NOW, updatedAt: NOW };
      return json(route, state.settings);
    }
    if (method === 'DELETE') {
      state.deletes += 1;
      state.settings = null;
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fallback();
  });
  return state;
}

function watchConsole(page: Page): string[] {
  const messages: string[] = [];
  page.on('console', (message) => {
    messages.push(message.text());
  });
  page.on('pageerror', (error) => {
    messages.push(String(error));
  });
  return messages;
}

async function expectKeyNowhere(page: Page, consoleMessages: readonly string[], { inDom = false } = {}): Promise<void> {
  const storage = await page.evaluate(() => {
    const dump = (store: Storage): string => {
      const out: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i) ?? '';
        out.push(k, store.getItem(k) ?? '');
      }
      return out.join('\n');
    };
    return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
  });
  expect(storage.local).not.toContain(KEY);
  expect(storage.session).not.toContain(KEY);
  expect(page.url()).not.toContain(KEY);
  expect(page.url()).not.toContain(encodeURIComponent(KEY));
  for (const message of consoleMessages) expect(message).not.toContain(KEY);
  // While the field still holds the key (a failed test) the input owns it; once saved, nothing does.
  if (!inDom) expect(await page.content()).not.toContain(KEY);
}

test.describe('AI settings (30-04)', () => {
  test('A1/H1: pick provider and model, test and save a write-only key, then see only the hint', async ({ page }) => {
    const consoleMessages = watchConsole(page);
    await login(page);
    const mock = await mockSettings(page);
    await page.goto('/settings');

    const group = page.getByTestId('ai-settings-group');
    await expect(group).toBeVisible();
    await expect(page.getByTestId('ai-read-only-copy')).toContainText('Read-only');
    await expect(page.getByTestId('ai-read-only-copy')).toContainText('never changes it');
    await expect(page.getByTestId('ai-data-sent-copy')).toContainText('sends the question');
    await expect(page.getByTestId('ai-data-sent-copy')).toContainText('Secret values and credentials are never sent');

    const keyInput = page.getByTestId('ai-key-input');
    await expect(keyInput).toHaveAttribute('type', 'password');
    await expect(keyInput).toHaveAttribute('autocomplete', 'off');
    await expect(keyInput).not.toHaveAttribute('name', /.*/);

    await expect(page.getByTestId('ai-model')).toHaveText('claude-opus-5-5');
    await page.getByTestId('ai-provider').getByRole('radio', { name: 'OpenAI' }).click();
    await expect(page.getByTestId('ai-model')).toHaveText('gpt-5-2025-08-07');

    await keyInput.fill(KEY);
    await page.getByTestId('ai-settings-save').click();

    await expect(page.getByTestId('ai-settings-saved')).toBeVisible();
    await expect(page.getByTestId('ai-saved-provider')).toHaveText('OpenAI');
    await expect(page.getByTestId('ai-saved-model')).toHaveText('gpt-5-2025-08-07');
    await expect(page.getByTestId('ai-saved-key-hint')).toHaveText(HINT);
    await expect(page.getByTestId('ai-key-input')).toHaveCount(0);
    expect(mock.putBodies).toEqual([{ provider: 'openai', model: 'gpt-5-2025-08-07', apiKey: KEY }]);

    await expectKeyNowhere(page, consoleMessages);

    // The saved state survives a reload with only the hint.
    await page.reload();
    await expect(page.getByTestId('ai-saved-key-hint')).toHaveText(HINT);
    await expectKeyNowhere(page, consoleMessages);
  });

  test('A1: a rejected key gets actionable copy and is not echoed', async ({ page }) => {
    const consoleMessages = watchConsole(page);
    await login(page);
    const mock = await mockSettings(page);
    mock.rejectNext = true;
    await page.goto('/settings');
    await page.getByTestId('ai-key-input').fill(KEY);
    await page.getByTestId('ai-settings-save').click();
    await expect(page.getByTestId('ai-settings-form')).toContainText('The provider rejected this key');
    await expect(page.getByTestId('ai-settings-saved')).toHaveCount(0);
    await expectKeyNowhere(page, consoleMessages, { inDom: true });
  });

  test('A1: remove the saved key after confirming', async ({ page }) => {
    await login(page);
    const mock = await mockSettings(page, {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      keyHint: HINT,
      validatedAt: NOW,
      updatedAt: NOW,
    });
    await page.goto('/settings');
    await expect(page.getByTestId('ai-saved-key-hint')).toHaveText(HINT);
    await page.getByTestId('ai-settings-remove').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove key' }).click();
    await expect(page.getByTestId('ai-settings-form')).toBeVisible();
    expect(mock.deletes).toBe(1);
  });

  test('A1: the saved state opens the chat in the inspector', async ({ page }) => {
    await login(page);
    await mockSettings(page, { provider: 'anthropic', model: 'claude-opus-5-5', keyHint: HINT, validatedAt: NOW, updatedAt: NOW });
    await page.goto('/settings');
    await page.getByTestId('ai-open-chat').click();
    await expect(page).toHaveURL(/\/settings\?ask=1$/);
    const panel = page.getByTestId('inspector-panel');
    await expect(panel.getByRole('heading', { name: 'Ask Noodara' })).toBeVisible();
    await expect(panel.getByTestId('ai-chat')).toBeVisible();
    await panel.getByTestId('inspector-close').click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByTestId('inspector-panel')).toHaveCount(0);
  });
});
