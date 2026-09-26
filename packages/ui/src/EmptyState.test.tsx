import { describe, expect, it, vi } from 'vitest';
import { EmptyState, type EmptyStateProps } from './EmptyState.js';
import { renderUi, screen, userEvent, within } from './testing/render.js';

describe('EmptyState', () => {
  it('renders its title and one-sentence body', () => {
    renderUi(
      <EmptyState title="No servers yet" body="Connect your first Ubuntu server to let Noodara discover it." />,
    );

    expect(screen.getByText('No servers yet')).toBeInTheDocument();
    expect(
      screen.getByText('Connect your first Ubuntu server to let Noodara discover it.'),
    ).toBeInTheDocument();
  });

  it('renders exactly one button when an action is supplied', () => {
    const { container } = renderUi(
      <EmptyState title="No servers yet" body="Body." action={{ label: 'Add server', onClick: vi.fn() }} />,
    );

    expect(within(container).getAllByRole('button')).toHaveLength(1);
    expect(within(container).getByRole('button', { name: 'Add server' })).toBeInTheDocument();
  });

  it('renders zero buttons when no action is supplied', () => {
    const { container } = renderUi(<EmptyState title="No servers yet" body="Body." />);

    expect(within(container).queryAllByRole('button')).toHaveLength(0);
  });

  it('invokes the action onClick exactly once when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderUi(<EmptyState title="No servers yet" body="Body." action={{ label: 'Add server', onClick }} />);

    await user.click(screen.getByRole('button', { name: 'Add server' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders no illustration -- no img or svg element', () => {
    const { container } = renderUi(
      <EmptyState title="No servers yet" body="Body." action={{ label: 'Add server', onClick: vi.fn() }} />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  // UI-09 (08-15-PLAN.md Task 1): the body sentence caps at a 70ch measure so a long body string
  // never reads wider than a comfortable line, matching Banner/Notice/dialog body copy's own cap.
  it('caps its body copy at a 70ch measure', () => {
    renderUi(<EmptyState title="No servers yet" body="Body." />);

    expect(screen.getByText('Body.').className).toMatch(/max-w-\[70ch\]/);
  });

  it('types the action prop as a single object, never an array (verified by tsc, not just convention)', () => {
    const invalidProps: EmptyStateProps = {
      title: 'No servers yet',
      body: 'Body.',
      // @ts-expect-error -- action must be a single EmptyStateAction object, not an array; this
      // line exists to make D-12's "una sola accion" a real type error, checked by `pnpm typecheck`.
      action: [{ label: 'Add server', onClick: vi.fn() }],
    };

    expect(invalidProps).toBeDefined();
  });
});
