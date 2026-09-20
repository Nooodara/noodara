// 260920-ly9: RED coverage for the confirmed-live regression (STATE.md 05-37 finding,
// 05-GAP-CLOSURE-AUDIT.md gap 5's "latent second bug", 05-REVIEW.md WR-B-07): ServerSheet.tsx's
// SSH user `Field` (around lines 303-316) renders with no `error`/`invalid` wiring, while
// `error-copy.ts`'s `normalizeFieldPath` already maps a backend `/sshUser` VALIDATION_FAILED issue
// into `fieldErrors.sshUser` -- so a real `sshUser` rejection currently produces zero visible
// feedback of any kind (`handleApiFailure` suppresses the generic toast the instant any field
// maps). This file proves the fix (plain case) and guards all five server-sheet-owned
// `KNOWN_FORM_FIELD_PATHS` keys against the same class of "field silently dropped from the wiring"
// defect recurring unnoticed.
import { beforeEach, describe, expect, it } from 'vitest';
import { renderUi, screen, userEvent, within } from '@noodara/ui/testing';
import { vi } from 'vitest';
import { ServerSheet } from './ServerSheet';
import { KNOWN_FORM_FIELD_PATHS } from '../lib/error-copy';
import type { ApiResult, ServerView } from '../lib/api-client';

// jsdom has no ResizeObserver. ServerSheet is the first component test in this repo to mount a
// Radix RadioGroup (SegmentedControl, via CredentialFields) inside a real `<form>` element --
// @radix-ui/react-radio-group's BubbleInput only mounts (and calls useSize -> ResizeObserver) when
// `control.closest('form')` finds one, so no prior test (SegmentedControl.test.tsx renders the
// control standalone, with no surrounding form) ever exercised this path. A file-local stub, not a
// global setup change, per vitest.setup.dom.ts's own "no global mocks" rule.
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

const apiSendMock = vi.fn<(...args: unknown[]) => Promise<ApiResult<ServerView>>>();

vi.mock('../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client')>()),
  apiSend: (...args: unknown[]) => apiSendMock(...args),
}));

vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// The five server-sheet-owned keys among `KNOWN_FORM_FIELD_PATHS` -- `token`/`email`/`password`
// belong to setup/login, not this sheet (see error-copy.ts's own comment on the whitelist).
const SERVER_SHEET_OWNED_FIELDS = ['name', 'host', 'sshPort', 'sshUser', 'credential'] as const;

async function fillMinimumValidForm(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Name'), 'test-server');
  await user.type(screen.getByLabelText('Host'), 'test-server.example.test');
  await user.click(within(screen.getByTestId('server-sheet-credential-type')).getByRole('radio', { name: 'Password' }));
  await user.type(screen.getByLabelText('Password'), 'diagnostic-only-password');
}

async function submit(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId('server-sheet-save-connect'));
}

beforeEach(() => {
  apiSendMock.mockReset();
});

describe('ServerSheet', () => {
  it('renders a visible error and marks the SSH user field invalid on a server-side /sshUser VALIDATION_FAILED issue', async () => {
    apiSendMock.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Request does not match the schema',
      issues: [{ path: '/sshUser', message: 'sshUser must not contain whitespace.' }],
      unauthorized: false,
    });

    renderUi(<ServerSheet open mode="create" server={null} onOpenChange={vi.fn()} onSaved={vi.fn()} />);

    await fillMinimumValidForm();
    await submit();

    expect(await screen.findByText('sshUser must not contain whitespace.')).toBeVisible();
    expect(screen.getByLabelText('SSH user')).toHaveAttribute('aria-invalid', 'true');
  });

  it.each(SERVER_SHEET_OWNED_FIELDS)('renders the server-side error for the %s field when the backend targets it', async (field) => {
    expect(KNOWN_FORM_FIELD_PATHS.has(field)).toBe(true);

    apiSendMock.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Request does not match the schema',
      issues: [{ path: `/${field}`, message: `${field} guard message` }],
      unauthorized: false,
    });

    renderUi(<ServerSheet open mode="create" server={null} onOpenChange={vi.fn()} onSaved={vi.fn()} />);

    await fillMinimumValidForm();
    await submit();

    expect(await screen.findByText(`${field} guard message`)).toBeVisible();
  });
});
