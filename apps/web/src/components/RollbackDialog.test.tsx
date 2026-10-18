import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import type { DeploymentView } from '../lib/deploy-api';
import { ROLLBACK_IN_PROGRESS_DIALOG_COPY, RollbackDialog } from './RollbackDialog';

const SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const TARGET_ID = '00000000-0000-4000-8000-000000000002';
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

const api = vi.hoisted(() => ({ rollbackService: vi.fn() }));
vi.mock('../lib/deploy-api', () => ({
  rollbackService: (...args: unknown[]) => api.rollbackService(...args) as unknown,
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

const target = { id: TARGET_ID, serviceId: SERVICE_ID, commitSha: SHA, status: 'SUCCESS' } as unknown as DeploymentView;
const queued = { id: 'new-id', trigger: 'rollback' } as unknown as DeploymentView;

function setup(onRolledBack = vi.fn(), onOpenChange = vi.fn()) {
  renderUi(<RollbackDialog open onOpenChange={onOpenChange} serviceId={SERVICE_ID} target={target} onRolledBack={onRolledBack} />);
  return { onRolledBack, onOpenChange };
}

describe('RollbackDialog', () => {
  beforeEach(() => {
    api.rollbackService.mockReset();
  });

  it('names the target commit', () => {
    setup();
    expect(screen.getByRole('dialog')).toHaveTextContent('abcdef0');
    expect(screen.getByRole('dialog')).not.toHaveTextContent(SHA);
  });

  it('sends the target with an Idempotency-Key and reports the queued deployment', async () => {
    api.rollbackService.mockResolvedValue({ ok: true, data: queued });
    const { onRolledBack, onOpenChange } = setup();

    await userEvent.click(screen.getByTestId('rollback-confirm'));

    await waitFor(() => {
      expect(onRolledBack).toHaveBeenCalledWith(queued);
    });
    const [serviceId, targetId, key] = api.rollbackService.mock.calls[0] as [string, string, string];
    expect([serviceId, targetId]).toEqual([SERVICE_ID, TARGET_ID]);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables confirm while in flight so a double click sends one request', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    api.rollbackService.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    const confirm = screen.getByTestId('rollback-confirm');

    await userEvent.click(confirm);
    await userEvent.click(confirm);

    expect(api.rollbackService).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    resolve({ ok: true, data: queued });
    await waitFor(() => {
      expect(confirm).not.toBeDisabled();
    });
  });

  it('reuses the same key on retry and shows actionable copy for DEPLOYMENT_IN_PROGRESS', async () => {
    api.rollbackService.mockResolvedValue({ ok: false, code: 'DEPLOYMENT_IN_PROGRESS', message: 'raw', unauthorized: false });
    const { onRolledBack } = setup();

    await userEvent.click(screen.getByTestId('rollback-confirm'));
    expect(await screen.findByTestId('rollback-error')).toHaveTextContent(ROLLBACK_IN_PROGRESS_DIALOG_COPY);
    expect(screen.queryByText('raw')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('rollback-confirm'));

    await waitFor(() => {
      expect(api.rollbackService).toHaveBeenCalledTimes(2);
    });
    const keys = api.rollbackService.mock.calls.map((call) => (call as string[])[2]);
    expect(keys[0]).toBe(keys[1]);
    expect(onRolledBack).not.toHaveBeenCalled();
  });

  it('generates a fresh key on each open', async () => {
    api.rollbackService.mockResolvedValue({ ok: false, code: 'INTERNAL_ERROR', message: 'x', unauthorized: false });
    const props = { onOpenChange: vi.fn(), serviceId: SERVICE_ID, target, onRolledBack: vi.fn() };
    const view = renderUi(<RollbackDialog open {...props} />);
    await userEvent.click(screen.getByTestId('rollback-confirm'));
    await waitFor(() => {
      expect(api.rollbackService).toHaveBeenCalledTimes(1);
    });
    view.rerender(<RollbackDialog open={false} {...props} />);
    view.rerender(<RollbackDialog open {...props} />);
    await userEvent.click(await screen.findByTestId('rollback-confirm'));
    await waitFor(() => {
      expect(api.rollbackService).toHaveBeenCalledTimes(2);
    });
    const keys = api.rollbackService.mock.calls.map((call) => (call as string[])[2]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('traps focus while open and restores it to the trigger on close (A5)', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="trigger" onClick={() => { setOpen(true); }}>Open</button>
          <RollbackDialog open={open} onOpenChange={setOpen} serviceId={SERVICE_ID} target={target} onRolledBack={vi.fn()} />
        </>
      );
    }
    renderUi(<Harness />);
    const trigger = screen.getByTestId('trigger');
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
