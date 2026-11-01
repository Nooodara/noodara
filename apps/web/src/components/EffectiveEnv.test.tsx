import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import { EFFECTIVE_EMPTY_COPY, EFFECTIVE_LOAD_FAILED_COPY, EffectiveEnv } from './EffectiveEnv';
import { REDEPLOY_TO_APPLY_COPY } from '../lib/env-form';

const api = vi.hoisted(() => ({ getEffectiveEnv: vi.fn() }));
vi.mock('../lib/env-api', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, getEffectiveEnv: (...a: unknown[]) => api.getEffectiveEnv(...a) as unknown };
});
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

const ok = (data: unknown) => Promise.resolve({ ok: true, data });

const VIEW = {
  items: [
    {
      key: 'DATABASE_URL',
      origin: 'service',
      value: { kind: 'secret_ref', name: 'db_url' },
      shadowed: [
        { origin: 'environment', value: { kind: 'plain', value: 'postgres://staging' } },
        { origin: 'project', value: { kind: 'plain', value: 'postgres://local' } },
      ],
    },
    { key: 'PORT', origin: 'project', value: { kind: 'plain', value: '3000' }, shadowed: [] },
    { key: 'ODD', origin: 'galaxy', value: { kind: 'plain', value: '<b>x</b>' }, shadowed: [] },
  ],
  differsFromRunning: false,
};

beforeEach(() => {
  api.getEffectiveEnv.mockReset();
});

describe('EffectiveEnv (24-02 A3)', () => {
  it('shows each key with its origin pill and a chip for secret references', async () => {
    api.getEffectiveEnv.mockReturnValue(ok(VIEW));
    renderUi(<EffectiveEnv projectId="p1" serviceId="s1" />);
    const db = await screen.findByTestId('effective-row-DATABASE_URL');
    expect(db).toHaveTextContent('db_url');
    expect(db).toHaveTextContent('Service');
    expect(screen.getByTestId('effective-row-PORT')).toHaveTextContent('Project');
    expect(screen.getByTestId('effective-row-ODD')).toHaveTextContent('Other');
    expect(screen.getByTestId('effective-row-ODD')).toHaveTextContent('<b>x</b>');
    expect(document.querySelector('b')).toBeNull();
    expect(screen.queryByTestId('effective-redeploy-notice')).not.toBeInTheDocument();
    expect(api.getEffectiveEnv).toHaveBeenCalledWith('p1', 's1');
  });

  it('shows shadowed definitions only on demand', async () => {
    api.getEffectiveEnv.mockReturnValue(ok(VIEW));
    const user = userEvent.setup();
    renderUi(<EffectiveEnv projectId="p1" serviceId="s1" />);
    await screen.findByTestId('effective-row-DATABASE_URL');
    expect(screen.queryByText('postgres://staging')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Overrides 2 definitions/ }));
    expect(screen.getAllByTestId('effective-shadowed-item')).toHaveLength(2);
    expect(screen.getByText('postgres://staging')).toBeInTheDocument();
  });

  it('shows Redeploy to apply when the stored set differs from the running deploy', async () => {
    api.getEffectiveEnv.mockReturnValue(ok({ ...VIEW, differsFromRunning: true }));
    renderUi(<EffectiveEnv projectId="p1" serviceId="s1" />);
    expect(await screen.findByTestId('effective-redeploy-notice')).toHaveTextContent(REDEPLOY_TO_APPLY_COPY);
  });

  it('refetches when the version is bumped, and shows empty and failed states', async () => {
    api.getEffectiveEnv.mockReturnValueOnce(ok({ items: [], differsFromRunning: false }));
    const { rerender } = renderUi(<EffectiveEnv projectId="p1" serviceId="s1" version={0} />);
    expect(await screen.findByText(EFFECTIVE_EMPTY_COPY)).toBeInTheDocument();
    api.getEffectiveEnv.mockReturnValueOnce(ok({ ...VIEW, differsFromRunning: true }));
    rerender(<EffectiveEnv projectId="p1" serviceId="s1" version={1} />);
    await waitFor(() => {
      expect(screen.getByTestId('effective-redeploy-notice')).toBeInTheDocument();
    });
    expect(api.getEffectiveEnv).toHaveBeenCalledTimes(2);
  });

  it('shows fixed copy when loading fails', async () => {
    api.getEffectiveEnv.mockReturnValue(
      Promise.resolve({ ok: false, code: 'INTERNAL_ERROR', message: 'raw server text', unauthorized: false }),
    );
    renderUi(<EffectiveEnv projectId="p1" serviceId="s1" />);
    expect(await screen.findByText(EFFECTIVE_LOAD_FAILED_COPY)).toBeInTheDocument();
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });
});
