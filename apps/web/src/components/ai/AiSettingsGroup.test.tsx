import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderUi, screen } from '@noodara/ui/testing';
import { AiSettingsGroup } from './AiSettingsGroup';

// jsdom has no ResizeObserver; Radix RadioGroup (SegmentedControl) inside a <form> needs one
// (same file-local stub as ServerSheet.test.tsx).
class ResizeObserverStub {
  observe(): void {
    return;
  }
  unobserve(): void {
    return;
  }
  disconnect(): void {
    return;
  }
}
type GlobalWithResizeObserver = typeof globalThis & { ResizeObserver?: typeof ResizeObserver };
(globalThis as GlobalWithResizeObserver).ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const KEY = 'canary-byok-key-0123456789abcdefghij';
const SAVED = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  keyHint: '••••••••ghij',
  validatedAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
} as const;

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api/ai-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/api/ai-api')>();
  return { ...real, getAiSettings: api.get, putAiSettings: api.put, deleteAiSettings: api.del };
});

beforeEach(() => {
  api.get.mockResolvedValue({ ok: true, data: { settings: null } });
});
afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function keyInput(): HTMLInputElement {
  const input = screen.getByTestId('ai-key-input');
  if (!(input instanceof HTMLInputElement)) throw new Error('ai-key-input is not an input');
  return input;
}

function dump(store: Storage): string {
  const out: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i) ?? '';
    out.push(key, store.getItem(key) ?? '');
  }
  return out.join('\n');
}

describe('AiSettingsGroup', () => {
  it('states that the AI is read-only and what is sent to the provider', async () => {
    renderUi(<AiSettingsGroup />);
    await screen.findByTestId('ai-settings-form');
    expect(screen.getByTestId('ai-read-only-copy').textContent).toMatch(/never changes it/);
    expect(screen.getByTestId('ai-data-sent-copy').textContent).toMatch(/Secret values and credentials are never sent/);
  });

  it('renders a write-only key field (H1)', async () => {
    renderUi(<AiSettingsGroup />);
    const input = await screen.findByTestId('ai-key-input');
    expect(input.getAttribute('type')).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.hasAttribute('name')).toBe(false);
  });

  it('switches the model with the provider', async () => {
    renderUi(<AiSettingsGroup />);
    await screen.findByTestId('ai-settings-form');
    expect(screen.getByTestId('ai-model').textContent).toBe('claude-opus-5-5');
    fireEvent.click(screen.getByRole('radio', { name: 'OpenAI' }));
    expect(screen.getByTestId('ai-model').textContent).toBe('gpt-5-2025-08-07');
  });

  it('asks for a key before testing', async () => {
    renderUi(<AiSettingsGroup />);
    fireEvent.click(await screen.findByTestId('ai-settings-save'));
    expect(screen.getByText('Paste an API key to test it.')).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('tests and saves, then shows only the redacted hint and clears the key', async () => {
    api.put.mockResolvedValue({ ok: true, data: SAVED });
    renderUi(<AiSettingsGroup />);
    fireEvent.change(await screen.findByTestId('ai-key-input'), { target: { value: KEY } });
    fireEvent.click(screen.getByTestId('ai-settings-save'));
    await screen.findByTestId('ai-settings-saved');
    expect(api.put).toHaveBeenCalledWith({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: KEY });
    expect(screen.getByTestId('ai-saved-key-hint').textContent).toBe('••••••••ghij');
    expect(screen.getByTestId('ai-settings-group').textContent).not.toContain(KEY);
    expect(screen.queryByTestId('ai-key-input')).toBeNull();
    expect(dump(localStorage)).not.toContain(KEY);
    expect(dump(sessionStorage)).not.toContain(KEY);
    expect(screen.getByTestId('ai-open-chat').getAttribute('href')).toBe('/settings?ask=1');
  });

  it('shows actionable copy when the provider rejects the key', async () => {
    api.put.mockResolvedValue({ ok: false, code: 'AI_PROVIDER_AUTH_FAILED', message: `bad ${KEY}` });
    renderUi(<AiSettingsGroup />);
    fireEvent.change(await screen.findByTestId('ai-key-input'), { target: { value: KEY } });
    fireEvent.click(screen.getByTestId('ai-settings-save'));
    await screen.findByText(/rejected this key/);
    expect(screen.getByTestId('ai-settings-group').textContent).not.toContain(KEY);
  });

  it('replaces a saved key and can cancel', async () => {
    api.get.mockResolvedValue({ ok: true, data: { settings: SAVED } });
    renderUi(<AiSettingsGroup />);
    fireEvent.click(await screen.findByTestId('ai-settings-replace'));
    expect(keyInput().value).toBe('');
    fireEvent.click(screen.getByTestId('ai-settings-cancel'));
    expect(screen.getByTestId('ai-settings-saved')).toBeTruthy();
  });

  it('removes the key after confirmation', async () => {
    api.get.mockResolvedValue({ ok: true, data: { settings: SAVED } });
    api.del.mockResolvedValue({ ok: true, data: undefined });
    renderUi(<AiSettingsGroup />);
    fireEvent.click(await screen.findByTestId('ai-settings-remove'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove key' }));
    await screen.findByTestId('ai-settings-form');
    expect(api.del).toHaveBeenCalledTimes(1);
  });

  it('reports a failed removal', async () => {
    api.get.mockResolvedValue({ ok: true, data: { settings: SAVED } });
    api.del.mockResolvedValue({ ok: false, code: 'INTERNAL_ERROR', message: 'x' });
    renderUi(<AiSettingsGroup />);
    fireEvent.click(await screen.findByTestId('ai-settings-remove'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove key' }));
    await screen.findByTestId('ai-settings-remove-error');
  });

  it('offers a retry when the settings cannot load', async () => {
    api.get.mockResolvedValueOnce({ ok: false, code: 'NETWORK_ERROR', message: 'x' });
    renderUi(<AiSettingsGroup />);
    await screen.findByTestId('ai-settings-error');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('ai-settings-form');
  });
});
